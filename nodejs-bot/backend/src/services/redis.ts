import Redis from 'ioredis';
import { config } from '../config/env';

const redis = new Redis(config.redis.url!);

redis.on('connect', () => console.log('[Redis] Connected'));
redis.on('error', (err) => console.error('[Redis] Error:', err));

export const redisService = {
  /**
   * Get conversation history for a user
   */
  getHistory: async (userId: string): Promise<any[]> => {
    try {
      const data = await redis.get(`hist:${userId}`);
      return data ? JSON.parse(data) : [];
    } catch (err) {
      console.error('[Redis] Error getting history:', err);
      return [];
    }
  },

  /**
   * Save conversation history with TTL
   */
  saveHistory: async (userId: string, history: any[]) => {
    try {
      await redis.set(
        `hist:${userId}`,
        JSON.stringify(history),
        'EX',
        config.redis.ttl
      );
    } catch (err) {
      console.error('[Redis] Error saving history:', err);
    }
  },

  /**
   * Check if a message ID as already been processed (Deduplication)
   */
  isProcessed: async (msgId: string): Promise<boolean> => {
    try {
      const exists = await redis.exists(`msg:${msgId}`);
      return exists === 1;
    } catch (err) {
      console.error('[Redis] Error checking msgId:', err);
      return false;
    }
  },

  /**
   * Mark a message ID as processed with a 24h TTL
   */
  markProcessed: async (msgId: string) => {
    try {
      await redis.set(`msg:${msgId}`, '1', 'EX', 86400); // 24 hours
    } catch (err) {
      console.error('[Redis] Error marking msgId:', err);
    }
  },

  /**
   * Content-based dedup: blocks same text from same user within 30s.
   * Returns true if this is a duplicate (should be skipped).
   */
  isDuplicateContent: async (userId: string, text: string): Promise<boolean> => {
    try {
      if (!text || text.trim().length === 0) return false;
      
      // Create a hash from userId + normalized text
      const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
      const key = `cdedup:${userId}:${normalized}`;
      
      // Try to set with NX (only if not exists) and 30s TTL
      const result = await redis.set(key, '1', 'EX', 30, 'NX');
      
      // If result is null, key already existed (duplicate)
      return result !== 'OK';
    } catch (err) {
      console.error('[Redis] Error checking content dedup:', err);
      return false; // fail-open
    }
  },

  /**
   * Clear all data for a user (useful for testing)
   */
  clearUser: async (userId: string) => {
    try {
      const keys = await redis.keys(`*:${userId}*`);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (err) {
      console.error('[Redis] Error clearing user:', err);
    }
  }
};
