import type { Request, Response } from 'express';
import { config } from '../config/env';
import { khaAgent } from '../agent/agent';
import { redisService } from './redis';
import { chatwootService } from './chatwoot';
import { db } from './db';
import { promptService } from './promptService';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { executeDynamicTool } from '../agent/tools';

// ─── Per-user State & Queues ────────────────────────────────────────────────

const userProcessingQueue = new Map<string, Promise<void>>();
const userLatestTimestamp = new Map<string, number>();
const lastOutboundByUser = new Map<string, { hash: string; at: number }>();
const interactiveDegradedUntil = new Map<string, number>();

const SCOPE_ONLY_MSG = 'Só posso ajudar com assuntos do restaurante: cardápio, reservas e delivery.';
const INJECTION_BLOCK_MSG = 'Não posso seguir esse tipo de instrução. Posso te ajudar com cardápio, reservas ou delivery.';

const userContextState = new Map<string, {
    preferredCity?: 'Curitiba' | 'Londrina' | 'São Paulo';
    preferredStoreId?: string;
    preferredUnitName?: string;
    hasInteracted?: boolean;
    lastInteractiveMenu?: string;
    reservation?: {
        people?: number;
        kids?: number;
        phoneConfirmed?: boolean;
        awaitingNewPhone?: boolean;
        contactPhone?: string;
        awaitingConfirmation?: boolean;
        awaitingCancellation?: boolean;
        name?: string;
        dateText?: string;
        timeText?: string;
        occasion?: string;
        notes?: string;
    };
    deliveryFlow?: {
        city?: 'Curitiba' | 'Londrina' | 'São Paulo';
    };
}>();

/**
 * Checks if the user is currently in an active flow that should NOT be
 * interrupted by greeting->MENU_PRINCIPAL conversion.
 */
function isInActiveFlow(from: string): boolean {
    const state = userContextState.get(from);
    if (!state) return false;

    // Active reservation flow: unit selected, phone step, or awaiting data/confirmation
    if (state.reservation) {
        const r = state.reservation;
        if (r.awaitingConfirmation) return true;
        if (r.awaitingNewPhone) return true;
        if (r.phoneConfirmed) return true;
        // User has started filling reservation data (has at least a unit selected)
        if (state.preferredUnitName) return true;
    }

    // Active delivery flow
    if (state.deliveryFlow?.city) return true;

    // Interactive menu context that implies mid-flow
    const activeMenus = new Set([
        'reserva_units', 'reserva_confirmation', 'phone_confirmation',
        'delivery_choice', 'delivery_cities'
    ]);
    if (state.lastInteractiveMenu && activeMenus.has(state.lastInteractiveMenu)) return true;

    return false;
}

function setLastInteractiveMenu(to: string, menu: string): void {
    const state = userContextState.get(to) || {};
    state.lastInteractiveMenu = menu;
    userContextState.set(to, state);
}

// ─── Command Sets ───────────────────────────────────────────────────────────

const MENU_COMMANDS = new Set([
    'MENU_PRINCIPAL', 'menu_cardapio', 'menu_reserva', 'menu_delivery'
]);

const CARDAPIO_CITY_COMMANDS = new Set([
    'cardapio_curitiba', 'cardapio_londrina', 'cardapio_saopaulo'
]);

const DELIVERY_CITY_COMMANDS = new Set([
    'delivery_curitiba', 'delivery_londrina', 'delivery_saopaulo'
]);

const RESERVA_UNIT_COMMANDS = new Set([
    'unidade_botanico', 'unidade_cabral', 'unidade_agua_verde',
    'unidade_batel', 'unidade_portao', 'unidade_londrina', 'unidade_saopaulo'
]);

const INTERACTIVE_DEGRADED_WINDOW_MS = 10 * 60 * 1000;

// True greetings — suppressed during active flows (oi, ola, bom dia)
const GREETING_COMMANDS = new Set([
    'oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite'
]);

// Explicit navigation — ALWAYS reset to menu, even during active flows
const EXPLICIT_MENU_COMMANDS = new Set([
    'menu', 'menu principal', 'inicio', 'início', 'voltar', 'voltar ao menu'
]);

// ─── Graph API Helpers ──────────────────────────────────────────────────────

function extractGraphError(err: any) {
    const status = err?.response?.status;
    const graph = err?.response?.data?.error || {};
    return {
        status,
        code: graph?.code,
        message: graph?.message || err?.message,
        fbtrace_id: graph?.fbtrace_id
    };
}

async function postGraphMessageWithRetry(payload: any, label: string, retries = 2): Promise<void> {
    let attempt = 0;
    let lastErr: any = null;
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const httpsAgent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;

    // Build axis config dynamically to avoid passing undefined proxy/httpsAgent
    const axiosConfig: any = {
        headers: { Authorization: `Bearer ${config.whatsapp.token}` }
    };
    if (proxyUrl) {
        axiosConfig.httpsAgent = httpsAgent;
        axiosConfig.proxy = false;
    }

    while (attempt <= retries) {
        try {
            await axios.post(
                `https://graph.facebook.com/v24.0/${config.whatsapp.phoneId}/messages`,
                payload,
                axiosConfig
            );
            return;
        } catch (err: any) {
            lastErr = err;
            console.error(`[WhatsApp] ${label} failed (attempt ${attempt + 1}/${retries + 1}):`, extractGraphError(err));
            if (attempt === retries) break;
            await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 300 : 800));
            attempt += 1;
        }
    }
    throw lastErr;
}

async function sendInteractiveWithFallback(
    to: string, menuPayload: any, label: string, fallbackText?: string
): Promise<boolean> {
    const now = Date.now();
    const degradedUntil = interactiveDegradedUntil.get(to) || 0;

    if (degradedUntil > now) {
        if (fallbackText) await sendWhatsAppText(to, fallbackText);
        return false;
    }

    try {
        await postGraphMessageWithRetry(menuPayload, label, 2);
        return true;
    } catch {
        interactiveDegradedUntil.set(to, now + INTERACTIVE_DEGRADED_WINDOW_MS);
        if (fallbackText) await sendWhatsAppText(to, fallbackText);
        return false;
    }
}

// ─── Text Utilities ─────────────────────────────────────────────────────────

