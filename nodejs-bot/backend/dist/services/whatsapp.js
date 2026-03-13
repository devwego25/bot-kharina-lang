"use strict";
/**
 * REFACTORED WhatsApp Service - Using Python LangChain Agent
 *
 * Correções aplicadas:
 * - Deduplicação de mensagens (content-based)
 * - Filtro de echo (mensagens do bot)
 * - Parsing correto de mensagens interativas
 * - Rate limiting por usuário
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleWhatsAppWebhook = exports.verifyWebhook = void 0;
exports.wasRecentlyMirroredByBot = wasRecentlyMirroredByBot;
exports.sendWhatsAppText = sendWhatsAppText;
const env_1 = require("../config/env");
const redis_1 = require("./redis");
const chatwoot_1 = require("./chatwoot");
const db_1 = require("./db");
const langchain_1 = require("./langchain");
const mcp_1 = require("./mcp");
const reservationAdmin_1 = require("./reservationAdmin");
const axios_1 = __importDefault(require("axios"));
const socks_proxy_agent_1 = require("socks-proxy-agent");
// In-memory state (consider moving to Redis for multi-instance)
const userStates = new Map();
const lastOutboundByUser = new Map();
const recentOutboundContentByUser = new Map();
const interactiveDegradedUntil = new Map();
const userProcessingQueue = new Map();
const botActiveCache = new Map();
const storesHoursCache = new Map();
const capturedOutboundByUser = new Map();
let reservasCallQueue = Promise.resolve();
const INTERACTIVE_DEGRADED_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 1000; // 1 second between messages
const FLOW_IDLE_RESET_MS = 120 * 60 * 1000; // keep in-progress flow for 2h before reset
const GRAPH_API_TIMEOUT_MS = 8000;
const BOT_ACTIVE_CACHE_TTL_MS = 15_000;
const BOT_ACTIVE_TIMEOUT_MS = 700;
const STORES_HOURS_CACHE_TTL_MS = 10 * 60 * 1000;
const RECENT_OUTBOUND_WINDOW_MS = 2 * 60 * 1000;
const MIN_RESERVATION_LEAD_MINUTES = 120;
const SCOPE_ONLY_MSG = 'Só posso ajudar com assuntos do restaurante: cardápio, reservas e delivery.';
// Command sets
const MENU_COMMANDS = new Set(['MENU_PRINCIPAL', 'menu_cardapio', 'menu_reserva', 'menu_delivery', 'menu_kids']);
const GREETING_COMMANDS = new Set(['oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'hello', 'hi']);
const GREETING_REGEX = /\b(oi|ol[áa]|bom dia|boa tarde|boa noite|e ai|e aí|opa|tudo bem|tudo bom|hello|hi)\b/i;
const UNIT_CONFIG = {
    unidade_botanico: { name: 'Jardim Botânico', storeId: 'a99c098f-c16b-4168-a5b1-54e76aa1a855' },
    unidade_cabral: { name: 'Cabral', storeId: 'c6919b3c-f5ff-4006-a226-2b493d9d8cf5' },
    unidade_agua_verde: { name: 'Água Verde', storeId: 'fde9ba37-baff-4958-b6be-5ced7059864c' },
    unidade_batel: { name: 'Batel', storeId: 'b45c9b5e-4f79-47b1-a442-ea8fb9d6e977' },
    unidade_portao: { name: 'Portão', storeId: 'f0f6ae17-01d1-4c51-a423-33222f8fcd5c' },
    unidade_londrina: { name: 'Londrina', storeId: '3e027375-3049-4080-98c3-9f7448b8fd62' },
    unidade_saopaulo: { name: 'São Paulo', storeId: '03dc5466-6c32-4e9e-b92f-c8b02e74bba6' }
};
const UNIT_PHONE_BY_NAME = {
    'Jardim Botânico': '(41) 3092-0449',
    'Cabral': '(41) 99288-6397',
    'Água Verde': '(41) 98811-6685',
    'Batel': '(41) 3203-4940',
    'Portão': '(41) 3083-7600',
    'Londrina': '(43) 3398-9191',
    'São Paulo': '(11) 5432-0052'
};
const UNIT_TEXT_MATCHERS = [
    { rx: /\bjardim\s*botanico\b|\bbotanico\b/, id: 'unidade_botanico' },
    { rx: /\bcabral\b/, id: 'unidade_cabral' },
    { rx: /\bagua\s*verde\b/, id: 'unidade_agua_verde' },
    { rx: /\bbatel\b/, id: 'unidade_batel' },
    { rx: /\bportao\b/, id: 'unidade_portao' },
    { rx: /\blondrina\b/, id: 'unidade_londrina' },
    { rx: /\bsao\s*paulo\b/, id: 'unidade_saopaulo' }
];
const CHATWOOT_COMMAND_LABELS = {
    MENU_PRINCIPAL: 'Menu principal',
    menu_cardapio: 'Menu de cardapio',
    cardapio_curitiba: 'Cardapio Curitiba',
    cardapio_londrina: 'Cardapio Londrina',
    cardapio_saopaulo: 'Cardapio Sao Paulo',
    menu_reserva: 'Menu de reserva',
    unidade_botanico: 'Unidade Jardim Botanico',
    unidade_cabral: 'Unidade Cabral',
    unidade_agua_verde: 'Unidade Agua Verde',
    unidade_batel: 'Unidade Batel',
    unidade_portao: 'Unidade Portao',
    unidade_londrina: 'Unidade Londrina',
    unidade_saopaulo: 'Unidade Sao Paulo',
    phone_use_current: 'Confirmou uso do telefone atual',
    phone_ask_new: 'Informar outro telefone',
    confirm_reserva_sim: 'Confirmou resumo da reserva',
    confirm_reserva_nao: 'Solicitou ajuste no resumo',
    menu_delivery: 'Menu de delivery',
    delivery_curitiba: 'Delivery Curitiba',
    delivery_londrina: 'Delivery Londrina',
    delivery_saopaulo: 'Delivery Sao Paulo',
    delivery_novo: 'Delivery novo pedido',
    delivery_ajuda: 'Delivery preciso de ajuda',
    menu_kids: 'Menu Espaco Kids'
};
// Bot message patterns to ignore (echo detection)
const BOT_MESSAGE_PATTERNS = [
    /^(opa!? ?👋? ?eu sou a kha|beleza!? ?👌|escolha uma opção|escolhe a cidade|qual unidade)/i,
    /^(perfeito!? ?aqui está o cardápio|show!?) ?🍽?/i,
    /^(você quer fazer um novo pedido|sinto muito pelo problema)/i,
    /^(prontinho!? ?✅? ?já encaminhei)/i,
];
const reservasMcp = new mcp_1.McpClient(process.env.MCP_RESERVAS_URL || 'https://mcp.reservas.wegosb.com.br/mcp', 'Reservas', process.env.MCP_RESERVAS_TOKEN, false, 'streamable');
let reservasMcpInitPromise = null;
const userStatesSet = userStates.set.bind(userStates);
userStates.set = ((userId, state) => {
    userStatesSet(userId, state);
    redis_1.redisService.saveUserState(userId, state).catch((err) => {
        console.error('[State] Failed to persist user state:', err?.message || err);
    });
    return userStates;
});
// ============ Helper Functions ============
function normalizeForOutboundDedupe(text) {
    return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function normalizeUnitName(value) {
    return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}
function formatBrazilPhone(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    const br = digits.startsWith('55') ? digits.slice(2) : digits;
    if (br.length === 11)
        return `(${br.slice(0, 2)}) ${br.slice(2, 7)}-${br.slice(7)}`;
    if (br.length === 10)
        return `(${br.slice(0, 2)}) ${br.slice(2, 6)}-${br.slice(6)}`;
    return raw;
}
function toIsoDate(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
function nextWeekdayDate(targetWeekday, fromDate = new Date()) {
    const base = new Date(fromDate);
    base.setHours(0, 0, 0, 0);
    const todayWeekday = base.getDay();
    let diff = (targetWeekday - todayWeekday + 7) % 7;
    if (diff === 0)
        diff = 7;
    base.setDate(base.getDate() + diff);
    return base;
}
function nextDayOfMonthDate(targetDay, fromDate = new Date()) {
    if (targetDay < 1 || targetDay > 31)
        return null;
    const base = new Date(fromDate);
    base.setHours(0, 0, 0, 0);
    const year = base.getFullYear();
    const month = base.getMonth();
    const candidateCurrent = new Date(year, month, targetDay);
    if (candidateCurrent.getMonth() === month && candidateCurrent >= base)
        return candidateCurrent;
    const candidateNext = new Date(year, month + 1, targetDay);
    if (candidateNext.getDate() === targetDay)
        return candidateNext;
    return null;
}
function isValidAdminTimeInput(text) {
    const normalized = normalizeTime(text);
    if (!/^\d{2}:\d{2}$/.test(normalized))
        return null;
    const [hour, minute] = normalized.split(':').map(Number);
    if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59)
        return null;
    return normalized;
}
function ensureAdminState(state) {
    state.admin = state.admin || {};
    return state.admin;
}
function clearAdminState(state) {
    delete state.admin;
}
function buildReservationBlockCustomerMessage(block, unitName, requestedDate, requestedTime) {
    const unitLabel = unitName || block.store_name || 'essa unidade';
    const base = `A reserva para a unidade ${unitLabel} nesse dia e horário está bloqueada, então o atendimento será por ordem de chegada ao restaurante. Ficaremos felizes em receber vocês por aqui.`;
    if (block.mode === 'suggest_alternative') {
        return `${base}\n\nSe quiser, me diga outro horário ou outra unidade e eu verifico por aqui.`;
    }
    if (block.mode === 'handoff') {
        const phone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';
        if (phone) {
            return `${base}\n\nSe quiser, também posso verificar outro horário ou outra unidade para você. Se preferir falar direto com a unidade, o telefone é ${phone}.`;
        }
        return `${base}\n\nSe quiser, também posso verificar outro horário ou outra unidade para você.`;
    }
    return `${base}\n\nSe quiser, também posso verificar outro horário ou outra unidade para você.`;
}
function buildReservationDateTime(date, time) {
    const normalizedDate = normalizeIsoDate(String(date || '').trim());
    const normalizedTime = normalizeTime(String(time || '').trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate))
        return null;
    if (!/^\d{2}:\d{2}$/.test(normalizedTime))
        return null;
    const reservationAt = new Date(`${normalizedDate}T${normalizedTime}:00-03:00`);
    if (Number.isNaN(reservationAt.getTime()))
        return null;
    return reservationAt;
}
function getReservationLeadTimeMessage(unitName) {
    const unitLabel = unitName || 'essa unidade';
    return `Para a unidade ${unitLabel}, só aceitamos reservas com pelo menos 2 horas de antecedência.\n\nSe quiser, posso verificar outro horário ou outra unidade para você.`;
}
function getReservationLeadTimeViolation(date, time, unitName) {
    if (!date || !time)
        return null;
    const reservationAt = buildReservationDateTime(date, time);
    if (!reservationAt)
        return null;
    const minAllowedAt = Date.now() + (MIN_RESERVATION_LEAD_MINUTES * 60 * 1000);
    if (reservationAt.getTime() < minAllowedAt) {
        return getReservationLeadTimeMessage(unitName);
    }
    return null;
}
async function maybeGetReservationBlock(state) {
    const storeId = String(state.preferred_store_id || '').trim();
    const date = normalizeIsoDate(String(state.reservation?.date_text || '').trim());
    const time = normalizeTime(String(state.reservation?.time_text || '').trim());
    if (!storeId || !date || !time)
        return null;
    return (0, reservationAdmin_1.findMatchingReservationBlock)({ storeId, date, time });
}
function toBrDate(isoOrBr) {
    const v = String(isoOrBr || '').trim();
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso)
        return `${iso[3]}/${iso[2]}/${iso[1]}`;
    return v;
}
function normalizeIntentText(text) {
    return String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function extractPhoneCandidate(text) {
    const matches = String(text || '').match(/\+?\d[\d\s().-]{8,}\d/g) || [];
    for (const raw of matches) {
        const digits = toDigitsPhone(raw);
        const br = digits.startsWith('55') ? digits.slice(2) : digits;
        if (br.length === 10 || br.length === 11) {
            return digits.startsWith('55') ? digits : `55${digits}`;
        }
    }
    return null;
}
function hasCompleteReservationData(reservation) {
    return !!reservation?.people &&
        !!reservation?.date_text &&
        !!reservation?.time_text &&
        reservation?.kids !== undefined;
}
function getMissingReservationFields(reservation) {
    const missing = [];
    if (!reservation?.people)
        missing.push('quantos adultos');
    if (!reservation?.date_text)
        missing.push('a data');
    if (!reservation?.time_text)
        missing.push('o horário');
    if (reservation?.kids === undefined)
        missing.push('se terá crianças (e quantas)');
    return missing;
}
function buildInteractivePreview(menuPayload, fallbackText) {
    const bodyText = String(menuPayload?.interactive?.body?.text || '').trim();
    const interactiveType = String(menuPayload?.interactive?.type || '').trim();
    const optionTitles = [];
    if (interactiveType === 'button') {
        const buttons = Array.isArray(menuPayload?.interactive?.action?.buttons)
            ? menuPayload.interactive.action.buttons
            : [];
        buttons.forEach((button) => {
            const title = String(button?.reply?.title || '').trim();
            if (title)
                optionTitles.push(title);
        });
    }
    else if (interactiveType === 'list') {
        const sections = Array.isArray(menuPayload?.interactive?.action?.sections)
            ? menuPayload.interactive.action.sections
            : [];
        sections.forEach((section) => {
            const rows = Array.isArray(section?.rows) ? section.rows : [];
            rows.forEach((row) => {
                const title = String(row?.title || '').trim();
                const description = String(row?.description || '').trim();
                if (title && description)
                    optionTitles.push(`${title} - ${description}`);
                else if (title)
                    optionTitles.push(title);
            });
        });
    }
    if (bodyText && optionTitles.length > 0) {
        return `${bodyText}\n\nOpções:\n${optionTitles.map((title) => `- ${title}`).join('\n')}`;
    }
    if (bodyText)
        return bodyText;
    if (fallbackText)
        return fallbackText;
    return '[MENU_INTERATIVO]';
}
function beginOutboundCapture(userId) {
    capturedOutboundByUser.set(userId, []);
}
function clearOutboundCapture(userId) {
    capturedOutboundByUser.delete(userId);
}
function captureOutboundMessage(userId, content, attributes = { source: 'bot' }, isPrivate = false) {
    const queue = capturedOutboundByUser.get(userId);
    if (!queue)
        return;
    const trimmed = String(content || '').trim();
    if (!trimmed)
        return;
    const normalized = normalizeForOutboundDedupe(trimmed);
    const last = queue[queue.length - 1];
    if (last && normalizeForOutboundDedupe(last.content) === normalized)
        return;
    queue.push({ content: trimmed, attributes, isPrivate });
}
function rememberRecentOutboundContent(userId, content) {
    const trimmed = String(content || '').trim();
    if (!trimmed)
        return;
    const now = Date.now();
    const hash = normalizeForOutboundDedupe(trimmed);
    const recent = (recentOutboundContentByUser.get(userId) || [])
        .filter((entry) => now - entry.at <= RECENT_OUTBOUND_WINDOW_MS);
    recent.push({ at: now, hash });
    recentOutboundContentByUser.set(userId, recent);
}
function wasRecentlyMirroredByBot(userId, content, windowMs = RECENT_OUTBOUND_WINDOW_MS) {
    const trimmed = String(content || '').trim();
    if (!trimmed)
        return false;
    const now = Date.now();
    const hash = normalizeForOutboundDedupe(trimmed);
    const recent = (recentOutboundContentByUser.get(userId) || [])
        .filter((entry) => now - entry.at <= windowMs);
    if (recent.length === 0) {
        recentOutboundContentByUser.delete(userId);
        return false;
    }
    recentOutboundContentByUser.set(userId, recent);
    return recent.some((entry) => entry.hash === hash);
}
async function flushCapturedOutboundToChatwoot(from, userName, fallbackSummary) {
    const queue = capturedOutboundByUser.get(from) || [];
    clearOutboundCapture(from);
    if (queue.length === 0) {
        if (!fallbackSummary)
            return;
        await chatwoot_1.chatwootService.syncMessage(from, userName, fallbackSummary, 'outgoing', { source: 'bot', kind: 'deterministic_fallback' });
        return;
    }
    for (const msg of queue) {
        await chatwoot_1.chatwootService.syncMessage(from, userName, msg.content, 'outgoing', msg.attributes || { source: 'bot' }, !!msg.isPrivate);
    }
}
function parseReservationDetails(text) {
    const raw = String(text || '').trim();
    const t = raw.toLowerCase();
    const tNoAccent = t
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    const updates = {};
    const peopleMatch = tNoAccent.match(/\b(\d+)\s*(pessoa|pessoas|adulto|adultos)\b/) ||
        tNoAccent.match(/\b(pessoas?|adultos?)\s*[:\-]?\s*(\d+)\b/);
    if (peopleMatch) {
        const val = parseInt((peopleMatch[1] || peopleMatch[2] || '0'), 10);
        if (!Number.isNaN(val) && val > 0)
            updates.people = val;
    }
    if (/sem\s+crian/.test(tNoAccent) ||
        /\b0\s*crian/.test(tNoAccent) ||
        /\bnao\s+(tera|vai\s+ter|tem)\s+crian/.test(tNoAccent) ||
        /\bnenhuma\s+crian/.test(tNoAccent)) {
        updates.kids = 0;
    }
    else {
        const kidsMatch = tNoAccent.match(/\b(\d+)\s*(crianca|criancas)\b/);
        if (kidsMatch) {
            const k = parseInt(kidsMatch[1], 10);
            if (!Number.isNaN(k) && k >= 0)
                updates.kids = k;
        }
    }
    const today = new Date();
    if (/\bhoje\b/.test(tNoAccent)) {
        updates.date_text = toIsoDate(today);
    }
    else if (/\bamanh/.test(tNoAccent)) {
        const d = new Date(today);
        d.setDate(d.getDate() + 1);
        updates.date_text = toIsoDate(d);
    }
    else {
        const weekdayMap = [
            { rx: /\b(domingo)\b/, day: 0 },
            { rx: /\b(segunda|segunda-feira)\b/, day: 1 },
            { rx: /\b(terca|terça|terca-feira|terça-feira)\b/, day: 2 },
            { rx: /\b(quarta|quarta-feira)\b/, day: 3 },
            { rx: /\b(quinta|quinta-feira)\b/, day: 4 },
            { rx: /\b(sexta|sexta-feira)\b/, day: 5 },
            { rx: /\b(sabado|sábado)\b/, day: 6 }
        ];
        const byWeekday = weekdayMap.find((w) => w.rx.test(tNoAccent));
        if (byWeekday) {
            updates.date_text = toIsoDate(nextWeekdayDate(byWeekday.day, today));
        }
    }
    if (!updates.date_text) {
        const dmY = tNoAccent.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
        if (dmY) {
            const day = parseInt(dmY[1], 10);
            const mon = parseInt(dmY[2], 10);
            let year = dmY[3] ? parseInt(dmY[3], 10) : today.getFullYear();
            if (year < 100)
                year += 2000;
            if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
                updates.date_text = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
            }
        }
    }
    if (!updates.date_text) {
        const dayOnly = tNoAccent.match(/\b(?:proximo)?\s*dia\s*(\d{1,2})\b/);
        if (dayOnly) {
            const day = parseInt(dayOnly[1], 10);
            const date = nextDayOfMonthDate(day, today);
            if (date)
                updates.date_text = toIsoDate(date);
        }
    }
    let hh = null;
    let mm = '00';
    if (/\bmeio\s*dia\b/.test(tNoAccent)) {
        hh = '12';
    }
    else if (/\bmeia\s*noite\b/.test(tNoAccent)) {
        hh = '00';
    }
    const hm = tNoAccent.match(/\b(\d{1,2})[:h](\d{2})\b/);
    if (!hh && hm) {
        hh = hm[1];
        mm = hm[2];
    }
    else {
        const hOnly = tNoAccent.match(/\b(\d{1,2})\s*(h|hr|hrs|hora|horas)\b/);
        if (!hh && hOnly)
            hh = hOnly[1];
        else {
            const hWord = tNoAccent.match(/\b(?:as)\s*(\d{1,2})\b/);
            if (!hh && hWord && /(noite|tarde|manha)/.test(tNoAccent))
                hh = hWord[1];
        }
    }
    if (hh !== null) {
        let h = parseInt(hh, 10);
        if (/noite|tarde/.test(tNoAccent) && h >= 1 && h <= 11)
            h += 12;
        if (h >= 0 && h <= 23)
            updates.time_text = `${String(h).padStart(2, '0')}:${mm}`;
    }
    const noteMarkers = [
        'obs', 'observa', 'anivers', 'janela', 'parquinho', 'perto do parquinho',
        'cadeira de bebe', 'cadeirinha', 'cadeirante', 'acessivel', 'acessível',
        'alerg', 'intoler', 'sem gluten', 'sem glúten', 'vegano', 'vegetar'
    ];
    const hasNoteMarker = noteMarkers.some((m) => tNoAccent.includes(m));
    const onlyKidsAnswer = /^(\s*(sem crian|nao|nenhuma|0)\s*)+$/.test(tNoAccent);
    if (hasNoteMarker && !onlyKidsAnswer) {
        updates.notes = raw.replace(/\s+/g, ' ').trim();
    }
    return updates;
}
function extractStandalonePeople(text) {
    const t = String(text || '').toLowerCase().trim();
    if (!t)
        return null;
    // Never infer adults from kids-only messages.
    if (/\bcrian/.test(t) && !/\b(adulto|adultos|pessoa|pessoas)\b/.test(t))
        return null;
    // Accept first number when it starts the sentence, e.g. "4 para amanhã às 11".
    const m = t.match(/^(?:sao|são)?\s*(\d{1,2})\b/);
    if (!m)
        return null;
    const n = parseInt(m[1], 10);
    if (Number.isNaN(n) || n <= 0 || n > 30)
        return null;
    return n;
}
function extractPartyDeltas(text) {
    const t = String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    if (!t)
        return null;
    let adultsDelta = 0;
    let kidsDelta = 0;
    // Casais sempre contam como adultos.
    if (/\bmais\s+(um|1)\s+casal\b/.test(t))
        adultsDelta += 2;
    if (/\bmenos\s+(um|1)\s+casal\b/.test(t))
        adultsDelta -= 2;
    const casaisMais = t.match(/\bmais\s+(\d+)\s+casais\b/);
    if (casaisMais)
        adultsDelta += Number(casaisMais[1]) * 2;
    const casaisMenos = t.match(/\bmenos\s+(\d+)\s+casais\b/);
    if (casaisMenos)
        adultsDelta -= Number(casaisMenos[1]) * 2;
    const plusAdults = [...t.matchAll(/\bmais\s+(\d+|um|uma)\s+(adulto|adultos|pessoa|pessoas)\b/g)];
    for (const m of plusAdults)
        adultsDelta += (m[1] === 'um' || m[1] === 'uma') ? 1 : Number(m[1]);
    const minusAdults = [...t.matchAll(/\bmenos\s+(\d+|um|uma)\s+(adulto|adultos|pessoa|pessoas)\b/g)];
    for (const m of minusAdults)
        adultsDelta -= (m[1] === 'um' || m[1] === 'uma') ? 1 : Number(m[1]);
    const plusKids = [...t.matchAll(/\bmais\s+(\d+|uma|um)\s+(crianca|criancas)\b/g)];
    for (const m of plusKids)
        kidsDelta += (m[1] === 'um' || m[1] === 'uma') ? 1 : Number(m[1]);
    const minusKids = [...t.matchAll(/\bmenos\s+(\d+|uma|um)\s+(crianca|criancas)\b/g)];
    for (const m of minusKids)
        kidsDelta -= (m[1] === 'um' || m[1] === 'uma') ? 1 : Number(m[1]);
    if (!adultsDelta && !kidsDelta)
        return null;
    return { adultsDelta, kidsDelta };
}
function sanitizeWhatsAppText(text) {
    if (!text)
        return text;
    return text
        .replace(/\*\*/g, '*')
        .replace(/```/g, '')
        .replace(/\s*\(\d{4}-\d{2}-\d{2}\)/g, '')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$2')
        .replace(/^[#{1,6}]\s+/gm, '')
        .trim();
}
function formatIncomingForChatwoot(message, normalizedText) {
    const commandLabel = CHATWOOT_COMMAND_LABELS[normalizedText];
    if (commandLabel)
        return `[INTERACAO] ${commandLabel}`;
    if (message?.type === 'interactive') {
        const title = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title;
        const id = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
        if (title && id && title !== id)
            return `[INTERACAO] ${title} (${id})`;
        if (title)
            return `[INTERACAO] ${title}`;
        if (id)
            return `[INTERACAO] ${id}`;
    }
    if (normalizedText.startsWith('alter_pick_'))
        return '[INTERACAO] Selecionou reserva para alteracao';
    if (normalizedText.startsWith('cancel_pick_'))
        return '[INTERACAO] Selecionou reserva para cancelamento';
    if (normalizedText.startsWith('cancel_yes_'))
        return '[INTERACAO] Confirmou cancelamento da reserva';
    return normalizedText;
}
function buildDeterministicSyncMessage(normalizedText, state) {
    const label = CHATWOOT_COMMAND_LABELS[normalizedText];
    if (label)
        return `[BOT] ${label}`;
    if (normalizedText.startsWith('alter_pick_'))
        return '[BOT] Iniciou fluxo de alteracao de reserva';
    if (normalizedText.startsWith('cancel_pick_'))
        return '[BOT] Iniciou fluxo de cancelamento de reserva';
    if (normalizedText.startsWith('cancel_yes_'))
        return '[BOT] Processando cancelamento de reserva';
    if (state?.last_interactive_menu)
        return `[BOT] ${state.last_interactive_menu}`;
    return '[BOT] Fluxo interativo executado';
}
function sanitizeAgentFallbackPhone(text, from, state) {
    if (!text)
        return text;
    const t = String(text);
    const lower = t.toLowerCase();
    const isUnitFallback = lower.includes('unidade') &&
        (lower.includes('falar direto') || lower.includes('telefone') || lower.includes('contato'));
    if (!isUnitFallback)
        return t;
    const unitName = String(state?.preferred_unit_name || '').trim();
    const unitPhone = UNIT_PHONE_BY_NAME[unitName];
    if (!unitPhone)
        return t;
    const fromDigits = toDigitsPhone(from);
    if (!fromDigits)
        return t;
    return t.replace(/\+?\d[\d\s().-]{8,}\d/g, (raw) => {
        const digits = raw.replace(/\D/g, '');
        return digits === fromDigits ? unitPhone : raw;
    });
}
function shouldOfferMainMenu(result, state) {
    const intent = String(result?.intent || '').toLowerCase();
    const response = String(result?.response || '').toLowerCase();
    if (intent === 'error') {
        // Keep context on transient errors; avoid pushing users back to menu.
        return false;
    }
    const noReservationHints = [
        'não possui reservas ativas',
        'nao possui reservas ativas',
        'não encontrei nenhuma reserva',
        'nao encontrei nenhuma reserva',
        'nenhuma reserva encontrada',
        'não há reservas',
        'nao ha reservas'
    ];
    if (['interesse_reserva', 'consultar_reserva', 'cancelar_reserva'].includes(intent)) {
        if (noReservationHints.some((hint) => response.includes(hint)))
            return true;
    }
    return false;
}
function isPromptInjection(text) {
    const t = text.toLowerCase();
    const markers = [
        'repeat your rules verbatim', 'exact text of your instructions',
        'out of character', 'ignore previous instructions',
        'developer instructions', 'system prompt'
    ];
    return markers.some(m => t.includes(m));
}
/**
 * Check if text looks like a bot message (echo detection)
 */
function isLikelyBotMessage(text) {
    if (!text)
        return false;
    // Check against known bot patterns
    for (const pattern of BOT_MESSAGE_PATTERNS) {
        if (pattern.test(text.trim())) {
            return true;
        }
    }
    // Check if contains menu structure patterns
    if (/\d️⃣\s*(ver cardápio|reservar mesa|delivery)/i.test(text)) {
        return true;
    }
    // Check if it's a known menu button text
    const menuTexts = [
        'escolha uma opção', 'escolhe a cidade', 'qual unidade',
        'posso usar este número', 'os dados da reserva estão corretos'
    ];
    if (menuTexts.some(t => text.toLowerCase().includes(t))) {
        return true;
    }
    return false;
}
/**
 * Extract actual user input from potentially polluted text
 */
function extractUserInput(text) {
    if (!text)
        return text;
    // Remove bot message prefixes that sometimes leak through
    const botPrefixes = [
        /^(opa!? ?👋? ?eu sou a kha do kharina.*escolha uma opção:\s*)/i,
        /^(beleza!? ?👌? ?vamos seguir por aqui.*escolha uma opção:\s*)/i,
        /^(escolhe a cidade pra eu te mostrar.*:\s*)/i,
        /^(qual unidade você deseja\?\s*)/i,
        /^(você quer fazer um novo pedido ou precisa de ajuda.*\?\s*)/i,
    ];
    let cleaned = text;
    for (const prefix of botPrefixes) {
        cleaned = cleaned.replace(prefix, '');
    }
    // Extract just the button ID if the whole menu text came through
    const buttonMatch = cleaned.match(/^(\d️⃣\s*[^\n]+)/);
    if (buttonMatch) {
        return buttonMatch[1].trim();
    }
    return cleaned.trim();
}
async function ensureReservasMcpReady() {
    if (reservasMcp.ready)
        return true;
    if (!reservasMcpInitPromise) {
        reservasMcp.connect();
        reservasMcpInitPromise = reservasMcp.waitReady(20000).finally(() => {
            reservasMcpInitPromise = null;
        });
    }
    return reservasMcpInitPromise;
}
function toDigitsPhone(raw) {
    return String(raw || '').replace(/\D/g, '');
}
function parseMcpToolText(result) {
    try {
        const text = result?.content?.[0]?.text;
        if (typeof text === 'string' && text.trim())
            return JSON.parse(text);
    }
    catch { }
    return result;
}
function normalizeIsoDate(value) {
    const v = String(value || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(v))
        return v;
    const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (m)
        return `${m[3]}-${m[2]}-${m[1]}`;
    return v;
}
function normalizeTime(value) {
    const v = String(value || '').trim();
    const m = v.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
    if (!m)
        return v;
    return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}
function pickReservationCode(res) {
    const payload = parseMcpToolText(res);
    if (!payload || typeof payload !== 'object')
        return {};
    return {
        id: payload.reservationId || payload.id || payload.data?.id,
        code: payload.code || payload.reservationCode || payload.confirmationCode || payload.data?.code || payload.data?.confirmationCode,
        status: payload.status || payload.data?.status
    };
}
function displayReservationCode(picked) {
    if (picked.code && String(picked.code).trim())
        return String(picked.code).trim().toUpperCase();
    if (picked.id && String(picked.id).trim())
        return String(picked.id).trim().split('-')[0].toUpperCase();
    return undefined;
}
function buildReservationIdentifierLines(picked) {
    const code = picked.code && String(picked.code).trim()
        ? String(picked.code).trim().toUpperCase()
        : undefined;
    const id = picked.id && String(picked.id).trim()
        ? String(picked.id).trim()
        : undefined;
    const fallback = !code && id ? String(id).split('-')[0].toUpperCase() : undefined;
    return [
        code ? `🔢 Código da reserva: ${code}` : '',
        id ? `🆔 ID da reserva: ${id}` : '',
        !code && fallback ? `🔎 Referência rápida: ${fallback}` : ''
    ].filter(Boolean);
}
function statusLabel(raw) {
    const v = String(raw || '').toLowerCase();
    const map = {
        confirmed: 'Confirmada',
        waiting: 'Em espera',
        cancelled: 'Cancelada',
        canceled: 'Cancelada'
    };
    return map[v] || String(raw || '');
}
function statusEmoji(raw) {
    const v = String(raw || '').toLowerCase();
    if (v === 'cancelled' || v === 'canceled')
        return '❌';
    if (v === 'waiting' || v === 'pending')
        return '⏳';
    if (v === 'confirmed')
        return '✅';
    return 'ℹ️';
}
function weekdayKeyFromText(text) {
    const t = String(text || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    if (/\b(segunda|segunda-feira)\b/.test(t))
        return 'monday';
    if (/\b(terca|terca-feira)\b/.test(t))
        return 'tuesday';
    if (/\b(quarta|quarta-feira)\b/.test(t))
        return 'wednesday';
    if (/\b(quinta|quinta-feira)\b/.test(t))
        return 'thursday';
    if (/\b(sexta|sexta-feira)\b/.test(t))
        return 'friday';
    if (/\b(sabado)\b/.test(t))
        return 'saturday';
    if (/\b(domingo)\b/.test(t))
        return 'sunday';
    return null;
}
function formatHourRange(open, close) {
    if (!open || !close)
        return '';
    return `${normalizeTime(open)} às ${normalizeTime(close)}`;
}
async function getStoresWithHours() {
    const cacheKey = 'reservas_stores';
    const cached = storesHoursCache.get(cacheKey);
    if (cached && (Date.now() - cached.at) < STORES_HOURS_CACHE_TTL_MS) {
        return cached.data;
    }
    const mcpReady = await ensureReservasMcpReady();
    if (!mcpReady)
        return [];
    const result = await callReservasToolWithTimeout('list_stores', {}, { timeoutMs: 15000, retries: 1, retryDelayMs: 600 });
    const payload = parseMcpToolText(result);
    const stores = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
    storesHoursCache.set(cacheKey, { data: stores, at: Date.now() });
    return stores;
}
async function answerStoreHours(from, state, text) {
    const weekday = weekdayKeyFromText(text);
    if (!state.preferred_store_id || !state.preferred_unit_name) {
        await sendWhatsAppText(from, 'Consigo te passar certinho, sim 😊 Me confirma primeiro a unidade (ex.: Batel, Cabral, Portão...) para eu consultar o horário correto.');
        await sendUnidadesMenu(from);
        return true;
    }
    try {
        const stores = await getStoresWithHours();
        const store = stores.find((s) => String(s?.id || '').toLowerCase() === String(state.preferred_store_id).toLowerCase());
        const op = store?.operationHours || {};
        if (!store || !op || typeof op !== 'object') {
            await sendWhatsAppText(from, `Não consegui consultar o horário da unidade ${state.preferred_unit_name} agora 😕 Pode tentar novamente em instantes?`);
            return true;
        }
        if (weekday) {
            const dayInfo = op[weekday];
            if (!dayInfo) {
                await sendWhatsAppText(from, `Não encontrei o horário dessa unidade para esse dia agora. Se quiser, te passo os horários gerais da unidade ${state.preferred_unit_name}.`);
                return true;
            }
            const range = formatHourRange(dayInfo.open, dayInfo.close);
            const isOpen = dayInfo.isOpen !== false;
            await sendWhatsAppText(from, isOpen
                ? `Na unidade ${state.preferred_unit_name}, nesse dia, o horário é ${range}. 🍽️`
                : `Na unidade ${state.preferred_unit_name}, ela não abre nesse dia.`);
            return true;
        }
        const weekOrder = [
            ['monday', 'Segunda'],
            ['tuesday', 'Terça'],
            ['wednesday', 'Quarta'],
            ['thursday', 'Quinta'],
            ['friday', 'Sexta'],
            ['saturday', 'Sábado'],
            ['sunday', 'Domingo']
        ];
        const lines = [`Horários da unidade ${state.preferred_unit_name}:`];
        for (const [k, label] of weekOrder) {
            const d = op[k];
            if (!d)
                continue;
            if (d.isOpen === false) {
                lines.push(`- ${label}: fechada`);
            }
            else {
                lines.push(`- ${label}: ${formatHourRange(d.open, d.close)}`);
            }
        }
        await sendWhatsAppText(from, lines.join('\n'));
        return true;
    }
    catch (err) {
        console.error('[HoursDeterministic] failed:', err?.message || err);
        await sendWhatsAppText(from, `Não consegui consultar o horário da unidade ${state.preferred_unit_name} agora 😕 Pode tentar novamente em instantes?`);
        return true;
    }
}
async function buildCardapioMessage(cardapioCommand) {
    const city = cardapioCommand.replace('cardapio_', '');
    const baseMap = {
        curitiba: 'https://cardapio.kharina.com.br/curitiba',
        londrina: 'https://cardapio.kharina.com.br/londrina',
        saopaulo: 'https://cardapio.kharina.com.br/saopaulo'
    };
    const cityLabelMap = {
        curitiba: 'Curitiba',
        londrina: 'Londrina',
        saopaulo: 'São Paulo'
    };
    const dynamic = await db_1.db.getConfig(`link_cardapio_${city}`);
    const legacySp = city === 'saopaulo' ? await db_1.db.getConfig('link_cardapio_sp') : null;
    const url = dynamic || legacySp || baseMap[city] || 'https://cardapio.kharina.com.br/';
    return `Perfeito! Aqui está o cardápio de ${cityLabelMap[city] || city} 🍽️\n👉 ${url}`;
}
async function buildKidsInfoMessage() {
    const base = await db_1.db.getConfig('kids_info_content');
    const configs = await db_1.db.listConfigs();
    const kidsInstagram = configs.filter((c) => String(c.key || '').startsWith('kids_instagram_'));
    const links = kidsInstagram
        .map((c) => {
        const unitRaw = String(c.key).replace('kids_instagram_', '');
        const unit = unitRaw
            .replace(/_/g, ' ')
            .replace(/\b\w/g, (ch) => ch.toUpperCase());
        return `- ${unit}: ${c.value}`;
    })
        .join('\n');
    const content = base || 'Hoje não consegui carregar as informações do Espaço Kids. Pode me chamar novamente em instantes?';
    if (!links)
        return content;
    return `${content}\n\n📸 Instagram do Espaço Kids por unidade:\n${links}`;
}
function extractReservationsList(payload) {
    if (!payload)
        return [];
    if (Array.isArray(payload?.reservations))
        return payload.reservations;
    if (Array.isArray(payload?.data?.reservations))
        return payload.data.reservations;
    if (Array.isArray(payload?.data))
        return payload.data;
    return [];
}
async function callReservasToolWithTimeout(tool, args, opts) {
    const timeoutMs = opts?.timeoutMs ?? 15000;
    const retries = opts?.retries ?? 0;
    const retryDelayMs = opts?.retryDelayMs ?? 500;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Serialize Reservas MCP calls to avoid session contention and timeout cascades.
            const previous = reservasCallQueue.catch(() => { });
            let releaseQueue;
            reservasCallQueue = new Promise((resolve) => { releaseQueue = resolve; });
            await previous;
            try {
                return await Promise.race([
                    reservasMcp.callTool(tool, args),
                    new Promise((_, reject) => setTimeout(() => reject(new Error(`${tool} timeout`)), timeoutMs))
                ]);
            }
            finally {
                releaseQueue?.();
            }
        }
        catch (err) {
            lastErr = err;
            if (attempt < retries)
                await new Promise((r) => setTimeout(r, retryDelayMs));
        }
    }
    throw lastErr;
}
async function fetchActiveReservations(phoneRaw) {
    const phone = toDigitsPhone(phoneRaw);
    const mcpReady = await ensureReservasMcpReady();
    if (!mcpReady)
        return [];
    const result = await callReservasToolWithTimeout('query_reservations', { clientPhone: phone }, { timeoutMs: 15000, retries: 1, retryDelayMs: 600 });
    const payload = parseMcpToolText(result);
    const all = extractReservationsList(payload);
    return all
        .filter((x) => !String(x?.status || '').toLowerCase().includes('cancel'))
        .map((x) => ({
        reservationId: String(x?.reservationId || x?.id || ''),
        code: displayReservationCode({ id: x?.reservationId || x?.id, code: x?.code || x?.reservationCode || x?.confirmationCode }) || 'N/A',
        storeId: String(x?.storeId || ''),
        storeName: String(x?.storeName || x?.store || 'N/A'),
        date: String(x?.date || ''),
        time: normalizeTime(String(x?.time || '')),
        people: Number(x?.numberOfPeople ?? x?.people ?? 0),
        kids: x?.kids !== undefined && x?.kids !== null ? Number(x.kids) : undefined,
        status: statusLabel(x?.status)
    }))
        .filter((x) => x.reservationId);
}
async function fetchActiveReservationsWithRetry(phoneRaw) {
    try {
        return await fetchActiveReservations(phoneRaw);
    }
    catch (err1) {
        console.error('[ReservasDeterministic] fetch active reservations failed (attempt 1):', err1?.message || err1);
        await new Promise((r) => setTimeout(r, 500));
        try {
            return await fetchActiveReservations(phoneRaw);
        }
        catch (err2) {
            console.error('[ReservasDeterministic] fetch active reservations failed (attempt 2):', err2?.message || err2);
            return [];
        }
    }
}
async function findReservationMatchWithId(input) {
    const verifyResult = await callReservasToolWithTimeout('query_reservations', { clientPhone: input.phone }, { timeoutMs: 12000, retries: 0 });
    const verifyPayload = parseMcpToolText(verifyResult);
    const items = extractReservationsList(verifyPayload);
    const matched = items.find((x) => normalizeIsoDate(x?.date) === input.date &&
        normalizeTime(x?.time) === input.time &&
        Number(x?.numberOfPeople || x?.people) === input.people &&
        String(x?.storeId || '').toLowerCase() === String(input.storeId).toLowerCase() &&
        !String(x?.status || '').toLowerCase().includes('cancel'));
    if (!matched)
        return null;
    const id = matched.reservationId || matched.id;
    if (!id)
        return null;
    return {
        id,
        code: matched.code || matched.reservationCode || matched.confirmationCode,
        status: matched.status
    };
}
async function waitForReservationMatchWithId(input, attempts = 6, intervalMs = 1500) {
    for (let i = 0; i < attempts; i++) {
        try {
            const hit = await findReservationMatchWithId(input);
            if (hit?.id)
                return hit;
        }
        catch (err) {
            console.error('[ReservasDeterministic] wait match attempt failed:', err?.message || err);
        }
        if (i < attempts - 1)
            await new Promise((r) => setTimeout(r, intervalMs));
    }
    return null;
}
async function sendManageReservationMenu(to, action, reservations) {
    const title = action === 'cancel' ? 'Qual reserva você quer cancelar?' : 'Qual reserva você quer alterar?';
    const rows = reservations.slice(0, 10).map((r, i) => ({
        id: `${action}_pick_${r.reservationId}`,
        title: `${i + 1}. ${r.code}`,
        description: `${toBrDate(r.date)} ${r.time} • ${r.storeName}`
    }));
    const payload = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
            type: "list",
            body: { text: title },
            action: { button: "Ver reservas", sections: [{ title: "Reservas ativas", rows }] }
        }
    };
    await sendInteractiveWithFallback(to, payload, action === 'cancel' ? 'send_cancel_pick_menu' : 'send_alter_pick_menu', `${title}\n` + reservations.map((r, i) => `${i + 1}. ${r.code} - ${toBrDate(r.date)} ${r.time} (${r.storeName})`).join('\n'));
}
async function beginAlterReservationFlow(from, state, selected, initialText) {
    state.preferred_store_id = selected.storeId || state.preferred_store_id;
    state.preferred_unit_name = selected.storeName || state.preferred_unit_name;
    state.reservation = {
        ...(state.reservation || {}),
        phone_confirmed: true,
        contact_phone: from,
        date_text: selected.date || state.reservation?.date_text,
        time_text: selected.time || state.reservation?.time_text,
        kids: selected.kids ?? state.reservation?.kids,
        people: selected.kids !== undefined
            ? Math.max(0, selected.people - Number(selected.kids || 0))
            : (state.reservation?.people ?? selected.people),
        pending_change_source_id: selected.reservationId,
        pending_change_source_code: selected.code,
        awaiting_confirmation: false
    };
    const incoming = String(initialText || '').trim();
    if (incoming) {
        const extracted = parseReservationDetails(incoming);
        const deltas = extractPartyDeltas(incoming);
        if (deltas) {
            if (deltas.adultsDelta !== 0 && state.reservation.people !== undefined && extracted.people === undefined) {
                extracted.people = Math.max(1, Number(state.reservation.people) + deltas.adultsDelta);
            }
            if (deltas.kidsDelta !== 0 && state.reservation.kids !== undefined && extracted.kids === undefined) {
                extracted.kids = Math.max(0, Number(state.reservation.kids) + deltas.kidsDelta);
            }
        }
        if (Object.keys(extracted).length > 0) {
            state.reservation = { ...(state.reservation || {}), ...extracted };
        }
    }
    userStates.set(from, state);
    const missing = [];
    if (!state.reservation?.people)
        missing.push('o número de adultos');
    if (!state.reservation?.date_text)
        missing.push('a data');
    if (!state.reservation?.time_text)
        missing.push('o horário');
    if (state.reservation?.kids === undefined)
        missing.push('se terá crianças (e quantas)');
    if (missing.length === 0) {
        await sendWhatsAppText(from, `Perfeito! ✅ Atualizei a reserva ${selected.code} com os dados que você mandou.`);
        await sendReservationConfirmationOrBlock(from, state);
        return;
    }
    await sendWhatsAppText(from, `Perfeito! Vamos alterar a reserva ${selected.code}. Me confirma só ${missing.join(' e ')}.`);
}
async function queryReservationsDeterministic(from) {
    try {
        const phone = toDigitsPhone(from);
        const mcpReady = await ensureReservasMcpReady();
        if (!mcpReady) {
            return { ok: false, message: 'Tive uma instabilidade para consultar suas reservas agora 😕' };
        }
        const result = await callReservasToolWithTimeout('query_reservations', { clientPhone: phone }, { timeoutMs: 15000, retries: 1, retryDelayMs: 600 });
        const payload = parseMcpToolText(result);
        const all = extractReservationsList(payload);
        if (all.length === 0) {
            return { ok: true, message: 'Não encontrei reservas no seu número no momento.' };
        }
        const lines = ['Encontrei estas reservas no seu número:'];
        all.slice(0, 8).forEach((r, idx) => {
            const code = displayReservationCode({
                id: r?.reservationId || r?.id,
                code: r?.code || r?.reservationCode || r?.confirmationCode
            }) || 'N/A';
            lines.push(`${idx + 1}. 🔢 Código: ${code}\n` +
                `📍 Unidade: ${r?.storeName || r?.store || 'N/A'}\n` +
                `📅 Data: ${toBrDate(r?.date || '')}\n` +
                `⏰ Horário: ${normalizeTime(r?.time || '')}\n` +
                `👥 Total de pessoas: ${r?.numberOfPeople ?? r?.people ?? 'N/A'}\n` +
                `${statusEmoji(r?.status)} Status: ${statusLabel(r?.status)}`);
        });
        const hasActive = all.some((x) => !String(x?.status || '').toLowerCase().includes('cancel'));
        lines.push(hasActive
            ? 'Se quiser, eu também posso cancelar ou alterar uma reserva ativa.'
            : 'No momento, todas as reservas listadas estão canceladas.');
        return { ok: true, message: lines.join('\n\n') };
    }
    catch (err) {
        console.error('[ReservasDeterministic] query_reservations failed:', err?.message || err);
        return { ok: false, message: 'Não consegui consultar suas reservas agora. Pode tentar novamente em instantes?' };
    }
}
async function createReservationDeterministic(from, state) {
    const r = state.reservation || {};
    const storeId = state.preferred_store_id;
    const unitName = state.preferred_unit_name || 'unidade selecionada';
    const phone = toDigitsPhone(r.contact_phone || from);
    const date = normalizeIsoDate(r.date_text || '');
    const time = normalizeTime(r.time_text || '');
    const adults = Number(r.people || 0);
    const kids = Number(r.kids ?? 0);
    const totalPeople = adults + kids;
    const name = String(r.name || '').trim();
    const notes = String(r.notes || r.occasion || '').trim();
    if (!storeId || !phone || !date || !time || !adults) {
        return {
            ok: false,
            message: 'Faltaram alguns dados obrigatórios para concluir a reserva. Vamos revisar rapidinho pelo resumo. 🙏'
        };
    }
    const leadTimeViolation = getReservationLeadTimeViolation(date, time, unitName);
    if (leadTimeViolation) {
        if (state.reservation)
            state.reservation.awaiting_confirmation = false;
        userStates.set(from, state);
        return { ok: false, message: leadTimeViolation };
    }
    const block = await (0, reservationAdmin_1.findMatchingReservationBlock)({ storeId, date, time });
    if (block) {
        if (state.reservation)
            state.reservation.awaiting_confirmation = false;
        userStates.set(from, state);
        return {
            ok: false,
            message: buildReservationBlockCustomerMessage(block, unitName, date, time)
        };
    }
    const mcpReady = await ensureReservasMcpReady();
    if (!mcpReady) {
        return { ok: false, message: 'Tive uma instabilidade técnica para acessar o sistema de reservas agora.' };
    }
    const createArgs = {
        clientPhone: phone,
        storeId,
        date,
        time,
        numberOfPeople: totalPeople,
        kids,
        ...(notes ? { notes } : {})
    };
    try {
        // If client pressed confirm again, avoid duplicate creates and try to recover existing reservation first.
        const preExisting = await waitForReservationMatchWithId({ phone, storeId, date, time, people: totalPeople }, 2, 600);
        if (preExisting?.id) {
            const recoveredStatus = preExisting.status ? statusLabel(preExisting.status) : undefined;
            const recoveredLines = [
                `Reserva confirmada com sucesso na unidade ${unitName}! 🎉`,
                `📅 Data: ${toBrDate(date)}`,
                `⏰ Horário: ${time}`,
                `👨 Adultos: ${adults}`,
                `👶 Crianças: ${kids}`,
                `👥 Total: ${totalPeople}`,
                ...buildReservationIdentifierLines(preExisting),
                recoveredStatus ? `${statusEmoji(preExisting.status)} Status: ${recoveredStatus}` : ''
            ].filter(Boolean);
            state.reservation = undefined;
            userStates.set(from, state);
            return { ok: true, message: recoveredLines.join('\n') };
        }
        let createResult;
        try {
            createResult = await callReservasToolWithTimeout('create_reservation', createArgs, { timeoutMs: 20000, retries: 1, retryDelayMs: 700 });
        }
        catch (err) {
            const msg = String(err?.message || '').toLowerCase();
            if (msg.includes('client') || msg.includes('cliente') || msg.includes('not found') || msg.includes('não encontrado')) {
                if (name) {
                    await callReservasToolWithTimeout('create_client', { name, phone }, { timeoutMs: 12000, retries: 1 });
                    createResult = await callReservasToolWithTimeout('create_reservation', createArgs, { timeoutMs: 20000, retries: 1, retryDelayMs: 700 });
                }
                else {
                    throw err;
                }
            }
            else {
                throw err;
            }
        }
        let picked = pickReservationCode(createResult);
        // Poll verification for eventual consistency in Reservas API.
        const matched = await waitForReservationMatchWithId({ phone, storeId, date, time, people: totalPeople }, 8, 1500);
        if (matched) {
            picked = {
                id: matched.id || picked.id,
                code: matched.code || picked.code,
                status: matched.status || picked.status
            };
        }
        if (!picked.id) {
            // Second-chance path: try to self-heal before failing customer flow.
            try {
                if (name) {
                    // Defensive upsert-like attempt (ignore "already exists" style errors).
                    await callReservasToolWithTimeout('create_client', { name, phone }, { timeoutMs: 12000, retries: 1, retryDelayMs: 400 }).catch(() => undefined);
                }
                const retryCreateResult = await callReservasToolWithTimeout('create_reservation', createArgs, { timeoutMs: 25000, retries: 1, retryDelayMs: 900 });
                let retryPicked = pickReservationCode(retryCreateResult);
                // Longer polling window to handle eventual consistency on MCP/Reservas.
                const retryMatched = await waitForReservationMatchWithId({ phone, storeId, date, time, people: totalPeople }, 12, 2000);
                if (retryMatched) {
                    retryPicked = {
                        id: retryMatched.id || retryPicked.id,
                        code: retryMatched.code || retryPicked.code,
                        status: retryMatched.status || retryPicked.status
                    };
                }
                if (retryPicked.id) {
                    picked = retryPicked;
                }
            }
            catch (retryErr) {
                console.error('[ReservasDeterministic] second-chance create failed:', retryErr?.message || retryErr);
            }
        }
        if (!picked.id) {
            const alertMsg = [
                'ALERTA RESERVA: criação sem ID confirmado.',
                `Telefone: +${phone}`,
                `Unidade: ${unitName} (${storeId})`,
                `Data/Hora: ${date} ${time}`,
                `Adultos: ${adults}`,
                `Crianças: ${kids}`,
                `Total: ${totalPeople}`,
                `Nome: ${name || 'N/A'}`,
                notes ? `Obs: ${notes}` : '',
                'Ação: validar no MCP/Reservas e retornar ao cliente.'
            ].filter(Boolean).join('\n');
            chatwoot_1.chatwootService.syncMessage(from, name || from, alertMsg, 'outgoing', { source: 'system', kind: 'reservation_alert', reason: 'missing_reservation_id' }, true).catch((err) => {
                console.error('[Chatwoot] reservation alert failed:', err?.message || err);
            });
            return {
                ok: false,
                message: 'Tive uma instabilidade para confirmar sua reserva com segurança agora 😕\nPor favor, tente novamente em alguns minutos. Se preferir, nosso time já foi alertado para verificar por aqui.'
            };
        }
        const status = picked.status ? statusLabel(picked.status) : undefined;
        const previousReservationId = String(r.pending_change_source_id || '').trim();
        const previousReservationCode = String(r.pending_change_source_code || '').trim();
        if (previousReservationId) {
            try {
                await callReservasToolWithTimeout('cancel_reservation', {
                    reservationId: previousReservationId,
                    reason: 'Alteração solicitada pelo cliente via WhatsApp'
                }, { timeoutMs: 15000, retries: 1, retryDelayMs: 500 });
            }
            catch (cancelErr) {
                console.error('[ReservasDeterministic] cancel old reservation after alter failed:', cancelErr?.message || cancelErr);
            }
        }
        const lines = [
            `Reserva confirmada com sucesso! 🎉`,
            `Nos vemos dia ${toBrDate(date)} às ${time}h na unidade ${unitName}! 🧡`,
            '',
            ...buildReservationIdentifierLines(picked),
            '',
            '⏰ Lembre-se:',
            '',
            'Procure chegar 10 minutos antes',
            'Você tem 10 minutos de tolerância',
            'Depois disso, a reserva é cancelada automaticamente ❤️'
        ].filter(line => line !== '');
        state.reservation = undefined;
        userStates.set(from, state);
        return { ok: true, message: lines.join('\n') };
    }
    catch (err) {
        console.error('[ReservasDeterministic] create_reservation failed:', err?.message || err);
        // Last-chance recovery for timeout/transport failures:
        // check if reservation was created but MCP response was lost.
        try {
            const recovered = await waitForReservationMatchWithId({ phone, storeId, date, time, people: totalPeople }, 6, 2000);
            if (recovered?.id) {
                const recoveredStatus = recovered.status ? statusLabel(recovered.status) : undefined;
                const recoveredLines = [
                    `Reserva confirmada com sucesso! 🎉`,
                    `Nos vemos dia ${toBrDate(date)} às ${time}h na unidade ${unitName}! 🧡`,
                    '',
                    ...buildReservationIdentifierLines(recovered),
                    '',
                    '⏰ Lembre-se:',
                    '',
                    'Procure chegar 10 minutos antes',
                    'Você tem 10 minutos de tolerância',
                    'Depois disso, a reserva é cancelada automaticamente ❤️'
                ].filter(line => line !== '');
                state.reservation = undefined;
                userStates.set(from, state);
                return { ok: true, message: recoveredLines.join('\n') };
            }
        }
        catch (recoverErr) {
            console.error('[ReservasDeterministic] post-error recovery failed:', recoverErr?.message || recoverErr);
        }
        const rr = state.reservation || {};
        const alertMsg = [
            'ALERTA RESERVA: falha técnica na criação.',
            `Telefone: +${toDigitsPhone(rr.contact_phone || from)}`,
            `Unidade: ${state.preferred_unit_name || 'N/A'} (${state.preferred_store_id || 'N/A'})`,
            `Data/Hora: ${normalizeIsoDate(rr.date_text || '') || 'N/A'} ${normalizeTime(rr.time_text || '') || ''}`.trim(),
            `Adultos: ${rr.people ?? 'N/A'}`,
            `Crianças: ${rr.kids ?? 'N/A'}`,
            `Total: ${(Number(rr.people || 0) + Number(rr.kids ?? 0))}`,
            `Nome: ${rr.name || from}`,
            `Erro: ${String(err?.message || err || 'unknown')}`,
            'Ação: verificar no MCP/Reservas e acompanhar cliente.'
        ].join('\n');
        chatwoot_1.chatwootService.syncMessage(from, rr.name || from, alertMsg, 'outgoing', { source: 'system', kind: 'reservation_alert', reason: 'create_reservation_exception' }, true).catch((cwErr) => {
            console.error('[Chatwoot] reservation alert failed:', cwErr?.message || cwErr);
        });
        if (state.reservation)
            state.reservation.awaiting_confirmation = true;
        userStates.set(from, state);
        return {
            ok: false,
            message: 'Tive uma instabilidade para concluir sua reserva agora 😕\nPor favor, tente novamente em alguns minutos. Nosso time também foi alertado para verificar.'
        };
    }
}
// ============ Graph API Helpers ============
async function postGraphMessage(payload, label, retries = 2) {
    let lastErr = null;
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const httpsAgent = proxyUrl ? new socks_proxy_agent_1.SocksProxyAgent(proxyUrl) : undefined;
    const axiosConfig = {
        headers: { Authorization: `Bearer ${env_1.config.whatsapp.token}` },
        timeout: GRAPH_API_TIMEOUT_MS
    };
    if (proxyUrl) {
        axiosConfig.httpsAgent = httpsAgent;
        axiosConfig.proxy = false;
    }
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const resp = await axios_1.default.post(`https://graph.facebook.com/v24.0/${env_1.config.whatsapp.phoneId}/messages`, payload, axiosConfig);
            const graphMsgId = resp?.data?.messages?.[0]?.id;
            if (graphMsgId) {
                console.log(`[WhatsApp] ${label} Graph message id: ${graphMsgId}`);
            }
            return;
        }
        catch (err) {
            lastErr = err;
            console.error(`[WhatsApp] ${label} failed (attempt ${attempt + 1}/${retries + 1}):`, err.message);
            if (attempt === retries)
                break;
            await new Promise(r => setTimeout(r, attempt === 0 ? 300 : 800));
        }
    }
    throw lastErr;
}
async function sendWhatsAppText(to, text) {
    const normalized = normalizeForOutboundDedupe(text);
    const now = Date.now();
    const DEDUPE_WINDOW_MS = 30_000;
    const last = lastOutboundByUser.get(to);
    // Deduplication check
    if (last && last.hash === normalized && now - last.at <= DEDUPE_WINDOW_MS) {
        console.log(`[WhatsApp] Deduplicated message to ${to}: "${text.substring(0, 50)}..."`);
        return;
    }
    await postGraphMessage({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text }
    }, 'send_text', 2);
    lastOutboundByUser.set(to, { hash: normalized, at: now });
    rememberRecentOutboundContent(to, text);
    captureOutboundMessage(to, text, { source: 'bot', kind: 'whatsapp_text' });
    console.log(`[WhatsApp] Sent to ${to}: "${text.substring(0, 80)}..."`);
}
async function sendWhatsAppSticker(to, stickerMediaIdOrLink) {
    const value = String(stickerMediaIdOrLink || '').trim();
    if (!value)
        return;
    const sticker = value.startsWith('http://') || value.startsWith('https://')
        ? { link: value }
        : { id: value };
    try {
        await postGraphMessage({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to,
            type: 'sticker',
            sticker
        }, 'send_sticker', 1);
        console.log(`[WhatsApp] Sticker sent to ${to}`);
    }
    catch (err) {
        console.error('[WhatsApp] Failed to send sticker:', err?.message || err);
    }
}
async function sendTypingIndicator(to, messageId) {
    try {
        await postGraphMessage({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            status: "read",
            message_id: messageId,
            typing_indicator: { type: "text" }
        }, 'send_typing', 1);
    }
    catch { }
}
async function sendInteractiveWithFallback(to, menuPayload, label, fallbackText) {
    const now = Date.now();
    const degradedUntil = interactiveDegradedUntil.get(to) || 0;
    if (degradedUntil > now) {
        if (fallbackText)
            await sendWhatsAppText(to, fallbackText);
        return false;
    }
    try {
        await postGraphMessage(menuPayload, label, 2);
        const previewText = buildInteractivePreview(menuPayload, fallbackText);
        rememberRecentOutboundContent(to, previewText);
        captureOutboundMessage(to, previewText, {
            source: 'bot',
            kind: 'whatsapp_interactive',
            interactive_label: label,
            interactive_type: String(menuPayload?.interactive?.type || '')
        });
        console.log(`[WhatsApp] Interactive sent successfully: ${label} to ${to}`);
        return true;
    }
    catch (err) {
        console.error(`[WhatsApp] ${label} failed:`, err.message);
        interactiveDegradedUntil.set(to, now + INTERACTIVE_DEGRADED_WINDOW_MS);
        if (fallbackText)
            await sendWhatsAppText(to, fallbackText);
        return false;
    }
}
// ============ Menu Functions ============
async function sendMainMenu(to, compact = false) {
    // Prevent duplicate menu sends
    const lastHash = lastOutboundByUser.get(to)?.hash;
    const menuHash = normalizeForOutboundDedupe(compact ? "compact_menu" : "full_menu");
    if (lastHash === menuHash) {
        console.log(`[Menu] Skipping duplicate main menu for ${to}`);
        return;
    }
    if (!compact) {
        const introSticker = await db_1.db.getConfig('intro_sticker_media');
        if (introSticker) {
            sendWhatsAppSticker(to, introSticker).catch((err) => {
                console.error('[WhatsApp] Intro sticker async failed:', err?.message || err);
            });
        }
    }
    if (compact) {
        // Give a short gap so the previous message doesn't feel glued to the menu.
        await new Promise((resolve) => setTimeout(resolve, 800));
    }
    const payload = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
            type: "list",
            body: {
                text: compact
                    ? "Se quiser, eu também posso te ajudar com reserva, delivery ou Espaço Kids. 😊\n\nEscolha uma opção:"
                    : "Opa! 👋 Eu sou a Kha do Kharina 😃\nEscolha uma opção:"
            },
            action: {
                button: "Ver opções",
                sections: [{
                        title: "O que você quer fazer?",
                        rows: [
                            { id: "menu_cardapio", title: "1️⃣ Ver Cardápio" },
                            { id: "menu_reserva", title: "2️⃣ Reservar Mesa" },
                            { id: "menu_delivery", title: "3️⃣ Delivery 🍟🚀" },
                            { id: "menu_kids", title: "4️⃣ Espaço Kids 🧸" }
                        ]
                    }]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_main_menu', 'Escolha: 1) Ver Cardápio 2) Reservar Mesa 3) Delivery 4) Espaço Kids');
}
async function sendCitiesMenu(to) {
    const payload = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
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
    await sendInteractiveWithFallback(to, payload, 'send_cities_menu', 'Escolha a cidade: Curitiba, Londrina ou São Paulo.');
}
async function sendUnidadesMenu(to) {
    const payload = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
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
    await sendInteractiveWithFallback(to, payload, 'send_unidades_menu', 'Qual unidade? (Jardim Botânico, Cabral, Água Verde, Batel, Portão, Londrina ou São Paulo).');
}
async function sendPhoneConfirmation(to) {
    const payload = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
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
    await sendInteractiveWithFallback(to, payload, 'send_phone_confirmation', 'Posso usar este número para a reserva? Responda "sim" ou "não, usar outro".');
}
async function sendConfirmationMenu(to, state) {
    const resv = state.reservation || {};
    const unit = state.preferred_unit_name || '❓ Pendente';
    const checklist = [
        `Dá uma olhada no resumo da sua reserva:`,
        `- 👤 Nome: ${resv.name || '❓ Pendente'}`,
        `- 📱 Celular: ${formatBrazilPhone(resv.contact_phone || '')}`,
        `- 📅 Data: ${resv.date_text ? toBrDate(normalizeIsoDate(resv.date_text)) : '❓ Pendente'}`,
        `- ⏰ Horário: ${resv.time_text ? normalizeTime(resv.time_text) : '❓ Pendente'}`,
        `- 👨 Adultos: ${resv.people !== undefined ? resv.people : '❓ Pendente'}`,
        `- 👶 Crianças: ${resv.kids !== undefined ? resv.kids : '❓ Pendente'}`,
        `- 👥 Total: ${(resv.people !== undefined && resv.kids !== undefined) ? (Number(resv.people) + Number(resv.kids)) : '❓ Pendente'}`,
        resv.notes ? `- 📝 Observações: ${resv.notes}` : '',
        `- 📍 Unidade: ${unit}`
    ].filter(Boolean).join('\n');
    const payload = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
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
    await sendInteractiveWithFallback(to, payload, 'send_confirmation_menu', `${checklist}\n\nOs dados estão corretos? Responda "sim" ou "não, mudar algo".`);
}
async function sendCancelConfirmationMenu(to, reservationId, preamble) {
    const payload = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
            type: "button",
            body: { text: preamble },
            action: {
                buttons: [
                    { type: "reply", reply: { id: `cancel_yes_${reservationId}`, title: "Sim, cancelar ❌" } },
                    { type: "reply", reply: { id: `cancel_no`, title: "Não, manter ✅" } }
                ]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_cancel_confirmation', `${preamble} Responda "Sim, cancelar" ou "Não".`);
}
async function sendCancelAllConfirmationMenu(to, count) {
    const preamble = `Confirma o cancelamento de *todas* as suas reservas ativas (${count})?`;
    const payload = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
            type: "button",
            body: { text: preamble },
            action: {
                buttons: [
                    { type: "reply", reply: { id: "cancel_all_yes", title: "Sim, cancelar todas ❌" } },
                    { type: "reply", reply: { id: "cancel_all_no", title: "Não, manter ✅" } }
                ]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_cancel_all_confirmation', `${preamble} Responda "Sim, cancelar todas" ou "Não".`);
}
async function sendDeliveryChoiceMenu(to) {
    const payload = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
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
    await sendInteractiveWithFallback(to, payload, 'send_delivery_choice_menu', 'Você quer: "Novo Pedido" ou "Preciso de Ajuda"?');
}
async function sendDeliveryCitiesMenu(to) {
    const payload = {
        messaging_product: "whatsapp",
        to,
        type: "interactive",
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
    await sendInteractiveWithFallback(to, payload, 'send_delivery_cities_menu', 'De qual cidade? 1) Curitiba 2) Londrina 3) São Paulo');
}
async function sendAdminMainMenu(to, isMaster) {
    const rows = [
        { id: 'admin_menu_blocks', title: 'Bloqueios', description: 'Criar, listar e desativar regras' },
        { id: 'admin_menu_list_blocks', title: 'Regras ativas', description: 'Ver bloqueios vigentes agora' },
        ...(isMaster ? [{ id: 'admin_menu_admins', title: 'Administradores', description: 'Gerenciar acessos ao menu' }] : []),
        { id: 'admin_menu_exit', title: 'Sair', description: 'Encerrar modo administrativo' }
    ];
    const fallbackText = isMaster
        ? 'Menu admin: 1) Bloqueios 2) Regras ativas 3) Administradores 4) Sair'
        : 'Menu admin: 1) Bloqueios 2) Regras ativas 3) Sair';
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: 'Menu administrativo do bot. Escolha o que você quer gerenciar.' },
            action: {
                button: 'Abrir opções',
                sections: [{ title: 'Administração', rows }]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_main_menu', fallbackText);
}
async function sendAdminBlocksMenu(to) {
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: 'Gerenciamento de bloqueios. Escolha uma ação.' },
            action: {
                button: 'Ver ações',
                sections: [{
                        title: 'Bloqueios',
                        rows: [
                            { id: 'admin_block_new', title: 'Criar bloqueio', description: 'Cadastrar nova regra de restrição' },
                            { id: 'admin_block_list', title: 'Listar bloqueios', description: 'Ver regras ativas' },
                            { id: 'admin_block_disable_menu', title: 'Desativar bloqueio', description: 'Encerrar regra existente' },
                            { id: 'admin_menu_back_main', title: 'Voltar', description: 'Retornar ao menu principal' }
                        ]
                    }]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_blocks_menu', 'Bloqueios: 1) Criar 2) Listar 3) Desativar 4) Voltar');
}
async function sendAdminStoreMenu(to) {
    const rows = Object.entries(UNIT_CONFIG).map(([id, unit]) => ({
        id: `admin_block_store_${id}`,
        title: unit.name,
        description: 'Aplicar bloqueio nesta unidade'
    }));
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: 'Escolha a unidade para o bloqueio.' },
            action: {
                button: 'Ver unidades',
                sections: [{ title: 'Unidades', rows }]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_store_menu', 'Escolha a unidade do bloqueio.');
}
async function sendAdminWeekdayMenu(to) {
    const rows = [
        { id: 'admin_block_day_all', title: 'Todos os dias', description: 'Vale para qualquer dia da semana' },
        { id: 'admin_block_day_1', title: 'Segunda', description: 'Somente segunda-feira' },
        { id: 'admin_block_day_2', title: 'Terça', description: 'Somente terça-feira' },
        { id: 'admin_block_day_3', title: 'Quarta', description: 'Somente quarta-feira' },
        { id: 'admin_block_day_4', title: 'Quinta', description: 'Somente quinta-feira' },
        { id: 'admin_block_day_5', title: 'Sexta', description: 'Somente sexta-feira' },
        { id: 'admin_block_day_6', title: 'Sábado', description: 'Somente sábado' },
        { id: 'admin_block_day_0', title: 'Domingo', description: 'Somente domingo' }
    ];
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: 'Agora escolha em qual dia esse bloqueio deve valer.' },
            action: {
                button: 'Escolher dia',
                sections: [{ title: 'Dias', rows }]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_weekday_menu', 'Escolha o dia do bloqueio.');
}
async function sendAdminModeMenu(to) {
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: 'Como o bot deve agir quando a reserva cair nesse bloqueio?' },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'admin_block_mode_deny', title: 'Bloquear' } },
                    { type: 'reply', reply: { id: 'admin_block_mode_suggest', title: 'Sugerir outro' } },
                    { type: 'reply', reply: { id: 'admin_block_mode_handoff', title: 'Encaminhar' } }
                ]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_mode_menu', 'Modo: bloquear, sugerir outro horário ou encaminhar para a equipe.');
}
async function sendAdminBlockConfirmMenu(to, draft) {
    const summary = [
        'Confirma a criação deste bloqueio?',
        `• Unidade: ${draft.store_name || 'N/A'}`,
        `• Dia: ${(0, reservationAdmin_1.weekdayLabel)(draft.weekday ?? null)}`,
        `• Faixa: ${draft.start_time || 'N/A'} às ${draft.end_time || 'N/A'}`,
        `• Ação: ${draft.mode ? (0, reservationAdmin_1.blockModeLabel)(draft.mode) : 'N/A'}`
    ].join('\n');
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: summary },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'admin_block_save', title: 'Salvar' } },
                    { type: 'reply', reply: { id: 'admin_block_cancel', title: 'Cancelar' } }
                ]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_block_confirm_menu', summary);
}
async function sendAdminAdminsMenu(to) {
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: 'Gerenciamento de administradores. Escolha uma ação.' },
            action: {
                button: 'Ver ações',
                sections: [{
                        title: 'Administradores',
                        rows: [
                            { id: 'admin_admin_add', title: 'Adicionar admin', description: 'Cadastrar novo acesso' },
                            { id: 'admin_admin_list', title: 'Listar admins', description: 'Ver acessos ativos' },
                            { id: 'admin_admin_remove_menu', title: 'Remover admin', description: 'Desativar acesso existente' },
                            { id: 'admin_menu_back_main', title: 'Voltar', description: 'Retornar ao menu principal' }
                        ]
                    }]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_admins_menu', 'Administradores: 1) Adicionar 2) Listar 3) Remover 4) Voltar');
}
async function sendAdminRoleMenu(to, phone) {
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: `Qual perfil você quer dar para ${phone}?` },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'admin_admin_role_admin', title: 'Admin' } },
                    { type: 'reply', reply: { id: 'admin_admin_role_master', title: 'Master' } },
                    { type: 'reply', reply: { id: 'admin_admin_role_cancel', title: 'Cancelar' } }
                ]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_role_menu', `Escolha o perfil para ${phone}: admin ou master.`);
}
async function sendAdminRemoveAdminMenu(to, currentPhone) {
    const admins = await (0, reservationAdmin_1.listAdminUsers)();
    const rows = [];
    for (const admin of admins) {
        if (admin.phone === (0, reservationAdmin_1.normalizeAdminPhone)(currentPhone))
            continue;
        const isFixedMaster = admin.role === 'master' && await (0, reservationAdmin_1.isConfiguredMasterPhone)(admin.phone);
        if (isFixedMaster)
            continue;
        rows.push({
            id: `admin_admin_remove_pick_${admin.phone}`,
            title: admin.phone,
            description: admin.role === 'master' ? 'Master' : 'Admin'
        });
    }
    if (rows.length === 0) {
        await sendWhatsAppText(to, 'Não encontrei outros administradores removíveis no momento.');
        return;
    }
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: 'Escolha qual administrador você quer remover.' },
            action: {
                button: 'Ver admins',
                sections: [{ title: 'Admins ativos', rows }]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_remove_admin_menu', 'Escolha o administrador que deve ser removido.');
}
async function sendAdminRemoveConfirmMenu(to, phone) {
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: `Confirma remover o acesso administrativo do número ${phone}?` },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'admin_admin_remove_confirm', title: 'Confirmar' } },
                    { type: 'reply', reply: { id: 'admin_admin_remove_cancel', title: 'Cancelar' } }
                ]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_remove_confirm_menu', `Confirma remover o admin ${phone}?`);
}
async function sendAdminDisableBlockMenu(to) {
    const blocks = await (0, reservationAdmin_1.listReservationBlocks)(true, 10);
    if (blocks.length === 0) {
        await sendWhatsAppText(to, 'Não há bloqueios ativos no momento.');
        return;
    }
    const rows = blocks.map((block) => ({
        id: `admin_block_disable_pick_${block.id}`,
        title: `${block.store_name} ${block.start_time}-${block.end_time}`.slice(0, 24),
        description: `${(0, reservationAdmin_1.weekdayLabel)(block.weekday)} | ${(0, reservationAdmin_1.blockModeLabel)(block.mode)}`.slice(0, 72)
    }));
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: 'Escolha o bloqueio que deve ser desativado.' },
            action: {
                button: 'Ver bloqueios',
                sections: [{ title: 'Bloqueios ativos', rows }]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_disable_block_menu', 'Escolha o bloqueio que deve ser desativado.');
}
async function sendAdminDisableBlockConfirmMenu(to, block) {
    const summary = (0, reservationAdmin_1.describeReservationBlock)(block);
    const payload = {
        messaging_product: 'whatsapp',
        to,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: `Confirma desativar este bloqueio?\n\n${summary}` },
            action: {
                buttons: [
                    { type: 'reply', reply: { id: 'admin_block_disable_confirm', title: 'Confirmar' } },
                    { type: 'reply', reply: { id: 'admin_block_disable_cancel', title: 'Cancelar' } }
                ]
            }
        }
    };
    await sendInteractiveWithFallback(to, payload, 'send_admin_disable_block_confirm_menu', `Confirma desativar o bloqueio ${summary}?`);
}
async function sendReservationConfirmationOrBlock(to, state) {
    const leadTimeViolation = getReservationLeadTimeViolation(state.reservation?.date_text, state.reservation?.time_text, state.preferred_unit_name);
    if (leadTimeViolation) {
        if (state.reservation)
            state.reservation.awaiting_confirmation = false;
        userStates.set(to, state);
        await sendWhatsAppText(to, leadTimeViolation);
        return false;
    }
    const block = await maybeGetReservationBlock(state);
    if (!block) {
        await sendConfirmationMenu(to, state);
        if (state.reservation)
            state.reservation.awaiting_confirmation = true;
        userStates.set(to, state);
        return true;
    }
    if (state.reservation)
        state.reservation.awaiting_confirmation = false;
    userStates.set(to, state);
    await sendWhatsAppText(to, buildReservationBlockCustomerMessage(block, state.preferred_unit_name, state.reservation?.date_text, state.reservation?.time_text));
    return false;
}
// ============ Command Handlers ============
function isInActiveFlow(state) {
    if (!state)
        return false;
    if (state.reservation) {
        const r = state.reservation;
        if (r.awaiting_confirmation || r.awaiting_cancellation || r.phone_confirmed)
            return true;
        if (state.preferred_unit_name)
            return true;
    }
    return false;
}
async function sendAdminBlockList(to) {
    const blocks = await (0, reservationAdmin_1.listReservationBlocks)(true, 50);
    if (blocks.length === 0) {
        await sendWhatsAppText(to, 'Não há bloqueios ativos no momento.');
        return;
    }
    const lines = ['Bloqueios ativos:'];
    for (const block of blocks) {
        lines.push(`- ${(0, reservationAdmin_1.describeReservationBlock)(block)}`);
    }
    await sendWhatsAppText(to, lines.join('\n'));
}
async function sendAdminUserList(to) {
    const admins = await (0, reservationAdmin_1.listAdminUsers)();
    if (admins.length === 0) {
        await sendWhatsAppText(to, 'Não há administradores ativos cadastrados.');
        return;
    }
    const lines = ['Administradores ativos:'];
    for (const admin of admins) {
        const isFixedMaster = admin.role === 'master' && await (0, reservationAdmin_1.isConfiguredMasterPhone)(admin.phone);
        lines.push(`- ${admin.phone} | ${admin.role === 'master' ? 'Master' : 'Admin'}${isFixedMaster ? ' | fixo do sistema' : ''}`);
    }
    await sendWhatsAppText(to, lines.join('\n'));
}
async function handleAdminCommand(text, from, state) {
    const raw = String(text || '').trim();
    const normalized = raw.toLowerCase();
    const adminState = state.admin;
    const looksLikeAdmin = normalized === '/admin' || normalized.startsWith('admin_') || !!adminState?.step;
    if (!looksLikeAdmin)
        return false;
    const hasAdmins = await (0, reservationAdmin_1.hasAnyAdminConfigured)();
    if (!hasAdmins) {
        if (normalized === '/admin') {
            await sendWhatsAppText(from, 'O acesso administrativo ainda não foi configurado. Defina o(s) número(s) master em `ADMIN_MASTER_PHONES` ou no config `admin_master_phones`.');
        }
        return true;
    }
    const adminUser = await (0, reservationAdmin_1.getAdminUser)(from);
    if (!adminUser) {
        if (normalized === '/admin') {
            await sendWhatsAppText(from, 'Este número não tem acesso ao menu administrativo.');
        }
        return true;
    }
    const isMaster = adminUser.role === 'master';
    const currentAdminState = ensureAdminState(state);
    if (normalized === '/admin') {
        currentAdminState.step = 'main';
        currentAdminState.draft_block = undefined;
        currentAdminState.pending_admin_phone = undefined;
        currentAdminState.pending_disable_block_id = undefined;
        currentAdminState.pending_remove_admin_phone = undefined;
        userStates.set(from, state);
        await sendAdminMainMenu(from, isMaster);
        return true;
    }
    if (normalized === 'admin_menu_exit') {
        clearAdminState(state);
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Modo administrativo encerrado.');
        return true;
    }
    if (normalized === 'admin_menu_back_main') {
        currentAdminState.step = 'main';
        currentAdminState.draft_block = undefined;
        currentAdminState.pending_admin_phone = undefined;
        currentAdminState.pending_disable_block_id = undefined;
        currentAdminState.pending_remove_admin_phone = undefined;
        userStates.set(from, state);
        await sendAdminMainMenu(from, isMaster);
        return true;
    }
    if (normalized === 'admin_menu_blocks') {
        currentAdminState.step = 'blocks';
        currentAdminState.draft_block = undefined;
        userStates.set(from, state);
        await sendAdminBlocksMenu(from);
        return true;
    }
    if (normalized === 'admin_menu_list_blocks' || normalized === 'admin_block_list') {
        await sendAdminBlockList(from);
        if (currentAdminState.step !== 'main') {
            await sendAdminBlocksMenu(from);
        }
        else {
            await sendAdminMainMenu(from, isMaster);
        }
        return true;
    }
    if (normalized === 'admin_menu_admins') {
        if (!isMaster) {
            await sendWhatsAppText(from, 'Apenas administradores master podem gerenciar outros acessos.');
            await sendAdminMainMenu(from, isMaster);
            return true;
        }
        currentAdminState.step = 'admins';
        userStates.set(from, state);
        await sendAdminAdminsMenu(from);
        return true;
    }
    if (normalized === 'admin_block_new') {
        currentAdminState.step = 'block_pick_store';
        currentAdminState.draft_block = {};
        userStates.set(from, state);
        await sendAdminStoreMenu(from);
        return true;
    }
    if (normalized.startsWith('admin_block_store_')) {
        const unitId = normalized.replace('admin_block_store_', '').trim();
        const unit = UNIT_CONFIG[unitId];
        if (!unit) {
            await sendWhatsAppText(from, 'Não reconheci essa unidade. Vou abrir a lista novamente.');
            await sendAdminStoreMenu(from);
            return true;
        }
        currentAdminState.step = 'block_pick_day';
        currentAdminState.draft_block = {
            ...(currentAdminState.draft_block || {}),
            store_id: unit.storeId,
            store_name: unit.name
        };
        userStates.set(from, state);
        await sendAdminWeekdayMenu(from);
        return true;
    }
    if (normalized.startsWith('admin_block_day_')) {
        const rawDay = normalized.replace('admin_block_day_', '').trim();
        currentAdminState.step = 'block_wait_start_time';
        currentAdminState.draft_block = {
            ...(currentAdminState.draft_block || {}),
            weekday: rawDay === 'all' ? null : Number(rawDay)
        };
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Me envie o horário inicial do bloqueio no formato HH:MM. Ex.: 19:00');
        return true;
    }
    if (currentAdminState.step === 'block_wait_start_time') {
        const startTime = isValidAdminTimeInput(raw);
        if (!startTime) {
            await sendWhatsAppText(from, 'Horário inválido. Me envie no formato HH:MM. Ex.: 19:00');
            return true;
        }
        currentAdminState.step = 'block_wait_end_time';
        currentAdminState.draft_block = {
            ...(currentAdminState.draft_block || {}),
            start_time: startTime
        };
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Agora me envie o horário final do bloqueio no formato HH:MM. Ex.: 21:30');
        return true;
    }
    if (currentAdminState.step === 'block_wait_end_time') {
        const endTime = isValidAdminTimeInput(raw);
        const startTime = currentAdminState.draft_block?.start_time;
        if (!endTime || !startTime || endTime <= startTime) {
            await sendWhatsAppText(from, 'Horário final inválido. Ele precisa ser maior que o horário inicial. Ex.: 21:30');
            return true;
        }
        currentAdminState.step = 'block_pick_mode';
        currentAdminState.draft_block = {
            ...(currentAdminState.draft_block || {}),
            end_time: endTime
        };
        userStates.set(from, state);
        await sendAdminModeMenu(from);
        return true;
    }
    if (normalized === 'admin_block_mode_deny' || normalized === 'admin_block_mode_suggest' || normalized === 'admin_block_mode_handoff') {
        const mode = normalized === 'admin_block_mode_suggest'
            ? 'suggest_alternative'
            : normalized === 'admin_block_mode_handoff'
                ? 'handoff'
                : 'deny';
        currentAdminState.step = 'block_confirm';
        currentAdminState.draft_block = {
            ...(currentAdminState.draft_block || {}),
            mode
        };
        userStates.set(from, state);
        await sendAdminBlockConfirmMenu(from, currentAdminState.draft_block || {});
        return true;
    }
    if (normalized === 'admin_block_cancel') {
        currentAdminState.step = 'blocks';
        currentAdminState.draft_block = undefined;
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Criação do bloqueio cancelada.');
        await sendAdminBlocksMenu(from);
        return true;
    }
    if (normalized === 'admin_block_save') {
        const draft = currentAdminState.draft_block || {};
        if (!draft.store_id || !draft.store_name || draft.start_time === undefined || !draft.end_time || !draft.mode) {
            await sendWhatsAppText(from, 'Faltaram dados do bloqueio. Vou reiniciar esse cadastro.');
            currentAdminState.step = 'blocks';
            currentAdminState.draft_block = undefined;
            userStates.set(from, state);
            await sendAdminBlocksMenu(from);
            return true;
        }
        const block = await (0, reservationAdmin_1.createReservationBlock)({
            storeId: draft.store_id,
            storeName: draft.store_name,
            weekday: draft.weekday ?? null,
            startTime: draft.start_time,
            endTime: draft.end_time,
            mode: draft.mode,
            message: (0, reservationAdmin_1.buildDefaultBlockMessage)({
                store_name: draft.store_name,
                weekday: draft.weekday ?? null,
                start_time: draft.start_time,
                end_time: draft.end_time,
                mode: draft.mode
            }),
            createdBy: from
        });
        currentAdminState.step = 'blocks';
        currentAdminState.draft_block = undefined;
        userStates.set(from, state);
        await sendWhatsAppText(from, `Bloqueio criado com sucesso.\n${(0, reservationAdmin_1.describeReservationBlock)(block)}`);
        await sendAdminBlocksMenu(from);
        return true;
    }
    if (normalized === 'admin_block_disable_menu') {
        currentAdminState.step = 'block_disable_pick';
        userStates.set(from, state);
        await sendAdminDisableBlockMenu(from);
        return true;
    }
    if (normalized.startsWith('admin_block_disable_pick_')) {
        const id = Number(normalized.replace('admin_block_disable_pick_', '').trim());
        const block = Number.isFinite(id) ? await (0, reservationAdmin_1.getReservationBlock)(id) : null;
        if (!block || !block.active) {
            await sendWhatsAppText(from, 'Esse bloqueio não está mais disponível. Vou abrir a lista novamente.');
            await sendAdminDisableBlockMenu(from);
            return true;
        }
        currentAdminState.step = 'block_disable_confirm';
        currentAdminState.pending_disable_block_id = id;
        userStates.set(from, state);
        await sendAdminDisableBlockConfirmMenu(from, block);
        return true;
    }
    if (normalized === 'admin_block_disable_confirm') {
        const blockId = Number(currentAdminState.pending_disable_block_id || 0);
        if (!blockId) {
            await sendWhatsAppText(from, 'Não encontrei qual bloqueio deveria ser desativado. Vou voltar ao menu.');
            currentAdminState.step = 'blocks';
            userStates.set(from, state);
            await sendAdminBlocksMenu(from);
            return true;
        }
        await (0, reservationAdmin_1.deactivateReservationBlock)(blockId, from);
        currentAdminState.step = 'blocks';
        currentAdminState.pending_disable_block_id = undefined;
        userStates.set(from, state);
        await sendWhatsAppText(from, `Bloqueio #${blockId} desativado com sucesso.`);
        await sendAdminBlocksMenu(from);
        return true;
    }
    if (normalized === 'admin_block_disable_cancel') {
        currentAdminState.step = 'blocks';
        currentAdminState.pending_disable_block_id = undefined;
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Desativação cancelada.');
        await sendAdminBlocksMenu(from);
        return true;
    }
    if (!isMaster) {
        if (adminState?.step) {
            await sendAdminMainMenu(from, false);
            return true;
        }
        return false;
    }
    if (normalized === 'admin_admin_list') {
        await sendAdminUserList(from);
        await sendAdminAdminsMenu(from);
        return true;
    }
    if (normalized === 'admin_admin_add') {
        currentAdminState.step = 'admin_wait_phone';
        currentAdminState.pending_admin_phone = undefined;
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Me envie o número que deve ganhar acesso administrativo, com DDD. Ex.: +5541999999999');
        return true;
    }
    if (currentAdminState.step === 'admin_wait_phone') {
        const extracted = extractPhoneCandidate(raw) || (0, reservationAdmin_1.normalizeAdminPhone)(raw);
        if (!extracted || extracted.length < 12) {
            await sendWhatsAppText(from, 'Número inválido. Envie com DDD e, de preferência, com +55. Ex.: +5541999999999');
            return true;
        }
        currentAdminState.step = 'admin_pick_role';
        currentAdminState.pending_admin_phone = extracted;
        userStates.set(from, state);
        await sendAdminRoleMenu(from, extracted);
        return true;
    }
    if (normalized === 'admin_admin_role_cancel') {
        currentAdminState.step = 'admins';
        currentAdminState.pending_admin_phone = undefined;
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Cadastro de admin cancelado.');
        await sendAdminAdminsMenu(from);
        return true;
    }
    if (normalized === 'admin_admin_role_admin' || normalized === 'admin_admin_role_master') {
        const targetPhone = String(currentAdminState.pending_admin_phone || '').trim();
        if (!targetPhone) {
            await sendWhatsAppText(from, 'Não encontrei o número pendente desse cadastro. Vou voltar ao menu.');
            currentAdminState.step = 'admins';
            userStates.set(from, state);
            await sendAdminAdminsMenu(from);
            return true;
        }
        const role = normalized === 'admin_admin_role_master' ? 'master' : 'admin';
        const saved = await (0, reservationAdmin_1.addOrUpdateAdminUser)(targetPhone, role, from);
        currentAdminState.step = 'admins';
        currentAdminState.pending_admin_phone = undefined;
        userStates.set(from, state);
        await sendWhatsAppText(from, `Acesso salvo para ${saved.phone} como ${saved.role === 'master' ? 'master' : 'admin'}.`);
        await sendAdminAdminsMenu(from);
        return true;
    }
    if (normalized === 'admin_admin_remove_menu') {
        currentAdminState.step = 'admin_remove_pick';
        userStates.set(from, state);
        await sendAdminRemoveAdminMenu(from, from);
        return true;
    }
    if (normalized.startsWith('admin_admin_remove_pick_')) {
        const phone = normalized.replace('admin_admin_remove_pick_', '').trim();
        currentAdminState.step = 'admin_remove_confirm';
        currentAdminState.pending_remove_admin_phone = phone;
        userStates.set(from, state);
        await sendAdminRemoveConfirmMenu(from, phone);
        return true;
    }
    if (normalized === 'admin_admin_remove_cancel') {
        currentAdminState.step = 'admins';
        currentAdminState.pending_remove_admin_phone = undefined;
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Remoção cancelada.');
        await sendAdminAdminsMenu(from);
        return true;
    }
    if (normalized === 'admin_admin_remove_confirm') {
        const phone = String(currentAdminState.pending_remove_admin_phone || '').trim();
        if (!phone) {
            await sendWhatsAppText(from, 'Não encontrei qual admin deveria ser removido. Vou voltar ao menu.');
            currentAdminState.step = 'admins';
            userStates.set(from, state);
            await sendAdminAdminsMenu(from);
            return true;
        }
        try {
            await (0, reservationAdmin_1.deactivateAdminUser)(phone, from);
            await sendWhatsAppText(from, `Acesso removido do número ${phone}.`);
        }
        catch (err) {
            const reason = String(err?.message || err || '');
            if (reason === 'cannot_remove_self') {
                await sendWhatsAppText(from, 'Você não pode remover o seu próprio acesso por este menu.');
            }
            else if (reason === 'cannot_remove_bootstrap_master') {
                await sendWhatsAppText(from, 'Esse administrador master é fixo do sistema e precisa ser removido da configuração do ambiente antes.');
            }
            else if (reason === 'cannot_remove_last_master') {
                await sendWhatsAppText(from, 'Não posso remover o último administrador master.');
            }
            else {
                await sendWhatsAppText(from, 'Não consegui remover esse administrador agora.');
            }
        }
        currentAdminState.step = 'admins';
        currentAdminState.pending_remove_admin_phone = undefined;
        userStates.set(from, state);
        await sendAdminAdminsMenu(from);
        return true;
    }
    if (currentAdminState.step) {
        await sendWhatsAppText(from, 'Não reconheci essa opção no fluxo administrativo. Vou te mostrar o menu novamente.');
        await sendAdminMainMenu(from, isMaster);
        return true;
    }
    return false;
}
async function handleDeterministicCommand(text, from, state, profileName) {
    if (await handleAdminCommand(text, from, state)) {
        return true;
    }
    const normalized = text.trim().toLowerCase();
    const normalizedNoAccent = normalized
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
    const normalizedIntent = normalizeIntentText(text);
    const isThanks = /\b(obrigad[oa]?|valeu|agrade[cç]o|muito obrigado|brigad[oa]?|thanks)\b/.test(normalized);
    const isGreeting = GREETING_COMMANDS.has(normalized) || GREETING_REGEX.test(normalized);
    const isGenericAck = /^(ok|okay|okk|blz|beleza|certo|certinho|fechado|show|perfeito|sim|isso|mandei|enviei|ja te mandei|ja mandei|te mandei|pronto|segue|pode ser)$/.test(normalizedIntent);
    const isBirthdayCakeQuestion = /\b(bolo|aniversa(?:rio|́rio))\b/.test(normalizedNoAccent) &&
        /\b(pode|permitid|autoriz|levar|trazer)\b/.test(normalizedNoAccent);
    const isCorkageQuestion = /\b(rolha|vinho|bebida(?:s)?\s+de\s+casa|bebida\s+de\s+fora)\b/.test(normalizedNoAccent) &&
        /\b(pode|permitid|autoriz|levar|trazer|tem|custa|cobra|taxa)\b/.test(normalizedNoAccent);
    const isReservationIntent = /\breserv(a|ar|e|ei|ando|ação|acao|as)\b/.test(normalized) ||
        normalized.includes('quero reservar') ||
        normalized.includes('fazer reserva') ||
        normalized.includes('reservar mesa');
    const isReservationLeadIntent = isReservationIntent ||
        /(\b(consegue|quero|queria|gostaria|preciso|posso)\b.*\b(hoje|amanha|amanhã|dia\s+\d{1,2}|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo)\b)|(\b\d{1,2}\/\d{1,2}\b)/.test(normalizedNoAccent);
    const isReservationManageIntent = /\b(minha(s)? reserva(s)?|tenho reserva(s)?|consult(a|ar)|verific(a|ar)|checar|cancel(a|ar)|alter(a|ar)|remarc(a|ar)|mudar reserva)\b/.test(normalized);
    const isCancelIntent = /\b(cancel(a|ar|amento)|desmarc(a|ar)|excluir reserva|nao vou poder ir|não vou poder ir)\b/.test(normalized);
    const isCancelAllIntent = /\b(cancel(a|ar).*(todas|tudo)|todas as reservas|cancelar tudo)\b/.test(normalized);
    const isAlterIntent = /\b(alter(a|ar|ação|acao)|remarc(a|ar)|reagend(a|ar)|mudar reserva|trocar|troca|outro dia|nova data|tenho que alterar|preciso alterar|vamos alterar|quero trocar)\b/.test(normalized);
    const isReservationQueryIntent = /\b(minha(s)? reserva(s)?|tenho reserva(s)?|consult(a|ar)|verific(a|ar)|checar|quais reservas)\b/.test(normalized);
    const isHoursIntent = /\b(horario|horarios|funcionamento|abre|aberto|fechamento|fecha|ate que horas|até que horas)\b/.test(normalizedNoAccent);
    const timeOnlyPattern = /\bhoje\b/.test(normalized) &&
        /(\d{1,2})\s*(h|hora|horas|:\d{2})/.test(normalized) &&
        !/\b\d+\s*(pessoa|pessoas|adulto|adultos)\b/.test(normalized);
    // If waiting final confirmation, keep user inside confirmation state.
    if (state.reservation?.awaiting_confirmation && text !== 'confirm_reserva_sim' && text !== 'confirm_reserva_nao') {
        if (isGreeting || isThanks || isGenericAck || normalized === 'menu' || normalized === 'inicio' || normalized === 'voltar') {
            await sendWhatsAppText(from, 'Estamos quase lá 😊 Para concluir, confirme os dados da reserva no botão abaixo.');
            await sendReservationConfirmationOrBlock(from, state);
            return true;
        }
    }
    // Main menu
    if (text === 'MENU_PRINCIPAL' || normalized === 'menu' || normalized === 'inicio' || normalized === 'voltar') {
        state.reservation = undefined;
        state.has_interacted = true;
        userStates.set(from, state);
        await sendMainMenu(from, false);
        return true;
    }
    if (isBirthdayCakeQuestion) {
        const unit = state.preferred_unit_name ? ` da unidade ${state.preferred_unit_name}` : '';
        await sendWhatsAppText(from, `Sim! 🎂 Pode levar bolo de aniversário${unit}. Se quiser, já deixo essa observação na reserva também. 😊`);
        return true;
    }
    if (isCorkageQuestion) {
        const unit = state.preferred_unit_name ? ` na unidade ${state.preferred_unit_name}` : '';
        await sendWhatsAppText(from, `Sim! 🍷 Trabalhamos com rolha liberada${unit}, sem custo. Pode trazer vinho ou bebida de casa sem taxa. 😊`);
        return true;
    }
    // Greeting outside active flow -> open main menu immediately
    if (isGreeting && !isInActiveFlow(state)) {
        state.has_interacted = true;
        userStates.set(from, state);
        await sendMainMenu(from, false);
        return true;
    }
    if (isThanks && !isInActiveFlow(state)) {
        await sendWhatsAppText(from, 'Imagina! 😊 Sempre que precisar, estou por aqui para ajudar com reservas, cardápio ou delivery.');
        await sendWhatsAppSticker(from, '1296835615764631').catch((err) => {
            console.error('[WhatsApp] Thanks sticker async failed:', err?.message || err);
        });
        return true;
    }
    if (isHoursIntent) {
        return await answerStoreHours(from, state, text);
    }
    // Natural language reservation intent -> traditional interactive flow
    if (isReservationQueryIntent && !isInActiveFlow(state)) {
        const q = await queryReservationsDeterministic(from);
        await sendWhatsAppText(from, q.message);
        return true;
    }
    // Natural language reservation intent -> traditional interactive flow
    if (isReservationManageIntent && !isInActiveFlow(state)) {
        if (isCancelIntent) {
            const active = await fetchActiveReservationsWithRetry(from);
            if (active.length === 0) {
                await sendWhatsAppText(from, 'Não consegui localizar uma reserva ativa para cancelar agora. Se você acabou de confirmar, aguarde 1 minuto e me peça novamente para cancelar.');
                return true;
            }
            if (active.length === 1) {
                const selected = active[0];
                state.reservation = {
                    ...(state.reservation || {}),
                    awaiting_cancellation: true,
                    pending_cancellation_id: selected.reservationId,
                    pending_cancellation_code: selected.code
                };
                userStates.set(from, state);
                await sendCancelConfirmationMenu(from, selected.reservationId, `Confirma o cancelamento da reserva ${selected.code} (${toBrDate(selected.date)} às ${selected.time}, ${selected.storeName})?`);
                return true;
            }
            if (isCancelAllIntent) {
                state.reservation = {
                    ...(state.reservation || {}),
                    awaiting_cancellation: true,
                    pending_cancellation_all_ids: active.map((r) => r.reservationId)
                };
                userStates.set(from, state);
                await sendCancelAllConfirmationMenu(from, active.length);
                return true;
            }
            await sendManageReservationMenu(from, 'cancel', active);
            return true;
        }
        if (isAlterIntent) {
            const active = await fetchActiveReservationsWithRetry(from);
            if (active.length === 0) {
                await sendWhatsAppText(from, 'Não encontrei reservas ativas para alterar no seu número.');
                return true;
            }
            if (active.length === 1) {
                await beginAlterReservationFlow(from, state, active[0], text);
                return true;
            }
            await sendManageReservationMenu(from, 'alter', active);
            return true;
        }
        const q = await queryReservationsDeterministic(from);
        await sendWhatsAppText(from, q.message);
        return true;
    }
    if (text.startsWith('cancel_pick_')) {
        const reservationId = text.replace('cancel_pick_', '').trim();
        const active = await fetchActiveReservationsWithRetry(from);
        const selected = active.find((r) => r.reservationId === reservationId);
        if (!selected) {
            await sendWhatsAppText(from, 'Não encontrei essa reserva para cancelar. Vou te mostrar as reservas ativas novamente.');
            if (active.length > 0)
                await sendManageReservationMenu(from, 'cancel', active);
            return true;
        }
        state.reservation = {
            ...(state.reservation || {}),
            awaiting_cancellation: true,
            pending_cancellation_id: selected.reservationId,
            pending_cancellation_code: selected.code
        };
        userStates.set(from, state);
        await sendCancelConfirmationMenu(from, selected.reservationId, `Confirma o cancelamento da reserva ${selected.code} (${toBrDate(selected.date)} às ${selected.time}, ${selected.storeName})?`);
        return true;
    }
    if (text.startsWith('cancel_yes_')) {
        const reservationId = text.replace('cancel_yes_', '').trim();
        try {
            const mcpReady = await ensureReservasMcpReady();
            if (!mcpReady)
                throw new Error('MCP not ready');
            await callReservasToolWithTimeout('cancel_reservation', {
                reservationId,
                reason: 'Cancelamento solicitado pelo cliente via WhatsApp'
            }, { timeoutMs: 15000, retries: 1, retryDelayMs: 500 });
            const code = state.reservation?.pending_cancellation_code || reservationId.substring(0, 8).toUpperCase();
            await sendWhatsAppText(from, `Reserva ${code} cancelada com sucesso. ✅`);
            state.reservation = undefined;
            userStates.set(from, state);
            const remainingActive = await fetchActiveReservationsWithRetry(from);
            if (remainingActive.length > 0) {
                await sendWhatsAppText(from, 'Se quiser, posso cancelar outra reserva ou te ajudar com uma nova. 🙂');
            }
            else {
                await sendWhatsAppText(from, 'Se quiser, posso te ajudar a fazer uma nova reserva ou com qualquer outra coisa. 🙂');
            }
            return true;
        }
        catch (err) {
            console.error('[ReservasDeterministic] cancel_reservation failed:', err?.message || err);
            await sendWhatsAppText(from, 'Não consegui cancelar agora por instabilidade técnica. Tente novamente em alguns instantes.');
            return true;
        }
    }
    if (text === 'cancel_no' || text === 'cancel_nao') {
        state.reservation = undefined;
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Perfeito, mantive sua reserva como está. 👍');
        await sendWhatsAppText(from, 'Se quiser, posso te mostrar suas reservas ativas novamente.');
        return true;
    }
    if (text === 'cancel_all_yes') {
        const ids = (state.reservation?.pending_cancellation_all_ids || []).filter(Boolean);
        if (ids.length === 0) {
            await sendWhatsAppText(from, 'Não encontrei reservas pendentes para esse cancelamento em lote. Pode pedir novamente que eu consulto.');
            return true;
        }
        let cancelled = 0;
        try {
            const mcpReady = await ensureReservasMcpReady();
            if (!mcpReady)
                throw new Error('MCP not ready');
            for (const reservationId of ids) {
                try {
                    await callReservasToolWithTimeout('cancel_reservation', {
                        reservationId,
                        reason: 'Cancelamento em lote solicitado pelo cliente via WhatsApp'
                    }, { timeoutMs: 15000, retries: 1, retryDelayMs: 500 });
                    cancelled += 1;
                }
                catch (err) {
                    console.error('[ReservasDeterministic] cancel_all item failed:', reservationId, err?.message || err);
                }
            }
            state.reservation = undefined;
            userStates.set(from, state);
            await sendWhatsAppText(from, `Concluído ✅ Cancelei ${cancelled} de ${ids.length} reservas ativas.`);
            await sendWhatsAppText(from, 'Se quiser, posso verificar se ainda restou alguma ativa.');
            return true;
        }
        catch (err) {
            console.error('[ReservasDeterministic] cancel_all failed:', err?.message || err);
            await sendWhatsAppText(from, 'Não consegui concluir o cancelamento em lote agora por instabilidade técnica. Tente novamente em instantes.');
            return true;
        }
    }
    if (text === 'cancel_all_no') {
        state.reservation = undefined;
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Perfeito, não cancelei as reservas. 👍');
        return true;
    }
    if (text.startsWith('alter_pick_')) {
        const reservationId = text.replace('alter_pick_', '').trim();
        const active = await fetchActiveReservationsWithRetry(from);
        const selected = active.find((r) => r.reservationId === reservationId);
        if (!selected) {
            await sendWhatsAppText(from, 'Não encontrei essa reserva para alterar. Vou te mostrar as reservas ativas novamente.');
            if (active.length > 0)
                await sendManageReservationMenu(from, 'alter', active);
            return true;
        }
        await beginAlterReservationFlow(from, state, selected);
        return true;
    }
    // Natural language reservation intent -> traditional interactive flow
    if (isReservationLeadIntent && !isInActiveFlow(state)) {
        state.reservation = state.reservation ? { contact_phone: state.reservation.contact_phone } : undefined;
        state.has_interacted = true;
        userStates.set(from, state);
        await sendUnidadesMenu(from);
        return true;
    }
    // Cardapio menu
    if (text === 'menu_cardapio') {
        state.has_interacted = true;
        userStates.set(from, state);
        await sendCitiesMenu(from);
        return true;
    }
    // Cardapio city selection
    if (text === 'cardapio_curitiba' || text === 'cardapio_londrina' || text === 'cardapio_saopaulo') {
        const cityMap = {
            'cardapio_curitiba': 'Curitiba',
            'cardapio_londrina': 'Londrina',
            'cardapio_saopaulo': 'São Paulo'
        };
        const city = cityMap[text];
        state.preferred_city = city;
        state.has_interacted = true;
        userStates.set(from, state);
        const msg = await buildCardapioMessage(text);
        await sendWhatsAppText(from, msg);
        await sendMainMenu(from, true);
        return true;
    }
    // Reserva menu
    if (text === 'menu_reserva') {
        state.reservation = state.reservation ? { contact_phone: state.reservation.contact_phone } : undefined;
        state.has_interacted = true;
        userStates.set(from, state);
        await sendUnidadesMenu(from);
        return true;
    }
    // Delivery menu
    if (text === 'menu_delivery') {
        state.has_interacted = true;
        userStates.set(from, state);
        await sendDeliveryCitiesMenu(from);
        return true;
    }
    // Espaço Kids menu
    if (text === 'menu_kids') {
        state.has_interacted = true;
        userStates.set(from, state);
        const kidsSticker = await db_1.db.getConfig('kids_sticker_media');
        if (kidsSticker) {
            sendWhatsAppSticker(from, kidsSticker).catch((err) => {
                console.error('[WhatsApp] Kids sticker async failed:', err?.message || err);
            });
        }
        const kidsMsg = await buildKidsInfoMessage();
        await sendWhatsAppText(from, kidsMsg);
        await sendMainMenu(from, true);
        return true;
    }
    // Delivery cities
    if (text === 'delivery_curitiba' || text === 'delivery_londrina' || text === 'delivery_saopaulo') {
        const cityMap = {
            'delivery_curitiba': 'Curitiba',
            'delivery_londrina': 'Londrina',
            'delivery_saopaulo': 'São Paulo'
        };
        const city = cityMap[text];
        if (city === 'São Paulo') {
            await sendWhatsAppText(from, "Poxa, em SP ainda não tem delivery! 😢 Mas vem visitar a gente no Shopping Parque da Cidade! 🧡");
            await sendMainMenu(from, true);
            return true;
        }
        state.preferred_city = city;
        userStates.set(from, state);
        await sendDeliveryChoiceMenu(from);
        return true;
    }
    // Delivery options
    if (text === 'delivery_novo') {
        const city = state.preferred_city || 'Curitiba';
        if (city === 'Londrina') {
            const link = await db_1.db.getConfig('link_delivery_londrina');
            await sendWhatsAppText(from, `Bora pedir! 😋\n👉 ${link || 'https://www.ifood.com.br/'}`);
        }
        else {
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
        }
        await sendMainMenu(from, true);
        return true;
    }
    // delivery_ajuda is now handled by AI to allow better interpretation/empathy
    // Unidade selection
    if (UNIT_CONFIG[text]) {
        state.preferred_unit_name = UNIT_CONFIG[text].name;
        state.preferred_store_id = UNIT_CONFIG[text].storeId;
        state.reservation = { ...(state.reservation || {}), phone_confirmed: false };
        userStates.set(from, state);
        await sendWhatsAppText(from, `Show! Você escolheu a unidade ${UNIT_CONFIG[text].name}! 😄`);
        await sendPhoneConfirmation(from);
        return true;
    }
    // Phone confirmation
    if (text === 'phone_use_current') {
        if (!state.preferred_unit_name || !state.preferred_store_id) {
            await sendWhatsAppText(from, 'Perfeito! ✅ Antes de continuar, me confirma novamente a unidade da reserva para evitar qualquer erro.');
            await sendUnidadesMenu(from);
            return true;
        }
        state.reservation = state.reservation || {};
        state.reservation.phone_confirmed = true;
        state.reservation.contact_phone = from;
        if (!state.reservation.name) {
            const contactName = String(profileName || '').trim();
            if (contactName && !/^[\d+\s\-().]+$/.test(contactName)) {
                state.reservation.name = contactName;
            }
        }
        userStates.set(from, state);
        const msg = `Perfeito! Vou usar este número para a reserva na unidade ${state.preferred_unit_name}. ✅\n\nMe conta: quantos adultos e para quando?`;
        await sendWhatsAppText(from, msg);
        return true;
    }
    if (text === 'phone_ask_new') {
        state.reservation = state.reservation || {};
        state.reservation.phone_confirmed = false;
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Sem problemas 😊 Me envia o número que devo usar na reserva (com DDD), por favor.');
        return true;
    }
    if (isInActiveFlow(state) && state.preferred_unit_name && !state.reservation?.phone_confirmed) {
        state.reservation = state.reservation || {};
        const extractedPhone = extractPhoneCandidate(text);
        if (extractedPhone) {
            state.reservation.contact_phone = extractedPhone;
            state.reservation.phone_confirmed = true;
            if (!state.reservation.name) {
                const contactName = String(profileName || '').trim();
                if (contactName && !/^[\d+\s\-().]+$/.test(contactName)) {
                    state.reservation.name = contactName;
                }
            }
            userStates.set(from, state);
            if (hasCompleteReservationData(state.reservation)) {
                await sendWhatsAppText(from, `Perfeito! Vou usar este número para a reserva na unidade ${state.preferred_unit_name}. ✅`);
                await sendReservationConfirmationOrBlock(from, state);
                return true;
            }
            const missing = getMissingReservationFields(state.reservation);
            await sendWhatsAppText(from, `Perfeito! ✅ Agora me confirma ${missing.join(' e ')}.`);
            return true;
        }
        const extracted = parseReservationDetails(text);
        if (Object.keys(extracted).length > 0) {
            state.reservation = { ...(state.reservation || {}), ...extracted };
            userStates.set(from, state);
        }
        const phonePrompt = Object.keys(extracted).length > 0
            ? `Anotei esses dados para a reserva na unidade ${state.preferred_unit_name}. ✅ Agora só preciso confirmar qual telefone devo usar.`
            : `Para seguir com a reserva na unidade ${state.preferred_unit_name}, preciso confirmar qual telefone devo usar. 😊`;
        await sendWhatsAppText(from, phonePrompt);
        await sendPhoneConfirmation(from);
        return true;
    }
    // Reservation flow guard: user sent only date/time (without people count)
    if (timeOnlyPattern && isInActiveFlow(state)) {
        const extracted = parseReservationDetails(text);
        state.reservation = { ...(state.reservation || {}), ...extracted };
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Perfeito! ✅ Agora me diz *quantos adultos* serão na reserva.');
        return true;
    }
    // Confirmation buttons
    if (text === 'confirm_reserva_sim') {
        await sendWhatsAppText(from, 'Perfeito! ✅ Estou verificando sua reserva agora, só um instante...');
        const done = await createReservationDeterministic(from, state);
        if (done.ok) {
            const confirmedSticker = await db_1.db.getConfig('reservation_confirmed_sticker_media');
            if (confirmedSticker)
                await sendWhatsAppSticker(from, confirmedSticker);
        }
        await sendWhatsAppText(from, done.message);
        if (!done.ok) {
            const suggestWait = done.message.toLowerCase().includes('alguns minutos');
            if (!suggestWait) {
                await sendReservationConfirmationOrBlock(from, state);
            }
        }
        return true;
    }
    if (text === 'confirm_reserva_nao') {
        if (state.reservation)
            state.reservation.awaiting_confirmation = false;
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Sem problemas! 😊 Me diz o que você quer alterar (nome, data, horário, adultos ou crianças).');
        return true;
    }
    // Deterministic slot-filling while in active reservation flow
    if (isInActiveFlow(state) && state.reservation?.phone_confirmed) {
        const unitByText = UNIT_TEXT_MATCHERS.find((u) => u.rx.test(normalizedNoAccent));
        if (unitByText) {
            const unit = UNIT_CONFIG[unitByText.id];
            state.preferred_unit_name = unit.name;
            state.preferred_store_id = unit.storeId;
            userStates.set(from, state);
            await sendWhatsAppText(from, `Perfeito! ✅ Atualizei para a unidade ${unit.name}.`);
            await sendWhatsAppText(from, 'Agora me confirma os outros dados da reserva (adultos, data/horário e crianças, se houver).');
            return true;
        }
    }
    if (isInActiveFlow(state) && state.preferred_unit_name && state.reservation?.phone_confirmed) {
        const extracted = parseReservationDetails(text);
        let deltaAppliedMessage = null;
        if (state.reservation) {
            const deltas = extractPartyDeltas(text);
            if (deltas) {
                if (deltas.adultsDelta !== 0 && state.reservation.people !== undefined && extracted.people === undefined) {
                    extracted.people = Math.max(1, Number(state.reservation.people) + deltas.adultsDelta);
                }
                if (deltas.kidsDelta !== 0 && state.reservation.kids !== undefined && extracted.kids === undefined) {
                    extracted.kids = Math.max(0, Number(state.reservation.kids) + deltas.kidsDelta);
                }
                const parts = [];
                if (deltas.adultsDelta)
                    parts.push(`${deltas.adultsDelta > 0 ? '+' : ''}${deltas.adultsDelta} adultos`);
                if (deltas.kidsDelta)
                    parts.push(`${deltas.kidsDelta > 0 ? '+' : ''}${deltas.kidsDelta} crianças`);
                if (parts.length > 0) {
                    deltaAppliedMessage = `Perfeito, atualizei: ${parts.join(' e ')}. Quer manter data e horário?`;
                }
            }
        }
        // If only people is missing, accept "4" style answers.
        if (!extracted.people && !state.reservation?.people) {
            const onlyPeople = extractStandalonePeople(text);
            if (onlyPeople)
                extracted.people = onlyPeople;
        }
        if (Object.keys(extracted).length > 0) {
            state.reservation = { ...(state.reservation || {}), ...extracted };
            userStates.set(from, state);
            const missing = getMissingReservationFields(state.reservation);
            if (missing.length > 0) {
                if (deltaAppliedMessage &&
                    !extracted.date_text &&
                    !extracted.time_text &&
                    state.reservation.date_text &&
                    state.reservation.time_text) {
                    await sendWhatsAppText(from, deltaAppliedMessage);
                    return true;
                }
                await sendWhatsAppText(from, `Perfeito! ✅ Agora me confirma ${missing.join(' e ')}.`);
                return true;
            }
            userStates.set(from, state);
            await sendReservationConfirmationOrBlock(from, state);
            return true;
        }
        // Anti-loop: if all reservation data is already present, keep the user on confirmation step
        // instead of restarting data collection.
        if (hasCompleteReservationData(state.reservation)) {
            if (state.reservation)
                state.reservation.awaiting_confirmation = true;
            userStates.set(from, state);
            await sendWhatsAppText(from, 'Estamos quase lá ✅ Se estiver tudo certo no resumo, toque em *Sim, tudo certo!* para eu tentar concluir agora.');
            await sendReservationConfirmationOrBlock(from, state);
            return true;
        }
        // Stay deterministic while in active flow; avoid falling back to LLM on ambiguous turns.
        await sendWhatsAppText(from, 'Vamos seguir com a reserva 😊 Me manda adultos, data/horário e crianças (se houver), ou diga exatamente o que quer mudar.');
        return true;
    }
    return false;
}
// ============ Webhook Handlers ============
const verifyWebhook = (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === env_1.config.whatsapp.verifyToken) {
        console.log('Webhook verified');
        res.status(200).send(challenge);
    }
    else {
        res.sendStatus(403);
    }
};
exports.verifyWebhook = verifyWebhook;
const handleWhatsAppWebhook = async (req, res) => {
    const body = req.body;
    console.log('[WhatsApp] Webhook received.');
    if (!body) {
        res.status(400).send({ error: 'Empty body' });
        return;
    }
    // Extract messages
    const value = body.entry?.[0]?.changes?.[0]?.value;
    const messages = value?.messages || [];
    if (messages.length === 0) {
        res.status(200).send({ status: 'ignored' });
        return;
    }
    const message = messages[0];
    const messageId = message.id;
    const from = message.from;
    // CRITICAL: Check if this is from our own number (echo)
    const metadata = value?.metadata;
    if (metadata?.display_phone_number) {
        const ourNumber = metadata.display_phone_number.replace(/\D/g, '');
        if (from === ourNumber) {
            console.log(`[WhatsApp] Ignoring echo from our own number: ${from}`);
            res.status(200).send({ status: 'ignored/echo' });
            return;
        }
    }
    // Dedup via Redis
    const alreadyProcessed = await redis_1.redisService.isProcessed(messageId);
    if (alreadyProcessed) {
        console.log(`[WhatsApp] Duplicate message ID: ${messageId}`);
        res.status(200).send({ status: 'ignored/duplicate' });
        return;
    }
    await redis_1.redisService.markProcessed(messageId);
    // Rate limiting
    const state = userStates.get(from);
    const now = Date.now();
    if (state?.last_message_timestamp && (now - state.last_message_timestamp) < RATE_LIMIT_WINDOW_MS) {
        console.log(`[WhatsApp] Rate limiting ${from}`);
        res.status(200).send({ status: 'ignored/rate_limited' });
        return;
    }
    if (state) {
        state.last_message_timestamp = now;
        userStates.set(from, state);
    }
    // Stale check
    const messageTimestamp = parseInt(message.timestamp, 10);
    const nowEpoch = Math.floor(Date.now() / 1000);
    if (messageTimestamp && (nowEpoch - messageTimestamp) > 3600) {
        console.log(`[WhatsApp] Stale message (age: ${nowEpoch - messageTimestamp}s)`);
        res.status(200).send({ status: 'ignored/stale' });
        return;
    }
    res.status(200).send({ status: 'received' });
    // Process in background with queue
    enqueueUserJob(from, async () => {
        await processMessageInternal(message, value);
    });
};
exports.handleWhatsAppWebhook = handleWhatsAppWebhook;
function enqueueUserJob(userId, job) {
    const previous = userProcessingQueue.get(userId) || Promise.resolve();
    const next = previous.catch(() => { }).then(job);
    userProcessingQueue.set(userId, next.finally(() => {
        if (userProcessingQueue.get(userId) === next)
            userProcessingQueue.delete(userId);
    }));
}
async function checkBotActiveFast(phone) {
    const now = Date.now();
    const cached = botActiveCache.get(phone);
    if (cached && (now - cached.at) <= BOT_ACTIVE_CACHE_TTL_MS) {
        return cached.value;
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort();
    }, BOT_ACTIVE_TIMEOUT_MS);
    try {
        const value = await chatwoot_1.chatwootService.checkBotActive(phone, controller.signal);
        clearTimeout(timeoutId);
        botActiveCache.set(phone, { value, at: Date.now() });
        return value;
    }
    catch (err) {
        clearTimeout(timeoutId);
        console.warn(`[Chatwoot] checkBotActiveFast error or timeout for ${phone}:`, err?.message);
        return true; // Fallback to active
    }
}
async function processMessageInternal(message, value) {
    try {
        const from = message.from;
        const totalStart = Date.now();
        const logStep = (step, startedAt) => {
            console.log(`[Perf][${from}] ${step}: ${Date.now() - startedAt}ms`);
        };
        const contact = value?.contacts?.[0];
        const rawPushName = contact?.profile?.name || '';
        // Only treat as real name if it contains non-digit characters (not a phone number fallback)
        const hasRealName = rawPushName.trim().length > 0 && !/^[\d+\s\-().]+$/.test(rawPushName.trim());
        const userName = hasRealName ? rawPushName : from; // for Chatwoot / logs
        const userNameForAgent = hasRealName ? rawPushName : undefined; // undefined = agent will ask
        // Extract text
        let text = '';
        if (message.type === 'text') {
            text = message.text?.body || '';
        }
        else if (message.type === 'interactive') {
            text = message.interactive?.button_reply?.id ||
                message.interactive?.list_reply?.id ||
                message.interactive?.button_reply?.title ||
                message.interactive?.list_reply?.title || '';
        }
        else if (message.type === 'button') {
            text = message.button?.payload || message.button?.text || '';
        }
        if (!text) {
            console.log(`[WhatsApp] No text content in message from ${from}`);
            return;
        }
        console.log(`[WhatsApp] Raw from ${from}: "${text.substring(0, 100)}..."`);
        // CRITICAL: Check if this looks like a bot message (echo)
        if (isLikelyBotMessage(text)) {
            console.log(`[WhatsApp] Ignoring likely bot echo: "${text.substring(0, 50)}..."`);
            return;
        }
        // Extract actual user input (remove bot message pollution)
        text = extractUserInput(text);
        console.log(`[WhatsApp] Cleaned from ${from}: "${text.substring(0, 100)}..."`);
        // Content dedup
        const isDup = await redis_1.redisService.isDuplicateContent(from, text);
        if (isDup) {
            console.log(`[WhatsApp] Duplicate content from ${from}: "${text.substring(0, 50)}..."`);
            return;
        }
        // Check bot active
        const botActiveStart = Date.now();
        const botActive = await checkBotActiveFast(from);
        logStep('checkBotActive', botActiveStart);
        if (!botActive)
            return;
        // Send typing indicator
        sendTypingIndicator(from, message.id).catch(() => { });
        const chatwootIncomingText = formatIncomingForChatwoot(message, text);
        chatwoot_1.chatwootService.syncMessage(from, userName, chatwootIncomingText, 'incoming', { source: 'whatsapp' }).catch((err) => {
            console.error(`[Chatwoot] async incoming sync failed for ${from}:`, err?.message || err);
        });
        // Prompt injection check
        if (isPromptInjection(text)) {
            const msg = 'Não posso seguir esse tipo de instrução. Posso te ajudar com cardápio, reservas ou delivery.';
            await sendWhatsAppText(from, msg);
            await chatwoot_1.chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
            return;
        }
        // Get/create user state
        let state = userStates.get(from);
        if (!state) {
            const persistedState = await redis_1.redisService.getUserState(from);
            if (persistedState && typeof persistedState === 'object') {
                state = persistedState;
                userStates.set(from, state);
            }
        }
        state = state ?? {};
        const nowMs = Date.now();
        if (state.last_message_timestamp && (nowMs - state.last_message_timestamp) > FLOW_IDLE_RESET_MS) {
            if (state.reservation || state.preferred_store_id || state.preferred_unit_name) {
                console.log(`[Flow] Resetting stale in-progress flow for ${from} after ${nowMs - state.last_message_timestamp}ms inactivity`);
            }
            state.reservation = undefined;
            state.preferred_store_id = undefined;
            state.preferred_unit_name = undefined;
        }
        state.last_message_timestamp = nowMs;
        if (!userStates.has(from)) {
            userStates.set(from, state);
        }
        else {
            userStates.set(from, state);
        }
        // If confirmation is pending, accept plain-text confirmations as button equivalent.
        const textLower = text.toLowerCase().trim();
        const textNorm = textLower
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (state.reservation?.awaiting_confirmation &&
            /^(sim|ok|confirmo|confirmar|pode confirmar|pode finalizar|sim pode confirmar|sim pode finalizar|sim confirmar|sim finalizar|tudo certo|esta tudo certo)$/.test(textNorm)) {
            text = 'confirm_reserva_sim';
        }
        else if (state.reservation?.awaiting_confirmation && /^(nao|corrigir|alterar|mudar|nao esta certo)$/.test(textNorm)) {
            text = 'confirm_reserva_nao';
        }
        else if (state.reservation?.awaiting_cancellation && /^(sim|ok|confirmo|sim cancelar|pode cancelar)$/.test(textNorm)) {
            const pendingId = String(state.reservation?.pending_cancellation_id || '').trim();
            if (pendingId)
                text = `cancel_yes_${pendingId}`;
        }
        else if (state.reservation?.awaiting_cancellation && /^(nao|manter|nao cancelar)$/.test(textNorm)) {
            text = 'cancel_no';
        }
        // Try deterministic commands first
        beginOutboundCapture(from);
        const deterministicStart = Date.now();
        const handled = await handleDeterministicCommand(text, from, state, rawPushName);
        logStep('handleDeterministicCommand', deterministicStart);
        if (handled) {
            const summary = buildDeterministicSyncMessage(text, state);
            flushCapturedOutboundToChatwoot(from, userName, summary).catch((err) => {
                console.error(`[Chatwoot] async deterministic flush failed for ${from}:`, err?.message || err);
            });
            logStep('total_handled_deterministic', totalStart);
            return;
        }
        clearOutboundCapture(from);
        // Call LangChain agent
        const sessionId = `whatsapp_${from}`;
        const langchainStart = Date.now();
        const result = await langchain_1.langchainService.processMessage(sessionId, text, {
            phone: from,
            user_name: userNameForAgent, // undefined when no push name → agent will ask
            preferred_store_id: state.preferred_store_id,
            preferred_unit_name: state.preferred_unit_name,
            preferred_city: state.preferred_city,
            reservation_state: state.reservation
        }, {
            // Confirmation can involve slower MCP operations (availability/create).
            timeoutMs: text === 'confirm_reserva_sim' ? 70000 : undefined
        });
        logStep('langchain.processMessage', langchainStart);
        // Handle UI actions from Python
        if (result.ui_action) {
            // First, apply any reservation_state updates from Python agent
            if (result.state_updates?.reservation_state) {
                const rs = result.state_updates.reservation_state;
                state.reservation = {
                    ...(state.reservation || {}),
                    name: rs.name ?? state.reservation?.name,
                    date_text: rs.date_text ?? state.reservation?.date_text,
                    time_text: rs.time_text ?? state.reservation?.time_text,
                    people: rs.people ?? state.reservation?.people,
                    kids: rs.kids ?? state.reservation?.kids,
                    contact_phone: rs.contact_phone ?? state.reservation?.contact_phone,
                    phone_confirmed: rs.phone_confirmed ?? state.reservation?.phone_confirmed,
                };
                userStates.set(from, state);
                console.log(`[State] Reservation state updated from Python:`, state.reservation);
            }
            switch (result.ui_action.type) {
                case 'show_confirmation_menu':
                    await sendReservationConfirmationOrBlock(from, state);
                    break;
                case 'show_main_menu':
                    await sendMainMenu(from, !!state.has_interacted);
                    state.reservation = undefined;
                    userStates.set(from, state);
                    break;
                case 'show_cardapio_menu':
                    await sendCitiesMenu(from);
                    break;
                case 'show_delivery_menu':
                    await sendDeliveryCitiesMenu(from);
                    break;
                case 'show_unidades_menu':
                    await sendUnidadesMenu(from);
                    break;
                case 'show_cancel_confirmation':
                    const resId = result.ui_action.data?.reservation_id;
                    if (resId) {
                        await sendCancelConfirmationMenu(from, resId, result.response);
                    }
                    break;
                default:
                    if (result.response) {
                        const safeResponse = sanitizeAgentFallbackPhone(sanitizeWhatsAppText(result.response), from, state);
                        const sendStart = Date.now();
                        await sendWhatsAppText(from, safeResponse);
                        logStep('sendWhatsAppText(default_ui_action)', sendStart);
                        chatwoot_1.chatwootService.syncMessage(from, userName, safeResponse, 'outgoing', { source: 'bot' }).catch((err) => {
                            console.error(`[Chatwoot] async outgoing sync failed for ${from}:`, err?.message || err);
                        });
                    }
            }
        }
        else {
            // Regular text response
            if (result.response) {
                const safeResponse = sanitizeAgentFallbackPhone(sanitizeWhatsAppText(result.response), from, state);
                const sendStart = Date.now();
                await sendWhatsAppText(from, safeResponse);
                logStep('sendWhatsAppText(regular)', sendStart);
                chatwoot_1.chatwootService.syncMessage(from, userName, safeResponse, 'outgoing', { source: 'bot' }).catch((err) => {
                    console.error(`[Chatwoot] async outgoing sync failed for ${from}:`, err?.message || err);
                });
                if (shouldOfferMainMenu(result, state)) {
                    await sendMainMenu(from, true);
                    chatwoot_1.chatwootService.syncMessage(from, userName, '[MENU_INTERATIVO]', 'outgoing', { source: 'bot' }).catch((err) => {
                        console.error(`[Chatwoot] async outgoing menu sync failed for ${from}:`, err?.message || err);
                    });
                }
            }
        }
        // Update state from any remaining state_updates keys
        if (result.state_updates) {
            const { reservation_state, ...rest } = result.state_updates;
            const nextState = { ...(state || {}), ...rest };
            state = nextState;
            userStates.set(from, nextState);
        }
        // Mark as interacted
        state = state || {};
        state.has_interacted = true;
        userStates.set(from, state);
        logStep('total', totalStart);
    }
    catch (error) {
        clearOutboundCapture(message?.from || '');
        console.error('[WhatsApp] Error processing message:', error);
    }
}
