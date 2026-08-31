import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import {
  EventBatchEnvelopeSchema,
  SubmissionEventSchema,
  XcpcioAllInOneSchema,
  type ScoreboardView,
  type XcpcioAllInOne,
} from '@hydro-league-sync/protocol';
import { createAuthenticator } from './auth.js';
import { resolveHubOptions, type HubOptions, type ResolvedHubOptions } from './config.js';
import {
  BatchIdConflictError,
  ContestIdImmutableError,
  HubDatabase,
  type StoredEvent,
} from './database.js';
import { buildCdpZip, buildContestApiResources, buildEventFeed, contestApiResourceId } from './icpc.js';
import { buildScoreboard } from './scoreboard.js';
import { buildCorrespondingSourceZip } from './source.js';
import type { EventBatch, HubConfiguration, IngestEvent } from './types.js';
import { buildXcpcio } from './xcpcio.js';

export interface HubApplication {
  app: FastifyInstance;
  database: HubDatabase;
  options: ResolvedHubOptions;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function validDate(value: unknown, field: string): string {
  const text = requiredString(value, field);
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/,
  );
  if (!match) throw new Error(`${field} must be an ISO 8601 date-time with a timezone`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offsetHourText, offsetMinuteText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText, monthText, dayText, hourText, minuteText, secondText,
  ].map(Number);
  const wallClock = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  const validWallClock = wallClock.getUTCFullYear() === year
    && wallClock.getUTCMonth() === month! - 1
    && wallClock.getUTCDate() === day
    && wallClock.getUTCHours() === hour
    && wallClock.getUTCMinutes() === minute
    && wallClock.getUTCSeconds() === second;
  const validOffset = offsetHourText === undefined
    || (Number(offsetHourText) <= 23 && Number(offsetMinuteText) <= 59);
  if (!validWallClock || !validOffset || !Number.isFinite(Date.parse(text))) {
    throw new Error(`${field} must be a valid ISO 8601 date-time with a timezone`);
  }
  return text;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function shortString(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (result.length > 128) throw new Error(`${field} must contain at most 128 characters`);
  return result;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function normalizeConfigurationBody(body: unknown): unknown {
  if (!object(body) || object(body.contest)) return body;
  const league = object(body.league) ? body.league : object(body.config) ? body.config : null;
  if (!league) return body;
  const teams = Array.isArray(body.teams) ? body.teams : [];
  const problems = Array.isArray(body.problems) ? body.problems : [];
  const teamMappings = Array.isArray(body.team_mappings) ? body.team_mappings : [];
  const problemMappings = Array.isArray(body.problem_mappings) ? body.problem_mappings : [];
  return {
    contest: {
      contest_id: league.league_id,
      name: league.title,
      start_time: league.starts_at,
      end_time: league.ends_at,
      freeze_time: league.freeze_at,
      unfreeze_at: league.unfreeze_at,
      penalty_minutes: Number(league.penalty_seconds ?? 1_200) / 60,
    },
    sites: body.sites,
    teams: teams.map((item) => object(item) ? {
      team_id: item.global_team_id,
      name: item.name,
      school_id: item.organization_id,
      school_name: item.organization_name,
      official: item.is_official,
      hidden: false,
    } : item),
    problems: problems.map((item) => object(item) ? {
      problem_id: item.global_problem_id,
      label: item.label,
      name: item.name,
      ordinal: item.ordinal,
      color: item.color,
      rgb: item.rgb,
    } : item),
    team_mappings: teamMappings.map((item) => object(item) ? {
      league_id: item.league_id,
      site_id: item.site_id,
      domain_id: item.domain_id,
      contest_id: item.contest_id,
      local_uid: String(item.uid ?? ''),
      team_id: item.global_team_id,
    } : item),
    problem_mappings: problemMappings.map((item) => object(item) ? {
      league_id: item.league_id,
      site_id: item.site_id,
      domain_id: item.domain_id,
      contest_id: item.contest_id,
      local_pid: String(item.pid ?? ''),
      problem_id: item.global_problem_id,
    } : item),
  };
}

function validateConfiguration(body: unknown): HubConfiguration {
  if (!object(body) || !object(body.contest)) throw new Error('contest is required');
  for (const list of ['sites', 'teams', 'problems', 'team_mappings', 'problem_mappings']) {
    if (!Array.isArray(body[list])) throw new Error(`${list} must be an array`);
  }
  const contest = body.contest;
  const parsed: HubConfiguration = {
    contest: {
      contest_id: requiredString(contest.contest_id, 'contest.contest_id'),
      name: requiredString(contest.name, 'contest.name'),
      start_time: validDate(contest.start_time, 'contest.start_time'),
      end_time: validDate(contest.end_time, 'contest.end_time'),
      freeze_time: contest.freeze_time === null || contest.freeze_time === undefined
        ? null
        : validDate(contest.freeze_time, 'contest.freeze_time'),
      unfreeze_at: contest.unfreeze_at === null || contest.unfreeze_at === undefined
        ? null
        : validDate(contest.unfreeze_at, 'contest.unfreeze_at'),
      penalty_minutes: contest.penalty_minutes === undefined
        ? 20
        : nonNegativeInteger(contest.penalty_minutes, 'contest.penalty_minutes'),
    },
    sites: (body.sites as unknown[]).map((item, index) => {
      if (!object(item)) throw new Error(`sites[${index}] must be an object`);
      const secret = item.secret === undefined ? undefined : requiredString(item.secret, `sites[${index}].secret`);
      if (secret && Buffer.byteLength(secret) < 32) throw new Error(`sites[${index}].secret must contain at least 32 bytes`);
      const enabled = optionalBoolean(item.enabled, `sites[${index}].enabled`);
      return {
        site_id: requiredString(item.site_id, `sites[${index}].site_id`),
        name: requiredString(item.name, `sites[${index}].name`),
        ...(item.school_name === undefined ? {} : { school_name: requiredString(item.school_name, `sites[${index}].school_name`) }),
        ...(enabled === undefined ? {} : { enabled }),
        ...(secret === undefined ? {} : { secret }),
      };
    }),
    teams: (body.teams as unknown[]).map((item, index) => {
      if (!object(item)) throw new Error(`teams[${index}] must be an object`);
      const official = optionalBoolean(item.official, `teams[${index}].official`);
      const hidden = optionalBoolean(item.hidden, `teams[${index}].hidden`);
      return {
        team_id: requiredString(item.team_id, `teams[${index}].team_id`),
        name: requiredString(item.name, `teams[${index}].name`),
        school_id: requiredString(item.school_id, `teams[${index}].school_id`),
        ...(item.school_name === undefined ? {} : { school_name: requiredString(item.school_name, `teams[${index}].school_name`) }),
        ...(official === undefined ? {} : { official }),
        ...(hidden === undefined ? {} : { hidden }),
      };
    }),
    problems: (body.problems as unknown[]).map((item, index) => {
      if (!object(item)) throw new Error(`problems[${index}] must be an object`);
      const color = item.color === undefined ? undefined : requiredString(item.color, `problems[${index}].color`);
      const rgb = item.rgb === undefined ? undefined : requiredString(item.rgb, `problems[${index}].rgb`);
      if (rgb !== undefined && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(rgb)) {
        throw new Error(`problems[${index}].rgb must be a #RGB or #RRGGBB hexadecimal color`);
      }
      return {
        problem_id: requiredString(item.problem_id, `problems[${index}].problem_id`),
        label: requiredString(item.label, `problems[${index}].label`),
        name: requiredString(item.name, `problems[${index}].name`),
        ordinal: item.ordinal === undefined ? index : nonNegativeInteger(item.ordinal, `problems[${index}].ordinal`),
        ...(color === undefined ? {} : { color }),
        ...(rgb === undefined ? {} : { rgb }),
      };
    }),
    team_mappings: (body.team_mappings as unknown[]).map((item, index) => {
      if (!object(item)) throw new Error(`team_mappings[${index}] must be an object`);
      return {
        site_id: requiredString(item.site_id, `team_mappings[${index}].site_id`),
        ...(item.league_id === undefined ? {} : { league_id: requiredString(item.league_id, `team_mappings[${index}].league_id`) }),
        domain_id: requiredString(item.domain_id, `team_mappings[${index}].domain_id`),
        contest_id: requiredString(item.contest_id, `team_mappings[${index}].contest_id`),
        local_uid: requiredString(String(item.local_uid ?? ''), `team_mappings[${index}].local_uid`),
        team_id: requiredString(item.team_id, `team_mappings[${index}].team_id`),
      };
    }),
    problem_mappings: (body.problem_mappings as unknown[]).map((item, index) => {
      if (!object(item)) throw new Error(`problem_mappings[${index}] must be an object`);
      return {
        site_id: requiredString(item.site_id, `problem_mappings[${index}].site_id`),
        ...(item.league_id === undefined ? {} : { league_id: requiredString(item.league_id, `problem_mappings[${index}].league_id`) }),
        domain_id: requiredString(item.domain_id, `problem_mappings[${index}].domain_id`),
        contest_id: requiredString(item.contest_id, `problem_mappings[${index}].contest_id`),
        local_pid: requiredString(String(item.local_pid ?? ''), `problem_mappings[${index}].local_pid`),
        problem_id: requiredString(item.problem_id, `problem_mappings[${index}].problem_id`),
      };
    }),
  };
  if (!Number.isSafeInteger(parsed.contest.penalty_minutes) || (parsed.contest.penalty_minutes ?? 0) < 0) {
    throw new Error('contest.penalty_minutes must be a non-negative integer');
  }
  if (Date.parse(parsed.contest.end_time) <= Date.parse(parsed.contest.start_time)) {
    throw new Error('contest.end_time must be after start_time');
  }
  if (parsed.contest.freeze_time !== null && parsed.contest.freeze_time !== undefined) {
    const freeze = Date.parse(parsed.contest.freeze_time);
    if (freeze <= Date.parse(parsed.contest.start_time) || freeze >= Date.parse(parsed.contest.end_time)) {
      throw new Error('contest.freeze_time must be strictly after start_time and before end_time');
    }
  }
  if (parsed.contest.unfreeze_at !== null && parsed.contest.unfreeze_at !== undefined
    && Date.parse(parsed.contest.unfreeze_at) < Date.parse(parsed.contest.end_time)) {
    throw new Error('contest.unfreeze_at must not be earlier than end_time');
  }
  const uniqueLists: Array<[string, string[]]> = [
    ['site_id', parsed.sites.map((item) => item.site_id)],
    ['team_id', parsed.teams.map((item) => item.team_id)],
    ['problem_id', parsed.problems.map((item) => item.problem_id)],
  ];
  for (const [name, values] of uniqueLists) {
    if (new Set(values).size !== values.length) throw new Error(`${name} values must be unique`);
  }
  if (new Set(parsed.problems.map((problem) => problem.ordinal)).size !== parsed.problems.length) {
    throw new Error('problem ordinal values must be unique');
  }
  const siteIds = new Set(parsed.sites.map((site) => site.site_id));
  const teamIds = new Set(parsed.teams.map((team) => team.team_id));
  const problemIds = new Set(parsed.problems.map((problem) => problem.problem_id));
  const teamMappingKeys = new Set<string>();
  for (const mapping of parsed.team_mappings) {
    if (!siteIds.has(mapping.site_id)) throw new Error(`team mapping references unknown site ${mapping.site_id}`);
    if (!teamIds.has(mapping.team_id)) throw new Error(`team mapping references unknown team ${mapping.team_id}`);
    if (mapping.league_id && mapping.league_id !== parsed.contest.contest_id) throw new Error('team mapping league_id does not match contest');
    const key = [mapping.site_id, mapping.domain_id, mapping.contest_id, mapping.local_uid].join('\0');
    if (teamMappingKeys.has(key)) throw new Error('team mapping keys must be unique');
    teamMappingKeys.add(key);
  }
  const problemMappingKeys = new Set<string>();
  for (const mapping of parsed.problem_mappings) {
    if (!siteIds.has(mapping.site_id)) throw new Error(`problem mapping references unknown site ${mapping.site_id}`);
    if (!problemIds.has(mapping.problem_id)) throw new Error(`problem mapping references unknown problem ${mapping.problem_id}`);
    if (mapping.league_id && mapping.league_id !== parsed.contest.contest_id) throw new Error('problem mapping league_id does not match contest');
    const key = [mapping.site_id, mapping.domain_id, mapping.contest_id, mapping.local_pid].join('\0');
    if (problemMappingKeys.has(key)) throw new Error('problem mapping keys must be unique');
    problemMappingKeys.add(key);
  }
  return parsed;
}

function validateEvent(value: unknown, expectedSiteId: string, expectedLeagueId: string, index: number): IngestEvent {
  const parsed = SubmissionEventSchema.safeParse(value);
  if (!parsed.success) throw new Error(`invalid events[${index}]: ${parsed.error.issues[0]?.message ?? 'schema error'}`);
  if (parsed.data.site_id !== expectedSiteId) throw new Error(`events[${index}].site_id does not match route`);
  if (parsed.data.league_id !== expectedLeagueId) throw new Error(`events[${index}].league_id does not match envelope`);
  return parsed.data;
}

function validateBatch(body: unknown, expectedSiteId: string, snapshot = false): EventBatch {
  if (!snapshot) {
    const parsed = EventBatchEnvelopeSchema.safeParse(body);
    if (!parsed.success) throw new Error(`invalid event batch: ${parsed.error.issues[0]?.message ?? 'schema error'}`);
    if (parsed.data.site_id !== expectedSiteId) throw new Error('site_id does not match route');
    return parsed.data;
  }
  if (!object(body) || !Array.isArray(body.events)) throw new Error('events must be an array');
  const allowedBatchKeys = snapshot
    ? new Set(['protocol_version', 'snapshot_id', 'league_id', 'site_id', 'generated_at', 'chunk_index', 'complete', 'events'])
    : new Set(['protocol_version', 'batch_id', 'league_id', 'site_id', 'sent_at', 'events']);
  const unknownBatchKey = Object.keys(body).find((key) => !allowedBatchKeys.has(key));
  if (unknownBatchKey) throw new Error(`batch contains unknown field ${unknownBatchKey}`);
  if (body.events.length > 1_000) throw new Error('a batch may contain at most 1000 events');
  const bodySiteId = requiredString(body.site_id, 'site_id');
  if (bodySiteId !== expectedSiteId) throw new Error('site_id does not match route');
  const leagueId = requiredString(body.league_id, 'league_id');
  if (body.protocol_version !== '1.0') throw new Error('protocol_version must be 1.0');
  const chunkIndex = Number(body.chunk_index ?? 0);
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) throw new Error('chunk_index must be a non-negative integer');
  if (typeof body.complete !== 'boolean') throw new Error('complete must be a boolean');
  const snapshotId = requiredString(body.snapshot_id, 'snapshot_id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(snapshotId)) {
    throw new Error('snapshot_id must be a UUID');
  }
  return {
    protocol_version: '1.0',
    batch_id: snapshotId,
    idempotency_key: `${snapshotId}:${chunkIndex}`,
    snapshot_id: snapshotId,
    snapshot_complete: body.complete,
    league_id: leagueId,
    site_id: bodySiteId,
    sent_at: validDate(body.sent_at ?? body.generated_at, snapshot ? 'generated_at' : 'sent_at'),
    events: body.events.map((event, index) => validateEvent(event, expectedSiteId, leagueId, index)),
  };
}

function flatTeams(snapshot: NonNullable<ReturnType<typeof buildScoreboard>>) {
  const labels = new Map(snapshot.problems.map((problem) => [problem.problem_id, problem.label]));
  return snapshot.rows.map((row) => ({
    rank: row.rank,
    team_id: row.team.team_id,
    name: row.team.name,
    school: row.team.school_name ?? row.team.school_id,
    official: row.team.official !== false,
    solved: row.solved,
    penalty: row.penalty_minutes,
    problems: Object.fromEntries(row.problems.map((problem) => [labels.get(problem.problem_id) ?? problem.problem_id, {
      attempts: problem.attempts,
      pending: problem.pending,
      solved: problem.solved,
      time: problem.solve_time_ms,
      frozen: problem.status === 'PENDING',
      first_to_solve: problem.first_to_solve,
    }])),
  }));
}

function scoreboardRevision(snapshot: NonNullable<ReturnType<typeof buildScoreboard>>): string {
  return createHash('sha256').update(JSON.stringify({
    cursor: snapshot.cursor,
    contest: snapshot.contest,
    frozen: snapshot.frozen,
    problems: snapshot.problems,
    rows: snapshot.rows,
    accuracy: snapshot.accuracy,
    sites: snapshot.sites.map((site) => ({
      site_id: site.site_id,
      status: site.status,
      last_seen_at: site.last_seen_at,
    })),
  })).digest('base64url').slice(0, 22);
}

function publicEvent(event: StoredEvent, database: HubDatabase, view: 'public' | 'jury', frozen: boolean) {
  const contest = database.getContest();
  const team = database.getTeams().find((item) => item.team_id === event.team_id);
  const problem = database.getProblems().find((item) => item.problem_id === event.problem_id);
  if ((!team || !problem) && view === 'public') return null;
  const freezeMs = contest?.freeze_time ? Date.parse(contest.freeze_time) : null;
  const submittedAt = event.submitted_at ?? event.occurred_at;
  const hideResult = view === 'public' && frozen && freezeMs !== null && Date.parse(submittedAt) >= freezeMs;
  return {
    event_id: event.event_id,
    rid: event.rid,
    team_id: event.team_id,
    team_name: team?.name ?? null,
    school: team?.school_name ?? team?.school_id ?? null,
    problem_id: event.problem_id,
    problem_label: problem?.label ?? null,
    status: hideResult ? 'FROZEN' : event.status,
    score: hideResult ? null : event.score ?? null,
    submitted_at: submittedAt,
    judged_at: hideResult ? null : event.judged_at ?? null,
    ...(view === 'jury' ? { site_id: event.site_id, source_seq: event.source_seq, quarantined: !team || !problem } : {}),
  };
}

function contestMatches(database: HubDatabase, leagueId: string): boolean {
  const contestId = database.getContest()?.contest_id;
  return contestId === leagueId
    || (contestId !== undefined && contestApiResourceId(contestId, 'contest') === leagueId);
}

async function noContest(reply: FastifyReply): Promise<void> {
  await reply.code(404).send({ error: 'league_not_found' });
}

async function contestApiError(reply: FastifyReply, code: number, message: string): Promise<void> {
  await reply.code(code).send({ code, message });
}

function isContestApiPath(url: string): boolean {
  const path = url.split('?', 1)[0] ?? url;
  return path === '/api' || path === '/api/' || path === '/api/contests'
    || path.startsWith('/api/contests/');
}

function packageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (dirname(current) !== current) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
        if (parsed.name === '@hydro-league-sync/league-hub') return current;
      } catch {
        // Keep walking; a parent manifest may be the package root.
      }
    }
    current = dirname(current);
  }
  throw new Error('Unable to locate the league-hub package root');
}

