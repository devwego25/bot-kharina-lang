import { Pool } from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const legacyIds = {
  "Jardim Botânico": "a99c098f-c16b-4168-a5b1-54e76aa1a855",
  "Cabral": "c6919b3c-f5ff-4006-a226-2b493d9d8cf5",
  "Água Verde": "fde9ba37-baff-4958-b6be-5ced7059864c",
  "Batel": "b45c9b5e-4f79-47b1-a442-ea8fb9d6e977",
  "Portão": "f0f6ae17-01d1-4c51-a423-33222f8fcd5c",
  "Higienópolis (Londrina)": "3e027375-3049-4080-98c3-9f7448b8fd62",
  "Shopping Parque da Cidade (SP)": "03dc5466-6c32-4e9e-b92f-c8b02e74bba6"
};

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function compare() {
  console.log("Starting UUID Consistency Audit...");
  console.log("--------------------------------------------------");
  
  try {
    const res = await pool.query("SELECT key, value FROM system_config WHERE key LIKE 'mcp_cardapio_uuid_%'");
    const currentConfigs = res.rows.reduce((acc, row) => {
      acc[row.key] = row.value;
      return acc;
    }, {} as Record<string, string>);

    console.log("Current system_config (MCP Cardapio UUIDs):");
    console.log(JSON.stringify(currentConfigs, null, 2));
    console.log("--------------------------------------------------");

    const mapping = [
      { key: 'mcp_cardapio_uuid_curitiba', legacyKey: 'Água Verde', label: 'Curitiba (Generic/Main)' },
      { key: 'mcp_cardapio_uuid_londrina', legacyKey: 'Higienópolis (Londrina)', label: 'Londrina' },
      { key: 'mcp_cardapio_uuid_sp', legacyKey: 'Shopping Parque da Cidade (SP)', label: 'São Paulo' }
    ];

    console.log("Comparing Mappings:");
    for (const item of mapping) {
      const current = currentConfigs[item.key];
      const legacy = legacyIds[item.legacyKey as keyof typeof legacyIds];
      const match = current === legacy ? "✅ MATCH" : "❌ DISCREPANCY";
      console.log(`${item.label}:`);
      console.log(`  Current: ${current}`);
      console.log(`  Legacy:  ${legacy}`);
      console.log(`  Status:  ${match}`);
    }

    console.log("--------------------------------------------------");
    console.log("Legacy Store IDs for Reservations (Reference):");
    console.log(JSON.stringify(legacyIds, null, 2));

  } catch (err) {
    console.error("Error during audit:", err);
  } finally {
    await pool.end();
  }
}

compare();
