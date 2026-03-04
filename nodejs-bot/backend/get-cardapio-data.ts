import { McpClient } from './src/services/mcp';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
    const url = process.env.MCP_CARDAPIO_URL || 'http://localhost:3001/mcp';

    console.log(`[Test] Initializing McpClient for Cardapio at ${url}...`);
    const client = new McpClient(
        url,
        'Cardapio-Audit',
        undefined, // No token usually for local cardapio
        true, // tokenInUrl
        'sse' // transport
    );

    client.connect();

    console.log('[Test] Waiting for client to be ready...');
    const ready = await client.waitReady(15000);
    if (!ready) {
        console.error('[Test] MCP failed to initialize.');
        // Try streamable just in case it was misconfigured in code but works differently
        process.exit(1);
    }

    console.log('[Test] Listing tools...');
    try {
        const tools = await client.listTools();
        console.log('Available Tools:', JSON.stringify(tools, null, 2));

        // If there's a mcp_cardapio tool, let's try to see if we can get list of "stores" indirectly
        // or just check a basic query.
        const result = await client.callTool('mcp_cardapio', { query: 'hamburger', storeId: null });
        console.log('Sample result:', JSON.stringify(result, null, 2));

    } catch (e: any) {
        console.error('[Test] Tool call failed:', e.message);
    }

    client.shutdown();
    process.exit(0);
}

run();
