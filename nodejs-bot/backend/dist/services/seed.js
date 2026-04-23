"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.seedConfigs = seedConfigs;
const db_1 = require("./db");
const initialConfigs = [
    { key: 'link_delivery_curitiba', value: 'https://www.ifood.com.br/delivery/curitiba-pr/kharina-agua-verde/9cda85cb-fa38-47a1-9831-818dfe5991e9?UTM_Medium=share' },
    { key: 'link_delivery_londrina', value: 'https://www.ifood.com.br/delivery/londrina-pr/kharina-londrina-centro/4c717d38-1310-49a8-8a9b-429389078b33?UTM_Medium=share' },
    { key: 'link_cardapio_curitiba', value: 'https://cardapio.kharina.com.br/curitiba' },
    { key: 'link_cardapio_londrina', value: 'https://cardapio.kharina.com.br/londrina' },
    { key: 'link_cardapio_saopaulo', value: 'https://cardapio.kharina.com.br/saopaulo' },
    { key: 'link_cardapio_sp', value: 'https://cardapio.kharina.com.br/saopaulo' },
    { key: 'uuid_botanico', value: 'a99c098f-c16b-4168-a5b1-54e76aa1a855' },
    { key: 'uuid_cabral', value: 'c6919b3c-f5ff-4006-a226-2b493d9d8cf5' },
    { key: 'uuid_agua_verde', value: 'fde9ba37-baff-4958-b6be-5ced7059864c' },
    { key: 'uuid_batel', value: 'b45c9b5e-4f79-47b1-a442-ea8fb9d6e977' },
    { key: 'uuid_portao', value: 'f0f6ae17-01d1-4c51-a423-33222f8fcd5c' },
    { key: 'uuid_londrina', value: '3e027375-3049-4080-98c3-9f7448b8fd62' },
    { key: 'uuid_saopaulo', value: '03dc5466-6c32-4e9e-b92f-c8b02e74bba6' },
    { key: 'phone_botanico', value: '(41) 3092-0449' },
    { key: 'phone_cabral', value: '(41) 3352-8661' },
    { key: 'phone_agua_verde', value: '(41) 3082-5439' },
    { key: 'phone_batel', value: '(41) 3203-4940' },
    { key: 'phone_portao', value: '(41) 3083-7600' },
    { key: 'phone_londrina', value: '(43) 3398-9191' },
    { key: 'phone_saopaulo', value: '(11) 5432-0052' },
    { key: 'delivery_help_phone_curitiba_cabral_group', value: '(41) 99288-6397' },
    { key: 'delivery_help_phone_curitiba_agua_verde_group', value: '(41) 98811-6685' },
    { key: 'delivery_help_phone_londrina', value: '(41) 99265-3755' },
    { key: 'kids_instagram_botanico', value: 'https://www.instagram.com/p/DPGpsgXEVAD/' },
    { key: 'kids_instagram_cabral', value: 'https://www.instagram.com/reels/DSkzcjYEZjd/' },
    { key: 'kids_instagram_portao', value: 'https://www.instagram.com/reels/CvtCLhksEso/' },
    { key: 'kids_instagram_londrina', value: 'https://www.instagram.com/reels/C4jJFDbxqml/' },
    { key: 'max_reservation_people', value: '30' },
    {
        key: 'kids_info_content',
        value: `Aqui estão os horários e valores do nosso Espaço Kids — os pequenos AMAM brincar por aqui! 😄

1️⃣ *Kharina Cabral — R$ 23,00*
* Segunda a Quinta: 18h às 22h
* Sexta: 18h às 23h
* Sábado: 12h às 23h
* Domingo: 12h30 às 21h30

2️⃣ *Kharina Batel — R$ 23,00*
* Segunda a Quinta: 18h às 22h
* Sexta: 18h às 23h
* Sábado: 12h às 23h
* Domingo: 12h30 às 21h30

3️⃣ *Kharina Água Verde — R$ 10,00*
* Sexta: 18h às 22h
* Sábado: 12h às 22h
* Domingo: 12h30 às 21h30

4️⃣ *Kharina Botânico — R$ 23,00*
* Segunda a Quinta: 18h às 22h
* Sexta: 18h às 23h
* Sábado: 12h às 23h
* Domingo: 12h às 22h

5️⃣ *Kharina Portão — R$ 23,00*
* Segunda a Quinta: 18h às 22h
* Sexta: 18h às 23h
* Sábado: 12h às 23h
* Domingo: 12h às 22h

6️⃣ *Kharina Londrina (Higienópolis) — R$ 15,00*
* Segunda a Quinta: 18h às 22h
* Sexta: 18h às 23h
* Sábado: 12h às 23h
* Domingo: 12h às 22h`
    }
];
async function seedConfigs() {
    console.log('[Seed] Seeding initial configurations...');
    for (const config of initialConfigs) {
        if (config.key === 'kids_info_content') {
            // Force update for content to ensure formatting fixes are applied
            await db_1.db.upsertConfig(config.key, config.value);
            console.log(`[Seed] Force updated ${config.key}`);
            continue;
        }
        // Only insert if doesn't exist to avoid overwriting user changes for others
        const existing = await db_1.db.getConfig(config.key);
        if (!existing) {
            await db_1.db.upsertConfig(config.key, config.value);
            console.log(`[Seed] Added default for ${config.key}`);
        }
    }
    console.log('[Seed] Seeding complete.');
}
