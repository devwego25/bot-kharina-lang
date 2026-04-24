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
import { reservasAdminApiService } from './reservasAdminApi';

import { reservasWebhookApiService } from './reservasWebhookApi';
import {
  beginReservationAttempt,
  markLatestAttemptManualConfirmed,
  updateReservationAttemptStatus
} from './reservationAttempts';
import { syncReservationVerificationState } from './reservationReconciliation';
import {
  addOrUpdateAdminUser,
  blockModeLabel,
  buildDefaultBlockMessage,
  createReservationBlock,
  DEFAULT_RESERVATION_LEAD_MINUTES,
  describeReservationBlock,
  deactivateAdminUser,
  deactivateReservationBlock,
  findMatchingReservationBlock,
  getAdminUser,
  getReservationBlock,
  getReservationLeadMinutes,
  hasAnyAdminConfigured,
  isConfiguredMasterPhone,
  listAdminUsers,
  listReservationBlocks,
  normalizeAdminPhone,
  setReservationLeadMinutes,
  type AdminRole,
  type ReservationBlock,
  type ReservationBlockMode,
  weekdayLabel
} from './reservationAdmin';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

// State management types
interface ReservationState {
  people?: number;
  kids?: number;
  phone_confirmed?: boolean;
  awaiting_name?: boolean;
  awaiting_manual_review?: boolean;
  manual_review_last_notice_at?: number;
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
  pending_attempt_id?: number;
}

interface UserState {
  preferred_city?: string;
  preferred_store_id?: string;
  preferred_unit_name?: string;
  pending_offer?: 'pet_friendly_reservation_offer' | 'cake_note_offer' | 'food_info_unit_offer' | 'unit_contact_offer' | 'delivery_help_offer';
  has_interacted?: boolean;
  last_interactive_menu?: string;
  last_message_timestamp?: number;
  reservation?: ReservationState;
  help?: HelpFlowState;
  admin?: AdminFlowState;
}

interface HelpFlowState {
  type?: 'lost_found' | 'public_admin_menu' | 'public_admin_rh_menu';
  awaiting_unit?: boolean;
  awaiting_item?: boolean;
  unit_name?: string;
  store_id?: string;
}

interface AdminBlockDraft {
  store_id?: string;
  store_name?: string;
  weekday?: number | null;
  start_time?: string;
  end_time?: string;
  mode?: ReservationBlockMode;
}

interface AdminReservationCreateDraft {
  store_id?: string;
  store_name?: string;
  name?: string;
  contact_phone?: string;
  date_text?: string;
  time_text?: string;
  adults?: number;
  kids?: number;
  notes?: string;
}

interface AdminFlowState {
  step?: string;
  draft_block?: AdminBlockDraft;
  draft_reservation?: AdminReservationCreateDraft;
  pending_lead_time_minutes?: number;
  pending_admin_phone?: string;
  pending_remove_admin_phone?: string;
  pending_disable_block_id?: number;
  reservation_view?: 'summary' | 'today' | 'next7' | 'date' | 'create';
  reservation_store_id?: string;
  reservation_store_name?: string;
  reservation_page?: number;
  reservation_start_date?: string;
  reservation_end_date?: string;
}

interface CapturedOutboundMessage {
  content: string;
  attributes?: Record<string, any>;
  isPrivate?: boolean;
}

interface RecentOutboundEntry {
  at: number;
  hash: string;
  content: string;
}

// In-memory state (consider moving to Redis for multi-instance)
const userStates = new Map<string, UserState>();
const lastOutboundByUser = new Map<string, { hash: string; at: number }>();
const recentOutboundContentByUser = new Map<string, RecentOutboundEntry[]>();
const interactiveDegradedUntil = new Map<string, number>();
const userProcessingQueue = new Map<string, Promise<void>>();
const botActiveCache = new Map<string, { value: boolean; at: number }>();
const storesHoursCache = new Map<string, { data: any[]; at: number }>();
const capturedOutboundByUser = new Map<string, CapturedOutboundMessage[]>();
let reservasCallQueue: Promise<void> = Promise.resolve();

const INTERACTIVE_DEGRADED_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 1000; // 1 second between messages
const FLOW_IDLE_RESET_MS = 120 * 60 * 1000; // keep in-progress flow for 2h before reset
const GRAPH_API_TIMEOUT_MS = 8000;
const BOT_ACTIVE_CACHE_TTL_MS = 15_000;
const BOT_ACTIVE_TIMEOUT_MS = 700;
const STORES_HOURS_CACHE_TTL_MS = 10 * 60 * 1000;
const RECENT_OUTBOUND_WINDOW_MS = 2 * 60 * 1000;
const ADMIN_RESERVATION_PAGE_SIZE = 6;
const RESERVATION_CLOSING_BUFFER_MINUTES = 60;
const SCOPE_ONLY_MSG = 'Só posso ajudar com assuntos do restaurante: cardápio, reservas e delivery.';
const PT_NUMBER_TOKEN_PATTERN = '(?:\\d+|zero|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|treze|catorze|quatorze|quinze|dezesseis|dezessete|dezoito|dezenove|vinte)';
const HAPPY_HOUR_INFO_TEXT = [
  '*Happy Hour Kharina*',
  '_De segunda a sexta-feira, das 16h às 20h._',
  '*Exceto nos feriados.*',
  '',
  'O melhor Happy Hour, com *até 50% de desconto*.',
  '',
  'Se quiser, também posso te ajudar com cardápio, reserva ou delivery.'
].join('\n');
const PET_FRIENDLY_INFO_TEXT = [
  '*Pet-friendly no Kharina*',
  'A unidade *Água Verde*, na *área externa*, é pet-friendly. 🐶',
  '',
  'Vamos ficar felizes em receber você e seu pet por lá.',
  '',
  'Se quiser, também posso te ajudar a fazer uma *reserva para a unidade Água Verde*.'
].join('\n');
let reservationLeadMinutesCache: { value: number; at: number } | null = null;
const RESERVATION_LEAD_MINUTES_CACHE_TTL_MS = 30_000;

