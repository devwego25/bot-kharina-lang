/// <reference types="node" />

import { McpClient } from './src/services/mcp';

async function test() {
    const reservasMcp = new McpClient(
        'https://mcp.reservas.wegosb.com.br/mcp',
        'Reservas',
        'c10748be293dc100ca2dd20782aae33a243724a78e2430b00b39db9a1bd70b3f',
        false,
        'streamable'
    );

    console.log('Connecting...');
    reservasMcp.connect();
    await reservasMcp.waitReady();
    console.log('Fetching stores...');
    const stores = await reservasMcp.callTool('list_stores', {});
    console.log('STORES RESULT:');
    console.log(JSON.stringify(stores, null, 2));
    process.exit(0);
}

test().catch(err => {
    console.error(err);
    process.exit(1);
});