function buildXcpcioResponse(
  database: HubDatabase,
  view: ScoreboardView,
  options: ResolvedHubOptions,
): XcpcioAllInOne | null {
  const snapshot = buildScoreboard(database, view, options);
  if (!snapshot) return null;
  return XcpcioAllInOneSchema.parse({
    ...buildXcpcio(database, view, options.now()),
    league_status: {
      generated_at: snapshot.generated_at,
      complete: snapshot.accuracy.complete,
      message: snapshot.accuracy.message,
      sites: snapshot.sites.map((site) => ({
        site_id: site.site_id,
        name: site.name,
        ...(site.school_name ? { school_name: site.school_name } : {}),
        status: site.status,
      })),
    },
  });
}

export function createHubApplication(input: HubOptions = {}): HubApplication {
  const options = resolveHubOptions(input);
  const database = new HubDatabase(options.databasePath);
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  app.register(fastifyStatic, {
    root: join(packageRoot(), 'public', 'hydro-league-xcpcio'),
    prefix: '/hydro-league-xcpcio/',
    decorateReply: false,
    setHeaders(response, filePath) {
      response.header('x-content-type-options', 'nosniff');
      response.header('referrer-policy', 'same-origin');
      response.header('cache-control', filePath.includes(`${join('vendor', '')}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-store');
      if (filePath.endsWith('.html')) {
        response.header(
          'content-security-policy',
          "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self'; font-src 'self' data:; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:",
        );
      }
    },
  });
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    try {
      const rawBody = typeof body === 'string' ? body : body.toString('utf8');
      (request as FastifyRequest & { rawBody?: string }).rawBody = rawBody;
      done(null, JSON.parse(rawBody));
    } catch (error) {
      done(error as Error);
    }
  });
  const auth = createAuthenticator(database, options);

  app.addHook('onClose', async () => database.close());
  app.setErrorHandler(async (error, request, reply) => {
    request.log.error(error);
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof BatchIdConflictError) {
      await reply.code(409).send({ error: error.code, message });
      return;
    }
    if (error instanceof ContestIdImmutableError) {
      await reply.code(409).send({
        error: error.code,
        message,
        configured_contest_id: error.configuredContestId,
        attempted_contest_id: error.attemptedContestId,
      });
      return;
    }
    const status = (error as { statusCode?: number }).statusCode === 400
      || message.includes('must') || message.includes('required') || message.includes('match')
      || message.includes('unknown field') || message.includes('invalid ')
      ? 400
      : 500;
    if (isContestApiPath(request.url)) {
      await reply.code(status).send({
        code: status,
        message: status === 400 ? message : 'Internal server error',
      });
      return;
    }
    await reply.code(status).send(status === 400
      ? { error: 'invalid_request', message }
      : { error: 'internal_error' });
  });
  app.setNotFoundHandler(async (request, reply) => {
    if (isContestApiPath(request.url)) {
      await contestApiError(reply, 404, 'Endpoint not found');
      return;
    }
    await reply.code(404).send({ error: 'not_found' });
  });

  app.get('/', async (_request, reply) => reply.redirect(
    `/hydro-league-xcpcio/index.html?source=${encodeURIComponent('/api/v1/scoreboard/xcpcio.json')}`,
  ));

  app.get('/source', async (_request, reply) => reply
    .header('content-disposition', 'attachment; filename="hydro-league-sync-source.zip"')
    .header('cache-control', 'public, max-age=3600')
    .type('application/zip')
    .send(Buffer.from(buildCorrespondingSourceZip())));

  app.get('/healthz', async () => ({
    status: database.ping() ? 'ok' : 'error',
    configured: database.getContest() !== null,
    time: options.now().toISOString(),
  }));

  app.get('/readyz', async (_request, reply) => {
    const ready = database.ping() && database.getContest() !== null;
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });

  app.put('/api/v1/admin/config', async (request, reply) => {
    if (!await auth.authenticateAdmin(request, reply)) return;
    const currentContest = database.getContest();
    if (currentContest && database.getContestFinalizedAt(currentContest.contest_id)) {
      return reply.code(409).send({ error: 'contest_finalized' });
    }
    const config = validateConfiguration(normalizeConfigurationBody(request.body));
    database.importConfiguration(config, options.now().toISOString());
    return reply.send({ ok: true, cursor: database.latestCursor() });
  });

  app.get('/api/v1/admin/config', async (request, reply) => {
    if (!await auth.authenticateAdmin(request, reply)) return;
    return reply.send(database.exportConfiguration() ?? { configured: false });
  });

  app.get('/api/v1/admin/quarantine', async (request, reply) => {
    if (!await auth.authenticateAdmin(request, reply)) return;
    const events = database.getEvents().filter((event) => !event.team_id || !event.problem_id);
    return reply.send({ count: events.length, items: events.map((event) => ({
      event_id: event.event_id,
      site_id: event.site_id,
      domain_id: event.domain_id,
      contest_id: event.contest_id,
      rid: event.rid,
      uid: event.uid,
      pid: event.pid,
      source_seq: event.source_seq,
      missing_team_mapping: !event.team_id,
      missing_problem_mapping: !event.problem_id,
      reason: event.quarantine_reason,
      received_at: event.received_at,
    })) });
  });

  app.get('/api/v1/admin/mapping-audit', async (request, reply) => {
    if (!await auth.authenticateAdmin(request, reply)) return;
    const events = database.getEvents().filter((event) => event.mapping_warning);
    return reply.send({ count: events.length, items: events.map((event) => ({
      event_id: event.event_id,
      site_id: event.site_id,
      rid: event.rid,
      warning: event.mapping_warning,
      authoritative_team_id: event.team_id,
      authoritative_problem_id: event.problem_id,
    })) });
  });

  const ingest = (snapshot: boolean) => async (request: FastifyRequest<{ Params: { siteId: string } }>, reply: FastifyReply) => {
    const principal = await auth.authenticateSite(request, reply);
    if (!principal) return;
    if (principal.siteId !== request.params.siteId) return reply.code(403).send({ error: 'site_route_mismatch' });
    const batch = validateBatch(request.body, request.params.siteId, snapshot);
    if (!contestMatches(database, batch.league_id)) return reply.code(409).send({ error: 'league_mismatch' });
    if (database.getContestFinalizedAt(batch.league_id)) {
      return reply.code(409).send({ error: 'contest_finalized' });
    }
    const ack = database.ingestBatch(batch, options.now().toISOString());
    return reply.send(ack);
  };

  app.post<{ Params: { siteId: string } }>('/api/v1/sites/:siteId/events:batch', ingest(false));
  app.post<{ Params: { siteId: string } }>('/api/v1/sites/:siteId/snapshot', ingest(true));
  app.post<{ Params: { siteId: string } }>('/api/v1/sites/:siteId/heartbeat', async (request, reply) => {
    const principal = await auth.authenticateSite(request, reply);
    if (!principal) return;
    if (principal.siteId !== request.params.siteId) return reply.code(403).send({ error: 'site_route_mismatch' });
    if (!object(request.body)) return reply.code(400).send({ error: 'invalid_heartbeat' });
    const allowedKeys = new Set([
      'protocol_version', 'league_id', 'site_id', 'sent_at', 'pending_events', 'rejected_events',
      'last_acked_source_seq', 'agent_version', 'hydro_version',
    ]);
    if (Object.keys(request.body).some((key) => !allowedKeys.has(key))) {
      return reply.code(400).send({ error: 'invalid_heartbeat' });
    }
    if (request.body.protocol_version !== '1.0'
      || request.body.site_id !== request.params.siteId
      || typeof request.body.league_id !== 'string'
      || !contestMatches(database, request.body.league_id)) {
      return reply.code(400).send({ error: 'invalid_heartbeat' });
    }
    let telemetry;
    try {
      validDate(request.body.sent_at, 'sent_at');
      telemetry = {
        pendingEvents: nonNegativeInteger(request.body.pending_events, 'pending_events'),
        rejectedEvents: nonNegativeInteger(request.body.rejected_events, 'rejected_events'),
        lastAckedSourceSeq: request.body.last_acked_source_seq === undefined
          ? null
          : nonNegativeInteger(request.body.last_acked_source_seq, 'last_acked_source_seq'),
        agentVersion: shortString(request.body.agent_version, 'agent_version'),
        hydroVersion: shortString(request.body.hydro_version, 'hydro_version'),
      };
    } catch {
      return reply.code(400).send({ error: 'invalid_heartbeat' });
    }
    database.recordHeartbeat(request.params.siteId, options.now().toISOString(), telemetry);
    return reply.send({ ok: true, server_time: options.now().toISOString(), cursor: database.latestCursor() });
  });

  async function sendScoreboard(leagueId: string, view: 'public' | 'jury', request: FastifyRequest, reply: FastifyReply) {
    if (!contestMatches(database, leagueId)) return noContest(reply);
    if (view === 'jury' && !await auth.authenticateJury(request, reply)) return;
    const snapshot = buildScoreboard(database, view, options);
    if (!snapshot) return noContest(reply);
    return reply.header('cache-control', 'no-store').send({ ...snapshot, teams: flatTeams(snapshot) });
  }

  app.get<{ Params: { leagueId: string }; Querystring: { view?: string } }>('/api/v1/leagues/:leagueId/scoreboard', async (request, reply) => {
    const view = request.query.view === 'jury' ? 'jury' : 'public';
    return sendScoreboard(request.params.leagueId, view, request, reply);
  });

  app.get<{ Params: { leagueId: string }; Querystring: { view?: string } }>('/api/v1/leagues/:leagueId/xcpcio.json', async (request, reply) => {
    if (!contestMatches(database, request.params.leagueId)) return noContest(reply);
    const view = request.query.view === 'jury' ? 'jury' : 'public';
    if (view === 'jury' && !await auth.authenticateJury(request, reply)) return;
    const board = buildXcpcioResponse(database, view, options);
    if (!board) return noContest(reply);
    return reply
      .header('cache-control', 'no-store')
      .type('application/json')
      .send(board);
  });

  app.get<{ Querystring: Record<string, string> }>('/api/v1/scoreboard/xcpcio.json', async (request, reply) => {
    if (Object.keys(request.query).length > 0) {
      return reply.code(400).send({ error: 'invalid_request', message: 'Query parameters are not supported' });
    }
    const board = buildXcpcioResponse(database, 'public', options);
    if (!board) return noContest(reply);
    return reply
      .header('cache-control', 'no-store')
      .type('application/json')
      .send(board);
  });

  app.get<{ Params: { leagueId: string }; Querystring: { view?: string; cursor?: string; limit?: string } }>('/api/v1/leagues/:leagueId/submissions', async (request, reply) => {
    if (!contestMatches(database, request.params.leagueId)) return noContest(reply);
    const view = request.query.view === 'jury' ? 'jury' : 'public';
    if (view === 'jury' && !await auth.authenticateJury(request, reply)) return;
    const after = Math.max(0, Number.parseInt(request.query.cursor ?? '0', 10) || 0);
    const limit = Math.min(500, Math.max(1, Number.parseInt(request.query.limit ?? '100', 10) || 100));
    const changes = database.getChanges(after, limit + 1);
    const page = changes.slice(0, limit);
    const snapshot = buildScoreboard(database, view, options);
    if (!snapshot) return noContest(reply);
    const seen = new Set<string>();
    const items = page.flatMap((change) => {
      if (change.kind !== 'event' || !change.event_id || seen.has(change.event_id)) return [];
      seen.add(change.event_id);
      const event = database.getEventById(change.event_id);
      if (!event || event.league_id !== request.params.leagueId) return [];
      const item = publicEvent(event, database, view, snapshot.frozen);
      return item ? [item] : [];
    });
    return reply.header('cache-control', 'no-store').send({
      cursor: page.at(-1)?.cursor ?? after,
      items,
      has_more: changes.length > limit,
    });
  });

  app.get<{ Params: { leagueId: string } }>('/api/v1/leagues/:leagueId/sites/status', async (request, reply) => {
    if (!contestMatches(database, request.params.leagueId)) return noContest(reply);
    const snapshot = buildScoreboard(database, 'public', options);
    if (!snapshot) return noContest(reply);
    return reply.header('cache-control', 'no-store').send({
      generated_at: snapshot.generated_at,
      complete: snapshot.accuracy.complete,
      message: snapshot.accuracy.message,
      sites: snapshot.sites,
    });
  });

  app.post<{ Params: { leagueId: string }; Body: { force?: boolean } }>('/api/v1/leagues/:leagueId/finalize', async (request, reply) => {
    if (!contestMatches(database, request.params.leagueId)) return noContest(reply);
    if (!await auth.authenticateAdmin(request, reply)) return;
    const contest = database.getContest();
    if (!contest || options.now().getTime() < Date.parse(contest.end_time)) {
      return reply.code(409).send({ error: 'contest_not_ended' });
    }
    const body = request.body ?? {};
    if (!object(body) || Object.keys(body).some((key) => key !== 'force')
      || (body.force !== undefined && typeof body.force !== 'boolean')) {
      return reply.code(400).send({ error: 'invalid_request', message: 'body may only contain boolean force' });
    }
    const snapshot = buildScoreboard(database, 'jury', options);
    if (!snapshot) return noContest(reply);
    if (!snapshot.accuracy.complete && body.force !== true) {
      return reply.code(409).send({
        error: 'sites_not_ready',
        message: snapshot.accuracy.message,
        affected_sites: snapshot.accuracy.affected_sites,
      });
    }
    buildEventFeed(database, snapshot, true);
    const state = buildContestApiResources(database, snapshot).state;
    return reply.send({
      ok: true,
      forced: body.force === true && !snapshot.accuracy.complete,
      complete: snapshot.accuracy.complete,
      warning: snapshot.accuracy.message,
      state,
    });
  });

  app.post<{ Params: { leagueId: string } }>('/api/v1/leagues/:leagueId/publish-results', async (request, reply) => {
    if (!contestMatches(database, request.params.leagueId)) return noContest(reply);
    if (!await auth.authenticateAdmin(request, reply)) return;
    const contest = database.getContest();
    if (!contest || !database.getContestFinalizedAt(contest.contest_id)) {
      return reply.code(409).send({ error: 'contest_not_finalized' });
    }
    const publishedAt = database.publishContestResults(contest.contest_id, options.now().toISOString());
    const snapshot = buildScoreboard(database, 'public', options);
    return reply.send({ ok: true, published_at: publishedAt, frozen: snapshot?.frozen ?? false });
  });

  app.get<{ Params: { leagueId: string } }>('/api/v1/leagues/:leagueId/cdp.zip', async (request, reply) => {
    if (!contestMatches(database, request.params.leagueId)) return noContest(reply);
    if (!await auth.authenticateJury(request, reply)) return;
    const contest = database.getContest();
    if (!contest || options.now().getTime() < Date.parse(contest.end_time)) {
      return reply.code(409).send({ error: 'contest_not_ended' });
    }
    if (!database.getContestFinalizedAt(contest.contest_id)) {
      return reply.code(409).send({ error: 'contest_not_finalized' });
    }
    const snapshot = buildScoreboard(database, 'jury', options);
    if (!snapshot) return noContest(reply);
    const archive = buildCdpZip(database, snapshot);
    return reply
      .header('content-disposition', `attachment; filename="${request.params.leagueId}-cdp.zip"`)
      .type('application/zip')
      .send(Buffer.from(archive));
  });

  app.get<{ Querystring: { cursor?: string; revision?: string } }>('/api/v1/scoreboard/public', async (request, reply) => {
    const snapshot = buildScoreboard(database, 'public', options);
    if (!snapshot) return noContest(reply);
    const cursor = Math.max(0, Number.parseInt(request.query.cursor ?? '0', 10) || 0);
    const revision = scoreboardRevision(snapshot);
    if (cursor === snapshot.cursor && cursor !== 0 && request.query.revision === revision) {
      return reply.send({ unchanged: true, cursor, revision });
    }
    return reply.send({ unchanged: false, cursor: snapshot.cursor, revision, snapshot });
  });

  const contestApi = async (request: FastifyRequest<{ Params: { contestId: string } }>, reply: FastifyReply) => {
    if (!contestMatches(database, request.params.contestId)) {
      await contestApiError(reply, 404, 'Contest not found');
      return;
    }
    if (!await auth.authenticateJury(request, reply)) return;
    const snapshot = buildScoreboard(database, 'jury', options);
    if (!snapshot) return noContest(reply);
    return { snapshot, resources: buildContestApiResources(database, snapshot) };
  };

  const apiInformation = {
    version: '2023-06',
    version_url: 'https://ccs-specs.icpc.io/2023-06/contest_api',
    provider: { name: 'Hydro League Hub', version: '0.1.0' },
  };
  const accessInformation = {
    capabilities: [],
    endpoints: [
      { type: 'contest', properties: ['id', 'name', 'formal_name', 'start_time', 'duration', 'scoreboard_freeze_duration', 'scoreboard_type', 'penalty_time'] },
      { type: 'judgement-types', properties: ['id', 'name', 'penalty', 'solved'] },
      { type: 'languages', properties: ['id', 'name'] },
      { type: 'problems', properties: ['id', 'label', 'name', 'ordinal', 'color', 'rgb'] },
      { type: 'groups', properties: ['id', 'name', 'type'] },
      { type: 'organizations', properties: ['id', 'name', 'formal_name'] },
      { type: 'teams', properties: ['id', 'name', 'display_name', 'organization_id', 'group_ids'] },
      { type: 'state', properties: ['started', 'frozen', 'ended', 'thawed', 'finalized', 'end_of_updates'] },
      { type: 'submissions', properties: ['id', 'language_id', 'problem_id', 'team_id', 'time', 'contest_time'] },
      { type: 'judgements', properties: ['id', 'submission_id', 'judgement_type_id', 'start_time', 'start_contest_time', 'end_time', 'end_contest_time'] },
      { type: 'runs', properties: ['id', 'judgement_id', 'ordinal', 'judgement_type_id', 'time', 'contest_time'] },
      { type: 'scoreboard', properties: ['time', 'contest_time', 'state', 'rows'] },
      { type: 'event-feed', properties: ['type', 'id', 'data', 'token'] },
    ],
  };

  const sendApiInformation = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!await auth.authenticateJury(request, reply)) return;
    return reply.send(apiInformation);
  };
  app.get('/api', sendApiInformation);
  app.get('/api/', sendApiInformation);

  app.get('/api/contests', async (request, reply) => {
    if (!await auth.authenticateJury(request, reply)) return;
    const contest = database.getContest();
    if (!contest) return reply.send([]);
    const snapshot = buildScoreboard(database, 'jury', options);
    return reply.send(snapshot ? buildContestApiResources(database, snapshot).contests : []);
  });

  app.get<{ Params: { contestId: string } }>('/api/contests/:contestId', async (request, reply) => {
    const result = await contestApi(request, reply);
    if (!result) return;
    return reply.send(result.resources.contests[0]);
  });

  app.get<{ Params: { contestId: string } }>('/api/contests/:contestId/access', async (request, reply) => {
    if (!contestMatches(database, request.params.contestId)) {
      await contestApiError(reply, 404, 'Contest not found');
      return;
    }
    if (!await auth.authenticateJury(request, reply)) return;
    return reply.send(accessInformation);
  });

  const resourceNames = ['state', 'scoreboard'] as const;
  for (const resourceName of resourceNames) {
    app.get<{ Params: { contestId: string } }>(`/api/contests/:contestId/${resourceName}`, async (request, reply) => {
      const result = await contestApi(request, reply);
      if (!result) return;
      const key = resourceName.replace('-', '_') as keyof typeof result.resources;
      return reply.send(result.resources[key]);
    });
  }
  const collectionResourceNames = ['judgement-types', 'languages', 'groups', 'organizations', 'teams', 'problems', 'submissions', 'judgements', 'runs'] as const;
  const collectionIdFilters: Record<(typeof collectionResourceNames)[number], readonly string[]> = {
    'judgement-types': [],
    languages: [],
    groups: [],
    organizations: [],
    teams: ['organization_id'],
    problems: [],
    submissions: ['language_id', 'problem_id', 'team_id'],
    judgements: ['submission_id', 'judgement_type_id'],
    runs: ['judgement_id', 'judgement_type_id'],
  };
  for (const resourceName of collectionResourceNames) {
    app.get<{ Params: { contestId: string }; Querystring: Record<string, string | string[] | undefined> }>(
      `/api/contests/:contestId/${resourceName}`,
      async (request, reply) => {
        const result = await contestApi(request, reply);
        if (!result) return;
        const allowedFilters = collectionIdFilters[resourceName];
        const unsupported = Object.keys(request.query).find((property) => !allowedFilters.includes(property));
        if (unsupported) {
          await contestApiError(reply, 400, `Filtering by property '${unsupported}' is not supported`);
          return;
        }
        const key = resourceName.replace('-', '_') as keyof typeof result.resources;
        let collection = result.resources[key] as Array<Record<string, unknown>>;
        for (const property of allowedFilters) {
          const value = request.query[property];
          if (value === undefined) continue;
          if (typeof value !== 'string') {
            await contestApiError(reply, 400, `Filter '${property}' must be specified exactly once`);
            return;
          }
          const expected: string | null = value === '' ? null : value;
          collection = collection.filter((candidate) => (candidate[property] ?? null) === expected);
        }
        return reply.send(collection);
      },
    );
    app.get<{ Params: { contestId: string; resourceId: string } }>(
      `/api/contests/:contestId/${resourceName}/:resourceId`,
      async (request, reply) => {
        const result = await contestApi(request, reply);
        if (!result) return;
        const key = resourceName.replace('-', '_') as keyof typeof result.resources;
        const collection = result.resources[key] as Array<Record<string, unknown>>;
        const item = collection.find((candidate) => candidate.id === request.params.resourceId);
        if (item) return reply.send(item);
        await contestApiError(reply, 404, `${resourceName} resource not found`);
      },
    );
  }

  app.get<{ Params: { contestId: string }; Querystring: { since_token?: string; stream?: string } }>('/api/contests/:contestId/event-feed', async (request, reply) => {
    const result = await contestApi(request, reply);
    if (!result) return;
    const rawSince = request.query.since_token ?? '0';
    if (!/^\d+$/.test(rawSince)) {
      await contestApiError(reply, 400, 'since_token is invalid');
      return;
    }
    const since = Number(rawSince);
    if (!Number.isSafeInteger(since)) {
      await contestApiError(reply, 400, 'since_token is invalid');
      return;
    }
    const allEvents = buildEventFeed(database, result.snapshot, false, 0);
    if (request.query.since_token !== undefined && since !== 0
      && !allEvents.some((event) => Number(event.token) === since)) {
      await contestApiError(reply, 400, 'since_token does not identify an available event');
      return;
    }
    const feed = since === 0 ? allEvents : allEvents.filter((event) => Number(event.token) > since);
    const serialized = feed.map((event) => JSON.stringify(event)).join('\n') + (feed.length ? '\n' : '');
    if (request.query.stream === 'false') {
      return reply.type('application/x-ndjson').send(serialized);
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    if (serialized) reply.raw.write(serialized);
    let cursor = feed.length ? Number(feed.at(-1)!.token) : since;
    const terminal = (events: ReturnType<typeof buildEventFeed>) => {
      const last = events.at(-1);
      return last?.type === 'state'
        && object(last.data)
        && typeof last.data.end_of_updates === 'string';
    };
    if (terminal(feed) || typeof result.resources.state.end_of_updates === 'string') {
      reply.raw.end();
      return;
    }

    let lastWriteAt = Date.now();
    const interval = setInterval(() => {
      if (reply.raw.destroyed || reply.raw.writableEnded) {
        clearInterval(interval);
        return;
      }
      try {
        const snapshot = buildScoreboard(database, 'jury', options);
        if (!snapshot) throw new Error('League configuration is not loaded');
        const updates = buildEventFeed(database, snapshot, false, cursor);
        if (updates.length) {
          reply.raw.write(updates.map((event) => JSON.stringify(event)).join('\n') + '\n');
          cursor = Number(updates.at(-1)!.token);
          lastWriteAt = Date.now();
          if (terminal(updates)) {
            clearInterval(interval);
            reply.raw.end();
          }
        } else if (Date.now() - lastWriteAt >= 60_000) {
          reply.raw.write('\n');
          lastWriteAt = Date.now();
        }
      } catch {
        clearInterval(interval);
        reply.raw.destroy();
      }
    }, 1_000);
    interval.unref();
    request.raw.once('close', () => clearInterval(interval));
  });

  return { app, database, options };
}
