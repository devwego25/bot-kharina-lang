import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from '../config/env';

type WebhookStore = {
  id: string;
  name: string;
  phone?: string;
  address?: string;
  isActive?: boolean;
  operationHours?: Record<string, { open?: string; close?: string; isOpen?: boolean }>;
};

type AvailabilityResponse = {
  available: boolean;
  storeId: string;
  date: string;
  time: string;
  numberOfPeople: number;
  maxCapacity?: number;
  currentOccupancy?: number;
  availableCapacity?: number;
  message?: string;
};

class ReservasWebhookApiService {
  private readonly http;

  constructor() {
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
    const httpsAgent = proxyUrl ? new SocksProxyAgent(proxyUrl) : undefined;
    this.http = axios.create({
      baseURL: config.reservasWebhook.url,
      timeout: 15000,
      httpsAgent,
      proxy: false,
      headers: {
        'X-Webhook-Key': config.reservasWebhook.key
      }
    } as any);
  }

  isConfigured(): boolean {
    return !!(config.reservasWebhook.url && config.reservasWebhook.key);
  }

  async listStores(): Promise<WebhookStore[]> {
    if (!this.isConfigured()) return [];
    const response = await this.http.get<{ success: boolean; data?: WebhookStore[] }>('/stores');
    return Array.isArray(response.data?.data) ? response.data.data : [];
  }

  async checkAvailability(input: {
    storeId: string;
    date: string;
    time: string;
    numberOfPeople: number;
  }): Promise<AvailabilityResponse | null> {
    if (!this.isConfigured()) return null;
    const response = await this.http.post<{ success: boolean; data?: AvailabilityResponse }>('/reservation/availability', input);
    return response.data?.data || null;
  }
}

export const reservasWebhookApiService = new ReservasWebhookApiService();
