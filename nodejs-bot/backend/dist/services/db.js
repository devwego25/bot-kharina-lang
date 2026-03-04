"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
const pg_1 = require("pg");
// Pool configuration
const pool = new pg_1.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});
exports.db = {
    query: (text, params) => pool.query(text, params),
    // Helper to get config value
    getConfig: async (key) => {
        try {
            const res = await pool.query('SELECT value FROM system_config WHERE key = $1', [key]);
            if (res.rows.length > 0)
                return res.rows[0].value;
            return null;
        }
        catch (err) {
            console.error('Error fetching config:', err);
            return null;
        }
    },
    // Helper to list all configs
    listConfigs: async () => {
        try {
            const res = await pool.query('SELECT key, value, updated_at FROM system_config ORDER BY key ASC');
            return res.rows;
        }
        catch (err) {
            console.error('Error listing configs:', err);
            return [];
        }
    },
    // Helper to set/update config value
    upsertConfig: async (key, value) => {
        const queryText = `
            INSERT INTO system_config (key, value, updated_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
        `;
        try {
            await pool.query(queryText, [key, value]);
            console.log(`[DB] Config updated: ${key}`);
        }
        catch (err) {
            console.error(`[DB] Failed to update config ${key}:`, err);
            throw err;
        }
    },
    // Helper to get raw prompt
    getPrompt: async (key = 'main_prompt') => {
        try {
            const res = await pool.query('SELECT content FROM system_prompts WHERE key = $1', [key]);
            if (res.rows.length > 0)
                return res.rows[0].content;
            return null;
        }
        catch (err) {
            console.error('[DB] Error fetching prompt:', err);
            return null;
        }
    },
    // Helper to update prompt
    updatePrompt: async (content, key = 'main_prompt') => {
        const queryText = `
            INSERT INTO system_prompts (key, content, updated_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (key) DO UPDATE
            SET content = EXCLUDED.content, updated_at = CURRENT_TIMESTAMP
        `;
        try {
            await pool.query(queryText, [key, content]);
            console.log(`[DB] Prompt updated: ${key}`);
        }
        catch (err) {
            console.error(`[DB] Failed to update prompt ${key}:`, err);
            throw err;
        }
    },
    // Helper to init config table
    init: async () => {
        const createTableText = `
        CREATE TABLE IF NOT EXISTS system_config (
            key VARCHAR(255) PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        
        CREATE TABLE IF NOT EXISTS system_prompts (
            key VARCHAR(255) PRIMARY KEY,
            content TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `;
        try {
            await pool.query(createTableText);
            console.log('[DB] Config table initialized');
        }
        catch (err) {
            console.error('[DB] Failed to init config table', err);
        }
    }
};
