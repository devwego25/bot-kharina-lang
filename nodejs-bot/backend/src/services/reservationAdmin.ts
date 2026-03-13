import { config } from '../config/env';
import { db } from './db';

export type AdminRole = 'master' | 'admin';
export type ReservationBlockMode = 'deny' | 'suggest_alternative' | 'handoff';

export interface AdminUser {
  phone: string;
  role: AdminRole;
  active: boolean;
  created_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface ReservationBlock {
  id: number;
  store_id: string;
  store_name: string;
  weekday: number | null;
  start_time: string;
  end_time: string;
  mode: ReservationBlockMode;
  message: string;
  active: boolean;
  created_by: string;
  updated_by?: string | null;
  created_at?: string;
  updated_at?: string;
}

type CreateReservationBlockInput = {
  storeId: string;
  storeName: string;
  weekday: number | null;
  startTime: string;
  endTime: string;
  mode: ReservationBlockMode;
  message: string;
  createdBy: string;
};

type ReservationBlockLookupInput = {
  storeId: string;
  date: string;
  time: string;
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export function normalizeAdminPhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55') && digits.length >= 12) return digits;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  return digits;
}

function parsePhoneList(raw: string): string[] {
  return unique(
    String(raw || '')
      .split(',')
      .map((value) => normalizeAdminPhone(value))
      .filter(Boolean)
  );
}

function normalizeTimeInput(raw: string): string | null {
  const match = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (Number.isNaN(hour) || Number.isNaN(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function isoDateToWeekday(date: string): number | null {
  const match = String(date || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.getDay();
}

let masterSyncPromise: Promise<void> | null = null;

async function getConfiguredMasterPhones(): Promise<string[]> {
  const dbConfig = await db.getConfig('admin_master_phones');
  return unique([
    ...config.admin.masterPhones.map((value) => normalizeAdminPhone(value)),
    ...parsePhoneList(dbConfig || '')
  ]).filter(Boolean);
}

export async function ensureConfiguredMasterAdmins(): Promise<void> {
  if (masterSyncPromise) {
    await masterSyncPromise;
    return;
  }

  masterSyncPromise = (async () => {
    const phones = await getConfiguredMasterPhones();
    for (const phone of phones) {
      await db.query(
        `
          INSERT INTO admin_users (phone, role, active, created_by, updated_at)
          VALUES ($1, 'master', TRUE, 'system', CURRENT_TIMESTAMP)
          ON CONFLICT (phone) DO UPDATE
          SET role = 'master', active = TRUE, updated_at = CURRENT_TIMESTAMP
        `,
        [phone]
      );
    }
  })();

  try {
    await masterSyncPromise;
  } finally {
    masterSyncPromise = null;
  }
}

export async function getAdminUser(phone: string): Promise<AdminUser | null> {
  await ensureConfiguredMasterAdmins();
  const normalized = normalizeAdminPhone(phone);
  if (!normalized) return null;

  const result = await db.query(
    `SELECT phone, role, active, created_by, created_at, updated_at
     FROM admin_users
     WHERE phone = $1 AND active = TRUE
     LIMIT 1`,
    [normalized]
  );
  return result.rows[0] || null;
}

export async function hasAnyAdminConfigured(): Promise<boolean> {
  await ensureConfiguredMasterAdmins();
  const result = await db.query(`SELECT COUNT(*)::int AS total FROM admin_users WHERE active = TRUE`);
  return Number(result.rows[0]?.total || 0) > 0;
}

export async function isAdminPhone(phone: string): Promise<boolean> {
  return !!(await getAdminUser(phone));
}

export async function isMasterAdminPhone(phone: string): Promise<boolean> {
  const admin = await getAdminUser(phone);
  return admin?.role === 'master';
}

export async function listAdminUsers(): Promise<AdminUser[]> {
  await ensureConfiguredMasterAdmins();
  const result = await db.query(
    `SELECT phone, role, active, created_by, created_at, updated_at
     FROM admin_users
     WHERE active = TRUE
     ORDER BY role DESC, created_at ASC`
  );
  return result.rows;
}

export async function addOrUpdateAdminUser(phone: string, role: AdminRole, actorPhone: string): Promise<AdminUser> {
  await ensureConfiguredMasterAdmins();
  const normalizedPhone = normalizeAdminPhone(phone);
  const normalizedActor = normalizeAdminPhone(actorPhone);
  if (!normalizedPhone) throw new Error('invalid_phone');

  const result = await db.query(
    `
      INSERT INTO admin_users (phone, role, active, created_by, updated_at)
      VALUES ($1, $2, TRUE, $3, CURRENT_TIMESTAMP)
      ON CONFLICT (phone) DO UPDATE
      SET role = EXCLUDED.role,
          active = TRUE,
          updated_at = CURRENT_TIMESTAMP
      RETURNING phone, role, active, created_by, created_at, updated_at
    `,
    [normalizedPhone, role, normalizedActor || 'system']
  );
  return result.rows[0];
}

export async function deactivateAdminUser(phone: string, actorPhone: string): Promise<void> {
  await ensureConfiguredMasterAdmins();
  const normalizedPhone = normalizeAdminPhone(phone);
  const normalizedActor = normalizeAdminPhone(actorPhone);
  if (!normalizedPhone) throw new Error('invalid_phone');
  if (normalizedPhone === normalizedActor) throw new Error('cannot_remove_self');

  const target = await getAdminUser(normalizedPhone);
  if (!target) throw new Error('admin_not_found');

  if (target.role === 'master') {
    const result = await db.query(`SELECT COUNT(*)::int AS total FROM admin_users WHERE active = TRUE AND role = 'master'`);
    if (Number(result.rows[0]?.total || 0) <= 1) {
      throw new Error('cannot_remove_last_master');
    }
  }

  await db.query(
    `UPDATE admin_users
     SET active = FALSE, updated_at = CURRENT_TIMESTAMP
     WHERE phone = $1`,
    [normalizedPhone]
  );
}

export async function createReservationBlock(input: CreateReservationBlockInput): Promise<ReservationBlock> {
  const startTime = normalizeTimeInput(input.startTime);
  const endTime = normalizeTimeInput(input.endTime);
  if (!startTime || !endTime || startTime >= endTime) throw new Error('invalid_time_range');

  const result = await db.query(
    `
      INSERT INTO reservation_blocks (
        store_id,
        store_name,
        weekday,
        start_time,
        end_time,
        mode,
        message,
        active,
        created_by,
        updated_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
      RETURNING *
    `,
    [
      input.storeId,
      input.storeName,
      input.weekday,
      startTime,
      endTime,
      input.mode,
      input.message,
      normalizeAdminPhone(input.createdBy) || 'system'
    ]
  );
  return result.rows[0];
}

export async function listReservationBlocks(activeOnly = true, limit = 50): Promise<ReservationBlock[]> {
  const params: any[] = [];
  const where = activeOnly ? 'WHERE active = TRUE' : '';
  params.push(limit);
  const result = await db.query(
    `
      SELECT *
      FROM reservation_blocks
      ${where}
      ORDER BY active DESC, created_at DESC
      LIMIT $1
    `,
    params
  );
  return result.rows;
}

export async function getReservationBlock(id: number): Promise<ReservationBlock | null> {
  const result = await db.query(`SELECT * FROM reservation_blocks WHERE id = $1 LIMIT 1`, [id]);
  return result.rows[0] || null;
}

export async function deactivateReservationBlock(id: number, actorPhone: string): Promise<void> {
  await db.query(
    `
      UPDATE reservation_blocks
      SET active = FALSE,
          updated_by = $2,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
    `,
    [id, normalizeAdminPhone(actorPhone) || 'system']
  );
}

export async function findMatchingReservationBlock(input: ReservationBlockLookupInput): Promise<ReservationBlock | null> {
  const weekday = isoDateToWeekday(input.date);
  const normalizedTime = normalizeTimeInput(input.time);
  if (!input.storeId || weekday === null || !normalizedTime) return null;

  const result = await db.query(
    `
      SELECT *
      FROM reservation_blocks
      WHERE active = TRUE
        AND store_id = $1
        AND (weekday = $2 OR weekday IS NULL)
        AND start_time <= $3
        AND end_time > $3
      ORDER BY CASE WHEN weekday IS NULL THEN 1 ELSE 0 END, start_time DESC
      LIMIT 1
    `,
    [input.storeId, weekday, normalizedTime]
  );
  return result.rows[0] || null;
}

export function weekdayLabel(weekday: number | null): string {
  const labels: Record<string, string> = {
    '0': 'Domingo',
    '1': 'Segunda',
    '2': 'Terça',
    '3': 'Quarta',
    '4': 'Quinta',
    '5': 'Sexta',
    '6': 'Sábado'
  };
  if (weekday === null || weekday === undefined) return 'Todos os dias';
  return labels[String(weekday)] || 'Dia inválido';
}

export function blockModeLabel(mode: ReservationBlockMode): string {
  if (mode === 'suggest_alternative') return 'Sugerir outro horário';
  if (mode === 'handoff') return 'Encaminhar equipe';
  return 'Bloquear';
}

export function buildDefaultBlockMessage(block: Pick<ReservationBlock, 'store_name' | 'weekday' | 'start_time' | 'end_time' | 'mode'>): string {
  const dayPart = weekdayLabel(block.weekday);
  const range = `${block.start_time} às ${block.end_time}`;

  if (block.mode === 'suggest_alternative') {
    return `Nesse período a unidade ${block.store_name} não está aceitando reservas automáticas (${dayPart}, ${range}). Posso te ajudar com outro horário ou outra unidade.`;
  }

  if (block.mode === 'handoff') {
    return `Nesse período a unidade ${block.store_name} está com atendimento especial (${dayPart}, ${range}). Vou te orientar a falar com a nossa equipe para validar a reserva.`;
  }

  return `Nesse período a unidade ${block.store_name} não está aceitando reservas automáticas (${dayPart}, ${range}).`;
}

export function describeReservationBlock(block: Pick<ReservationBlock, 'id' | 'store_name' | 'weekday' | 'start_time' | 'end_time' | 'mode' | 'active'>): string {
  return `#${block.id} | ${block.store_name} | ${weekdayLabel(block.weekday)} | ${block.start_time}-${block.end_time} | ${blockModeLabel(block.mode)}${block.active ? '' : ' | inativo'}`;
}
