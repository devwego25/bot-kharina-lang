import axios from 'axios';
import { EventSource } from 'eventsource';

async function testMcp(url: string, name: string, token?: string) {
    console.log(`\n--- Testing MCP: ${name} (${url}) ---`);
    try {
        const es = new EventSource(url, {
            fetch: (url: string, init: any) => {
                init.headers = {
                    ...init.headers,
                    'Accept': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive'
                };
                if (token) init.headers['Authorization'] = `Bearer ${token}`;
                return fetch(url, init);
            }
        } as any);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                es.close();
                reject(new Error('Connection timeout (15s)'));
            }, 15000);

            es.onopen = () => console.log(`[${name}] SSE Connection Opened.`);
            es.onerror = (e) => console.error(`[${name}] SSE Error:`, e);

            es.addEventListener('endpoint', async (event: any) => {
                clearTimeout(timeout);
                const sessionEndpoint = new URL(event.data, url).toString();
                console.log(`[${name}] Session Endpoint found: ${sessionEndpoint}`);

                try {
                    console.log(`[${name}] Sending 'initialize'...`);
                    const response = await axios.post(sessionEndpoint, {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'initialize',
                        params: {
                            protocolVersion: '2024-11-05',
                            capabilities: {},
                            clientInfo: { name: 'Test', version: '1.0.0' }
                        }
                    }, {
                        headers: { 'Content-Type': 'application/json' }
                    });

                    console.log(`[${name}] HTTP Response Status: ${response.status}`);
                    console.log(`[${name}] HTTP Response Body:`, JSON.stringify(response.data, null, 2));

                    es.close();
                    resolve(true);
                } catch (err: any) {
                    console.error(`[${name}] POST Failed:`, err.response?.data || err.message);
                    es.close();
                    reject(err);
                }
            });
        });
    } catch (e: any) {
        console.error(`[${name}] Test Failed:`, e.message);
    }
}

async function runAll() {
    const cardapioUrl = process.env.MCP_CARDAPIO_URL || 'http://172.17.0.1:3002/mcp';
    const reservasUrl = process.env.MCP_RESERVAS_URL || 'https://mcp.reservas.wegosb.com.br/mcp';
    const token = process.env.MCP_RESERVAS_TOKEN;

    await testMcp(cardapioUrl, 'Cardapio');
    await testMcp(reservasUrl, 'Reservas', token);
}

runAll();
