
import { db } from './src/services/db';
import * as dotenv from 'dotenv';
dotenv.config();

// Override for local execution
process.env.DATABASE_URL = process.env.DATABASE_URL?.replace('host.docker.internal', 'localhost');

async function run() {
    const configs = await db.listConfigs();
    console.log('--- SYSTEM CONFIGURATIONS ---');
    console.table(configs);
    process.exit(0);
}

run();
