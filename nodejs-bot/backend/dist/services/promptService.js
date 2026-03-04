"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.promptService = void 0;
const promises_1 = __importDefault(require("fs/promises"));
const path_1 = __importDefault(require("path"));
const db_1 = require("./db");
let cachedRawPrompt = null;
let cachedConfigsSnapshot = null;
let cachedFinalPrompt = null;
/**
 * PromptService handles dynamic loading of the system prompt and
 * substitution of variables stored in the database.
 */
exports.promptService = {
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
    getSystemPrompt: async () => {
        try {
            // 1. Try to load raw prompt from file ONLY if not cached
            if (!cachedRawPrompt) {
                const pathsToTry = [
                    path_1.default.join(process.cwd(), 'prompt.md'),
                    path_1.default.join(process.cwd(), '../prompt.md'),
                    '/app/prompt.md'
                ];
                for (const p of pathsToTry) {
                    try {
                        console.log(`[PromptService] Checking file: ${p}`);
                        await promises_1.default.access(p);
                        const stats = await promises_1.default.stat(p);
                        if (stats.isDirectory())
                            continue;
                        const content = await promises_1.default.readFile(p, 'utf-8');
                        if (content) {
                            cachedRawPrompt = content;
                            // Update DB asynchronously (Deployment authority)
                            db_1.db.updatePrompt(content, 'main_prompt').catch(e => console.error('[PromptService] Async DB sync failed:', e));
                            console.log(`[PromptService] Loaded from file (${p}). Length: ${content.length}`);
                            break;
                        }
                    }
                    catch (err) {
                        continue;
                    }
                }
            }
            // 2. If file not found and no cache, try DB
            if (!cachedRawPrompt) {
                console.log('[PromptService] No local prompt file, checking DB...');
                cachedRawPrompt = await db_1.db.getPrompt('main_prompt') || '';
            }
            if (!cachedRawPrompt) {
                console.error('[PromptService] FATAL: No prompt found in file or DB.');
                return 'Você é a Kha, assistente virtual do Kharina. Atenda o cliente com simpatia.';
            }
            // 3. Fetch all configurations from DB
            const configs = await db_1.db.listConfigs();
            const currentConfigsSnapshot = JSON.stringify(configs);
            // 4. Build base prompt (cached)
            let basePrompt;
            if (cachedFinalPrompt && cachedConfigsSnapshot === currentConfigsSnapshot) {
                basePrompt = cachedFinalPrompt;
            }
            else {
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
            // Verify critical variables in log for diagnostic purposes
            const maxPeopleMatch = finalPrompt.match(/(\d+) pessoas/);
            if (maxPeopleMatch) {
                console.log(`[PromptService] 📊 Capacity in prompt: ${maxPeopleMatch[0]}`);
            }
            else if (finalPrompt.includes('{{max_reservation_people}}')) {
                console.warn(`[PromptService] ⚠️ Variable {{max_reservation_people}} NOT substituted!`);
            }
            return finalPrompt;
        }
        catch (err) {
            console.error('[PromptService] Error building system prompt:', err);
            return 'Erro ao carregar prompt do sistema.';
        }
    }
};
