"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.redisService = void 0;
const ioredis_1 = __importDefault(require("ioredis"));
const env_1 = require("../config/env");
const redis = new ioredis_1.default(env_1.config.redis.url);
redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err));
exports.redisService = {
    /**
     * Get conversation history for a user
     */
    getHistory: async (userId) => {
        try {
            const data = await redis.get(`hist:${userId}`);
            return data ? JSON.parse(data) : [];
        }
        catch (err) {
            console.error('[Redis] Error getting history:', err);
            return [];
        }
    },
    /**
     * Save conversation history with TTL
     */
    saveHistory: async (userId, history) => {
        try {
            await redis.set(`hist:${userId}`, JSON.stringify(history), 'EX', env_1.config.redis.ttl);
        }
        catch (err) {
            console.error('[Redis] Error saving history:', err);
        }
    },
    /**
     * Check if a message ID as already been processed (Deduplication)
     */
    isProcessed: async (msgId) => {
        try {
            const exists = await redis.exists(`msg:${msgId}`);
            return exists === 1;
        }
        catch (err) {
            console.error('[Redis] Error checking msgId:', err);
            return false;
        }
    },
    /**
     * Mark a message ID as processed with a 24h TTL
     */
    markProcessed: async (msgId) => {
        try {
            await redis.set(`msg:${msgId}`, '1', 'EX', 86400); // 24 hours
        }
        catch (err) {
            console.error('[Redis] Error marking msgId:', err);
        }
    },
    /**
     * Content-based dedup: blocks same text from same user within 10s.
     * Returns true if this is a duplicate (should be skipped).
     */
    isDuplicateContent: async (userId, text) => {
        try {
            // Create a simple hash from userId + text
            const key = `cdedup:${userId}:${text}`;
            const result = await redis.set(key, '1', 'EX', 10, 'NX');
            return result !== 'OK'; // If NX failed, it's a duplicate
        }
        catch (err) {
            console.error('[Redis] Error checking content dedup:', err);
            return false; // fail-open
        }
    }
};
