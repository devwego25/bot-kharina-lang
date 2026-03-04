import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Force load .env from the current directory
dotenv.config({ path: path.resolve(__dirname, '.env') });

const connectionString = process.env.DATABASE_URL?.replace('host.docker.internal', 'localhost');

if (!connectionString) {
    console.error('DATABASE_URL not found in .env');
    process.exit(1);
}

const pool = new Pool({
    connectionString
});

async function upsertConfig(key: string, value: string) {
    const queryText = `
    INSERT INTO system_config (key, value, updated_at)
    VALUES ($1, $2, CURRENT_TIMESTAMP)
    ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP
  `;
    try {
        await pool.query(queryText, [key, value]);
        console.log(`[DB] Config updated: ${key} -> ${value}`);
    } catch (err) {
        console.error(`[DB] Failed to update config ${key}:`, err);
        throw err;
    }
}

const UUIDS = {
    city_curitiba_cardapio_uuid: '550e8400-e29b-41d4-a716-446655440001',
    city_londrina_cardapio_uuid: '550e8400-e29b-41d4-a716-446655440002',
    city_sp_cardapio_uuid: '550e8400-e29b-41d4-a716-446655440003'
};

async function run() {
    try {
        console.log('Syncing City UUIDs to database...');
        for (const [key, value] of Object.entries(UUIDS)) {
            await upsertConfig(key, value);
        }
        console.log('Sync completed successfully!');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await pool.end();
    }
}

run();