// Command sets
const MENU_COMMANDS = new Set([
  'MENU_PRINCIPAL',
  'menu_cardapio',
  'menu_reserva',
  'menu_delivery',
  'menu_kids',
  'menu_help',
  'help_lost_found',
  'help_unit_contact',
  'menu_public_admin',
  'public_admin_rh',
  'public_admin_compras',
  'public_admin_financeiro',
  'public_admin_feedback',
  'public_admin_rh_employee',
  'public_admin_rh_candidate'
]);
const GREETING_COMMANDS = new Set(['oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'hello', 'hi']);
const GREETING_REGEX = /\b(oi|ol[áa]|bom dia|boa tarde|boa noite|e ai|e aí|opa|tudo bem|tudo bom|hello|hi)\b/i;
const CHILDREN_WORD_PATTERN = 'crian\\w*';
const UNIT_CONFIG: Record<string, { name: string; storeId: string }> = {
  unidade_botanico: { name: 'Jardim Botânico', storeId: 'a99c098f-c16b-4168-a5b1-54e76aa1a855' },
  unidade_cabral: { name: 'Cabral', storeId: 'c6919b3c-f5ff-4006-a226-2b493d9d8cf5' },
  unidade_agua_verde: { name: 'Água Verde', storeId: 'fde9ba37-baff-4958-b6be-5ced7059864c' },
  unidade_batel: { name: 'Batel', storeId: 'b45c9b5e-4f79-47b1-a442-ea8fb9d6e977' },
  unidade_portao: { name: 'Portão', storeId: 'f0f6ae17-01d1-4c51-a423-33222f8fcd5c' },
  unidade_londrina: { name: 'Londrina', storeId: '3e027375-3049-4080-98c3-9f7448b8fd62' },
  unidade_saopaulo: { name: 'São Paulo', storeId: '03dc5466-6c32-4e9e-b92f-c8b02e74bba6' }
};

const UNIT_PHONE_BY_NAME: Record<string, string> = {
  'Jardim Botânico': '(41) 3092-0449',
  'Cabral': '(41) 3352-8661',
  'Água Verde': '(41) 3082-5439',
  'Batel': '(41) 3203-4940',
  'Portão': '(41) 3083-7600',
  'Londrina': '(43) 3398-9191',
  'São Paulo': '(11) 5432-0052'
};

const UNIT_MANAGER_ASSIGNEE_BY_NAME: Record<string, number> = {
  'Jardim Botânico': 15,
  'Cabral': 23,
  'Água Verde': 19,
  'Batel': 17,
  'Portão': 21,
  'Londrina': 25,
  'São Paulo': 27
};

const CHATWOOT_TEAM_IDS = {
  financeiro: 1,
  compras: 2,
  rh: 4,
  central: 5
} as const;

const DELIVERY_HELP_PHONE_BY_CONTEXT: Record<string, string> = {
  'Cabral': '(41) 99288-6397',
  'Jardim Botânico': '(41) 99288-6397',
  'Água Verde': '(41) 98811-6685',
  'Batel': '(41) 98811-6685',
  'Portão': '(41) 98811-6685',
  'Londrina': '(41) 99265-3755'
};

const UNIT_TEXT_MATCHERS: Array<{ rx: RegExp; id: keyof typeof UNIT_CONFIG }> = [
  { rx: /\bjardim\s*botanico\b|\bbotanico\b/, id: 'unidade_botanico' },
  { rx: /\bcabral\b/, id: 'unidade_cabral' },
  { rx: /\bagua\s*verde\b/, id: 'unidade_agua_verde' },
  { rx: /\bbatel\b/, id: 'unidade_batel' },
  { rx: /\bportao\b/, id: 'unidade_portao' },
  { rx: /\blondrina\b/, id: 'unidade_londrina' },
  { rx: /\bsao\s*paulo\b/, id: 'unidade_saopaulo' }
];

const HELP_UNIT_CONFIG: Record<string, keyof typeof UNIT_CONFIG> = {
  help_unit_botanico: 'unidade_botanico',
  help_unit_cabral: 'unidade_cabral',
  help_unit_agua_verde: 'unidade_agua_verde',
  help_unit_batel: 'unidade_batel',
  help_unit_portao: 'unidade_portao',
  help_unit_londrina: 'unidade_londrina',
  help_unit_saopaulo: 'unidade_saopaulo'
};

const CHATWOOT_COMMAND_LABELS: Record<string, string> = {
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
  menu_kids: 'Menu Espaco Kids',
  menu_help: 'Menu legado de ajuda',
  help_lost_found: 'Achados e Perdidos',
  help_unit_contact: 'Ajuda Contato da unidade',
  help_unit_botanico: 'Ajuda Jardim Botanico',
  help_unit_cabral: 'Ajuda Cabral',
  help_unit_agua_verde: 'Ajuda Agua Verde',
  help_unit_batel: 'Ajuda Batel',
  help_unit_portao: 'Ajuda Portao',
  help_unit_londrina: 'Ajuda Londrina',
  help_unit_saopaulo: 'Ajuda Sao Paulo',
  menu_public_admin: 'Menu público Administração',
  public_admin_rh: 'Administração RH',
  public_admin_compras: 'Administração Compras',
  public_admin_financeiro: 'Administração Financeiro',
  public_admin_feedback: 'Administração Sugestões e Críticas',
  public_admin_rh_employee: 'Administração RH já sou funcionário',
  public_admin_rh_candidate: 'Administração RH não sou funcionário'
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
const userStatesSet = userStates.set.bind(userStates);
userStates.set = ((userId: string, state: UserState) => {
  userStatesSet(userId, state);
  redisService.saveUserState(userId, state).catch((err) => {
    console.error('[State] Failed to persist user state:', err?.message || err);
  });
  return userStates;
}) as typeof userStates.set;

// ============ Helper Functions ============

function normalizeForOutboundDedupe(text: string): string {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeUnitName(value: string): string {
  return (value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function getUnitManagerAssigneeId(unitName?: string): number | null {
  if (!unitName) return null;
  return UNIT_MANAGER_ASSIGNEE_BY_NAME[unitName] || null;
}

async function assignChatwootConversationToUnitManager(
  phone: string,
  unitName?: string,
  reason?: string
): Promise<void> {
  const assigneeId = getUnitManagerAssigneeId(unitName);
  if (!assigneeId) return;

  try {
    await chatwootService.updateConversation(phone, {
      assignee_id: assigneeId,
      status: 'open',
      custom_attributes: {
        route_reason: reason || 'unit_contact',
        routed_unit: unitName
      }
    });
    console.log(`[Chatwoot] Routed ${phone} to unit manager ${unitName} (${assigneeId}) due to ${reason || 'unit_contact'}`);
  } catch (err: any) {
    console.error('[Chatwoot] Failed to route conversation to unit manager:', err?.message || err);
  }
}

async function assignChatwootConversationToTeam(
  phone: string,
  teamId: number,
  teamName: string,
  reason: string,
  assigneeId?: number
): Promise<void> {
  try {
    const payload: any = {
      team_id: teamId,
      status: 'open',
      custom_attributes: {
        route_reason: reason,
        routed_team: teamName
      }
    };
    if (assigneeId) {
      payload.assignee_id = assigneeId;
    }
    await chatwootService.updateConversation(phone, payload);
    console.log(`[Chatwoot] Routed ${phone} to team ${teamName} (${teamId}) due to ${reason}`);
  } catch (err: any) {
    console.error('[Chatwoot] Failed to route conversation to team:', err?.message || err);
  }
}

async function addPrivateChatwootNote(phone: string, content: string): Promise<void> {
  try {
    await chatwootService.syncMessage(phone, phone, content, 'outgoing', { source: 'bot', kind: 'internal_note' }, true);
  } catch (err: any) {
    console.error('[Chatwoot] Failed to add private note:', err?.message || err);
  }
}

function formatBrazilPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  const br = digits.startsWith('55') ? digits.slice(2) : digits;
  if (br.length === 11) return `(${br.slice(0, 2)}) ${br.slice(2, 7)}-${br.slice(7)}`;
  if (br.length === 10) return `(${br.slice(0, 2)}) ${br.slice(2, 6)}-${br.slice(6)}`;
  return raw;
}

function isUsableContactName(raw: string): boolean {
  const value = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!value) return false;
  if (/^[\d+\s\-().]+$/.test(value)) return false;
  if (value.length < 2 || value.length > 80) return false;

  const normalized = value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (
    /\b(hoje|amanha|amanhã|para amanha|para amanhã|reserva|adult|crianc|data|horario|horário|mesa|unidade)\b/.test(normalized) ||
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(normalized) ||
    /\b\d{1,2}(?::|h)\d{2}\b/.test(normalized)
  ) {
    return false;
  }

  return true;
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

function isValidAdminTimeInput(text: string): string | null {
  const normalized = normalizeTime(text);
  if (!/^\d{2}:\d{2}$/.test(normalized)) return null;
  const [hour, minute] = normalized.split(':').map(Number);
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return normalized;
}

function ensureAdminState(state: UserState): AdminFlowState {
  state.admin = state.admin || {};
  return state.admin;
}

function clearAdminState(state: UserState): void {
  delete state.admin;
}

function clearHelpState(state: UserState): void {
  delete state.help;
}

function clearAdminReservationState(state: UserState): void {
  if (!state.admin) return;
  delete state.admin.reservation_view;
  delete state.admin.reservation_store_id;
  delete state.admin.reservation_store_name;
  delete state.admin.reservation_page;
  delete state.admin.reservation_start_date;
  delete state.admin.reservation_end_date;
}

function clearAdminReservationCreateState(state: UserState): void {
  if (!state.admin) return;
  delete state.admin.draft_reservation;
}

function formatLeadHoursLabel(hours: number): string {
  return `${hours} ${hours === 1 ? 'hora' : 'horas'}`;
}

async function getCurrentReservationLeadMinutes(): Promise<number> {
  const now = Date.now();
  if (reservationLeadMinutesCache && (now - reservationLeadMinutesCache.at) <= RESERVATION_LEAD_MINUTES_CACHE_TTL_MS) {
    return reservationLeadMinutesCache.value;
  }

  const value = await getReservationLeadMinutes();
  reservationLeadMinutesCache = { value, at: now };
  return value;
}

async function updateReservationLeadMinutes(minutes: number): Promise<number> {
  const saved = await setReservationLeadMinutes(minutes);
  reservationLeadMinutesCache = { value: saved, at: Date.now() };
  return saved;
}

function parseLeadTimeHoursInput(text: string): number | null {
  const parsed = Number(String(text || '').trim().replace(/[^\d]/g, ''));
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 24) return null;
  return parsed;
}

function timeToMinutes(value?: string): number | null {
  const normalized = normalizeTime(String(value || '').trim());
  const match = normalized.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToTime(totalMinutes: number): string {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function reservationWeekdayFromIso(date: string): number | null {
  const match = String(date || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getDay();
}

function weekdayKeyFromIso(date: string): string | null {
  const weekday = reservationWeekdayFromIso(date);
  if (weekday === null) return null;
  const map = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  return map[weekday] || null;
}

function pickBalancedAlternativeMinutes(candidates: number[], requestedMinutes: number, limit: number): number[] {
  const before = candidates
    .filter((minutes) => minutes < requestedMinutes)
    .sort((a, b) => b - a);
  const after = candidates
    .filter((minutes) => minutes > requestedMinutes)
    .sort((a, b) => a - b);
  const exact = candidates
    .filter((minutes) => minutes === requestedMinutes)
    .sort((a, b) => a - b);

  const picked: number[] = [];
  let beforeIndex = 0;
  let afterIndex = 0;
  let exactIndex = 0;

  while (picked.length < limit) {
    let added = false;

    if (exactIndex < exact.length) {
      picked.push(exact[exactIndex++]);
      added = true;
      if (picked.length >= limit) break;
    }

    if (beforeIndex < before.length) {
      picked.push(before[beforeIndex++]);
      added = true;
      if (picked.length >= limit) break;
    }

    if (afterIndex < after.length) {
      picked.push(after[afterIndex++]);
      added = true;
      if (picked.length >= limit) break;
    }

    if (!added) break;
  }

  return picked;
}

async function suggestReservationAlternativeTimes(
  storeId: string,
  unitName: string,
  date: string,
  requestedTime: string,
  numberOfPeople = 2
): Promise<string[]> {
  const weekday = reservationWeekdayFromIso(date);
  const weekdayKey = weekdayKeyFromIso(date);
  if (!weekdayKey) return [];

  const stores = await getStoresWithHours();
  const store = stores.find((s: any) => String(s?.id || '').toLowerCase() === String(storeId).toLowerCase());
  const dayInfo = store?.operationHours?.[weekdayKey];
  const openMinutes = timeToMinutes(dayInfo?.open);
  const rawCloseMinutes = timeToMinutes(dayInfo?.close);
  if (!store || !dayInfo || dayInfo.isOpen === false || openMinutes === null || rawCloseMinutes === null) {
    return [];
  }
  const closeMinutes = rawCloseMinutes <= openMinutes ? rawCloseMinutes + 1440 : rawCloseMinutes;
  const lastReservableMinutes = closeMinutes - RESERVATION_CLOSING_BUFFER_MINUTES;
  if (lastReservableMinutes <= openMinutes) return [];

  const rawRequestedMinutes = timeToMinutes(requestedTime);
  const requestedMinutes =
    rawRequestedMinutes === null
      ? openMinutes
      : (closeMinutes > 1440 && rawRequestedMinutes < openMinutes ? rawRequestedMinutes + 1440 : rawRequestedMinutes);
  const blocks = (await listReservationBlocks(true, 500)).filter((item) =>
    item.store_id === storeId && (item.weekday === null || item.weekday === weekday)
  );
  const blockRanges = blocks
    .map((item) => ({ start: timeToMinutes(item.start_time), end: timeToMinutes(item.end_time) }))
    .filter((item): item is { start: number; end: number } => item.start !== null && item.end !== null && item.start < item.end);
  const leadMinutes = await getCurrentReservationLeadMinutes();
  const minAllowedAt = leadMinutes > 0 ? Date.now() + (leadMinutes * 60 * 1000) : 0;

  const candidates: number[] = [];
  for (let minutes = openMinutes; minutes < lastReservableMinutes; minutes += 30) {
    const time = minutesToTime(minutes);
    if (leadMinutes > 0) {
      const candidateAt = buildReservationDateTime(date, time);
      if (!candidateAt || candidateAt.getTime() < minAllowedAt) continue;
    }
    const blocked = blockRanges.some((range) => range.start <= minutes && range.end > minutes);
    if (blocked) continue;
    candidates.push(minutes);
  }

  const rankedCandidates = pickBalancedAlternativeMinutes(candidates, requestedMinutes, Math.max(10, candidates.length));

  let pickedMinutes = rankedCandidates.slice(0, 4);
  if (reservasWebhookApiService.isConfigured() && numberOfPeople > 0) {
    const availableMinutes: number[] = [];
    for (const minutes of rankedCandidates.slice(0, 10)) {
      try {
        const availability = await reservasWebhookApiService.checkAvailability({
          storeId,
          date,
          time: minutesToTime(minutes),
          numberOfPeople
        });
        if (availability?.available) {
          availableMinutes.push(minutes);
          if (availableMinutes.length >= 4) break;
        }
      } catch (err: any) {
        console.error('[ReservasDeterministic] webhook availability fallback failed:', err?.message || err);
        break;
      }
    }
    if (availableMinutes.length > 0) pickedMinutes = availableMinutes;
  }

  const picked = pickedMinutes
    .sort((a, b) => a - b)
    .map((minutes) => minutesToTime(minutes));

  return Array.from(new Set(picked));
}

async function buildReservationBlockCustomerMessage(
  block: ReservationBlock,
  storeId?: string,
  unitName?: string,
  requestedDate?: string,
  requestedTime?: string,
  numberOfPeople = 2
): Promise<string> {
  const unitLabel = unitName || block.store_name || 'essa unidade';
  const base = `A reserva para a unidade ${unitLabel} nesse dia e horário está bloqueada, então o atendimento será por ordem de chegada ao restaurante. Ficaremos felizes em receber vocês por aqui.`;
  const alternativeTimes =
    storeId && requestedDate && requestedTime
      ? await suggestReservationAlternativeTimes(storeId, unitLabel, normalizeIsoDate(requestedDate), normalizeTime(requestedTime), numberOfPeople)
      : [];
  const alternativesText = alternativeTimes.length > 0
    ? `\n\nAlguns horários fora desse bloqueio para você tentar nessa unidade: *${alternativeTimes.join('*, *')}*.`
    : '';
  if (block.mode === 'suggest_alternative') {
    return `${base}${alternativesText}\n\nSe quiser, me diga outro horário ou outra unidade e eu verifico por aqui.`;
  }
  if (block.mode === 'handoff') {
    const phone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';
    if (phone) {
      return `${base}${alternativesText}\n\nSe quiser, também posso verificar outro horário ou outra unidade para você. Se preferir falar direto com a unidade, o telefone é ${phone}.`;
    }
    return `${base}${alternativesText}\n\nSe quiser, também posso verificar outro horário ou outra unidade para você.`;
  }
  return `${base}${alternativesText}\n\nSe quiser, também posso verificar outro horário ou outra unidade para você.`;
}

function buildReservationDateTime(date: string, time: string): Date | null {
  const normalizedDate = normalizeIsoDate(String(date || '').trim());
  const normalizedTime = normalizeTime(String(time || '').trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) return null;
  if (!/^\d{2}:\d{2}$/.test(normalizedTime)) return null;
  const reservationAt = new Date(`${normalizedDate}T${normalizedTime}:00-03:00`);
  if (Number.isNaN(reservationAt.getTime())) return null;
  return reservationAt;
}

async function buildReservationLeadTimeCustomerMessage(
  storeId?: string,
  unitName?: string,
  requestedDate?: string,
  requestedTime?: string,
  numberOfPeople = 2
): Promise<string> {
  const leadMinutes = await getCurrentReservationLeadMinutes();
  const leadHours = Math.max(0, Math.round(leadMinutes / 60));
  const leadLabel = formatLeadHoursLabel(leadHours);
  const unitLabel = unitName || 'essa unidade';
  const normalizedDate = normalizeIsoDate(String(requestedDate || ''));
  const today = toIsoDate(new Date());
  const isToday = normalizedDate === today;
  const base = isToday
    ? `Para a unidade ${unitLabel}, com menos de ${leadLabel} de antecedência, não conseguimos confirmar a reserva automática para hoje. Nesse caso, o atendimento será por ordem de chegada ao restaurante. Ficaremos felizes em receber vocês por aqui.`
    : `Para a unidade ${unitLabel}, só conseguimos confirmar reservas com pelo menos ${leadLabel} de antecedência. Nesse caso, o atendimento será por ordem de chegada ao restaurante. Ficaremos felizes em receber vocês por aqui.`;
  const alternativeTimes =
    storeId && requestedDate && requestedTime
      ? await suggestReservationAlternativeTimes(storeId, unitLabel, normalizeIsoDate(requestedDate), normalizeTime(requestedTime), numberOfPeople)
      : [];
  const alternativesText = alternativeTimes.length > 0
    ? `\n\nAlguns horários fora desse bloqueio para você tentar nessa unidade: *${alternativeTimes.join('*, *')}*.`
    : '';
  return `${base}${alternativesText}\n\nSe quiser, também posso verificar outro horário ou outra unidade para você.`;
}

async function buildReservationClosingBufferCustomerMessage(
  storeId?: string,
  unitName?: string,
  requestedDate?: string,
  requestedTime?: string,
  numberOfPeople = 2
): Promise<string> {
  const unitLabel = unitName || 'essa unidade';
  const base = `Para a unidade ${unitLabel}, não conseguimos confirmar reservas automáticas na última hora antes do fechamento. Nesse caso, o atendimento será por ordem de chegada ao restaurante. Ficaremos felizes em receber vocês por aqui.`;
  const alternativeTimes =
    storeId && requestedDate && requestedTime
      ? await suggestReservationAlternativeTimes(storeId, unitLabel, normalizeIsoDate(requestedDate), normalizeTime(requestedTime), numberOfPeople)
      : [];
  const alternativesText = alternativeTimes.length > 0
    ? `\n\nAlguns horários fora desse bloqueio para você tentar nessa unidade: *${alternativeTimes.join('*, *')}*.`
    : '';
  return `${base}${alternativesText}\n\nSe quiser, também posso verificar outro horário ou outra unidade para você.`;
}

async function getReservationLeadTimeViolation(date?: string, time?: string, unitName?: string): Promise<string | null> {
  if (!date || !time) return null;
  const reservationAt = buildReservationDateTime(date, time);
  if (!reservationAt) return null;
  const leadMinutes = await getCurrentReservationLeadMinutes();
  if (leadMinutes <= 0) return null;
  const minAllowedAt = Date.now() + (leadMinutes * 60 * 1000);
  if (reservationAt.getTime() < minAllowedAt) {
    return unitName || 'lead_time_violation';
  }
  return null;
}

async function getReservationClosingBufferViolation(
  storeId?: string,
  date?: string,
  time?: string,
  unitName?: string
): Promise<string | null> {
  if (!storeId || !date || !time) return null;
  const weekdayKey = weekdayKeyFromIso(date);
  if (!weekdayKey) return null;

  const stores = await getStoresWithHours();
  const store = stores.find((s: any) => String(s?.id || '').toLowerCase() === String(storeId).toLowerCase());
  const dayInfo = store?.operationHours?.[weekdayKey];
  const openMinutes = timeToMinutes(dayInfo?.open);
  const rawCloseMinutes = timeToMinutes(dayInfo?.close);
  const rawRequestedMinutes = timeToMinutes(time);
  if (!store || !dayInfo || dayInfo.isOpen === false || openMinutes === null || rawCloseMinutes === null || rawRequestedMinutes === null) {
    return null;
  }

  const closeMinutes = rawCloseMinutes <= openMinutes ? rawCloseMinutes + 1440 : rawCloseMinutes;
  const requestedMinutes =
    closeMinutes > 1440 && rawRequestedMinutes < openMinutes
      ? rawRequestedMinutes + 1440
      : rawRequestedMinutes;
  const lastReservableMinutes = closeMinutes - RESERVATION_CLOSING_BUFFER_MINUTES;
  if (lastReservableMinutes <= openMinutes) return unitName || store?.name || 'closing_buffer_violation';
  if (requestedMinutes >= lastReservableMinutes) {
    return unitName || store?.name || 'closing_buffer_violation';
  }
  return null;
}

async function maybeGetReservationBlock(state: UserState): Promise<ReservationBlock | null> {
  const storeId = String(state.preferred_store_id || '').trim();
  const date = normalizeIsoDate(String(state.reservation?.date_text || '').trim());
  const time = normalizeTime(String(state.reservation?.time_text || '').trim());
  if (!storeId || !date || !time) return null;
  return findMatchingReservationBlock({ storeId, date, time });
}

function toBrDate(isoOrBr: string): string {
  const v = String(isoOrBr || '').trim();
  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return v;
}

function getSaoPauloTodayIso(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

function addIsoDays(isoDate: string, days: number): string {
  const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return isoDate;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

function parseAdminDateInput(text: string): string | null {
  const normalized = normalizeIsoDate(String(text || '').trim());
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function parseAdminReservationPhoneInput(text: string): string | null {
  const raw = String(text || '').trim();
  if (!raw.startsWith('+55')) return null;
  const digits = normalizeReservationPhone(raw);
  return /^55\d{10,11}$/.test(digits) ? digits : null;
}

function parseAdminReservationCountInput(text: string, allowEmpty = false): number | null {
  const normalized = normalizeIntentText(text);
  if (allowEmpty && /^(sem|nenhuma|nenhum|nao|não|0)$/.test(normalized)) return 0;
  const parsed = parsePtNumberToken(normalized);
  if (parsed === null || parsed < 0 || parsed > 200) return null;
  return parsed;
}

function parseAdminReservationNotesInput(text: string): string {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return /^(sem observacao|sem observação|sem obs|nenhuma|nao|não)$/.test(normalizeIntentText(raw))
    ? ''
    : raw;
}

function normalizeIntentText(text: string): string {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePtNumberToken(token: string): number | null {
  const normalized = String(token || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w]/g, '')
    .trim();
  if (!normalized) return null;
  if (/^\d+$/.test(normalized)) {
    const parsed = parseInt(normalized, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const numberMap: Record<string, number> = {
    zero: 0,
    um: 1,
    uma: 1,
    dois: 2,
    duas: 2,
    tres: 3,
    quatro: 4,
    cinco: 5,
    seis: 6,
    sete: 7,
    oito: 8,
    nove: 9,
    dez: 10,
    onze: 11,
    doze: 12,
    treze: 13,
    catorze: 14,
    quatorze: 14,
    quinze: 15,
    dezesseis: 16,
    dezessete: 17,
    dezoito: 18,
    dezenove: 19,
    vinte: 20,
  };

  return numberMap[normalized] ?? null;
}

function extractPhoneCandidate(text: string): string | null {
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

function getMentionedUnitFromText(text: string): { name: string; storeId: string } | null {
  const normalized = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const match = UNIT_TEXT_MATCHERS.find((unit) => unit.rx.test(normalized));
  return match ? UNIT_CONFIG[match.id] : null;
}

function inferCityFromUnitName(unitName?: string): 'Curitiba' | 'Londrina' | 'São Paulo' | undefined {
  const normalized = normalizeUnitName(String(unitName || ''));
  if (!normalized) return undefined;
  if (normalized === 'londrina') return 'Londrina';
  if (normalized === 'sao paulo') return 'São Paulo';
  if (Object.values(UNIT_CONFIG).some((unit) => normalizeUnitName(unit.name) === normalized)) return 'Curitiba';
  return undefined;
}

function inferCityFromText(text: string): 'Curitiba' | 'Londrina' | 'São Paulo' | undefined {
  const normalized = normalizeIntentText(text);
  if (/\bsao paulo\b/.test(normalized)) return 'São Paulo';
  if (/\blondrina\b/.test(normalized)) return 'Londrina';
  if (/\bcuritiba\b/.test(normalized) || /\bpr\b/.test(normalized)) return 'Curitiba';
  return undefined;
}

function getDeliveryHelpPhone(unitName?: string, city?: string): string | null {
  const normalizedUnit = String(unitName || '').trim();
  if (normalizedUnit && DELIVERY_HELP_PHONE_BY_CONTEXT[normalizedUnit]) {
    return DELIVERY_HELP_PHONE_BY_CONTEXT[normalizedUnit];
  }

  const normalizedCity = String(city || '').trim();
  if (normalizedCity === 'Londrina') return DELIVERY_HELP_PHONE_BY_CONTEXT['Londrina'];
  return null;
}

function buildDeliveryHelpMessage(unitName?: string, city?: string): string {
  const phone = getDeliveryHelpPhone(unitName, city);
  if (unitName && phone) {
    return `Claro! Para *ajuda com pedido de delivery* da unidade *${unitName}*, fale com a equipe por este número:\n\n📱 *${phone}*\n\nEsse contato é exclusivo para suporte de pedidos/delivery.`;
  }

  if (city === 'Londrina' && phone) {
    return `Claro! Para *ajuda com pedido de delivery* em *Londrina*, fale com a equipe por este número:\n\n📱 *${phone}*\n\nEsse contato é exclusivo para suporte de pedidos/delivery.`;
  }

  return [
    'Claro! Para *ajuda com pedido de delivery*, use estes contatos:',
    '',
    '*Curitiba*',
    '- *Água Verde / Batel / Portão:* (41) 98811-6685',
    '- *Cabral / Jardim Botânico:* (41) 99288-6397',
    '',
    '*Londrina*',
    '- (41) 99265-3755',
    '',
    'Esses números são exclusivos para suporte de pedidos/delivery.'
  ].join('\n');
}

function getCardapioCommandFromContext(unitName?: string, city?: string): 'cardapio_curitiba' | 'cardapio_londrina' | 'cardapio_saopaulo' | null {
  const resolvedCity = city || inferCityFromUnitName(unitName);
  if (resolvedCity === 'Londrina') return 'cardapio_londrina';
  if (resolvedCity === 'São Paulo') return 'cardapio_saopaulo';
  if (resolvedCity === 'Curitiba') return 'cardapio_curitiba';
  return null;
}

async function sendDirectDeliveryHelp(to: string, unitName?: string, city?: string): Promise<void> {
  const resolvedCity = city || inferCityFromUnitName(unitName) || 'Curitiba';

  if (resolvedCity === 'São Paulo') {
    await sendWhatsAppText(to, "Poxa, em SP ainda não tem delivery! 😢 Mas vem visitar a gente no Shopping Parque da Cidade! 🧡");
    return;
  }

  if (resolvedCity === 'Londrina') {
    const link = await db.getConfig('link_delivery_londrina');
    await sendWhatsAppText(to, `Bora pedir! 😋\n👉 ${link || 'https://www.ifood.com.br/'}`);
    return;
  }

  const normalizedUnit = normalizeUnitName(String(unitName || ''));
  if (normalizedUnit === 'jardim botanico' || normalizedUnit === 'cabral') {
    await sendWhatsAppText(
      to,
      [
        'Perfeito! 🍔 Para *Cabral / Jardim Botânico*, o pedido é por este link:',
        '👉 https://www.ifood.com.br/delivery/curitiba-pr/kharina-steakhouse---cabral-cabral/8152217a-0a08-4512-8d18-ae240d7a1a37'
      ].join('\n')
    );
    return;
  }

  if (normalizedUnit === 'agua verde' || normalizedUnit === 'batel' || normalizedUnit === 'portao') {
    await sendWhatsAppText(
      to,
      [
        'Perfeito! 🍔 Para *Água Verde / Batel / Portão*, o pedido é por este link:',
        '👉 https://www.ifood.com.br/delivery/curitiba-pr/kharina-steakhouse---agua-verde-agua-verde/9cda85cb-fa38-47a1-9831-818dfe5991e9?UTM_Medium=share'
      ].join('\n')
    );
    return;
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
  await sendWhatsAppText(to, msg);
}

function hasCompleteReservationData(reservation?: ReservationState): boolean {
  return !!reservation?.name &&
    !!reservation?.people &&
    !!reservation?.date_text &&
    !!reservation?.time_text &&
    reservation?.kids !== undefined;
}

function getMissingReservationFields(reservation?: ReservationState): string[] {
  const missing: string[] = [];
  if (!reservation?.name) missing.push('seu nome');
  if (!reservation?.people) missing.push('quantos adultos');
  if (!reservation?.date_text) missing.push('a data');
  if (!reservation?.time_text) missing.push('o horário');
  if (reservation?.kids === undefined) missing.push('se terá crianças (e quantas)');
  return missing;
}

function buildInteractivePreview(menuPayload: any, fallbackText?: string): string {
  const bodyText = String(menuPayload?.interactive?.body?.text || '').trim();
  const interactiveType = String(menuPayload?.interactive?.type || '').trim();

  const optionTitles: string[] = [];
  if (interactiveType === 'button') {
    const buttons = Array.isArray(menuPayload?.interactive?.action?.buttons)
      ? menuPayload.interactive.action.buttons
      : [];
    buttons.forEach((button: any) => {
      const title = String(button?.reply?.title || '').trim();
      if (title) optionTitles.push(title);
    });
  } else if (interactiveType === 'list') {
    const sections = Array.isArray(menuPayload?.interactive?.action?.sections)
      ? menuPayload.interactive.action.sections
      : [];
    sections.forEach((section: any) => {
      const rows = Array.isArray(section?.rows) ? section.rows : [];
      rows.forEach((row: any) => {
        const title = String(row?.title || '').trim();
        const description = String(row?.description || '').trim();
        if (title && description) optionTitles.push(`${title} - ${description}`);
        else if (title) optionTitles.push(title);
      });
    });
  }

  if (bodyText && optionTitles.length > 0) {
    return `${bodyText}\n\nOpções:\n${optionTitles.map((title) => `- ${title}`).join('\n')}`;
  }
  if (bodyText) return bodyText;
  if (fallbackText) return fallbackText;
  return '[MENU_INTERATIVO]';
}

function beginOutboundCapture(userId: string): void {
  capturedOutboundByUser.set(userId, []);
}

function clearOutboundCapture(userId: string): void {
  capturedOutboundByUser.delete(userId);
}

function captureOutboundMessage(
  userId: string,
  content: string,
  attributes: Record<string, any> = { source: 'bot' },
  isPrivate = false
): void {
  const queue = capturedOutboundByUser.get(userId);
  if (!queue) return;

  const trimmed = String(content || '').trim();
  if (!trimmed) return;

  const normalized = normalizeForOutboundDedupe(trimmed);
  const last = queue[queue.length - 1];
  if (last && normalizeForOutboundDedupe(last.content) === normalized) return;

  queue.push({ content: trimmed, attributes, isPrivate });
}

function rememberRecentOutboundContent(userId: string, content: string): void {
  const trimmed = String(content || '').trim();
  if (!trimmed) return;

  const now = Date.now();
  const hash = normalizeForOutboundDedupe(trimmed);
  const normalizedContent = normalizeIntentText(trimmed);
  const recent = (recentOutboundContentByUser.get(userId) || [])
    .filter((entry) => now - entry.at <= RECENT_OUTBOUND_WINDOW_MS);

  recent.push({ at: now, hash, content: normalizedContent });
  recentOutboundContentByUser.set(userId, recent);
}

function getRecentOutboundContents(userId: string): string[] {
  const now = Date.now();
  const recent = (recentOutboundContentByUser.get(userId) || [])
    .filter((entry) => now - entry.at <= RECENT_OUTBOUND_WINDOW_MS);
  if (recent.length === 0) return [];
  recentOutboundContentByUser.set(userId, recent);
  return recent.map((entry) => entry.content || entry.hash);
}

function recentlyPromptedDeliveryCities(userId: string): boolean {
  const recent = getRecentOutboundContents(userId);
  return recent.some((content) => content.includes('de qual cidade voce esta pedindo') || content.includes('cidades com delivery'));
}

function recentlyPromptedReservationUnit(userId: string): boolean {
  const recent = getRecentOutboundContents(userId);
  return recent.some((content) => content.includes('qual unidade voce deseja') || content.includes('unidades kharina'));
}

export function wasRecentlyMirroredByBot(userId: string, content: string, windowMs = RECENT_OUTBOUND_WINDOW_MS): boolean {
  const trimmed = String(content || '').trim();
  if (!trimmed) return false;

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

async function flushCapturedOutboundToChatwoot(from: string, userName: string, fallbackSummary?: string): Promise<void> {
  const queue = capturedOutboundByUser.get(from) || [];
  clearOutboundCapture(from);

  if (queue.length === 0) {
    if (!fallbackSummary) return;
    await chatwootService.syncMessage(from, userName, fallbackSummary, 'outgoing', { source: 'bot', kind: 'deterministic_fallback' });
    return;
  }

  for (const msg of queue) {
    await chatwootService.syncMessage(
      from,
      userName,
      msg.content,
      'outgoing',
      msg.attributes || { source: 'bot' },
      !!msg.isPrivate
    );
  }
}

function parseReservationDetails(text: string): Partial<ReservationState> {
  const raw = String(text || '').trim();
  const t = raw.toLowerCase();
  const tNoAccent = t
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const updates: Partial<ReservationState> = {};

  const peopleMatch =
    tNoAccent.match(/\b(\d+)\s*[:\-]?\s*(pessoa|pessoas|adulto|adultos)\b/) ||
    tNoAccent.match(/\b(pessoas?|adultos?)\s*[:\-]?\s*(\d+)\b/);
  if (peopleMatch) {
    const val = parseInt((peopleMatch[1] || peopleMatch[2] || '0'), 10);
    if (!Number.isNaN(val) && val > 0) updates.people = val;
  } else {
    const peopleWordMatch =
      tNoAccent.match(new RegExp(`\\b(${PT_NUMBER_TOKEN_PATTERN})\\s*(pessoa|pessoas|adulto|adultos)\\b`)) ||
      tNoAccent.match(new RegExp(`\\b(pessoas?|adultos?)\\s*[:\\-]?\\s*(${PT_NUMBER_TOKEN_PATTERN})\\b`));
    const val = parsePtNumberToken((peopleWordMatch?.[1] || peopleWordMatch?.[2] || '').trim());
    if (val !== null && val > 0) updates.people = val;
  }

  if (
    /sem\s+crian/.test(tNoAccent) ||
    /\b0\s*crian/.test(tNoAccent) ||
    /\bnao\s+(tera|vai\s+ter|tem)\s+crian/.test(tNoAccent) ||
    /\bnao\s+(havera|vai\s+haver)\s+crian/.test(tNoAccent) ||
    /\bnenhuma\s+crian/.test(tNoAccent) ||
    /^(nao|não)\s+tera$/.test(tNoAccent.trim()) ||
    /^(nao|nenhuma|0)$/.test(tNoAccent.trim())
  ) {
    updates.kids = 0;
  } else {
    const kidsMatch =
      tNoAccent.match(new RegExp(`\\b(\\d+)\\s*[:\\-]?\\s*(${CHILDREN_WORD_PATTERN})\\b`)) ||
      tNoAccent.match(new RegExp(`\\b(${PT_NUMBER_TOKEN_PATTERN})\\s*[:\\-]?\\s*(${CHILDREN_WORD_PATTERN})\\b`)) ||
      tNoAccent.match(new RegExp(`\\b(${CHILDREN_WORD_PATTERN})\\b(?:\\s+(?:umas?|cerca\\s+de|mais\\s+ou\\s+menos))?\\s+(${PT_NUMBER_TOKEN_PATTERN})\\b`));
    if (kidsMatch) {
      const rawKidsValue = kidsMatch[2] && new RegExp(CHILDREN_WORD_PATTERN).test(kidsMatch[1]) ? kidsMatch[2] : kidsMatch[1];
      const k = parsePtNumberToken(rawKidsValue);
      if (k !== null && k >= 0) updates.kids = k;
    }
  }

  const today = new Date();
  const dmY = tNoAccent.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?\b/);
  if (dmY) {
    const day = parseInt(dmY[1], 10);
    const mon = parseInt(dmY[2], 10);
    let year = dmY[3] ? parseInt(dmY[3], 10) : today.getFullYear();
    if (year < 100) year += 2000;
    if (day >= 1 && day <= 31 && mon >= 1 && mon <= 12) {
      updates.date_text = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  if (!updates.date_text) {
    const monthMap: Record<string, number> = {
      janeiro: 1,
      fevereiro: 2,
      marco: 3,
      abril: 4,
      maio: 5,
      junho: 6,
      julho: 7,
      agosto: 8,
      setembro: 9,
      outubro: 10,
      novembro: 11,
      dezembro: 12,
    };
    const monthMatch = tNoAccent.match(/\b(\d{1,2})\s*(?:de\s*)?(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/);
    if (monthMatch) {
      const day = parseInt(monthMatch[1], 10);
      const mon = monthMap[monthMatch[2]];
      let year = today.getFullYear();
      const candidateCurrent = new Date(year, mon - 1, day);
      if (candidateCurrent < new Date(today.getFullYear(), today.getMonth(), today.getDate())) {
        year += 1;
      }
      if (day >= 1 && day <= 31) {
        updates.date_text = `${year}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      }
    }
  }

  if (!updates.date_text) {
    if (/\bhoje\b/.test(tNoAccent)) {
      updates.date_text = toIsoDate(today);
    } else if (/\bamanh/.test(tNoAccent)) {
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
      const byWeekday = weekdayMap.find((w) => w.rx.test(tNoAccent));
      if (byWeekday) {
        updates.date_text = toIsoDate(nextWeekdayDate(byWeekday.day, today));
      }
    }
  }

  if (!updates.date_text) {
    const dayOnly = tNoAccent.match(/\b(?:proximo)?\s*dia\s*(\d{1,2})\b/);
    if (dayOnly) {
      const day = parseInt(dayOnly[1], 10);
      const date = nextDayOfMonthDate(day, today);
      if (date) updates.date_text = toIsoDate(date);
    }
  }

  let hh: string | null = null;
  let mm = '00';
  if (/\bmeio\s*dia\b/.test(tNoAccent)) {
    hh = '12';
  } else if (/\bmeia\s*noite\b/.test(tNoAccent)) {
    hh = '00';
  }
  const hm = tNoAccent.match(/\b(\d{1,2})(?::|h)(\d{2})\s*h?\b/);
  if (!hh && hm) {
    hh = hm[1];
    mm = hm[2];
  } else {
    const hOnly = tNoAccent.match(/\b(\d{1,2})\s*(h|hs|hr|hrs|hora|horas)\b/);
    if (!hh && hOnly) hh = hOnly[1];
    else {
      const hWord = tNoAccent.match(/\b(?:as)\s*(\d{1,2})\b/);
      if (!hh && hWord && /(noite|tarde|manha)/.test(tNoAccent)) hh = hWord[1];
    }
  }
  if (hh !== null) {
    let h = parseInt(hh, 10);
    if (/noite|tarde/.test(tNoAccent) && h >= 1 && h <= 11) h += 12;
    if (h >= 0 && h <= 23) updates.time_text = `${String(h).padStart(2, '0')}:${mm}`;
  }

  const noteMarkers = [
    'obs', 'observa', 'anivers', 'janela', 'parquinho', 'perto do parquinho',
    'parte de baixo', 'andar de baixo', 'parte de cima', 'andar de cima',
    'docinho', 'docinhos', 'mesa embaixo', 'mesa em baixo', 'mesa em cima',
    'cadeira de bebe', 'cadeirinha', 'cadeirante', 'acessivel', 'acessível',
    'alerg', 'intoler', 'sem gluten', 'sem glúten', 'vegano', 'vegetar',
    'evento', 'atras', 'atrasar', 'varia', 'aprox', 'aproxim', 'juntar as mesas',
    'espaco kids', 'espaço kids', 'vista para o espaco kids', 'vista para o espaço kids',
    'frente para o espaco kids', 'frente para o espaço kids', 'de frente para o espaco kids',
    'de frente para o espaço kids', 'area kids', 'área kids', 'perto da area kids',
    'perto da área kids', 'perto do kids', 'proximo da area kids', 'proximo da área kids'
  ];
  const hasNoteMarker = noteMarkers.some((m) => tNoAccent.includes(m));
  const onlyKidsAnswer = /^(\s*(sem crian|nao|nenhuma|0)\s*)+$/.test(tNoAccent);
  if (hasNoteMarker && !onlyKidsAnswer) {
    updates.notes = raw.replace(/\s+/g, ' ').trim();
  }

  return updates;
}

function extractStandalonePeople(text: string): number | null {
  const t = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!t) return null;
  // Never infer adults from kids-only messages.
  if (/\bcrian/.test(t) && !/\b(adulto|adultos|pessoa|pessoas)\b/.test(t)) return null;

  // Accept first numeric token when it starts the sentence, e.g. "4 para amanhã às 11" or "seis".
  const m = t.match(new RegExp(`^(?:sao\\s+)?(${PT_NUMBER_TOKEN_PATTERN})\\b`));
  if (!m) return null;
  const n = parsePtNumberToken(m[1]);
  if (n === null || n <= 0 || n > 30) return null;
  return n;
}

function extractStandaloneTime(text: string): string | null {
  const t = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
  if (!t) return null;

  const explicitHm = t.match(/^(\d{1,2})(?::|h)(\d{2})\s*h?s?$/);
  if (explicitHm) {
    const hh = parseInt(explicitHm[1], 10);
    const mm = parseInt(explicitHm[2], 10);
    if (hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59) {
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    }
  }

  const explicitHour = t.match(/^(\d{1,2})\s*(h|hs|hr|hrs|hora|horas)?$/);
  if (!explicitHour) return null;
  const hh = parseInt(explicitHour[1], 10);
  if (hh < 0 || hh > 23) return null;
  return `${String(hh).padStart(2, '0')}:00`;
}

function extractExplicitNameUpdate(text: string, opts?: { allowBareName?: boolean }): string | null {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return null;

  const explicit = raw.match(/^(?:alterar\s+o\s+)?nome\s*[:\-]?\s*(.+)$/i);
  if (explicit) {
    const candidate = explicit[1].trim();
    if (
      candidate &&
      candidate.length >= 3 &&
      !/\b(data|horario|horário|adult|crianc|reserva|mesa|bolo|observa|telefone)\b/i.test(candidate)
    ) {
      return candidate;
    }
  }

  if (!opts?.allowBareName) return null;
  if (/\d/.test(raw)) return null;
  if (/[!?]/.test(raw)) return null;
  if (/^(sim|nao|não|ok|menu|voltar|data|horario|horário|nome)$/i.test(raw)) return null;
  if (/\b(data|horario|horário|adult|crianc|reserva|mesa|bolo|observa|telefone|unidade)\b/i.test(raw)) return null;

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;
  if (!words.every((word) => /^[A-Za-zÀ-ÿ'`-]+$/.test(word))) return null;
  return raw;
}

function extractPartyDeltas(text: string): { adultsDelta: number; kidsDelta: number } | null {
  const t = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (!t) return null;

  let adultsDelta = 0;
  let kidsDelta = 0;

  // Casais sempre contam como adultos.
  if (/\bmais\s+(um|1)\s+casal\b/.test(t)) adultsDelta += 2;
  if (/\bmenos\s+(um|1)\s+casal\b/.test(t)) adultsDelta -= 2;

  const casaisMais = t.match(/\bmais\s+(\d+)\s+casais\b/);
  if (casaisMais) adultsDelta += Number(casaisMais[1]) * 2;
  const casaisMenos = t.match(/\bmenos\s+(\d+)\s+casais\b/);
  if (casaisMenos) adultsDelta -= Number(casaisMenos[1]) * 2;

  const plusAdults = [...t.matchAll(/\bmais\s+(\d+|um|uma)\s+(adulto|adultos|pessoa|pessoas)\b/g)];
  for (const m of plusAdults) adultsDelta += (m[1] === 'um' || m[1] === 'uma') ? 1 : Number(m[1]);
  const minusAdults = [...t.matchAll(/\bmenos\s+(\d+|um|uma)\s+(adulto|adultos|pessoa|pessoas)\b/g)];
  for (const m of minusAdults) adultsDelta -= (m[1] === 'um' || m[1] === 'uma') ? 1 : Number(m[1]);

  const plusKids = [...t.matchAll(/\bmais\s+(\d+|uma|um)\s+(crianca|criancas)\b/g)];
  for (const m of plusKids) kidsDelta += (m[1] === 'um' || m[1] === 'uma') ? 1 : Number(m[1]);
  const minusKids = [...t.matchAll(/\bmenos\s+(\d+|uma|um)\s+(crianca|criancas)\b/g)];
  for (const m of minusKids) kidsDelta -= (m[1] === 'um' || m[1] === 'uma') ? 1 : Number(m[1]);

  if (!adultsDelta && !kidsDelta) return null;
  return { adultsDelta, kidsDelta };
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

function formatIncomingForChatwoot(message: any, normalizedText: string): string {
  const commandLabel = CHATWOOT_COMMAND_LABELS[normalizedText];
  if (commandLabel) return `[INTERACAO] ${commandLabel}`;

  if (message?.type === 'interactive') {
    const title = message.interactive?.button_reply?.title || message.interactive?.list_reply?.title;
    const id = message.interactive?.button_reply?.id || message.interactive?.list_reply?.id;
    if (title && id && title !== id) return `[INTERACAO] ${title} (${id})`;
    if (title) return `[INTERACAO] ${title}`;
    if (id) return `[INTERACAO] ${id}`;
  }

  if (normalizedText.startsWith('alter_pick_')) return '[INTERACAO] Selecionou reserva para alteracao';
  if (normalizedText.startsWith('cancel_pick_')) return '[INTERACAO] Selecionou reserva para cancelamento';
  if (normalizedText.startsWith('cancel_yes_')) return '[INTERACAO] Confirmou cancelamento da reserva';

  return normalizedText;
}

function buildDeterministicSyncMessage(normalizedText: string, state: UserState): string {
  const label = CHATWOOT_COMMAND_LABELS[normalizedText];
  if (label) return `[BOT] ${label}`;
  if (normalizedText.startsWith('alter_pick_')) return '[BOT] Iniciou fluxo de alteracao de reserva';
  if (normalizedText.startsWith('cancel_pick_')) return '[BOT] Iniciou fluxo de cancelamento de reserva';
  if (normalizedText.startsWith('cancel_yes_')) return '[BOT] Processando cancelamento de reserva';
  if (state?.last_interactive_menu) return `[BOT] ${state.last_interactive_menu}`;
  return '[BOT] Fluxo interativo executado';
}

function sanitizeAgentFallbackPhone(text: string, from: string, state?: UserState): string {
  if (!text) return text;
  const t = String(text);
  const lower = t.toLowerCase();
  const isUnitFallback =
    lower.includes('unidade') &&
    (lower.includes('falar direto') || lower.includes('telefone') || lower.includes('contato'));
  if (!isUnitFallback) return t;

  const unitName = String(state?.preferred_unit_name || '').trim();
  const unitPhone = UNIT_PHONE_BY_NAME[unitName];
  if (!unitPhone) return t;

  const fromDigits = toDigitsPhone(from);
  if (!fromDigits) return t;

  return t.replace(/\+?\d[\d\s().-]{8,}\d/g, (raw) => {
    const digits = raw.replace(/\D/g, '');
    return digits === fromDigits ? unitPhone : raw;
  });
}

function sanitizeReservationTimingResponse(text: string, state?: UserState): string {
  if (!text) return text;
  const raw = String(text).trim();
  const normalized = normalizeIntentText(raw);
  const mentionsOrderArrival = normalized.includes('ordem de chegada');
  if (mentionsOrderArrival) return raw;

  const looksLikeReservationTimingDenial =
    (
      normalized.includes('reserva') ||
      normalized.includes('reservar')
    ) &&
    (
      normalized.includes('horario') ||
      normalized.includes('hora') ||
      normalized.includes('antecedencia') ||
      normalized.includes('indisponivel') ||
      normalized.includes('disponibilidade')
    ) &&
    (
      normalized.includes('nao') ||
      normalized.includes('infelizmente') ||
      normalized.includes('nao conseguimos') ||
      normalized.includes('nao temos')
    );

  if (!looksLikeReservationTimingDenial) return raw;

  const unitName = String(state?.preferred_unit_name || '').trim();
  const invite = unitName
    ? `\n\nNesse caso, o atendimento na unidade *${unitName}* será por ordem de chegada ao restaurante. Ficaremos felizes em receber vocês por aqui.`
    : `\n\nNesse caso, o atendimento será por ordem de chegada ao restaurante. Ficaremos felizes em receber vocês por aqui.`;

  return `${raw}${invite}`;
}

function sanitizeIncompleteReservationFallback(text: string, state?: UserState): string {
  const raw = String(text || '').trim();
  if (!raw || !state?.reservation || !isInActiveFlow(state)) return raw;

  const missing = getMissingReservationFields(state.reservation);
  if (missing.length === 0) return raw;

  const normalized = normalizeIntentText(raw);
  const looksLikeStaleReservationDenial =
    normalized.includes('ja passaram') ||
    normalized.includes('já passaram') ||
    normalized.includes('novo horario') ||
    normalized.includes('novo horário') ||
    normalized.includes('nova data') ||
    normalized.includes('escolher um novo horario') ||
    normalized.includes('escolher um novo horário') ||
    normalized.includes('escolher outro horario') ||
    normalized.includes('escolher outro horário') ||
    normalized.includes('que tal escolher');

  if (!looksLikeStaleReservationDenial) return raw;

  return `Perfeito! ✅ Agora me confirma ${missing.join(' e ')}.`;
}

function shouldOfferMainMenu(result: any, state?: UserState): boolean {
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

function normalizeReservationPhone(raw: string): string {
  const digits = toDigitsPhone(raw);
  if (!digits) return '';
  if (digits.startsWith('55')) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function getPhoneLookupVariants(raw: string): string[] {
  const digits = normalizeReservationPhone(raw);
  if (!digits) return [];

  const local = digits.startsWith('55') ? digits.slice(2) : digits;
  if (local.length < 10) {
    return Array.from(new Set([digits, local].filter(Boolean)));
  }

  const ddd = local.slice(0, 2);
  const subscriber = local.slice(2);
  const variants = new Set<string>();

  const addVariant = (localNumber: string) => {
    if (!localNumber) return;
    variants.add(localNumber);
    variants.add(`55${localNumber}`);
  };

  addVariant(local);

  if (subscriber.length === 9 && subscriber.startsWith('9')) {
    addVariant(`${ddd}${subscriber.slice(1)}`);
  } else if (subscriber.length === 8) {
    addVariant(`${ddd}9${subscriber}`);
  }

  return Array.from(variants);
}

async function queryReservationsByPhoneVariants(phoneRaw: string): Promise<any[]> {
  const mcpReady = await ensureReservasMcpReady();
  if (!mcpReady) return [];

  for (const phone of getPhoneLookupVariants(phoneRaw)) {
    try {
      const result = await callReservasToolWithTimeout(
        'query_reservations',
        { clientPhone: phone },
        { timeoutMs: 15000, retries: 1, retryDelayMs: 600 }
      );
      const payload = parseMcpToolText(result);
      const all = extractReservationsList(payload);
      if (all.length > 0) return all;
    } catch (err: any) {
      console.error('[ReservasDeterministic] phone variant query failed:', phone, err?.message || err);
    }
  }

  return [];
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
  const m = v.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
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

function buildReservationIdentifierLines(picked: { id?: string; code?: string }): string[] {
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

async function getReservationConfirmationSnapshot(input: {
  picked: { id?: string; code?: string; status?: string };
  fallbackDate: string;
  fallbackTime: string;
  fallbackStoreId?: string;
  fallbackStoreName: string;
  fallbackTotalPeople: number;
  fallbackKids: number;
}): Promise<ReservationConfirmationSnapshot> {
  const fallback: ReservationConfirmationSnapshot = {
    id: input.picked.id,
    code: input.picked.code,
    status: input.picked.status,
    date: normalizeIsoDate(input.fallbackDate) || input.fallbackDate,
    time: normalizeTime(input.fallbackTime),
    storeId: input.fallbackStoreId,
    storeName: input.fallbackStoreName,
    totalPeople: Number(input.fallbackTotalPeople || 0),
    kids: Number(input.fallbackKids || 0)
  };

  const reservationId = String(input.picked.id || '').trim();
  if (!reservationId || !reservasAdminApiService.isConfigured()) return fallback;

  try {
    const saved = await reservasAdminApiService.getReservationById(reservationId);
    return {
      id: String(saved.id || reservationId),
      code: displayReservationCode({ id: saved.id || reservationId, code: input.picked.code }),
      status: String(saved.status || input.picked.status || ''),
      date: normalizeIsoDate(String(saved.date || '')) || fallback.date,
      time: normalizeTime(String(saved.time || '')) || fallback.time,
      storeId: String(saved.storeId || saved.store?.id || input.fallbackStoreId || ''),
      storeName: String(saved.store?.name || input.fallbackStoreName || '').trim() || fallback.storeName,
      totalPeople: Number(saved.guests ?? input.fallbackTotalPeople ?? 0),
      kids: Number(saved.kids ?? input.fallbackKids ?? 0)
    };
  } catch (err: any) {
    console.error('[ReservasDeterministic] getReservationById failed:', err?.message || err);
    return fallback;
  }
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

function statusEmoji(raw: any): string {
  const v = String(raw || '').toLowerCase();
  if (v === 'cancelled' || v === 'canceled') return '❌';
  if (v === 'waiting' || v === 'pending') return '⏳';
  if (v === 'confirmed') return '✅';
  return 'ℹ️';
}

function weekdayKeyFromText(text: string): keyof Record<string, any> | null {
  const t = String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (/\b(segunda|segunda-feira)\b/.test(t)) return 'monday';
  if (/\b(terca|terca-feira)\b/.test(t)) return 'tuesday';
  if (/\b(quarta|quarta-feira)\b/.test(t)) return 'wednesday';
  if (/\b(quinta|quinta-feira)\b/.test(t)) return 'thursday';
  if (/\b(sexta|sexta-feira)\b/.test(t)) return 'friday';
  if (/\b(sabado)\b/.test(t)) return 'saturday';
  if (/\b(domingo)\b/.test(t)) return 'sunday';
  return null;
}

function formatHourRange(open?: string, close?: string): string {
  if (!open || !close) return '';
  return `${normalizeTime(open)} às ${normalizeTime(close)}`;
}

async function getStoresWithHours(): Promise<any[]> {
  const cacheKey = 'reservas_stores';
  const cached = storesHoursCache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < STORES_HOURS_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const mcpReady = await ensureReservasMcpReady();
    if (mcpReady) {
      const result = await callReservasToolWithTimeout('list_stores', {}, { timeoutMs: 15000, retries: 1, retryDelayMs: 600 });
      const payload = parseMcpToolText(result);
      const stores = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
      if (stores.length > 0) {
        storesHoursCache.set(cacheKey, { data: stores, at: Date.now() });
        return stores;
      }
    }
  } catch (err: any) {
    console.error('[ReservasDeterministic] MCP list_stores failed, trying webhook fallback:', err?.message || err);
  }

  try {
    const stores = await reservasWebhookApiService.listStores();
    if (stores.length > 0) {
      storesHoursCache.set(cacheKey, { data: stores, at: Date.now() });
      return stores;
    }
  } catch (err: any) {
    console.error('[ReservasDeterministic] webhook stores fallback failed:', err?.message || err);
  }

  return [];
}

async function answerStoreHours(from: string, state: UserState, text: string): Promise<boolean> {
  const weekday = weekdayKeyFromText(text);
  if (!state.preferred_store_id || !state.preferred_unit_name) {
    await sendWhatsAppText(
      from,
      'Consigo te passar certinho, sim 😊 Me confirma primeiro a unidade (ex.: Batel, Cabral, Portão...) para eu consultar o horário correto.'
    );
    await sendUnidadesMenu(from);
    return true;
  }

  try {
    const stores = await getStoresWithHours();
    const store = stores.find((s: any) => String(s?.id || '').toLowerCase() === String(state.preferred_store_id).toLowerCase());
    const op = store?.operationHours || {};
    if (!store || !op || typeof op !== 'object') {
      await sendWhatsAppText(
        from,
        `Não consegui consultar o horário da unidade ${state.preferred_unit_name} agora 😕 Pode tentar novamente em instantes?`
      );
      return true;
    }

    if (weekday) {
      const dayInfo = op[weekday];
      if (!dayInfo) {
        await sendWhatsAppText(
          from,
          `Não encontrei o horário dessa unidade para esse dia agora. Se quiser, te passo os horários gerais da unidade ${state.preferred_unit_name}.`
        );
        return true;
      }
      const range = formatHourRange(dayInfo.open, dayInfo.close);
      const isOpen = dayInfo.isOpen !== false;
      await sendWhatsAppText(
        from,
        isOpen
          ? `Na unidade ${state.preferred_unit_name}, nesse dia, o horário é ${range}. 🍽️`
          : `Na unidade ${state.preferred_unit_name}, ela não abre nesse dia.`
      );
      return true;
    }

    const weekOrder: Array<[string, string]> = [
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
      if (!d) continue;
      if (d.isOpen === false) {
        lines.push(`- ${label}: fechada`);
      } else {
        lines.push(`- ${label}: ${formatHourRange(d.open, d.close)}`);
      }
    }
    await sendWhatsAppText(from, lines.join('\n'));
    return true;
  } catch (err: any) {
    console.error('[HoursDeterministic] failed:', err?.message || err);
    await sendWhatsAppText(
      from,
      `Não consegui consultar o horário da unidade ${state.preferred_unit_name} agora 😕 Pode tentar novamente em instantes?`
    );
    return true;
  }
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

async function buildHappyHourCardapioMessage(unitName?: string, city?: string): Promise<string | null> {
  const cardapioCommand = getCardapioCommandFromContext(unitName, city);
  if (!cardapioCommand) return null;

  const cardapioText = await buildCardapioMessage(cardapioCommand);
  const unitPhone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';

  return [
    'Claro. Para consultar os itens do *Happy Hour*, use este cardápio:',
    '',
    cardapioText,
    '',
    unitPhone
      ? `Se quiser confirmar itens ou valores do *Happy Hour* na unidade *${unitName}*, fale com a equipe pelo telefone *${unitPhone}*.`
      : 'Se quiser, eu também posso te passar o telefone da unidade para confirmar itens e valores do *Happy Hour*.'
  ].join('\n');
}

async function buildKidsInfoMessage(): Promise<string> {
  const base = await db.getConfig('kids_info_content');
  const configs = await db.listConfigs();
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
  if (!links) return content;
  return `${content}\n\n📸 Instagram do Espaço Kids por unidade:\n${links}`;
}

type ActiveReservation = {
  reservationId: string;
  code: string;
  storeId: string;
  storeName: string;
  name?: string;
  date: string;
  time: string;
  people: number;
  kids?: number;
  notes?: string;
  status: string;
};

type ReservationConfirmationSnapshot = {
  id?: string;
  code?: string;
  status?: string;
  date: string;
  time: string;
  storeId?: string;
  storeName: string;
  totalPeople: number;
  kids: number;
};

type ReservationMatchInput = {
  phone: string;
  storeId: string;
  date: string;
  time: string;
  people: number;
};

function phonesLookEquivalent(aRaw: string, bRaw: string): boolean {
  const a = toDigitsPhone(aRaw);
  const b = toDigitsPhone(bRaw);
  if (!a || !b) return false;
  const localA = a.startsWith('55') ? a.slice(2) : a;
  const localB = b.startsWith('55') ? b.slice(2) : b;
  return (
    a === b ||
    localA === localB ||
    localA.endsWith(localB) ||
    localB.endsWith(localA) ||
    localA.slice(-10) === localB.slice(-10) ||
    localA.slice(-8) === localB.slice(-8)
  );
}

function adminReservationMatchesBase(item: any, input: ReservationMatchInput): boolean {
  const itemDate = normalizeIsoDate(String(item?.date || ''));
  const itemTime = normalizeTime(String(item?.time || ''));
  const itemStoreId = String(item?.storeId || item?.store?.id || '').toLowerCase();
  const itemStatus = String(item?.status || '').toLowerCase();
  const itemPhone = String(item?.customerPhone || item?.clientPhone || item?.phone || '');

  return (
    itemDate === input.date &&
    itemTime === input.time &&
    itemStoreId === String(input.storeId).toLowerCase() &&
    !itemStatus.includes('cancel') &&
    phonesLookEquivalent(itemPhone, input.phone)
  );
}

function adminReservationMatchesExactPeople(item: any, input: ReservationMatchInput): boolean {
  const guests = Number(item?.guests ?? item?.numberOfPeople ?? item?.people ?? 0);
  const kids = Number(item?.kids ?? 0);
  const possibleTotals = new Set<number>([guests, guests + kids]);
  return possibleTotals.has(Number(input.people));
}

function adminReservationLikelyRecentCreate(item: any, input: ReservationMatchInput): boolean {
  const notes = normalizeIntentText(String(item?.notes || ''));
  const mentionsExpectedParty =
    notes.includes(`total ${input.people}`) ||
    notes.includes(`${input.people} pessoas`) ||
    notes.includes(`${input.people} pessoa`);

  const createdAt = Date.parse(String(item?.createdAt || item?.updatedAt || ''));
  const isRecent = Number.isFinite(createdAt) && Math.abs(Date.now() - createdAt) <= 30 * 60 * 1000;

  return mentionsExpectedParty || isRecent;
}

function extractReservationsList(payload: any): any[] {
  if (!payload) return [];
  if (Array.isArray(payload?.reservations)) return payload.reservations;
  if (Array.isArray(payload?.data?.reservations)) return payload.data.reservations;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

async function callReservasToolWithTimeout(
  tool: string,
  args: Record<string, any>,
  opts?: { timeoutMs?: number; retries?: number; retryDelayMs?: number }
): Promise<any> {
  const timeoutMs = opts?.timeoutMs ?? 15000;
  const retries = opts?.retries ?? 0;
  const retryDelayMs = opts?.retryDelayMs ?? 500;
  let lastErr: any;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Serialize Reservas MCP calls to avoid session contention and timeout cascades.
      const previous = reservasCallQueue.catch(() => { });
      let releaseQueue: (() => void) | undefined;
      reservasCallQueue = new Promise<void>((resolve) => { releaseQueue = resolve; });
      await previous;
      try {
        return await Promise.race([
          reservasMcp.callTool(tool, args),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`${tool} timeout`)), timeoutMs))
        ]);
      } finally {
        releaseQueue?.();
      }
    } catch (err: any) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
  throw lastErr;
}

async function fetchActiveReservations(phoneRaw: string): Promise<ActiveReservation[]> {
  const all = await queryReservationsByPhoneVariants(phoneRaw);
  const mapped = all
    .filter((x: any) => !String(x?.status || '').toLowerCase().includes('cancel'))
    .map((x: any) => ({
      reservationId: String(x?.reservationId || x?.id || ''),
      code: displayReservationCode({ id: x?.reservationId || x?.id, code: x?.code || x?.reservationCode || x?.confirmationCode }) || 'N/A',
      storeId: String(x?.storeId || ''),
      storeName: String(x?.storeName || x?.store || 'N/A'),
      name: String(x?.name || x?.clientName || x?.customerName || '').trim() || undefined,
      date: String(x?.date || ''),
      time: normalizeTime(String(x?.time || '')),
      people: Number(x?.numberOfPeople ?? x?.people ?? 0),
      kids: x?.kids !== undefined && x?.kids !== null ? Number(x.kids) : undefined,
      notes: String(x?.notes || x?.occasion || '').trim() || undefined,
      status: statusLabel(x?.status)
    }))
    .filter((x: ActiveReservation) => x.reservationId);
  if (mapped.length > 0) return mapped;
  return searchReservationsAdminFallback(phoneRaw);
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

function formatActiveReservationsMessage(reservations: ActiveReservation[]): string {
  const lines = ['Encontrei estas reservas no seu número:'];
  reservations.slice(0, 8).forEach((r, idx) => {
    lines.push(
      `${idx + 1}. 🔢 Código: ${r.code}\n` +
      `📍 Unidade: ${r.storeName}\n` +
      `📅 Data: ${toBrDate(r.date)}\n` +
      `⏰ Horário: ${normalizeTime(r.time)}\n` +
      `👥 Total de pessoas: ${r.people}\n` +
      `${statusEmoji(r.status)} Status: ${statusLabel(r.status)}`
    );
  });
  const hasActive = reservations.some((x) => !String(x.status || '').toLowerCase().includes('cancel'));
  lines.push(hasActive
    ? 'Se quiser, eu também posso cancelar ou alterar uma reserva ativa.'
    : 'No momento, todas as reservas listadas estão canceladas.');
  return lines.join('\n\n');
}

async function searchReservationsAdminFallback(phoneRaw: string): Promise<ActiveReservation[]> {
  if (!reservasAdminApiService.isConfigured()) return [];

  const digits = toDigitsPhone(phoneRaw);
  const localPhone = digits.startsWith('55') ? digits.slice(2) : digits;
  const searchTerms = Array.from(new Set([
    localPhone,
    localPhone.slice(-10),
    localPhone.slice(-8),
  ].filter((term) => term && term.length >= 8)));

  const results = new Map<string, ActiveReservation>();
  for (const term of searchTerms) {
    try {
      const response = await reservasAdminApiService.searchReservations(term, { status: 'confirmed', page: 1, limit: 20 });
      for (const item of response.data || []) {
        const itemPhone = toDigitsPhone(String(item.customerPhone || ''));
        if (!itemPhone) continue;
        const samePhone =
          itemPhone === localPhone ||
          itemPhone === localPhone.slice(-10) ||
          localPhone.endsWith(itemPhone) ||
          itemPhone.endsWith(localPhone.slice(-8));
        if (!samePhone) continue;

        results.set(item.id, {
          reservationId: String(item.id || ''),
          code: displayReservationCode({ id: item.id }) || 'N/A',
          storeId: String(item.storeId || item.store?.id || ''),
          storeName: String(item.store?.name || 'N/A'),
          name: String(item.customerName || '').trim() || undefined,
          date: String(item.date || ''),
          time: normalizeTime(String(item.time || '')),
          people: Number(item.guests || 0) + Number(item.kids || 0),
          kids: item.kids !== undefined && item.kids !== null ? Number(item.kids) : undefined,
          notes: String(item.notes || '').trim() || undefined,
          status: statusLabel(item.status),
        });
      }
    } catch (err: any) {
      console.error('[ReservasDeterministic] admin fallback search failed:', term, err?.message || err);
    }
  }

  return Array.from(results.values()).sort((a, b) =>
    `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`)
  );
}

async function findReservationMatchWithId(input: ReservationMatchInput): Promise<{ id?: string; code?: string; status?: string } | null> {
  for (const phone of getPhoneLookupVariants(input.phone)) {
    try {
      const verifyResult = await callReservasToolWithTimeout(
        'query_reservations',
        { clientPhone: phone },
        { timeoutMs: 12000, retries: 0 }
      );
      const verifyPayload = parseMcpToolText(verifyResult);
      const items = extractReservationsList(verifyPayload);
      const matched = items.find((x: any) =>
        normalizeIsoDate(x?.date) === input.date &&
        normalizeTime(x?.time) === input.time &&
        Number(x?.numberOfPeople || x?.people) === input.people &&
        String(x?.storeId || '').toLowerCase() === String(input.storeId).toLowerCase() &&
        !String(x?.status || '').toLowerCase().includes('cancel')
      );
      if (!matched) continue;

      const id = matched.reservationId || matched.id;
      if (!id) continue;
      return {
        id,
        code: matched.code || matched.reservationCode || matched.confirmationCode,
        status: matched.status
      };
    } catch (err: any) {
      console.error('[ReservasDeterministic] match lookup failed for phone variant:', phone, err?.message || err);
    }
  }

  return null;
}

async function findReservationMatchViaAdmin(input: ReservationMatchInput): Promise<{ id?: string; code?: string; status?: string } | null> {
  if (!reservasAdminApiService.isConfigured()) return null;

  try {
    const byStore = await reservasAdminApiService.listReservations({
      storeId: input.storeId,
      startDate: input.date,
      endDate: input.date,
      page: 1,
      limit: 100
    });
    const baseMatches = (byStore.data || []).filter((item) => adminReservationMatchesBase(item, input));
    const exactMatch = baseMatches.find((item) => adminReservationMatchesExactPeople(item, input));
    const matched = exactMatch || (baseMatches.length === 1 && adminReservationLikelyRecentCreate(baseMatches[0], input) ? baseMatches[0] : null);
    if (matched?.id) {
      return {
        id: String(matched.id),
        code: displayReservationCode({ id: matched.id }),
        status: matched.status
      };
    }
  } catch (err: any) {
    console.error('[ReservasDeterministic] admin match by store/date failed:', err?.message || err);
  }

  const digits = toDigitsPhone(input.phone);
  const localPhone = digits.startsWith('55') ? digits.slice(2) : digits;
  const searchTerms = Array.from(new Set([
    localPhone,
    localPhone.slice(-10),
    localPhone.slice(-8),
    localPhone.slice(-4),
  ].filter((term) => term && term.length >= 4)));

  for (const term of searchTerms) {
    try {
      const response = await reservasAdminApiService.searchReservations(term, {
        page: 1,
        limit: 50
      });
      const baseMatches = (response.data || []).filter((item) => adminReservationMatchesBase(item, input));
      const exactMatch = baseMatches.find((item) => adminReservationMatchesExactPeople(item, input));
      const matched = exactMatch || (baseMatches.length === 1 && adminReservationLikelyRecentCreate(baseMatches[0], input) ? baseMatches[0] : null);
      if (matched?.id) {
        return {
          id: String(matched.id),
          code: displayReservationCode({ id: matched.id }),
          status: matched.status
        };
      }
    } catch (err: any) {
      console.error('[ReservasDeterministic] admin match by search failed:', term, err?.message || err);
    }
  }

  return null;
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
      const adminHit = await findReservationMatchViaAdmin(input);
      if (adminHit?.id) return adminHit;
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

async function beginAlterReservationFlow(
  from: string,
  state: UserState,
  selected: ActiveReservation,
  initialText?: string
): Promise<void> {
  state.preferred_store_id = selected.storeId || state.preferred_store_id;
  state.preferred_unit_name = selected.storeName || state.preferred_unit_name;
  state.reservation = {
    ...(state.reservation || {}),
    phone_confirmed: true,
    awaiting_name: !selected.name && !state.reservation?.name,
    contact_phone: from,
    name: selected.name || state.reservation?.name,
    date_text: selected.date || state.reservation?.date_text,
    time_text: selected.time || state.reservation?.time_text,
    kids: selected.kids ?? state.reservation?.kids,
    people: selected.kids !== undefined
      ? Math.max(0, selected.people - Number(selected.kids || 0))
      : (state.reservation?.people ?? selected.people),
    notes: selected.notes || state.reservation?.notes,
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
    const extractedName = extractExplicitNameUpdate(incoming, { allowBareName: !state.reservation?.name });
    if (extractedName) {
      state.reservation = { ...(state.reservation || {}), name: extractedName };
    }
  }

  userStates.set(from, state);

  const missing: string[] = [];
  if (!state.reservation?.people) missing.push('o número de adultos');
  if (!state.reservation?.date_text) missing.push('a data');
  if (!state.reservation?.time_text) missing.push('o horário');
  if (state.reservation?.kids === undefined) missing.push('se terá crianças (e quantas)');

  if (missing.length === 0) {
    await sendWhatsAppText(from, `Perfeito! ✅ Atualizei a reserva ${selected.code} com os dados que você mandou.`);
    await sendReservationConfirmationOrBlock(from, state);
    return;
  }

  await sendWhatsAppText(
    from,
    `Perfeito! Vamos alterar a reserva ${selected.code}. Me confirma só ${missing.join(' e ')}.`
  );
}

async function queryReservationsDeterministic(from: string): Promise<{ ok: boolean; message: string }> {
  try {
    const all = await queryReservationsByPhoneVariants(from);
    if (!all.length && !(await ensureReservasMcpReady())) {
      return { ok: false, message: 'Tive uma instabilidade para consultar suas reservas agora 😕' };
    }

    if (all.length === 0) {
      const fallback = await searchReservationsAdminFallback(from);
      if (fallback.length === 0) {
        return { ok: true, message: 'Não encontrei reservas no seu número no momento.' };
      }
      return { ok: true, message: formatActiveReservationsMessage(fallback) };
    }

    const mapped = all.map((r: any) => ({
      reservationId: String(r?.reservationId || r?.id || ''),
      code: displayReservationCode({
        id: r?.reservationId || r?.id,
        code: r?.code || r?.reservationCode || r?.confirmationCode
      }) || 'N/A',
      storeId: String(r?.storeId || ''),
      storeName: String(r?.storeName || r?.store || 'N/A'),
      date: String(r?.date || ''),
      time: normalizeTime(String(r?.time || '')),
      people: Number(r?.numberOfPeople ?? r?.people ?? 0),
      kids: r?.kids !== undefined && r?.kids !== null ? Number(r.kids) : undefined,
      status: statusLabel(r?.status)
    }));
    return { ok: true, message: formatActiveReservationsMessage(mapped) };
  } catch (err: any) {
    console.error('[ReservasDeterministic] query_reservations failed:', err?.message || err);
    return { ok: false, message: 'Não consegui consultar suas reservas agora. Pode tentar novamente em instantes?' };
  }
}

async function createReservationDeterministic(from: string, state: UserState): Promise<{ ok: boolean; message: string; }> {
  const r = state.reservation || {};
  const storeId = state.preferred_store_id;
  const unitName = state.preferred_unit_name || 'unidade selecionada';
  const phone = normalizeReservationPhone(r.contact_phone || from);
  const date = normalizeIsoDate(r.date_text || '');
  const time = normalizeTime(r.time_text || '');
  const adults = Number(r.people || 0);
  const kids = Number(r.kids ?? 0);
  const totalPeople = adults + kids;
  const name = String(r.name || '').trim();
  const notes = String(r.notes || r.occasion || '').trim();
  let attemptId = Number(r.pending_attempt_id || 0) || undefined;

  if (!storeId || !phone || !date || !time || !adults || !name) {
    return {
      ok: false,
      message: 'Faltaram alguns dados obrigatórios para concluir a reserva. Vamos revisar rapidinho pelo resumo. 🙏'
    };
  }

  const leadTimeViolation = await getReservationLeadTimeViolation(date, time, unitName);
  if (leadTimeViolation) {
    if (state.reservation) state.reservation.awaiting_confirmation = false;
    userStates.set(from, state);
    return {
      ok: false,
      message: await buildReservationLeadTimeCustomerMessage(storeId, unitName, date, time, totalPeople)
    };
  }

  const closingBufferViolation = await getReservationClosingBufferViolation(storeId, date, time, unitName);
  if (closingBufferViolation) {
    if (state.reservation) state.reservation.awaiting_confirmation = false;
    userStates.set(from, state);
    return {
      ok: false,
      message: await buildReservationClosingBufferCustomerMessage(storeId, unitName, date, time, totalPeople)
    };
  }

  const block = await findMatchingReservationBlock({ storeId, date, time });
  if (block) {
    if (state.reservation) state.reservation.awaiting_confirmation = false;
    userStates.set(from, state);
    return {
      ok: false,
      message: await buildReservationBlockCustomerMessage(block, storeId, unitName, date, time, totalPeople)
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
    attemptId = await beginReservationAttempt({
      phone,
      storeId,
      storeName: unitName,
      customerName: name,
      dateText: date,
      timeText: time,
      adults,
      kids,
      totalPeople,
      notes
    });
    if (state.reservation) {
      state.reservation.pending_attempt_id = attemptId;
      userStates.set(from, state);
    }
    await syncReservationVerificationState(from, {
      attemptId,
      status: 'creating',
      storeName: unitName,
      dateText: date,
      timeText: time
    });

    // If client pressed confirm again, avoid duplicate creates and try to recover existing reservation first.
    const preExisting = await waitForReservationMatchWithId({ phone, storeId, date, time, people: totalPeople }, 2, 600);
    if (preExisting?.id) {
      const confirmed = await getReservationConfirmationSnapshot({
        picked: preExisting,
        fallbackDate: date,
        fallbackTime: time,
        fallbackStoreId: storeId,
        fallbackStoreName: unitName,
        fallbackTotalPeople: totalPeople,
        fallbackKids: kids
      });
      await updateReservationAttemptStatus(attemptId, 'confirmed_recovered', {
        resolutionSource: 'pre_existing_match',
        reservationId: String(confirmed.id || ''),
        reservationCode: displayReservationCode(confirmed)
      });
      await syncReservationVerificationState(from, {
        attemptId,
        status: 'confirmed_recovered',
        storeName: confirmed.storeName,
        dateText: confirmed.date,
        timeText: confirmed.time,
        reservationId: String(confirmed.id || ''),
        reservationCode: displayReservationCode(confirmed),
        resolutionSource: 'pre_existing_match'
      });
      const recoveredStatus = confirmed.status ? statusLabel(confirmed.status) : undefined;
      const recoveredLines = [
        `Reserva confirmada com sucesso na unidade ${confirmed.storeName}! 🎉`,
        `📅 Data: ${toBrDate(confirmed.date)}`,
        `⏰ Horário: ${confirmed.time}`,
        `👨 Adultos: ${adults}`,
        `👶 Crianças: ${kids}`,
        `👥 Total: ${totalPeople}`,
        ...buildReservationIdentifierLines(confirmed),
        recoveredStatus ? `${statusEmoji(confirmed.status)} Status: ${recoveredStatus}` : ''
      ].filter(Boolean);
      state.reservation = undefined;
      userStates.set(from, state);
      return { ok: true, message: recoveredLines.join('\n') };
    }

    let createResult: any;
    let createResultHadIdentifier = false;
    try {
      createResult = await callReservasToolWithTimeout(
        'create_reservation',
        createArgs,
        { timeoutMs: 20000, retries: 1, retryDelayMs: 700 }
      );
    } catch (err: any) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('client') || msg.includes('cliente') || msg.includes('not found') || msg.includes('não encontrado')) {
        if (name) {
          await callReservasToolWithTimeout('create_client', { name, phone }, { timeoutMs: 12000, retries: 1 });
          createResult = await callReservasToolWithTimeout(
            'create_reservation',
            createArgs,
            { timeoutMs: 20000, retries: 1, retryDelayMs: 700 }
          );
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }

    let picked = pickReservationCode(createResult);
    createResultHadIdentifier = !!picked.id;

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
          await callReservasToolWithTimeout(
            'create_client',
            { name, phone },
            { timeoutMs: 12000, retries: 1, retryDelayMs: 400 }
          ).catch(() => undefined);
        }

        const retryCreateResult = await callReservasToolWithTimeout(
          'create_reservation',
          createArgs,
          { timeoutMs: 25000, retries: 1, retryDelayMs: 900 }
        );
        let retryPicked = pickReservationCode(retryCreateResult);

        // Longer polling window to handle eventual consistency on MCP/Reservas.
        const retryMatched = await waitForReservationMatchWithId(
          { phone, storeId, date, time, people: totalPeople },
          12,
          2000
        );

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
      } catch (retryErr: any) {
        console.error('[ReservasDeterministic] second-chance create failed:', retryErr?.message || retryErr);
      }
    }

    if (!picked.id) {
      if (state.reservation) {
        state.reservation.awaiting_confirmation = false;
        state.reservation.awaiting_manual_review = true;
        state.reservation.manual_review_last_notice_at = Date.now();
        userStates.set(from, state);
      }
      await updateReservationAttemptStatus(attemptId, 'manual_review', {
        resolutionSource: 'missing_reservation_id'
      });
      await syncReservationVerificationState(from, {
        attemptId,
        status: 'manual_review',
        storeName: unitName,
        dateText: date,
        timeText: time,
        resolutionSource: 'missing_reservation_id'
      });
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
      await assignChatwootConversationToUnitManager(from, unitName, 'reservation_manual_review');
      return {
        ok: false,
        message: 'Tive uma instabilidade para confirmar sua reserva com segurança agora 😕\nPor favor, tente novamente em alguns minutos. Se preferir, nosso time já foi alertado para verificar por aqui.'
      };
    }

    const confirmed = await getReservationConfirmationSnapshot({
      picked,
      fallbackDate: date,
      fallbackTime: time,
      fallbackStoreId: storeId,
      fallbackStoreName: unitName,
      fallbackTotalPeople: totalPeople,
      fallbackKids: kids
    });
    const status = confirmed.status ? statusLabel(confirmed.status) : undefined;
    const previousReservationId = String(r.pending_change_source_id || '').trim();
    const previousReservationCode = String(r.pending_change_source_code || '').trim();

    if (previousReservationId) {
      try {
        await callReservasToolWithTimeout('cancel_reservation', {
          reservationId: previousReservationId,
          reason: 'Alteração solicitada pelo cliente via WhatsApp'
        }, { timeoutMs: 15000, retries: 1, retryDelayMs: 500 });
      } catch (cancelErr: any) {
        console.error('[ReservasDeterministic] cancel old reservation after alter failed:', cancelErr?.message || cancelErr);
      }
    }

    const lines = [
      `Reserva confirmada com sucesso! 🎉`,
      `Nos vemos dia ${toBrDate(confirmed.date)} às ${confirmed.time}h na unidade ${confirmed.storeName}! 🧡`,
      '',
      ...buildReservationIdentifierLines(confirmed),
      '',
      '⏰ Lembre-se:',
      '',
      'Procure chegar 10 minutos antes',
      'Você tem 10 minutos de tolerância',
      'Depois disso, a reserva é cancelada automaticamente ❤️'
    ].filter(line => line !== '');

    await updateReservationAttemptStatus(
      attemptId,
      createResultHadIdentifier ? 'confirmed_bot' : 'confirmed_recovered',
      {
        resolutionSource: createResultHadIdentifier ? 'mcp_create' : 'fallback_match',
        reservationId: String(confirmed.id || ''),
        reservationCode: displayReservationCode(confirmed)
      }
    );
    await syncReservationVerificationState(from, {
      attemptId,
      status: createResultHadIdentifier ? 'confirmed_bot' : 'confirmed_recovered',
      storeName: confirmed.storeName,
      dateText: confirmed.date,
      timeText: confirmed.time,
      reservationId: String(confirmed.id || ''),
      reservationCode: displayReservationCode(confirmed),
      resolutionSource: createResultHadIdentifier ? 'mcp_create' : 'fallback_match'
    });
    state.reservation = undefined;
    userStates.set(from, state);
    return { ok: true, message: lines.join('\n') };
  } catch (err: any) {
    console.error('[ReservasDeterministic] create_reservation failed:', err?.message || err);
    // Last-chance recovery for timeout/transport failures:
    // check if reservation was created but MCP response was lost.
    try {
      const recovered = await waitForReservationMatchWithId(
        { phone, storeId, date, time, people: totalPeople },
        6,
        2000
      );
      if (recovered?.id) {
        const confirmed = await getReservationConfirmationSnapshot({
          picked: recovered,
          fallbackDate: date,
          fallbackTime: time,
          fallbackStoreId: storeId,
          fallbackStoreName: unitName,
          fallbackTotalPeople: totalPeople,
          fallbackKids: kids
        });
        await updateReservationAttemptStatus(attemptId, 'confirmed_recovered', {
          resolutionSource: 'post_error_match',
          reservationId: String(confirmed.id || ''),
          reservationCode: displayReservationCode(confirmed)
        });
        await syncReservationVerificationState(from, {
          attemptId,
          status: 'confirmed_recovered',
          storeName: confirmed.storeName,
          dateText: confirmed.date,
          timeText: confirmed.time,
          reservationId: String(confirmed.id || ''),
          reservationCode: displayReservationCode(confirmed),
          resolutionSource: 'post_error_match'
        });
        const recoveredStatus = confirmed.status ? statusLabel(confirmed.status) : undefined;
        const recoveredLines = [
          `Reserva confirmada com sucesso! 🎉`,
          `Nos vemos dia ${toBrDate(confirmed.date)} às ${confirmed.time}h na unidade ${confirmed.storeName}! 🧡`,
          '',
          ...buildReservationIdentifierLines(confirmed),
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
    } catch (recoverErr: any) {
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
    await updateReservationAttemptStatus(attemptId, 'manual_review', {
      resolutionSource: 'technical_failure',
      lastError: String(err?.message || err || 'unknown')
    });
    await syncReservationVerificationState(from, {
      attemptId,
      status: 'manual_review',
      storeName: unitName,
      dateText: date,
      timeText: time,
      resolutionSource: 'technical_failure',
      lastError: String(err?.message || err || 'unknown')
    });
    if (state.reservation) state.reservation.awaiting_confirmation = false;
    if (state.reservation) state.reservation.awaiting_manual_review = true;
    if (state.reservation) state.reservation.manual_review_last_notice_at = Date.now();
    userStates.set(from, state);
    await assignChatwootConversationToUnitManager(from, unitName, 'reservation_manual_review');
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

async function downloadWhatsAppMedia(mediaId: string): Promise<Buffer | null> {
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

  try {
    const token = config.whatsapp.token;
    // 1. Get media URL
    const urlRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, axiosConfig);
    const downloadUrl = (urlRes.data as any)?.url;
    console.log(`[WhatsApp Media] Media ID ${mediaId} -> URL: ${downloadUrl ? (downloadUrl.substring(0, 50) + '...') : 'NULL'}`);
    
    if (!downloadUrl) return null;

    // 2. Download binary
    const downloadConfig = { ...axiosConfig, responseType: 'arraybuffer' };
    const mediaRes = await axios.get(downloadUrl, downloadConfig);
    return Buffer.from(mediaRes.data as ArrayBuffer);
  } catch (err: any) {
    console.error(`[WhatsApp Media] Download failed for ${mediaId}:`, err.message);
    if (err.stack) console.error(err.stack);
    if (err.config) console.error(`[WhatsApp Media] Error config URL: ${err.config.url}`);
    return null;
  }
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
  rememberRecentOutboundContent(to, text);
  captureOutboundMessage(to, text, { source: 'bot', kind: 'whatsapp_text' });
  console.log(`[WhatsApp] Sent to ${to}: "${text.substring(0, 80)}..."`);
}

async function sendWhatsAppSticker(to: string, stickerMediaIdOrLink: string): Promise<void> {
  const value = String(stickerMediaIdOrLink || '').trim();
  if (!value) return;

  const sticker: Record<string, string> = value.startsWith('http://') || value.startsWith('https://')
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
  } catch (err: any) {
    console.error('[WhatsApp] Failed to send sticker:', err?.message || err);
  }
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
    const previewText = buildInteractivePreview(menuPayload, fallbackText);
    rememberRecentOutboundContent(to, previewText);
    captureOutboundMessage(
      to,
      previewText,
      {
        source: 'bot',
        kind: 'whatsapp_interactive',
        interactive_label: label,
        interactive_type: String(menuPayload?.interactive?.type || '')
      }
    );
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

  if (!compact) {
    const introSticker = await db.getConfig('intro_sticker_media');
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
          ? "Se quiser, eu também posso te ajudar com reserva, delivery, Espaço Kids, achados e perdidos ou administração. 😊\n\nEscolha uma opção:"
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
            { id: "menu_kids", title: "4️⃣ Espaço Kids 🧸" },
            { id: "help_lost_found", title: "5️⃣ Achados e Perdidos 🔎" },
            { id: "menu_public_admin", title: "6️⃣ Administração 🏢" }
          ]
        }]
      }
    }
  };
  await sendInteractiveWithFallback(to, payload, 'send_main_menu',
    'Escolha: 1) Ver Cardápio 2) Reservar Mesa 3) Delivery 4) Espaço Kids 5) Achados e Perdidos 6) Administração');
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

async function sendFeedbackUnitsMenu(to: string): Promise<void> {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Qual loja você visitou para nos enviar sua avaliação?" },
      action: {
        button: "Ver lojas",
        sections: [{
          title: "Lojas Kharina",
          rows: [
            { id: "feedback_unit_cabral", title: "🏘️ Cabral" },
            { id: "feedback_unit_pdc", title: "🌆 São Paulo", description: "Parque da Cidade" },
            { id: "feedback_unit_londrina", title: "🏙️ Londrina" },
            { id: "feedback_unit_jardim_botanico", title: "🌿 Jardim Botânico" },
            { id: "feedback_unit_batel", title: "🏛️ Batel" },
            { id: "feedback_unit_portao", title: "🚪 Portão" },
            { id: "feedback_unit_agua_verde", title: "🌳 Água Verde" }
          ]
        }]
      }
    }
  };
  await sendInteractiveWithFallback(to, payload, 'send_feedback_units_menu',
    'Escolha a unidade: Cabral, PDC, Londrina, Jardim Botânico, Batel, Portão ou Água Verde.');
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

async function sendHelpMenu(to: string): Promise<void> {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Como posso te ajudar?" },
      action: {
        button: "Ver opções",
        sections: [{
          title: "Ajuda",
          rows: [
            { id: "help_lost_found", title: "Achados e Perdidos", description: "Avisar a unidade sobre um item esquecido" },
            { id: "help_unit_contact", title: "Contato da unidade", description: "Pedir telefone fixo da loja" }
          ]
        }]
      }
    }
  };
  await sendInteractiveWithFallback(to, payload, 'send_help_menu',
    'Ajuda: Achados e Perdidos ou contato da unidade.');
}

async function sendPublicAdminMenu(to: string): Promise<void> {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: 'Qual área administrativa você quer acionar?' },
      action: {
        button: 'Ver opções',
        sections: [{
          title: 'Administração',
          rows: [
            { id: 'public_admin_rh', title: 'RH', description: 'Assuntos de colaboradores e currículos' },
            { id: 'public_admin_compras', title: 'Compras', description: 'Demandas e contato com compras' },
            { id: 'public_admin_financeiro', title: 'Financeiro', description: 'Boletos, pagamentos e financeiro' },
            { id: 'public_admin_feedback', title: 'Sugestões/Críticas', description: 'Feedback geral para a administração' }
          ]
        }]
      }
    }
  };
  await sendInteractiveWithFallback(
    to,
    payload,
    'send_public_admin_menu',
    'Administração: RH, Compras, Financeiro ou Sugestões/Críticas.'
  );
}

async function sendPublicRhMenu(to: string): Promise<void> {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: 'Para o RH, me diga qual é o seu caso:' },
      action: {
        button: 'Ver opções',
        sections: [{
          title: 'RH',
          rows: [
            { id: 'public_admin_rh_employee', title: 'Já sou funcionário', description: 'Assuntos de colaborador' },
            { id: 'public_admin_rh_candidate', title: 'Não sou funcionário', description: 'Currículo e interesse em vaga' }
          ]
        }]
      }
    }
  };
  await sendInteractiveWithFallback(
    to,
    payload,
    'send_public_rh_menu',
    'RH: já sou funcionário ou não sou funcionário.'
  );
}

async function sendHelpUnitsMenu(to: string): Promise<void> {
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Em qual unidade aconteceu?" },
      action: {
        button: "Ver unidades",
        sections: [{
          title: "Unidades Kharina",
          rows: [
            { id: "help_unit_botanico", title: "🌿 Jardim Botânico" },
            { id: "help_unit_cabral", title: "🏘️ Cabral" },
            { id: "help_unit_agua_verde", title: "🌳 Água Verde" },
            { id: "help_unit_batel", title: "🏛️ Batel" },
            { id: "help_unit_portao", title: "🚪 Portão" },
            { id: "help_unit_londrina", title: "🏙️ Londrina" },
            { id: "help_unit_saopaulo", title: "🌆 São Paulo" }
          ]
        }]
      }
    }
  };
  await sendInteractiveWithFallback(to, payload, 'send_help_units_menu',
    'Em qual unidade aconteceu? Jardim Botânico, Cabral, Água Verde, Batel, Portão, Londrina ou São Paulo.');
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

async function sendAdminMainMenu(to: string, isMaster: boolean): Promise<void> {
  const rows = [
    { id: 'admin_menu_reservations', title: 'Reservas', description: 'Consultar totais e listagens por unidade' },
    { id: 'admin_menu_blocks', title: 'Bloqueios', description: 'Criar, listar e desativar regras' },
    { id: 'admin_menu_lead_time', title: 'Antecedência', description: 'Gerenciar o prazo mínimo da reserva' },
    { id: 'admin_menu_list_blocks', title: 'Regras ativas', description: 'Ver bloqueios vigentes agora' },
    ...(isMaster ? [{ id: 'admin_menu_admins', title: 'Administradores', description: 'Gerenciar acessos ao menu' }] : []),
    { id: 'admin_menu_exit', title: 'Sair', description: 'Encerrar modo administrativo' }
  ];

  const fallbackText = isMaster
    ? 'Menu admin: 1) Reservas 2) Bloqueios 3) Antecedência 4) Regras ativas 5) Administradores 6) Sair'
    : 'Menu admin: 1) Reservas 2) Bloqueios 3) Antecedência 4) Regras ativas 5) Sair';

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

  await sendInteractiveWithFallback(
    to,
    payload,
    'send_admin_main_menu',
    fallbackText
  );
}

async function sendAdminLeadTimeMenu(to: string): Promise<void> {
  const leadMinutes = await getCurrentReservationLeadMinutes();
  const leadHours = Math.round(leadMinutes / 60);
  const statusText = leadMinutes > 0
    ? `Ativo em *${formatLeadHoursLabel(leadHours)}*`
    : 'Desativado';

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: `Prazo mínimo para reservas automáticas.\n\n*Status atual:* ${statusText}` },
      action: {
        button: 'Ver ações',
        sections: [{
          title: 'Antecedência',
          rows: [
            { id: 'admin_lead_status', title: 'Ver status', description: 'Consultar a regra atual' },
            { id: 'admin_lead_enable_default', title: 'Ativar 4 horas', description: 'Aplicar o bloqueio padrão de 4 horas' },
            { id: 'admin_lead_disable', title: 'Desativar', description: 'Remover a antecedência mínima' },
            { id: 'admin_lead_change', title: 'Alterar prazo', description: 'Definir outro número de horas' },
            { id: 'admin_menu_back_main', title: 'Voltar', description: 'Retornar ao menu principal' }
          ]
        }]
      }
    }
  };

  await sendInteractiveWithFallback(
    to,
    payload,
    'send_admin_lead_time_menu',
    `Antecedência: status ${leadMinutes > 0 ? `ativo em ${formatLeadHoursLabel(leadHours)}` : 'desativado'} | 1) Ver status 2) Ativar 4 horas 3) Desativar 4) Alterar prazo 5) Voltar`
  );
}

async function sendAdminBlocksMenu(to: string): Promise<void> {
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

  await sendInteractiveWithFallback(
    to,
    payload,
    'send_admin_blocks_menu',
    'Bloqueios: 1) Criar 2) Listar 3) Desativar 4) Voltar'
  );
}

async function sendAdminReservationsMenu(to: string): Promise<void> {
  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: 'Consultas operacionais de reservas por unidade.' },
      action: {
        button: 'Ver ações',
        sections: [{
          title: 'Reservas',
          rows: [
            { id: 'admin_res_summary', title: 'Resumo geral', description: 'Compilado de todas as unidades' },
            { id: 'admin_res_create', title: 'Criar reserva', description: 'Cadastrar reserva manualmente' },
            { id: 'admin_res_list_today', title: 'Listar reservas hoje', description: 'Reservas confirmadas com paginação' },
            { id: 'admin_res_list_next7', title: 'Próximos 7 dias', description: 'Reservas confirmadas dos próximos 7 dias' },
            { id: 'admin_res_list_date', title: 'Buscar por data', description: 'Consultar reservas confirmadas de uma data' },
            { id: 'admin_menu_back_main', title: 'Voltar', description: 'Retornar ao menu principal' }
          ]
        }]
      }
    }
  };

  await sendInteractiveWithFallback(
    to,
    payload,
    'send_admin_reservations_menu',
    'Reservas: 1) Resumo geral 2) Criar reserva 3) Listar reservas hoje 4) Próximos 7 dias 5) Buscar por data 6) Voltar'
  );
}

async function sendAdminReservationStoreMenu(to: string, view: 'summary' | 'today' | 'next7' | 'date' | 'create'): Promise<void> {
  const rows = Object.entries(UNIT_CONFIG).map(([id, unit]) => ({
    id: `admin_res_store_${id}`,
    title: unit.name,
    description:
      view === 'summary'
        ? 'Ver resumo da unidade'
        : view === 'create'
          ? 'Criar reserva nesta unidade'
        : view === 'today'
          ? 'Ver reservas confirmadas de hoje'
          : view === 'next7'
            ? 'Ver reservas confirmadas dos próximos 7 dias'
            : 'Escolher esta unidade para buscar por data'
  }));

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: {
        text:
          view === 'summary'
            ? 'Escolha a unidade para consultar o resumo.'
            : view === 'create'
              ? 'Escolha a unidade para criar a reserva manualmente.'
            : view === 'today'
              ? 'Escolha a unidade para listar as reservas de hoje.'
              : view === 'next7'
                ? 'Escolha a unidade para listar as reservas confirmadas dos próximos 7 dias.'
                : 'Escolha a unidade e depois me envie a data no formato DD/MM/AAAA.'
      },
      action: {
        button: 'Ver unidades',
        sections: [{ title: 'Unidades', rows }]
      }
    }
  };

  await sendInteractiveWithFallback(
    to,
    payload,
    view === 'summary' ? 'send_admin_res_summary_store_menu' : 'send_admin_res_list_store_menu',
    'Escolha a unidade da consulta.'
  );
}

