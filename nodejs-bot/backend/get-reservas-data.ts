import { McpClient } from './src/services/mcp';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
    const url = process.env.MCP_RESERVAS_URL || 'https://mcp.reservas.wegosb.com.br/mcp';
    const token = process.env.MCP_RESERVAS_TOKEN;

    console.log('[Test] Initializing McpClient for Reservas...');
    const client = new McpClient(
        url,
        'Reservas-Audit',
        token,
        false, // tokenInUrl
        'streamable' // transport
    );

    client.connect();

    console.log('[Test] Waiting for client to be ready...');
    const ready = await client.waitReady(15000);
    if (!ready) {
        console.error('[Test] MCP failed to initialize. Check token and URL.');
        process.exit(1);
    }

    console.log('[Test] Fetching store list...');
    try {
        const stores = await client.callTool('list_stores', {});
        console.log('--- RESERVATION SYSTEM STORE IDs ---');
        console.log(JSON.stringify(stores, null, 2));
    } catch (e: any) {
        console.error('[Test] Tool call failed:', e.message);
    }

    client.shutdown();
    process.exit(0);
}

run();
