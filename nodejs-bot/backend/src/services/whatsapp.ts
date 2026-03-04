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

const INTERACTIVE_DEGRADED_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_WINDOW_MS = 1000; // 1 second between messages
const GRAPH_API_TIMEOUT_MS = 8000;
const SCOPE_ONLY_MSG = 'Só posso ajudar com assuntos do restaurante: cardápio, reservas e delivery.';

// Command sets
const MENU_COMMANDS = new Set(['MENU_PRINCIPAL', 'menu_cardapio', 'menu_reserva', 'menu_delivery']);
const GREETING_COMMANDS = new Set(['oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite']);

// Bot message patterns to ignore (echo detection)
const BOT_MESSAGE_PATTERNS = [
  /^(opa!? ?👋? ?eu sou a kha|beleza!? ?👌|escolha uma opção|escolhe a cidade|qual unidade)/i,
  /^(perfeito!? ?aqui está o cardápio|show!?) ?🍽?/i,
  /^(você quer fazer um novo pedido|sinto muito pelo problema)/i,
  /^(prontinho!? ?✅? ?já encaminhei)/i,
];

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

function sanitizeWhatsAppText(text: string): string {
  if (!text) return text;
  return text
    .replace(/```/g, '')
    .replace(/\s*\(\d{4}-\d{2}-\d{2}\)/g, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$2')
    .replace(/^[#{1,6}]\s+/gm, '')
    .trim();
}

function shouldOfferMainMenu(result: any): boolean {
  const intent = String(result?.intent || '').toLowerCase();
  const response = String(result?.response || '').toLowerCase();

  if (intent === 'error') return true;

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
      await axios.post(
        `https://graph.facebook.com/v24.0/${config.whatsapp.phoneId}/messages`,
        payload,
        axiosConfig
      );
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
    `- 👥 Pessoas: ${resv.people !== undefined ? resv.people : '❓ Pendente'}`,
    `- 👶 Crianças: ${resv.kids !== undefined ? resv.kids : '❓ Pendente'}`,
    `- 📍 Unidade: ${unit}`
  ].join('\n');

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
          { type: "reply", reply: { id: `cancel_sim_${reservationId.substring(0, 8)}`, title: "Sim, cancelar ❌" } },
          { type: "reply", reply: { id: `cancel_nao`, title: "Não, manter ✅" } }
        ]
      }
    }
  };
  await sendInteractiveWithFallback(to, payload, 'send_cancel_confirmation',
    `${preamble} Responda "Sim, cancelar" ou "Não".`);
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
  state: UserState
): Promise<boolean> {
  const normalized = text.trim().toLowerCase();
  const isReservationIntent =
    /\breserv(a|ar|e|ei|ando|ação|acao|as)\b/.test(normalized) ||
    normalized.includes('quero reservar') ||
    normalized.includes('fazer reserva') ||
    normalized.includes('reservar mesa');

  // Main menu
  if (text === 'MENU_PRINCIPAL' || normalized === 'menu' || normalized === 'inicio' || normalized === 'voltar') {
    state.reservation = undefined;
    state.has_interacted = true;
    userStates.set(from, state);
    await sendMainMenu(from, true);
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

    const link = await db.getConfig(`link_cardapio_${text.replace('cardapio_', '')}`);
    const msg = `Perfeito! Aqui está o cardápio de ${city} 🍽️\n👉 ${link || 'https://kharina.com.br/cardapio-digital/'}`;
    await sendWhatsAppText(from, msg);
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
  const unitMap: Record<string, string> = {
    'unidade_botanico': 'Jardim Botânico',
    'unidade_cabral': 'Cabral',
    'unidade_agua_verde': 'Água Verde',
    'unidade_batel': 'Batel',
    'unidade_portao': 'Portão',
    'unidade_londrina': 'Londrina',
    'unidade_saopaulo': 'São Paulo'
  };

  if (unitMap[text]) {
    state.preferred_unit_name = unitMap[text];
    state.reservation = { ...(state.reservation || {}), phone_confirmed: false };
    userStates.set(from, state);

    await sendWhatsAppText(from, `Show! Você escolheu a unidade ${unitMap[text]}! 😄`);
    await sendPhoneConfirmation(from);
    return true;
  }

  // Phone confirmation
  if (text === 'phone_use_current') {
    state.reservation = state.reservation || {};
    state.reservation.phone_confirmed = true;
    state.reservation.contact_phone = from;
    userStates.set(from, state);

    const msg = `Perfeito! Vou usar este número para a reserva na unidade ${state.preferred_unit_name}. ✅\n\nMe conta: quantas pessoas e para quando?`;
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

  // Confirmation buttons
  if (text === 'confirm_reserva_sim') {
    return false; // Let Python agent handle
  }

  if (text === 'confirm_reserva_nao') {
    if (state.reservation) state.reservation.awaiting_confirmation = false;
    userStates.set(from, state);
    await sendWhatsAppText(from, 'Sem problemas! 😊 Me diz o que você quer alterar (nome, data, horário, pessoas ou crianças).');
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
    const botActive = await chatwootService.checkBotActive(from);
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

    // Try deterministic commands first
    const deterministicStart = Date.now();
    const handled = await handleDeterministicCommand(text, from, state);
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

        if (shouldOfferMainMenu(result)) {
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
