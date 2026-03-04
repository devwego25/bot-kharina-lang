"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.triageAgent = exports.reservasAgent = exports.maitreAgent = void 0;
const agents_1 = require("@openai/agents");
const zod_1 = require("zod");
const tools_1 = require("../tools");
const env_1 = require("../../config/env");
// ─── Shared Prompt Fragments ────────────────────────────────────────────────
const CORE_IDENTITY = `
# 🎭 *IDENTIDADE DA AGENTE*
* *Nome*: Kha
* *Personalidade*: Alegre, simpática, acolhedora
* *Estilo*: Informal, humano, divertido
* *Emojis*: Sempre presentes
* *Data de Hoje*: {{current_weekday}}, {{current_date}}

# 📱 REGRAS DE FORMATAÇÃO WHATSAPP (RIGOROSO)
1. *NEGRITO*: Usar *APENAS* um asterisco: \`*palavra*\`. *PROIBIDO* usar dois (\`**\`).
2. 🚫 *PROIBIDO*: Cabeçalhos Markdown (\`#\`, \`##\`). Use *Negrito* para títulos.
3. 🚫 *PROIBIDO*: Links Markdown \`[texto](url)\`. Envie a URL pura: \`👉 https://...\`.
4. 🚫 *PROIBIDO*: Tabelas Markdown. Use listas.
5. 🚫 *PROIBIDO*: Citações Markdown (\`>\`).
`;
const DATE_RULES = `
# 📅 *REGRA_DATAS*
1. Use *somente* a data retornada pelo MCP/Contexto como base.
2. *NUNCA* deduza o ano (use o do MCP).
3. "Amanhã" = Data Atual + 1 dia. "Sexta" = Próxima sexta futura.
4. Validação: Formato \`YYYY-MM-DD\`, Data Futura, Ano Correto.
`;
const FALLBACK_RULES = `
# 🛡️ *REGRA_FALLBACK*
Se não souber responder, faltar dados ou a tool falhar:
1. Pergunte a unidade desejada.
2. Busque o telefone da unidade (via \`list_stores\` ou tabela interna).
3. Responda: "Poxa, essa informação eu não tenho 😕 Mas você pode falar direto com a unidade {nome}: 📞 {telefone}. O pessoal te ajuda!"
4. *NUNCA* invente dados.
`;
const COMMAND_RULES = `
# 🔀 *REGRAS DE COMANDOS INTERNOS*
Se a mensagem do usuário for EXATAMENTE um dos comandos abaixo, responda APENAS o Token:

| Mensagem | Token |
| :--- | :--- |
| MENU_PRINCIPAL | MENU_PRINCIPAL |
| menu_cardapio | MENU_CIDADES_CARDAPIO |
| menu_reserva | LIST_RESERVA_UNIDADES |
| menu_delivery | MENU_DELIVERY_CIDADES |
| voltar, inicio | MENU_PRINCIPAL |
`;
const RESTAURANT_HISTORY = `
# 📜 *CONTEXTO HISTÓRICO - KHARINA*
* *Fundação*: 1975 por Rachid Cury Filho, em Curitiba, aos 24 anos.
* *Origem*: Inspirado em drive-ins americanos dos anos 50.
* *Prato Ícone*: Clube Kharina.
* *Nome*: Inspirado em "Karina", com "H" por escolha do fundador.
* *Slogan*: "Feito de boas escolhas".
* *Marco*: 50 anos de história (1975-2025).
`;
// ─── LinkGuardrail ──────────────────────────────────────────────────────────
const linkGuardrail = {
    name: 'link_safety_guardrail',
    execute: async ({ agentOutput, context }) => {
        const text = agentOutput.output || '';
        const config = context.context?.config || {};
        const officialLinks = Object.keys(config)
            .filter(k => k.startsWith('link_') || k.startsWith('kids_instagram_'))
            .map(k => config[k].toLowerCase());
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const foundUrls = text.match(urlRegex) || [];
        for (const url of foundUrls) {
            const cleanUrl = url.replace(/[).,;]$/, '').toLowerCase();
            if (!officialLinks.some(link => cleanUrl.includes(link) || link.includes(cleanUrl))) {
                console.warn(`[LinkGuardrail] Bloqueando alucinação de URL: ${cleanUrl}`);
                return {
                    tripwireTriggered: true,
                    outputInfo: { reason: 'hallucinated_url', blockedUrl: cleanUrl }
                };
            }
        }
        return { tripwireTriggered: false, outputInfo: { status: 'safe' } };
    }
};
// ─── MAITRE AGENT (Cardápio only) ───────────────────────────────────────────
exports.maitreAgent = new agents_1.Agent({
    name: 'Kha_Maitre',
    model: env_1.config.openai.models.maitre,
    instructions: `${CORE_IDENTITY}
${RESTAURANT_HISTORY}
${COMMAND_RULES}
${DATE_RULES}
${FALLBACK_RULES}

Você é o Maitre e Sommelier do Kharina. Cuida de informações sobre o cardápio.

DIRETRIZES:
1. Responda com elegância e entusiasmo.
2. 🍤 Se sugerir camarão, ofereça Vinho Branco para harmonizar.
3. 🍷 Sugira bebidas que combinem com o prato escolhido.

FLUXO CARDÁPIO:
- Use 'mcp_cardapio' para detalhes e preços. Se retornar vazio, use FALLBACK.
- Se o cliente escolher a cidade, chame \`get_cardapio_link\` **SILENCIOSAMENTE**. Apenas entregue o link.

🔒 *GROUNDING*:
- Você SÓ pode responder pratos, preços e ingredientes com base no retorno real da tool \`mcp_cardapio\`.
- Se retornar \`CARDAPIO_DATA_NOT_FOUND\`, use fallback. NÃO invente nenhum item.
`,
    handoffDescription: 'Trata de cardápio e vinhos.',
    tools: [
        (0, agents_1.tool)({
            name: 'mcp_cardapio',
            description: 'Busca pratos, ingredientes, preços no cardápio. Retorna CARDAPIO_DATA_FOUND ou CARDAPIO_DATA_NOT_FOUND.',
            parameters: zod_1.z.object({
                query: zod_1.z.string(),
                storeId: zod_1.z.string().nullable(),
                maxItems: zod_1.z.number().nullable()
            }),
            execute: async (args, ctx) => {
                const runContext = ctx.context || {};
                const config = runContext.config || {};
                const normalizeStoreId = (value) => {
                    if (value === null || value === undefined)
                        return undefined;
                    const text = String(value).trim();
                    if (!text || text.toLowerCase() === 'null' || text.toLowerCase() === 'undefined')
                        return undefined;
                    return text;
                };
                const isMeaningfulResult = (value) => {
                    const normalized = (value || '').trim().toLowerCase();
                    if (!normalized || normalized === '[]' || normalized === '{}' || normalized === 'null')
                        return false;
                    if (normalized.includes('"items":[]') || normalized.includes('"items": []'))
                        return false;
                    if (normalized.includes('nenhum item encontrado') || normalized.includes('"error"'))
                        return false;
                    const maybeJsonStart = value.indexOf('{');
                    if (maybeJsonStart >= 0) {
                        try {
                            const parsed = JSON.parse(value.slice(maybeJsonStart));
                            if (Array.isArray(parsed?.items) && parsed.items.length === 0)
                                return false;
                        }
                        catch { }
                    }
                    return true;
                };
                const baseArgs = { query: args.query, maxItems: args.maxItems || 5 };
                // Build candidate store IDs
                const candidateStoreIds = [];
                const pushCandidate = (id) => {
                    if (id && !candidateStoreIds.includes(id))
                        candidateStoreIds.push(id);
                };
                pushCandidate(normalizeStoreId(args.storeId));
                pushCandidate(runContext.preferredStoreId);
                const uuidEntries = Object.keys(config)
                    .filter(k => k.startsWith('uuid_'))
                    .map(k => ({ key: k, value: config[k] }));
                for (const entry of uuidEntries)
                    pushCandidate(entry.value);
                if (!candidateStoreIds.length) {
                    const result = await (0, tools_1.executeDynamicTool)('mcp_cardapio', baseArgs);
                    return isMeaningfulResult(result) ? `CARDAPIO_DATA_FOUND\n${result}` : 'CARDAPIO_DATA_NOT_FOUND';
                }
                let attempts = 0;
                for (const storeId of candidateStoreIds) {
                    attempts++;
                    if (attempts > 4)
                        break;
                    const result = await (0, tools_1.executeDynamicTool)('mcp_cardapio', { ...baseArgs, storeId });
                    if (isMeaningfulResult(result))
                        return `CARDAPIO_DATA_FOUND\n${result}`;
                }
                return 'CARDAPIO_DATA_NOT_FOUND';
            }
        }),
        (0, agents_1.tool)({
            name: 'get_cardapio_link',
            description: 'Retorna o link do cardápio digital para a localidade informada.',
            parameters: zod_1.z.object({
                localidade: zod_1.z.enum(['Curitiba', 'Londrina', 'São Paulo'])
            }),
            execute: async (args, ctx) => {
                const config = ctx.context?.config || {};
                let key = 'link_cardapio_curitiba';
                if (args.localidade === 'Londrina')
                    key = 'link_cardapio_londrina';
                else if (args.localidade === 'São Paulo')
                    key = 'link_cardapio_sp';
                return config[key] || "Confira nosso cardápio no site oficial!";
            }
        })
    ],
    outputGuardrails: [linkGuardrail]
});
// ─── RESERVAS AGENT ─────────────────────────────────────────────────────────
exports.reservasAgent = new agents_1.Agent({
    name: 'Kha_Reservas',
    model: env_1.config.openai.models.reservas,
    instructions: `${CORE_IDENTITY}
${COMMAND_RULES}
${DATE_RULES}

Você é a especialista em reservas do Kharina.

# 📱 TELEFONE DO CLIENTE
O telefone do cliente está em INSTRUCOES_MANDATORIAS_DO_BACKEND como "Telefone WhatsApp do cliente".
NUNCA peça o telefone ao cliente — use o número do WhatsApp automaticamente.

# 🛡️ REGRA_FALLBACK (RESERVAS)
⚠️ O fallback "mande ligar pro restaurante" NÃO se aplica a reservas.
Para QUALQUER operação de reserva (criar, consultar, cancelar, alterar), você DEVE usar as ferramentas disponíveis.
🚫 PROIBIDO: Dizer "Poxa, essa informação eu não tenho" para pedidos de reserva/cancelamento/consulta.
🚫 PROIBIDO: Mandar o cliente ligar pro restaurante quando você tem ferramentas para resolver.
O fallback só é permitido se uma tool FALHAR com erro técnico E não houver alternativa.

REGRAS DE OURO:
1. **DADOS NECESSÁRIOS**: Para reservar, você precisa destas informações: [Unidade, Nome, Data, Horário, Pessoas e (Opcional) Crianças]. Se o cliente não falar sobre crianças, você pode perguntar uma única vez "Haverá alguma criança?".
2. **FLUIDEZ**: Monitore os dados que o cliente já forneceu. PERGUNTE APENAS o que falta. Nunca repita perguntas sobre dados já informados.
3. **RESUMO / CONFIRMAÇÃO OBRIGATÓRIA**: 
   🚫 PROIBIDO escrever "Dá uma olhada no resumo abaixo:" ou criar listas manuais com os dados.
   Assim que você coletar as informações necessárias, PARE de gerar texto. A sua ÚNICA e EXCLUSIVA resposta deve ser OBRIGATORIAMENTE o token mágico abaixo:
   CONFIRM_RESERVATION_RESUMO
   (Nosso sistema interceptará este token e mostrará a tela visual de confirmação para o cliente).
4. **TELEFONE**: NUNCA peça o telefone para novas reservas, o sistema já sabe o número do WhatsApp. Apenas utilize para 'query_reservations', 'query_client' ou 'create_client'.
5. **CONFIRMAÇÃO FINAL**: Após o cliente aprovar o resumo visual, você receberá "confirm_reserva_sim". Quando isso acontecer, chame a tool 'create_reservation' SILENCIOSAMENTE. SÓ ENVIE MENSAGEM DE SUCESSO após a ferramenta 'create_reservation' retornar success: true.
   
⚠️ ATENÇÃO MÁXIMA PARA A REGRA 5: A reserva NÃO FOI FEITA até que 'create_reservation' termine com sucesso! Não dê "faz de conta" dizendo que a reserva está feita antes da tool rodar.
🚫 PROIBIDO: Responder sucesso SEM ter chamado 'create_reservation'.
🚫 PROIBIDO: Chamar 'query_client' e 'create_reservation' ao mesmo tempo.

# 🔄 ALTERAÇÃO / MODIFICAÇÃO DE RESERVA
Quando o cliente pedir para ALTERAR uma reserva:
1. Use 'query_reservations' com o telefone do cliente para encontrar a reserva.
2. Guarde o 'reservationId' retornado.
3. CANCELE a reserva antiga com 'cancel_reservation' usando o 'reservationId'. Motivo: "Alteração solicitada pelo cliente".
4. Crie a NOVA reserva com 'create_reservation' mantendo os dados originais e aplicando APENAS as alterações solicitadas.

⚠️ REGRAS DE ALTERAÇÃO:
- Se o cliente diz "altera pra 6 pessoas", mude APENAS o número de pessoas.
- O **nome do cliente** vem do retorno de 'query_reservations' ou 'query_client', NUNCA do texto do pedido.
- SEMPRE cancele ANTES de criar a nova. Nunca deixe duas reservas ativas.

# 🔍 CONSULTA DE RESERVA
Quando o cliente perguntar sobre reservas ("tenho reserva?", "minhas reservas", "ver reservas"):
1. Use 'query_reservations' com o telefone do cliente — SEMPRE.
2. Se retornar reservas, mostre de forma amigável com emojis.
3. Se NÃO retornar reservas, diga que não encontrou nenhuma reserva ativa.
4. Sempre inclua o ID: 🆔 *ID*: {reservationId}

# ❌ CANCELAMENTO DE RESERVA
Quando o cliente pedir para CANCELAR ("cancelar reserva", "cancela", "não vou poder ir"):
1. PRIMEIRO: Use 'query_reservations' com o telefone do cliente para encontrar a(s) reserva(s).
2. Se encontrar UMA reserva, mostre os dados e pergunte se deseja cancelar.
3. Se encontrar MAIS DE UMA, liste todas e pergunte qual cancelar.
4. Após confirmação do cliente, use 'cancel_reservation' com o 'reservationId'.
5. Confirme o cancelamento com a mensagem de sucesso.

Template de sucesso de CANCELAMENTO:
"Reserva cancelada com sucesso! ✅
Sua reserva do dia {data_legivel} às {hora}h na unidade {unidade} foi cancelada. Se precisar de algo mais, estou aqui! 🧡"

⚠️ NUNCA confunda CANCELAMENTO com CRIAÇÃO. Se o contexto é cancelar e o cliente confirmou, execute cancel_reservation, NÃO create_reservation.

# ✅ TEMPLATE DE SUCESSO (CRIAÇÃO)
Use este template APENAS após create_reservation retornar sucesso:
"Reserva confirmada com sucesso! 🎉
Nos vemos dia {data_legivel} às {hora}h na unidade {unidade}! 🧡

⏰ Lembre-se:
- Procure chegar 10 minutos antes
- Você tem 15 minutos de tolerância
- Depois disso, a reserva é cancelada automaticamente ❤️"
`,
    handoffDescription: 'Trata de reservas de mesas.',
    modelSettings: {
        reasoning: { effort: 'medium' }
    },
    tools: [
        (0, agents_1.tool)({
            name: 'check_availability',
            description: 'Verifica disponibilidade de mesas.',
            parameters: zod_1.z.object({
                storeId: zod_1.z.string(),
                date: zod_1.z.string(),
                time: zod_1.z.string(),
                numberOfPeople: zod_1.z.number().min(1).max(100)
            }),
            inputGuardrails: [
                {
                    name: 'store_validation',
                    run: async ({ context, toolCall }) => {
                        const config = context.context?.config || {};
                        const args = JSON.parse(toolCall.arguments);
                        const validUuids = Object.keys(config).filter(k => k.startsWith('uuid_')).map(k => config[k]);
                        if (!validUuids.includes(args.storeId)) {
                            return { behavior: { type: 'rejectContent', message: "Ops! Essa unidade parece não estar correta. Poderia me confirmar?" } };
                        }
                        return { behavior: { type: 'allow' } };
                    }
                },
                {
                    name: 'capacity_guardrail',
                    run: async ({ context, toolCall }) => {
                        const config = context.context?.config || {};
                        const args = JSON.parse(toolCall.arguments);
                        const max = parseInt(config['max_reservation_people'] || '30');
                        if (args.numberOfPeople > max) {
                            return { behavior: { type: 'rejectContent', message: `O limite para reservas online é de até ${max} pessoas. Para grupos maiores, entre em contato direto com a unidade.` } };
                        }
                        return { behavior: { type: 'allow' } };
                    }
                }
            ],
            execute: async (args, ctx) => {
                return await (0, tools_1.executeDynamicTool)('check_availability', args, {
                    chatwootId: ctx?.context?.chatwootId
                });
            }
        }),
        (0, agents_1.tool)({
            name: 'create_reservation',
            description: 'Finaliza a reserva no sistema.',
            parameters: zod_1.z.object({
                storeId: zod_1.z.string(),
                clientPhone: zod_1.z.string(),
                date: zod_1.z.string(),
                time: zod_1.z.string(),
                numberOfPeople: zod_1.z.number(),
                kids: zod_1.z.number().nullable(),
                notes: zod_1.z.string().nullable()
            }),
            execute: async (args, ctx) => {
                const runContext = ctx?.context || {};
                const facts = runContext.reservationFacts || {};
                // Auto-upsert client name before creating reservation to guarantee proper name in CRM
                if (facts.name || args.clientPhone) {
                    const phoneToUse = args.clientPhone || facts.contactPhone || runContext.clientPhone;
                    const nameToUse = facts.name || 'Cliente';
                    try {
                        console.log(`[Agent] Auto-updating client name via MCP: ${nameToUse} (${phoneToUse})`);
                        await (0, tools_1.executeDynamicTool)('create_client', { name: nameToUse, phone: phoneToUse });
                    }
                    catch (e) {
                        console.error('[Agent] Non-fatal error auto-updating client name:', e);
                    }
                }
                const cleanedArgs = {
                    ...args,
                    time: facts.timeText && facts.timeText.length >= 4 ? facts.timeText : args.time,
                    numberOfPeople: facts.people !== undefined ? Number(facts.people) : args.numberOfPeople,
                    kids: facts.kids !== undefined ? Number(facts.kids) : (args.kids || 0),
                    notes: facts.notes || args.notes || undefined
                };
                if (runContext.preferredStoreId)
                    cleanedArgs.storeId = runContext.preferredStoreId;
                return await (0, tools_1.executeDynamicTool)('create_reservation', cleanedArgs);
            }
        }),
        (0, agents_1.tool)({
            name: 'query_client',
            description: 'Pesquisa cliente por telefone.',
            parameters: zod_1.z.object({ phone: zod_1.z.string() }),
            execute: async (args) => await (0, tools_1.executeDynamicTool)('query_client', args)
        }),
        (0, agents_1.tool)({
            name: 'create_client',
            description: 'Cria novo cliente.',
            parameters: zod_1.z.object({
                name: zod_1.z.string(),
                phone: zod_1.z.string(),
                email: zod_1.z.string().nullable()
            }),
            execute: async (args) => {
                return await (0, tools_1.executeDynamicTool)('create_client', { ...args, email: args.email || undefined });
            }
        }),
        (0, agents_1.tool)({
            name: 'list_stores',
            description: 'Lista unidades.',
            parameters: zod_1.z.object({}),
            execute: async () => await (0, tools_1.executeDynamicTool)('list_stores', {})
        }),
        (0, agents_1.tool)({
            name: 'query_reservations',
            description: 'Consulta reservas de um cliente por telefone.',
            parameters: zod_1.z.object({
                clientPhone: zod_1.z.string(),
                startDate: zod_1.z.string().nullable(),
                endDate: zod_1.z.string().nullable()
            }),
            execute: async (args) => {
                return await (0, tools_1.executeDynamicTool)('query_reservations', {
                    ...args,
                    startDate: args.startDate || undefined,
                    endDate: args.endDate || undefined
                });
            }
        }),
        (0, agents_1.tool)({
            name: 'cancel_reservation',
            description: 'Cancela uma reserva existente pelo ID.',
            parameters: zod_1.z.object({
                reservationId: zod_1.z.string(),
                reason: zod_1.z.string().nullable()
            }),
            execute: async (args) => {
                return await (0, tools_1.executeDynamicTool)('cancel_reservation', {
                    reservationId: args.reservationId,
                    reason: args.reason || undefined
                });
            }
        })
    ],
    handoffs: [(0, agents_1.handoff)(exports.maitreAgent)],
    outputGuardrails: [linkGuardrail]
});
// Cross-reference handoffs
exports.maitreAgent.handoffs = [(0, agents_1.handoff)(exports.reservasAgent)];
// ─── TRIAGE AGENT ───────────────────────────────────────────────────────────
exports.triageAgent = new agents_1.Agent({
    name: 'Kha_Triage',
    model: env_1.config.openai.models.triage,
    instructions: `${CORE_IDENTITY}
${RESTAURANT_HISTORY}
${COMMAND_RULES}
Você é a recepção (Triage) do Kharina.
Sua função é identificar a intenção do cliente e transferir para o especialista correto.

⚠️ *REGRA PARA TOKENS*: Se a mensagem exige TOKEN (ex: menu_cardapio -> MENU_CIDADES_CARDAPIO), responda o token você mesmo. NUNCA faça handoff para tokens.

⚠️ *REGRA PARA AÇÕES*: Se a mensagem exige FERRAMENTA (ex: cardapio_curitiba), faça HANDOFF:
- cardapio_* -> Kha_Maitre
- unidade_*, phone_*, confirm_* -> Kha_Reservas

⚠️ *SAUDAÇÕES*: Se o usuário disser APENAS um cumprimento ("oi", "olá", "bom dia", etc.), responda APENAS: MENU_PRINCIPAL

ENCAMINHAMENTO:
- Cardápio, pratos, vinhos -> Kha_Maitre
- Reservar mesa, disponibilidade, aniversário -> Kha_Reservas

⚠️ *SILÊNCIO NO HANDOFF*: Ao transferir, NÃO escreva texto. Apenas chame o handoff.
`,
    handoffs: [
        (0, agents_1.handoff)(exports.maitreAgent),
        (0, agents_1.handoff)(exports.reservasAgent)
    ]
});
