import axios from 'axios';
import { EventSource } from 'eventsource';

interface JsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: any;
    id?: string | number;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    result?: any;
    error?: {
        code: number;
        message: string;
        data?: any;
    };
    id: string | number | null;
}

interface PendingRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timer: NodeJS.Timeout;
}

export type McpTransport = 'sse' | 'streamable';

export class McpClient {
    public readonly name: string;
    private baseUrl: string;
    private authToken?: string;
    private tokenInUrl: boolean;
    private transport: McpTransport;

    // SSE transport state
    private sessionEndpoint: string | null = null;
    private sessionId: string | null = null;
    private eventSource: EventSource | null = null;
    private isConnected: boolean = false;
    private pendingRequests = new Map<string | number, PendingRequest>();

    // Shared state
    private isInitialized: boolean = false;
    private isConnecting: boolean = false;

    // Reconnect state
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 5;
    private reconnectTimer: NodeJS.Timeout | null = null;

    /**
     * @param url       Base MCP server URL
     * @param name      Human-readable name for logging
     * @param authToken Optional auth token
     * @param tokenInUrl If true, appends ?token= to SSE URL (for n8n-style servers)
     * @param transport  'sse' for SSE transport, 'streamable' for Streamable HTTP (direct POST)
     */
    constructor(url: string, name: string, authToken?: string, tokenInUrl: boolean = true, transport: McpTransport = 'sse') {
        this.baseUrl = url;
        this.name = name;
        this.authToken = authToken;
        this.tokenInUrl = tokenInUrl;
        this.transport = transport;
    }

    public get ready(): boolean {
        return this.isInitialized;
    }

    // ─── Disconnect / Shutdown ──────────────────────────────────────────

    public disconnect() {
        if (this.eventSource) {
            console.log(`[MCP ${this.name}] Closing SSE Connection.`);
            this.eventSource.close();
            this.eventSource = null;
        }
        this.isConnected = false;
        this.isInitialized = false;
        this.isConnecting = false;
        this.sessionEndpoint = null;
        this.sessionId = null;
        this.pendingRequests.forEach(req => {
            clearTimeout(req.timer);
            req.reject(new Error(`MCP ${this.name} disconnected.`));
        });
        this.pendingRequests.clear();
    }

