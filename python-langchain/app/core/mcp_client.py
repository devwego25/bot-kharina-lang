"""MCP Client supporting Streamable HTTP (2024-11-05) and SSE transports."""

import json
import logging
import os
from typing import Any, Dict, Optional
from urllib.parse import urljoin

import httpx

logger = logging.getLogger(__name__)

# Normalize proxy scheme for httpx compatibility
def _get_proxy() -> Optional[str]:
    for var in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
        val = os.environ.get(var, "")
        if val:
            return val.replace("socks5h://", "socks5://")
    return None


class McpClient:
    """
    MCP Client implementing the Streamable HTTP transport (MCP 2024-11-05).

    Protocol flow:
    1. POST /mcp with method=initialize → receives mcp-session-id header
    2. All subsequent calls POST /mcp with mcp-session-id header
    3. Responses are SSE (text/event-stream) — we read the first event
    """

    def __init__(
        self,
        url: str,
        name: str,
        token: Optional[str] = None,
        token_in_url: bool = False,
        transport: str = "streamable",  # "streamable" or "sse"
        timeout: float = 30.0
    ):
        self.url = url.rstrip("/")
        self.name = name
        self.token = token
        self.token_in_url = token_in_url
        self.transport = transport
        self.timeout = timeout
        self.ready = False
        self._session_id: Optional[str] = None
        self._request_id = 0

        proxy = _get_proxy()
        self._client = httpx.AsyncClient(timeout=timeout, proxy=proxy)

        logger.info(f"MCP Client '{name}' initialized with {transport} transport")

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def connect(self) -> bool:
        """Initialize the MCP session."""
        try:
            if self.transport == "streamable":
                await self._initialize_session()
            else:
                # Legacy SSE: just mark ready (cardapio fallback)
                await self._connect_sse_legacy()

            logger.info(f"MCP Client '{self.name}' connected successfully (session={self._session_id})")
            return True
        except Exception as e:
            logger.error(f"MCP Client '{self.name}' connection failed: {e}")
            self.ready = False
            return False

    async def _initialize_session(self) -> None:
        """Perform MCP initialize handshake and capture mcp-session-id."""
        headers = self._get_headers()

        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "kha-langchain", "version": "1.0"}
            }
        }

        response = await self._client.post(
            self.url,
            json=payload,
            headers=headers
        )
        response.raise_for_status()

        # Capture session id from response headers
        self._session_id = response.headers.get("mcp-session-id")
        if not self._session_id:
            logger.warning(f"MCP '{self.name}': no mcp-session-id in response headers")

        self.ready = True
        logger.info(f"MCP '{self.name}' session initialized: {self._session_id}")

    async def _connect_sse_legacy(self) -> None:
        """Legacy SSE connect (cardapio MCP)."""
        try:
            url = self.url + "/sse"
            if self.token and self.token_in_url:
                url = f"{url}?token={self.token}"

            async with self._client.stream("GET", url, timeout=self.timeout) as response:
                if response.status_code == 200:
                    self.ready = True
                    logger.info(f"SSE connection established to {self.name}")
                else:
                    logger.warning(f"SSE connection returned {response.status_code} for {self.name} — marking ready anyway")
                    self.ready = True
        except Exception as e:
            logger.warning(f"SSE connect error for {self.name}: {e} — marking ready anyway")
            self.ready = True

    def _get_headers(self) -> Dict[str, str]:
        """Build request headers."""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream"
        }
        if self.token and not self.token_in_url:
            headers["Authorization"] = f"Bearer {self.token}"
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        return headers

    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        """Call a tool using the MCP JSON-RPC protocol."""
        if not self.ready:
            # Try to reconnect once
            logger.warning(f"MCP client {self.name} not ready — attempting reconnect")
            await self.connect()
            if not self.ready:
                raise RuntimeError(f"MCP client {self.name} not connected")

        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        }

        try:
            logger.info(f"Calling tool '{tool_name}' on {self.name} with args: {arguments}")

            response = await self._client.post(
                self.url,
                json=payload,
                headers=self._get_headers()
            )

            # If session expired, reinitialize and retry
            if response.status_code in (400, 404) and self.transport == "streamable":
                logger.warning(f"MCP session expired for {self.name}, reinitializing...")
                self.ready = False
                self._session_id = None
                await self.connect()
                response = await self._client.post(
                    self.url,
                    json=payload,
                    headers=self._get_headers()
                )

            response.raise_for_status()

            # Parse SSE response: extract data line
            result = self._parse_sse_or_json(response.text)

            # Extract tool result content
            if isinstance(result, dict):
                if "result" in result:
                    inner = result["result"]
                    # MCP tools/call result: {"content": [{"type": "text", "text": "..."}]}
                    if isinstance(inner, dict) and "content" in inner:
                        content = inner["content"]
                        if isinstance(content, list) and content:
                            return content[0].get("text", json.dumps(inner))
                    return json.dumps(inner)
                elif "error" in result:
                    raise RuntimeError(f"MCP tool error: {result['error']}")

            return json.dumps(result)

        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error calling tool {tool_name}: {e.response.status_code} - {e.response.text[:500]}")
            raise
        except Exception as e:
            logger.error(f"Error calling tool {tool_name}: {e}")
            raise

    def _parse_sse_or_json(self, text: str) -> Any:
        """Parse SSE event stream or plain JSON from response body."""
        text = text.strip()
        if not text:
            return {}

        # SSE format: "event: message\ndata: {...}\n\n"
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                data_str = line[5:].strip()
                if data_str and data_str != "[DONE]":
                    try:
                        return json.loads(data_str)
                    except json.JSONDecodeError:
                        pass

        # Fallback: try parsing whole body as JSON
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {"raw": text}

    async def list_tools(self) -> Dict[str, Any]:
        """List available tools from MCP server."""
        if not self.ready:
            await self.connect()

        payload = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/list"
        }

        response = await self._client.post(
            self.url,
            json=payload,
            headers=self._get_headers()
        )
        response.raise_for_status()
        return self._parse_sse_or_json(response.text)

    async def close(self):
        """Close the HTTP client."""
        await self._client.aclose()


# Global MCP clients
_mcp_clients: Dict[str, McpClient] = {}


async def get_mcp_clients() -> Dict[str, McpClient]:
    """Get or initialize MCP clients."""
    global _mcp_clients

    if not _mcp_clients:
        from app.config import get_settings
        settings = get_settings()

        # Cardapio MCP (legacy SSE transport — currently disabled)
        _mcp_clients["cardapio"] = McpClient(
            url=settings.MCP_CARDAPIO_URL,
            name="Cardapio",
            token=settings.MCP_CARDAPIO_TOKEN,
            token_in_url=True,
            transport="sse"
        )

        # Reservas MCP (Streamable HTTP MCP 2024-11-05)
        _mcp_clients["reservas"] = McpClient(
            url=settings.MCP_RESERVAS_URL,
            name="Reservas",
            token=settings.MCP_RESERVAS_TOKEN,
            token_in_url=False,
            transport="streamable"
        )

        # Connect all clients
        for client in _mcp_clients.values():
            await client.connect()

    return _mcp_clients
