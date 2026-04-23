import { chatwootService } from './chatwoot';
import { reservasAdminApiService } from './reservasAdminApi';
import {
  listPendingReservationAttempts,
  markManualReviewNotified,
  type ReservationAttemptRecord,
  type ReservationAttemptStatus,
  updateReservationAttemptStatus
} from './reservationAttempts';

const MANUAL_REVIEW_ESCALATION_MS = 10 * 60 * 1000;

function normalizePhone(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

function phonesLookEquivalent(a: string, b: string): boolean {
  const da = normalizePhone(a);
  const db = normalizePhone(b);
  if (!da || !db) return false;
  const aa = da.startsWith('55') ? da.slice(2) : da;
  const bb = db.startsWith('55') ? db.slice(2) : db;
  return aa === bb || aa.endsWith(bb) || bb.endsWith(aa);
}

function normalizeDate(value: string): string {
  const v = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return v;
}

function normalizeTime(value: string): string {
  const v = String(value || '').trim();
  const m = v.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
  if (!m) return v;
  return `${m[1].padStart(2, '0')}:${(m[2] || '00').padStart(2, '0')}`;
}

function displayReservationCode(input: { id?: string | null; code?: string | null }): string | undefined {
  const code = String(input.code || '').trim();
  if (code) return code.toUpperCase();
  const id = String(input.id || '').trim();
  if (id) return id.split('-')[0].toUpperCase();
  return undefined;
}

function isBaseAttemptMatch(item: any, attempt: ReservationAttemptRecord): boolean {
  const itemDate = normalizeDate(String(item?.date || ''));
  const itemTime = normalizeTime(String(item?.time || ''));
  const itemStoreId = String(item?.storeId || item?.store?.id || '').toLowerCase();
  const itemStatus = String(item?.status || '').toLowerCase();
  const itemPhone = String(item?.customerPhone || item?.clientPhone || item?.phone || '');

  return (
    itemDate === attempt.date_text &&
    itemTime === normalizeTime(attempt.time_text) &&
    itemStoreId === String(attempt.store_id || '').toLowerCase() &&
    !itemStatus.includes('cancel') &&
    phonesLookEquivalent(itemPhone, attempt.phone)
  );
}

function isExactAttemptPeopleMatch(item: any, attempt: ReservationAttemptRecord): boolean {
  const guests = Number(item?.guests ?? item?.numberOfPeople ?? item?.people ?? 0);
  const kids = Number(item?.kids ?? 0);
  const possibleTotals = new Set<number>([guests, guests + kids]);
  return possibleTotals.has(Number(attempt.total_people || 0));
}

function isLikelyRecentAttemptMatch(item: any, attempt: ReservationAttemptRecord): boolean {
  const normalizedNotes = String(item?.notes || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const mentionsExpectedParty =
    normalizedNotes.includes(`total ${attempt.total_people}`) ||
    normalizedNotes.includes(`${attempt.total_people} pessoas`) ||
    normalizedNotes.includes(`${attempt.total_people} pessoa`);

  const createdAt = Date.parse(String(item?.createdAt || item?.updatedAt || ''));
  const isRecent = Number.isFinite(createdAt) && Math.abs(Date.now() - createdAt) <= 30 * 60 * 1000;

  return mentionsExpectedParty || isRecent;
}

function parseTimestamp(value?: string | null): number | null {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldEscalateManualReview(attempt: ReservationAttemptRecord): boolean {
  if (attempt.status !== 'manual_review') return false;
  if (attempt.manual_review_notified_at) return false;
  const referenceTime = parseTimestamp(attempt.updated_at) ?? parseTimestamp(attempt.created_at);
  if (!referenceTime) return false;
  return Date.now() - referenceTime >= MANUAL_REVIEW_ESCALATION_MS;
}

async function escalateManualReviewAttempt(attempt: ReservationAttemptRecord): Promise<void> {
  await chatwootService.updateConversation(attempt.phone, {
    status: 'open',
    custom_attributes: {
      reservation_verification_needed: true,
      reservation_verification_status: 'manual_review_pending_human',
      reservation_attempt_id: attempt.id,
      reservation_store_name: attempt.store_name,
      reservation_date: attempt.date_text,
      reservation_time: attempt.time_text,
      reservation_id: attempt.reservation_id || null,
      reservation_code: attempt.reservation_code || null,
      reservation_resolution_source: attempt.resolution_source || null,
      reservation_last_error: attempt.last_error || null
    }
  });

  await chatwootService.syncMessage(
    attempt.phone,
    attempt.customer_name || attempt.phone,
    [
      'REVISAO MANUAL DE RESERVA',
      `Tentativa: ${attempt.id}`,
      `Unidade: ${attempt.store_name}`,
      `Data/Hora: ${attempt.date_text} ${attempt.time_text}`,
      `Status atual: ${attempt.status}`,
      attempt.last_error ? `Ultimo erro: ${attempt.last_error}` : '',
      'A reserva ainda nao foi localizada automaticamente no sistema.',
      'Necessaria acao humana para validar e retornar ao cliente.'
    ].filter(Boolean).join('\n'),
    'outgoing',
    { source: 'system', kind: 'reservation_manual_review_escalation' },
    true
  );

  await markManualReviewNotified(attempt.id);
}

export async function syncReservationVerificationState(
  phoneRaw: string,
  input: {
    attemptId?: number;
    status: ReservationAttemptStatus | 'pending';
    storeName?: string;
    dateText?: string;
    timeText?: string;
    reservationId?: string;
    reservationCode?: string;
    resolutionSource?: string;
    lastError?: string;
  }
): Promise<void> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) return;

  const needsVerification = input.status === 'creating' || input.status === 'manual_review' || input.status === 'pending';
  await chatwootService.updateConversation(phone, {
    custom_attributes: {
      reservation_verification_needed: needsVerification,
      reservation_verification_status: input.status,
      reservation_attempt_id: input.attemptId || null,
      reservation_store_name: input.storeName || null,
      reservation_date: input.dateText || null,
      reservation_time: input.timeText || null,
      reservation_id: input.reservationId || null,
      reservation_code: input.reservationCode || null,
      reservation_resolution_source: input.resolutionSource || null,
      reservation_last_error: input.lastError || null
    }
  });
}

async function findAttemptMatch(attempt: ReservationAttemptRecord): Promise<{ id: string; code?: string; status?: string } | null> {
  if (!reservasAdminApiService.isConfigured()) return null;

  const byStore = await reservasAdminApiService.listReservations({
    storeId: attempt.store_id,
    startDate: attempt.date_text,
    endDate: attempt.date_text,
    page: 1,
    limit: 100
  });

  const baseMatches = (byStore.data || []).filter((item) => isBaseAttemptMatch(item, attempt));
  const exact = baseMatches.find((item) => isExactAttemptPeopleMatch(item, attempt));
  const matched = exact || (baseMatches.length === 1 && isLikelyRecentAttemptMatch(baseMatches[0], attempt) ? baseMatches[0] : null);
  if (!matched?.id) return null;

  return {
    id: String(matched.id),
    code: displayReservationCode({ id: matched.id }),
    status: String(matched.status || '')
  };
}

let reconciliationRunning = false;

export async function reconcilePendingReservationAttempts(): Promise<void> {
  if (reconciliationRunning) return;
  reconciliationRunning = true;

  try {
    const attempts = await listPendingReservationAttempts(50);
    for (const attempt of attempts) {
      try {
        const matched = await findAttemptMatch(attempt);
        if (!matched?.id) {
          if (shouldEscalateManualReview(attempt)) {
            await escalateManualReviewAttempt(attempt);
          }
          continue;
        }

        await updateReservationAttemptStatus(attempt.id, 'confirmed_recovered', {
          resolutionSource: 'background_reconcile',
          reservationId: matched.id,
          reservationCode: matched.code
        });

        await syncReservationVerificationState(attempt.phone, {
          attemptId: attempt.id,
          status: 'confirmed_recovered',
          storeName: attempt.store_name,
          dateText: attempt.date_text,
          timeText: attempt.time_text,
          reservationId: matched.id,
          reservationCode: matched.code,
          resolutionSource: 'background_reconcile'
        });

        await chatwootService.syncMessage(
          attempt.phone,
          attempt.customer_name || attempt.phone,
          [
            'RECONCILIACAO DE RESERVA',
            `Tentativa: ${attempt.id}`,
            `Unidade: ${attempt.store_name}`,
            `Data/Hora: ${attempt.date_text} ${attempt.time_text}`,
            `Status final: confirmed_recovered`,
            matched.code ? `Código: ${matched.code}` : '',
            matched.id ? `ID: ${matched.id}` : '',
            'A reserva foi localizada automaticamente após a tentativa inicial.'
          ].filter(Boolean).join('\n'),
          'outgoing',
          { source: 'system', kind: 'reservation_reconciliation' },
          true
        );
      } catch (err: any) {
        console.error('[ReservationReconciliation] failed for attempt', attempt.id, err?.message || err);
      }
    }
  } finally {
    reconciliationRunning = false;
  }
}
