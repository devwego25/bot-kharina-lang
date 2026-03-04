/**
 * REFACTORED WhatsApp Service - Using Python LangChain Agent
 * 
 * Correções aplicadas:
 * - Deduplicação de mensagens (content-based)
 * - Filtro de echo (mensagens do bot)
 * - Parsing correto de mensagens interativas
 * - Rate limiting por usuário
 */

import type { Request, Response } from 'express';
import { config } from '../config/env';
import { redisService } from './redis';
import { chatwootService } from './chatwoot';
import { db } from './db';
import { langchainService } from './langchain';
import { McpClient } from './mcp';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

// State management types
interface ReservationState {
  people?: number;
  kids?: number;
  phone_confirmed?: boolean;
  contact_phone?: string;
  awaiting_confirmation?: boolean;
  awaiting_cancellation?: boolean;
  name?: string;
  date_text?: string;
  time_text?: string;
  occasion?: string;
  notes?: string;
  pending_change_source_id?: string;
  pending_change_source_code?: string;
  pending_cancellation_id?: string;
  pending_cancellation_code?: string;
  pending_cancellation_all_ids?: string[];
}

interface UserState {
  preferred_city?: string;
  preferred_store_id?: string;
  preferred_unit_name?: string;
  has_interacted?: boolean;
  last_interactive_menu?: string;
  last_message_timestamp?: number;
  reservation?: ReservationState;
}

// In-memory state (consider moving to Redis for multi-instance)
const userStates = new Map<string, UserState>();
const lastOutboundByUser = new Map<string, { hash: string; at: number }>();
const interactiveDegradedUntil = new Map<string, number>();
const userProcessingQueue = new Map<string, Promise<void>>();
const botActiveCache = new Map<string, { value: boolean; at: number }>();

const INTERACTIVE_DEGRADED_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 1000; // 1 second between messages
const GRAPH_API_TIMEOUT_MS = 8000;
const BOT_ACTIVE_CACHE_TTL_MS = 15_000;
const BOT_ACTIVE_TIMEOUT_MS = 700;
const SCOPE_ONLY_MSG = 'Só posso ajudar com assuntos do restaurante: cardápio, reservas e delivery.';

// Command sets
const MENU_COMMANDS = new Set(['MENU_PRINCIPAL', 'menu_cardapio', 'menu_reserva', 'menu_delivery']);
const GREETING_COMMANDS = new Set(['oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite']);
const GREETING_REGEX = /\b(oi|ol[áa]|bom dia|boa tarde|boa noite|e ai|e aí|opa|tudo bem|tudo bom)\b/i;
const UNIT_CONFIG: Record<string, { name: string; storeId: string }> = {
  unidade_botanico: { name: 'Jardim Botânico', storeId: 'a99c098f-c16b-4168-a5b1-54e76aa1a855' },
  unidade_cabral: { name: 'Cabral', storeId: 'c6919b3c-f5ff-4006-a226-2b493d9d8cf5' },
  unidade_agua_verde: { name: 'Água Verde', storeId: 'fde9ba37-baff-4958-b6be-5ced7059864c' },
  unidade_batel: { name: 'Batel', storeId: 'b45c9b5e-4f79-47b1-a442-ea8fb9d6e977' },
  unidade_portao: { name: 'Portão', storeId: 'f0f6ae17-01d1-4c51-a423-33222f8fcd5c' },
  unidade_londrina: { name: 'Londrina', storeId: '3e027375-3049-4080-98c3-9f7448b8fd62' },
  unidade_saopaulo: { name: 'São Paulo', storeId: '03dc5466-6c32-4e9e-b92f-c8b02e74bba6' }
};

// Bot message patterns to ignore (echo detection)
const BOT_MESSAGE_PATTERNS = [
  /^(opa!? ?👋? ?eu sou a kha|beleza!? ?👌|escolha uma opção|escolhe a cidade|qual unidade)/i,
  /^(perfeito!? ?aqui está o cardápio|show!?) ?🍽?/i,
  /^(você quer fazer um novo pedido|sinto muito pelo problema)/i,
  /^(prontinho!? ?✅? ?já encaminhei)/i,
];

const reservasMcp = new McpClient(
  process.env.MCP_RESERVAS_URL || 'https://mcp.reservas.wegosb.com.br/mcp',
  'Reservas',
  process.env.MCP_RESERVAS_TOKEN,
  false,
  'streamable'
);
let reservasMcpInitPromise: Promise<boolean> | null = null;

// ============ Helper Functions ============

