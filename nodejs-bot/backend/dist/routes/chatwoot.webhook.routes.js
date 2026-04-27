"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const env_1 = require("../config/env");
const whatsapp_1 = require("../services/whatsapp");
const router = (0, express_1.Router)();
function digitsOnly(value) {
    return String(value || '').replace(/\D/g, '');
}
function extractPhone(payload) {
    const candidates = [
        payload?.conversation?.meta?.sender?.phone_number,
        payload?.conversation?.contact_inbox?.source_id,
        payload?.contact?.phone_number,
        payload?.meta?.sender?.phone_number,
        payload?.source_id
    ];
    for (const c of candidates) {
        const d = digitsOnly(c);
        if (d.length >= 10)
            return d;
    }
    return '';
}
/** Detect if a human agent message is confirming a reservation. */
function isReservationConfirmationMessage(content) {
    const c = content.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return (/reserva.*confirm/i.test(c) ||
        /confirm.*reserva/i.test(c) ||
        /^reserva confirmada/i.test(content) ||
        /^consegui confirmar/i.test(content) ||
        /sua reserva.*esta.*confirmada/i.test(c) ||
        /reserva.*feita/i.test(c) ||
        /reserva.*realizada/i.test(c) ||
        /reserva.*ok/i.test(c) ||
        /reserva.*pronta/i.test(c));
}
function shouldRelay(payload) {
    const event = String(payload?.event || '');
    if (event !== 'message_created')
        return { ok: false, reason: `event=${event}` };
    const msg = payload?.message || payload;
    const messageType = String(msg?.message_type || '').toLowerCase();
    if (messageType !== 'outgoing')
        return { ok: false, reason: `message_type=${messageType}` };
    if (msg?.private)
        return { ok: false, reason: 'private_message' };
    const content = String(msg?.content || '').trim();
    if (!content)
        return { ok: false, reason: 'empty_content' };
    const senderType = String(msg?.sender?.type || payload?.sender?.type || '').toLowerCase();
    if (senderType && senderType !== 'user')
        return { ok: false, reason: `sender_type=${senderType}` };
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
router.post('/webhook/chatwoot', async (req, res) => {
    const tokenHeader = String(req.headers['x-chatwoot-token'] || req.headers['x-api-key'] || '');
    const tokenQuery = String(req.query.token || '');
    const providedToken = tokenHeader || tokenQuery;
    const allowedTokens = [
        String(env_1.config.chatwoot.webhookToken || '').trim(),
        String(env_1.config.whatsapp.verifyToken || '').trim()
    ].filter(Boolean);
    if (allowedTokens.length > 0 && !allowedTokens.includes(providedToken)) {
        console.warn('[Chatwoot Relay] Unauthorized webhook request');
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
    }
    const payload = req.body || {};
    const event = String(payload?.event || '');
    // ── Handle conversation_updated (unassignment) ────────────────────────
    if (event === 'conversation_updated') {
        const changes = payload?.changed_attributes || {};
        const to = extractPhone(payload);
        // When assignee is removed (set to null/undefined), clear manual review state
        const assigneeChanged = changes?.assignee_id;
        if (assigneeChanged && to) {
            const newAssignee = assigneeChanged?.current_value;
            if (!newAssignee || newAssignee === null) {
                console.log(`[Chatwoot Relay] Conversation unassigned for ${to} — clearing manual_review state`);
                (0, whatsapp_1.clearReservationDraftForUser)(to);
            }
        }
        res.status(200).json({ ok: true, handled: 'conversation_updated' });
        return;
    }
    // ── Handle message_created (relay agent messages) ─────────────────────
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
    if ((0, whatsapp_1.wasRecentlyMirroredByBot)(to, content)) {
        console.log('[Chatwoot Relay] Ignored: recently_mirrored_by_bot');
        res.status(200).json({ ok: true, ignored: 'recently_mirrored_by_bot' });
        return;
    }
    try {
        // Broader detection of human reservation confirmations
        if (isReservationConfirmationMessage(content)) {
            const codeMatch = content.match(/\b([A-Z0-9]{6,12})\b/);
            await (0, whatsapp_1.markReservationAttemptManualConfirmedForUser)(to, codeMatch?.[1]);
            (0, whatsapp_1.clearReservationDraftForUser)(to);
            console.log(`[Chatwoot Relay] Detected reservation confirmation for ${to}, cleared manual_review`);
        }
        await (0, whatsapp_1.sendWhatsAppText)(to, content);
        console.log(`[Chatwoot Relay] Forwarded agent message to WhatsApp ${to}`);
        res.status(200).json({ ok: true });
    }
    catch (err) {
        console.error('[Chatwoot Relay] Failed to send WhatsApp message:', err?.message || err);
        res.status(500).json({ ok: false, error: 'relay_failed' });
    }
});
exports.default = router;
