import axios from 'axios';
import { config } from '../config/env';

type LoginResponse = {
  accessToken: string;
  expiresIn: number;
};

export type ReservationStatsResponse = {
  totalReservations: number;
  todayReservations: number;
  upcomingReservations: number;
  pendingReservations: number;
  confirmedReservations: number;
  cancelledReservations: number;
  completedReservations: number;
};

export type ReservationListItem = {
  id: string;
  customerName: string;
  customerPhone?: string | null;
  date: string;
  time: string;
  guests: number;
  kids?: number | null;
  status: string;
  notes?: string | null;
};

export type ReservationListResponse = {
  data: ReservationListItem[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
};

class ReservasAdminApiService {
  private readonly http;
  private accessToken = '';
  private expiresAt = 0;
  private loginPromise: Promise<string> | null = null;

  constructor() {
    this.http = axios.create({
      baseURL: config.reservasApi.url,
      timeout: 15000,
    });
  }

  isConfigured(): boolean {
    return !!(config.reservasApi.url && config.reservasApi.adminEmail && config.reservasApi.adminPassword);
  }

  private async login(): Promise<string> {
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = (async () => {
      if (!this.isConfigured()) throw new Error('missing_reservas_admin_config');
      const response = await this.http.post<LoginResponse>('/auth/login', {
        email: config.reservasApi.adminEmail,
        password: config.reservasApi.adminPassword,
      });
      const token = String(response.data?.accessToken || '').trim();
      const expiresIn = Number(response.data?.expiresIn || 0);
      if (!token || !expiresIn) throw new Error('invalid_reservas_admin_login');
      this.accessToken = token;
      this.expiresAt = Date.now() + Math.max(1, expiresIn - 300) * 1000;
      return token;
    })();

    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  private async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.accessToken && Date.now() < this.expiresAt) {
      return this.accessToken;
    }
    return this.login();
  }

  private async request<T>(method: 'GET' | 'POST', path: string, params?: Record<string, any>, retry = true): Promise<T> {
    const token = await this.getToken(!retry);
    try {
      const response = await this.http.request<T>({
        method,
        url: path,
        params,
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      return response.data;
    } catch (err: any) {
      const status = Number(err?.response?.status || 0);
      if (retry && status === 401) {
        this.accessToken = '';
        this.expiresAt = 0;
        return this.request<T>(method, path, params, false);
      }
      throw err;
    }
  }

  async getReservationStats(storeId: string): Promise<ReservationStatsResponse> {
    return this.request<ReservationStatsResponse>('GET', '/admin/reservations/stats', { storeId });
  }

  async listReservations(input: {
    storeId: string;
    startDate?: string;
    endDate?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<ReservationListResponse> {
    return this.request<ReservationListResponse>('GET', '/admin/reservations', input);
  }
}

export const reservasAdminApiService = new ReservasAdminApiService();
