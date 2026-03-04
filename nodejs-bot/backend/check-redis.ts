import { redisService } from './src/services/redis';
import dotenv from 'dotenv';
dotenv.config();

async function testHistory() {
    console.log('--- CHECKING REDIS HISTORY ---');
    // Try to find any user histories
    // Since we don't know the userId exactly (it's the phone number), 
    // we can't easily guess it. But we can search for keys.
    const Redis = require('ioredis');
    const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

    try {
        const keys = await redis.keys('hist:*');
        console.log('Found history keys:', keys);

        for (const key of keys) {
            const history = await redis.get(key);
            console.log(`\nHistory for ${key}:`);
            console.log(history);
        }
    } catch (err) {
        console.error('Redis error:', err);
    } finally {
        redis.disconnect();
    }
    console.log('--- END TEST ---');
}

testHistory();
