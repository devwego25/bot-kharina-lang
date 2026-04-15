import { Pool } from 'pg';
import { config } from '../config/env';

// Pool configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
});

export const db = {
    query: (text: string, params?: any[]) => pool.query(text, params),

    // Helper to get config value
    getConfig: async (key: string): Promise<string | null> => {
        try {
            const res = await pool.query('SELECT value FROM system_config WHERE key = $1', [key]);
            if (res.rows.length > 0) return res.rows[0].value;
            return null;
        } catch (err) {
            console.error('Error fetching config:', err);
            return null;
        }
    },

    // Helper to list all configs
    listConfigs: async (): Promise<any[]> => {
        try {
            const res = await pool.query('SELECT key, value, updated_at FROM system_config ORDER BY key ASC');
            return res.rows;
        } catch (err) {
            console.error('Error listing configs:', err);
            return [];
        }
    },

    // Helper to set/update config value
    upsertConfig: async (key: string, value: string) => {
        const queryText = `
            INSERT INTO system_config (key, value, updated_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (key) DO UPDATE
            SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
        `;
        try {
            await pool.query(queryText, [key, value]);
            console.log(`[DB] Config updated: ${key}`);
        } catch (err) {
            console.error(`[DB] Failed to update config ${key}:`, err);
            throw err;
        }
    },

    // Helper to get raw prompt
    getPrompt: async (key: string = 'main_prompt'): Promise<string | null> => {
        try {
            const res = await pool.query('SELECT content FROM system_prompts WHERE key = $1', [key]);
            if (res.rows.length > 0) return res.rows[0].content;
            return null;
        } catch (err) {
            console.error('[DB] Error fetching prompt:', err);
            return null;
        }
    },

    // Helper to update prompt
    updatePrompt: async (content: string, key: string = 'main_prompt') => {
        const queryText = `
            INSERT INTO system_prompts (key, content, updated_at)
            VALUES ($1, $2, CURRENT_TIMESTAMP)
            ON CONFLICT (key) DO UPDATE
            SET content = EXCLUDED.content, updated_at = CURRENT_TIMESTAMP
        `;
        try {
            await pool.query(queryText, [key, content]);
            console.log(`[DB] Prompt updated: ${key}`);
        } catch (err) {
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

        CREATE TABLE IF NOT EXISTS admin_users (
            phone VARCHAR(32) PRIMARY KEY,
            role VARCHAR(16) NOT NULL CHECK (role IN ('master', 'admin')),
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_by VARCHAR(32),
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS reservation_blocks (
            id BIGSERIAL PRIMARY KEY,
            store_id VARCHAR(64) NOT NULL,
            store_name VARCHAR(128) NOT NULL,
            weekday SMALLINT NULL CHECK (weekday BETWEEN 0 AND 6),
            start_time VARCHAR(5) NOT NULL,
            end_time VARCHAR(5) NOT NULL,
            mode VARCHAR(32) NOT NULL CHECK (mode IN ('deny', 'suggest_alternative', 'handoff')),
            message TEXT NOT NULL,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_by VARCHAR(32) NOT NULL,
            updated_by VARCHAR(32),
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS reservation_attempts (
            id BIGSERIAL PRIMARY KEY,
            phone VARCHAR(32) NOT NULL,
            store_id VARCHAR(64) NOT NULL,
            store_name VARCHAR(128) NOT NULL,
            customer_name VARCHAR(128),
            date_text VARCHAR(10) NOT NULL,
            time_text VARCHAR(5) NOT NULL,
            adults INTEGER NOT NULL DEFAULT 0,
            kids INTEGER NOT NULL DEFAULT 0,
            total_people INTEGER NOT NULL DEFAULT 0,
            notes TEXT,
            status VARCHAR(32) NOT NULL CHECK (status IN ('creating', 'manual_review', 'confirmed_bot', 'confirmed_recovered', 'confirmed_manual', 'failed')),
            resolution_source VARCHAR(32),
            reservation_id VARCHAR(128),
            reservation_code VARCHAR(64),
            last_error TEXT,
            manual_review_notified_at TIMESTAMP,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            resolved_at TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_admin_users_active_role ON admin_users (active, role);
        CREATE INDEX IF NOT EXISTS idx_reservation_blocks_lookup ON reservation_blocks (active, store_id, weekday, start_time, end_time);
        CREATE INDEX IF NOT EXISTS idx_reservation_attempts_lookup ON reservation_attempts (phone, store_id, date_text, time_text, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_reservation_attempts_status ON reservation_attempts (status, updated_at DESC);
      `;
        try {
            await pool.query(createTableText);
            await pool.query(`
                ALTER TABLE reservation_attempts
                ADD COLUMN IF NOT EXISTS manual_review_notified_at TIMESTAMP
            `);
            console.log('[DB] Config table initialized');
        } catch (err) {
            console.error('[DB] Failed to init config table', err);
        }
    }
};
