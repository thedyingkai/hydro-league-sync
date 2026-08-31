import {
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import type {
  BatchAck,
  BatchEnvelope,
  CanonicalStatus,
  SnapshotEnvelope,
  SubmissionEvent,
} from './types.js';

export const PROTOCOL_VERSION = '1.0' as const;

export const HMAC_SCHEME = 'HL-HMAC-SHA256' as const;
export const HMAC_SIGNATURE_VERSION = 'v1' as const;
export const HMAC_HEADER_NAMES = {
  siteId: 'x-hydro-league-site-id',
  timestamp: 'x-hydro-league-timestamp',
  nonce: 'x-hydro-league-nonce',
  signature: 'x-hydro-league-signature',
} as const;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const CANONICAL_STATUSES: ReadonlySet<string> = new Set<CanonicalStatus>([
  'PENDING',
  'JUDGING',
  'ACCEPTED',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'OUTPUT_LIMIT_EXCEEDED',
  'RUNTIME_ERROR',
  'COMPILE_ERROR',
  'SYSTEM_ERROR',
  'FORMAT_ERROR',
  'IGNORED',
  'CANCELED',
]);

const EVENT_KEYS = new Set([
  'protocol_version',
  'event_type',
  'league_id',
  'site_id',
  'source_seq',
  'domain_id',
  'contest_id',
  'rid',
  'uid',
  'pid',
  'global_team_id',
  'global_problem_id',
  'status',
  'score',
  'lang',
  'submitted_at',
  'judged_at',
  'rejudged',
  'emitted_at',
]);

const BATCH_KEYS = new Set([
  'protocol_version',
  'batch_id',
  'league_id',
  'site_id',
  'sent_at',
  'events',
]);

const SNAPSHOT_KEYS = new Set([
  'protocol_version',
  'snapshot_id',
  'league_id',
  'site_id',
  'generated_at',
  'chunk_index',
  'complete',
  'events',
]);

const ACK_KEYS = new Set([
  'protocol_version',
  'batch_id',
  'league_id',
  'site_id',
  'accepted_count',
  'duplicate_count',
  'rejected',
  'high_watermark',
  'received_at',
]);

const REJECTION_KEYS = new Set([
  'source_seq',
  'rid',
  'code',
  'message',
  'retryable',
]);

type RequestBody = string | Uint8Array;
type HmacSecret = string | Uint8Array;

export type HmacHeaders = {
  'x-hydro-league-site-id': string;
  'x-hydro-league-timestamp': string;
  'x-hydro-league-nonce': string;
  'x-hydro-league-signature': string;
};

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson does not support non-finite numbers');
      return JSON.stringify(Object.is(value, -0) ? 0 : value);
    case 'object': {
      if (ancestors.has(value)) throw new TypeError('canonicalJson does not support cyclic values');
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          const parts: string[] = [];
          for (let index = 0; index < value.length; index += 1) {
            if (!Object.hasOwn(value, index)) {
              throw new TypeError('canonicalJson does not support sparse arrays');
            }
            parts.push(canonicalize(value[index], ancestors));
          }
          return `[${parts.join(',')}]`;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError('canonicalJson accepts only plain objects');
        }
        if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
          throw new TypeError('canonicalJson does not support symbol keys');
        }
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`)
          .join(',')}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new TypeError(`canonicalJson does not support ${typeof value} values`);
  }
}

/** Stable JSON used both as the transmitted request body and HMAC input. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set());
}

function bodyBytes(body: RequestBody): Uint8Array {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
}

function sha256Hex(body: RequestBody): string {
  return createHash('sha256').update(bodyBytes(body)).digest('hex');
}

function opaqueId(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !ID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a valid opaque ID`);
  }
  return value;
}

function isoDateTime(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ISO_DATE_TIME_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO 8601 date-time with an offset`);
  }
  return value;
}

function safeInteger(value: unknown, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function finiteNumber(value: unknown, name: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${name} must be a finite number greater than or equal to ${minimum}`);
  }
  return value;
}

