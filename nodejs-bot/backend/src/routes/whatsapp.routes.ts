import { Router, Request, Response } from 'express';
import { sendWhatsAppText } from '../services/whatsapp';
import { adminAuth } from '../middleware/adminAuth';

const router = Router();

// POST /api/whatsapp/send
router.post('/send', adminAuth, async (req: Request, res: Response) => {
    const { to, text } = req.body;
    console.log(`[Relay] Incoming request to send message to ${to}: "${text.substring(0, 50)}..."`);

    if (!to || !text) {
        console.warn('[Relay] Missing to or text');
        return res.status(400).json({ error: 'to and text are required' });
    }

    try {
        await sendWhatsAppText(to, text);
        console.log(`[Relay] Message sent successfully to ${to}`);
        res.json({ success: true });
    } catch (err: any) {
        console.error('[WhatsApp Route] Error:', err.message);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

export default router;
