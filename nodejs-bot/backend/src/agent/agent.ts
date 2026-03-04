import { run, MemorySession, Session } from '@openai/agents';
import { triageAgent } from './agents';
import { config } from '../config/env';
import { db } from '../services/db';
import { popToolTelemetry } from './tools';

// Mapa para manter as sessões em memória por ID do Chatwoot (ou telefone)
// Futuramente, podemos persistir isso no Redis/DB
const activeSessions = new Map<string, Session>();
const promptPrimedSessions = new Set<string>();
const USE_STATELESS_SESSION = true;

function stringifySafe(value: any): string {
    try {
        if (typeof value === 'string') return value;
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function truncateText(text: string, max = 220): string {
    if (!text) return text;
    return text.length > max ? `${text.slice(0, max)}...` : text;
}

function logRunItems(result: any) {
    const items = Array.isArray(result?.newItems) ? result.newItems : [];
    if (!items.length) {
        console.log('[KhaAgent] Trace: sem itens novos no turno.');
        return;
    }

    console.log(`[KhaAgent] Trace: ${items.length} item(ns) no turno.`);

    for (const item of items) {
        const type = item?.type || item?.itemType || 'unknown';
        const rawType = item?.rawItem?.type || '';

        const toolName = item?.name || item?.tool_name || item?.toolName || item?.rawItem?.name;
        const maybeArgs = item?.arguments || item?.args || item?.input || item?.rawItem?.arguments;
        const maybeOutput = item?.output || item?.result || item?.rawItem?.output;
        let agentName = item?.agent?.name || item?.fromAgent?.name || item?.toAgent?.name;
        const text = item?.text || item?.content || item?.output_text || item?.rawItem?.text;

        if (!agentName && item?.rawItem?.output?.text) {
            try {
                const parsed = JSON.parse(item.rawItem.output.text);
                agentName = parsed?.assistant || parsed?.agent || parsed?.name;
            } catch {
                // Ignore parse failure and keep fallback
            }
        }

        if (rawType === 'function_call_result' && toolName) {
            console.log(
                `[KhaAgent] 🛠️ Tool Output: ${toolName} => ${truncateText(stringifySafe(maybeOutput))}`
            );
            continue;
        }

        if (toolName && (type.includes('tool') || type.includes('function') || type.includes('call'))) {
            console.log(
                `[KhaAgent] 🛠️ Tool Call: ${toolName} args=${truncateText(stringifySafe(maybeArgs))}`
            );
            if (maybeOutput !== undefined) {
                console.log(
                    `[KhaAgent] 🛠️ Tool Output: ${toolName} => ${truncateText(stringifySafe(maybeOutput))}`
                );
            }
            continue;
        }

        if (type.includes('handoff')) {
            console.log(
                `[KhaAgent] 🔀 Handoff: ${agentName || 'unknown-agent'} (${truncateText(stringifySafe(item))})`
            );
            continue;
        }

        if (typeof text === 'string' && text.trim()) {
            console.log(`[KhaAgent] 💬 Item(${type}): ${truncateText(text)}`);
            continue;
        }

        console.log(`[KhaAgent] • Item(${type}): ${truncateText(stringifySafe(item))}`);
    }
}

function collectToolsCalled(result: any): string[] {
    const items = Array.isArray(result?.newItems) ? result.newItems : [];
    const tools = new Set<string>();

    for (const item of items) {
        const type = item?.type || item?.itemType || '';
        const toolName = item?.name || item?.tool_name || item?.toolName || item?.rawItem?.name;
        if (!toolName) continue;
        if (type.includes('tool') || type.includes('function') || type.includes('call')) {
            tools.add(String(toolName));
        }
    }
    return Array.from(tools);
}

function buildHistoryContext(history: any[] = []): string {
    if (!Array.isArray(history) || history.length === 0) return '';
    const recent = history.slice(-8);
    const lines = recent.map((h: any) => {
        const role = h?.role === 'assistant' ? 'ASSISTENTE' : 'CLIENTE';
        const content = truncateText(String(h?.content || ''), 280).replace(/\n+/g, ' ').trim();
        return `${role}: ${content}`;
    });
    return lines.join('\n');
}

export class KhaAgent {
    /**
     * Processa uma mensagem do usuário usando a arquitetura multi-agente
     */
    async processMessage(input: string, chatwootId: string, context: any = {}): Promise<{ response: string; logs?: any }> {
        try {
            // 1. Recupera ou cria a sessão do usuário
            let session: Session | undefined = undefined;
            if (!USE_STATELESS_SESSION) {
                session = activeSessions.get(chatwootId);
                if (!session) {
                    session = new MemorySession();
                    activeSessions.set(chatwootId, session);
                    promptPrimedSessions.delete(chatwootId);
                    console.log(`[KhaAgent] Nova sessão criada para: ${chatwootId}`);
                }
            }

            // 2. Carrega configurações do sistema (Links, Telefones, UUIDs)
            const configs = await db.listConfigs();
            const configMap: Record<string, string> = {};
            configs.forEach(c => configMap[c.key] = c.value);

            // 3. Prepara o contexto de execução (Data, Unidade, etc)
            const runContext = {
                ...context,
                chatwootId,
                currentDate: new Date().toISOString(),
                timezone: 'America/Sao_Paulo',
                config: configMap // Injeta todas as configs aqui
            };

            // 4. Executa o Runner (começando pelo Triage)
            const shouldPrimePrompt = !!context?.systemPrompt && (USE_STATELESS_SESSION || !promptPrimedSessions.has(chatwootId));
            const agentInput = shouldPrimePrompt
                ? `CONTEXTO_BASE_KHARINA (siga estas regras como prioridade):\n${context.systemPrompt}\n\nMENSAGEM_DO_CLIENTE:\n${input}`
                : input;
            const forceInstructions = context?.forceInstructions
                ? `\n\nINSTRUCOES_MANDATORIAS_DO_BACKEND:\n${context.forceInstructions}`
                : '';
            const historyContext = buildHistoryContext(context?.history || []);
            const finalInput = historyContext
                ? `${agentInput}\n\nHISTORICO_RECENTE_PARA_CONTEXTO:\n${historyContext}${forceInstructions}`
                : `${agentInput}${forceInstructions}`;

            if (shouldPrimePrompt) {
                promptPrimedSessions.add(chatwootId);
            }

            console.log(`[KhaAgent] Processando input para ${chatwootId}: "${input}"`);

            let result;
            try {
                result = await run(triageAgent, finalInput, {
                    ...(session ? { session } : {}),
                    context: runContext
                });
            } catch (runError: any) {
                console.error('[KhaAgent] Erro durante execução do agente:', JSON.stringify(runError, null, 2));

                // FALLBACK: Só limpa sessão se for erro específico de validação de histórico/reasoning da OpenAI
                if (runError?.status === 400 && (runError?.message?.includes("'reasoning'") || runError?.message?.includes("'history'"))) {
                    console.warn(`[KhaAgent] Erro crítico de histórico (${runError.message}). Resetando sessão para recuperar...`);
                    session = USE_STATELESS_SESSION ? undefined : new MemorySession();
                    if (session) activeSessions.set(chatwootId, session);
                    promptPrimedSessions.delete(chatwootId);

                    // Tenta novamente com sessão limpa
                    const retryInput = context?.systemPrompt
                        ? `CONTEXTO_BASE_KHARINA (siga estas regras como prioridade):\n${context.systemPrompt}\n\nMENSAGEM_DO_CLIENTE:\n${input}`
                        : input;
                    const retryFinalInput = historyContext
                        ? `${retryInput}\n\nHISTORICO_RECENTE_PARA_CONTEXTO:\n${historyContext}${forceInstructions}`
                        : `${retryInput}${forceInstructions}`;
                    promptPrimedSessions.add(chatwootId);

                    result = await run(triageAgent, retryFinalInput, {
                        ...(session ? { session } : {}),
                        context: runContext
                    });
                } else {
                    throw runError;
                }
            }

            // 5. Extrai a resposta final
            let finalResponse = '';
            if (typeof result.finalOutput === 'string') {
                finalResponse = result.finalOutput;
            } else if (result.finalOutput !== null && result.finalOutput !== undefined) {
                finalResponse = String(result.finalOutput);
            }
            if (!finalResponse.trim()) {
                finalResponse = "Desculpe, tive um probleminha técnico aqui. 😅 Pode repetir por favor?";
            }

            const usage = (result as any).usage;
            if (usage?.completion_tokens_details?.reasoning_tokens) {
                console.log(`[KhaAgent] 🧠 Raciocínio Detectado! O modelo usou ${usage.completion_tokens_details.reasoning_tokens} tokens de pensamento.`);
            } else if (usage) {
                console.log(`[KhaAgent] 📊 Uso de Tokens: Input=${usage.prompt_tokens}, Output=${usage.completion_tokens}, Total=${usage.total_tokens}`);
            }
            logRunItems(result);
            const toolsCalled = collectToolsCalled(result);
            if (toolsCalled.length) {
                console.log(`[KhaAgent] Tools chamadas no turno: ${toolsCalled.join(', ')}`);
            }

            console.log(`[KhaAgent] Resposta final: ${finalResponse.substring(0, 50)}...`);

            return {
                response: finalResponse,
                logs: {
                    lastAgent: result.lastAgent?.name,
                    turns: result.newItems.length,
                    usage: (result as any).usage,
                    toolsCalled,
                    toolTelemetry: popToolTelemetry(chatwootId)
                }
            };

        } catch (error) {
            console.error('[KhaAgent] Erro ao processar mensagem:', error);
            return {
                response: "Desculpe, tive um probleminha técnico aqui. 😅 Pode repetir por favor?",
                logs: { error: (error as Error).message }
            };
        }
    }

    /**
     * Limpa a sessão de um usuário
     */
    async clearSession(chatwootId: string): Promise<void> {
        activeSessions.delete(chatwootId);
        promptPrimedSessions.delete(chatwootId);
        console.log(`[KhaAgent] Sessão limpa para: ${chatwootId}`);
    }
}

export const khaAgent = new KhaAgent();
