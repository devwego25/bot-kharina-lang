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
    getUserState: async (userId) => {
        try {
            const data = await redis.get(`state:${userId}`);
            return data ? JSON.parse(data) : null;
        }
        catch (err) {
            console.error('[Redis] Error getting user state:', err);
            return null;
        }
    },
    saveUserState: async (userId, state) => {
        try {
            await redis.set(`state:${userId}`, JSON.stringify(state), 'EX', env_1.config.redis.ttl);
        }
        catch (err) {
            console.error('[Redis] Error saving user state:', err);
        }
    },
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
     * Content-based dedup: blocks accidental duplicates in a short window.
     * Returns true if this is a duplicate (should be skipped).
     */
    isDuplicateContent: async (userId, text) => {
        try {
            if (!text || text.trim().length === 0)
                return false;
            const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
            // Don't dedupe very short messages; users often repeat "oi", "ok", etc.
            if (normalized.length <= 3)
                return false;
            // Create a hash from userId + normalized text
            const key = `cdedup:${userId}:${normalized}`;
            // Try to set with NX (only if not exists) and 5s TTL
            const result = await redis.set(key, '1', 'EX', 5, 'NX');
            // If result is null, key already existed (duplicate)
            return result !== 'OK';
        }
        catch (err) {
            console.error('[Redis] Error checking content dedup:', err);
            return false; // fail-open
        }
    },
    /**
     * Clear all data for a user (useful for testing)
     */
    clearUser: async (userId) => {
        try {
            const patterns = [`hist:${userId}`, `state:${userId}`, `cdedup:${userId}:*`];
            const keys = new Set();
            for (const pattern of patterns) {
                const matched = await redis.keys(pattern);
                matched.forEach((key) => keys.add(key));
            }
            if (keys.size > 0) {
                await redis.del(...Array.from(keys));
            }
        }
        catch (err) {
            console.error('[Redis] Error clearing user:', err);
        }
    }
};