function sanitizeWhatsAppText(text: string): string {
    if (!text) return text;
    return text
        .replace(/```/g, '')
        .replace(/\s*\(\d{4}-\d{2}-\d{2}\)/g, '')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$2')
        .replace(/^#{1,6}\s+/gm, '')
        .trim();
}

function normalizeForOutboundDedupe(text: string): string {
    return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeUnitNameForMatch(value: string): string {
    return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function isPromptInjectionLike(text: string): boolean {
    const t = text.toLowerCase();
    const markers = [
        'repeat your rules verbatim', 'exact text of your instructions',
        'out of character', 'ignore previous instructions',
        'developer instructions', 'system prompt'
    ];
    return markers.some(m => t.includes(m));
}

function isCardapioIntent(text: string): boolean {
    const t = text.toLowerCase();
    const keywords = [
        'cardápio', 'cardapio', 'prato', 'pratos', 'sobremesa',
        'vinho', 'drink', 'hamburguer', 'hambúrguer', 'camarão',
        'camarao', 'preço', 'preco', 'vocês têm', 'voces tem'
    ];
    return keywords.some(k => t.includes(k));
}

function isGenericCardapioRequest(text: string): boolean {
    const t = (text || '').trim().toLowerCase();
    const genericPatterns = [
        /^card[áa]pio$/, /^ver card[áa]pio$/, /^me manda o card[áa]pio$/
    ];
    return genericPatterns.some(p => p.test(t));
}

function isDeliveryIntent(text: string): boolean {
    const t = text.toLowerCase();
    const keywords = ['delivery', 'ifood', 'i-food', 'entrega', 'pedir comida', 'fazer pedido'];
    return keywords.some(k => t.includes(k));
}

function extractDeliveryCity(text: string): 'Curitiba' | 'Londrina' | 'São Paulo' | null {
    const t = text.toLowerCase();
    if (t.includes('londrina')) return 'Londrina';
    if (t.includes('são paulo') || t.includes('sao paulo') || t.includes('sp')) return 'São Paulo';
    if (t.includes('curitiba') || t.includes('cwb')) return 'Curitiba';
    return null;
}

function formatBrazilPhoneDisplay(raw: string): string {
    const digits = String(raw || '').replace(/\D/g, '');
    const br = digits.startsWith('55') ? digits.slice(2) : digits;
    if (br.length === 11) return `(${br.slice(0, 2)}) ${br.slice(2, 7)}-${br.slice(7)}`;
    if (br.length === 10) return `(${br.slice(0, 2)}) ${br.slice(2, 6)}-${br.slice(6)}`;
    return raw;
}

function normalizeReservationPhone(raw: string): string | null {
    const digits = String(raw || '').replace(/\D/g, '');
    if (!digits) return null;
    if (digits.startsWith('55')) {
        if (digits.length === 12 || digits.length === 13) return digits;
        return null;
    }
    if (digits.length === 10 || digits.length === 11) return `55${digits}`;
    return null;
}

export function extractReservationFacts(text: string): {
    people?: number; kids?: number; occasion?: string; notes?: string;
    name?: string; dateText?: string; timeText?: string;
} {
    const lower = text.toLowerCase();
    const facts: any = {};

    const peoplePatterns = [
        /\b(\d{1,2})\s*(pessoas?|adultos?)\b/i,
        /\bsomos\s*(\d{1,2})\b/i,
        /\bpara\s*(\d{1,2})\s*(pessoas?|adultos?)?\b/i
    ];
    for (const p of peoplePatterns) {
        const m = text.match(p);
        if (m?.[1]) { facts.people = parseInt(m[1], 10); break; }
    }

    if (/\bsem (filhos|criancas|crianças)\b/i.test(lower) || /\b0 (crianca|criança|criancas|crianças|kids)\b/i.test(lower)) {
        facts.kids = 0;
    } else {
        const kidsMatch = text.match(/\b(\d{1,2})\s*(crianca|criança|criancas|crianças|kids)\b/i);
        if (kidsMatch?.[1]) facts.kids = parseInt(kidsMatch[1], 10);
    }

    if (lower.includes('aniversário de casamento') || lower.includes('aniversario de casamento')) {
        facts.occasion = 'aniversário de casamento';
    } else if (lower.includes('aniversario') || lower.includes('aniversário')) {
        facts.occasion = 'aniversário';
    }

    // Time extraction: supports "20h", "20:00", "20 horas", "às 20h", "as 20", "20hrs"
    const timePatterns = [
        /\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/i,                    // 20:30, 20h30
        /\b([01]?\d|2[0-3])h\b/i,                                 // 20h
        /\b(?:as|às)\s+([01]?\d|2[0-3])(?:\s*(?:h|hora|horas|hrs?))?\b/i, // as 20, às 20h, às 20 horas
        /\b([01]?\d|2[0-3])\s*(?:hora|horas|hrs)\b/i,             // 20 horas, 20hrs
        /\bpra(?:s)?\s+(?:as\s+)?([01]?\d|2[0-3])(?:\s*h)?\b/i,    // pra 20h, pra as 19
        /\bmeio[\s-]?dia\b/i,                                      // meio-dia
        /\bmeia[\s-]?noite\b/i                                      // meia-noite
    ];

    for (const pattern of timePatterns) {
        const m = text.match(pattern);
        if (m) {
            if (/meio[\s-]?dia/i.test(m[0])) {
                facts.timeText = '12:00';
                break;
            }
            if (/meia[\s-]?noite/i.test(m[0])) {
                facts.timeText = '00:00';
                break;
            }
            // Find the hour capture group (first numeric group)
            const hourGroup = m[1] || m[2];
            if (hourGroup) {
                const hh = String(hourGroup).padStart(2, '0');
                const mm = m[2] && /^\d{2}$/.test(m[2]) ? m[2] : '00';
                facts.timeText = `${hh}:${mm}`;
                break;
            }
        }
    }

    // Date extraction: supports "hoje", "amanhã", DD/MM/YYYY, DD/MM/YY, DD/MM
    if (/\bhoje\b/i.test(lower)) {
        facts.dateText = 'hoje';
    } else if (/\bamanh[ãa]\b/i.test(lower)) {
        facts.dateText = 'amanhã';
    } else {
        // DD/MM/YYYY or DD/MM/YY
        const fullDateMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/);
        if (fullDateMatch) {
            const day = fullDateMatch[1].padStart(2, '0');
            const month = fullDateMatch[2].padStart(2, '0');
            let year = fullDateMatch[3];
            if (year.length === 2) year = `20${year}`;
            facts.dateText = `${day}/${month}/${year}`;
        } else {
            // DD/MM (assume current year)
            const shortDateMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
            if (shortDateMatch) {
                const day = shortDateMatch[1].padStart(2, '0');
                const month = shortDateMatch[2].padStart(2, '0');
                const monthNum = parseInt(month);
                // Only if it looks like a valid date (month <= 12)
                if (monthNum >= 1 && monthNum <= 12) {
                    const currentYear = new Date().getFullYear();
                    facts.dateText = `${day}/${month}/${currentYear}`;
                }
            }
        }
    }

    // Weekday names
    const weekdays: Record<string, string> = {
        'segunda': 'segunda-feira', 'terca': 'terça-feira', 'terça': 'terça-feira',
        'quarta': 'quarta-feira', 'quinta': 'quinta-feira', 'sexta': 'sexta-feira',
        'sabado': 'sábado', 'sábado': 'sábado', 'domingo': 'domingo'
    };
    if (!facts.dateText) {
        for (const [key, value] of Object.entries(weekdays)) {
            if (lower.includes(key)) { facts.dateText = value; break; }
        }
    }

    // Name extraction: find the chunk that most looks like a name
    const chunks = text.split(/[,;\-]/)
        .map(c => c.trim())
        .filter(c => c.length > 0);

    let extractedName: string | undefined;
    let bestScore = -999;

    for (const chunk of chunks) {
        const lowerChunk = chunk.toLowerCase();

        // Exclude strong conversational noise
        const hasNoise = /\b(sim|nao|não|ok|certo|correto|isso|esse|pode|fechado|show|perfeito|obrigado|valeu|confirmar|confirmo|confirmado|confirmei|j[aá]|nome)\b/i.test(lowerChunk);
        const looksLikeGreeting = /^(oi|ol[áa]|bom dia|boa tarde|boa noite|tudo bem|blz|beleza|opa)\b/i.test(lowerChunk);
        const hasNumbers = /\d/.test(chunk);
        const hasReservaWords = /\b(reserva|quero|hoje|amanh[ãa]|pessoas|hor[aá]rio|crian[çc]as|mudar|alterar|corrigir|cancelar|favor|minha)\b/i.test(lowerChunk);

        if (!hasNumbers && !hasReservaWords && !looksLikeGreeting) {
            // Clean up common prefixes like "meu nome é "
            let cleanedChunk = chunk.replace(/^(eu sou (o|a)?|sou (o|a)?|[ée] (o|a)?|meu nome [ée])\s+/i, '').trim();

            if (/^[A-Za-zÀ-ÿ'\s]{2,50}$/.test(cleanedChunk)) {
                const wordCount = cleanedChunk.split(/\s+/).length;
                let score = 1;

                if (hasNoise) score -= 5; // heavy penalty for conversational words
                if (wordCount >= 2 && wordCount <= 4) score += 3; // strong prefer 2-4 words
                if (/^[A-ZÀ-ÖØ-Þ]/.test(cleanedChunk)) score += 2; // prefer capitalized

                if (score > bestScore) {
                    bestScore = score;
                    extractedName = cleanedChunk;
                }
            }
        }
    }

    if (extractedName && bestScore > 0) {
        facts.name = extractedName;
    }

    return facts;
}

// ─── Command Normalization (Simplified) ─────────────────────────────────────

function normalizeInteractiveCommand(raw: string, lastInteractiveMenu?: string): string {
    const original = raw.trim();
    const command = original.toLowerCase();
    const plain = normalizeUnitNameForMatch(command).replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();

    // Button title fallbacks
    if (command === 'reservar mesa') return 'menu_reserva';
    if (command === 'ver delivery' || command === 'delivery') return 'menu_delivery';
    if (command === 'menu principal' || command === 'voltar ao menu') return 'MENU_PRINCIPAL';
    if (command === 'ver cardápio' || command === 'ver cardapio') return 'menu_cardapio';

    // Context-aware title fallback
    if (lastInteractiveMenu === 'delivery_choice') {
        if (plain.includes('novo pedido')) return 'delivery_novo';
        if (plain.includes('preciso de ajuda') || plain.includes('preciso ajuda')) return 'delivery_ajuda';
    }

    // Unit slug detection
    const unitSlug =
        plain.includes('jardim botanico') || plain === 'botanico' ? 'botanico' :
            plain.includes('agua verde') ? 'agua_verde' :
                plain.includes('sao paulo') ? 'saopaulo' :
                    plain.includes('portao') ? 'portao' :
                        plain.includes('londrina') ? 'londrina' :
                            plain.includes('cabral') ? 'cabral' :
                                plain.includes('batel') ? 'batel' : null;

    if (unitSlug && lastInteractiveMenu === 'reserva_units') return `unidade_${unitSlug}`;

    if (lastInteractiveMenu === 'cardapio_cities') {
        if (plain.includes('curitiba')) return 'cardapio_curitiba';
        if (plain.includes('londrina')) return 'cardapio_londrina';
        if (plain.includes('sao paulo')) return 'cardapio_saopaulo';
    }

    if (lastInteractiveMenu === 'delivery_cities') {
        if (plain.includes('curitiba')) return 'delivery_curitiba';
        if (plain.includes('londrina')) return 'delivery_londrina';
        if (plain.includes('sao paulo')) return 'delivery_saopaulo';
    }

    if (lastInteractiveMenu === 'reserva_confirmation') {
        if (plain.includes('confirm_reserva_sim') || plain.includes('sim')) return 'confirm_reserva_sim';
        if (plain.includes('confirm_reserva_nao') || plain.includes('nao') || plain.includes('mudar')) return 'confirm_reserva_nao';
    }

    if (lastInteractiveMenu === 'cancel_confirmation') {
        if (plain.includes('sim') || plain.includes('cancelar')) return 'Sim, quero cancelar a reserva';
        if (plain.includes('nao') || plain.includes('manter')) return 'Não, decidi manter a reserva';
    }

    return original;
}

function normalizeFreeTextToCommand(text: string, state: any): string {
    const normalized = (text || '').trim().toLowerCase();
    const awaitingConfirmation = !!state?.reservation?.awaitingConfirmation;
    const awaitingCancellation = !!state?.reservation?.awaitingCancellation;

    // If user is in cancellation flow, do NOT convert 'sim' to confirm_reserva_sim
    if (awaitingCancellation) {
        console.log(`[WhatsApp] normalizeFreeText: awaitingCancellation=true, input="${normalized}", passing through to AI agent.`);
        return text;
    }

    if (!awaitingConfirmation) return text;

    // Check for affirmations
    if (/\b(sim|ok|fechado|certo|perfeito|pode|isso aí|isso ai|confirmar|correto)\b|\btudo (certo|ok)\b/i.test(normalized)) {
        return 'confirm_reserva_sim';
    }

    // Check for negations
    if (/\b(não|nao|mudar|alterar|corrigir|errado|cancelar)\b/i.test(normalized)) {
        return 'confirm_reserva_nao';
    }

    return text;
}

function normalizeNaturalLanguageToMenuCommand(
    text: string, lastInteractiveMenu?: string, messageType: string = 'text',
    from?: string
): string {
    const fromInteractive = messageType === 'interactive' || messageType === 'button';
    const normalized = text.trim().toLowerCase();
    if (!normalized) return text;
    const flat = normalized.replace(/\s+/g, ' ').trim();

    // If already a command (confirm_*, phone_*, unidade_*), never convert to menu
    if (/^(confirm_|phone_|unidade_)/.test(flat)) return text;

    // Explicit navigation commands (menu, voltar, inicio) — ALWAYS go to menu, even in active flow
    if (EXPLICIT_MENU_COMMANDS.has(flat)) return 'MENU_PRINCIPAL';

    // Advanced greeting match for phrases like 'ola tudo bom'
    const looksLikeGreeting = /^(oi|ol[áa]|bom dia|boa tarde|boa noite|tudo bem|blz|beleza|opa)\b/i.test(flat);
    const inActiveFlow = from ? isInActiveFlow(from) : false;

    if (looksLikeGreeting || GREETING_COMMANDS.has(flat)) {
        // Only convert to MENU_PRINCIPAL if it's short (likely just a greeting, not "oi quero reservar")
        if (flat.split(' ').length <= 4) {
            if (!inActiveFlow) return 'MENU_PRINCIPAL';
            console.log(`[WhatsApp] Greeting "${flat}" suppressed — user is in active flow.`);
            return text;
        }
    }

    if (!fromInteractive) {
        if (/\b(delivery|entrega)\b/.test(flat) && /\b(quero|fazer|pedir|ver|menu)\b/.test(flat)) return 'menu_delivery';
        if (/^(ver delivery|delivery|menu delivery)$/.test(flat)) return 'menu_delivery';
        if (/\b(reserv)\b/.test(flat) && /\b(quero|fazer|uma|mesa|menu)\b/.test(flat)) return 'menu_reserva';
        if (/^(reservar mesa|reservar|menu reserva|fazer reserva)$/.test(flat)) return 'menu_reserva';
        if (/\b(cardapio|cardápio)\b/.test(flat)) return 'menu_cardapio';
        if (/^(ver cardapio|ver cardápio)$/.test(flat)) return 'menu_cardapio';

        if (/^(1|1️⃣)$/.test(flat)) return 'menu_cardapio';
        if (/^(2|2️⃣)$/.test(flat)) return 'menu_reserva';
        if (/^(3|3️⃣)$/.test(flat)) return 'menu_delivery';
        return text;
    }

    // Context-aware numeric mapping for interactive
    if (lastInteractiveMenu === 'after_cardapio') {
        if (/^(1|1️⃣)\b/.test(flat)) return 'menu_reserva';
        if (/^(2|2️⃣)\b/.test(flat)) return 'menu_delivery';
        if (/^(3|3️⃣)\b/.test(flat)) return 'MENU_PRINCIPAL';
    }
    if (lastInteractiveMenu === 'delivery_choice') {
        if (/^(1|1️⃣)\b/.test(flat)) return 'delivery_novo';
        if (/^(2|2️⃣)\b/.test(flat)) return 'delivery_ajuda';
    }
    if (lastInteractiveMenu === 'cardapio_cities') {
        if (/^(1|1️⃣)\b/.test(flat)) return 'cardapio_curitiba';
        if (/^(2|2️⃣)\b/.test(flat)) return 'cardapio_londrina';
        if (/^(3|3️⃣)\b/.test(flat)) return 'cardapio_saopaulo';
    }
    if (lastInteractiveMenu === 'delivery_cities') {
        if (/^(1|1️⃣)\b/.test(flat)) return 'delivery_curitiba';
        if (/^(2|2️⃣)\b/.test(flat)) return 'delivery_londrina';
        if (/^(3|3️⃣)\b/.test(flat)) return 'delivery_saopaulo';
    }

    // Generic numeric fallbacks
    if (/^(1|1️⃣)\b/.test(flat)) return 'menu_cardapio';
    if (/^(2|2️⃣)\b/.test(flat)) return 'menu_reserva';
    if (/^(3|3️⃣)\b/.test(flat)) return 'menu_delivery';

    if (flat.includes('ver delivery')) return 'menu_delivery';
    if (flat.includes('menu principal') || flat.includes('voltar')) return 'MENU_PRINCIPAL';
    if (flat.includes('ver cardápio') || flat.includes('ver cardapio')) return 'menu_cardapio';

    return text;
}

function shouldBypassContentDedup(text: string, messageType: string): boolean {
    if (messageType === 'interactive' || messageType === 'button') return true;
    const t = (text || '').trim().toLowerCase();
    if (!t) return true;
    return (
        t === 'menu_principal' ||
        /^(1|2|3)\s*$/.test(t) ||
        t.startsWith('menu_') || t.startsWith('cardapio_') || t.startsWith('delivery_') ||
        t.startsWith('unidade_') || t.startsWith('confirm_') || t.startsWith('phone_')
    );
}

function shouldForceDeterministicRoute(text: string, messageType: string, from?: string): boolean {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return false;
    if (messageType === 'interactive' || messageType === 'button') return true;
    if (MENU_COMMANDS.has(text.trim())) return true;
    // Explicit menu commands ALWAYS force deterministic route
    if (EXPLICIT_MENU_COMMANDS.has(t)) return true;
    // Greetings should only force deterministic route if NOT in active flow
    if (GREETING_COMMANDS.has(t)) {
        const inFlow = from ? isInActiveFlow(from) : false;
        return !inFlow;
    }
    if (/^(1|2|3)\s*$/.test(t)) return true;
    return (
        t.startsWith('menu_') || t.startsWith('cardapio_') || t.startsWith('delivery_') ||
        t.startsWith('unidade_') || t.startsWith('confirm_') || t.startsWith('phone_')
    );
}

// ─── Deterministic Menu Handlers ────────────────────────────────────────────

async function handleDeterministicMenuCommand(
    text: string, from: string, userName: string
): Promise<boolean> {
    const normalized = text.trim().toLowerCase();
    const isGreeting = GREETING_COMMANDS.has(normalized);
    const command = isGreeting ? 'MENU_PRINCIPAL' : text.trim();

    if (!MENU_COMMANDS.has(command)) return false;

    const currentState = userContextState.get(from) || {};
    currentState.deliveryFlow = undefined;
    const alreadyInteracted = !!currentState.hasInteracted;

    if (command === 'MENU_PRINCIPAL') {
        // Clear all flow state so user starts fresh from main menu
        currentState.reservation = undefined;
        currentState.lastInteractiveMenu = undefined;
        await sendInteractiveMenu(from, alreadyInteracted);
        currentState.hasInteracted = true;
        userContextState.set(from, currentState);
        await chatwootService.syncMessage(from, userName, 'MENU_PRINCIPAL', 'outgoing', { source: 'bot' });
        return true;
    }

    if (command === 'menu_cardapio') {
        await sendCitiesMenu(from);
        currentState.hasInteracted = true;
        userContextState.set(from, currentState);
        await chatwootService.syncMessage(from, userName, 'MENU_CIDADES_CARDAPIO', 'outgoing', { source: 'bot' });
        return true;
    }

    if (command === 'menu_reserva') {
        currentState.reservation = currentState.reservation ? {
            contactPhone: currentState.reservation.contactPhone,
            phoneConfirmed: currentState.reservation.phoneConfirmed
        } : undefined;
        currentState.hasInteracted = true;
        userContextState.set(from, currentState);
        await sendUnidadesMenu(from);
        await chatwootService.syncMessage(from, userName, 'LIST_RESERVA_UNIDADES', 'outgoing', { source: 'bot' });
        return true;
    }

    if (command === 'menu_delivery') {
        await sendDeliveryCitiesMenu(from);
        currentState.hasInteracted = true;
        userContextState.set(from, currentState);
        await chatwootService.syncMessage(from, userName, 'MENU_DELIVERY_CIDADES', 'outgoing', { source: 'bot' });
        return true;
    }

    return false;
}

async function handleDeterministicInteractiveCommand(
    text: string, from: string, userName: string
): Promise<boolean> {
    const command = text.trim().toLowerCase();
    const state = userContextState.get(from) || {};

    // ── Cardápio City Commands ──
    if (CARDAPIO_CITY_COMMANDS.has(command)) {
        const cityMap: Record<string, string> = {
            cardapio_curitiba: 'Curitiba', cardapio_londrina: 'Londrina', cardapio_saopaulo: 'São Paulo'
        };
        const keyMap: Record<string, string> = {
            cardapio_curitiba: 'link_cardapio_curitiba', cardapio_londrina: 'link_cardapio_londrina', cardapio_saopaulo: 'link_cardapio_sp'
        };

        const city = cityMap[command];
        const link = await db.getConfig(keyMap[command]);
        const fallback = await db.getConfig('link_cardapio_curitiba');
        const finalLink = link || fallback || 'https://cardapio.kharina.com.br/';

        state.preferredCity = city as any;
        userContextState.set(from, state);

        const msg = `Perfeito! Aqui está o cardápio de ${city} 🍽️\n👉 ${finalLink}`;
        await sendWhatsAppText(from, msg);
        await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
        return true;
    }

    // ── Delivery City Commands ──
    if (DELIVERY_CITY_COMMANDS.has(command)) {
        state.deliveryFlow = {
            city: command === 'delivery_curitiba' ? 'Curitiba' : command === 'delivery_londrina' ? 'Londrina' : 'São Paulo'
        };
        userContextState.set(from, state);

        if (command === 'delivery_saopaulo') {
            const msg = "Poxa, em SP ainda não tem delivery! 😢 Mas vem visitar a gente no Shopping Parque da Cidade! 🧡";
            await sendWhatsAppText(from, msg);
            await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
            await sendInteractiveMenu(from, true);
            return true;
        }

        await sendDeliveryChoiceMenu(from);
        await chatwootService.syncMessage(from, userName, 'MENU_DELIVERY_OPCOES', 'outgoing', { source: 'bot' });
        return true;
    }

    // ── Delivery Novo / Ajuda ──
    if (command === 'delivery_novo') {
        const city = state.deliveryFlow?.city || state.preferredCity || 'Curitiba';
        if (city === 'Londrina') {
            const link = await db.getConfig('link_delivery_londrina');
            const msg = `Bora pedir! 😋\n👉 ${link || 'https://www.ifood.com.br/'}`;
            await sendWhatsAppText(from, msg);
            await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot', flow: 'delivery' });
            await sendInteractiveMenu(from, true);
            return true;
        }
        const msg = [
            'Show! 🍔 Escolha a unidade mais perto de você pra pedir no iFood:',
            '',
            '1️⃣ *Água Verde / Batel / Portão*',
            '👉 https://www.ifood.com.br/delivery/curitiba-pr/kharina-steakhouse---agua-verde-agua-verde/9cda85cb-fa38-47a1-9831-818dfe5991e9?UTM_Medium=share',
            '',
            '2️⃣ *Cabral / Jardim Botânico*',
            '👉 https://www.ifood.com.br/delivery/curitiba-pr/kharina-steakhouse---cabral-cabral/8152217a-0a08-4512-8d18-ae240d7a1a37'
        ].join('\n');
        await sendWhatsAppText(from, msg);
        await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot', flow: 'delivery' });
        await sendInteractiveMenu(from, true);
        return true;
    }

    if (command === 'delivery_ajuda') {
        const city = state.deliveryFlow?.city || state.preferredCity || 'Curitiba';

        // Register delivery issue in Chatwoot with private note for follow-up
        const privateNote = `⚠️ *Solicitação de ajuda com Delivery*\n📍 Cidade: ${city}\n📱 Cliente: ${from}\n\n_Aguardando descrição do problema pelo cliente._`;
        await chatwootService.syncMessage(from, userName, privateNote, 'outgoing', { source: 'bot', flow: 'delivery_help' }, true);

        if (city === 'Londrina') {
            const phone = await db.getConfig('phone_londrina');
            const msg = [
                'Puxa, lamento pelo inconveniente! 😕',
                '',
                'Pra gente resolver isso da melhor forma, entra em contato direto com a unidade de Londrina:',
                `📱 *${phone || '(43) 3398-9191'}*`,
                '',
                'Nossa equipe já foi notificada sobre o seu caso! 📋',
                'O pessoal de lá vai te atender rapidinho e resolver tudo! 💛'
            ].join('\n');
            await sendWhatsAppText(from, msg);
            await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot', flow: 'delivery_help' });
            await sendInteractiveMenu(from, true);
            return true;
        }

        const msg = [
            'Puxa, lamento pelo inconveniente! 😕',
            '',
            'Pra gente resolver da melhor forma, entra em contato direto com a unidade responsável pelo seu pedido:',
            '',
            '📍 *Cabral / Jardim Botânico*',
            '📱 (41) 99288-6397',
            '',
            '📍 *Água Verde / Batel / Portão*',
            '📱 (41) 98811-6685',
            '',
            'Nossa equipe já foi notificada sobre o seu caso! 📋',
            'É só mandar uma mensagem explicando o que aconteceu que o pessoal vai te ajudar! 💛'
        ].join('\n');
        await sendWhatsAppText(from, msg);
        await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot', flow: 'delivery_help' });
        await sendInteractiveMenu(from, true);
        return true;
    }

    // ── Reserva Unit Commands ──
    if (RESERVA_UNIT_COMMANDS.has(command)) {
        const unitMap: Record<string, string> = {
            unidade_botanico: 'Jardim Botânico', unidade_cabral: 'Cabral',
            unidade_agua_verde: 'Água Verde', unidade_batel: 'Batel',
            unidade_portao: 'Portão', unidade_londrina: 'Londrina',
            unidade_saopaulo: 'São Paulo'
        };
        const unit = unitMap[command];
        const uuidKey = command.replace('unidade_', 'uuid_');
        const storeId = await db.getConfig(uuidKey);
        state.preferredUnitName = unit;
        if (storeId) state.preferredStoreId = storeId;
        state.reservation = { ...(state.reservation || {}), phoneConfirmed: false };
        userContextState.set(from, state);

        const msg = `Show! Você escolheu a unidade ${unit}! 😄`;
        await sendWhatsAppText(from, msg);
        await chatwootService.syncMessage(from, userName, `${msg}\nCONFIRM_PHONE_NUMBER`, 'outgoing', { source: 'bot' });
        await sendPhoneNumberConfirmation(from);
        return true;
    }

    // ── Phone Confirmation ──
    if (command === 'phone_use_current') {
        const reservation = state.reservation || {};
        reservation.phoneConfirmed = true;
        reservation.awaitingNewPhone = false;
        reservation.contactPhone = from;
        state.reservation = reservation;
        userContextState.set(from, state);

        const unit = state.preferredUnitName || 'a unidade escolhida';
        const missing: string[] = [];
        if (!reservation.name) missing.push('nome completo');
        if (!reservation.dateText) missing.push('data');
        if (!reservation.timeText) missing.push('horário');
        if (reservation.people === undefined) missing.push('quantidade de pessoas');

        const checklist = [
            `Olha como está seu pré-cadastro:`,
            `- 👤 Nome: ${reservation.name || '❓ Pendente'}`,
            `- 📱 Celular: ${formatBrazilPhoneDisplay(reservation.contactPhone || from)}`,
            `- 📅 Data: ${reservation.dateText || '❓ Pendente'}`,
            `- ⏰ Horário: ${reservation.timeText || '❓ Pendente'}`,
            `- 👥 Pessoas: ${reservation.people !== undefined ? reservation.people : '❓ Pendente'}`,
            `- 👶 Crianças: ${reservation.kids !== undefined ? reservation.kids : '❓ Pendente'}`
        ].join('\n');

        const msg = missing.length > 0
            ? `Perfeito! Vou usar este número para a reserva na unidade ${unit}. ✅\n\n${checklist}\n\nPra eu seguir, me manda só: *${missing.join(', ')}*.`
            : `Perfeito! Vou usar este número para a reserva na unidade ${unit}. ✅\n\nJá tenho tudo para seguir com a confirmação!`;
        await sendWhatsAppText(from, msg);
        await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
        return true;
    }

    if (command === 'phone_ask_new') {
        state.reservation = state.reservation || {};
        state.reservation.awaitingNewPhone = true;
        state.reservation.phoneConfirmed = false;
        userContextState.set(from, state);
        const msg = 'Sem problemas 😊 Me envia o número que devo usar na reserva (com DDD), por favor.';
        await sendWhatsAppText(from, msg);
        await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
        return true;
    }

    // ── Reservation Confirmation ──
    if (command === 'confirm_reserva_sim') {
        // Client confirmed the reservation — delegate to AI agent with full context
        // so it calls create_reservation with all collected data.
        // We do NOT handle this deterministically because the AI agent needs to
        // call create_reservation tool and handle the response.
        // Mark that we are no longer awaiting confirmation (prevent re-entry)
        // and let it fall through to the AI agent.
        console.log(`[WhatsApp] confirm_reserva_sim — delegating to AI agent with reservation context.`);
        return false; // Let it fall through to AI agent processing
    }

    if (command === 'confirm_reserva_nao') {
        if (state.reservation) state.reservation.awaitingConfirmation = false;
        userContextState.set(from, state);
        const msg = 'Sem problemas! 😊 Me diz o que você quer alterar (nome, data, horário, pessoas ou crianças).';
        await sendWhatsAppText(from, msg);
        await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
        return true;
    }

    return false;
}

// ─── User Job Queue ─────────────────────────────────────────────────────────

function enqueueUserJob(userId: string, job: () => Promise<void>) {
    const previous = userProcessingQueue.get(userId) || Promise.resolve();
    const next = previous.catch(() => { }).then(job);
    userProcessingQueue.set(userId, next.finally(() => {
        if (userProcessingQueue.get(userId) === next) userProcessingQueue.delete(userId);
    }));
}

// ─── Webhook Handlers ───────────────────────────────────────────────────────

export const verifyWebhook = (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
        console.log('Webhook verified');
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
};

export const handleWhatsAppWebhook = async (req: Request, res: Response) => {
    const body = req.body;
    console.log('[WhatsApp] Webhook received.');

    if (!body) { res.status(400).send({ error: 'Empty body' }); return; }

    // Find messages in nested structure
    const findMessages = (obj: any): any[] | null => {
        if (!obj || typeof obj !== 'object') return null;
        if (obj.messages && Array.isArray(obj.messages)) return obj.messages;
        if (Array.isArray(obj)) {
            for (const item of obj) { const found = findMessages(item); if (found) return found; }
        }
        for (const key in obj) { const found = findMessages(obj[key]); if (found) return found; }
        return null;
    };

    const value = body.entry?.[0]?.changes?.[0]?.value;
    if (value?.statuses && !value?.messages) {
        res.status(200).send({ status: 'ignored/status_update' });
        return;
    }

    const messages = findMessages(body) || [];
    if (messages.length === 0) {
        res.status(200).send({ status: 'ignored' });
        return;
    }

    const message = messages[0];
    const messageId = message.id;

    // Echo filter
    const metadata = value?.metadata;
    if (metadata?.display_phone_number && message.from === metadata.display_phone_number.replace(/\D/g, '')) {
        res.status(200).send({ status: 'ignored/echo' });
        return;
    }

    // Dedup via Redis
    if (messageId) {
        const alreadyProcessed = await redisService.isProcessed(messageId);
        if (alreadyProcessed) {
            res.status(200).send({ status: 'ignored/duplicate' });
            return;
        }
        await redisService.markProcessed(messageId);
    }

    // Stale check (1h)
    const messageTimestamp = parseInt(message.timestamp, 10);
    const nowEpoch = Math.floor(Date.now() / 1000);
    const MAX_AGE_SECONDS = 3600;
    if (messageTimestamp && (nowEpoch - messageTimestamp) > MAX_AGE_SECONDS) {
        console.warn(`[WhatsApp] Dropping STALE message (age: ${nowEpoch - messageTimestamp}s). ID: ${messageId}`);
        res.status(200).send({ status: 'ignored/stale' });
        return;
    }

    res.status(200).send({ status: 'received' });

    // Background processing
    enqueueUserJob(message.from, async () => {
        const from = message.from;
        const preState = userContextState.get(from) || {};
        const contact = value?.contacts?.[0];
        const userName = contact?.profile?.name || from;
        const currentTs = parseInt(message.timestamp || '0', 10) || Math.floor(Date.now() / 1000);
        const lastTs = userLatestTimestamp.get(from) || 0;
        if (currentTs + 120 < lastTs) return;
        userLatestTimestamp.set(from, Math.max(currentTs, lastTs));

        // Typing indicator
        sendTypingIndicator(from, messageId).catch(() => { });

        // Extract text
        let text = '';
        if (message.type === 'text') {
            text = message.text?.body || '';
        } else if (message.type === 'interactive') {
            const rawInteractive = message.interactive?.button_reply?.id ||
                message.interactive?.list_reply?.id ||
                message.interactive?.button_reply?.title ||
                message.interactive?.list_reply?.title || '';
            text = normalizeInteractiveCommand(rawInteractive, preState.lastInteractiveMenu);
        } else if (message.type === 'button') {
            const rawButton = message.button?.payload || message.button?.text || '';
            text = normalizeInteractiveCommand(rawButton, preState.lastInteractiveMenu);
        } else if (message.type === 'audio') {
            text = "[AUDIO]";
        }

        if (!text) return;

        let normalizedInput = normalizeFreeTextToCommand(text, preState);

        // Before normalizing to MENU_PRINCIPAL, check if it's a pure greeting.
        // If it is, and we aren't in an active flow, clear hasInteracted so the user gets the FULL greeting.
        const flatText = normalizedInput.replace(/\s+/g, ' ').trim().toLowerCase();
        const looksLikeGreeting = /^(oi|ol[áa]|bom dia|boa tarde|boa noite|tudo bem|blz|beleza|opa)\b/i.test(flatText) || GREETING_COMMANDS.has(flatText);
        if (looksLikeGreeting && flatText.split(' ').length <= 4 && !isInActiveFlow(from)) {
            preState.hasInteracted = false;
            userContextState.set(from, preState);
        }

        text = normalizeNaturalLanguageToMenuCommand(normalizedInput, preState.lastInteractiveMenu, message.type, from);
        console.log(`[WhatsApp] Final input: "${String(text).slice(0, 160)}"`);

        // Content dedup
        const bypassDedup = shouldBypassContentDedup(text, message.type);
        if (!bypassDedup) {
            const isDupContent = await redisService.isDuplicateContent(from, text.trim().toLowerCase());
            if (isDupContent) return;
        }

        try {
            const botActive = await chatwootService.checkBotActive(from);
            if (!botActive) return;

            await chatwootService.syncMessage(from, userName, text, 'incoming', { source: 'whatsapp' });

            // Phone capture for reservation
            const st = userContextState.get(from) || {};
            if (st.reservation?.awaitingNewPhone && !/^menu_|^unidade_|^cardapio_|^delivery_|^confirm_/.test(text.trim().toLowerCase())) {
                const normalizedPhone = normalizeReservationPhone(text);
                if (!normalizedPhone) {
                    const msg = 'Esse número parece inválido 😕 Me envia um celular válido com DDD (10 ou 11 dígitos).';
                    await sendWhatsAppText(from, msg);
                    await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
                    return;
                }
                st.reservation!.contactPhone = normalizedPhone;
                st.reservation!.phoneConfirmed = true;
                st.reservation!.awaitingNewPhone = false;
                userContextState.set(from, st);

                const resv = st.reservation!;
                const missing: string[] = [];
                if (!resv.name) missing.push('nome completo');
                if (!resv.dateText) missing.push('data');
                if (!resv.timeText) missing.push('horário');
                if (resv.people === undefined) missing.push('quantidade de pessoas');

                const checklist = [
                    `Olha como está seu pré-cadastro:`,
                    `- 👤 Nome: ${resv.name || '❓ Pendente'}`,
                    `- 📱 Celular: ${formatBrazilPhoneDisplay(resv.contactPhone || from)}`,
                    `- 📅 Data: ${resv.dateText || '❓ Pendente'}`,
                    `- ⏰ Horário: ${resv.timeText || '❓ Pendente'}`,
                    `- 👥 Pessoas: ${resv.people !== undefined ? resv.people : '❓ Pendente'}`,
                    `- 👶 Crianças: ${resv.kids !== undefined ? resv.kids : '❓ Pendente'}`
                ].join('\n');

                const msgBody = missing.length > 0
                    ? `Perfeito! Vou usar o número ${formatBrazilPhoneDisplay(normalizedPhone)} para a reserva. ✅\n\n${checklist}\n\nPra eu seguir, me manda só: *${missing.join(', ')}*.`
                    : `Perfeito! Vou usar o número ${formatBrazilPhoneDisplay(normalizedPhone)} para a reserva. ✅\n\n${checklist}\n\nJá tenho tudo para seguir com a confirmação!`;

                await sendWhatsAppText(from, msgBody);
                await chatwootService.syncMessage(from, userName, msgBody, 'outgoing', { source: 'bot' });
                return;
            }

            // Prompt injection guard
            if (isPromptInjectionLike(text)) {
                await sendWhatsAppText(from, INJECTION_BLOCK_MSG);
                await chatwootService.syncMessage(from, userName, INJECTION_BLOCK_MSG, 'outgoing', { source: 'bot' });
                return;
            }

            // Extract reservation facts from free text
            const facts = extractReservationFacts(text);
            if (Object.keys(facts).length > 0) {
                const reservation = st.reservation || {};
                if (facts.people !== undefined) reservation.people = facts.people;
                if (facts.kids !== undefined) reservation.kids = facts.kids;
                if (facts.occasion !== undefined) reservation.occasion = facts.occasion;
                if (facts.notes !== undefined) reservation.notes = facts.notes;
                if (facts.name !== undefined) reservation.name = facts.name;
                if (facts.dateText !== undefined) reservation.dateText = facts.dateText;
                if (facts.timeText !== undefined) reservation.timeText = facts.timeText;
                st.reservation = reservation;
                userContextState.set(from, st);
            }

            // ... log facts for debugging
            console.log(`[WhatsApp] Extracted facts:`, facts);
            console.log(`[WhatsApp] Current reservation state before AI call:`, st.reservation);

            // Detect cancellation intent — set awaitingCancellation to prevent
            // 'sim' from being misrouted to confirm_reserva_sim
            const lowerText = text.toLowerCase();
            if (/\b(cancelar|cancela|cancelamento)\b/i.test(lowerText) && /\b(reserva|mesa)\b/i.test(lowerText)) {
                const reservation = st.reservation || {};
                reservation.awaitingCancellation = true;
                reservation.awaitingConfirmation = false; // Clear confirmation state
                st.reservation = reservation;
                userContextState.set(from, st);
                console.log(`[WhatsApp] Cancellation intent detected for ${from}. Set awaitingCancellation=true.`);
            }

            // Deterministic routing
            const forceDeterministic = shouldForceDeterministicRoute(text, message.type, from);
            if (forceDeterministic) {
                const handledMenu = await handleDeterministicMenuCommand(text, from, userName);
                if (handledMenu) return;
                const handledInteractive = await handleDeterministicInteractiveCommand(text, from, userName);
                if (handledInteractive) return;
            }

            // Cardápio intent — direct link for generic requests
            if (isCardapioIntent(text)) {
                const cardapioState = userContextState.get(from) || {};
                if (isGenericCardapioRequest(text) && !cardapioState.preferredCity) {
                    await sendCitiesMenu(from);
                    await chatwootService.syncMessage(from, userName, 'MENU_CIDADES_CARDAPIO', 'outgoing', { source: 'bot' });
                    return;
                }
                if (cardapioState.preferredCity && isGenericCardapioRequest(text)) {
                    await sendCardapioByCity(from, userName, cardapioState.preferredCity);
                    return;
                }
            }

            // Delivery intent — route to deterministic delivery flow
            if (isDeliveryIntent(text)) {
                const deliveryCity = extractDeliveryCity(text);
                if (deliveryCity) {
                    const deliveryState = userContextState.get(from) || {};
                    deliveryState.deliveryFlow = { city: deliveryCity };
                    userContextState.set(from, deliveryState);
                    if (deliveryCity === 'São Paulo') {
                        const msg = "Poxa, em SP ainda não tem delivery! 😢 Mas vem visitar a gente no Shopping Parque da Cidade! 🧡";
                        await sendWhatsAppText(from, msg);
                        await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
                    } else {
                        await sendDeliveryChoiceMenu(from);
                        await chatwootService.syncMessage(from, userName, 'MENU_DELIVERY_OPCOES', 'outgoing', { source: 'bot' });
                    }
                    return;
                }
                // No city detected — show city menu
                await sendDeliveryCitiesMenu(from);
                await chatwootService.syncMessage(from, userName, 'MENU_DELIVERY_CIDADES', 'outgoing', { source: 'bot' });
                return;
            }

            // AI Agent processing
            const systemPrompt = await promptService.getSystemPrompt();
            const history = await redisService.getHistory(from);
            const userState = userContextState.get(from) || {};
            const reservationState = userState.reservation || {};

            const mandatoryRules: string[] = [];
            if (reservationState.people !== undefined) mandatoryRules.push(`O cliente ja informou ${reservationState.people} pessoas.`);
            if (reservationState.kids !== undefined) mandatoryRules.push(`O cliente ja informou ${reservationState.kids} criancas.`);
            if (reservationState.phoneConfirmed) {
                mandatoryRules.push('Telefone ja confirmado. Nao pergunte CONFIRM_PHONE_NUMBER novamente.');
                mandatoryRules.push(`Telefone do cliente: ${from}.`);
            }
            if (userState.preferredUnitName) mandatoryRules.push(`Unidade escolhida: ${userState.preferredUnitName}.`);
            if (userState.preferredStoreId) mandatoryRules.push(`storeId: ${userState.preferredStoreId}.`);
            if (reservationState.name) mandatoryRules.push(`Nome: ${reservationState.name}.`);
            if (reservationState.dateText) mandatoryRules.push(`Data: ${reservationState.dateText}.`);
            if (reservationState.timeText) mandatoryRules.push(`Horario: ${reservationState.timeText}.`);
            mandatoryRules.push(`Telefone WhatsApp do cliente: ${from}. Use este numero para query_reservations, create_client, create_reservation.`);
            mandatoryRules.push('Ao exibir data, use DD/MM/YYYY. Nao exiba ISO entre parenteses.');

            // Prevent AI from returning MENU_PRINCIPAL when user is in an active flow
            if (isInActiveFlow(from)) {
                mandatoryRules.push('⚠️ REGRA CRITICA: O cliente esta no MEIO de um fluxo ativo (reserva ou delivery). NAO responda MENU_PRINCIPAL. Continue o fluxo atual. Se o cliente mandar uma saudacao como "oi" ou "ola", trate como uma continuacao da conversa, NAO como um pedido para voltar ao menu.');
                if (text.toLowerCase() === 'confirm_reserva_sim') {
                    mandatoryRules.push('⚠️ O cliente CONFIRMOU a reserva (confirm_reserva_sim). Chame create_reservation AGORA com os dados coletados. NAO peca mais informacoes, NAO responda MENU_PRINCIPAL.');
                }
            }

            const result = await khaAgent.processMessage(text, from, {
                history,
                systemPrompt,
                clientPhone: from,
                preferredCity: userState.preferredCity,
                preferredStoreId: userState.preferredStoreId,
                preferredUnitName: userState.preferredUnitName,
                reservationFacts: reservationState,
                forceInstructions: mandatoryRules.join('\n')
            });
            let response = result.response;

            if (response) {
                console.log(`[WhatsApp] Agent Response: "${response.slice(0, 100)}..."`);

                // Intercept cancellation confirmation token
                const cancelMatch = response.match(/CONFIRM_CANCEL_ID:\s*([A-Za-z0-9\-]+)/);
                if (cancelMatch) {
                    const resId = cancelMatch[1];
                    const preamble = response.replace(cancelMatch[0], '').trim() || "Você confirma o cancelamento desta reserva? 😕";
                    await sendCancelConfirmationMenu(from, resId, preamble);
                    // Update History
                    history.push({ role: 'user', content: text });
                    history.push({ role: 'assistant', content: preamble });
                    await redisService.saveHistory(from, history);
                    // Mark state
                    userState.hasInteracted = true;
                    userContextState.set(from, userState);
                    return;
                }

                // Token triggers in AI response (includes aliases for robustness)
                const triggers = [
                    { key: 'MENU_PRINCIPAL', action: () => sendInteractiveMenu(from, !!userState.hasInteracted), menuOnly: true },
                    { key: 'MENU_CIDADES_CARDAPIO', action: () => sendCitiesMenu(from), menuOnly: true },
                    { key: 'MENU_DELIVERY_CIDADES', action: () => sendDeliveryCitiesMenu(from), menuOnly: true },
                    { key: 'LIST_RESERVA_UNIDADES', action: () => sendUnidadesMenu(from), menuOnly: true },
                    { key: 'MENU_RESERVA_UNIDADES', action: () => sendUnidadesMenu(from), menuOnly: true }, // alias
                    { key: 'MENU_UNIDADES', action: () => sendUnidadesMenu(from), menuOnly: true },          // alias
                    { key: 'CONFIRM_RESERVATION_RESUMO', action: () => sendConfirmationMenu(from), menuOnly: false },
                    { key: 'CONFIRM_PHONE_NUMBER', action: () => sendPhoneNumberConfirmation(from), menuOnly: false },
                    { key: 'MENU_DELIVERY_OPCOES', action: () => sendDeliveryChoiceMenu(from), menuOnly: false }
                ];

                const matchedTrigger = triggers.find(t => response.includes(t.key));

                if (matchedTrigger) {
                    if (matchedTrigger.key === 'CONFIRM_RESERVATION_RESUMO') {
                        const st2 = userContextState.get(from) || {};
                        const reservation = st2.reservation || {};
                        if (!reservation.name) {
                            const msg = 'Antes de confirmar, me passa seu *nome completo*, por favor. 😊';
                            await sendWhatsAppText(from, msg);
                            await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
                            return;
                        }
                        reservation.awaitingConfirmation = true;
                        st2.reservation = reservation;
                        userContextState.set(from, st2);
                    }

                    if (!matchedTrigger.menuOnly) {
                        const preamble = response.split(matchedTrigger.key)[0].trim();
                        if (preamble) {
                            const safePreamble = sanitizeWhatsAppText(preamble);
                            await sendWhatsAppText(from, safePreamble);
                            await chatwootService.syncMessage(from, userName, safePreamble, 'outgoing', { source: 'bot' });
                        }
                    }
                    await matchedTrigger.action();
                } else {
                    const safeResponse = sanitizeWhatsAppText(response);
                    await sendWhatsAppText(from, safeResponse);
                    await chatwootService.syncMessage(from, userName, safeResponse, 'outgoing', { source: 'bot' });
                }

                // History update
                history.push({ role: 'user', content: text });
                history.push({ role: 'assistant', content: response });
                await redisService.saveHistory(from, history);

                // Mark as interacted so next time the menu is compact
                userState.hasInteracted = true;
                userContextState.set(from, userState);
            }
        } catch (err) {
            console.error('[WhatsApp] Background processing error:', err);
        }
    });
};

// ─── Send Helpers ───────────────────────────────────────────────────────────

export async function sendWhatsAppText(to: string, text: string) {
    try {
        const normalized = normalizeForOutboundDedupe(text);
        const now = Date.now();
        const DEDUPE_WINDOW_MS = 30_000;
        const last = lastOutboundByUser.get(to);
        if (last && last.hash === normalized && now - last.at <= DEDUPE_WINDOW_MS) return;

        await postGraphMessageWithRetry({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to, type: 'text',
            text: { body: text }
        }, 'send_text', 2);
        lastOutboundByUser.set(to, { hash: normalized, at: now });
    } catch (err: any) {
        console.error('[WhatsApp] Error sending text:', extractGraphError(err));
    }
}

async function sendTypingIndicator(to: string, messageId: string) {
    try {
        await postGraphMessageWithRetry({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to, status: "read",
            message_id: messageId,
            typing_indicator: { type: "text" }
        }, 'send_typing_indicator', 1);
    } catch { }
}

async function sendCardapioByCity(from: string, userName: string, city: 'Curitiba' | 'Londrina' | 'São Paulo') {
    const keyMap: Record<string, string> = {
        Curitiba: 'link_cardapio_curitiba', Londrina: 'link_cardapio_londrina', 'São Paulo': 'link_cardapio_sp'
    };
    const link = await db.getConfig(keyMap[city]);
    const finalLink = link || 'https://cardapio.kharina.com.br/';
    const msg = `Perfeito! Aqui está o cardápio de ${city} 🍽️\n👉 ${finalLink}`;
    await sendWhatsAppText(from, msg);
    await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
    await sendInteractiveMenu(from, true);
}

// ─── Interactive Menus ──────────────────────────────────────────────────────

async function sendInteractiveMenu(to: string, compact = false) {
    const menuPayload = {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
            type: "list",
            body: {
                text: compact
                    ? "Beleza! 👌 Escolha uma opção:"
                    : "Opa! 👋 Eu sou a Kha do Kharina 😃\nEscolha uma opção:"
            },
            action: {
                button: "Ver opções",
                sections: [{
                    title: "O que você quer fazer?",
                    rows: [
                        { id: "menu_cardapio", title: "1️⃣ Ver Cardápio" },
                        { id: "menu_reserva", title: "2️⃣ Reservar Mesa" },
                        { id: "menu_delivery", title: "3️⃣ Delivery 🍟🚀" }
                    ]
                }]
            }
        }
    };
    await sendInteractiveWithFallback(to, menuPayload, 'send_main_menu',
        'Escolha: 1) Ver Cardápio 2) Reservar Mesa 3) Delivery');
    setLastInteractiveMenu(to, 'main_menu');
}

async function sendCitiesMenu(to: string) {
    const menuPayload = {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
            type: "list",
            body: { text: "Escolhe a cidade pra eu te mostrar o cardápio certinho:" },
            action: {
                button: "Ver cidades",
                sections: [{
                    title: "Cidades",
                    rows: [
                        { id: "cardapio_curitiba", title: "1️⃣ Curitiba / PR" },
                        { id: "cardapio_londrina", title: "2️⃣ Londrina / PR" },
                        { id: "cardapio_saopaulo", title: "3️⃣ São Paulo / SP" }
                    ]
                }]
            }
        }
    };
    await sendInteractiveWithFallback(to, menuPayload, 'send_cities_menu',
        'Escolha a cidade: Curitiba, Londrina ou São Paulo.');
    setLastInteractiveMenu(to, 'cardapio_cities');
}

async function sendUnidadesMenu(to: string) {
    const menuPayload = {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
            type: "list",
            body: { text: "Qual unidade você deseja?" },
            action: {
                button: "Ver unidades",
                sections: [{
                    title: "Unidades Kharina",
                    rows: [
                        { id: "unidade_botanico", title: "🌿 Jardim Botânico" },
                        { id: "unidade_cabral", title: "🏘️ Cabral" },
                        { id: "unidade_agua_verde", title: "🌳 Água Verde" },
                        { id: "unidade_batel", title: "🏛️ Batel" },
                        { id: "unidade_portao", title: "🚪 Portão" },
                        { id: "unidade_londrina", title: "🏙️ Londrina" },
                        { id: "unidade_saopaulo", title: "🌆 São Paulo" }
                    ]
                }]
            }
        }
    };
    await sendInteractiveWithFallback(to, menuPayload, 'send_unidades_menu',
        'Qual unidade? (Jardim Botânico, Cabral, Água Verde, Batel, Portão, Londrina ou São Paulo).');
    setLastInteractiveMenu(to, 'reserva_units');
}

async function sendPhoneNumberConfirmation(to: string) {
    const menuPayload = {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
            type: "button",
            body: { text: "Posso usar este número para o registro da reserva? 📱" },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "phone_use_current", title: "Sim, pode usar! ✅" } },
                    { type: "reply", reply: { id: "phone_ask_new", title: "Não, usar outro ✏️" } }
                ]
            }
        }
    };
    await sendInteractiveWithFallback(to, menuPayload, 'send_phone_confirmation',
        'Posso usar este número para a reserva? Responda "sim" ou "não, usar outro".');
    setLastInteractiveMenu(to, 'phone_confirmation');
}

async function sendConfirmationMenu(to: string) {
    const state = userContextState.get(to) || {};
    const resv = state.reservation || {};
    const unit = state.preferredUnitName || '❓ Pendente';

    const checklist = [
        `Dá uma olhada no resumo da sua reserva:`,
        `- 👤 Nome: ${resv.name || '❓ Pendente'}`,
        `- 📱 Celular: ${formatBrazilPhoneDisplay(resv.contactPhone || to)}`,
        `- 📅 Data: ${resv.dateText || '❓ Pendente'}`,
        `- ⏰ Horário: ${resv.timeText || '❓ Pendente'}`,
        `- 👥 Pessoas: ${resv.people !== undefined ? resv.people : '❓ Pendente'}`,
        `- 👶 Crianças: ${resv.kids !== undefined ? resv.kids : '❓ Pendente'}`,
        `- 📍 Unidade: ${unit}`
    ].join('\n');

    const menuPayload = {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
            type: "button",
            body: { text: `${checklist}\n\nOs dados da reserva estão corretos? 😄` },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "confirm_reserva_sim", title: "Sim, tudo certo! ✅" } },
                    { type: "reply", reply: { id: "confirm_reserva_nao", title: "Não, mudar algo ❌" } }
                ]
            }
        }
    };
    await sendInteractiveWithFallback(to, menuPayload, 'send_confirmation_menu',
        `${checklist}\n\nOs dados da reserva estão corretos? Responda "sim" ou "não, mudar algo".`);
    setLastInteractiveMenu(to, 'reserva_confirmation');
}

async function sendCancelConfirmationMenu(to: string, reservationId: string, customBody: string) {
    const defaultBody = "Você confirma que quer cancelar essa reserva? 😕";
    const bodyText = customBody.trim() || defaultBody;
    const menuPayload = {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
            type: "button",
            body: { text: bodyText },
            action: {
                buttons: [
                    { type: "reply", reply: { id: `cancel_sim_${reservationId.substring(0, 8)}`, title: "Sim, cancelar ❌" } },
                    { type: "reply", reply: { id: `cancel_nao`, title: "Não, manter ✅" } }
                ]
            }
        }
    };
    await sendInteractiveWithFallback(to, menuPayload, 'send_cancel_confirmation',
        `${bodyText} Responda "Sim, cancelar" ou "Não".`);
    setLastInteractiveMenu(to, 'cancel_confirmation');
}

async function sendDeliveryCitiesMenu(to: string): Promise<boolean> {
    const menuPayload = {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
            type: "list",
            body: { text: "De qual cidade você está pedindo? 🛵" },
            action: {
                button: "Escolher Cidade",
                sections: [{
                    title: "Cidades com Delivery",
                    rows: [
                        { id: "delivery_curitiba", title: "1️⃣ Curitiba / PR" },
                        { id: "delivery_londrina", title: "2️⃣ Londrina / PR" },
                        { id: "delivery_saopaulo", title: "3️⃣ São Paulo / SP" }
                    ]
                }]
            }
        }
    };
    const sent = await sendInteractiveWithFallback(to, menuPayload, 'send_delivery_cities_menu',
        'De qual cidade? 1) Curitiba 2) Londrina 3) São Paulo');
    setLastInteractiveMenu(to, 'delivery_cities');
    return sent;
}

async function sendDeliveryChoiceMenu(to: string) {
    const menuPayload = {
        messaging_product: "whatsapp", to, type: "interactive",
        interactive: {
            type: "button",
            body: { text: "Você quer fazer um *novo pedido* ou precisa de *ajuda* com um pedido já feito? 😊" },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "delivery_novo", title: "1️⃣ Novo Pedido" } },
                    { type: "reply", reply: { id: "delivery_ajuda", title: "2️⃣ Preciso Ajuda" } }
                ]
            }
        }
    };
    await sendInteractiveWithFallback(to, menuPayload, 'send_delivery_choice_menu',
        'Você quer: "Novo Pedido" ou "Preciso de Ajuda"?');
    setLastInteractiveMenu(to, 'delivery_choice');
}