    public shutdown() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempts = this.maxReconnectAttempts;
        this.disconnect();
    }

    // ─── Reconnect Logic ────────────────────────────────────────────────

    private scheduleReconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            console.error(`[MCP ${this.name}] Max reconnect attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
            return;
        }

        const delayMs = Math.min(2000 * Math.pow(2, this.reconnectAttempts), 32000);
        this.reconnectAttempts++;
        console.log(`[MCP ${this.name}] Scheduling reconnect #${this.reconnectAttempts} in ${delayMs}ms...`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delayMs);
    }

    private resetReconnect() {
        this.reconnectAttempts = 0;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    public async forceReconnect() {
        console.log(`[MCP ${this.name}] Forced reconnect requested. Clearing session...`);
        this.shutdown();
        this.resetReconnect();
        this.connect();
        await this.waitReady();
    }

    // ─── Main Connect Entry Point ───────────────────────────────────────

    public connect() {
        if (this.isConnecting || this.isInitialized) {
            return;
        }

        if (this.transport === 'streamable') {
            this.connectStreamable();
        } else {
            this.connectSSE();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // STREAMABLE HTTP TRANSPORT (modern, no SSE)
    // ═══════════════════════════════════════════════════════════════════

    private async connectStreamable() {
        this.isConnecting = true;
        // Start a fresh streamable handshake without stale session metadata.
        this.sessionEndpoint = null;
        this.sessionId = null;
        console.log(`[MCP ${this.name}] Connecting via Streamable HTTP to ${this.baseUrl}`);

        try {
            // Direct POST initialize to the base URL
            const requestId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const payload: JsonRpcRequest = {
                jsonrpc: '2.0',
                method: 'initialize',
                params: {
                    protocolVersion: '2024-11-05',
                    capabilities: {},
                    clientInfo: { name: 'KharinaAgent', version: '1.0.0' }
                },
                id: requestId
            };

            console.log(`[MCP ${this.name}] POST initialize (ID: ${requestId})`);

            const response = await axios.post(this.baseUrl, payload, {
                headers: this.getHeaders(),
                timeout: 60000,
                // Important: accept both JSON and SSE responses
                transformResponse: [(data: any) => data] as any, // Keep raw response
                // @ts-expect-error
                proxy: false
            });

            const rawContentType = response.headers['content-type'];
            console.log(`[MCP ${this.name}] Response status: ${response.status}, content-type: ${rawContentType}`);

            // Extract session ID from response headers if present
            const mcpSessionId = response.headers['mcp-session-id'];
            if (mcpSessionId) {
                this.sessionId = mcpSessionId;
                console.log(`[MCP ${this.name}] Capture Session ID: ${this.sessionId}`);
            }

            // Parse the response (could be JSON or SSE-formatted)
            const result = this.parsePostResponse(response.data, rawContentType);

            if (!result) {
                throw new Error('Empty or unparseable response from server');
            }

            if (result.error) {
                throw new Error(`Server error: ${result.error.message} (code: ${result.error.code})`);
            }

            const protocolVersion = result.result?.protocolVersion || 'unknown';
            console.log(`[MCP ${this.name}] Server initialized. Protocol: ${protocolVersion}`);

            // Send initialized notification
            console.log(`[MCP ${this.name}] Sending 'notifications/initialized'...`);
            await axios.post(this.baseUrl, {
                jsonrpc: '2.0',
                method: 'notifications/initialized'
            }, {
                headers: this.getHeaders(),
                timeout: 10000,
                // @ts-expect-error
                proxy: false
            });

            this.isInitialized = true;
            this.isConnecting = false;
            this.resetReconnect();
            console.log(`[MCP ${this.name}] ✅ Handshake COMPLETED (Streamable HTTP).`);
        } catch (err: any) {
            const errorDetail = err.response?.data || err.message;
            console.error(`[MCP ${this.name}] Streamable HTTP handshake FAILED:`, errorDetail);
            this.isConnecting = false;
            this.scheduleReconnect();
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // SSE TRANSPORT (legacy)
    // ═══════════════════════════════════════════════════════════════════

    private connectSSE() {
        this.isConnecting = true;

        let connectUrl = this.baseUrl;
        if (this.tokenInUrl && this.authToken && !connectUrl.includes('token=')) {
            const separator = connectUrl.includes('?') ? '&' : '?';
            connectUrl += `${separator}token=${this.authToken}`;
        }

        console.log(`[MCP ${this.name}] Connecting to SSE at ${connectUrl}`);

        try {
            const esOptions: any = {
                fetch: (url: string, init: any) => {
                    init.headers = {
                        ...init.headers,
                        'Accept': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive'
                    };
                    if (this.authToken) {
                        init.headers['Authorization'] = `Bearer ${this.authToken}`;
                    }
                    return fetch(url, init);
                }
            };

            const es = new EventSource(connectUrl, esOptions);
            this.eventSource = es;

            es.onopen = () => {
                console.log(`[MCP ${this.name}] SSE Connection opened`);
            };

            es.onerror = (err: any) => {
                if (err?.message?.includes('Body Timeout') && this.isInitialized) {
                    return;
                }
                const statusCode = err?.status || err?.statusCode;
                const errMsg = err?.message || String(err);
                if (statusCode) {
                    console.error(`[MCP ${this.name}] SSE Error: Non-200 status code (${statusCode})`);
                } else {
                    console.error(`[MCP ${this.name}] SSE Error:`, errMsg);
                }
                this.disconnect();
                this.scheduleReconnect();
            };

            es.addEventListener('endpoint', async (event: any) => {
                try {
                    const relativeUrl = (event as any).data;
                    console.log(`[MCP ${this.name}] Endpoint event received: ${relativeUrl}`);

                    const originalUrlObj = new URL(connectUrl);
                    const endpointUrlObj = new URL(relativeUrl, connectUrl);

                    originalUrlObj.searchParams.forEach((value, key) => {
                        if (!endpointUrlObj.searchParams.has(key)) {
                            endpointUrlObj.searchParams.set(key, value);
                        }
                    });

                    if (relativeUrl.includes('sessionId=')) {
                        this.sessionId = relativeUrl.split('sessionId=')[1].split('&')[0];
                    }

                    this.sessionEndpoint = endpointUrlObj.toString();
                    console.log(`[MCP ${this.name}] Session Established. Endpoint: ${this.sessionEndpoint}`);

                    this.isConnected = true;
                    await this.performSSEHandshake();
                } catch (err) {
                    console.error(`[MCP ${this.name}] Endpoint setup error:`, err);
                    this.disconnect();
                    this.scheduleReconnect();
                }
            });

            // Single message handler for SSE responses
            es.onmessage = (event: any) => {
                this.handleSSEMessage(event);
            };
        } catch (error) {
            console.error(`[MCP ${this.name}] SSE Initialization failed:`, error);
            this.isConnecting = false;
            this.scheduleReconnect();
        }
    }

    private async performSSEHandshake() {
        if (!this.sessionEndpoint) return;

        try {
            console.log(`[MCP ${this.name}] Starting handshake...`);
            console.log(`[MCP ${this.name}] Sending 'initialize' request...`);

            const initResponse = await this.sendSSERequest('initialize', {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'KharinaAgent', version: '1.0.0' }
            }, 60000);

            const protocolVersion = initResponse?.protocolVersion || 'unknown';
            console.log(`[MCP ${this.name}] Server initialized. Protocol: ${protocolVersion}`);

            console.log(`[MCP ${this.name}] Sending 'notifications/initialized'...`);
            await axios.post(this.sessionEndpoint, {
                jsonrpc: '2.0',
                method: 'notifications/initialized'
            }, {
                headers: this.getHeaders(),
                timeout: 10000,
                // @ts-expect-error
                proxy: false
            });

            this.isInitialized = true;
            this.isConnecting = false;
            this.resetReconnect();
            console.log(`[MCP ${this.name}] ✅ Handshake COMPLETED (SSE).`);
        } catch (err: any) {
            const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
            console.error(`[MCP ${this.name}] Handshake FAILED:`, errorDetail);
            this.disconnect();
            this.scheduleReconnect();
        }
    }

    /**
     * Send a JSON-RPC request over SSE transport.
     * Handles both synchronous (inline HTTP response) and async (SSE event) responses.
     */
    private async sendSSERequest(method: string, params: any, timeoutMs: number = 60000): Promise<any> {
        if (!this.sessionEndpoint) throw new Error(`No session endpoint for ${this.name}`);

        const requestId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const payload: JsonRpcRequest = {
            jsonrpc: '2.0',
            method,
            params,
            id: requestId
        };

        return new Promise(async (resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pendingRequests.has(requestId)) {
                    this.pendingRequests.delete(requestId);
                    reject(new Error(`MCP Timeout: ${method} for ${this.name} (${timeoutMs}ms)`));
                }
            }, timeoutMs);

            this.pendingRequests.set(requestId, { resolve, reject, timer });

            try {
                console.log(`[MCP ${this.name}] POST ${method} (ID: ${requestId})`);

                const response = await axios.post(this.sessionEndpoint!, payload, {
                    headers: this.getHeaders(),
                    timeout: timeoutMs,
                    transformResponse: [(data: any) => data] as any, // Keep raw
                    // @ts-expect-error
                    proxy: false
                });

                const bodyLen = typeof response.data === 'string' ? response.data.length : 0;
                const contentType = response.headers['content-type'] || 'none';
                console.log(`[MCP ${this.name}] POST response: status=${response.status}, content-type=${contentType}, body-length=${bodyLen}`);

                // Try to extract inline JSON-RPC response from POST body
                if (response.data && this.pendingRequests.has(requestId)) {
                    const parsed = this.parsePostResponse(response.data, response.headers['content-type']);
                    if (parsed && (parsed.id !== undefined && parsed.id !== null)) {
                        const respId = parsed.id.toString();
                        if (this.pendingRequests.has(respId)) {
                            console.log(`[MCP ${this.name}] Got inline response for ${method} (ID: ${respId})`);
                            const pending = this.pendingRequests.get(respId)!;
                            clearTimeout(pending.timer);
                            this.pendingRequests.delete(respId);
                            if (parsed.error) {
                                pending.reject(new Error(parsed.error.message || 'JSON-RPC error'));
                            } else {
                                pending.resolve(parsed.result);
                            }
                        }
                    }
                }
                // If not resolved inline, it will come via SSE onmessage
            } catch (err: any) {
                if (this.pendingRequests.has(requestId)) {
                    clearTimeout(timer);
                    this.pendingRequests.delete(requestId);
                    const errorData = err.response?.data || err.message;
                    console.error(`[MCP ${this.name}] POST FAILED: ${method} (ID: ${requestId}) ->`, errorData);
                    reject(err);
                }
            }
        });
    }

    private handleSSEMessage(event: any) {
        try {
            const parsed = this.parsePostResponse(event.data, 'application/json');
            if (!parsed) return;

            const id = parsed.id?.toString();
            if (id && this.pendingRequests.has(id)) {
                const pending = this.pendingRequests.get(id)!;
                clearTimeout(pending.timer);
                this.pendingRequests.delete(id);

                if (parsed.error) {
                    console.error(`[MCP ${this.name}] RPC Error (ID: ${id}):`, parsed.error);
                    pending.reject(new Error(parsed.error.message));
                } else {
                    console.log(`[MCP ${this.name}] SSE Response received (ID: ${id})`);
                    pending.resolve(parsed.result);
                }
            }
        } catch (error) {
            console.error(`[MCP ${this.name}] Error processing SSE message:`, error);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    // SHARED UTILITIES
    // ═══════════════════════════════════════════════════════════════════

    private getHeaders() {
        const headers: any = {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/event-stream'
        };
        if (this.authToken) {
            headers['Authorization'] = `Bearer ${this.authToken}`;
        }
        if (this.sessionId) {
            headers['mcp-session-id'] = this.sessionId;
        }
        return headers;
    }

    /**
     * Parse a POST response that could be:
     * - JSON string: '{"jsonrpc":"2.0",...}'
     * - SSE-formatted: 'event: message\ndata: {...}\n\n'
     * - Already-parsed object
     */
    private parsePostResponse(data: any, contentType?: string): JsonRpcResponse | null {
        if (!data) return null;

        // Already an object (pre-parsed by axios)
        if (typeof data === 'object' && data.jsonrpc) {
            return data as JsonRpcResponse;
        }

        if (typeof data !== 'string') return null;

        const str = data.trim();
        if (!str) return null;

        // Try direct JSON parse first
        if (str.startsWith('{')) {
            try {
                return JSON.parse(str) as JsonRpcResponse;
            } catch { }
        }

        // Parse SSE-formatted response: extract data: lines
        const lines = str.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data:')) {
                const jsonStr = trimmed.substring(5).trim();
                if (jsonStr.startsWith('{')) {
                    try {
                        return JSON.parse(jsonStr) as JsonRpcResponse;
                    } catch { }
                }
            }
        }

        return null;
    }

    // ─── Public API ─────────────────────────────────────────────────────

    public async waitReady(timeoutMs: number = 60000): Promise<boolean> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.isInitialized) return true;
            await new Promise(r => setTimeout(r, 500));
        }
        return false;
    }

    async callTool(toolName: string, args: any): Promise<any> {
        if (!this.isInitialized) {
            throw new Error(`MCP Client ${this.name} is not connected.`);
        }

        try {
            if (this.transport === 'streamable') {
                return await this.callStreamable('tools/call', { name: toolName, arguments: args });
            } else {
                return await this.sendSSERequest('tools/call', { name: toolName, arguments: args });
            }
        } catch (err: any) {
            // If it's a timeout or a session error, try to reconnect and retry once
            const isTimeout = err.message?.includes('timeout') || err.code === 'ECONNABORTED';
            const status = err.response?.status;
            const errorMsg = err.response?.data?.error?.message || err.message || '';

            const isSessionError =
                isTimeout ||
                status === 401 ||
                status === 400 ||
                errorMsg.toLowerCase().includes('session') ||
                errorMsg.toLowerCase().includes('not initialized');

            if (isSessionError) {
                console.warn(`[MCP ${this.name}] Tool call failed (${errorMsg}). status=${status}. Attempting force reconnect and retry...`);
                await this.forceReconnect();

                if (this.transport === 'streamable') {
                    return await this.callStreamable('tools/call', { name: toolName, arguments: args });
                } else {
                    return await this.sendSSERequest('tools/call', { name: toolName, arguments: args });
                }
            }
            throw err;
        }
    }

    async listTools(): Promise<any> {
        if (!this.isInitialized) {
            throw new Error(`MCP Client ${this.name} is not connected.`);
        }

        if (this.transport === 'streamable') {
            return this.callStreamable('tools/list', {});
        } else {
            return this.sendSSERequest('tools/list', {});
        }
    }

    /**
     * Generic Streamable HTTP call (direct POST, response in body).
     */
    private async callStreamable(method: string, params: any): Promise<any> {
        const requestId = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const payload: JsonRpcRequest = {
            jsonrpc: '2.0',
            method,
            params,
            id: requestId
        };

        console.log(`[MCP ${this.name}] POST ${method} (ID: ${requestId})`);

        const response = await axios.post(this.baseUrl, payload, {
            headers: this.getHeaders(),
            timeout: 60000,
            transformResponse: [(data: any) => data] as any,
            // @ts-expect-error
            proxy: false
        });

        const parsed = this.parsePostResponse(response.data, response.headers['content-type']);

        if (!parsed) {
            throw new Error(`Empty response from ${this.name} for ${method}`);
        }

        if (parsed.error) {
            throw new Error(parsed.error.message || 'JSON-RPC error');
        }

        return parsed.result;
    }
}
