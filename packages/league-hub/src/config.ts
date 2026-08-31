import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface HubOptions {
  host?: string;
  port?: number;
  databasePath?: string;
  adminToken?: string;
  delayedAfterMs?: number;
  offlineAfterMs?: number;
  authClockSkewMs?: number;
  now?: () => Date;
}

export interface ResolvedHubOptions {
  host: string;
  port: number;
  databasePath: string;
  adminToken: string | undefined;
  delayedAfterMs: number;
  offlineAfterMs: number;
  authClockSkewMs: number;
  now: () => Date;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveHubOptions(options: HubOptions = {}): ResolvedHubOptions {
  const configuredDatabasePath = options.databasePath
    ?? process.env.HYDRO_LEAGUE_DATABASE
    ?? './data/league-hub.sqlite';
  const databasePath = configuredDatabasePath === ':memory:' ? ':memory:' : resolve(configuredDatabasePath);
  if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });

  const delayedAfterMs = options.delayedAfterMs
    ?? positiveInteger(process.env.HYDRO_LEAGUE_DELAYED_AFTER_MS, 45_000);
  const offlineAfterMs = options.offlineAfterMs
    ?? positiveInteger(process.env.HYDRO_LEAGUE_OFFLINE_AFTER_MS, 180_000);
  if (offlineAfterMs <= delayedAfterMs) {
    throw new Error('offlineAfterMs must be greater than delayedAfterMs');
  }
  const adminToken = options.adminToken ?? process.env.HYDRO_LEAGUE_ADMIN_TOKEN;
  if (adminToken !== undefined && Buffer.byteLength(adminToken, 'utf8') < 32) {
    throw new Error('adminToken must contain at least 32 UTF-8 bytes');
  }

  return {
    host: options.host ?? process.env.HYDRO_LEAGUE_HOST ?? '127.0.0.1',
    port: options.port ?? positiveInteger(process.env.HYDRO_LEAGUE_PORT, 3000),
    databasePath,
    adminToken,
    delayedAfterMs,
    offlineAfterMs,
    authClockSkewMs: options.authClockSkewMs
      ?? positiveInteger(process.env.HYDRO_LEAGUE_AUTH_CLOCK_SKEW_MS, 300_000),
    now: options.now ?? (() => new Date()),
  };
}
