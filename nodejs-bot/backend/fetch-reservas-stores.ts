import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const url = process.env.MCP_RESERVAS_URL || 'https://mcp.reservas.wegosb.com.br/mcp';
const token = process.env.MCP_RESERVAS_TOKEN;

async function listStores() {
    console.log(`Connecting to Reservas MCP at ${url}...`);

    try {
        const response: any = await axios.post(url, {
            jsonrpc: '2.0',
            method: 'list_stores',
            params: {},
            id: 1
        }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/event-stream'
            }
        });

        if (response.data.error) {
            console.error('MCP Error:', response.data.error);
            return;
        }

        const result = response.data.result;
        console.log('--- STORES FROM RESERVAS SYSTEM ---');

        // The result might be a list of tools or the direct result of list_stores
        // Depending on how the proxy handles the call.
        console.log(JSON.stringify(result, null, 2));

    } catch (error: any) {
        if (error.response) {
            console.error(`Request failed with status ${error.response.status}`);
            console.error('Response data:', error.response.data);
        } else {
            console.error('Error:', error.message);
        }
    }
}

listStores();
