import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const pool = new Pool({
    connectionString: "postgresql://postgres:193ad511e7b50e22c80638a615c280bd@localhost:5432/mcp_cardapio"
});

async function run() {
    try {
        console.log('Querying unique storeIds in MenuItem table (mcp_cardapio DB)...');
        const res = await pool.query('SELECT DISTINCT "storeId" FROM "MenuItem"');
        console.log('Unique storeIds found:', res.rows.length);
        console.table(res.rows);

        // Also get counts per storeId
        const counts = await pool.query('SELECT "storeId", COUNT(*) as count FROM "MenuItem" GROUP BY "storeId"');
        console.table(counts.rows);

    } catch (err) {
        console.error('Error:', err);
    } finally {
        await pool.end();
    }
}

run();
