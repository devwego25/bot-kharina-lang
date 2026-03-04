import { db } from './src/services/db';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
  console.log('Attempting to initialize database...');
  try {
    await db.init();
    console.log('Database init called successfully.');
  } catch (err) {
    console.error('Init failed:', err);
  }
}
run();
