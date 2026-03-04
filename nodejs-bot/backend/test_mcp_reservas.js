const axios = require('axios');
require('dotenv').config();

const url = process.env.MCP_RESERVAS_URL || 'https://mcp.reservas.wegosb.com.br/mcp';
const token = process.env.MCP_RESERVAS_TOKEN;

async function test() {
    console.log('Testing MCP Reservas at:', url);
    const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
    };

    try {
        // 1. Initialize
        console.log('\n--- 1. Initialize ---');
        const initPayload = {
            jsonrpc: '2.0',
            method: 'initialize',
            params: {
                protocolVersion: '2024-11-05',
                capabilities: {},
                clientInfo: { name: 'Test', version: '1.0.0' }
            },
            id: '1'
        };
        const initRes = await axios.post(url, initPayload, { headers });
        console.log('Init Status:', initRes.status);
        console.log('Init Response Headers:', JSON.stringify(initRes.headers, null, 2));
        console.log('Init Response Body:', JSON.stringify(initRes.data, null, 2));

        const sessionId = initRes.headers['mcp-session-id'];
        if (sessionId) {
            headers['mcp-session-id'] = sessionId;
            console.log('Session ID:', sessionId);
        } else {
            console.log('NO MCP-SESSION-ID FOUND IN HEADERS');
        }

        // 2. Initialized Notification
        console.log('\n--- 2. Initialized Notification ---');
        await axios.post(url, {
            jsonrpc: '2.0',
            method: 'notifications/initialized'
        }, { headers });
        console.log('Notification sent.');

        // 3. List Tools
        console.log('\n--- 3. List Tools ---');
        const listRes = await axios.post(url, {
            jsonrpc: '2.0',
            method: 'tools/list',
            params: {},
            id: '2'
        }, { headers });
        console.log('List Status:', listRes.status);
        console.log('List Body:', JSON.stringify(listRes.data, null, 2));

        // 4. Call Tool (query_reservations)
        console.log('\n--- 4. Call query_reservations ---');
        const callPaylad = {
            jsonrpc: '2.0',
            method: 'tools/call',
            params: {
                name: 'query_reservations',
                arguments: { storeId: 'c6919b3c-f5ff-4006-a226-2b493d9d8cf5' }
            },
            id: '3'
        };
        const callRes = await axios.post(url, callPaylad, { headers });
        console.log('Call Status:', callRes.status);
        console.log('Call Body:', JSON.stringify(callRes.data, null, 2));

    } catch (err) {
        console.error('Error:', err.message);
        if (err.response) {
            console.error('Response Status:', err.response.status);
            console.error('Response Data:', JSON.stringify(err.response.data, null, 2));
        }
    }
}

test();
