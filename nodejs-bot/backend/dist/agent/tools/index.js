"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.toolFunctions = exports.tools = exports.reservasMcp = exports.cardapioMcp = void 0;
exports.popToolTelemetry = popToolTelemetry;
exports.connectMcpClients = connectMcpClients;
exports.getToolsForAgent = getToolsForAgent;
exports.executeDynamicTool = executeDynamicTool;
const axios_1 = __importDefault(require("axios"));
const mcp_1 = require("../../services/mcp");
const toolTelemetryByChatId = new Map();
function pushToolTelemetry(chatwootId, event) {
    if (!chatwootId)
        return;
    const existing = toolTelemetryByChatId.get(chatwootId) || [];
    existing.push(event);
    toolTelemetryByChatId.set(chatwootId, existing);
}
function popToolTelemetry(chatwootId) {
    const events = toolTelemetryByChatId.get(chatwootId) || [];
    toolTelemetryByChatId.delete(chatwootId);
    return events;
}
// ─── MCP Client Instances (connected once at startup from server.ts) ───
exports.cardapioMcp = new mcp_1.McpClient(process.env.MCP_CARDAPIO_URL || 'http://172.17.0.1:3001/mcp', 'Cardapio', process.env.MCP_CARDAPIO_TOKEN || process.env.MCP_RESERVAS_TOKEN, true, // tokenInUrl
'sse' // transport
);
exports.reservasMcp = new mcp_1.McpClient(process.env.MCP_RESERVAS_URL || 'https://mcp.reservas.wegosb.com.br/mcp', 'Reservas', process.env.MCP_RESERVAS_TOKEN, false, // tokenInUrl: no ?token= in URL
'streamable' // transport: direct POST (no SSE)
);
// ─── Tool Registry ─────────────────────────────────────────────────────
const toolRegistry = {};
let cachedTools = null;
let lastFetchTime = 0;
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
// ─── Static/local tools (always available) ─────────────────────────────
const BASE_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'mcp_adm',
            description: 'Encaminha solicitações para áreas administrativas (Financeiro, Compras, RH). Use APENAS se o cliente pedir explicitamente contato administrativo ou demonstrar interesse comercial/corporativo.',
            parameters: {
                type: 'object',
                properties: {
                    setor: { type: 'string', enum: ['Financeiro', 'Compras', 'RH'] },
                    phone: { type: 'string', description: 'Número de telefone do usuário (ID)' }
                },
                required: ['setor', 'phone']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_kids_info',
            description: 'Retorna informações atualizadas sobre preços e horários do Espaço Kids de todas as unidades.',
            parameters: { type: 'object', properties: {} }
        }
    },
    {
        type: 'function',
        function: {
            name: 'get_cardapio_link',
            description: 'Retorna o link do cardápio digital (PDF ou Site) para a localidade informada.',
            parameters: {
                type: 'object',
                properties: {
                    localidade: { type: 'string', enum: ['Curitiba', 'Londrina', 'São Paulo'] }
                },
                required: ['localidade']
            }
        }
    }
];
// Register mcp_adm local handler
toolRegistry['mcp_adm'] = {
    client: null,
    localFn: async (args) => {
        console.log('[Agent] Calling mcp_adm (Admin Webhook)', args);
        try {
            await axios_1.default.post('https://auto.webhook.kharina.com.br/webhook/0311f366-9d47-47f0-9802-e0fce06bec2a', {
                setor: args.setor,
                phone: args.phone,
                timestamp: new Date().toISOString()
            });
            return `✅ Solicitação encaminhada para o setor: ${args.setor}. O responsável entrará em contato em breve.`;
        }
        catch (e) {
            console.error('[Agent] mcp_adm failed:', e.message);
            return `✅ Solicitação encaminhada para o setor: ${args.setor}.`;
        }
    }
};
// Register get_kids_info local handler
const db_1 = require("../../services/db");
toolRegistry['get_kids_info'] = {
    client: null,
    localFn: async () => {
        try {
            const content = await db_1.db.getConfig('kids_info_content');
            if (!content)
                return "Não há informações cadastradas sobre o Espaço Kids no momento.";
            return content;
        }
        catch (e) {
            console.error('[Agent] get_kids_info failed:', e);
            return "Erro ao consultar informações do Espaço Kids.";
        }
    }
};
// Register get_cardapio_link local handler
toolRegistry['get_cardapio_link'] = {
    client: null,
    localFn: async (args) => {
        const linkCuritiba = await db_1.db.getConfig('link_cardapio_curitiba');
        const linkLondrina = await db_1.db.getConfig('link_cardapio_londrina');
        const linkSP = await db_1.db.getConfig('link_cardapio_sp');
        // If all links are identical, return the generic one and notify the agent
        if (linkCuritiba === linkLondrina && linkLondrina === linkSP) {
            return `INFO: O link é o mesmo para todas as cidades. Use o link geral: ${linkCuritiba || "https://cardapio.kharina.com.br/"}`;
        }
        let key = 'link_cardapio_curitiba'; // default
        const loc = args.localidade?.toLowerCase() || '';
        if (loc.includes('londrina'))
            key = 'link_cardapio_londrina';
        else if (loc.includes('paulo'))
            key = 'link_cardapio_sp';
        const link = await db_1.db.getConfig(key);
        return link || "https://cardapio.kharina.com.br/";
    }
};
// ─── Connect MCP Clients (called ONCE from server.ts) ──────────────────
function connectMcpClients() {
    console.log('[Agent] Connecting MCP clients...');
    exports.cardapioMcp.connect();
    // Stagger second connection to avoid rate-limiting
    setTimeout(() => {
        exports.reservasMcp.connect();
    }, 2000);
}
// ─── Fetch & cache MCP tool definitions ────────────────────────────────
async function fetchMcpTools() {
    const mcpTools = [];
    const clients = [exports.cardapioMcp, exports.reservasMcp];
    for (const client of clients) {
        if (!client.ready) {
            console.warn(`[Agent] Client ${client.name} not ready. Skipping tool listing.`);
            continue;
        }
        try {
            const result = await client.listTools();
            if (result?.tools) {
                for (const tool of result.tools) {
                    mcpTools.push({
                        type: 'function',
                        function: {
                            name: tool.name,
                            description: tool.description,
                            parameters: tool.inputSchema
                        }
                    });
                    // Register for dispatch
                    toolRegistry[tool.name] = { client };
                }
                const toolNames = result.tools.map((t) => t.name).join(', ');
                console.log(`[Agent] Loaded ${result.tools.length} tools from ${client.name}: [${toolNames}]`);
            }
        }
        catch (err) {
            console.warn(`[Agent] Could not fetch tools from ${client.name}: ${err.message}`);
        }
    }
    // Ensure legacy aliases point to the correct clients
    if (!toolRegistry['mcp_enviacardapio']) {
        toolRegistry['mcp_enviacardapio'] = { client: exports.cardapioMcp };
    }
    if (!toolRegistry['mcp_reserva']) {
        toolRegistry['mcp_reserva'] = { client: exports.reservasMcp };
    }
    return mcpTools;
}
/**
 * Returns all tools for the OpenAI agent.
 * Uses a 30-minute cache. Does NOT trigger connections — that's done at startup.
 */
