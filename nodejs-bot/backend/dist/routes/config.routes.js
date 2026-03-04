"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = require("../services/db");
const adminAuth_1 = require("../middleware/adminAuth");
const router = (0, express_1.Router)();
// --- Configuration Endpoints ---
// GET /api/config - List all dynamic variables
router.get('/config', adminAuth_1.adminAuth, async (req, res) => {
    try {
        const configs = await db_1.db.listConfigs();
        res.json(configs);
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to list configs' });
    }
});
// POST /api/config - Update or create a dynamic variable
router.post('/config', adminAuth_1.adminAuth, async (req, res) => {
    const { key, value } = req.body;
    if (!key || value === undefined) {
        return res.status(400).json({ error: 'Key and value are required' });
    }
    try {
        await db_1.db.upsertConfig(key, value);
        res.json({ success: true, key, value });
    }
    catch (err) {
        res.status(500).json({ error: 'Failed to update config' });
    }
});
// --- Prompt Endpoints ---
// GET /api/prompt - Read the prompt from DB
router.get('/prompt', adminAuth_1.adminAuth, async (req, res) => {
    try {
        const content = await db_1.db.getPrompt('main_prompt');
        // If null, it means it hasn't been seeded yet (service restart needed or first run)
        res.json({ content: content || '' });
    }
    catch (err) {
        console.error('Error getting prompt:', err);
        res.status(500).json({ error: 'Failed to read prompt' });
    }
});
// POST /api/prompt - Update the prompt in DB
router.post('/prompt', adminAuth_1.adminAuth, async (req, res) => {
    const { content } = req.body;
    if (!content) {
        return res.status(400).json({ error: 'Content is required' });
    }
    try {
        await db_1.db.updatePrompt(content, 'main_prompt');
        res.json({ success: true });
    }
    catch (err) {
        console.error('Error updating prompt:', err);
        res.status(500).json({ error: 'Failed to update prompt' });
    }
});
exports.default = router;
