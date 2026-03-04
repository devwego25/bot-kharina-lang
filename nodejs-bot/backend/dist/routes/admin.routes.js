"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../services/db");
const adminAuth_1 = require("../middleware/adminAuth");
const promptService_1 = require("../services/promptService");
const router = (0, express_1.Router)();
router.use(adminAuth_1.adminAuth);
// --- Maintenance ---
// POST /api/admin/cache/clear - Clear the prompt cache
router.post('/cache/clear', (req, res) => {
    promptService_1.promptService.clearCache();
    res.json({ success: true, message: 'Prompt cache cleared' });
});
// --- Auth Validation ---
// GET /api/admin/validate - Test API Key
router.get('/validate', (req, res) => {
    res.json({
        valid: true,
        message: 'API Key is correct',
        timestamp: new Date().toISOString()
    });
});
// --- Espaço Kids Conveniência ---
// GET /api/admin/kids - List all Instagram links
router.get('/kids', async (req, res) => {
    try {
        const configs = await db_1.db.listConfigs();
        const kidsLinks = configs
            .filter(c => c.key.startsWith('kids_instagram_'))
            .map(c => ({
            unit: c.key.replace('kids_instagram_', ''),
            link: c.value,
            updated_at: c.updated_at
        }));
        res.json(kidsLinks);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to list kids links' });
    }
});
// PUT /api/admin/kids/:unit - Update Instagram link for a unit
router.put('/kids/:unit', async (req, res) => {
    const { unit } = req.params;
    const { link } = req.body;
    if (!link)
        return res.status(400).json({ error: 'Link is required' });
    try {
        const key = `kids_instagram_${unit}`;
        await db_1.db.upsertConfig(key, link);
        res.json({ success: true, unit, link });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to update kids link' });
    }
});
// --- Delivery Conveniência ---
// GET /api/admin/delivery - List all delivery links
router.get('/delivery', async (req, res) => {
    try {
        const configs = await db_1.db.listConfigs();
        const deliveryLinks = configs
            .filter(c => c.key.startsWith('link_delivery_'))
            .map(c => ({
            city: c.key.replace('link_delivery_', ''),
            link: c.value,
            updated_at: c.updated_at
        }));
        res.json(deliveryLinks);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to list delivery links' });
    }
});
// PUT /api/admin/delivery/:city - Update delivery link for a city
router.put('/delivery/:city', async (req, res) => {
    const { city } = req.params;
    const { link } = req.body;
    if (!link)
        return res.status(400).json({ error: 'Link is required' });
    try {
        const key = `link_delivery_${city}`;
        await db_1.db.upsertConfig(key, link);
        res.json({ success: true, city, link });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to update delivery link' });
    }
});
exports.default = router;