async function getToolsForAgent() {
    const now = Date.now();
    if (cachedTools && (now - lastFetchTime < CACHE_TTL)) {
        return cachedTools;
    }
    console.log('[Agent] Refreshing dynamic tools...');
    try {
        const mcpTools = await fetchMcpTools();
        cachedTools = [...BASE_TOOLS, ...mcpTools];
        lastFetchTime = now;
        console.log(`[Agent] Total tools available: ${cachedTools.length} (${BASE_TOOLS.length} local + ${mcpTools.length} MCP)`);
        return cachedTools;
    }
    catch (e) {
        console.error('[Agent] Error getting dynamic tools:', e);
        // Graceful degradation: return local tools only
        return BASE_TOOLS;
    }
}
/**
 * Executes a tool by name, routing to either a local function or an MCP client.
 */
async function executeDynamicTool(name, args, meta) {
    const registration = toolRegistry[name];
    if (!registration) {
        return JSON.stringify({ error: `Tool ${name} not found in registry.` });
    }
    if (registration.localFn) {
        return await registration.localFn(args);
    }
    if (registration.client) {
        if (!registration.client.ready) {
            return JSON.stringify({ error: `MCP server ${registration.client.name} is not connected. Please try again later.` });
        }
        try {
            // Handle legacy name mapping
            let actualToolName = name;
            if (name === 'mcp_enviacardapio')
                actualToolName = 'mcp_cardapio';
            const result = await registration.client.callTool(actualToolName, args);
            if (result?.content && Array.isArray(result.content)) {
                const text = result.content.map((c) => c.text).join('\n');
                // MCP reservas has a known inconsistency where check_availability can return
                // available=false with no reason payload when there is any confirmed booking in slot.
                // In this specific shape, treat it as "likely available" to avoid false negative UX.
                if (actualToolName === 'check_availability') {
                    try {
                        const parsed = JSON.parse(text);
                        const data = parsed?.data;
                        const hasStructuredReason = !!data?.message ||
                            data?.maxCapacity !== undefined ||
                            data?.currentOccupancy !== undefined ||
                            data?.availableCapacity !== undefined ||
                            data?.storeOpen !== undefined ||
                            data?.storeClose !== undefined;
                        if (parsed?.success === true && data?.available === false && !hasStructuredReason) {
                            const normalized = {
                                ...parsed,
                                data: {
                                    ...data,
                                    available: true,
                                    botNormalized: true,
                                    botNormalizationReason: 'false_negative_without_reason_from_mcp'
                                }
                            };
                            console.warn('[Agent] check_availability normalized (false negative without reason) to available=true');
                            pushToolTelemetry(meta?.chatwootId, {
                                type: 'check_availability_normalized',
                                reason: 'false_negative_without_reason_from_mcp',
                                storeId: args?.storeId,
                                date: args?.date,
                                time: args?.time,
                                numberOfPeople: args?.numberOfPeople,
                                at: new Date().toISOString()
                            });
                            return JSON.stringify(normalized);
                        }
                    }
                    catch {
                        // Keep original payload if parsing fails.
                    }
                }
                return text;
            }
            return JSON.stringify(result);
        }
        catch (e) {
            const status = e?.response?.status || e?.status;
            const responseData = e?.response?.data;
            const detail = typeof responseData === 'string'
                ? responseData
                : responseData
                    ? JSON.stringify(responseData)
                    : e?.message;
            console.error(`[Agent] Tool execution FAILED: ${name}`, status ? `(status ${status})` : '', detail);
            return `Erro ao executar ${name}${status ? ` (status ${status})` : ''}: ${detail}`;
        }
    }
    return JSON.stringify({ error: `Tool ${name} is registered but has no implementation.` });
}
// For compatibility with any legacy imports
exports.tools = [];
exports.toolFunctions = {};
