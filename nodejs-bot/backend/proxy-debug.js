
const axios = require('axios');
const SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;

async function runDebug() {
    console.log('--- PROXY DEBUG START ---');
    console.log('Node Version:', process.version);
    console.log('Environment:');
    console.log('HTTP_PROXY:', process.env.HTTP_PROXY);
    console.log('HTTPS_PROXY:', process.env.HTTPS_PROXY);
    console.log('NO_PROXY:', process.env.NO_PROXY);

    const testUrl = 'https://chat.kharina.com.br/api/v1/accounts/1/contacts/search?q=556596419667';
    const headers = { 'api_access_token': 'LoAh2ak7KNDANChBqd16miBp' };

    console.log('\n1. Testing WITH proxy: false (Explicitly bypassing proxy)');
    try {
        const resp = await axios.get(testUrl, { headers, proxy: false });
        console.log('SUCCESS: Status', resp.status);
    } catch (err) {
        console.error('FAILED:', err.message);
        if (err.response) console.error('Data:', err.response.data);
    }

    console.log('\n2. Testing with SOCKS agent (Simulating WhatsApp style if it accidentally leaks)');
    if (process.env.HTTP_PROXY) {
        const agent = new SocksProxyAgent(process.env.HTTP_PROXY);
        try {
            const resp = await axios.get(testUrl, { headers, httpsAgent: agent, proxy: false });
            console.log('SUCCESS: Status', resp.status);
        } catch (err) {
            console.error('FAILED:', err.message);
        }
    }

    console.log('\n3. Testing with NO proxy config at all (Relying on env NO_PROXY)');
    try {
        const resp = await axios.get(testUrl, { headers });
        console.log('SUCCESS: Status', resp.status);
    } catch (err) {
        console.error('FAILED:', err.message);
    }

    console.log('--- PROXY DEBUG END ---');
}

runDebug();