async function sendAdminCreateReservationConfirmMenu(to: string, draft: AdminReservationCreateDraft): Promise<void> {
  const lines = [
    '*Confirma a criação desta reserva?*',
    `*Unidade:* ${draft.store_name || 'N/A'}`,
    `*Nome:* ${draft.name || 'N/A'}`,
    `*Telefone:* ${draft.contact_phone ? `+${draft.contact_phone}` : 'N/A'}`,
    `*Data:* ${draft.date_text ? toBrDate(draft.date_text) : 'N/A'}`,
    `*Horário:* ${draft.time_text || 'N/A'}`,
    `*Adultos:* ${draft.adults ?? 'N/A'}`,
    `*Crianças:* ${draft.kids ?? 'N/A'}`,
    `*Observação:* ${draft.notes || 'Sem observação'}`
  ];

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: lines.join('\n') },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'admin_res_create_save', title: 'Salvar' } },
          { type: 'reply', reply: { id: 'admin_res_create_cancel', title: 'Cancelar' } }
        ]
      }
    }
  };

  await sendInteractiveWithFallback(to, payload, 'send_admin_create_reservation_confirm_menu', lines.join('\n'));
}

async function sendAdminReservationDatePrompt(to: string, storeName: string): Promise<void> {
  await sendWhatsAppText(to, `Perfeito. Agora me envie a data que você quer consultar na unidade ${storeName}, no formato DD/MM/AAAA.`);
}

