import dotenv from 'dotenv';
dotenv.config();

function normalizeModelName(model?: string, fallback?: string): string {
    const raw = (model || fallback || '').trim();
    if (!raw) return 'gpt-4o-mini';

    const aliases: Record<string, string> = {
        'gpt-5-1-codex-mini': 'gpt-5.1-codex-mini',
        'gpt5.1-codex-mini': 'gpt-5.1-codex-mini'
    };

    return aliases[raw] || raw;
}

const defaultModel = normalizeModelName(process.env.OPENAI_MODEL, 'gpt-4o-mini');

export const config = {
    port: process.env.PORT || 3000,
    admin: {
        masterPhones: String(process.env.ADMIN_MASTER_PHONES || '')
            .split(',')
            .map((value) => value.replace(/\D/g, '').trim())
            .filter(Boolean),
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
