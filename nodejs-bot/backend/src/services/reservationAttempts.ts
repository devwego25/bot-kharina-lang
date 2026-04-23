import { db } from './db';

export type ReservationAttemptStatus =
  | 'creating'
  | 'manual_review'
  | 'confirmed_bot'
  | 'confirmed_recovered'
  | 'confirmed_manual'
  | 'failed';

export type ReservationAttemptInput = {
  phone: string;
  storeId: string;
  storeName: string;
  customerName?: string;
  dateText: string;
  timeText: string;
  adults: number;
  kids: number;
  totalPeople: number;
  notes?: string;
};

export type ReservationAttemptRecord = {
  id: number;
  phone: string;
  store_id: string;
  store_name: string;
  customer_name?: string | null;
  date_text: string;
  time_text: string;
  adults: number;
  kids: number;
  total_people: number;
  notes?: string | null;
  status: ReservationAttemptStatus;
  resolution_source?: string | null;
  reservation_id?: string | null;
  reservation_code?: string | null;
  last_error?: string | null;
  manual_review_notified_at?: string | null;
  created_at: string;
  updated_at: string;
  resolved_at?: string | null;
};

function normalizePhone(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

export async function beginReservationAttempt(input: ReservationAttemptInput): Promise<number> {
  const phone = normalizePhone(input.phone);
  const existing = await db.query(
    `SELECT id
       FROM reservation_attempts
      WHERE phone = $1
        AND store_id = $2::varchar
        AND date_text = $3::varchar
        AND time_text = $4::varchar
        AND total_people = $5::integer
        AND status IN ('creating', 'manual_review')
      ORDER BY updated_at DESC
      LIMIT 1`,
    [phone, input.storeId, input.dateText, input.timeText, input.totalPeople]
  );

  if (existing.rows[0]?.id) {
    const id = Number(existing.rows[0].id);
    await db.query(
      `UPDATE reservation_attempts
          SET store_name = $2::varchar,
              customer_name = $3::varchar,
              adults = $4::integer,
              kids = $5::integer,
              total_people = $6::integer,
              notes = $7::text,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1`,
      [id, input.storeName, input.customerName || null, input.adults, input.kids, input.totalPeople, input.notes || null]
    );
    return id;
  }

  const inserted = await db.query(
    `INSERT INTO reservation_attempts (
        phone, store_id, store_name, customer_name, date_text, time_text,
        adults, kids, total_people, notes, status
      ) VALUES (
        $1::varchar, $2::varchar, $3::varchar, $4::varchar, $5::varchar, $6::varchar,
        $7::integer, $8::integer, $9::integer, $10::text, 'creating'
      )
      RETURNING id`,
    [
      phone,
      input.storeId,
      input.storeName,
      input.customerName || null,
      input.dateText,
      input.timeText,
      input.adults,
      input.kids,
      input.totalPeople,
      input.notes || null
    ]
  );

  return Number(inserted.rows[0].id);
}

export async function updateReservationAttemptStatus(
  attemptId: number | undefined,
  status: ReservationAttemptStatus,
  extras?: {
    resolutionSource?: string;
    reservationId?: string;
    reservationCode?: string;
    lastError?: string;
  }
): Promise<void> {
  if (!attemptId) return;
  await db.query(
    `UPDATE reservation_attempts
        SET status = $2::varchar,
            resolution_source = COALESCE($3::varchar, resolution_source),
            reservation_id = COALESCE($4::varchar, reservation_id),
            reservation_code = COALESCE($5::varchar, reservation_code),
            last_error = COALESCE($6::text, last_error),
            updated_at = CURRENT_TIMESTAMP,
            resolved_at = CASE
              WHEN $2::varchar IN ('confirmed_bot', 'confirmed_recovered', 'confirmed_manual', 'failed')
                THEN CURRENT_TIMESTAMP
              ELSE resolved_at
            END
      WHERE id = $1`,
    [
      attemptId,
      status,
      extras?.resolutionSource || null,
      extras?.reservationId || null,
      extras?.reservationCode || null,
      extras?.lastError || null
    ]
  );
}

export async function markLatestAttemptManualConfirmed(phoneRaw: string, extras?: { reservationCode?: string }): Promise<ReservationAttemptRecord | null> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return null;
  const result = await db.query(
    `UPDATE reservation_attempts
        SET status = 'confirmed_manual',
            resolution_source = 'chatwoot_manual',
            reservation_code = COALESCE($2::varchar, reservation_code),
            updated_at = CURRENT_TIMESTAMP,
            resolved_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT id
          FROM reservation_attempts
         WHERE phone = $1
           AND status IN ('creating', 'manual_review')
         ORDER BY updated_at DESC
         LIMIT 1
      )
      RETURNING *`,
    [phone, extras?.reservationCode || null]
  );
  return (result.rows[0] as ReservationAttemptRecord) || null;
}

export async function listPendingReservationAttempts(limit = 50): Promise<ReservationAttemptRecord[]> {
  const result = await db.query(
    `SELECT *
       FROM reservation_attempts
      WHERE status IN ('creating', 'manual_review')
      ORDER BY updated_at ASC
      LIMIT $1`,
    [limit]
  );
  return result.rows as ReservationAttemptRecord[];
}

export async function markManualReviewNotified(attemptId: number | undefined): Promise<void> {
  if (!attemptId) return;
  await db.query(
    `UPDATE reservation_attempts
        SET manual_review_notified_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      WHERE id = $1`,
    [attemptId]
  );
}