function strictRecord(value: unknown, allowed: ReadonlySet<string>, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !allowed.has(key));
  if (extra.length) throw new TypeError(`${name} contains unknown field: ${extra[0]}`);
  return record;
}

function uuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value;
}

function normalizeTimestamp(timestamp: string | number): string {
  const text = String(timestamp);
  if (!/^\d{1,16}$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new TypeError('timestamp must be a safe integer number of Unix seconds');
  }
  return text;
}

function secretBytes(secret: HmacSecret): Uint8Array {
  const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  if (bytes.byteLength === 0) throw new TypeError('HMAC secret must not be empty');
  return bytes;
}

export interface CreateSignedHeadersInput {
  method: string;
  path: string;
  siteId: string;
  body: RequestBody;
  secret: HmacSecret;
  timestamp?: number;
  nonce?: string;
}

export function createSignedHeaders(input: CreateSignedHeadersInput): HmacHeaders {
  const method = input.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new TypeError('method must contain only ASCII letters');
  if (!input.path.startsWith('/') || /[\r\n]/.test(input.path)) {
    throw new TypeError('path must be a raw origin-form URL without CR/LF');
  }
  const siteId = opaqueId(input.siteId, 'siteId');
  const timestamp = normalizeTimestamp(input.timestamp ?? Math.floor(Date.now() / 1_000));
  const nonce = input.nonce ?? randomBytes(18).toString('base64url');
  if (!NONCE_PATTERN.test(nonce)) throw new TypeError('nonce must be a base64url string of 16 to 128 characters');
  const canonicalRequest = [
    HMAC_SCHEME,
    method,
    input.path,
    siteId,
    timestamp,
    nonce,
    sha256Hex(input.body),
  ].join('\n');
  const digest = createHmac('sha256', secretBytes(input.secret))
    .update(canonicalRequest, 'utf8')
    .digest('hex');
  return {
    [HMAC_HEADER_NAMES.siteId]: siteId,
    [HMAC_HEADER_NAMES.timestamp]: timestamp,
    [HMAC_HEADER_NAMES.nonce]: nonce,
    [HMAC_HEADER_NAMES.signature]: `${HMAC_SIGNATURE_VERSION}=${digest}`,
  };
}

export function validateSubmissionEvent(value: unknown): SubmissionEvent {
  const event = strictRecord(value, EVENT_KEYS, 'submission event');
  if (event.protocol_version !== PROTOCOL_VERSION) throw new TypeError('Unsupported protocol_version');
  if (event.event_type !== 'submission.upsert') throw new TypeError('Unsupported event_type');
  opaqueId(event.league_id, 'league_id');
  opaqueId(event.site_id, 'site_id');
  safeInteger(event.source_seq, 'source_seq', 1);
  opaqueId(event.domain_id, 'domain_id');
  opaqueId(event.contest_id, 'contest_id');
  opaqueId(event.rid, 'rid');
  safeInteger(event.uid, 'uid', 0);
  safeInteger(event.pid, 'pid', 1);
  if (event.global_team_id !== undefined) opaqueId(event.global_team_id, 'global_team_id');
  if (event.global_problem_id !== undefined) opaqueId(event.global_problem_id, 'global_problem_id');
  if (typeof event.status !== 'string' || !CANONICAL_STATUSES.has(event.status)) {
    throw new TypeError('status must be a canonical protocol status');
  }
  if (event.score !== undefined) finiteNumber(event.score, 'score', 0);
  if (event.lang !== undefined) {
    if (typeof event.lang !== 'string' || event.lang !== event.lang.trim() || event.lang.length > 64) {
      throw new TypeError('lang must be a trimmed string no longer than 64 characters');
    }
  }
  isoDateTime(event.submitted_at, 'submitted_at');
  if (event.judged_at !== undefined) isoDateTime(event.judged_at, 'judged_at');
  if (typeof event.rejudged !== 'boolean') throw new TypeError('rejudged must be a boolean');
  isoDateTime(event.emitted_at, 'emitted_at');
  return event as unknown as SubmissionEvent;
}

