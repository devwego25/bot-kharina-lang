const axios = require('axios');
const { EventSource } = require('eventsource');

async function testMcp(url, name, token, pattern = 'FETCH_HEADERS') {
    console.log(`\n--- Testing MCP: ${name} (${url}) | Pattern: ${pattern} ---`);

    try {
        let esOptions = {};
        if (token) {
            if (pattern === 'FETCH_HEADERS') {
                esOptions = {
                    fetch: (fetchUrl, init) => {
                        init.headers = {
                            ...init.headers,
                            'Accept': 'application/json, text/event-stream',
                            'Authorization': `Bearer ${token}`
                        };
                        return fetch(fetchUrl, init);
                    }
                };
            } else if (pattern === 'DIRECT_HEADERS') {
                esOptions = {
                    headers: {
                        'Authorization': `Bearer ${token}`,
                        'Accept': 'application/json, text/event-stream'
                    }
                };
            }
        }

        const es = new EventSource(url, esOptions);

        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.warn(`[${name}] Connection Timeout (15s).`);
                es.close();
                resolve(false);
            }, 15000);

            es.onopen = () => console.log(`[${name}] SSE Connection Opened.`);
            es.onerror = (e) => {
                console.error(`[${name}] SSE Error:`, e.message || 'Check network/headers.');
                es.close();
                clearTimeout(timeout);
                resolve(false);
            }

            es.addEventListener('endpoint', async (event) => {
                clearTimeout(timeout);
                const sessionEndpoint = new URL(event.data, url).toString();
                console.log(`[${name}] Session Endpoint found: ${sessionEndpoint}`);

                try {
                    console.log(`[${name}] Sending 'initialize'...`);
                    const headers = {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json, text/event-stream'
                    };
                    if (token) headers['Authorization'] = `Bearer ${token}`;

                    const response = await axios.post(sessionEndpoint, {
                        jsonrpc: '2.0',
                        id: 1,
                        method: 'initialize',
                        params: {
                            protocolVersion: '2024-11-05',
                            capabilities: {},
                            clientInfo: { name: 'Test', version: '1.0.0' }
                        }
                    }, { headers, timeout: 10000 });

                    console.log(`[${name}] POST Response Status: ${response.status}`);
                    console.log(`[${name}] POST Response Body:`, JSON.stringify(response.data, null, 2));

                    es.close();
                    resolve(true);
                } catch (err) {
                    const errData = err.response?.data ? JSON.stringify(err.response.data) : err.message;
                    console.error(`[${name}] POST Failed:`, errData);
                    es.close();
                    resolve(false);
                }
            });
        });
    } catch (e) {
        console.error(`[${name}] Test Failed:`, e.message);
        return false;
    }
}

async function runAll() {
    const cardapioUrl = process.env.MCP_CARDAPIO_URL || 'http://172.17.0.1:3001/mcp';
    const reservasUrl = process.env.MCP_RESERVAS_URL || 'https://mcp.reservas.wegosb.com.br/mcp';
    const token = process.env.MCP_RESERVAS_TOKEN;

    console.log('[Diagnostics] Starting multi-pattern test...');

    // Test Cardapio (Local)
    await testMcp(cardapioUrl, 'Cardapio (Standard)', token, 'FETCH_HEADERS');

    // Test Reservas (Remote) with multiple patterns
    await testMcp(reservasUrl, 'Reservas (Fetch)', token, 'FETCH_HEADERS');
    await testMcp(reservasUrl, 'Reservas (Direct)', token, 'DIRECT_HEADERS');

    // Pattern: URL Token
    const urlWithToken = `${reservasUrl}?token=${token}`;
    await testMcp(urlWithToken, 'Reservas (URL Token)', null, 'NONE');
}

runAll().then(() => console.log('\n--- Diagnostics Finished ---'));
