"""MCP Client supporting both SSE and HTTP transports."""

import json
import logging
from typing import Any, Dict, Optional
from urllib.parse import urljoin

import httpx
import sseclient

logger = logging.getLogger(__name__)


class McpClient:
    """
    MCP Client that supports both SSE and HTTP POST transports.
    
    SSE (Server-Sent Events): Used by cardapio MCP
    HTTP POST (streamable): Used by reservas MCP
    """
    
    def __init__(
        self,
        url: str,
        name: str,
        token: Optional[str] = None,
        token_in_url: bool = False,
        transport: str = "sse",  # "sse" or "streamable"
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
        import os
        # Normalize socks5h:// to socks5:// for httpx
        proxies = os.environ.get("HTTP_PROXY", "").replace("socks5h://", "socks5://") or None
        self._client = httpx.AsyncClient(timeout=timeout, proxy=proxies)
        
        logger.info(f"MCP Client '{name}' initialized with {transport} transport")
    
    async def connect(self) -> bool:
        """Initialize connection to MCP server."""
        try:
            if self.transport == "sse":
                await self._connect_sse()
            else:
                # HTTP transport is stateless
                self.ready = True
            
            logger.info(f"MCP Client '{self.name}' connected successfully")
            return True
        except Exception as e:
            logger.error(f"MCP Client '{self.name}' connection failed: {e}")
            self.ready = False
            return False
    
    async def _connect_sse(self) -> None:
        """Connect to SSE-based MCP server."""
        url = self._build_url("/sse")
        
        try:
            async with httpx.AsyncClient() as client:
                async with client.stream("GET", url, timeout=self.timeout) as response:
                    if response.status_code == 200:
                        self.ready = True
                        # For SSE, we maintain a session but actual calls use HTTP POST
                        logger.info(f"SSE connection established to {self.name}")
                    else:
                        raise ConnectionError(f"SSE connection failed: {response.status_code}")
        except Exception as e:
            logger.error(f"SSE connection error: {e}")
            raise
    
    def _build_url(self, path: str) -> str:
        """Build URL with optional token in query string."""
        url = urljoin(self.url + "/", path.lstrip("/"))
        if self.token and self.token_in_url:
            separator = "&" if "?" in url else "?"
            url = f"{url}{separator}token={self.token}"
        return url
    
    def _get_headers(self) -> Dict[str, str]:
        """Get headers with optional authorization."""
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json"
        }
        if self.token and not self.token_in_url:
            headers["Authorization"] = f"Bearer {self.token}"
        return headers
    
    async def list_tools(self) -> Dict[str, Any]:
        """List available tools from MCP server."""
        if not self.ready:
            await connect()
        
        url = self._build_url("/tools")
        
        try:
            response = await self._client.get(
                url,
                headers=self._get_headers()
            )
            response.raise_for_status()
            return response.json()
        except Exception as e:
            logger.error(f"Failed to list tools from {self.name}: {e}")
            raise
    
    async def call_tool(self, tool_name: str, arguments: Dict[str, Any]) -> str:
        """Call a tool on the MCP server."""
        if not self.ready:
            raise RuntimeError(f"MCP client {self.name} not connected")
        
        url = self._build_url("/invoke")
        
        payload = {
            "tool": tool_name,
            "params": arguments
        }
        
        try:
            logger.debug(f"Calling tool '{tool_name}' on {self.name} with args: {arguments}")
            
            response = await self._client.post(
                url,
                json=payload,
                headers=self._get_headers()
            )
            response.raise_for_status()
            
            result = response.json()
            
            # Extract text content from MCP response
            if isinstance(result, dict) and "content" in result:
                content = result["content"]
                if isinstance(content, list) and len(content) > 0:
                    return content[0].get("text", json.dumps(result))
            
            return json.dumps(result)
            
        except httpx.HTTPStatusError as e:
            logger.error(f"HTTP error calling tool {tool_name}: {e.response.status_code} - {e.response.text}")
            raise
        except Exception as e:
            logger.error(f"Error calling tool {tool_name}: {e}")
            raise
    
    async def close(self):
        """Close HTTP client."""
        await self._client.aclose()


# Global MCP clients
_mcp_clients: Dict[str, McpClient] = {}


async def get_mcp_clients() -> Dict[str, McpClient]:
    """Get or initialize MCP clients."""
    global _mcp_clients
    
    if not _mcp_clients:
        from app.config import get_settings
        settings = get_settings()
        
        # Cardapio MCP (SSE)
        _mcp_clients["cardapio"] = McpClient(
            url=settings.MCP_CARDAPIO_URL,
            name="Cardapio",
            token=settings.MCP_CARDAPIO_TOKEN,
            token_in_url=True,
            transport="sse"
        )
        
        # Reservas MCP (HTTP/streamable)
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
