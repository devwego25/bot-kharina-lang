"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminAuth = void 0;
const env_1 = require("../config/env");
/**
 * Middleware to authenticate requests to Admin API using x-api-key header.
 */
const adminAuth = (req, res, next) => {
    const apiKeyHeader = req.headers['x-api-key'] || req.query.api_key;
    // Check multiple potential env vars for compatibility
    const validKey = process.env.ADMIN_API_KEY ||
        process.env.AUTH_TOKEN ||
        process.env.API_KEY ||
        env_1.config.whatsapp.verifyToken;
    if (apiKeyHeader && apiKeyHeader === validKey) {
        return next();
    }
    console.warn(`[Admin Auth] Unauthorized access attempt from ${req.ip}. Header: ${req.headers['x-api-key'] ? 'PRESENT' : 'MISSING'}`);
    res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid API key in x-api-key header'
    });
};
exports.adminAuth = adminAuth;
