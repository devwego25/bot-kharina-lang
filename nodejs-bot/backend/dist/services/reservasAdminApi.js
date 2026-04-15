"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.reservasAdminApiService = void 0;
const axios_1 = __importDefault(require("axios"));
const socks_proxy_agent_1 = require("socks-proxy-agent");
const env_1 = require("../config/env");
class ReservasAdminApiService {
    http;
    accessToken = '';
    expiresAt = 0;
    loginPromise = null;
    constructor() {
        const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
        const httpsAgent = proxyUrl ? new socks_proxy_agent_1.SocksProxyAgent(proxyUrl) : undefined;
        this.http = axios_1.default.create({
            baseURL: env_1.config.reservasApi.url,
            timeout: 15000,
            httpsAgent,
            proxy: false,
        });
    }
    isConfigured() {
        return !!(env_1.config.reservasApi.url && env_1.config.reservasApi.adminEmail && env_1.config.reservasApi.adminPassword);
    }
    async login() {
        if (this.loginPromise)
            return this.loginPromise;
        this.loginPromise = (async () => {
            if (!this.isConfigured())
                throw new Error('missing_reservas_admin_config');
            const response = await this.http.post('/auth/login', {
                email: env_1.config.reservasApi.adminEmail,
                password: env_1.config.reservasApi.adminPassword,
            });
            const token = String(response.data?.accessToken || '').trim();
            const expiresIn = Number(response.data?.expiresIn || 0);
            if (!token || !expiresIn)
                throw new Error('invalid_reservas_admin_login');
            this.accessToken = token;
            this.expiresAt = Date.now() + Math.max(1, expiresIn - 300) * 1000;
            return token;
        })();
        try {
            return await this.loginPromise;
        }
        finally {
            this.loginPromise = null;
        }
    }
    async getToken(forceRefresh = false) {
        if (!forceRefresh && this.accessToken && Date.now() < this.expiresAt) {
            return this.accessToken;
        }
        return this.login();
    }
    async request(method, path, params, retry = true) {
        const token = await this.getToken(!retry);
        try {
            const response = await this.http.request({
                method,
                url: path,
                params,
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });
            return response.data;
        }
        catch (err) {
            const status = Number(err?.response?.status || 0);
            if (retry && status === 401) {
                this.accessToken = '';
                this.expiresAt = 0;
                return this.request(method, path, params, false);
            }
            throw err;
        }
    }
    async getReservationStats(storeId) {
        return this.request('GET', '/admin/reservations/stats', storeId ? { storeId } : undefined);
    }
    async listReservations(input) {
        return this.request('GET', '/admin/reservations', input);
    }
    async searchReservations(search, input) {
        return this.request('GET', '/admin/reservations', {
            search,
            ...(input || {})
        });
    }
    async getReservationById(reservationId) {
        return this.request('GET', `/admin/reservations/${reservationId}`);
    }
}
exports.reservasAdminApiService = new ReservasAdminApiService();
