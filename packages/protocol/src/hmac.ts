import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import {
  HmacHeaderSchema,
  NonceSchema,
  OpaqueIdSchema,
  type HmacHeaders,
} from './schemas.js';

export const HMAC_SCHEME = 'HL-HMAC-SHA256' as const;
export const HMAC_SIGNATURE_VERSION = 'v1' as const;
export const HMAC_HEADER_NAMES = {
  siteId: 'x-hydro-league-site-id',
  timestamp: 'x-hydro-league-timestamp',
  nonce: 'x-hydro-league-nonce',
  signature: 'x-hydro-league-signature',
} as const;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type RequestBody = string | Uint8Array;
export type HmacSecret = string | Uint8Array;

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
        const keys = Object.keys(record).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key], ancestors)}`).join(',')}}`;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new TypeError(`canonicalJson does not support ${typeof value} values`);
  }
}

/** Stable JSON for producing request bodies. The receiver still verifies raw bytes. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set());
}

function bodyBytes(body: RequestBody): Uint8Array {
  return typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
}

export function sha256Hex(body: RequestBody): string {
  return createHash('sha256').update(bodyBytes(body)).digest('hex');
}

export interface RequestSignatureInput {
  method: string;
  path: string;
  siteId: string;
  timestamp: string | number;
  nonce: string;
  body: RequestBody;
  secret: HmacSecret;
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

export function canonicalRequest(input: Omit<RequestSignatureInput, 'secret'>): string {
  const method = input.method.toUpperCase();
  if (!/^[A-Z]+$/.test(method)) throw new TypeError('method must contain only ASCII letters');
  if (!input.path.startsWith('/') || /[\r\n]/.test(input.path)) {
    throw new TypeError('path must be a raw origin-form URL without CR/LF');
  }
  const siteId = OpaqueIdSchema.parse(input.siteId);
  const timestamp = normalizeTimestamp(input.timestamp);
  const nonce = NonceSchema.parse(input.nonce);
  return [
    HMAC_SCHEME,
    method,
    input.path,
    siteId,
    timestamp,
    nonce,
    sha256Hex(input.body),
  ].join('\n');
}

export function signRequest(input: RequestSignatureInput): string {
  const message = canonicalRequest(input);
  const digest = createHmac('sha256', secretBytes(input.secret)).update(message, 'utf8').digest('hex');
  return `${HMAC_SIGNATURE_VERSION}=${digest}`;
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
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? randomBytes(18).toString('base64url');
  return HmacHeaderSchema.parse({
    [HMAC_HEADER_NAMES.siteId]: input.siteId,
    [HMAC_HEADER_NAMES.timestamp]: String(timestamp),
    [HMAC_HEADER_NAMES.nonce]: nonce,
    [HMAC_HEADER_NAMES.signature]: signRequest({
      method: input.method,
      path: input.path,
      siteId: input.siteId,
      timestamp,
      nonce,
      body: input.body,
      secret: input.secret,
    }),
  });
}

export type RequestVerificationResult =
  | { ok: true; siteId: string; timestamp: number; nonce: string }
  | { ok: false; reason: 'invalid_headers' | 'timestamp_out_of_window' | 'invalid_signature' };

export interface VerifyRequestInput {
  method: string;
  path: string;
  body: RequestBody;
  secret: HmacSecret;
  headers: unknown;
  nowSeconds?: number;
  maxClockSkewSeconds?: number;
}

/**
 * Verifies syntax, clock window, and signature in constant time. Nonce replay
 * protection is intentionally left to the hub's durable nonce store.
 */
export function verifyRequest(input: VerifyRequestInput): RequestVerificationResult {
  const parsed = HmacHeaderSchema.safeParse(input.headers);
  if (!parsed.success) return { ok: false, reason: 'invalid_headers' };

  const headers = parsed.data;
  const timestamp = Number(headers[HMAC_HEADER_NAMES.timestamp]);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.maxClockSkewSeconds ?? 300;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(tolerance) || tolerance < 0) {
    throw new TypeError('nowSeconds and maxClockSkewSeconds must be non-negative safe integers');
  }
  if (Math.abs(now - timestamp) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }

  const expected = signRequest({
    method: input.method,
    path: input.path,
    siteId: headers[HMAC_HEADER_NAMES.siteId],
    timestamp: headers[HMAC_HEADER_NAMES.timestamp],
    nonce: headers[HMAC_HEADER_NAMES.nonce],
    body: input.body,
    secret: input.secret,
  });
  const actualBytes = Buffer.from(headers[HMAC_HEADER_NAMES.signature], 'ascii');
  const expectedBytes = Buffer.from(expected, 'ascii');
  if (actualBytes.byteLength !== expectedBytes.byteLength || !timingSafeEqual(actualBytes, expectedBytes)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return {
    ok: true,
    siteId: headers[HMAC_HEADER_NAMES.siteId],
    timestamp,
    nonce: headers[HMAC_HEADER_NAMES.nonce],
  };
}
