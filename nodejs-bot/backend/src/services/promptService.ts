import fs from 'fs/promises';
import path from 'path';
import { db } from './db';


let cachedRawPrompt: string | null = null;
let cachedConfigsSnapshot: string | null = null;
let cachedFinalPrompt: string | null = null;

/**
 * PromptService handles dynamic loading of the system prompt and
 * substitution of variables stored in the database.
 */
export const promptService = {
    /**
     * Clears the in-memory cache, forcing a reload on the next call.
     */
    clearCache: () => {
        cachedRawPrompt = null;
        cachedConfigsSnapshot = null;
        cachedFinalPrompt = null;
        console.log('[PromptService] Cache cleared.');
    },

    /**
     * Loads prompt.md, fetches all configs, and substitutes variables.
     */
    getSystemPrompt: async (): Promise<string> => {
        try {
            // 1. Try to load raw prompt from file ONLY if not cached
            if (!cachedRawPrompt) {
                const pathsToTry = [
                    path.join(process.cwd(), 'prompt.md'),
                    path.join(process.cwd(), '../prompt.md'),
                    '/app/prompt.md'
                ];

                for (const p of pathsToTry) {
                    try {
                        console.log(`[PromptService] Checking file: ${p}`);
                        await fs.access(p);
                        const stats = await fs.stat(p);
                        if (stats.isDirectory()) continue;

                        const content = await fs.readFile(p, 'utf-8');
                        if (content) {
                            cachedRawPrompt = content;
                            // Update DB asynchronously (Deployment authority)
                            db.updatePrompt(content, 'main_prompt').catch(e =>
                                console.error('[PromptService] Async DB sync failed:', e)
                            );
                            console.log(`[PromptService] Loaded from file (${p}). Length: ${content.length}`);
                            break;
                        }
                    } catch (err) {
                        continue;
                    }
                }
            }

            // 2. If file not found and no cache, try DB
            if (!cachedRawPrompt) {
                console.log('[PromptService] No local prompt file, checking DB...');
                cachedRawPrompt = await db.getPrompt('main_prompt') || '';
            }

            if (!cachedRawPrompt) {
                console.error('[PromptService] FATAL: No prompt found in file or DB.');
                return 'Você é a Kha, assistente virtual do Kharina. Atenda o cliente com simpatia.';
            }

            // 3. Fetch all configurations from DB
            const configs = await db.listConfigs();
            const currentConfigsSnapshot = JSON.stringify(configs);

            // 4. Build base prompt (cached)
            let basePrompt: string;
            if (cachedFinalPrompt && cachedConfigsSnapshot === currentConfigsSnapshot) {
                basePrompt = cachedFinalPrompt;
            } else {
                // Perform substitutions from DB
                basePrompt = cachedRawPrompt;
                for (const conf of configs) {
                    const placeholder = `{{${conf.key}}}`;
                    basePrompt = basePrompt.split(placeholder).join(conf.value);
                }
                // Update cache
                cachedConfigsSnapshot = currentConfigsSnapshot;
                cachedFinalPrompt = basePrompt;
            }

            // 5. Dynamic injections (ALWAYS fresh)
            const now = new Date();
            const dateStr = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
            const weekDay = now.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long' });

            const finalPrompt = basePrompt
                .replace('{{current_date}}', dateStr)
                .replace('{{current_weekday}}', weekDay);


            return finalPrompt;

        } catch (err) {
            console.error('[PromptService] Error building system prompt:', err);
            return 'Erro ao carregar prompt do sistema.';
        }
    }
};
