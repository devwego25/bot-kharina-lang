/**
 * E2E Local Test — Simulates WhatsApp webhook payloads against the local server.
 *
 * Usage:
 *   npx ts-node tests/e2e-local.ts
 */

import axios from 'axios';

const BASE_URL = process.env.TEST_URL || 'http://localhost:3000';
const TEST_PHONE = process.env.TEST_PHONE || '5500000000000';
const BOT_PHONE_ID = process.env.TEST_BOT_PHONE_ID || '000000000000000';
let messageCounter = 0;

function makeMessageId(): string {
    return `wamid.test_${Date.now()}_${++messageCounter}`;
}

function makeTextPayload(text: string, from = TEST_PHONE) {
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: '123456789',
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: BOT_PHONE_ID, phone_number_id: BOT_PHONE_ID },
                    contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
                    messages: [{
                        from,
                        id: makeMessageId(),
                        timestamp: String(Math.floor(Date.now() / 1000)),
                        text: { body: text },
                        type: 'text'
                    }]
                },
                field: 'messages'
            }]
        }]
    };
}

function makeInteractivePayload(id: string, title: string, from = TEST_PHONE) {
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: '123456789',
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: BOT_PHONE_ID, phone_number_id: BOT_PHONE_ID },
                    contacts: [{ profile: { name: 'Test User' }, wa_id: from }],
                    messages: [{
                        from, id: makeMessageId(),
                        timestamp: String(Math.floor(Date.now() / 1000)),
                        type: 'interactive',
                        interactive: {
                            type: 'list_reply',
                            list_reply: { id, title }
                        }
                    }]
                },
                field: 'messages'
            }]
        }]
    };
}

interface TestCase {
    name: string;
    payload: any;
    expectedStatus?: number;
    delayMs?: number;
}

const results: { name: string; status: 'PASS' | 'FAIL' | 'ERROR'; detail?: string }[] = [];

async function runTest(test: TestCase) {
    const delay = test.delayMs || 500;
    await new Promise(r => setTimeout(r, delay));

    try {
        const resp = await axios.post(`${BASE_URL}/webhook/whatsapp`, test.payload, {
            timeout: 30000,
            validateStatus: () => true
        });
        const expected = test.expectedStatus || 200;
        if (resp.status === expected) {
            results.push({ name: test.name, status: 'PASS', detail: `HTTP ${resp.status}` });
            console.log(`  ✅ ${test.name} → HTTP ${resp.status}`);
        } else {
            const detail = `Expected ${expected}, got ${resp.status}: ${JSON.stringify(resp.data)}`;
            results.push({ name: test.name, status: 'FAIL', detail });
            console.log(`  ❌ ${test.name} → Expected ${expected}, got ${resp.status}`);
        }
    } catch (err: any) {
        results.push({ name: test.name, status: 'ERROR', detail: err.message });
        console.log(`  💥 ${test.name} → ERROR: ${err.message}`);
    }
}

async function testDeterministicFlows() {
    console.log('\n📋 Suite 1: Fluxos Determinísticos\n');
    const tests: TestCase[] = [
        { name: 'Greeting "oi"', payload: makeTextPayload('oi') },
        { name: 'Menu Cardápio', payload: makeInteractivePayload('menu_cardapio', 'Ver Cardápio') },
        { name: 'Menu Delivery', payload: makeInteractivePayload('menu_delivery', 'Delivery 🍟🚀') },
    ];
    for (const test of tests) await runTest(test);
}

async function testDeliveryFlows() {
    console.log('\n📋 Suite 2: Fluxos de Delivery\n');
    const tests: TestCase[] = [
        { name: 'Delivery Curitiba', payload: makeInteractivePayload('delivery_curitiba', 'Curitiba / PR') },
        { name: 'Delivery Londrina', payload: makeInteractivePayload('delivery_londrina', 'Londrina / PR') },
    ];
    for (const test of tests) await runTest(test);
}

async function testDeliveryFreeText() {
    console.log('\n📋 Suite 3: Delivery por Texto Livre\n');
    const tests: TestCase[] = [
        { name: '"delivery de londrina"', payload: makeTextPayload('delivery de londrina') },
        { name: '"delivery sp"', payload: makeTextPayload('delivery de são paulo') },
    ];
    for (const test of tests) await runTest(test);
}

async function main() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  🧪 Kharina Bot E2E Local Tests');
    console.log('═══════════════════════════════════════════════════════');

    try {
        const health = await axios.get(`${BASE_URL}/health`, { timeout: 5000 });
        const data = health.data as any;
        console.log(`\n✅ Server is up! MCP: Cardápio=${data.mcp?.cardapio}, Reservas=${data.mcp?.reservas}\n`);
    } catch {
        console.error('\n❌ Server is not running! Start it with: npm run dev\n');
        process.exit(1);
    }

    await testDeterministicFlows();
    await testDeliveryFlows();
    await testDeliveryFreeText();

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  📊 RESULTS SUMMARY');
    console.log('═══════════════════════════════════════════════════════\n');

    for (const r of results) {
        const icon = r.status === 'PASS' ? '✅' : '❌';
        console.log(`  ${icon} ${r.name}`);
    }
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
