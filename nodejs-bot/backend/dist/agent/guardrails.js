"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.linkGuardrail = void 0;
const agents_1 = require("@openai/agents");
/**
 * LinkGuardrail: Protege o cliente de URLs alucinadas pelo modelo.
 * Valida se qualquer link de estilo markdown ou URL crua está na lista de links oficiais
 * configurados no banco de dados.
 */
exports.linkGuardrail = (0, agents_1.defineOutputGuardrail)({
    name: 'link_safety_guardrail',
    execute: async ({ agentOutput, context }) => {
        const text = agentOutput.output || '';
        const config = context.context?.config || {};
        // Coleta todos os links oficiais das variáveis (link_cardapio_*, link_delivery_*, kids_instagram_*)
        const officialLinks = Object.keys(config)
            .filter(k => k.startsWith('link_') || k.startsWith('kids_instagram_'))
            .map(k => config[k].toLowerCase());
        // Regex simples para capturar URLs (melhorada se necessário)
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const foundUrls = text.match(urlRegex) || [];
        for (const url of foundUrls) {
            // Remove parênteses ou pontuação final comum em mensagens
            const cleanUrl = url.replace(/[).,;]$/, '').toLowerCase();
            // Se for um link externo suspeito (que não está na lista oficial)
            // Permitindo apenas o domínio base do kharina ou iFood se for parte da lista
            if (!officialLinks.some(link => cleanUrl.includes(link.toLowerCase()) || link.toLowerCase().includes(cleanUrl))) {
                console.warn(`[LinkGuardrail] Bloqueando alucinação de URL: ${cleanUrl}`);
                return {
                    tripwireTriggered: true,
                    outputInfo: {
                        reason: 'hallucinated_url',
                        blockedUrl: cleanUrl
                    }
                };
            }
        }
        return {
            tripwireTriggered: false,
            outputInfo: { status: 'safe' }
        };
    }
});