export function validateEventBatchEnvelope(value: unknown): BatchEnvelope {
  const batch = strictRecord(value, BATCH_KEYS, 'event batch envelope');
  if (batch.protocol_version !== PROTOCOL_VERSION) throw new TypeError('Unsupported protocol_version');
  uuid(batch.batch_id, 'batch_id');
  const leagueId = opaqueId(batch.league_id, 'league_id');
  const siteId = opaqueId(batch.site_id, 'site_id');
  isoDateTime(batch.sent_at, 'sent_at');
  if (!Array.isArray(batch.events) || batch.events.length < 1 || batch.events.length > 1_000) {
    throw new TypeError('events must contain between 1 and 1000 entries');
  }
  batch.events.forEach((input, index) => {
    const event = validateSubmissionEvent(input);
    if (event.league_id !== leagueId) throw new TypeError(`events[${index}].league_id does not match envelope`);
    if (event.site_id !== siteId) throw new TypeError(`events[${index}].site_id does not match envelope`);
  });
  return batch as unknown as BatchEnvelope;
}

export function validateSnapshotEnvelope(value: unknown): SnapshotEnvelope {
  const snapshot = strictRecord(value, SNAPSHOT_KEYS, 'snapshot envelope');
  if (snapshot.protocol_version !== PROTOCOL_VERSION) throw new TypeError('Unsupported protocol_version');
  uuid(snapshot.snapshot_id, 'snapshot_id');
  const leagueId = opaqueId(snapshot.league_id, 'league_id');
  const siteId = opaqueId(snapshot.site_id, 'site_id');
  isoDateTime(snapshot.generated_at, 'generated_at');
  safeInteger(snapshot.chunk_index, 'chunk_index', 0);
  if (typeof snapshot.complete !== 'boolean') throw new TypeError('complete must be a boolean');
  if (!Array.isArray(snapshot.events) || snapshot.events.length > 1_000) {
    throw new TypeError('events must contain at most 1000 entries');
  }
  snapshot.events.forEach((input, index) => {
    const event = validateSubmissionEvent(input);
    if (event.league_id !== leagueId) throw new TypeError(`events[${index}].league_id does not match snapshot`);
    if (event.site_id !== siteId) throw new TypeError(`events[${index}].site_id does not match snapshot`);
  });
  return snapshot as unknown as SnapshotEnvelope;
}

export function parseEventBatchAck(value: unknown): BatchAck {
  const ack = strictRecord(value, ACK_KEYS, 'event batch ACK');
  if (ack.protocol_version !== PROTOCOL_VERSION) throw new TypeError('Unsupported protocol_version');
  uuid(ack.batch_id, 'batch_id');
  opaqueId(ack.league_id, 'league_id');
  opaqueId(ack.site_id, 'site_id');
  safeInteger(ack.accepted_count, 'accepted_count', 0);
  safeInteger(ack.duplicate_count, 'duplicate_count', 0);
  const highWatermark = safeInteger(ack.high_watermark, 'high_watermark', 0);
  isoDateTime(ack.received_at, 'received_at');
  if (!Array.isArray(ack.rejected)) throw new TypeError('rejected must be an array');
  ack.rejected.forEach((input, index) => {
    const rejection = strictRecord(input, REJECTION_KEYS, `rejected[${index}]`);
    const sourceSeq = safeInteger(rejection.source_seq, `rejected[${index}].source_seq`, 1);
    opaqueId(rejection.rid, `rejected[${index}].rid`);
    for (const [field, maximum] of [['code', 64], ['message', 500]] as const) {
      const text = rejection[field];
      if (typeof text !== 'string' || text !== text.trim() || text.length < 1 || text.length > maximum) {
        throw new TypeError(`rejected[${index}].${field} must be a non-empty trimmed string`);
      }
    }
    if (typeof rejection.retryable !== 'boolean') {
      throw new TypeError(`rejected[${index}].retryable must be a boolean`);
    }
    if (rejection.retryable && sourceSeq <= highWatermark) {
      throw new TypeError('high_watermark must not cross a retryable rejection');
    }
  });
  return ack as unknown as BatchAck;
}
