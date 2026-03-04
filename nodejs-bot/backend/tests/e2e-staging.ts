/**
 * E2E Staging Test — Tests against the live VPS via the real webhook endpoint.
 *
 * Usage:
 *   npx ts-node tests/e2e-staging.ts
 *
 * ⚠️ This sends REAL webhook payloads to the production server.
 *    Uses a dedicated test phone number to avoid affecting real clients.
 *    The bot WILL try to send WhatsApp messages to TEST_PHONE.
 */

import axios from 'axios';

// ─── Config ──────────────────────────────────────────────────────────────────

const STAGING_URL = process.env.STAGING_URL || 'https://chatbot.kharina.com.br';
const TEST_PHONE = process.env.TEST_PHONE || '5511999999999';
const BOT_PHONE_ID = process.env.TEST_BOT_PHONE_ID || '000000000000000';
let messageCounter = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeId(): string {
    return `wamid.staging_${Date.now()}_${++messageCounter}`;
}

function text(msg: string, from = TEST_PHONE) {
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: '123456789',
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: BOT_PHONE_ID, phone_number_id: BOT_PHONE_ID },
                    contacts: [{ profile: { name: 'E2E Test' }, wa_id: from }],
                    messages: [{
                        from, id: makeId(),
                        timestamp: String(Math.floor(Date.now() / 1000)),
                        text: { body: msg }, type: 'text'
                    }]
                },
                field: 'messages'
            }]
        }]
    };
}

function interactive(id: string, title: string, from = TEST_PHONE) {
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: '123456789',
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: BOT_PHONE_ID, phone_number_id: BOT_PHONE_ID },
                    contacts: [{ profile: { name: 'E2E Test' }, wa_id: from }],
                    messages: [{
                        from, id: makeId(),
                        timestamp: String(Math.floor(Date.now() / 1000)),
                        type: 'interactive',
                        interactive: { type: 'list_reply', list_reply: { id, title } }
                    }]
                },
                field: 'messages'
            }]
        }]
    };
}

// ─── Test Runner ─────────────────────────────────────────────────────────────

interface Result { name: string; status: 'PASS' | 'FAIL' | 'ERROR'; time: number; detail?: string }
const results: Result[] = [];

async function send(name: string, payload: any, waitMs = 2000): Promise<void> {
    const start = Date.now();
    try {
        const resp = await axios.post(`${STAGING_URL}/webhook/whatsapp`, payload, {
            timeout: 30000, validateStatus: () => true
        });
        const elapsed = Date.now() - start;
        if (resp.status === 200) {
            results.push({ name, status: 'PASS', time: elapsed });
            console.log(`  ✅ ${name} (${elapsed}ms)`);
        } else {
            results.push({ name, status: 'FAIL', time: elapsed, detail: `HTTP ${resp.status}` });
            console.log(`  ❌ ${name} → HTTP ${resp.status} (${elapsed}ms)`);
        }
    } catch (err: any) {
        results.push({ name, status: 'ERROR', time: Date.now() - start, detail: err.message });
        console.log(`  💥 ${name} → ${err.message}`);
    }
    await new Promise(r => setTimeout(r, waitMs));
}

// ─── Test Scenarios ──────────────────────────────────────────────────────────

async function scenarioCardapio() {
    console.log('\n🍽️  Cenário: Cardápio Curitiba\n');
    await send('1. Saudação "oi"', text('oi'));
    await send('2. Menu Cardápio', interactive('menu_cardapio', 'Ver Cardápio'));
    await send('3. Cidade Curitiba', interactive('cardapio_curitiba', 'Curitiba / PR'));
}

async function scenarioDeliveryCuritiba() {
    console.log('\n🚗 Cenário: Delivery Curitiba\n');
    const phone = '5500000000010';
    await send('1. Saudação', text('oi', phone));
    await send('2. Menu Delivery', interactive('menu_delivery', 'Delivery', phone));
    await send('3. Cidade Curitiba', interactive('delivery_curitiba', 'Curitiba / PR', phone));
    await send('4. Novo Pedido', interactive('delivery_novo', 'Novo Pedido', phone));
}

async function scenarioDeliveryLondrina() {
    console.log('\n🚗 Cenário: Delivery Londrina\n');
    const phone = '5500000000011';
    await send('1. Saudação', text('oi', phone));
    await send('2. Menu Delivery', interactive('menu_delivery', 'Delivery', phone));
    await send('3. Cidade Londrina', interactive('delivery_londrina', 'Londrina / PR', phone));
    await send('4. Ajuda', interactive('delivery_ajuda', 'Preciso Ajuda', phone));
}

async function scenarioDeliveryFreeText() {
    console.log('\n💬 Cenário: Delivery por Texto Livre\n');
    const phone = '5500000000012';
    await send('1. "delivery de londrina"', text('delivery de londrina', phone));
    await send('2. "quero pedir no ifood cwb"', text('quero pedir no ifood', phone), 3000);
}

async function scenarioReservaBasic() {
    console.log('\n📅 Cenário: Início de Reserva\n');
    const phone = '5500000000020';
    await send('1. Saudação', text('oi', phone));
    await send('2. Menu Reserva', interactive('menu_reserva', 'Reservar Mesa', phone));
    await send('3. Unidade Batel', interactive('unidade_batel', 'Batel', phone));
    // Stops here — full reservation would need phone confirm + data + AI
}

async function scenarioQueryReservation() {
    console.log('\n🔍 Cenário: Consulta de Reservas\n');
    const phone = '5500000000030';
    await send('1. "tenho reservas?"', text('tenho reservas?', phone), 5000);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('═══════════════════════════════════════════════════════');
    console.log('  🧪 Kharina Bot E2E Staging Tests');
    console.log(`  📡 Target: ${STAGING_URL}`);
    console.log(`  📱 Test Phone: ${TEST_PHONE}`);
    console.log('═══════════════════════════════════════════════════════');

    try {
        const health = await axios.get(`${STAGING_URL}/health`, { timeout: 5000 });
        const data = health.data as any;
        console.log(`\n✅ Server: MCP Cardápio=${data.mcp?.cardapio}, Reservas=${data.mcp?.reservas}\n`);
    } catch {
        console.error('\n❌ Staging server unreachable!\n');
        process.exit(1);
    }

    await scenarioCardapio();
    await scenarioDeliveryCuritiba();
    await scenarioDeliveryLondrina();
    await scenarioDeliveryFreeText();
    await scenarioReservaBasic();
    await scenarioQueryReservation();

    // ─── Summary ─────────────────────────────────────────────────────────────
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  📊 RESULTS');
    console.log('═══════════════════════════════════════════════════════\n');

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const errors = results.filter(r => r.status === 'ERROR').length;
    const avgTime = Math.round(results.reduce((a, r) => a + r.time, 0) / results.length);

    for (const r of results) {
        const icon = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '💥';
        console.log(`  ${icon} ${r.name} (${r.time}ms)${r.detail ? ` — ${r.detail}` : ''}`);
    }

    console.log(`\n  Total: ${results.length} | ✅ ${passed} | ❌ ${failed} | 💥 ${errors} | ⏱️ Avg: ${avgTime}ms`);
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('⚠️  Verifique as respostas no WhatsApp do número de teste ou nos logs da VPS:');
    console.log('   ssh root@72.60.137.167 "docker logs kharina-bot_backend... --tail 100"\n');

    process.exit(failed + errors > 0 ? 1 : 0);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