function normalizeForOutboundDedupe(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeUnitName(value: string): string {
  return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function formatBrazilPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  const br = digits.startsWith('55') ? digits.slice(2) : digits;
  if (br.length === 11) return `(${br.slice(0, 2)}) ${br.slice(2, 7)}-${br.slice(7)}`;
  if (br.length === 10) return `(${br.slice(0, 2)}) ${br.slice(2, 6)}-${br.slice(6)}`;
  return raw;
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nextWeekdayDate(targetWeekday: number, fromDate: Date = new Date()): Date {
  const base = new Date(fromDate);
  base.setHours(0, 0, 0, 0);
  const todayWeekday = base.getDay();
  let diff = (targetWeekday - todayWeekday + 7) % 7;
  if (diff === 0) diff = 7;
  base.setDate(base.getDate() + diff);
  return base;
}

function nextDayOfMonthDate(targetDay: number, fromDate: Date = new Date()): Date | null {
  if (targetDay < 1 || targetDay > 31) return null;
  const base = new Date(fromDate);
  base.setHours(0, 0, 0, 0);
  const year = base.getFullYear();
  const month = base.getMonth();

  const candidateCurrent = new Date(year, month, targetDay);
  if (candidateCurrent.getMonth() === month && candidateCurrent >= base) return candidateCurrent;

  const candidateNext = new Date(year, month + 1, targetDay);
  if (candidateNext.getDate() === targetDay) return candidateNext;
  return null;
}

function toBrDate(isoOrBr: string): string {
  const v = String(isoOrBr || '').trim();
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return v;
}

function parseReservationDetails(text: string): Partial<ReservationState> {
  const raw = String(text || '').trim();
  const t = raw.toLowerCase();
  const updates: Partial<ReservationState> = {};

  const peopleMatch =
    t.match(/\b(\d+)\s*(pessoa|pessoas|adulto|adultos)\b/) ||
    t.match(/\b(pessoas?|adultos?)\s*(\d+)\b/);
  if (peopleMatch) {
    const val = parseInt((peopleMatch[1] || peopleMatch[2] || '0'), 10);
    if (!Number.isNaN(val) && val > 0) updates.people = val;
  }

  if (/sem crian/.test(t) || /\b0\s*(crianca|criança|criancas|crianças)\b/.test(t)) {
    updates.kids = 0;
  } else {
    const kidsMatch = t.match(/\b(\d+)\s*(crianca|criança|criancas|crianças)\b/);
    if (kidsMatch) {
      const k = parseInt(kidsMatch[1], 10);
      if (!Number.isNaN(k) && k >= 0) updates.kids = k;
    }
  }

  const today = new Date();
  if (/\bhoje\b/.test(t)) {
    updates.date_text = toIsoDate(today);
  } else if (/\bamanh/.test(t)) {
    const d = new Date(today);
    d.setDate(d.getDate() + 1);
    updates.date_text = toIsoDate(d);
  } else {
    const weekdayMap: Array<{ rx: RegExp; day: number }> = [
      { rx: /\b(domingo)\b/, day: 0 },
      { rx: /\b(segunda|segunda-feira)\b/, day: 1 },
      { rx: /\b(terca|terça|terca-feira|terça-feira)\b/, day: 2 },
      { rx: /\b(quarta|quarta-feira)\b/, day: 3 },
      { rx: /\b(quinta|quinta-feira)\b/, day: 4 },
      { rx: /\b(sexta|sexta-feira)\b/, day: 5 },
      { rx: /\b(sabado|sábado)\b/, day: 6 }
    ];
    const byWeekday = weekdayMap.find((w) => w.rx.test(t));
    if (byWeekday) {
      updates.date_text = toIsoDate(nextWeekdayDate(byWeekday.day, today));
    }
  }

  if (!updates.date_text) {
    const dmY = t.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (dmY) {
      const day = parseInt(dmY[1], 10);
      const mon = parseInt(dmY[2], 10);
      let year = dmY[3] ? parseInt(dmY[3], 10) : today.getFullYear();
      if (year < 100) year += 2000;
      if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
        updates.date_text = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  if (!updates.date_text) {
    const dayOnly = t.match(/\b(?:proximo|próximo)?\s*dia\s*(\d{1,2})\b/);
    if (dayOnly) {
      const day = parseInt(dayOnly[1], 10);
      const date = nextDayOfMonthDate(day, today);
      if (date) updates.date_text = toIsoDate(date);
    }
  }

  let hh: string | null = null;
  let mm = '00';
  if (/\bmeio\s*dia\b/.test(t)) {
    hh = '12';
  } else if (/\bmeia\s*noite\b/.test(t)) {
    hh = '00';
  }
  const hm = t.match(/\b(\d{1,2})[:h](\d{2})\b/);
  if (!hh && hm) {
    hh = hm[1];
    mm = hm[2];
  } else {
    const hOnly = t.match(/\b(\d{1,2})\s*(h|hora|horas)\b/);
    if (!hh && hOnly) hh = hOnly[1];
    else {
      const hWord = t.match(/\b(?:as|às)\s*(\d{1,2})\b/);
      if (!hh && hWord && /(noite|tarde|manha|manhã)/.test(t)) hh = hWord[1];
    }
  }
  if (hh !== null) {
    let h = parseInt(hh, 10);
    if (/noite|tarde/.test(t) && h >= 1 && h <= 11) h += 12;
    if (h >= 0 && h <= 23) updates.time_text = `${String(h).padStart(2, '0')}:${mm}`;
  }

  const noteMarkers = [
    'obs', 'observa', 'anivers', 'janela', 'parquinho', 'perto do parquinho',
    'cadeira de bebe', 'cadeirinha', 'cadeirante', 'acessivel', 'acessível',
    'alerg', 'intoler', 'sem gluten', 'sem glúten', 'vegano', 'vegetar'
  ];
  const hasNoteMarker = noteMarkers.some((m) => t.includes(m));
  const onlyKidsAnswer = /^(\s*(sem crian|não|nao|nenhuma|0)\s*)+$/.test(t);
  if (hasNoteMarker && !onlyKidsAnswer) {
    updates.notes = raw.replace(/\s+/g, ' ').trim();
  }

  return updates;
}

function extractStandalonePeople(text: string): number | null {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return null;
  // Ignore obvious date/time-only messages
  if (/\b(\d{1,2})[:h](\d{2})\b/.test(t) || /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(t)) return null;
  if (/\b(crian|hora|horas|h|amanh|hoje|domingo|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|dia)\b/.test(t)) return null;
  const m = t.match(/^\D*(\d{1,2})\D*$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (Number.isNaN(n) || n <= 0 || n > 30) return null;
  return n;
}

function sanitizeWhatsAppText(text: string): string {
  if (!text) return text;
  return text
    .replace(/\*\*/g, '*')
    .replace(/```/g, '')
    .replace(/\s*\(\d{4}-\d{2}-\d{2}\)/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$2')
    .replace(/^[#{1,6}]\s+/gm, '')
    .trim();
}

function shouldOfferMainMenu(result: any, state?: UserState): boolean {
  const intent = String(result?.intent || '').toLowerCase();
  const response = String(result?.response || '').toLowerCase();

  if (intent === 'error') {
    // Don't reset to main menu if user is in the middle of reservation flow.
    if (isInActiveFlow(state)) return false;
    return true;
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
    if (noReservationHints.some((hint) => response.includes(hint))) return true;
  }

  return false;
}

function isPromptInjection(text: string): boolean {
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
function isLikelyBotMessage(text: string): boolean {
  if (!text) return false;

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
function extractUserInput(text: string): string {
  if (!text) return text;

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

async function ensureReservasMcpReady(): Promise<boolean> {
  if (reservasMcp.ready) return true;
  if (!reservasMcpInitPromise) {
    reservasMcp.connect();
    reservasMcpInitPromise = reservasMcp.waitReady(20000).finally(() => {
      reservasMcpInitPromise = null;
    });
  }
  return reservasMcpInitPromise;
}

function toDigitsPhone(raw: string): string {
  return String(raw || '').replace(/\D/g, '');
}

function parseMcpToolText(result: any): any {
  try {
    const text = result?.content?.[0]?.text;
    if (typeof text === 'string' && text.trim()) return JSON.parse(text);
  } catch { }
  return result;
}

function normalizeIsoDate(value: string): string {
  const v = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return v;
}

function normalizeTime(value: string): string {
  const v = String(value || '').trim();
  const m = v.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m) return v;
  return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}

function pickReservationCode(res: any): { id?: string; code?: string; status?: string } {
  const payload = parseMcpToolText(res);
  if (!payload || typeof payload !== 'object') return {};
  return {
    id: payload.reservationId || payload.id || payload.data?.id,
    code: payload.code || payload.reservationCode || payload.confirmationCode || payload.data?.code || payload.data?.confirmationCode,
    status: payload.status || payload.data?.status
  };
}

function displayReservationCode(picked: { id?: string; code?: string }): string | undefined {
  if (picked.code && String(picked.code).trim()) return String(picked.code).trim().toUpperCase();
  if (picked.id && String(picked.id).trim()) return String(picked.id).trim().split('-')[0].toUpperCase();
  return undefined;
}

function statusLabel(raw: any): string {
  const v = String(raw || '').toLowerCase();
  const map: Record<string, string> = {
    confirmed: 'Confirmada',
    waiting: 'Em espera',
    cancelled: 'Cancelada',
    canceled: 'Cancelada'
  };
  return map[v] || String(raw || '');
}

async function buildCardapioMessage(cardapioCommand: string): Promise<string> {
  const city = cardapioCommand.replace('cardapio_', '');
  const baseMap: Record<string, string> = {
    curitiba: 'https://cardapio.kharina.com.br/curitiba',
    londrina: 'https://cardapio.kharina.com.br/londrina',
    saopaulo: 'https://cardapio.kharina.com.br/saopaulo'
  };

  const cityLabelMap: Record<string, string> = {
    curitiba: 'Curitiba',
    londrina: 'Londrina',
    saopaulo: 'São Paulo'
  };
  const dynamic = await db.getConfig(`link_cardapio_${city}`);
  const legacySp = city === 'saopaulo' ? await db.getConfig('link_cardapio_sp') : null;
  const url = dynamic || legacySp || baseMap[city] || 'https://cardapio.kharina.com.br/';
  return `Perfeito! Aqui está o cardápio de ${cityLabelMap[city] || city} 🍽️\n👉 ${url}`;
}

type ActiveReservation = {
  reservationId: string;
  code: string;
  storeId: string;
  storeName: string;
  date: string;
  time: string;
  people: number;
  status: string;
};

type ReservationMatchInput = {
  phone: string;
  storeId: string;
  date: string;
  time: string;
  people: number;
};

function extractReservationsList(payload: any): any[] {
  if (!payload) return [];
  if (Array.isArray(payload?.reservations)) return payload.reservations;
  if (Array.isArray(payload?.data?.reservations)) return payload.data.reservations;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function fetchActiveReservations(phoneRaw: string): Promise<ActiveReservation[]> {
  const phone = toDigitsPhone(phoneRaw);
  const mcpReady = await ensureReservasMcpReady();
  if (!mcpReady) return [];
  const result = await reservasMcp.callTool('query_reservations', { clientPhone: phone });
  const payload = parseMcpToolText(result);
  const all = extractReservationsList(payload);
  return all
    .filter((x: any) => !String(x?.status || '').toLowerCase().includes('cancel'))
    .map((x: any) => ({
      reservationId: String(x?.reservationId || x?.id || ''),
      code: displayReservationCode({ id: x?.reservationId || x?.id, code: x?.code || x?.reservationCode || x?.confirmationCode }) || 'N/A',
      storeId: String(x?.storeId || ''),
      storeName: String(x?.storeName || x?.store || 'N/A'),
      date: String(x?.date || ''),
      time: normalizeTime(String(x?.time || '')),
      people: Number(x?.numberOfPeople ?? x?.people ?? 0),
      status: statusLabel(x?.status)
    }))
    .filter((x: ActiveReservation) => x.reservationId);
}

async function fetchActiveReservationsWithRetry(phoneRaw: string): Promise<ActiveReservation[]> {
  try {
    return await fetchActiveReservations(phoneRaw);
  } catch (err1: any) {
    console.error('[ReservasDeterministic] fetch active reservations failed (attempt 1):', err1?.message || err1);
    await new Promise((r) => setTimeout(r, 500));
    try {
      return await fetchActiveReservations(phoneRaw);
    } catch (err2: any) {
      console.error('[ReservasDeterministic] fetch active reservations failed (attempt 2):', err2?.message || err2);
      return [];
    }
  }
}

async function findReservationMatchWithId(input: ReservationMatchInput): Promise<{ id?: string; code?: string; status?: string } | null> {
  const verifyResult = await reservasMcp.callTool('query_reservations', { clientPhone: input.phone });
  const verifyPayload = parseMcpToolText(verifyResult);
  const items = extractReservationsList(verifyPayload);
  const matched = items.find((x: any) =>
    normalizeIsoDate(x?.date) === input.date &&
    normalizeTime(x?.time) === input.time &&
    Number(x?.numberOfPeople || x?.people) === input.people &&
    String(x?.storeId || '').toLowerCase() === String(input.storeId).toLowerCase() &&
    !String(x?.status || '').toLowerCase().includes('cancel')
  );
  if (!matched) return null;

  const id = matched.reservationId || matched.id;
  if (!id) return null;
  return {
    id,
    code: matched.code || matched.reservationCode || matched.confirmationCode,
    status: matched.status
  };
}

async function waitForReservationMatchWithId(
  input: ReservationMatchInput,
  attempts = 6,
  intervalMs = 1500
): Promise<{ id?: string; code?: string; status?: string } | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      const hit = await findReservationMatchWithId(input);
      if (hit?.id) return hit;
    } catch (err: any) {
      console.error('[ReservasDeterministic] wait match attempt failed:', err?.message || err);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

async function sendManageReservationMenu(to: string, action: 'cancel' | 'alter', reservations: ActiveReservation[]): Promise<void> {
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
  await sendInteractiveWithFallback(
    to,
    payload,
    action === 'cancel' ? 'send_cancel_pick_menu' : 'send_alter_pick_menu',
    `${title}\n` + reservations.map((r, i) => `${i + 1}. ${r.code} - ${toBrDate(r.date)} ${r.time} (${r.storeName})`).join('\n')
  );
}

async function queryReservationsDeterministic(from: string): Promise<{ ok: boolean; message: string }> {
  try {
    const phone = toDigitsPhone(from);
    const mcpReady = await ensureReservasMcpReady();
    if (!mcpReady) {
      return { ok: false, message: 'Tive uma instabilidade para consultar suas reservas agora 😕' };
    }
    const result = await reservasMcp.callTool('query_reservations', { clientPhone: phone });
    const payload = parseMcpToolText(result);
    const all = extractReservationsList(payload);

    if (all.length === 0) {
      return { ok: true, message: 'Não encontrei reservas no seu número no momento.' };
    }

    const lines = ['Encontrei estas reservas no seu número:'];
    all.slice(0, 8).forEach((r: any, idx: number) => {
      const code = displayReservationCode({
        id: r?.reservationId || r?.id,
        code: r?.code || r?.reservationCode || r?.confirmationCode
      }) || 'N/A';
      lines.push(
        `${idx + 1}. 🔢 Código: ${code}\n` +
        `📍 Unidade: ${r?.storeName || r?.store || 'N/A'}\n` +
        `📅 Data: ${toBrDate(r?.date || '')}\n` +
        `⏰ Horário: ${normalizeTime(r?.time || '')}\n` +
        `👥 Total de pessoas: ${r?.numberOfPeople ?? r?.people ?? 'N/A'}\n` +
        `✅ Status: ${statusLabel(r?.status)}`
      );
    });
    const hasActive = all.some((x: any) => !String(x?.status || '').toLowerCase().includes('cancel'));
    lines.push(hasActive
      ? 'Se quiser, eu também posso cancelar ou alterar uma reserva ativa.'
      : 'No momento, todas as reservas listadas estão canceladas.');
    return { ok: true, message: lines.join('\n\n') };
  } catch (err: any) {
    console.error('[ReservasDeterministic] query_reservations failed:', err?.message || err);
    return { ok: false, message: 'Não consegui consultar suas reservas agora. Pode tentar novamente em instantes?' };
  }
}

async function createReservationDeterministic(from: string, state: UserState): Promise<{ ok: boolean; message: string; }> {
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
      const recoveredCode = displayReservationCode(preExisting);
      const recoveredStatus = preExisting.status ? statusLabel(preExisting.status) : undefined;
      const recoveredLines = [
        `Reserva confirmada com sucesso na unidade ${unitName}! 🎉`,
        `📅 Data: ${toBrDate(date)}`,
        `⏰ Horário: ${time}`,
        `👨 Adultos: ${adults}`,
        `👶 Crianças: ${kids}`,
        `👥 Total: ${totalPeople}`,
        recoveredCode ? `🔢 Código da reserva: ${recoveredCode}` : `🆔 ID da reserva: ${preExisting.id}`,
        recoveredStatus ? `✅ Status: ${recoveredStatus}` : ''
      ].filter(Boolean);
      state.reservation = undefined;
      userStates.set(from, state);
      return { ok: true, message: recoveredLines.join('\n') };
    }

    let createResult: any;
    try {
      createResult = await reservasMcp.callTool('create_reservation', createArgs);
    } catch (err: any) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('client') || msg.includes('cliente') || msg.includes('not found') || msg.includes('não encontrado')) {
        if (name) {
          await reservasMcp.callTool('create_client', { name, phone });
          createResult = await reservasMcp.callTool('create_reservation', createArgs);
        } else {
          throw err;
        }
      } else {
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

    const displayCode = displayReservationCode(picked);
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
      chatwootService.syncMessage(
        from,
        name || from,
        alertMsg,
        'outgoing',
        { source: 'system', kind: 'reservation_alert', reason: 'missing_reservation_id' },
        true
      ).catch((err) => {
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
        await reservasMcp.callTool('cancel_reservation', {
          reservationId: previousReservationId,
          reason: 'Alteração solicitada pelo cliente via WhatsApp'
        });
      } catch (cancelErr: any) {
        console.error('[ReservasDeterministic] cancel old reservation after alter failed:', cancelErr?.message || cancelErr);
      }
    }

    const lines = [
      `Reserva confirmada com sucesso na unidade ${unitName}! 🎉`,
      `📅 Data: ${toBrDate(date)}`,
      `⏰ Horário: ${time}`,
      `👨 Adultos: ${adults}`,
      `👶 Crianças: ${kids}`,
      `👥 Total: ${totalPeople}`,
      displayCode ? `🔢 Código da reserva: ${displayCode}` : '',
      previousReservationCode ? `🔁 Alteração concluída (reserva anterior: ${previousReservationCode}).` : '',
      status ? `✅ Status: ${status}` : ''
    ].filter(Boolean);

    state.reservation = undefined;
    userStates.set(from, state);
    return { ok: true, message: lines.join('\n') };
  } catch (err: any) {
    console.error('[ReservasDeterministic] create_reservation failed:', err?.message || err);
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
    chatwootService.syncMessage(
      from,
      rr.name || from,
      alertMsg,
      'outgoing',
      { source: 'system', kind: 'reservation_alert', reason: 'create_reservation_exception' },
      true
    ).catch((cwErr) => {
      console.error('[Chatwoot] reservation alert failed:', cwErr?.message || cwErr);
    });
    if (state.reservation) state.reservation.awaiting_confirmation = true;
    userStates.set(from, state);
    return {
      ok: false,
      message: 'Tive uma instabilidade para concluir sua reserva agora 😕\nPor favor, tente novamente em alguns minutos. Nosso time também foi alertado para verificar.'
    };
  }
}

// ============ Graph API Helpers ============

async function postGraphMessage(payload: any, label: string, retries = 2): Promise<void> {
  let lastErr: any = null;
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  const httpsAgent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;

  const axiosConfig: any = {
    headers: { Authorization: `Bearer ${config.whatsapp.token}` },
    timeout: GRAPH_API_TIMEOUT_MS
  };
  if (proxyUrl) {
    axiosConfig.httpsAgent = httpsAgent;
    axiosConfig.proxy = false;
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await axios.post(
        `https://graph.facebook.com/v24.0/${config.whatsapp.phoneId}/messages`,
        payload,
        axiosConfig
      );
      const graphMsgId = (resp?.data as any)?.messages?.[0]?.id;
      if (graphMsgId) {
        console.log(`[WhatsApp] ${label} Graph message id: ${graphMsgId}`);
      }
      return;
    } catch (err: any) {
      lastErr = err;
      console.error(`[WhatsApp] ${label} failed (attempt ${attempt + 1}/${retries + 1}):`, err.message);
      if (attempt === retries) break;
      await new Promise(r => setTimeout(r, attempt === 0 ? 300 : 800));
    }
  }
  throw lastErr;
}

export async function sendWhatsAppText(to: string, text: string): Promise<void> {
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
  console.log(`[WhatsApp] Sent to ${to}: "${text.substring(0, 80)}..."`);
}

async function sendTypingIndicator(to: string, messageId: string): Promise<void> {
  try {
    await postGraphMessage({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" }
    }, 'send_typing', 1);
  } catch { }
}

async function sendInteractiveWithFallback(
  to: string,
  menuPayload: any,
  label: string,
  fallbackText?: string
): Promise<boolean> {
  const now = Date.now();
  const degradedUntil = interactiveDegradedUntil.get(to) || 0;

  if (degradedUntil > now) {
    if (fallbackText) await sendWhatsAppText(to, fallbackText);
    return false;
  }

  try {
    await postGraphMessage(menuPayload, label, 2);
    console.log(`[WhatsApp] Interactive sent successfully: ${label} to ${to}`);
    return true;
  } catch (err: any) {
    console.error(`[WhatsApp] ${label} failed:`, err.message);
    interactiveDegradedUntil.set(to, now + INTERACTIVE_DEGRADED_WINDOW_MS);
    if (fallbackText) await sendWhatsAppText(to, fallbackText);
    return false;
  }
}

// ============ Menu Functions ============

async function sendMainMenu(to: string, compact = false): Promise<void> {
  // Prevent duplicate menu sends
  const lastHash = lastOutboundByUser.get(to)?.hash;
  const menuHash = normalizeForOutboundDedupe(compact ? "compact_menu" : "full_menu");
  if (lastHash === menuHash) {
    console.log(`[Menu] Skipping duplicate main menu for ${to}`);
    return;
  }

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
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
  await sendInteractiveWithFallback(to, payload, 'send_main_menu',
    'Escolha: 1) Ver Cardápio 2) Reservar Mesa 3) Delivery');
}

async function sendCitiesMenu(to: string): Promise<void> {
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
  await sendInteractiveWithFallback(to, payload, 'send_cities_menu',
    'Escolha a cidade: Curitiba, Londrina ou São Paulo.');
}

async function sendUnidadesMenu(to: string): Promise<void> {
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
  await sendInteractiveWithFallback(to, payload, 'send_unidades_menu',
    'Qual unidade? (Jardim Botânico, Cabral, Água Verde, Batel, Portão, Londrina ou São Paulo).');
}

async function sendPhoneConfirmation(to: string): Promise<void> {
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
  await sendInteractiveWithFallback(to, payload, 'send_phone_confirmation',
    'Posso usar este número para a reserva? Responda "sim" ou "não, usar outro".');
}

async function sendConfirmationMenu(to: string, state: UserState): Promise<void> {
  const resv = state.reservation || {};
  const unit = state.preferred_unit_name || '❓ Pendente';

  const checklist = [
    `Dá uma olhada no resumo da sua reserva:`,
    `- 👤 Nome: ${resv.name || '❓ Pendente'}`,
    `- 📱 Celular: ${formatBrazilPhone(resv.contact_phone || '')}`,
    `- 📅 Data: ${resv.date_text || '❓ Pendente'}`,
    `- ⏰ Horário: ${resv.time_text || '❓ Pendente'}`,
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
  await sendInteractiveWithFallback(to, payload, 'send_confirmation_menu',
    `${checklist}\n\nOs dados estão corretos? Responda "sim" ou "não, mudar algo".`);
}

async function sendCancelConfirmationMenu(to: string, reservationId: string, preamble: string): Promise<void> {
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
  await sendInteractiveWithFallback(to, payload, 'send_cancel_confirmation',
    `${preamble} Responda "Sim, cancelar" ou "Não".`);
}

async function sendCancelAllConfirmationMenu(to: string, count: number): Promise<void> {
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
  await sendInteractiveWithFallback(to, payload, 'send_cancel_all_confirmation',
    `${preamble} Responda "Sim, cancelar todas" ou "Não".`);
}

async function sendDeliveryChoiceMenu(to: string): Promise<void> {
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
  await sendInteractiveWithFallback(to, payload, 'send_delivery_choice_menu',
    'Você quer: "Novo Pedido" ou "Preciso de Ajuda"?');
}

async function sendDeliveryCitiesMenu(to: string): Promise<void> {
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
  await sendInteractiveWithFallback(to, payload, 'send_delivery_cities_menu',
    'De qual cidade? 1) Curitiba 2) Londrina 3) São Paulo');
}

// ============ Command Handlers ============

function isInActiveFlow(state: UserState | undefined): boolean {
  if (!state) return false;

  if (state.reservation) {
    const r = state.reservation;
    if (r.awaiting_confirmation || r.awaiting_cancellation || r.phone_confirmed) return true;
    if (state.preferred_unit_name) return true;
  }

  return false;
}

async function handleDeterministicCommand(
  text: string,
  from: string,
  state: UserState,
  profileName?: string
): Promise<boolean> {
  const normalized = text.trim().toLowerCase();
  const isThanks = /\b(obrigad[oa]?|valeu|agrade[cç]o|muito obrigado|brigad[oa]?|thanks)\b/.test(normalized);
  const isGreeting = GREETING_COMMANDS.has(normalized) || GREETING_REGEX.test(normalized);
  const isReservationIntent =
    /\breserv(a|ar|e|ei|ando|ação|acao|as)\b/.test(normalized) ||
    normalized.includes('quero reservar') ||
    normalized.includes('fazer reserva') ||
    normalized.includes('reservar mesa');
  const isReservationManageIntent =
    /\b(minha(s)? reserva(s)?|tenho reserva|consult(a|ar)|verific(a|ar)|checar|cancel(a|ar)|alter(a|ar)|remarc(a|ar)|mudar reserva)\b/.test(normalized);
  const isCancelIntent =
    /\b(cancel(a|ar|amento)|desmarc(a|ar)|excluir reserva|nao vou poder ir|não vou poder ir)\b/.test(normalized);
  const isCancelAllIntent =
    /\b(cancel(a|ar).*(todas|tudo)|todas as reservas|cancelar tudo)\b/.test(normalized);
  const isAlterIntent =
    /\b(alter(a|ar|ação|acao)|remarc(a|ar)|reagend(a|ar)|mudar reserva|trocar|troca|outro dia|nova data|tenho que alterar|preciso alterar|vamos alterar|quero trocar)\b/.test(normalized);
  const isReservationQueryIntent =
    /\b(minha(s)? reserva(s)?|tenho reserva|consult(a|ar)|verific(a|ar)|checar|quais reservas)\b/.test(normalized);
  const timeOnlyPattern =
    /\bhoje\b/.test(normalized) &&
    /(\d{1,2})\s*(h|hora|horas|:\d{2})/.test(normalized) &&
    !/\b\d+\s*(pessoa|pessoas|adulto|adultos)\b/.test(normalized);

  // If waiting final confirmation, keep user inside confirmation state.
  if (state.reservation?.awaiting_confirmation && text !== 'confirm_reserva_sim' && text !== 'confirm_reserva_nao') {
    if (isGreeting || normalized === 'menu' || normalized === 'inicio' || normalized === 'voltar') {
      await sendWhatsAppText(from, 'Estamos quase lá 😊 Para concluir, confirme os dados da reserva no botão abaixo.');
      await sendConfirmationMenu(from, state);
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

  // Greeting outside active flow -> open main menu immediately
  if (isGreeting && !isInActiveFlow(state)) {
    state.has_interacted = true;
    userStates.set(from, state);
    await sendMainMenu(from, false);
    return true;
  }

  if (isThanks && !isInActiveFlow(state)) {
    await sendWhatsAppText(from, 'Imagina! 😊 Sempre que precisar, estou por aqui para ajudar com reservas, cardápio ou delivery.');
    return true;
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
      await sendManageReservationMenu(from, 'alter', active);
      return true;
    }
    return false; // query can still go to agent in other phrasings
  }

  if (text.startsWith('cancel_pick_')) {
    const reservationId = text.replace('cancel_pick_', '').trim();
    const active = await fetchActiveReservationsWithRetry(from);
    const selected = active.find((r) => r.reservationId === reservationId);
    if (!selected) {
      await sendWhatsAppText(from, 'Não encontrei essa reserva para cancelar. Vou te mostrar as reservas ativas novamente.');
      if (active.length > 0) await sendManageReservationMenu(from, 'cancel', active);
      return true;
    }
    state.reservation = {
      ...(state.reservation || {}),
      awaiting_cancellation: true,
      pending_cancellation_id: selected.reservationId,
      pending_cancellation_code: selected.code
    };
    userStates.set(from, state);
    await sendCancelConfirmationMenu(
      from,
      selected.reservationId,
      `Confirma o cancelamento da reserva ${selected.code} (${toBrDate(selected.date)} às ${selected.time}, ${selected.storeName})?`
    );
    return true;
  }

  if (text.startsWith('cancel_yes_')) {
    const reservationId = text.replace('cancel_yes_', '').trim();
    try {
      const mcpReady = await ensureReservasMcpReady();
      if (!mcpReady) throw new Error('MCP not ready');
      await reservasMcp.callTool('cancel_reservation', {
        reservationId,
        reason: 'Cancelamento solicitado pelo cliente via WhatsApp'
      });
      const code = state.reservation?.pending_cancellation_code || reservationId.substring(0, 8).toUpperCase();
      await sendWhatsAppText(from, `Reserva ${code} cancelada com sucesso. ✅`);
      if (state.reservation) {
        state.reservation.awaiting_cancellation = false;
        state.reservation.pending_cancellation_id = undefined;
        state.reservation.pending_cancellation_code = undefined;
      }
      userStates.set(from, state);
      await sendWhatsAppText(from, 'Se quiser, posso cancelar outra reserva ou te ajudar com uma nova. 🙂');
      return true;
    } catch (err: any) {
      console.error('[ReservasDeterministic] cancel_reservation failed:', err?.message || err);
      await sendWhatsAppText(from, 'Não consegui cancelar agora por instabilidade técnica. Tente novamente em alguns instantes.');
      return true;
    }
  }

  if (text === 'cancel_no' || text === 'cancel_nao') {
    if (state.reservation) {
      state.reservation.awaiting_cancellation = false;
      state.reservation.pending_cancellation_id = undefined;
      state.reservation.pending_cancellation_code = undefined;
    }
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
      if (!mcpReady) throw new Error('MCP not ready');
      for (const reservationId of ids) {
        try {
          await reservasMcp.callTool('cancel_reservation', {
            reservationId,
            reason: 'Cancelamento em lote solicitado pelo cliente via WhatsApp'
          });
          cancelled += 1;
        } catch (err: any) {
          console.error('[ReservasDeterministic] cancel_all item failed:', reservationId, err?.message || err);
        }
      }
      if (state.reservation) {
        state.reservation.awaiting_cancellation = false;
        state.reservation.pending_cancellation_all_ids = undefined;
        state.reservation.pending_cancellation_id = undefined;
        state.reservation.pending_cancellation_code = undefined;
      }
      userStates.set(from, state);
      await sendWhatsAppText(from, `Concluído ✅ Cancelei ${cancelled} de ${ids.length} reservas ativas.`);
      await sendWhatsAppText(from, 'Se quiser, posso verificar se ainda restou alguma ativa.');
      return true;
    } catch (err: any) {
      console.error('[ReservasDeterministic] cancel_all failed:', err?.message || err);
      await sendWhatsAppText(from, 'Não consegui concluir o cancelamento em lote agora por instabilidade técnica. Tente novamente em instantes.');
      return true;
    }
  }

  if (text === 'cancel_all_no') {
    if (state.reservation) {
      state.reservation.awaiting_cancellation = false;
      state.reservation.pending_cancellation_all_ids = undefined;
      state.reservation.pending_cancellation_id = undefined;
      state.reservation.pending_cancellation_code = undefined;
    }
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
      if (active.length > 0) await sendManageReservationMenu(from, 'alter', active);
      return true;
    }
    state.preferred_store_id = selected.storeId || state.preferred_store_id;
    state.preferred_unit_name = selected.storeName || state.preferred_unit_name;
    state.reservation = {
      ...(state.reservation || {}),
      phone_confirmed: true,
      contact_phone: from,
      pending_change_source_id: selected.reservationId,
      pending_change_source_code: selected.code,
      awaiting_confirmation: false
    };
    userStates.set(from, state);
    await sendWhatsAppText(
      from,
      `Perfeito! Vamos alterar a reserva ${selected.code}. Me envie em uma mensagem: data, horário, número de adultos, crianças (se houver) e observações (opcional).`
    );
    return true;
  }

  // Natural language reservation intent -> traditional interactive flow
  if (isReservationIntent && !isInActiveFlow(state)) {
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
    const cityMap: Record<string, string> = {
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

  // Delivery cities
  if (text === 'delivery_curitiba' || text === 'delivery_londrina' || text === 'delivery_saopaulo') {
    const cityMap: Record<string, string> = {
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
      const link = await db.getConfig('link_delivery_londrina');
      await sendWhatsAppText(from, `Bora pedir! 😋\n👉 ${link || 'https://www.ifood.com.br/'}`);
    } else {
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

  if (text === 'delivery_ajuda') {
    const city = state.preferred_city || 'Curitiba';
    const msg = city === 'Londrina'
      ? `Puxa, lamento pelo inconveniente! 😕\n\nPra gente resolver isso da melhor forma, entra em contato direto com a unidade de Londrina:\n📱 (43) 3398-9191`
      : [
        'Puxa, lamento pelo inconveniente! 😕',
        '',
        '📍 *Cabral / Jardim Botânico*',
        '📱 (41) 99288-6397',
        '',
        '📍 *Água Verde / Batel / Portão*',
        '📱 (41) 98811-6685'
      ].join('\n');

    await sendWhatsAppText(from, msg);
    await sendMainMenu(from, true);
    return true;
  }

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
    await sendWhatsAppText(from, done.message);
    if (!done.ok) {
      const suggestWait = done.message.toLowerCase().includes('alguns minutos');
      if (!suggestWait) {
        await sendConfirmationMenu(from, state);
      }
    }
    return true;
  }

  if (text === 'confirm_reserva_nao') {
    if (state.reservation) state.reservation.awaiting_confirmation = false;
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Sem problemas! 😊 Me diz o que você quer alterar (nome, data, horário, adultos ou crianças).');
    return true;
  }

  // Deterministic slot-filling while in active reservation flow
  if (isInActiveFlow(state) && state.preferred_unit_name && state.reservation?.phone_confirmed) {
    const extracted = parseReservationDetails(text);
    // If only people is missing, accept "4" style answers.
    if (!extracted.people && !state.reservation?.people) {
      const onlyPeople = extractStandalonePeople(text);
      if (onlyPeople) extracted.people = onlyPeople;
    }
    if (Object.keys(extracted).length > 0) {
      state.reservation = { ...(state.reservation || {}), ...extracted };
      userStates.set(from, state);

      const missing: string[] = [];
      if (!state.reservation.people) missing.push('quantos adultos');
      if (!state.reservation.date_text) missing.push('a data');
      if (!state.reservation.time_text) missing.push('o horário');
      if (state.reservation.kids === undefined) missing.push('se terá crianças (e quantas)');

      if (missing.length > 0) {
        await sendWhatsAppText(from, `Perfeito! ✅ Agora me confirma ${missing.join(' e ')}.`);
        return true;
      }

      userStates.set(from, state);
      await sendConfirmationMenu(from, state);
      state.reservation.awaiting_confirmation = true;
      userStates.set(from, state);
      return true;
    }
  }

  return false;
}

// ============ Webhook Handlers ============

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
  const alreadyProcessed = await redisService.isProcessed(messageId);
  if (alreadyProcessed) {
    console.log(`[WhatsApp] Duplicate message ID: ${messageId}`);
    res.status(200).send({ status: 'ignored/duplicate' });
    return;
  }
  await redisService.markProcessed(messageId);

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

function enqueueUserJob(userId: string, job: () => Promise<void>) {
  const previous = userProcessingQueue.get(userId) || Promise.resolve();
  const next = previous.catch(() => { }).then(job);
  userProcessingQueue.set(userId, next.finally(() => {
    if (userProcessingQueue.get(userId) === next) userProcessingQueue.delete(userId);
  }));
}

async function checkBotActiveFast(phone: string): Promise<boolean> {
  const now = Date.now();
  const cached = botActiveCache.get(phone);
  if (cached && (now - cached.at) <= BOT_ACTIVE_CACHE_TTL_MS) {
    return cached.value;
  }

  const timeoutGuard = new Promise<boolean>((resolve) => {
    setTimeout(() => resolve(true), BOT_ACTIVE_TIMEOUT_MS);
  });
  const checkPromise = chatwootService.checkBotActive(phone)
    .then((value) => {
      botActiveCache.set(phone, { value, at: Date.now() });
      return value;
    })
    .catch(() => true);

  return Promise.race([checkPromise, timeoutGuard]);
}

async function processMessageInternal(message: any, value: any): Promise<void> {
  try {
    const from = message.from;
    const totalStart = Date.now();
    const logStep = (step: string, startedAt: number) => {
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
    } else if (message.type === 'interactive') {
      text = message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.id ||
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title || '';
    } else if (message.type === 'button') {
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
    const isDup = await redisService.isDuplicateContent(from, text);
    if (isDup) {
      console.log(`[WhatsApp] Duplicate content from ${from}: "${text.substring(0, 50)}..."`);
      return;
    }

    // Check bot active
    const botActiveStart = Date.now();
    const botActive = await checkBotActiveFast(from);
    logStep('checkBotActive', botActiveStart);
    if (!botActive) return;

    // Send typing indicator
    sendTypingIndicator(from, message.id).catch(() => { });
    chatwootService.syncMessage(from, userName, text, 'incoming', { source: 'whatsapp' }).catch((err) => {
      console.error(`[Chatwoot] async incoming sync failed for ${from}:`, err?.message || err);
    });

    // Prompt injection check
    if (isPromptInjection(text)) {
      const msg = 'Não posso seguir esse tipo de instrução. Posso te ajudar com cardápio, reservas ou delivery.';
      await sendWhatsAppText(from, msg);
      await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
      return;
    }


    // Get/create user state
    let state: UserState = userStates.get(from) ?? {};
    if (!userStates.has(from)) {
      userStates.set(from, state);
    }

    // If confirmation is pending, accept plain-text confirmations as button equivalent.
    const textLower = text.toLowerCase().trim();
    if (state.reservation?.awaiting_confirmation && /^(sim|ok|confirmo|pode confirmar|tudo certo|esta tudo certo|está tudo certo)$/.test(textLower)) {
      text = 'confirm_reserva_sim';
    } else if (state.reservation?.awaiting_confirmation && /^(nao|não|corrigir|alterar|mudar|nao esta certo|não está certo)$/.test(textLower)) {
      text = 'confirm_reserva_nao';
    } else if (state.reservation?.awaiting_cancellation && /^(sim|ok|confirmo|sim cancelar|pode cancelar)$/.test(textLower)) {
      const pendingId = String(state.reservation?.pending_cancellation_id || '').trim();
      if (pendingId) text = `cancel_yes_${pendingId}`;
    } else if (state.reservation?.awaiting_cancellation && /^(nao|não|manter|nao cancelar|não cancelar)$/.test(textLower)) {
      text = 'cancel_no';
    }

    // Try deterministic commands first
    const deterministicStart = Date.now();
    const handled = await handleDeterministicCommand(text, from, state, rawPushName);
    logStep('handleDeterministicCommand', deterministicStart);
    if (handled) {
      chatwootService.syncMessage(from, userName, '[MENU_INTERATIVO]', 'outgoing', { source: 'bot' }).catch((err) => {
        console.error(`[Chatwoot] async outgoing sync failed for ${from}:`, err?.message || err);
      });
      logStep('total_handled_deterministic', totalStart);
      return;
    }

    // Call LangChain agent
    const sessionId = `whatsapp_${from}`;
    const langchainStart = Date.now();
    const result = await langchainService.processMessage(sessionId, text, {
      phone: from,
      user_name: userNameForAgent,    // undefined when no push name → agent will ask
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
        const rs = result.state_updates.reservation_state as Record<string, any>;
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
          await sendConfirmationMenu(from, state);
          if (state.reservation) {
            state.reservation.awaiting_confirmation = true;
            userStates.set(from, state);
          }
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
            const safeResponse = sanitizeWhatsAppText(result.response);
            const sendStart = Date.now();
            await sendWhatsAppText(from, safeResponse);
            logStep('sendWhatsAppText(default_ui_action)', sendStart);
            chatwootService.syncMessage(from, userName, safeResponse, 'outgoing', { source: 'bot' }).catch((err) => {
              console.error(`[Chatwoot] async outgoing sync failed for ${from}:`, err?.message || err);
            });
          }
      }
    } else {
      // Regular text response
      if (result.response) {
        const safeResponse = sanitizeWhatsAppText(result.response);
        const sendStart = Date.now();
        await sendWhatsAppText(from, safeResponse);
        logStep('sendWhatsAppText(regular)', sendStart);
        chatwootService.syncMessage(from, userName, safeResponse, 'outgoing', { source: 'bot' }).catch((err) => {
          console.error(`[Chatwoot] async outgoing sync failed for ${from}:`, err?.message || err);
        });

        if (shouldOfferMainMenu(result, state)) {
          await sendMainMenu(from, true);
          chatwootService.syncMessage(from, userName, '[MENU_INTERATIVO]', 'outgoing', { source: 'bot' }).catch((err) => {
            console.error(`[Chatwoot] async outgoing menu sync failed for ${from}:`, err?.message || err);
          });
        }
      }
    }

    // Update state from any remaining state_updates keys
    if (result.state_updates) {
      const { reservation_state, ...rest } = result.state_updates as any;
      state = { ...state, ...rest };
      userStates.set(from, state);
    }

    // Mark as interacted
    state.has_interacted = true;
    userStates.set(from, state);
    logStep('total', totalStart);

  } catch (error) {
    console.error('[WhatsApp] Error processing message:', error);
  }
}
