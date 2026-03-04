import { Router, Request, Response } from 'express';
import { db } from '../services/db';
import { adminAuth } from '../middleware/adminAuth';
import { promptService } from '../services/promptService';

const router = Router();
router.use(adminAuth);

// --- Maintenance ---

// POST /api/admin/cache/clear - Clear the prompt cache
router.post('/cache/clear', (req: Request, res: Response) => {
    promptService.clearCache();
    res.json({ success: true, message: 'Prompt cache cleared' });
});

// --- Auth Validation ---

// GET /api/admin/validate - Test API Key
router.get('/validate', (req: Request, res: Response) => {
    res.json({
        valid: true,
        message: 'API Key is correct',
        timestamp: new Date().toISOString()
    });
});

// --- Espaço Kids Conveniência ---

// GET /api/admin/kids - List all Instagram links
router.get('/kids', async (req: Request, res: Response) => {
    try {
        const configs = await db.listConfigs();
        const kidsLinks = configs
            .filter(c => c.key.startsWith('kids_instagram_'))
            .map(c => ({
                unit: c.key.replace('kids_instagram_', ''),
                link: c.value,
                updated_at: c.updated_at
            }));
        res.json(kidsLinks);
    } catch (err) {
        res.status(500).json({ error: 'Failed to list kids links' });
    }
});

// PUT /api/admin/kids/:unit - Update Instagram link for a unit
router.put('/kids/:unit', async (req: Request, res: Response) => {
    const { unit } = req.params;
    const { link } = req.body;

    if (!link) return res.status(400).json({ error: 'Link is required' });

    try {
        const key = `kids_instagram_${unit}`;
        await db.upsertConfig(key, link);
        res.json({ success: true, unit, link });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update kids link' });
    }
});

// --- Delivery Conveniência ---

// GET /api/admin/delivery - List all delivery links
router.get('/delivery', async (req: Request, res: Response) => {
    try {
        const configs = await db.listConfigs();
        const deliveryLinks = configs
            .filter(c => c.key.startsWith('link_delivery_'))
            .map(c => ({
                city: c.key.replace('link_delivery_', ''),
                link: c.value,
                updated_at: c.updated_at
            }));
        res.json(deliveryLinks);
    } catch (err) {
        res.status(500).json({ error: 'Failed to list delivery links' });
    }
});

// PUT /api/admin/delivery/:city - Update delivery link for a city
router.put('/delivery/:city', async (req: Request, res: Response) => {
    const { city } = req.params;
    const { link } = req.body;

    if (!link) return res.status(400).json({ error: 'Link is required' });

    try {
        const key = `link_delivery_${city}`;
        await db.upsertConfig(key, link);
        res.json({ success: true, city, link });
    } catch (err) {
        res.status(500).json({ error: 'Failed to update delivery link' });
    }
});

export default router;
