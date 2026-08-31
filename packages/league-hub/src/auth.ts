import { timingSafeEqual } from 'node:crypto';
import {
  canonicalJson,
  HMAC_HEADER_NAMES,
  signRequest,
} from '@hydro-league-sync/protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ResolvedHubOptions } from './config.js';
import type { HubDatabase } from './database.js';
import type { AuthenticatedPrincipal } from './types.js';

export const AUTH_HEADERS = HMAC_HEADER_NAMES;
export { canonicalJson };

function signatureBody(body: unknown): string {
  if (body === undefined || body === null) return '';
  return canonicalJson(body);
}

export function createRequestSignature(input: {
  method: string;
  path: string;
  siteId: string;
  timestamp: string;
  nonce: string;
  body: unknown;
  secret: string;
}): string {
  const rawBody = typeof input.body === 'string' || Buffer.isBuffer(input.body)
    ? input.body
    : signatureBody(input.body);
  return signRequest({
    method: input.method,
    path: input.path,
    siteId: input.siteId,
    timestamp: input.timestamp,
    nonce: input.nonce,
    body: rawBody,
    secret: input.secret,
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearerToken(request: FastifyRequest): string | undefined {
  const authorization = header(request, 'authorization');
  const match = authorization?.match(/^Bearer[ \t]+(.+)$/i);
  return match?.[1];
}

function basicCredentials(request: FastifyRequest): { username: string; password: string } | undefined {
  const authorization = header(request, 'authorization');
  const match = authorization?.match(/^Basic[ \t]+([A-Za-z0-9+/]+={0,2})$/i);
  if (!match) return undefined;
  const encoded = match[1]!;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    if (Buffer.from(decoded, 'utf8').toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
      return undefined;
    }
    const separator = decoded.indexOf(':');
    if (separator < 0) return undefined;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return undefined;
  }
}

function isContestApiRequest(request: FastifyRequest): boolean {
  const path = request.url.split('?', 1)[0] ?? request.url;
  return path === '/api' || path === '/api/' || path.startsWith('/api/contests/')
    || path === '/api/contests';
}

async function authFailure(
  reply: FastifyReply,
  status: number,
  error: string,
  message: string,
  contestApi: boolean,
): Promise<void> {
  await reply.code(status).send(contestApi ? { code: status, message } : { error });
}

export function createAuthenticator(database: HubDatabase, options: ResolvedHubOptions) {
  async function authenticateSite(
    request: FastifyRequest,
    reply: FastifyReply,
    contestApi = false,
  ): Promise<AuthenticatedPrincipal | null> {
    const siteId = header(request, AUTH_HEADERS.siteId);
    const timestamp = header(request, AUTH_HEADERS.timestamp);
    const nonce = header(request, AUTH_HEADERS.nonce);
    const suppliedSignature = header(request, AUTH_HEADERS.signature);
    if (!siteId || !timestamp || !nonce || !suppliedSignature) {
      await authFailure(reply, 401, 'missing_hmac_headers', 'Authentication credentials are required', contestApi);
      return null;
    }
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      await authFailure(reply, 401, 'invalid_nonce', 'The HMAC nonce is invalid', contestApi);
      return null;
    }
    if (!/^\d{1,16}$/.test(timestamp) || !/^v1=[a-f0-9]{64}$/.test(suppliedSignature)) {
      await authFailure(reply, 401, 'invalid_hmac_headers', 'The HMAC credentials are invalid', contestApi);
      return null;
    }
    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(options.now().getTime() / 1_000);
    const allowedSkewSeconds = Math.floor(options.authClockSkewMs / 1_000);
    if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > allowedSkewSeconds) {
      await authFailure(reply, 401, 'timestamp_outside_allowed_window', 'The HMAC timestamp is outside the allowed window', contestApi);
      return null;
    }
    const site = database.getSite(siteId);
    if (!site || !site.enabled || !site.secret) {
      await authFailure(reply, 401, 'unknown_or_disabled_site', 'The site credentials are not authorized', contestApi);
      return null;
    }
    const expected = createRequestSignature({
      method: request.method,
      path: request.raw.url ?? request.url,
      siteId,
      timestamp,
      nonce,
      body: (request as FastifyRequest & { rawBody?: string }).rawBody ?? request.body,
      secret: site.secret,
    });
    if (!safeEqual(suppliedSignature, expected)) {
      await authFailure(reply, 401, 'invalid_signature', 'The HMAC signature is invalid', contestApi);
      return null;
    }
    const consumed = database.consumeNonce(siteId, nonce, timestampSeconds, nowSeconds - allowedSkewSeconds);
    if (!consumed) {
      await authFailure(reply, 409, 'replayed_nonce', 'The HMAC nonce has already been used', contestApi);
      return null;
    }
    return { kind: 'site', siteId };
  }

  async function authenticateAdmin(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedPrincipal | null> {
    if (!options.adminToken) {
      await reply.code(503).send({ error: 'admin_api_disabled' });
      return null;
    }
    const token = bearerToken(request);
    if (!token || !safeEqual(token, options.adminToken)) {
      await reply.code(401).send({ error: 'invalid_admin_token' });
      return null;
    }
    return { kind: 'admin' };
  }

  async function authenticateJury(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedPrincipal | null> {
    const contestApi = isContestApiRequest(request);
    const authorization = header(request, 'authorization');
    if (authorization !== undefined) {
      if (!options.adminToken) {
        await authFailure(reply, 503, 'jury_api_disabled', 'The jury API is disabled', contestApi);
        return null;
      }
      const bearer = bearerToken(request);
      const basic = basicCredentials(request);
      const bearerAccepted = bearer !== undefined && safeEqual(bearer, options.adminToken);
      const basicAccepted = basic !== undefined
        && safeEqual(basic.username, 'jury')
        && safeEqual(basic.password, options.adminToken);
      if (!bearerAccepted && !basicAccepted) {
        if (contestApi) reply.header('www-authenticate', 'Basic realm="Hydro League Hub Jury", charset="UTF-8"');
        await authFailure(reply, 401, 'invalid_jury_credentials', 'The jury credentials are invalid', contestApi);
        return null;
      }
      return { kind: 'admin' };
    }
    if (contestApi && !header(request, AUTH_HEADERS.siteId)) {
      reply.header('www-authenticate', 'Basic realm="Hydro League Hub Jury", charset="UTF-8"');
    }
    return authenticateSite(request, reply, contestApi);
  }

  return { authenticateSite, authenticateAdmin, authenticateJury };
}
