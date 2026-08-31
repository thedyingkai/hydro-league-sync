import Schema from 'schemastery';
import type { AgentConfig, BoardView, ContestBindingConfig } from './types.js';

export const DEFAULT_CENTER_URL = 'http://127.0.0.1:3000';

export const Config = Schema.object({
  enabled: Schema.boolean().default(false).description('Enable league synchronization'),
  centerUrl: Schema.string().default(DEFAULT_CENTER_URL).description('League hub base URL').role('url'),
  allowInsecureHttp: Schema.boolean().default(false).description('Allow plain HTTP for non-loopback hubs'),
  leagueId: Schema.string().default('').description('Global league ID'),
  siteId: Schema.string().default('').description('School site ID'),
  sharedSecret: Schema.string().default('').description('Site HMAC secret (at least 32 UTF-8 bytes)').role('password'),
  // Hydro beta.9 resolves addon schemas twice. Its second pass receives a
  // settings Proxy that rejects Array.prototype's constructor lookup.
  contests: Schema.any().default([]).description('Hydro contest bindings array'),
  batchSize: Schema.number().step(1).min(1).max(500).default(100).description('Maximum events per upload'),
  flushIntervalMs: Schema.number().step(100).min(500).default(2000).description('Outbox flush interval'),
  heartbeatIntervalMs: Schema.number().step(1000).min(5000).default(15000).description('Heartbeat interval'),
  reconciliationIntervalMs: Schema.number().step(1000).min(30000).default(300000).description('Full reconciliation interval'),
  requestTimeoutMs: Schema.number().step(100).min(1000).default(10000).description('Hub request timeout'),
  retryBaseMs: Schema.number().step(100).min(500).default(1000).description('Initial retry delay'),
  retryMaxMs: Schema.number().step(1000).min(5000).default(300000).description('Maximum retry delay'),
  leaseMs: Schema.number().step(1000).min(5000).default(30000).description('Outbox delivery lease'),
  cacheTtlMs: Schema.number().step(100).min(0).default(3000).description('Remote board cache TTL'),
  cacheMaxStaleMs: Schema.number().step(1000).min(0).default(300000).description('Maximum stale board age'),
  sourceUrl: Schema.string().default('/hydro-league-agent-source.zip').description('AGPL corresponding source URL'),
}).description('Hydro League Agent');

export type RawAgentConfig = Partial<AgentConfig>;

export const DEFAULT_CONFIG: AgentConfig = {
  enabled: false,
  centerUrl: DEFAULT_CENTER_URL,
  allowInsecureHttp: false,
  leagueId: '',
  siteId: '',
  sharedSecret: '',
  contests: [],
  batchSize: 100,
  flushIntervalMs: 2_000,
  heartbeatIntervalMs: 15_000,
  reconciliationIntervalMs: 300_000,
  requestTimeoutMs: 10_000,
  retryBaseMs: 1_000,
  retryMaxMs: 300_000,
  leaseMs: 30_000,
  cacheTtlMs: 3_000,
  cacheMaxStaleMs: 300_000,
  sourceUrl: '/hydro-league-agent-source.zip',
};

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized.startsWith('127.');
}

function validateBinding(binding: ContestBindingConfig, index: number): ContestBindingConfig {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new Error(`contests[${index}] must be an object`);
  }
  const domainId = String(binding.domainId ?? '').trim();
  const contestId = String(binding.contestId ?? '').trim();
  if (!domainId) throw new Error(`contests[${index}].domainId is required`);
  if (!/^[a-f\d]{24}$/i.test(contestId)) {
    throw new Error(`contests[${index}].contestId must be a 24-character Hydro ObjectId`);
  }
  return {
    domainId,
    contestId: contestId.toLowerCase(),
    ...(binding.teamMapping ? { teamMapping: { ...binding.teamMapping } } : {}),
    ...(binding.problemMapping ? { problemMapping: { ...binding.problemMapping } } : {}),
  };
}

function normalizeBindings(input: unknown): ContestBindingConfig[] {
  if (!Array.isArray(input)) throw new Error('contests must be an array');
  const bindings: ContestBindingConfig[] = [];
  // Do not call Array.prototype methods here. Hydro beta.9 passes this value
  // through a settings Proxy whose constructor property is deliberately blocked.
  for (let index = 0; index < input.length; index += 1) {
    bindings.push(validateBinding(input[index] as ContestBindingConfig, index));
  }
  return bindings;
}

export function normalizeConfig(raw: RawAgentConfig = {}): AgentConfig {
  const merged: AgentConfig = {
    ...DEFAULT_CONFIG,
    ...raw,
    contests: normalizeBindings(raw.contests ?? DEFAULT_CONFIG.contests),
  };
  const center = new URL(merged.centerUrl);
  if (!['http:', 'https:'].includes(center.protocol)) {
    throw new Error('centerUrl must use http or https');
  }
  if (center.username || center.password) {
    throw new Error('centerUrl must not contain credentials');
  }
  if (center.pathname !== '/' && center.pathname !== '') {
    throw new Error('centerUrl must be an origin without a path prefix');
  }
  if (center.protocol === 'http:' && !isLoopback(center.hostname) && !merged.allowInsecureHttp) {
    throw new Error('Plain HTTP is allowed only for loopback hubs unless allowInsecureHttp is enabled');
  }
  center.pathname = '';
  center.search = '';
  center.hash = '';
  merged.centerUrl = center.toString().replace(/\/$/, '');

  if (merged.enabled) {
    if (!merged.leagueId.trim()) throw new Error('leagueId is required when synchronization is enabled');
    if (!merged.siteId.trim()) throw new Error('siteId is required when synchronization is enabled');
    if (Buffer.byteLength(merged.sharedSecret, 'utf8') < 32) {
      throw new Error('sharedSecret must contain at least 32 UTF-8 bytes when synchronization is enabled');
    }
    if (!merged.contests.length) throw new Error('At least one contest binding is required when synchronization is enabled');
  }
  if (merged.retryBaseMs > merged.retryMaxMs) {
    throw new Error('retryBaseMs must not exceed retryMaxMs');
  }
  return merged;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

export const hubPaths = {
  eventBatch: (siteId: string) => `/api/v1/sites/${encodeSegment(siteId)}/events:batch`,
  heartbeat: (siteId: string) => `/api/v1/sites/${encodeSegment(siteId)}/heartbeat`,
  snapshot: (siteId: string) => `/api/v1/sites/${encodeSegment(siteId)}/snapshot`,
  scoreboard: (leagueId: string, view: BoardView) => (
    `/api/v1/leagues/${encodeSegment(leagueId)}/scoreboard?view=${view}`
  ),
  xcpcio: (leagueId: string, view: BoardView) => (
    `/api/v1/leagues/${encodeSegment(leagueId)}/xcpcio.json?view=${view}`
  ),
  submissions: (leagueId: string, cursor: string, view: BoardView) => {
    const query = new URLSearchParams({ cursor, view });
    return `/api/v1/leagues/${encodeSegment(leagueId)}/submissions?${query.toString()}`;
  },
  siteStatus: (leagueId: string) => `/api/v1/leagues/${encodeSegment(leagueId)}/sites/status`,
  cdp: (leagueId: string) => `/api/v1/leagues/${encodeSegment(leagueId)}/cdp.zip`,
};

export function findBinding(
  config: Pick<AgentConfig, 'contests'>,
  domainId: string,
  contestId: string,
): ContestBindingConfig | undefined {
  const normalizedContestId = contestId.toLowerCase();
  return config.contests.find((binding) => (
    binding.domainId === domainId && binding.contestId === normalizedContestId
  ));
}