async function sendAdminReservationSummary(to: string): Promise<void> {
  if (!reservasAdminApiService.isConfigured()) {
    await sendWhatsAppText(to, 'A integração da API de reservas ainda não foi configurada no bot.');
    return;
  }

  const [globalStats, storeStats] = await Promise.all([
    reservasAdminApiService.getReservationStats(),
    Promise.all(
      Object.values(UNIT_CONFIG).map(async (unit) => ({
        name: unit.name,
        stats: await reservasAdminApiService.getReservationStats(unit.storeId),
      }))
    ),
  ]);

  const todayStoreLines = storeStats
    .filter((item) => Number(item.stats.todayReservations || 0) > 0)
    .map((item) => `- *${item.name}:* ${item.stats.todayReservations}`);

  const upcomingStoreLines = storeStats
    .filter((item) => Number(item.stats.upcomingReservations || 0) > 0)
    .map((item) => `- *${item.name}:* ${item.stats.upcomingReservations}`);

  const lines = [
    '*Resumo Geral de Reservas*',
    '',
    '*Hoje*',
    `*Total geral:* ${globalStats.todayReservations}`,
    ...(todayStoreLines.length > 0 ? todayStoreLines : ['_Nenhuma reserva para hoje no momento._']),
    '',
    '*Próximos dias*',
    `*Total geral:* ${globalStats.upcomingReservations}`,
    ...(upcomingStoreLines.length > 0 ? upcomingStoreLines : ['_Nenhuma reserva futura no momento._'])
  ];

  await sendWhatsAppText(to, lines.join('\n'));
}

