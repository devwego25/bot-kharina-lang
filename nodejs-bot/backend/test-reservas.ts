
import { reservasMcp } from './src/agent/tools';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
    console.log('[Test] Connecting to Reservas MCP...');
    reservasMcp.connect();

    const ready = await reservasMcp.waitReady(10000);
    if (!ready) {
        console.error('[Test] Reservas MCP failed to connect.');
        process.exit(1);
    }

    console.log('[Test] Listing stores from Reservas MCP...');
    try {
        const result = await reservasMcp.listTools();
        console.log('[Test] Available Tools:', result.tools.map((t: any) => t.name));

        const stores = await reservasMcp.callTool('list_stores', {});
        console.log('[Test] Reservas Stores:', JSON.stringify(stores, null, 2));
    } catch (e: any) {
        console.error('[Test] Error:', e.message);
    }

    process.exit(0);
}

run();
