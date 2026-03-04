"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const whatsapp_1 = require("../services/whatsapp");
const adminAuth_1 = require("../middleware/adminAuth");
const router = (0, express_1.Router)();
// POST /api/whatsapp/send
router.post('/send', adminAuth_1.adminAuth, async (req, res) => {
    const { to, text } = req.body;
    console.log(`[Relay] Incoming request to send message to ${to}: "${text.substring(0, 50)}..."`);
    if (!to || !text) {
        console.warn('[Relay] Missing to or text');
        return res.status(400).json({ error: 'to and text are required' });
    }
    try {
        await (0, whatsapp_1.sendWhatsAppText)(to, text);
        console.log(`[Relay] Message sent successfully to ${to}`);
        res.json({ success: true });
    }
    catch (err) {
        console.error('[WhatsApp Route] Error:', err.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});
exports.default = router;