async function sendAdminReservationListPage(to: string, state: UserState): Promise<void> {
  const admin = ensureAdminState(state);
  const storeId = String(admin.reservation_store_id || '').trim();
  const storeName = String(admin.reservation_store_name || '').trim() || 'Unidade';
  const page = Math.max(1, Number(admin.reservation_page || 1));
  const startDate = String(admin.reservation_start_date || '').trim();
  const endDate = String(admin.reservation_end_date || '').trim() || startDate;
  const view = admin.reservation_view || 'today';
  if (!storeId) {
    await sendWhatsAppText(to, 'Não encontrei a unidade da consulta. Vou voltar ao menu administrativo.');
    admin.step = 'main';
    clearAdminReservationState(state);
    userStates.set(to, state);
    await sendAdminMainMenu(to, (await getAdminUser(to))?.role === 'master');
    return;
  }

  if (!reservasAdminApiService.isConfigured()) {
    await sendWhatsAppText(to, 'A integração da API de reservas ainda não foi configurada no bot.');
    return;
  }

  const response = await reservasAdminApiService.listReservations({
    storeId,
    startDate,
    endDate,
    status: 'confirmed',
    page,
    limit: ADMIN_RESERVATION_PAGE_SIZE
  });

  const dateLabel =
    view === 'next7'
      ? `${toBrDate(startDate)} até ${toBrDate(endDate)}`
      : toBrDate(startDate);
  const title =
    view === 'next7'
      ? 'Reservas confirmadas dos próximos 7 dias'
      : view === 'date'
        ? 'Reservas confirmadas da data'
        : 'Reservas confirmadas de hoje';
  const totalLabel =
    view === 'next7'
      ? 'Total no período'
      : 'Total na data';
  const emptyLabel =
    view === 'next7'
      ? '_Nenhuma reserva confirmada para essa unidade nos próximos 7 dias._'
      : '_Nenhuma reserva confirmada para essa unidade nessa data._';

  const lines = [
    `*${title}*`,
    `*Unidade:* ${storeName}`,
    `*Data:* ${dateLabel}`,
    `*Página:* ${response.meta.page}/${Math.max(1, response.meta.totalPages)}`,
    `*${totalLabel}:* ${response.meta.total}`,
    ''
  ];

  if (response.data.length === 0) {
    lines.push(emptyLabel);
  } else {
    response.data.forEach((item, index) => {
      const phone = item.customerPhone ? formatBrazilPhone(item.customerPhone) : 'Sem telefone';
      const guests = Number(item.guests || 0);
      const kids = Number(item.kids || 0);
      const guestsLabel = kids > 0 ? `${guests} pessoas (${kids} crianças)` : `${guests} pessoas`;
      lines.push(
        `${(response.meta.page - 1) * response.meta.limit + index + 1}. *${toBrDate(item.date)} às ${normalizeTime(item.time)}*`,
        `_${String(item.customerName || 'Cliente').trim()}_`,
        `${guestsLabel} | ${phone}`,
        ''
      );
    });
  }

  await sendWhatsAppText(to, lines.join('\n').trim());

  const buttons = [];
  if (response.meta.hasPreviousPage) {
    buttons.push({ type: 'reply', reply: { id: 'admin_res_list_prev', title: 'Anterior' } });
  }
  if (response.meta.hasNextPage) {
    buttons.push({ type: 'reply', reply: { id: 'admin_res_list_next', title: 'Próxima' } });
  }
  buttons.push({ type: 'reply', reply: { id: 'admin_res_list_back', title: 'Voltar' } });

  const payload = {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: `Navegação da lista de reservas de ${storeName}.` },
      action: { buttons }
    }
  };

  await sendInteractiveWithFallback(
    to,
    payload,
    'send_admin_reservation_list_nav',
    response.meta.hasNextPage ? 'Digite "próxima" para ver mais reservas ou "voltar".' : 'Digite "voltar" para retornar ao menu de reservas.'
  );
}

async function sendAdminStoreMenu(to: string): Promise<void> {
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

  await sendInteractiveWithFallback(
    to,
    payload,
    'send_admin_store_menu',
    'Escolha a unidade do bloqueio.'
  );
}

