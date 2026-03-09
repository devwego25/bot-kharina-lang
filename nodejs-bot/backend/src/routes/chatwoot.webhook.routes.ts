import { Router, Request, Response } from 'express';
import { config } from '../config/env';
import { sendWhatsAppText } from '../services/whatsapp';

const router = Router();

function digitsOnly(value: any): string {
  return String(value || '').replace(/\D/g, '');
}

function extractPhone(payload: any): string {
  const candidates = [
    payload?.conversation?.meta?.sender?.phone_number,
    payload?.conversation?.contact_inbox?.source_id,
    payload?.contact?.phone_number,
    payload?.meta?.sender?.phone_number,
    payload?.source_id
  ];
  for (const c of candidates) {
    const d = digitsOnly(c);
    if (d.length >= 10) return d;
  }
  return '';
}

function shouldRelay(payload: any): { ok: boolean; reason?: string } {
  const event = String(payload?.event || '');
  if (event !== 'message_created') return { ok: false, reason: `event=${event}` };

  const msg = payload?.message || payload;
  const messageType = String(msg?.message_type || '').toLowerCase();
  if (messageType !== 'outgoing') return { ok: false, reason: `message_type=${messageType}` };

  if (msg?.private) return { ok: false, reason: 'private_message' };

  const content = String(msg?.content || '').trim();
  if (!content) return { ok: false, reason: 'empty_content' };

  const senderType = String(msg?.sender?.type || payload?.sender?.type || '').toLowerCase();
  if (senderType && senderType !== 'user') return { ok: false, reason: `sender_type=${senderType}` };

  // Do not re-relay bot mirrored messages.
  const source = String(msg?.content_attributes?.source || '').toLowerCase();
  if (source === 'bot' || source === 'whatsapp' || source === 'system') {
    return { ok: false, reason: `source=${source}` };
  }

  if (/^\[(BOT|INTERACAO|MENU_INTERATIVO)\]/i.test(content)) {
    return { ok: false, reason: 'mirrored_marker' };
  }

  return { ok: true };
}

router.post('/webhook/chatwoot', async (req: Request, res: Response) => {
  const tokenHeader = String(req.headers['x-chatwoot-token'] || req.headers['x-api-key'] || '');
  const tokenQuery = String(req.query.token || '');
  const providedToken = tokenHeader || tokenQuery;
  const allowedTokens = [
    String(config.chatwoot.webhookToken || '').trim(),
    String(config.whatsapp.verifyToken || '').trim()
  ].filter(Boolean);
  if (allowedTokens.length > 0 && !allowedTokens.includes(providedToken)) {
    console.warn('[Chatwoot Relay] Unauthorized webhook request');
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const payload = req.body || {};
  const relayCheck = shouldRelay(payload);
  if (!relayCheck.ok) {
    console.log(`[Chatwoot Relay] Ignored: ${relayCheck.reason}`);
    res.status(200).json({ ok: true, ignored: relayCheck.reason });
    return;
  }

  const msg = payload?.message || payload;
  const content = String(msg?.content || '').trim();
  const to = extractPhone(payload);
  if (!to) {
    console.warn('[Chatwoot Relay] No target phone found in payload');
    res.status(200).json({ ok: true, ignored: 'missing_phone' });
    return;
  }

  try {
    await sendWhatsAppText(to, content);
    console.log(`[Chatwoot Relay] Forwarded agent message to WhatsApp ${to}`);
    res.status(200).json({ ok: true });
  } catch (err: any) {
    console.error('[Chatwoot Relay] Failed to send WhatsApp message:', err?.message || err);
    res.status(500).json({ ok: false, error: 'relay_failed' });
  }
});

export default router;
