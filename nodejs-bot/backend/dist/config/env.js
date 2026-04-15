"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
dotenv_1.default.config();
function normalizeModelName(model, fallback) {
    const raw = (model || fallback || '').trim();
    if (!raw)
        return 'gpt-4o-mini';
    const aliases = {
        'gpt-5-1-codex-mini': 'gpt-5.1-codex-mini',
        'gpt5.1-codex-mini': 'gpt-5.1-codex-mini'
    };
    return aliases[raw] || raw;
}
const defaultModel = normalizeModelName(process.env.OPENAI_MODEL, 'gpt-4o-mini');
exports.config = {
    port: process.env.PORT || 3000,
    admin: {
        masterPhones: String(process.env.ADMIN_MASTER_PHONES || '')
            .split(',')
            .map((value) => value.replace(/\D/g, '').trim())
            .filter(Boolean),
    },
    reservasApi: {
        url: process.env.RESERVAS_API_URL || 'https://api.reservas.kharina.com.br/api',
        adminEmail: process.env.RESERVAS_API_ADMIN_EMAIL || '',
        adminPassword: process.env.RESERVAS_API_ADMIN_PASSWORD || '',
    },
    reservasWebhook: {
        url: process.env.RESERVAS_WEBHOOK_URL || 'https://api.reservas.kharina.com.br/api/webhook',
        key: process.env.RESERVAS_WEBHOOK_KEY || '',
    },
    whatsapp: {
        token: process.env.WHATSAPP_TOKEN,
        phoneId: process.env.WHATSAPP_PHONE_ID,
        verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
        maxArrivalDelaySeconds: parseInt(process.env.WHATSAPP_MAX_ARRIVAL_DELAY_SECONDS || '600', 10),
    },
    openai: {
        apiKey: process.env.OPENAI_API_KEY,
        model: defaultModel,
        models: {
            triage: normalizeModelName(process.env.OPENAI_MODEL_TRIAGE, defaultModel),
            maitre: normalizeModelName(process.env.OPENAI_MODEL_MAITRE, defaultModel),
            reservas: normalizeModelName(process.env.OPENAI_MODEL_RESERVAS, 'gpt-5.1-codex-mini'),
            delivery: normalizeModelName(process.env.OPENAI_MODEL_DELIVERY, defaultModel),
        }
    },
    redis: {
        url: process.env.REDIS_URL || 'redis://172.17.0.1:6395',
        ttl: parseInt(process.env.SESSION_TTL || '300', 10), // 5 minutes default
    },
    chatwoot: {
        url: process.env.CHATWOOT_URL,
        token: process.env.CHATWOOT_TOKEN,
        accountId: process.env.CHATWOOT_ACCOUNT_ID,
        inboxId: process.env.CHATWOOT_INBOX_ID,
        webhookToken: process.env.CHATWOOT_WEBHOOK_TOKEN || process.env.CHATWOOT_TOKEN,
    }
};