async function sendAdminWeekdayMenu(to: string): Promise<void> {
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

async function sendAdminModeMenu(to: string): Promise<void> {
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

  await sendInteractiveWithFallback(
    to,
    payload,
    'send_admin_mode_menu',
    'Modo: bloquear, sugerir outro horário ou encaminhar para a equipe.'
  );
}

async function sendAdminBlockConfirmMenu(to: string, draft: AdminBlockDraft): Promise<void> {
  const summary = [
    'Confirma a criação deste bloqueio?',
    `• Unidade: ${draft.store_name || 'N/A'}`,
    `• Dia: ${weekdayLabel(draft.weekday ?? null)}`,
    `• Faixa: ${draft.start_time || 'N/A'} às ${draft.end_time || 'N/A'}`,
    `• Ação: ${draft.mode ? blockModeLabel(draft.mode) : 'N/A'}`
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

async function sendAdminAdminsMenu(to: string): Promise<void> {
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

  await sendInteractiveWithFallback(
    to,
    payload,
    'send_admin_admins_menu',
    'Administradores: 1) Adicionar 2) Listar 3) Remover 4) Voltar'
  );
}

async function sendAdminRoleMenu(to: string, phone: string): Promise<void> {
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

async function sendAdminRemoveAdminMenu(to: string, currentPhone: string): Promise<void> {
  const admins = await listAdminUsers();
  const rows = [];
  for (const admin of admins) {
    if (admin.phone === normalizeAdminPhone(currentPhone)) continue;
    const isFixedMaster = admin.role === 'master' && await isConfiguredMasterPhone(admin.phone);
    if (isFixedMaster) continue;
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

async function sendAdminRemoveConfirmMenu(to: string, phone: string): Promise<void> {
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

async function sendAdminDisableBlockMenu(to: string): Promise<void> {
  const blocks = await listReservationBlocks(true, 10);
  if (blocks.length === 0) {
    await sendWhatsAppText(to, 'Não há bloqueios ativos no momento.');
    return;
  }

  const rows = blocks.map((block) => ({
    id: `admin_block_disable_pick_${block.id}`,
    title: `${block.store_name} ${block.start_time}-${block.end_time}`.slice(0, 24),
    description: `${weekdayLabel(block.weekday)} | ${blockModeLabel(block.mode)}`.slice(0, 72)
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

async function sendAdminDisableBlockConfirmMenu(to: string, block: ReservationBlock): Promise<void> {
  const summary = describeReservationBlock(block);
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

async function sendReservationConfirmationOrBlock(to: string, state: UserState): Promise<boolean> {
  const leadTimeViolation = await getReservationLeadTimeViolation(
    state.reservation?.date_text,
    state.reservation?.time_text,
    state.preferred_unit_name
  );
  if (leadTimeViolation) {
    if (state.reservation) state.reservation.awaiting_confirmation = false;
    userStates.set(to, state);
    await sendWhatsAppText(
      to,
      await buildReservationLeadTimeCustomerMessage(
        state.preferred_store_id,
        state.preferred_unit_name,
        state.reservation?.date_text,
        state.reservation?.time_text,
        Number(state.reservation?.people || 0) + Number(state.reservation?.kids ?? 0)
      )
    );
    return false;
  }

  const closingBufferViolation = await getReservationClosingBufferViolation(
    state.preferred_store_id,
    state.reservation?.date_text,
    state.reservation?.time_text,
    state.preferred_unit_name
  );
  if (closingBufferViolation) {
    if (state.reservation) state.reservation.awaiting_confirmation = false;
    userStates.set(to, state);
    await sendWhatsAppText(
      to,
      await buildReservationClosingBufferCustomerMessage(
        state.preferred_store_id,
        state.preferred_unit_name,
        state.reservation?.date_text,
        state.reservation?.time_text,
        Number(state.reservation?.people || 0) + Number(state.reservation?.kids ?? 0)
      )
    );
    return false;
  }

  const block = await maybeGetReservationBlock(state);
  if (!block) {
    await sendConfirmationMenu(to, state);
    if (state.reservation) state.reservation.awaiting_confirmation = true;
    userStates.set(to, state);
    return true;
  }

  if (state.reservation) state.reservation.awaiting_confirmation = false;
  userStates.set(to, state);
  await sendWhatsAppText(
    to,
    await buildReservationBlockCustomerMessage(
      block,
      state.preferred_store_id,
      state.preferred_unit_name,
      state.reservation?.date_text,
      state.reservation?.time_text,
      Number(state.reservation?.people || 0) + Number(state.reservation?.kids ?? 0)
    )
  );
  return false;
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

function clearReservationDraftState(state: UserState): void {
  state.reservation = undefined;
  state.preferred_store_id = undefined;
  state.preferred_unit_name = undefined;
  state.pending_offer = undefined;
}

function getManualReviewMessage(state: UserState): string {
  const unitName = state.preferred_unit_name || '';
  const unitPhone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';
  if (unitName && unitPhone) {
    return `Sua solicitação anterior está em verificação pelo nosso time para confirmar a reserva com segurança. 😊\n\nSe preferir falar direto com a unidade *${unitName}*, o telefone é *${unitPhone}*.`;
  }
  return 'Sua solicitação anterior está em verificação pelo nosso time para confirmar a reserva com segurança. 😊';
}

function shouldAnswerDuringManualReview(normalizedNoAccent: string): boolean {
  return /\b(confirm|confirma|confirmado|confirmaram|reserva|status|verifica|verificacao|verificação|andamento|retorno|codigo|id|atendimento|humano|falar|unidade|telefone)\b/.test(normalizedNoAccent)
    || /\?/.test(normalizedNoAccent);
}

function isGenericManualReviewPing(normalizedNoAccent: string): boolean {
  return /^(oi|ola|bom dia|boa tarde|boa noite|ok|okay|obrigada|obrigado|valeu|blz|beleza|joia|show|certo|ta bom|tudo bem|hum|hmm|\?+)$/.test(normalizedNoAccent.trim());
}

export function clearReservationDraftForUser(userId: string): void {
  const state = userStates.get(userId);
  if (!state) return;
  clearReservationDraftState(state);
  userStates.set(userId, state);
}

export async function markReservationAttemptManualConfirmedForUser(userId: string, reservationCode?: string): Promise<void> {
  const attempt = await markLatestAttemptManualConfirmed(userId, { reservationCode });
  if (!attempt) return;
  await syncReservationVerificationState(userId, {
    attemptId: attempt.id,
    status: 'confirmed_manual',
    storeName: attempt.store_name,
    dateText: attempt.date_text,
    timeText: attempt.time_text,
    reservationId: attempt.reservation_id || undefined,
    reservationCode: attempt.reservation_code || reservationCode,
    resolutionSource: 'chatwoot_manual'
  });
}

function looksLikeExternalReservationResolution(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return (
    /\b(minha filha ja confirmou|minha filha ja fez|minha filha confirmou|ja confirmou|ja foi confirmado|ja esta confirmado|ja esta confirmada|ja esta resolvido)\b/.test(normalized) ||
    /^reserva confirmada\b/.test(normalized) ||
    /^consegui confirmar sua reserva\b/.test(normalized)
  );
}

async function sendAdminBlockList(to: string): Promise<void> {
  const blocks = await listReservationBlocks(true, 50);
  if (blocks.length === 0) {
    await sendWhatsAppText(to, 'Não há bloqueios ativos no momento.');
    return;
  }

  const lines = ['Bloqueios ativos:'];
  for (const block of blocks) {
    lines.push(`- ${describeReservationBlock(block)}`);
  }
  await sendWhatsAppText(to, lines.join('\n'));
}

async function sendAdminUserList(to: string): Promise<void> {
  const admins = await listAdminUsers();
  if (admins.length === 0) {
    await sendWhatsAppText(to, 'Não há administradores ativos cadastrados.');
    return;
  }

  const lines = ['Administradores ativos:'];
  for (const admin of admins) {
    const isFixedMaster = admin.role === 'master' && await isConfiguredMasterPhone(admin.phone);
    lines.push(`- ${admin.phone} | ${admin.role === 'master' ? 'Master' : 'Admin'}${isFixedMaster ? ' | fixo do sistema' : ''}`);
  }
  await sendWhatsAppText(to, lines.join('\n'));
}

async function handleAdminCommand(text: string, from: string, state: UserState): Promise<boolean> {
  const raw = String(text || '').trim();
  const normalized = raw.toLowerCase();
  const adminState = state.admin;
  const looksLikeAdmin = normalized === '/admin' || normalized.startsWith('admin_') || !!adminState?.step;
  if (!looksLikeAdmin) return false;

  const hasAdmins = await hasAnyAdminConfigured();
  if (!hasAdmins) {
    if (normalized === '/admin') {
      await sendWhatsAppText(
        from,
        'O acesso administrativo ainda não foi configurado. Defina o(s) número(s) master em `ADMIN_MASTER_PHONES` ou no config `admin_master_phones`.'
      );
    }
    return true;
  }

  const adminUser = await getAdminUser(from);
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
    currentAdminState.draft_reservation = undefined;
    currentAdminState.pending_lead_time_minutes = undefined;
    currentAdminState.pending_admin_phone = undefined;
    currentAdminState.pending_disable_block_id = undefined;
    currentAdminState.pending_remove_admin_phone = undefined;
    clearAdminReservationState(state);
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
    currentAdminState.draft_reservation = undefined;
    currentAdminState.pending_lead_time_minutes = undefined;
    currentAdminState.pending_admin_phone = undefined;
    currentAdminState.pending_disable_block_id = undefined;
    currentAdminState.pending_remove_admin_phone = undefined;
    clearAdminReservationState(state);
    userStates.set(from, state);
    await sendAdminMainMenu(from, isMaster);
    return true;
  }

  if (normalized === 'admin_menu_reservations') {
    currentAdminState.step = 'reservations';
    clearAdminReservationState(state);
    userStates.set(from, state);
    await sendAdminReservationsMenu(from);
    return true;
  }

  if (normalized === 'admin_menu_lead_time') {
    currentAdminState.step = 'lead_time_menu';
    currentAdminState.pending_lead_time_minutes = undefined;
    userStates.set(from, state);
    await sendAdminLeadTimeMenu(from);
    return true;
  }

  if (normalized === 'admin_lead_status') {
    const leadMinutes = await getCurrentReservationLeadMinutes();
    const leadHours = Math.round(leadMinutes / 60);
    await sendWhatsAppText(
      from,
      leadMinutes > 0
        ? `A antecedência mínima para reservas automáticas está *ativa* em *${formatLeadHoursLabel(leadHours)}*.`
        : 'A antecedência mínima para reservas automáticas está *desativada*.'
    );
    await sendAdminLeadTimeMenu(from);
    return true;
  }

  if (normalized === 'admin_lead_enable_default') {
    const savedMinutes = await updateReservationLeadMinutes(DEFAULT_RESERVATION_LEAD_MINUTES);
    currentAdminState.step = 'lead_time_menu';
    currentAdminState.pending_lead_time_minutes = undefined;
    userStates.set(from, state);
    await sendWhatsAppText(from, `Perfeito. A antecedência mínima foi ativada em *${formatLeadHoursLabel(Math.round(savedMinutes / 60))}*.`);
    await sendAdminLeadTimeMenu(from);
    return true;
  }

  if (normalized === 'admin_lead_disable') {
    await updateReservationLeadMinutes(0);
    currentAdminState.step = 'lead_time_menu';
    currentAdminState.pending_lead_time_minutes = undefined;
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Perfeito. A antecedência mínima das reservas automáticas foi *desativada*.');
    await sendAdminLeadTimeMenu(from);
    return true;
  }

  if (normalized === 'admin_lead_change') {
    currentAdminState.step = 'lead_time_wait_hours';
    currentAdminState.pending_lead_time_minutes = undefined;
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Me envie o novo prazo mínimo em *horas inteiras*. Ex.: `4`');
    return true;
  }

  if (currentAdminState.step === 'lead_time_wait_hours') {
    const hours = parseLeadTimeHoursInput(raw);
    if (hours === null) {
      await sendWhatsAppText(from, 'Valor inválido. Me envie apenas o número de *horas inteiras* entre `0` e `24`. Ex.: `4`');
      return true;
    }
    const savedMinutes = await updateReservationLeadMinutes(hours * 60);
    currentAdminState.step = 'lead_time_menu';
    currentAdminState.pending_lead_time_minutes = undefined;
    userStates.set(from, state);
    if (savedMinutes <= 0) {
      await sendWhatsAppText(from, 'Perfeito. A antecedência mínima foi *desativada*.');
    } else {
      await sendWhatsAppText(from, `Perfeito. A antecedência mínima foi atualizada para *${formatLeadHoursLabel(Math.round(savedMinutes / 60))}*.`);
    }
    await sendAdminLeadTimeMenu(from);
    return true;
  }

  if (
    normalized === 'admin_res_summary' ||
    normalized === 'admin_res_create' ||
    normalized === 'admin_res_list_today' ||
    normalized === 'admin_res_list_next7' ||
    normalized === 'admin_res_list_date'
  ) {
    if (normalized === 'admin_res_summary') {
      currentAdminState.step = 'reservations';
      clearAdminReservationState(state);
      userStates.set(from, state);
      try {
        await sendAdminReservationSummary(from);
        await sendAdminReservationsMenu(from);
      } catch (err: any) {
        console.error('[AdminReservations] summary query failed:', err?.response?.data || err?.message || err);
        await sendWhatsAppText(from, 'Não consegui consultar o resumo geral agora. Tente novamente em instantes.');
      }
      return true;
    }

    if (normalized === 'admin_res_create') {
      currentAdminState.step = 'reservation_create_pick_store';
      currentAdminState.reservation_view = 'create';
      currentAdminState.draft_reservation = {};
      clearAdminReservationState(state);
      currentAdminState.reservation_view = 'create';
      userStates.set(from, state);
      await sendAdminReservationStoreMenu(from, 'create');
      return true;
    }

    currentAdminState.step = 'reservation_store_pick';
    currentAdminState.reservation_view =
      normalized === 'admin_res_list_next7'
          ? 'next7'
          : normalized === 'admin_res_list_date'
            ? 'date'
            : 'today';
    currentAdminState.reservation_store_id = undefined;
    currentAdminState.reservation_store_name = undefined;
    currentAdminState.reservation_page = undefined;
    currentAdminState.reservation_start_date = undefined;
    currentAdminState.reservation_end_date = undefined;
    userStates.set(from, state);
    await sendAdminReservationStoreMenu(from, currentAdminState.reservation_view);
    return true;
  }

  if (normalized.startsWith('admin_res_store_')) {
    const unitId = normalized.replace('admin_res_store_', '').trim() as keyof typeof UNIT_CONFIG;
    const unit = UNIT_CONFIG[unitId];
    if (!unit) {
      await sendWhatsAppText(from, 'Não reconheci essa unidade. Vou abrir a lista novamente.');
      await sendAdminReservationStoreMenu(from, currentAdminState.reservation_view || 'summary');
      return true;
    }

    currentAdminState.reservation_store_id = unit.storeId;
    currentAdminState.reservation_store_name = unit.name;
    currentAdminState.reservation_page = 1;
    userStates.set(from, state);

    try {
      if (currentAdminState.reservation_view === 'create') {
        currentAdminState.step = 'reservation_create_wait_name';
        currentAdminState.draft_reservation = {
          ...(currentAdminState.draft_reservation || {}),
          store_id: unit.storeId,
          store_name: unit.name
        };
        userStates.set(from, state);
        await sendWhatsAppText(from, `Perfeito. Vamos criar uma reserva para a unidade ${unit.name}. Me envie o *nome do cliente*.`);
      } else if (currentAdminState.reservation_view === 'today') {
        const today = getSaoPauloTodayIso();
        currentAdminState.step = 'reservation_list';
        currentAdminState.reservation_start_date = today;
        currentAdminState.reservation_end_date = today;
        userStates.set(from, state);
        await sendAdminReservationListPage(from, state);
      } else if (currentAdminState.reservation_view === 'next7') {
        const today = getSaoPauloTodayIso();
        currentAdminState.step = 'reservation_list';
        currentAdminState.reservation_start_date = today;
        currentAdminState.reservation_end_date = addIsoDays(today, 6);
        userStates.set(from, state);
        await sendAdminReservationListPage(from, state);
      } else if (currentAdminState.reservation_view === 'date') {
        currentAdminState.step = 'reservation_wait_date';
        currentAdminState.reservation_start_date = undefined;
        currentAdminState.reservation_end_date = undefined;
        userStates.set(from, state);
        await sendAdminReservationDatePrompt(from, unit.name);
      } else {
        currentAdminState.step = 'reservations';
        currentAdminState.reservation_start_date = undefined;
        currentAdminState.reservation_end_date = undefined;
        userStates.set(from, state);
        await sendAdminReservationsMenu(from);
      }
    } catch (err: any) {
      console.error('[AdminReservations] store query failed:', err?.response?.data || err?.message || err);
      await sendWhatsAppText(from, 'Não consegui consultar a API de reservas agora. Tente novamente em instantes.');
    }
    return true;
  }

  if (normalized === 'admin_res_create_cancel') {
    currentAdminState.step = 'reservations';
    currentAdminState.draft_reservation = undefined;
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Criação manual de reserva cancelada.');
    await sendAdminReservationsMenu(from);
    return true;
  }

  if (currentAdminState.step === 'reservation_create_wait_name') {
    const name = extractExplicitNameUpdate(raw, { allowBareName: true }) || '';
    if (!name || !isUsableContactName(name)) {
      await sendWhatsAppText(from, 'Nome inválido. Me envie o *nome completo do cliente*.');
      return true;
    }
    currentAdminState.step = 'reservation_create_wait_phone';
    currentAdminState.draft_reservation = {
      ...(currentAdminState.draft_reservation || {}),
      name
    };
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Agora me envie o *telefone* no formato *+55DDDNÚMERO*. Ex.: `+5541999999999`');
    return true;
  }

  if (currentAdminState.step === 'reservation_create_wait_phone') {
    const phone = parseAdminReservationPhoneInput(raw);
    if (!phone) {
      await sendWhatsAppText(from, 'Telefone inválido. Envie no formato *+55DDDNÚMERO*. Ex.: `+5541999999999`');
      return true;
    }
    currentAdminState.step = 'reservation_create_wait_date';
    currentAdminState.draft_reservation = {
      ...(currentAdminState.draft_reservation || {}),
      contact_phone: phone
    };
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Agora me envie a *data* no formato *DD/MM/AAAA*.');
    return true;
  }

  if (currentAdminState.step === 'reservation_create_wait_date') {
    const parsedDate = parseAdminDateInput(raw);
    if (!parsedDate) {
      await sendWhatsAppText(from, 'Data inválida. Envie no formato *DD/MM/AAAA*.');
      return true;
    }
    currentAdminState.step = 'reservation_create_wait_time';
    currentAdminState.draft_reservation = {
      ...(currentAdminState.draft_reservation || {}),
      date_text: parsedDate
    };
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Agora me envie o *horário* no formato *HH:MM*. Ex.: `19:30`');
    return true;
  }

  if (currentAdminState.step === 'reservation_create_wait_time') {
    const parsedTime = isValidAdminTimeInput(raw);
    if (!parsedTime) {
      await sendWhatsAppText(from, 'Horário inválido. Envie no formato *HH:MM*. Ex.: `19:30`');
      return true;
    }
    currentAdminState.step = 'reservation_create_wait_adults';
    currentAdminState.draft_reservation = {
      ...(currentAdminState.draft_reservation || {}),
      time_text: parsedTime
    };
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Quantos *adultos* estarão na reserva?');
    return true;
  }

  if (currentAdminState.step === 'reservation_create_wait_adults') {
    const adults = parseAdminReservationCountInput(raw);
    if (adults === null || adults <= 0) {
      await sendWhatsAppText(from, 'Quantidade inválida. Me envie o número de *adultos* usando apenas número. Ex.: `4`');
      return true;
    }
    currentAdminState.step = 'reservation_create_wait_kids';
    currentAdminState.draft_reservation = {
      ...(currentAdminState.draft_reservation || {}),
      adults
    };
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Quantas *crianças* irão? Se não tiver, responda `0`.');
    return true;
  }

  if (currentAdminState.step === 'reservation_create_wait_kids') {
    const kids = parseAdminReservationCountInput(raw, true);
    if (kids === null || kids < 0) {
      await sendWhatsAppText(from, 'Quantidade inválida. Me envie o número de *crianças*. Se não tiver, responda `0`.');
      return true;
    }
    currentAdminState.step = 'reservation_create_wait_notes';
    currentAdminState.draft_reservation = {
      ...(currentAdminState.draft_reservation || {}),
      kids
    };
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Se houver *observação*, me envie agora. Se não houver, responda `sem observação`.');
    return true;
  }

  if (currentAdminState.step === 'reservation_create_wait_notes') {
    currentAdminState.step = 'reservation_create_confirm';
    currentAdminState.draft_reservation = {
      ...(currentAdminState.draft_reservation || {}),
      notes: parseAdminReservationNotesInput(raw)
    };
    userStates.set(from, state);
    await sendAdminCreateReservationConfirmMenu(from, currentAdminState.draft_reservation || {});
    return true;
  }

  if (normalized === 'admin_res_create_save') {
    const draft = currentAdminState.draft_reservation || {};
    if (!draft.store_id || !draft.store_name || !draft.name || !draft.contact_phone || !draft.date_text || !draft.time_text || draft.adults === undefined || draft.kids === undefined) {
      await sendWhatsAppText(from, 'Faltaram dados da reserva manual. Vou voltar ao menu de reservas.');
      currentAdminState.step = 'reservations';
      currentAdminState.draft_reservation = undefined;
      userStates.set(from, state);
      await sendAdminReservationsMenu(from);
      return true;
    }

    const preservedState = userStates.get(from);
    const tempState: UserState = {
      preferred_store_id: draft.store_id,
      preferred_unit_name: draft.store_name,
      reservation: {
        name: draft.name,
        contact_phone: draft.contact_phone,
        phone_confirmed: true,
        date_text: draft.date_text,
        time_text: draft.time_text,
        people: draft.adults,
        kids: draft.kids,
        notes: draft.notes || undefined
      }
    };

    await sendWhatsAppText(from, 'Perfeito! ✅ Estou criando a reserva manual agora, só um instante...');
    const result = await createReservationDeterministic(from, tempState);
    if (preservedState) userStates.set(from, preservedState);
    else userStates.delete(from);

    currentAdminState.step = 'reservations';
    currentAdminState.draft_reservation = undefined;
    userStates.set(from, state);
    await sendWhatsAppText(from, result.message);
    await sendAdminReservationsMenu(from);
    return true;
  }

  if (currentAdminState.step === 'reservation_wait_date') {
    const parsedDate = parseAdminDateInput(raw);
    if (!parsedDate) {
      await sendWhatsAppText(from, 'Data inválida. Me envie no formato DD/MM/AAAA. Ex.: 13/03/2026');
      return true;
    }

    currentAdminState.step = 'reservation_list';
    currentAdminState.reservation_page = 1;
    currentAdminState.reservation_start_date = parsedDate;
    currentAdminState.reservation_end_date = parsedDate;
    userStates.set(from, state);
    try {
      await sendAdminReservationListPage(from, state);
    } catch (err: any) {
      console.error('[AdminReservations] date query failed:', err?.response?.data || err?.message || err);
      await sendWhatsAppText(from, 'Não consegui consultar essa data agora. Tente novamente em instantes.');
    }
    return true;
  }

  if (normalized === 'admin_res_list_next' || normalized === 'admin_res_list_prev') {
    const currentPage = Math.max(1, Number(currentAdminState.reservation_page || 1));
    currentAdminState.step = 'reservation_list';
    currentAdminState.reservation_page = normalized === 'admin_res_list_next' ? currentPage + 1 : Math.max(1, currentPage - 1);
    userStates.set(from, state);
    try {
      await sendAdminReservationListPage(from, state);
    } catch (err: any) {
      console.error('[AdminReservations] pagination failed:', err?.response?.data || err?.message || err);
      await sendWhatsAppText(from, 'Não consegui carregar a próxima página agora. Tente novamente em instantes.');
    }
    return true;
  }

  if (normalized === 'admin_res_list_back') {
    currentAdminState.step = 'reservations';
    clearAdminReservationState(state);
    userStates.set(from, state);
    await sendAdminReservationsMenu(from);
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
    } else {
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
    const unitId = normalized.replace('admin_block_store_', '').trim() as keyof typeof UNIT_CONFIG;
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
    const mode: ReservationBlockMode =
      normalized === 'admin_block_mode_suggest'
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

    const block = await createReservationBlock({
      storeId: draft.store_id,
      storeName: draft.store_name,
      weekday: draft.weekday ?? null,
      startTime: draft.start_time,
      endTime: draft.end_time,
      mode: draft.mode,
      message: buildDefaultBlockMessage({
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
    await sendWhatsAppText(from, `Bloqueio criado com sucesso.\n${describeReservationBlock(block)}`);
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
    const block = Number.isFinite(id) ? await getReservationBlock(id) : null;
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
    await deactivateReservationBlock(blockId, from);
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
    const extracted = extractPhoneCandidate(raw) || normalizeAdminPhone(raw);
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

    const role: AdminRole = normalized === 'admin_admin_role_master' ? 'master' : 'admin';
    const saved = await addOrUpdateAdminUser(targetPhone, role, from);
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
      await deactivateAdminUser(phone, from);
      await sendWhatsAppText(from, `Acesso removido do número ${phone}.`);
    } catch (err: any) {
      const reason = String(err?.message || err || '');
      if (reason === 'cannot_remove_self') {
        await sendWhatsAppText(from, 'Você não pode remover o seu próprio acesso por este menu.');
      } else if (reason === 'cannot_remove_bootstrap_master') {
        await sendWhatsAppText(from, 'Esse administrador master é fixo do sistema e precisa ser removido da configuração do ambiente antes.');
      } else if (reason === 'cannot_remove_last_master') {
        await sendWhatsAppText(from, 'Não posso remover o último administrador master.');
      } else {
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

async function handleDeterministicCommand(
  text: string,
  from: string,
  state: UserState,
  profileName?: string
): Promise<boolean> {
  if (await handleAdminCommand(text, from, state)) {
    return true;
  }

  const normalized = text.trim().toLowerCase();
  const normalizedNoAccent = normalized
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const normalizedIntent = normalizeIntentText(text);
  const parsedReservationInput = parseReservationDetails(text);
  const hasReservationPayloadInText =
    parsedReservationInput.people !== undefined ||
    parsedReservationInput.kids !== undefined ||
    !!parsedReservationInput.date_text ||
    !!parsedReservationInput.time_text ||
    !!parsedReservationInput.notes;
  const isThanks = /\b(obrigad[oa]?|valeu|agrade[cç]o|muito obrigado|brigad[oa]?|thanks)\b/.test(normalized);
  const isGreeting = GREETING_COMMANDS.has(normalized) || GREETING_REGEX.test(normalized);
  const isExternalReservationResolved = looksLikeExternalReservationResolution(text);
  const isGenericAck = /^(ok|okay|okk|blz|beleza|certo|certinho|fechado|show|perfeito|sim|isso|mandei|enviei|ja te mandei|ja mandei|te mandei|pronto|segue|pode ser)$/.test(normalizedIntent);
  const isOfferAcceptance =
    isGenericAck ||
    /^(sim quero|sim quero fazer|sim quero reservar|quero|quero fazer|quero reservar|vamos|bora|claro|com certeza|por favor|pode deixar|pode deixar por favor|deixa por favor|pode sim)$/.test(normalizedIntent);
  const isOfferRejection =
    /^(nao|não|nao obrigado|não obrigado|deixa|deixa pra la|deixa pra lá|agora nao|agora não)$/.test(normalizedIntent);
  const isBirthdayCakeQuestion =
    /\b(bolo|aniversa(?:rio|́rio))\b/.test(normalizedNoAccent) &&
    /\b(pode|permitid|autoriz|levar|trazer)\b/.test(normalizedNoAccent);
  const isCakeNoteStatement =
    /\b(bolo|aniversa(?:rio|́rio))\b/.test(normalizedNoAccent) &&
    (
      /\b(vou|vamos|iremos|levarei|levaremos|trarei|traremos|anota|anotar|observa|obs)\b/.test(normalizedNoAccent) ||
      /\b(levar|trazer)\b/.test(normalizedNoAccent)
    ) &&
    !/\b(posso|pode|permitid|autoriz)\b/.test(normalizedNoAccent);
  const isCorkageQuestion =
    /\b(rolha|vinho|bebida(?:s)?\s+de\s+casa|bebida\s+de\s+fora)\b/.test(normalizedNoAccent) &&
    /\b(pode|permitid|autoriz|levar|trazer|tem|custa|cobra|taxa)\b/.test(normalizedNoAccent);
  const isBirthdayDessertQuestion =
    /\b(sobremesa|doce|docinho|brinde)\b/.test(normalizedNoAccent) &&
    /\b(aniversariant|aniversario)\b/.test(normalizedNoAccent);
  const isDietaryOptionsQuestion =
    /\b(vegano|vegana|veganos|veganas|vegetariano|vegetariana|vegetarianos|vegetarianas)\b/.test(normalizedNoAccent);
  const isFoodInfoQuestion =
    (
      /\b(ingrediente|ingredientes|composicao|composição|leva|tem|vai)\b/.test(normalizedNoAccent) &&
      /\b(maionese|molho|burger|burguer|lanche|hamburg)\b/.test(normalizedNoAccent)
    ) ||
    (
      /\b(alerg|alergic|intoler)\b/.test(normalizedNoAccent) &&
      /\b(maionese|molho|burger|burguer|lanche|hamburg)\b/.test(normalizedNoAccent)
    );
  const isGourmetQuestion =
    /\bgourmet\b/.test(normalizedNoAccent);
  const isLostAndFoundQuestion =
    (
      /\b(esqueci|perdi|deixei|sumiu|esquecido|perdido)\b/.test(normalizedNoAccent) &&
      /\b(chave|celular|carteira|documento|oculos|óculos|bolsa|mochila|carro)\b/.test(normalizedNoAccent)
    ) ||
    /\bachados?\s+e\s+perdidos?\b/.test(normalizedNoAccent);
  const isHumanAssistanceRequest =
    /\batendimento\s+humano\b/.test(normalizedNoAccent) ||
    /\b(falar|atendente|equipe|humano|pessoa|alguem|alguém)\b/.test(normalizedNoAccent) &&
    /\b(com|direto|preciso|quero)\b/.test(normalizedNoAccent);
  const isFrustrationMessage =
    /\b(ja mandei|ja enviei|mande[iy]\s+\d+|pqp|que saco|sistema espanta cliente|nao funciona|não funciona|erro de novo|quatro vezes|seis vezes)\b/.test(normalizedNoAccent);
  const isReviewStatusRequest =
    /\b(confirma|confirmar|pode me confirmar|consegue confirmar|confirmacao|confirmação|ja foi|já foi|deu certo|certo)\b/.test(normalizedNoAccent);
  const isKidsAgeQuestion =
    (
      /\b(espaco kids|espaço kids|kids)\b/.test(normalizedNoAccent) ||
      /\bbrincar\b/.test(normalizedNoAccent)
    ) &&
    (
      /\bidade\b/.test(normalizedNoAccent) ||
      /\b(\d{1,2})\s*anos?\b/.test(normalizedNoAccent) ||
      /\bate que idade\b/.test(normalizedNoAccent) ||
      /\bpode\b/.test(normalizedNoAccent)
    );
  const isBotIdentityQuestion =
    /\b(quem\s+(e|é)\s+voce|quem\s+e\s+vc|quem\s+e\s+tu|quem\s+e\s+vcs?)\b/.test(normalizedNoAccent) ||
    (
      /\b(qual|quais|me fala|fala|diz|diga|escreve)\b/.test(normalizedNoAccent) &&
      /\b(seu|teu)\s+nome\b/.test(normalizedNoAccent)
    ) ||
    /\b(seu|teu)\s+nome\s+e\b/.test(normalizedNoAccent);
  const isHappyHourQuestion =
    /\bhappy\s*hour\b/.test(normalizedNoAccent) ||
    (
      /\b(desconto|promoc[aã]o|promocoes|promo[cç][aã]o)\b/.test(normalizedNoAccent) &&
      /\b(16h|20h|segunda|sexta|dias|horario|horarios)\b/.test(normalizedNoAccent)
    );
  const isHappyHourCardapioIntent =
    /\bhappy\s*hour\b/.test(normalizedNoAccent) &&
    /\b(cardapio|cardápio|menu|itens?)\b/.test(normalizedNoAccent);
  const isPetFriendlyQuestion =
    /\bpet\s*friend(?:ly)?\b/.test(normalizedNoAccent) ||
    (
      /\b(pet|pets|cachorro|cachorros|cao|caes|c[aã]o|c[aã]es|dog|dogs)\b/.test(normalizedNoAccent) &&
      /\b(aceita|aceitam|permit|permitido|permitida|pode|podem|entrar|levar|ir|fica|ficar|tem)\b/.test(normalizedNoAccent)
    );
  const isCardapioIntent =
    /\b(cardapio|cardápio)\b/.test(normalizedNoAccent) ||
    (/\bmenu\b/.test(normalizedNoAccent) && /\bcomida|almoco|almoço|jantar|pratos?\b/.test(normalizedNoAccent));
  const isDeliveryIntent =
    /\b(delivery|entrega|ifood)\b/.test(normalizedNoAccent) ||
    (/\b(pedir|pedido)\b/.test(normalizedNoAccent) && /\b(entrega|delivery|ifood)\b/.test(normalizedNoAccent));
  const isDeliveryHelpIntent =
    text === 'delivery_ajuda' ||
    (
      /\b(delivery|entrega|ifood|pedido)\b/.test(normalizedNoAccent) &&
      /\b(ajuda|reclama|reclamacao|reclamação|problema|errad|falt|atras|atrasou|nao chegou|não chegou|suporte)\b/.test(normalizedNoAccent)
    ) ||
    /\b(pedido ja feito|pedido já feito)\b/.test(normalizedNoAccent);
  const isNewOrderIntent =
    /\b(quero|queria|gostaria|preciso|posso|vou)\b.*\b(fazer\s+um\s+pedido|pedir|pedido)\b/.test(normalizedNoAccent) ||
    /\b(fazer\s+um\s+pedido|novo\s+pedido)\b/.test(normalizedNoAccent);
  const isDeliveryOrderDetailsIntent =
    (
      /\b(hamburg|burger|lanche|combo|batata|classico|classicos|classico[s]?|refrigerante|milk[- ]?shake|maionese|ketchup)\b/.test(normalizedNoAccent) ||
      /\b(pacote|pacotes|separado|separados)\b/.test(normalizedNoAccent)
    ) &&
    (
      /\b(\d+|um|uma|dois|duas|tres|tres)\b/.test(normalizedNoAccent) ||
      /\bquero\b/.test(normalizedNoAccent)
    ) &&
    !/\b(errad|falt|atras|reclam|problema|ruim|frio|veio)\b/.test(normalizedNoAccent);
  const mentionedUnit = getMentionedUnitFromText(text);
  const contactTargetUnit = mentionedUnit?.name || state.preferred_unit_name || '';
  const isUnitContactQuestion =
    !!contactTargetUnit &&
    /\b(falar|contato|telefone|whatsapp|numero|n[uú]mero|ligar|chamar)\b/.test(normalizedNoAccent) &&
    /\b(unidade|loja|restaurante|cabral|batel|portao|londrina|sao paulo|agua verde|botanico)\b/.test(normalizedNoAccent);
  const isGenericUnitContactAsk =
    !contactTargetUnit &&
    /\b(contato|telefone|whatsapp|numero|n[uú]mero|ligar|chamar)\b/.test(normalizedNoAccent) &&
    !isDeliveryHelpIntent &&
    !/\breserv(a|ar|e|ei|ando|acao|ação|as)\b/.test(normalized);
  const isReservationIntent =
    /\breserv(a|ar|e|ei|ando|ação|acao|as)\b/.test(normalized) ||
    normalized.includes('quero reservar') ||
    normalized.includes('fazer reserva') ||
    normalized.includes('reservar mesa');
  const isReservationLeadIntent =
    isReservationIntent ||
    /(\b(consegue|quero|queria|gostaria|preciso|posso)\b.*\b(hoje|amanha|amanhã|dia\s+\d{1,2}|segunda|terca|terça|quarta|quinta|sexta|sabado|sábado|domingo)\b)|(\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b)/.test(normalizedNoAccent);
  const isReservationManageIntent =
    /\b(minha(s)? reserva(s)?|tenho reserva(s)?|consult(a|ar)|verific(a|ar)|checar|cancel(a|ar)|alter(a|ar)|remarc(a|ar)|mudar reserva)\b/.test(normalized);
  const isCancelIntent =
    /\b(cancel(a|ar|amento)|desmarc(a|ar)|excluir reserva|nao vou poder ir|não vou poder ir)\b/.test(normalized);
  const isCancelAllIntent =
    /\b(cancel(a|ar).*(todas|tudo)|todas as reservas|cancelar tudo)\b/.test(normalized);
  const isAlterIntent =
    /\b(alter(a|ar|ação|acao)|remarc(a|ar)|reagend(a|ar)|mudar reserva|trocar|troca|outro dia|nova data|tenho que alterar|preciso alterar|vamos alterar|quero trocar)\b/.test(normalized);
  const isReservationQueryIntent =
    !isAlterIntent &&
    !isCancelIntent &&
    /\b(minha(s)? reserva(s)?|tenho reserva(s)?|consult(a|ar)|verific(a|ar)|checar|quais reservas)\b/.test(normalized);
  const isExistingReservationLookupIntent =
    isReservationQueryIntent ||
    /\b(ja|já)\s+tenho\s+uma?\s+reserva\b/.test(normalizedNoAccent) ||
    /\b(confere|confirma|confirmar|verifica|verificar|checa|checar)\b.*\b(reserva|ela|se)\b/.test(normalizedNoAccent) ||
    /\btem\s+(a\s+)?reserva\b/.test(normalizedNoAccent);
  const isHoursIntent =
    /\b(horario|horarios|funcionamento|abre|aberto|fechamento|fecha|ate que horas|até que horas)\b/.test(normalizedNoAccent);
  const isAlternativeTimeRequest =
    /\b(outro|outra|alternativ)\b/.test(normalizedNoAccent) &&
    /\b(horario|horarios|hora|horas)\b/.test(normalizedNoAccent) ||
    /\b(horarios?|hora)\s+(disponiveis|disponivel|livres?)\b/.test(normalizedNoAccent);
  const looksLikeReservationDateOrTimeInput =
    !!parsedReservationInput.date_text ||
    !!parsedReservationInput.time_text ||
    /\bdata\b/.test(normalizedNoAccent) ||
    /\b\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?\b/.test(normalizedNoAccent) ||
    /\b\d{1,2}(?::|h)\d{2}\s*h?\b/.test(normalizedNoAccent) ||
    /\b\d{1,2}\s*(h|hora|horas)\b/.test(normalizedNoAccent);
  const shouldHandleAsStoreHours =
    isHoursIntent &&
    !(
      isInActiveFlow(state) &&
      (
        isAlterIntent ||
        isCancelIntent ||
        hasReservationPayloadInText ||
        looksLikeReservationDateOrTimeInput ||
        /\b(reserva|adult|crianc|mesa|almoco|almoço|evento|atras|variar|aprox|mais ou menos)\b/.test(normalizedNoAccent)
      )
    );
  const timeOnlyPattern =
    /\bhoje\b/.test(normalized) &&
    /(\d{1,2})\s*(h|hora|horas|:\d{2})/.test(normalized) &&
    !/\b\d+\s*(pessoa|pessoas|adulto|adultos)\b/.test(normalized);
  const isReservationObservationIntent =
    !!parsedReservationInput.notes ||
    isCakeNoteStatement ||
    /\b(parte de baixo|andar de baixo|parte de cima|andar de cima|docinho|docinhos|janela|parquinho|juntar as mesas|espaco kids|area kids)\b/.test(normalizedNoAccent) ||
    /\b(vista|frente|perto|proximo|proxima)\b.*\b(espaco kids|area kids|kids)\b/.test(normalizedNoAccent);

  if (state.help?.type === 'lost_found') {
    if (state.help.awaiting_unit) {
      const helpUnitKey = text.startsWith('help_unit_') ? HELP_UNIT_CONFIG[text] : undefined;
      const helpUnit = mentionedUnit || (helpUnitKey ? UNIT_CONFIG[helpUnitKey] : null);
      if (helpUnit?.name && helpUnit?.storeId) {
        state.help.unit_name = helpUnit.name;
        state.help.store_id = helpUnit.storeId;
        state.help.awaiting_unit = false;
        state.help.awaiting_item = true;
        state.preferred_unit_name = helpUnit.name;
        state.preferred_store_id = helpUnit.storeId;
        userStates.set(from, state);
        await sendWhatsAppText(
          from,
          `Perfeito. Me diga, por favor, *o que foi esquecido* na unidade *${helpUnit.name}* para eu notificar a equipe.`
        );
        return true;
      }

      if (!isGreeting && !isThanks && !isOfferRejection) {
        await sendWhatsAppText(from, 'Me confirma a unidade para eu avisar a equipe certa.');
        await sendHelpUnitsMenu(from);
        return true;
      }
    }

    if (state.help.awaiting_item) {
      const itemDescription = String(text || '').replace(/\s+/g, ' ').trim();
      const isTechnicalInteractiveToken =
        /^help_/.test(text) ||
        /^menu_/.test(text) ||
        /^unidade_/.test(text) ||
        /^cardapio_/.test(text) ||
        /^delivery_/.test(text) ||
        /^admin_/.test(text);
      if (!itemDescription || MENU_COMMANDS.has(text) || isGreeting || isTechnicalInteractiveToken) {
        await sendWhatsAppText(from, 'Me diga o que foi esquecido para eu encaminhar à unidade.');
        return true;
      }

      const unitName = state.help.unit_name || state.preferred_unit_name || '';
      await assignChatwootConversationToUnitManager(from, unitName, 'lost_found');
      await addPrivateChatwootNote(
        from,
        [
          'ACHADOS E PERDIDOS',
          `Unidade: ${unitName || 'não identificada'}`,
          `Telefone cliente: +${toDigitsPhone(from)}`,
          `Relato: ${itemDescription}`
        ].join('\n')
      );
      clearReservationDraftState(state);
      clearHelpState(state);
      userStates.set(from, state);
      await sendWhatsAppText(
        from,
        `Perfeito, avisei a unidade *${unitName}* sobre o item informado. 😊\n\nA equipe foi notificada e deve entrar em contato com você para verificar isso com mais cuidado.`
      );
      return true;
    }
  }

  if (state.help?.type === 'public_admin_menu') {
    const wantsRh = /\brh\b/.test(normalizedNoAccent);
    const wantsCompras = /\bcompras?\b/.test(normalizedNoAccent);
    const wantsFinanceiro = /\bfinanceiro\b/.test(normalizedNoAccent);
    const wantsFeedback =
      /\b(sugestoes?|sugestões?|criticas?|críticas?|feedback)\b/.test(normalizedNoAccent);

    if (wantsRh) {
      state.help = { type: 'public_admin_rh_menu' };
      userStates.set(from, state);
      await sendPublicRhMenu(from);
      return true;
    }

    if (wantsCompras) {
      clearReservationDraftState(state);
      clearHelpState(state);
      userStates.set(from, state);
      await assignChatwootConversationToTeam(from, CHATWOOT_TEAM_IDS.compras, 'compras', 'public_admin_compras');
      await addPrivateChatwootNote(
        from,
        [
          'ADMINISTRACAO',
          'Canal: Compras',
          `Telefone cliente: +${toDigitsPhone(from)}`,
          'Origem: menu público'
        ].join('\n')
      );
      await sendWhatsAppText(
        from,
        'Perfeito. Vou te conectar com *Compras*. 😊\n\nDescreva por favor a sua solicitação, produto ou necessidade, que a equipe seguirá por aqui.'
      );
      return true;
    }

    if (wantsFinanceiro) {
      clearReservationDraftState(state);
      clearHelpState(state);
      userStates.set(from, state);
      await assignChatwootConversationToTeam(from, CHATWOOT_TEAM_IDS.financeiro, 'financeiro', 'public_admin_financeiro');
      await addPrivateChatwootNote(
        from,
        [
          'ADMINISTRACAO',
          'Canal: Financeiro',
          `Telefone cliente: +${toDigitsPhone(from)}`,
          'Origem: menu público'
        ].join('\n')
      );
      await sendWhatsAppText(
        from,
        'Perfeito. Vou te conectar com o *Financeiro*. 😊\n\nEnvie por favor a sua solicitação por aqui, com o máximo de contexto possível, que a equipe dará continuidade.'
      );
      return true;
    }

    if (wantsFeedback) {
      clearReservationDraftState(state);
      clearHelpState(state);
      userStates.set(from, state);
      await sendFeedbackUnitsMenu(from);
      return true;
    }
  }

  if (state.help?.type === 'public_admin_rh_menu') {
    const isEmployee =
      /\b(ja sou funcionario|já sou funcionario|ja sou colaborador|já sou colaborador|sou funcionario|sou colaborador)\b/.test(normalizedNoAccent);
    const isCandidate =
      /\b(nao sou funcionario|não sou funcionario|nao sou colaborador|não sou colaborador|curriculo|curriculo|vaga|trabalhar|quero trabalhar)\b/.test(normalizedNoAccent);

    if (isEmployee) {
      clearReservationDraftState(state);
      clearHelpState(state);
      userStates.set(from, state);
      await assignChatwootConversationToTeam(from, CHATWOOT_TEAM_IDS.rh, 'rh', 'public_admin_rh_employee');
      await addPrivateChatwootNote(
        from,
        [
          'ADMINISTRACAO',
          'Canal: RH',
          'Perfil: funcionário',
          `Telefone cliente: +${toDigitsPhone(from)}`,
          'Origem: menu público'
        ].join('\n')
      );
      await sendWhatsAppText(
        from,
        'Perfeito. Vou te conectar com o *RH*. 😊\n\nEnvie por favor seu nome, unidade/cargo e o que você precisa, que a equipe seguirá o atendimento por aqui.'
      );
      return true;
    }

    if (isCandidate) {
      clearReservationDraftState(state);
      clearHelpState(state);
      userStates.set(from, state);
      await assignChatwootConversationToTeam(from, CHATWOOT_TEAM_IDS.rh, 'rh', 'public_admin_rh_candidate', 10);
      await addPrivateChatwootNote(
        from,
        [
          'ADMINISTRACAO',
          'Canal: RH',
          'Perfil: candidato externo',
          `Telefone cliente: +${toDigitsPhone(from)}`,
          'Origem: menu público'
        ].join('\n')
      );
      await sendWhatsAppText(
        from,
        'Perfeito. Vou te conectar com o *RH*. 😊\n\nEnvie por favor *nome completo, telefone, cidade/unidade de interesse, área/vaga desejada* e, se quiser, já pode mandar o *currículo* por aqui para a equipe analisar.'
      );
      return true;
    }
  }

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
    clearReservationDraftState(state);
    clearHelpState(state);
    state.has_interacted = true;
    userStates.set(from, state);
    await sendMainMenu(from, false);
    return true;
  }

  if (isInActiveFlow(state) && (isExternalReservationResolved || (isThanks && /confirm/.test(normalizedNoAccent)))) {
    await markLatestAttemptManualConfirmed(from);
    clearReservationDraftState(state);
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Perfeito! 😊 Considerei essa reserva como resolvida por aqui. Se precisar de algo novo, é só me chamar.');
    return true;
  }

  if (state.reservation?.awaiting_manual_review) {
    // Auto-expire manual review after 6 hours to prevent indefinite bot lockout
    const MANUAL_REVIEW_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours
    const reviewStartedAt = Number(state.reservation.manual_review_last_notice_at || 0);
    if (reviewStartedAt && (Date.now() - reviewStartedAt > MANUAL_REVIEW_TIMEOUT_MS)) {
      console.log(`[ManualReview] Auto-expired for ${from} after 6h — clearing state`);
      clearReservationDraftState(state);
      userStates.set(from, state);
      // Fall through to normal processing
    } else {
      if (isExternalReservationResolved) {
        await markLatestAttemptManualConfirmed(from);
        clearReservationDraftState(state);
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Perfeito! 😊 Considerei essa reserva como resolvida por aqui. Se precisar de algo novo, é só me chamar.');
        return true;
      }

      if (text !== 'MENU_PRINCIPAL' && normalized !== 'menu' && normalized !== 'inicio' && normalized !== 'voltar') {
        const now = Date.now();
        const lastNoticeAt = Number(state.reservation.manual_review_last_notice_at || 0);
        const isGenericPing = isGenericManualReviewPing(normalizedNoAccent);
        const needsReply = shouldAnswerDuringManualReview(normalizedNoAccent) || !lastNoticeAt;
        const cooldownMs = isGenericPing ? 30 * 60 * 1000 : 2 * 60 * 1000;

        if (!needsReply || (lastNoticeAt && now - lastNoticeAt < cooldownMs)) {
          return true;
        }

        state.reservation.manual_review_last_notice_at = now;
        userStates.set(from, state);
        await assignChatwootConversationToUnitManager(from, state.preferred_unit_name, 'reservation_manual_review');
        await sendWhatsAppText(from, getManualReviewMessage(state));
        return true;
      }
    }
  }

  if (isBirthdayCakeQuestion && !isCakeNoteStatement) {
    const unit = state.preferred_unit_name ? ` da unidade ${state.preferred_unit_name}` : '';
    state.pending_offer = 'cake_note_offer';
    userStates.set(from, state);
    await sendWhatsAppText(
      from,
      `Sim! 🎂 Pode levar bolo de aniversário${unit}. Se quiser, já deixo essa observação na reserva também. 😊`
    );
    return true;
  }

  if (isCorkageQuestion) {
    const unit = state.preferred_unit_name ? ` na unidade ${state.preferred_unit_name}` : '';
    await sendWhatsAppText(
      from,
      `Sim! 🍷 Trabalhamos com rolha liberada${unit}, sem custo. Pode trazer vinho ou bebida de casa sem taxa. 😊`
    );
    return true;
  }

  if (state.pending_offer === 'delivery_help_offer') {
    const unitName = mentionedUnit?.name || state.preferred_unit_name || '';
    const city = state.preferred_city || inferCityFromUnitName(unitName) || inferCityFromText(text);
    const phone = getDeliveryHelpPhone(unitName, city);

    if (phone || city === 'Curitiba') {
      state.pending_offer = undefined;
      if (unitName) state.preferred_unit_name = unitName;
      if (city) state.preferred_city = city;
      userStates.set(from, state);
      await sendWhatsAppText(from, buildDeliveryHelpMessage(unitName, city));
      return true;
    }

    if (isThanks || isOfferRejection) {
      state.pending_offer = undefined;
      userStates.set(from, state);
      await sendWhatsAppText(from, 'Sem problemas 😊');
      return true;
    }

    await sendWhatsAppText(
      from,
      'Me diga a cidade ou unidade do pedido para eu te passar o contato certo de ajuda do delivery.'
    );
    return true;
  }

  if (isBirthdayDessertQuestion) {
    const unitName = state.preferred_unit_name || '';
    const unitPhone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';
    if (unitName && unitPhone) {
      await sendWhatsAppText(
        from,
        `Essa informação pode variar conforme a unidade e a disponibilidade do dia. 😊\n\nNa unidade *${unitName}*, o melhor é confirmar direto com a equipe pelo telefone *${unitPhone}*.\n\nSe quiser, também posso seguir verificando outro horário ou outra unidade para a sua reserva.`
      );
      return true;
    }

    await sendWhatsAppText(
      from,
      'Essa informação pode variar conforme a unidade e a disponibilidade do dia. 😊\n\nSe você me disser a unidade, eu te passo o contato certo para confirmar isso com a equipe.'
    );
    return true;
  }

  if (isKidsAgeQuestion) {
    const unitName = state.preferred_unit_name || '';
    const unitPhone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';
    if (unitName && unitPhone) {
      await sendWhatsAppText(
        from,
        `Essa regra do *Espaço Kids* pode variar conforme a unidade e a operação do dia. 😊\n\nNa unidade *${unitName}*, o melhor é confirmar direto com a equipe pelo telefone *${unitPhone}*.\n\nSe quiser, também posso te ajudar com reserva, cardápio ou delivery.`
      );
      return true;
    }

    await sendWhatsAppText(
      from,
      'Essa regra do *Espaço Kids* pode variar conforme a unidade e a operação do dia. 😊\n\nSe você me disser a unidade, eu te passo o contato certo para confirmar isso com a equipe.'
    );
    return true;
  }

  if (state.pending_offer === 'food_info_unit_offer') {
    const unitName = mentionedUnit?.name || state.preferred_unit_name || '';
    const unitPhone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';
    if (unitName && unitPhone) {
      state.pending_offer = undefined;
      state.preferred_unit_name = unitName;
      userStates.set(from, state);
      await sendWhatsAppText(
        from,
        `Como você mencionou alergia/ingredientes, o mais seguro é confirmar direto com a equipe da unidade *${unitName}*.\n\n📞 *${unitPhone}*\n\nSe quiser, também posso te ajudar com reserva, cardápio ou delivery.`
      );
      return true;
    }

    if (isThanks || isOfferRejection) {
      state.pending_offer = undefined;
      userStates.set(from, state);
      await sendWhatsAppText(from, 'Sem problemas 😊');
      return true;
    }

    await sendWhatsAppText(
      from,
      'Para eu te passar o contato certo, me diga qual unidade você quer consultar: Jardim Botânico, Cabral, Água Verde, Batel, Portão, Londrina ou São Paulo.'
    );
    return true;
  }

  if (state.pending_offer === 'unit_contact_offer') {
    const unitName = mentionedUnit?.name || state.preferred_unit_name || '';
    const unitPhone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';
    if (unitName && unitPhone) {
      state.pending_offer = undefined;
      state.reservation = undefined;
      state.preferred_store_id = undefined;
      state.preferred_unit_name = unitName;
      userStates.set(from, state);
      await sendWhatsAppText(
        from,
        `Claro! O contato da unidade *${unitName}* é *${unitPhone}*.\n\nSe quiser, também posso te ajudar com reserva, cardápio ou delivery.`
      );
      await assignChatwootConversationToUnitManager(from, unitName, 'unit_contact_offer');
      return true;
    }

    if (isThanks || isOfferRejection) {
      state.pending_offer = undefined;
      userStates.set(from, state);
      await sendWhatsAppText(from, 'Sem problemas 😊');
      return true;
    }

    await sendWhatsAppText(
      from,
      'Me diga qual unidade você quer consultar: Jardim Botânico, Cabral, Água Verde, Batel, Portão, Londrina ou São Paulo.'
    );
    return true;
  }

  if (isFoodInfoQuestion) {
    const unitName = mentionedUnit?.name || state.preferred_unit_name || '';
    const unitPhone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';
    if (unitName && unitPhone) {
      await sendWhatsAppText(
        from,
        `Como você mencionou alergia/ingredientes, o mais seguro é confirmar direto com a equipe da unidade *${unitName}*.\n\n📞 *${unitPhone}*\n\nSe quiser, também posso te ajudar com reserva, cardápio ou delivery.`
      );
      return true;
    }

    state.pending_offer = 'food_info_unit_offer';
    userStates.set(from, state);
    await sendWhatsAppText(
      from,
      'Essa informação pode variar conforme a unidade e a operação do dia. 😊\n\nMe diga qual loja/unidade você quer consultar que eu te passo o contato certo.'
    );
    return true;
  }

  if (isDietaryOptionsQuestion) {
    const unitName = mentionedUnit?.name || state.preferred_unit_name || '';
    const unitPhone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';
    const city = state.preferred_city || inferCityFromUnitName(unitName);
    const cardapioCommand = getCardapioCommandFromContext(unitName, city);
    if (cardapioCommand) {
      const msg = await buildCardapioMessage(cardapioCommand);
      await sendWhatsAppText(
        from,
        `As opções vegetarianas/veganas podem variar conforme a unidade e o cardápio disponível. 😊\n\n${msg}${unitPhone ? `\n\nSe quiser confirmar detalhes direto com a equipe da unidade *${unitName}*, o telefone é *${unitPhone}*.` : ''}`
      );
      return true;
    }

    state.pending_offer = 'food_info_unit_offer';
    userStates.set(from, state);
    await sendWhatsAppText(
      from,
      'As opções vegetarianas/veganas podem variar conforme a unidade e o cardápio disponível. 😊\n\nMe diga a cidade ou unidade que eu te envio o cardápio e o contato certo para confirmar.'
    );
    return true;
  }

  if (isDeliveryHelpIntent) {
    const unitName = mentionedUnit?.name || state.preferred_unit_name || '';
    const city = state.preferred_city || inferCityFromUnitName(unitName) || inferCityFromText(text);
    if (getDeliveryHelpPhone(unitName, city) || city === 'Curitiba') {
      state.pending_offer = undefined;
      if (unitName) state.preferred_unit_name = unitName;
      if (city) state.preferred_city = city;
      userStates.set(from, state);
      await sendWhatsAppText(from, buildDeliveryHelpMessage(unitName, city));
      return true;
    }

    state.pending_offer = 'delivery_help_offer';
    userStates.set(from, state);
    await sendWhatsAppText(
      from,
      'Claro! Me diga a cidade ou unidade do pedido para eu te passar o contato certo de ajuda do delivery.'
    );
    return true;
  }

  if (isLostAndFoundQuestion) {
    const unitName = mentionedUnit?.name || state.preferred_unit_name || '';
    const storeId = mentionedUnit?.storeId || state.preferred_store_id || '';
    clearReservationDraftState(state);
    state.help = {
      type: 'lost_found',
      awaiting_unit: !unitName,
      awaiting_item: !!unitName,
      unit_name: unitName || undefined,
      store_id: storeId || undefined
    };
    if (unitName) {
      state.preferred_unit_name = unitName;
      state.preferred_store_id = storeId || state.preferred_store_id;
      userStates.set(from, state);
      await sendWhatsAppText(
        from,
        `Claro. Me diga, por favor, *o que foi esquecido* na unidade *${unitName}* para eu avisar a equipe.`
      );
      return true;
    }

    userStates.set(from, state);
    await sendWhatsAppText(
      from,
      'Claro. Vou te ajudar com *Achados e Perdidos*. 😊\n\nMe diga em qual unidade aconteceu para eu avisar a equipe certa.'
    );
    await sendHelpUnitsMenu(from);
    return true;
  }

  if (isGourmetQuestion || isHumanAssistanceRequest) {
    const unitName = mentionedUnit?.name || state.preferred_unit_name || '';
    const unitPhone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';
    if (unitName && unitPhone) {
      state.pending_offer = undefined;
      state.reservation = undefined;
      state.preferred_store_id = undefined;
      state.preferred_unit_name = unitName;
      userStates.set(from, state);
      await sendWhatsAppText(
        from,
        `Claro! O contato da unidade *${unitName}* é *${unitPhone}*.\n\nComo esse tipo de assunto precisa da equipe da loja, o melhor é falar direto com eles por lá.`
      );
      await assignChatwootConversationToUnitManager(from, unitName, 'unit_problem');
      return true;
    }

    state.pending_offer = 'unit_contact_offer';
    userStates.set(from, state);
    await sendWhatsAppText(
      from,
      'Me diga qual loja/unidade você quer consultar que eu te passo o contato certo.'
    );
    return true;
  }

  if (isInActiveFlow(state) && (isHumanAssistanceRequest || isFrustrationMessage)) {
    const unitName = mentionedUnit?.name || state.preferred_unit_name || '';
    const unitPhone = unitName ? UNIT_PHONE_BY_NAME[unitName] : '';
    clearReservationDraftState(state);
    if (unitName) state.preferred_unit_name = unitName;
    userStates.set(from, state);
    if (unitPhone) {
      await sendWhatsAppText(
        from,
        `Entendi. Vou encerrar o fluxo automático por aqui. 😊\n\nPara seguir direto com a equipe da unidade *${unitName}*, o telefone é *${unitPhone}*.`
      );
      await assignChatwootConversationToUnitManager(from, unitName, 'human_handoff');
    } else {
      await sendWhatsAppText(
        from,
        'Entendi. Vou encerrar o fluxo automático por aqui. 😊\n\nSe você me disser a unidade, eu te passo o contato certo da equipe.'
      );
    }
    return true;
  }

  if (isHappyHourQuestion) {
    const unitName = mentionedUnit?.name || state.preferred_unit_name || '';
    const city = state.preferred_city || inferCityFromUnitName(unitName) || inferCityFromText(text);
    if (isHappyHourCardapioIntent) {
      const msg = await buildHappyHourCardapioMessage(unitName, city);
      if (unitName) state.preferred_unit_name = unitName;
      if (city) state.preferred_city = city;
      state.pending_offer = unitName ? undefined : 'unit_contact_offer';
      userStates.set(from, state);
      if (msg) {
        await sendWhatsAppText(from, msg);
      } else {
        await sendWhatsAppText(
          from,
          'Me diga a *cidade ou unidade* do Happy Hour que eu te passo o cardápio e, se precisar, o contato certo para confirmar os itens.'
        );
      }
      return true;
    }

    state.pending_offer = undefined;
    userStates.set(from, state);
    await sendWhatsAppText(from, HAPPY_HOUR_INFO_TEXT);
    return true;
  }

  if (isBotIdentityQuestion) {
    state.pending_offer = undefined;
    userStates.set(from, state);
    await sendWhatsAppText(
      from,
      'Eu sou a *Kha*, assistente virtual do *Kharina*. 😊\n\nMeu nome é *Kha* e estou aqui para te ajudar com reservas, cardápio, delivery, Espaço Kids e ajuda das unidades.'
    );
    return true;
  }

  if (isPetFriendlyQuestion) {
    state.pending_offer = 'pet_friendly_reservation_offer';
    userStates.set(from, state);
    await sendWhatsAppText(from, PET_FRIENDLY_INFO_TEXT);
    return true;
  }

  if (isGenericUnitContactAsk) {
    state.pending_offer = 'unit_contact_offer';
    userStates.set(from, state);
    await sendWhatsAppText(
      from,
      'Claro. Me diga qual unidade você quer consultar que eu te passo o contato certo: Jardim Botânico, Cabral, Água Verde, Batel, Portão, Londrina ou São Paulo.'
    );
    return true;
  }

  if (isUnitContactQuestion) {
    const unitPhone = UNIT_PHONE_BY_NAME[contactTargetUnit];
    if (unitPhone) {
      state.pending_offer = undefined;
      state.reservation = undefined;
      state.preferred_store_id = undefined;
      state.preferred_unit_name = undefined;
      userStates.set(from, state);
      await sendWhatsAppText(
        from,
        `Claro! O contato da unidade *${contactTargetUnit}* é *${unitPhone}*.\n\nSe quiser, também posso te ajudar com a reserva por aqui. 😊`
      );
      await assignChatwootConversationToUnitManager(from, contactTargetUnit, 'unit_contact');
      return true;
    }
  }

  if (state.pending_offer === 'pet_friendly_reservation_offer') {
    if (isOfferAcceptance || isReservationIntent) {
      const currentPhone = state.reservation?.contact_phone;
      state.pending_offer = undefined;
      state.preferred_unit_name = UNIT_CONFIG.unidade_agua_verde.name;
      state.preferred_store_id = UNIT_CONFIG.unidade_agua_verde.storeId;
      state.reservation = currentPhone ? { contact_phone: currentPhone, phone_confirmed: false } : { phone_confirmed: false };
      userStates.set(from, state);
      await sendWhatsAppText(from, 'Perfeito! Vou seguir com a reserva para a unidade Água Verde. ✅');
      await sendPhoneConfirmation(from);
      return true;
    }

    if (isOfferRejection || isThanks) {
      state.pending_offer = undefined;
      userStates.set(from, state);
      await sendWhatsAppText(from, 'Sem problemas 😊 Se quiser, posso te ajudar com reserva, cardápio ou delivery.');
      return true;
    }
  }

  if (state.pending_offer === 'cake_note_offer') {
    if (isOfferAcceptance || isReservationObservationIntent) {
      state.pending_offer = undefined;
      userStates.set(from, state);
      const active = await fetchActiveReservationsWithRetry(from);
      const noteText = parsedReservationInput.notes || (isCakeNoteStatement ? String(text || '').trim() : 'Obs: levará bolo de aniversário');
      if (active.length === 0) {
        await sendWhatsAppText(from, 'Perfeito 😊 Se sua reserva foi confirmada manualmente e eu não conseguir localizar por aqui, me manda o código da reserva ou peça para a equipe adicionar a observação: levará bolo de aniversário.');
        return true;
      }
      if (active.length === 1) {
        await beginAlterReservationFlow(from, state, active[0], noteText);
        return true;
      }
      await sendWhatsAppText(from, 'Perfeito! Encontrei mais de uma reserva ativa. Me diga qual delas você quer atualizar com a observação do bolo.');
      await sendManageReservationMenu(from, 'alter', active);
      return true;
    }

    if (isOfferRejection || isThanks) {
      state.pending_offer = undefined;
      userStates.set(from, state);
      await sendWhatsAppText(from, 'Sem problemas 😊');
      return true;
    }
  }

  if (isExistingReservationLookupIntent) {
    state.pending_offer = undefined;
    state.reservation = undefined;
    state.preferred_store_id = undefined;
    state.preferred_unit_name = undefined;
    userStates.set(from, state);
    const q = await queryReservationsDeterministic(from);
    await sendWhatsAppText(from, q.message);
    return true;
  }

  if (isReservationObservationIntent && !isInActiveFlow(state)) {
    const active = await fetchActiveReservationsWithRetry(from);
    if (active.length === 1) {
      await beginAlterReservationFlow(from, state, active[0], parsedReservationInput.notes || String(text || '').trim());
      return true;
    }
    if (active.length > 1) {
      await sendWhatsAppText(from, 'Encontrei mais de uma reserva ativa. Me diga qual delas você quer atualizar com essa observação.');
      await sendManageReservationMenu(from, 'alter', active);
      return true;
    }
  }

  if (isReservationObservationIntent && isInActiveFlow(state) && !hasCompleteReservationData(state.reservation)) {
    const active = await fetchActiveReservationsWithRetry(from);
    if (active.length === 1) {
      state.pending_offer = undefined;
      state.reservation = undefined;
      state.preferred_store_id = undefined;
      state.preferred_unit_name = undefined;
      userStates.set(from, state);
      await beginAlterReservationFlow(from, state, active[0], parsedReservationInput.notes || String(text || '').trim());
      return true;
    }
    if (active.length > 1) {
      await sendWhatsAppText(from, 'Encontrei mais de uma reserva ativa. Me diga qual delas você quer atualizar com essa observação.');
      await sendManageReservationMenu(from, 'alter', active);
      return true;
    }
  }

  if (isInActiveFlow(state) && (isCardapioIntent || isDeliveryIntent)) {
    const unitName = mentionedUnit?.name || state.preferred_unit_name;
    const city = state.preferred_city || inferCityFromUnitName(unitName);
    state.reservation = undefined;
    state.preferred_store_id = undefined;
    state.preferred_unit_name = undefined;
    state.pending_offer = undefined;
    if (city) state.preferred_city = city;
    userStates.set(from, state);

    if (isCardapioIntent) {
      const cardapioCommand = getCardapioCommandFromContext(unitName, city);
      if (cardapioCommand) {
        const msg = await buildCardapioMessage(cardapioCommand);
        await sendWhatsAppText(from, unitName ? `${msg}\n\nPara a unidade ${unitName}, este é o cardápio correspondente. 😊` : msg);
      } else {
        await sendCitiesMenu(from);
      }
      return true;
    }

    await sendDirectDeliveryHelp(from, unitName, city);
    return true;
  }

  if (!isInActiveFlow(state) && isNewOrderIntent) {
    const city = state.preferred_city || inferCityFromText(text) || inferCityFromUnitName(mentionedUnit?.name);
    state.has_interacted = true;
    state.preferred_city = city || state.preferred_city;
    userStates.set(from, state);
    if (city || mentionedUnit?.name) {
      await sendDirectDeliveryHelp(from, mentionedUnit?.name, city);
    } else {
      await sendDeliveryCitiesMenu(from);
    }
    return true;
  }

  // Greeting outside active flow -> open main menu immediately
  if (isGreeting && !isInActiveFlow(state)) {
    if (recentlyPromptedReservationUnit(from)) {
      await sendUnidadesMenu(from);
      return true;
    }
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

  if (!isInActiveFlow(state) && recentlyPromptedDeliveryCities(from)) {
    if (isCardapioIntent) {
      state.preferred_city = undefined;
      state.has_interacted = true;
      userStates.set(from, state);
      await sendCitiesMenu(from);
      return true;
    }

    if (isReservationIntent) {
      state.preferred_city = undefined;
      state.has_interacted = true;
      userStates.set(from, state);
      await sendUnidadesMenu(from);
      return true;
    }

    const city = inferCityFromText(text);
    if (city) {
      state.preferred_city = city;
      state.has_interacted = true;
      userStates.set(from, state);
      if (city === 'São Paulo') {
        await sendWhatsAppText(from, "Poxa, em SP ainda não tem delivery! 😢 Mas vem visitar a gente no Shopping Parque da Cidade! 🧡");
        await sendMainMenu(from, true);
        return true;
      }
      await sendDeliveryChoiceMenu(from);
      return true;
    }
  }

  if (!isInActiveFlow(state) && state.preferred_city && isDeliveryOrderDetailsIntent) {
    await sendDirectDeliveryHelp(from, undefined, state.preferred_city);
    return true;
  }

  if (state.reservation?.awaiting_cancellation && MENU_COMMANDS.has(text)) {
    const pendingAllIds = (state.reservation.pending_cancellation_all_ids || []).filter(Boolean);
    if (pendingAllIds.length > 0) {
      await sendCancelAllConfirmationMenu(from, pendingAllIds.length);
      return true;
    }

    const pendingId = String(state.reservation?.pending_cancellation_id || '').trim();
    if (pendingId) {
      const code = state.reservation?.pending_cancellation_code || pendingId.substring(0, 8).toUpperCase();
      await sendCancelConfirmationMenu(
        from,
        pendingId,
        `Confirma o cancelamento da reserva ${code} (${state.reservation?.date_text ? toBrDate(normalizeIsoDate(state.reservation.date_text)) : 'data pendente'} às ${state.reservation?.time_text || 'horário pendente'}, ${state.preferred_unit_name || 'unidade pendente'})?`
      );
      return true;
    }
  }

  if (isInActiveFlow(state) && isAlternativeTimeRequest) {
    const block = await maybeGetReservationBlock(state);
    if (block) {
      const wantsAnotherUnit = /\boutra?\s+unidade\b/.test(normalizedNoAccent);
      const wantsAnotherTime = /\boutro\b.*\b(horario|horário|hora|horas)\b/.test(normalizedNoAccent) || /\b(horario|horário|hora|horas)\b/.test(normalizedNoAccent);

      if (wantsAnotherUnit) {
        if (state.reservation) state.reservation.awaiting_confirmation = false;
        state.preferred_store_id = undefined;
        state.preferred_unit_name = undefined;
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Perfeito! Me diz a outra unidade que você quer tentar, ou escolha na lista abaixo. 😊');
        await sendUnidadesMenu(from);
        return true;
      }

      if (wantsAnotherTime && !parsedReservationInput.time_text) {
        if (state.reservation) state.reservation.awaiting_confirmation = false;
        userStates.set(from, state);
        await sendWhatsAppText(from, 'Claro! Me diga o horário que você quer tentar nessa unidade, ou escolha um dos horários sugeridos. 😊');
        return true;
      }

      if (state.reservation) state.reservation.awaiting_confirmation = false;
      userStates.set(from, state);
      await sendWhatsAppText(
        from,
        await buildReservationBlockCustomerMessage(
          block,
          state.preferred_store_id,
          state.preferred_unit_name,
          state.reservation?.date_text,
          state.reservation?.time_text,
          Number(state.reservation?.people || 0) + Number(state.reservation?.kids ?? 0)
        )
      );
      return true;
    }
  }

  if (isInActiveFlow(state) && isCancelIntent) {
    const pendingChangeId = String(state.reservation?.pending_change_source_id || '').trim();
    const pendingChangeCode = String(state.reservation?.pending_change_source_code || '').trim();
    if (pendingChangeId) {
      state.reservation = {
        ...(state.reservation || {}),
        awaiting_cancellation: true,
        awaiting_confirmation: false,
        pending_cancellation_id: pendingChangeId,
        pending_cancellation_code: pendingChangeCode || pendingChangeId.substring(0, 8).toUpperCase()
      };
      userStates.set(from, state);
      await sendCancelConfirmationMenu(
        from,
        pendingChangeId,
        `Confirma o cancelamento da reserva ${state.reservation.pending_cancellation_code} (${state.reservation?.date_text ? toBrDate(normalizeIsoDate(state.reservation.date_text)) : 'data pendente'} às ${state.reservation?.time_text || 'horário pendente'}, ${state.preferred_unit_name || 'unidade pendente'})?`
      );
      return true;
    }
  }

  if (isInActiveFlow(state) && isAlterIntent && !hasReservationPayloadInText && !looksLikeReservationDateOrTimeInput) {
    const target =
      /\bhorario|horário\b/.test(normalizedNoAccent) ? 'horário' :
      /\bdata\b/.test(normalizedNoAccent) ? 'data' :
      /\badult|pessoa\b/.test(normalizedNoAccent) ? 'quantidade de adultos' :
      /\bcrian\b/.test(normalizedNoAccent) ? 'crianças' :
      'dados da reserva';
    await sendWhatsAppText(from, `Perfeito! 😊 Me diga como você quer ajustar ${target}.`);
    return true;
  }

  if (shouldHandleAsStoreHours) {
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
        await sendCancelConfirmationMenu(
          from,
          selected.reservationId,
          `Confirma o cancelamento da reserva ${selected.code} (${toBrDate(selected.date)} às ${selected.time}, ${selected.storeName})?`
        );
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
      } else {
        await sendWhatsAppText(from, 'Se quiser, posso te ajudar a fazer uma nova reserva ou com qualquer outra coisa. 🙂');
      }
      return true;
    } catch (err: any) {
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
      if (!mcpReady) throw new Error('MCP not ready');
      for (const reservationId of ids) {
        try {
          await callReservasToolWithTimeout('cancel_reservation', {
            reservationId,
            reason: 'Cancelamento em lote solicitado pelo cliente via WhatsApp'
          }, { timeoutMs: 15000, retries: 1, retryDelayMs: 500 });
          cancelled += 1;
        } catch (err: any) {
          console.error('[ReservasDeterministic] cancel_all item failed:', reservationId, err?.message || err);
        }
      }
      state.reservation = undefined;
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
      if (active.length > 0) await sendManageReservationMenu(from, 'alter', active);
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
    clearHelpState(state);
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
    clearHelpState(state);
    state.reservation = state.reservation ? { contact_phone: state.reservation.contact_phone } : undefined;
    state.has_interacted = true;
    userStates.set(from, state);
    await sendUnidadesMenu(from);
    return true;
  }

  // Delivery menu
  if (text === 'menu_delivery') {
    clearHelpState(state);
    state.has_interacted = true;
    userStates.set(from, state);
    await sendDeliveryCitiesMenu(from);
    return true;
  }

  // Espaço Kids menu
  if (text === 'menu_kids') {
    clearHelpState(state);
    state.has_interacted = true;
    userStates.set(from, state);
    const kidsSticker = await db.getConfig('kids_sticker_media');
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

  if (text === 'menu_help') {
    clearReservationDraftState(state);
    state.help = {
      type: 'lost_found',
      awaiting_unit: true,
      awaiting_item: false
    };
    userStates.set(from, state);
    await sendHelpUnitsMenu(from);
    return true;
  }

  if (text === 'menu_public_admin') {
    clearReservationDraftState(state);
    state.has_interacted = true;
    state.help = { type: 'public_admin_menu' };
    userStates.set(from, state);
    await sendPublicAdminMenu(from);
    return true;
  }

  if (text === 'help_lost_found') {
    clearReservationDraftState(state);
    state.help = {
      type: 'lost_found',
      awaiting_unit: true,
      awaiting_item: false
    };
    userStates.set(from, state);
    await sendHelpUnitsMenu(from);
    return true;
  }

  if (text === 'public_admin_rh') {
    clearReservationDraftState(state);
    state.has_interacted = true;
    state.help = { type: 'public_admin_rh_menu' };
    userStates.set(from, state);
    await sendPublicRhMenu(from);
    return true;
  }

  if (text === 'public_admin_compras') {
    clearReservationDraftState(state);
    clearHelpState(state);
    state.has_interacted = true;
    userStates.set(from, state);
    await assignChatwootConversationToTeam(from, CHATWOOT_TEAM_IDS.compras, 'compras', 'public_admin_compras');
    await addPrivateChatwootNote(
      from,
      [
        'ADMINISTRACAO',
        'Canal: Compras',
        `Telefone cliente: +${toDigitsPhone(from)}`,
        'Origem: menu público'
      ].join('\n')
    );
    await sendWhatsAppText(
      from,
      'Perfeito. Vou te conectar com *Compras*. 😊\n\nDescreva por favor a sua solicitação, produto ou necessidade, que a equipe seguirá por aqui.'
    );
    return true;
  }

  if (text === 'public_admin_financeiro') {
    clearReservationDraftState(state);
    clearHelpState(state);
    state.has_interacted = true;
    userStates.set(from, state);
    await assignChatwootConversationToTeam(from, CHATWOOT_TEAM_IDS.financeiro, 'financeiro', 'public_admin_financeiro');
    await addPrivateChatwootNote(
      from,
      [
        'ADMINISTRACAO',
        'Canal: Financeiro',
        `Telefone cliente: +${toDigitsPhone(from)}`,
        'Origem: menu público'
      ].join('\n')
    );
    await sendWhatsAppText(
      from,
      'Perfeito. Vou te conectar com o *Financeiro*. 😊\n\nEnvie por favor a sua solicitação por aqui, com o máximo de contexto possível, que a equipe dará continuidade.'
    );
    return true;
  }

  if (text.startsWith('feedback_unit_')) {
    const feedbackLinks: Record<string, string> = {
      'feedback_unit_cabral': 'https://falae.experienciab2s.com/3795c6ac-c9ad-46aa-9576-99990a8dcee3',
      'feedback_unit_pdc': 'https://falae.experienciab2s.com/3d853b10-266c-4852-8b82-402e2f8c8d57',
      'feedback_unit_londrina': 'https://falae.experienciab2s.com/7a25e074-d338-4c34-af41-484bde65fb8a',
      'feedback_unit_jardim_botanico': 'https://falae.experienciab2s.com/b8b952eb-d3a7-409d-bf1a-f91f2ae785c7',
      'feedback_unit_batel': 'https://falae.experienciab2s.com/c8cfbb47-5310-4340-914b-d78e026e8b1e',
      'feedback_unit_portao': 'https://falae.experienciab2s.com/cae97e8a-b52a-4d37-805a-63fd1599f5e1',
      'feedback_unit_agua_verde': 'https://falae.experienciab2s.com/edc566d8-8f00-4308-965a-b0b7a62be733'
    };
    
    if (feedbackLinks[text]) {
      clearReservationDraftState(state);
      clearHelpState(state);
      state.has_interacted = true;
      userStates.set(from, state);
      
      await sendWhatsAppText(
        from,
        `Muito obrigado pela sua visita! 😊\n\nSua opinião é super importante para podermos melhorar sempre. Por favor, registre sua avaliação ou sugestão no link abaixo:\n\n${feedbackLinks[text]}`
      );
    }
    return true;
  }

  if (text === 'public_admin_feedback') {
    clearReservationDraftState(state);
    clearHelpState(state);
    state.has_interacted = true;
    userStates.set(from, state);
    await sendFeedbackUnitsMenu(from);
    return true;
  }

  if (text === 'public_admin_rh_employee') {
    clearReservationDraftState(state);
    clearHelpState(state);
    state.has_interacted = true;
    userStates.set(from, state);
    await assignChatwootConversationToTeam(from, CHATWOOT_TEAM_IDS.rh, 'rh', 'public_admin_rh_employee');
    await addPrivateChatwootNote(
      from,
      [
        'ADMINISTRACAO',
        'Canal: RH',
        'Perfil: funcionário',
        `Telefone cliente: +${toDigitsPhone(from)}`,
        'Origem: menu público'
      ].join('\n')
    );
    await sendWhatsAppText(
      from,
      'Perfeito. Vou te conectar com o *RH*. 😊\n\nEnvie por favor seu nome, unidade/cargo e o que você precisa, que a equipe seguirá o atendimento por aqui.'
    );
    return true;
  }

  if (text === 'public_admin_rh_candidate') {
    clearReservationDraftState(state);
    clearHelpState(state);
    state.has_interacted = true;
    userStates.set(from, state);
    await assignChatwootConversationToTeam(from, CHATWOOT_TEAM_IDS.rh, 'rh', 'public_admin_rh_candidate', 10);
    await addPrivateChatwootNote(
      from,
      [
        'ADMINISTRACAO',
        'Canal: RH',
        'Perfil: candidato externo',
        `Telefone cliente: +${toDigitsPhone(from)}`,
        'Origem: menu público'
      ].join('\n')
    );
    await sendWhatsAppText(
      from,
      'Perfeito. Vou te conectar com o *RH*. 😊\n\nEnvie por favor *nome completo, telefone, cidade/unidade de interesse, área/vaga desejada* e, se quiser, já pode mandar o *currículo* por aqui para a equipe analisar.'
    );
    return true;
  }

  if (text === 'help_unit_contact') {
    clearReservationDraftState(state);
    state.pending_offer = 'unit_contact_offer';
    state.help = {};
    userStates.set(from, state);
    await sendWhatsAppText(
      from,
      'Claro. Me diga qual unidade você quer consultar que eu te passo o telefone fixo certo: Jardim Botânico, Cabral, Água Verde, Batel, Portão, Londrina ou São Paulo.'
    );
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

  // delivery_ajuda is now handled by AI to allow better interpretation/empathy
  if (text === 'delivery_ajuda') {
    state.pending_offer = 'delivery_help_offer';
    userStates.set(from, state);
    await sendWhatsAppText(
      from,
      state.preferred_city
        ? buildDeliveryHelpMessage(state.preferred_unit_name, state.preferred_city)
        : 'Claro! Me diga a cidade ou unidade do pedido para eu te passar o contato certo de ajuda do delivery.'
    );
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
    if (!state.preferred_unit_name || !state.preferred_store_id) {
      await sendWhatsAppText(
        from,
        'Perfeito! ✅ Antes de continuar, me confirma novamente a unidade da reserva para evitar qualquer erro.'
      );
      await sendUnidadesMenu(from);
      return true;
    }

    state.reservation = state.reservation || {};
    state.reservation.phone_confirmed = true;
    state.reservation.contact_phone = from;
    if (!state.reservation.name) {
      const contactName = String(profileName || '').trim();
      if (isUsableContactName(contactName)) {
        state.reservation.name = contactName;
        state.reservation.awaiting_name = false;
      }
    }
    userStates.set(from, state);

    if (!state.reservation.name) {
      state.reservation.awaiting_name = true;
      userStates.set(from, state);
      await sendWhatsAppText(from, `Perfeito! Vou usar este número para a reserva na unidade ${state.preferred_unit_name}. ✅\n\nAntes de continuar, me diga seu *nome*, por favor.`);
      return true;
    }

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
        if (isUsableContactName(contactName)) {
          state.reservation.name = contactName;
          state.reservation.awaiting_name = false;
        }
      }
      userStates.set(from, state);

      if (!state.reservation.name) {
        state.reservation.awaiting_name = true;
        userStates.set(from, state);
        await sendWhatsAppText(from, `Perfeito! Vou usar este número para a reserva na unidade ${state.preferred_unit_name}. ✅\n\nAgora me diga seu *nome*, por favor.`);
        return true;
      }

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
  if (timeOnlyPattern && isInActiveFlow(state) && !state.reservation?.people) {
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
      const confirmedSticker = await db.getConfig('reservation_confirmed_sticker_media');
      if (confirmedSticker) await sendWhatsAppSticker(from, confirmedSticker);
    }
    await sendWhatsAppText(from, done.message);
    if (!done.ok) {
      const suggestWait = done.message.toLowerCase().includes('alguns minutos');
      if (suggestWait && state.reservation) {
        state.reservation.awaiting_confirmation = false;
        state.reservation.awaiting_manual_review = true;
        userStates.set(from, state);
      }
      const hasRecoverableDraft = hasCompleteReservationData(state.reservation);
      if (!suggestWait && hasRecoverableDraft) {
        await sendReservationConfirmationOrBlock(from, state);
      } else if (!suggestWait && !hasRecoverableDraft) {
        const active = await fetchActiveReservationsWithRetry(from);
        if (active.length > 0) {
          await sendWhatsAppText(from, formatActiveReservationsMessage(active));
        } else {
          await sendWhatsAppText(from, 'Perdi o contexto desse resumo e não vou te mostrar um formulário vazio. Se quiser, me diga novamente unidade, data, horário e quantidade de pessoas para eu reabrir a reserva certinho.');
        }
      }
    }
    return true;
  }

  if (text === 'confirm_reserva_nao') {
    if (!isInActiveFlow(state)) {
      const active = await fetchActiveReservationsWithRetry(from);
      if (active.length === 1) {
        await beginAlterReservationFlow(from, state, active[0]);
        return true;
      }
      if (active.length > 1) {
        await sendWhatsAppText(from, 'Sem problemas! 😊 Qual reserva você quer alterar?');
        await sendManageReservationMenu(from, 'alter', active);
        return true;
      }
      await sendWhatsAppText(from, 'Não encontrei uma reserva ativa para alterar agora. Se quiser, posso te ajudar a consultar ou fazer uma nova reserva.');
      return true;
    }
    if (state.reservation) state.reservation.awaiting_confirmation = false;
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
    if (state.reservation?.awaiting_name) {
      const extractedName = extractExplicitNameUpdate(text, { allowBareName: true });
      const extracted = parseReservationDetails(text);
      if (extractedName) {
        state.reservation = {
          ...(state.reservation || {}),
          ...extracted,
          name: extractedName,
          awaiting_name: false
        };
        userStates.set(from, state);

        const missing = getMissingReservationFields(state.reservation);
        if (missing.length > 0) {
          await sendWhatsAppText(from, `Perfeito, ${extractedName}! ✅ Agora me confirma ${missing.join(' e ')}.`);
          return true;
        }

        await sendReservationConfirmationOrBlock(from, state);
        return true;
      }

      if (Object.keys(extracted).length > 0) {
        state.reservation = { ...(state.reservation || {}), ...extracted, awaiting_name: true };
        userStates.set(from, state);
      }

      await sendWhatsAppText(from, 'Antes de seguir, preciso do seu *nome* para registrar a reserva. 😊');
      return true;
    }

    const extracted = parseReservationDetails(text);
    const extractedName = extractExplicitNameUpdate(
      text,
      { allowBareName: !state.reservation?.name || state.reservation?.name === '❓ Pendente' }
    );
    let deltaAppliedMessage: string | null = null;
    if (state.reservation) {
      const deltas = extractPartyDeltas(text);
      if (deltas) {
        if (deltas.adultsDelta !== 0 && state.reservation.people !== undefined && extracted.people === undefined) {
          extracted.people = Math.max(1, Number(state.reservation.people) + deltas.adultsDelta);
        }
        if (deltas.kidsDelta !== 0 && state.reservation.kids !== undefined && extracted.kids === undefined) {
          extracted.kids = Math.max(0, Number(state.reservation.kids) + deltas.kidsDelta);
        }
        const parts: string[] = [];
        if (deltas.adultsDelta) parts.push(`${deltas.adultsDelta > 0 ? '+' : ''}${deltas.adultsDelta} adultos`);
        if (deltas.kidsDelta) parts.push(`${deltas.kidsDelta > 0 ? '+' : ''}${deltas.kidsDelta} crianças`);
        if (parts.length > 0) {
          deltaAppliedMessage = `Perfeito, atualizei: ${parts.join(' e ')}. Quer manter data e horário?`;
        }
      }
    }
    // If only people is missing, accept "4" style answers.
    if (!extracted.people && !state.reservation?.people) {
      const onlyPeople = extractStandalonePeople(text);
      if (onlyPeople) extracted.people = onlyPeople;
    }
    if (!extracted.time_text && !state.reservation?.time_text) {
      const onlyTime = extractStandaloneTime(text);
      if (onlyTime) extracted.time_text = onlyTime;
    }
    if (extractedName) {
      extracted.name = extractedName;
      extracted.awaiting_name = false;
    } else if (/^(?:alterar\s+o\s+)?nome\s*[:\-]?\s*$/i.test(String(text || '').trim())) {
      await sendWhatsAppText(from, 'Perfeito! Me manda o nome completo exatamente como quer deixar na reserva.');
      return true;
    }
    if (Object.keys(extracted).length > 0) {
      state.reservation = { ...(state.reservation || {}), ...extracted };
      userStates.set(from, state);

      const missing = getMissingReservationFields(state.reservation);

      if (missing.length > 0) {
        if (
          deltaAppliedMessage &&
          !extracted.date_text &&
          !extracted.time_text &&
          state.reservation.date_text &&
          state.reservation.time_text
        ) {
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
      if (state.reservation) state.reservation.awaiting_confirmation = true;
      userStates.set(from, state);
      await sendWhatsAppText(from, 'Estamos quase lá ✅ Se estiver tudo certo no resumo, toque em *Sim, tudo certo!* para eu tentar concluir agora.');
      await sendReservationConfirmationOrBlock(from, state);
      return true;
    }

    if (isReviewStatusRequest || /^[?!.]+$/.test(normalized)) {
      const missing = getMissingReservationFields(state.reservation);
      if (missing.length > 0) {
        await sendWhatsAppText(from, `Ainda não confirmei a reserva 😊 Só falta me confirmar ${missing.join(' e ')}.`);
        return true;
      }
    }

    // Stay deterministic while in active flow; avoid falling back to LLM on ambiguous turns.
    await sendWhatsAppText(from, 'Vamos seguir com a reserva 😊 Me manda adultos, data/horário e crianças (se houver), ou diga exatamente o que quer mudar.');
    return true;
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, BOT_ACTIVE_TIMEOUT_MS);

  try {
    const value = await chatwootService.checkBotActive(phone, controller.signal);
    clearTimeout(timeoutId);
    botActiveCache.set(phone, { value, at: Date.now() });
    return value;
  } catch (err: any) {
    clearTimeout(timeoutId);
    console.warn(`[Chatwoot] checkBotActiveFast error or timeout for ${phone}:`, err?.message);
    return true; // Fallback to active
  }
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
    let mediaId = '';
    let mimeType = '';
    let fileName = '';

    if (message.type === 'text') {
      text = message.text?.body || '';
    } else if (message.type === 'interactive') {
      text = message.interactive?.button_reply?.id ||
        message.interactive?.list_reply?.id ||
        message.interactive?.button_reply?.title ||
        message.interactive?.list_reply?.title || '';
    } else if (message.type === 'button') {
      text = message.button?.payload || message.button?.text || '';
    } else if (message.type === 'document' && message.document) {
      mediaId = message.document.id;
      mimeType = message.document.mime_type;
      fileName = message.document.filename || 'document.pdf';
    } else if (message.type === 'image' && message.image) {
      mediaId = message.image.id;
      mimeType = message.image.mime_type || 'image/jpeg';
      fileName = 'image.jpg';
    } else if (message.type === 'audio' && message.audio) {
      mediaId = message.audio.id;
      mimeType = message.audio.mime_type || 'audio/ogg';
      fileName = 'audio.ogg';
    } else if (message.type === 'video' && message.video) {
      mediaId = message.video.id;
      mimeType = message.video.mime_type || 'video/mp4';
      fileName = 'video.mp4';
    }

    if (!text && !mediaId) {
      console.log(`[WhatsApp] No text or media content in message from ${from}`);
      return;
    }

    if (text) {
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
    } else {
      console.log(`[WhatsApp] Media received from ${from}: ID ${mediaId}`);
    }

    // --- SYNC TO CHATWOOT (Always Sync) ---
    if (mediaId) {
      // Download and sync media to Chatwoot (async)
      downloadWhatsAppMedia(mediaId).then(mediaBuf => {
        if (mediaBuf) {
          chatwootService.syncMediaMessage(from, userName, mediaBuf, fileName, mimeType, 'incoming', { source: 'whatsapp' }).catch(err => {
            console.error(`[Chatwoot] async media sync failed for ${from}:`, err?.message || err);
          });
        }
      }).catch(err => {
          console.error(`[WhatsApp] Media download/sync chain failed for ${from}:`, err?.message || err);
      });
    } else {
      const chatwootIncomingText = formatIncomingForChatwoot(message, text);
      chatwootService.syncMessage(from, userName, chatwootIncomingText, 'incoming', { source: 'whatsapp' }).catch((err) => {
        console.error(`[Chatwoot] async incoming sync failed for ${from}:`, err?.message || err);
      });
    }

    // Check bot active (controls ONLY the agent response)
    const botActiveStart = Date.now();
    const botActive = await checkBotActiveFast(from);
    logStep('checkBotActive', botActiveStart);
    if (!botActive) return;

    // Send typing indicator
    sendTypingIndicator(from, message.id).catch(() => { });

    // Prompt injection check
    if (isPromptInjection(text)) {
      const msg = 'Não posso seguir esse tipo de instrução. Posso te ajudar com cardápio, reservas ou delivery.';
      await sendWhatsAppText(from, msg);
      await chatwootService.syncMessage(from, userName, msg, 'outgoing', { source: 'bot' });
      return;
    }


    // Get/create user state
    let state: UserState | undefined = userStates.get(from);
    if (!state) {
      const persistedState = await redisService.getUserState(from);
      if (persistedState && typeof persistedState === 'object') {
        state = persistedState as UserState;
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
    } else {
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
    if (
      state.reservation?.awaiting_confirmation &&
      /^(sim|ok|confirmo|confirmar|pode confirmar|pode finalizar|sim pode confirmar|sim pode finalizar|sim confirmar|sim finalizar|tudo certo|esta tudo certo)$/.test(textNorm)
    ) {
      text = 'confirm_reserva_sim';
    } else if (state.reservation?.awaiting_confirmation && /^(nao|corrigir|alterar|mudar|nao esta certo)$/.test(textNorm)) {
      text = 'confirm_reserva_nao';
    } else if (state.reservation?.awaiting_cancellation && /^(sim|ok|confirmo|sim cancelar|pode cancelar)$/.test(textNorm)) {
      const pendingId = String(state.reservation?.pending_cancellation_id || '').trim();
      if (pendingId) text = `cancel_yes_${pendingId}`;
    } else if (state.reservation?.awaiting_cancellation && /^(nao|manter|nao cancelar)$/.test(textNorm)) {
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
            const safeResponse = sanitizeIncompleteReservationFallback(
              sanitizeReservationTimingResponse(
                sanitizeAgentFallbackPhone(
                  sanitizeWhatsAppText(result.response),
                  from,
                  state
                ),
                state
              ),
              state
            );
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
        const safeResponse = sanitizeIncompleteReservationFallback(
          sanitizeReservationTimingResponse(
            sanitizeAgentFallbackPhone(
              sanitizeWhatsAppText(result.response),
              from,
              state
            ),
            state
          ),
          state
        );
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
      const nextState: UserState = { ...(state || {}), ...rest };
      state = nextState;
      userStates.set(from, nextState);
    }

    // Mark as interacted
    state = state || {};
    state.has_interacted = true;
    userStates.set(from, state);
    logStep('total', totalStart);

  } catch (error) {
    clearOutboundCapture(message?.from || '');
    console.error('[WhatsApp] Error processing message:', error);
  }
}
