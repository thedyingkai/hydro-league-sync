import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  AUTH_HEADERS,
  canonicalJson,
  createHubApplication,
  createRequestSignature,
  type HubApplication,
} from '../src/index.js';
import type { EventBatch, HubConfiguration, IngestEvent } from '../src/types.js';

const adminToken = 'central-jury-token-that-is-at-least-thirty-two-bytes';
const siteASecret = 'site-a-secret-that-is-at-least-thirty-two-bytes';
const siteBSecret = 'site-b-secret-that-is-at-least-thirty-two-bytes';
const leagueId = 'league-2026';

function configuration(): HubConfiguration {
  return {
    contest: {
      contest_id: leagueId,
      name: 'Boundary Test Contest',
      start_time: '2026-08-30T02:00:00.000Z',
      freeze_time: '2026-08-30T05:00:00.000Z',
      end_time: '2026-08-30T06:00:00.000Z',
      penalty_minutes: 20,
    },
    sites: [
      { site_id: 'site-a', name: 'Site A', school_name: 'School A', enabled: true, secret: siteASecret },
      { site_id: 'site-b', name: 'Site B', school_name: 'School B', enabled: true, secret: siteBSecret },
    ],
    teams: [
      { team_id: 'team-a', name: 'Team A', school_id: 'school-a', official: true, hidden: false },
      { team_id: 'team-b', name: 'Team B', school_id: 'school-b', official: true, hidden: false },
    ],
    problems: [
      { problem_id: 'problem-a', label: 'A', name: 'Alpha', ordinal: 0, color: 'red', rgb: '#e74c3c' },
      { problem_id: 'problem-b', label: 'B', name: 'Beta', ordinal: 1, color: 'blue', rgb: '#3498db' },
    ],
    team_mappings: [
      { site_id: 'site-a', domain_id: 'system', contest_id: 'local-a', local_uid: '101', team_id: 'team-a' },
      { site_id: 'site-b', domain_id: 'system', contest_id: 'local-b', local_uid: '201', team_id: 'team-b' },
    ],
    problem_mappings: [
      { site_id: 'site-a', domain_id: 'system', contest_id: 'local-a', local_pid: '1001', problem_id: 'problem-a' },
      { site_id: 'site-a', domain_id: 'system', contest_id: 'local-a', local_pid: '1002', problem_id: 'problem-b' },
      { site_id: 'site-b', domain_id: 'system', contest_id: 'local-b', local_pid: '2001', problem_id: 'problem-a' },
      { site_id: 'site-b', domain_id: 'system', contest_id: 'local-b', local_pid: '2002', problem_id: 'problem-b' },
    ],
  };
}

interface MutableConfiguration {
  contest: Record<string, unknown>;
  sites: Array<Record<string, unknown>>;
  teams: Array<Record<string, unknown>>;
  problems: Array<Record<string, unknown>>;
  team_mappings: Array<Record<string, unknown>>;
  problem_mappings: Array<Record<string, unknown>>;
  awards?: Array<Record<string, unknown>>;
}

function mutableConfiguration(): MutableConfiguration {
  return structuredClone(configuration()) as unknown as MutableConfiguration;
}

function signed(
  now: Date,
  path: string,
  method: string,
  body?: unknown,
  siteId = 'site-a',
  secret = siteASecret,
) {
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const rawBody = body === undefined ? '' : canonicalJson(body);
  const nonce = randomUUID();
  return {
    rawBody,
    headers: {
      [AUTH_HEADERS.siteId]: siteId,
      [AUTH_HEADERS.timestamp]: timestamp,
      [AUTH_HEADERS.nonce]: nonce,
      [AUTH_HEADERS.signature]: createRequestSignature({
        method,
        path,
        siteId,
        timestamp,
        nonce,
        body: rawBody,
        secret,
      }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  };
}

async function configure(hub: HubApplication): Promise<void> {
  const response = await hub.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: configuration(),
  });
  assert.equal(response.statusCode, 200, response.body);
}

function acceptedEvent(submittedAt = '2026-08-30T02:10:00.000Z'): IngestEvent {
  return {
    protocol_version: '1.0',
    event_type: 'submission.upsert',
    league_id: leagueId,
    site_id: 'site-a',
    domain_id: 'system',
    contest_id: 'local-a',
    rid: 'record-1',
    source_seq: 1,
    status: 'ACCEPTED',
    uid: 101,
    pid: 1001,
    submitted_at: submittedAt,
    judged_at: submittedAt,
    emitted_at: '2026-08-30T02:00:00.000Z',
    rejudged: false,
  };
}

function eventBatch(event: IngestEvent): EventBatch {
  return {
    protocol_version: '1.0',
    batch_id: randomUUID(),
    league_id: leagueId,
    site_id: 'site-a',
    sent_at: '2026-08-30T02:00:00.000Z',
    events: [event],
  };
}

test('admin configuration rejects coercions and non-interior freeze boundaries', async (t) => {
  const now = new Date('2026-08-30T02:00:00.000Z');
  const hub = createHubApplication({ databasePath: ':memory:', adminToken, now: () => now });
  t.after(() => hub.app.close());

  const cases: Array<{ name: string; mutate: (body: MutableConfiguration) => void; message: RegExp }> = [
    { name: 'string site boolean', mutate: (body) => { body.sites[0]!.enabled = 'false'; }, message: /must be a boolean/ },
    { name: 'numeric team boolean', mutate: (body) => { body.teams[0]!.official = 1; }, message: /must be a boolean/ },
    { name: 'string hidden boolean', mutate: (body) => { body.teams[0]!.hidden = 'false'; }, message: /must be a boolean/ },
    { name: 'date-only start', mutate: (body) => { body.contest.start_time = '2026-08-30'; }, message: /ISO 8601/ },
    { name: 'invalid calendar date', mutate: (body) => { body.contest.start_time = '2026-02-30T02:00:00Z'; }, message: /valid ISO 8601/ },
    { name: 'string penalty', mutate: (body) => { body.contest.penalty_minutes = '20'; }, message: /non-negative integer/ },
    { name: 'string ordinal', mutate: (body) => { body.problems[0]!.ordinal = '0'; }, message: /non-negative integer/ },
    { name: 'fractional ordinal', mutate: (body) => { body.problems[0]!.ordinal = 0.5; }, message: /non-negative integer/ },
    { name: 'duplicate ordinal', mutate: (body) => { body.problems[1]!.ordinal = 0; }, message: /ordinal values must be unique/ },
    { name: 'freeze at start', mutate: (body) => { body.contest.freeze_time = body.contest.start_time; }, message: /strictly after/ },
    { name: 'freeze at end', mutate: (body) => { body.contest.freeze_time = body.contest.end_time; }, message: /strictly after/ },
    { name: 'non-hex rgb', mutate: (body) => { body.problems[0]!.rgb = 'red'; }, message: /hexadecimal color/ },
    { name: 'team groups object', mutate: (body) => { body.teams[0]!.groups = {}; }, message: /must be an array/ },
    { name: 'reserved team group', mutate: (body) => { body.teams[0]!.groups = ['official']; }, message: /reserved official or unofficial/ },
    { name: 'badge with credentials', mutate: (body) => { body.teams[0]!.badge_url = 'https://user:pass@example.test/logo.png'; }, message: /without credentials/ },
    { name: 'protocol-relative badge', mutate: (body) => { body.teams[0]!.badge_url = '//example.test/logo.png'; }, message: /safe root-relative path/ },
    { name: 'traversing root-relative badge', mutate: (body) => { body.teams[0]!.badge_url = '/hydro-league-xcpcio/%2e%2e/private.png'; }, message: /safe root-relative path/ },
    { name: 'double-encoded traversing badge', mutate: (body) => { body.teams[0]!.badge_url = '/hydro-league-xcpcio/%252e%252e/private.png'; }, message: /safe root-relative path/ },
    { name: 'backslash root-relative badge', mutate: (body) => { body.teams[0]!.badge_url = '/hydro-league-xcpcio/%5cprivate.png'; }, message: /safe root-relative path/ },
    { name: 'double-encoded backslash badge', mutate: (body) => { body.teams[0]!.badge_url = '/hydro-league-xcpcio/%255cprivate.png'; }, message: /safe root-relative path/ },
    { name: 'encoded protocol-relative badge', mutate: (body) => { body.teams[0]!.badge_url = '/%252fexample.test/logo.png'; }, message: /safe root-relative path/ },
    { name: 'double-encoded control character badge', mutate: (body) => { body.teams[0]!.badge_url = '/hydro-league-xcpcio/%2500.png'; }, message: /safe root-relative path/ },
    { name: 'UTF-8 encoded control character badge', mutate: (body) => { body.teams[0]!.badge_url = '/hydro-league-xcpcio/%C2%85.png'; }, message: /safe root-relative path/ },
    { name: 'truncated UTF-8 badge', mutate: (body) => { body.teams[0]!.badge_url = '/hydro-league-xcpcio/%E5%8C.png'; }, message: /safe root-relative path/ },
    { name: 'invalid UTF-8 badge', mutate: (body) => { body.teams[0]!.badge_url = '/hydro-league-xcpcio/%FF.png'; }, message: /safe root-relative path/ },
    { name: 'fractional medal count', mutate: (body) => {
      body.teams[0]!.groups = ['freshman'];
      body.contest.xcpcio_medals = { freshman: { gold: 1.5, silver: 0, bronze: 0 } };
    }, message: /non-negative integer/ },
    { name: 'unknown medal group', mutate: (body) => {
      body.contest.xcpcio_medals = { missing: { gold: 1, silver: 0, bronze: 0 } };
    }, message: /unknown group/ },
    { name: 'award references hidden team', mutate: (body) => {
      body.teams[1]!.hidden = true;
      body.awards = [{ award_id: 'winner', citation: 'Winner', team_ids: ['team-b'] }];
    }, message: /unknown or hidden team/ },
    { name: 'duplicate award id', mutate: (body) => {
      body.awards = [
        { award_id: 'winner', citation: 'Winner', team_ids: ['team-a'] },
        { award_id: 'winner', citation: 'Another winner', team_ids: ['team-b'] },
      ];
    }, message: /award_id values must be unique/ },
  ];
  for (const item of cases) {
    const body = mutableConfiguration();
    item.mutate(body);
    const response = await hub.app.inject({
      method: 'PUT',
      url: '/api/v1/admin/config',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: body,
    });
    assert.equal(response.statusCode, 400, `${item.name}: ${response.body}`);
    assert.match(response.json().message, item.message, item.name);
  }

  const rootRelative = configuration();
  rootRelative.teams[0]!.badge_url = '/hydro-league-xcpcio/school-badges/%E5%8C%97%E5%AD%97%F0%9F%8F%AB.png';
  const rootRelativeResponse = await hub.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: rootRelative,
  });
  assert.equal(rootRelativeResponse.statusCode, 200, rootRelativeResponse.body);
  assert.equal(
    hub.database.getTeams()[0]?.badge_url,
    '/hydro-league-xcpcio/school-badges/%E5%8C%97%E5%AD%97%F0%9F%8F%AB.png',
  );

  await configure(hub);
  const replacement = configuration();
  replacement.contest.contest_id = 'different-league';
  const immutable = await hub.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: replacement,
  });
  assert.equal(immutable.statusCode, 409, immutable.body);
  assert.deepEqual(immutable.json(), {
    error: 'CONTEST_ID_IMMUTABLE',
    message: `contest id is immutable after initial configuration (${leagueId} != different-league)`,
    configured_contest_id: leagueId,
    attempted_contest_id: 'different-league',
  });
});

test('public polling revision changes when a future submission becomes scoreable', async (t) => {
  let now = new Date('2026-08-30T02:00:00.000Z');
  const hub = createHubApplication({
    databasePath: ':memory:',
    adminToken,
    delayedAfterMs: 1_000_000_000,
    offlineAfterMs: 2_000_000_000,
    now: () => now,
  });
  t.after(() => hub.app.close());
  await configure(hub);

  const event = acceptedEvent('2026-08-30T02:30:00.000Z');
  hub.database.ingestBatch(eventBatch(event), now.toISOString());
  hub.database.recordHeartbeat('site-a', now.toISOString(), {
    pendingEvents: 0,
    rejectedEvents: 0,
    lastAckedSourceSeq: 1,
    agentVersion: 'test-agent',
    hydroVersion: '5.0.0-beta.9',
  });
  const before = await hub.app.inject({ method: 'GET', url: '/api/v1/scoreboard/public?cursor=0' });
  assert.equal(before.statusCode, 200, before.body);
  const initial = before.json();
  assert.equal(initial.snapshot.rows.find((row: { team: { team_id: string } }) => row.team.team_id === 'team-a').solved, 0);

  now = new Date('2026-08-30T02:31:00.000Z');
  const after = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/scoreboard/public?cursor=${initial.cursor}&revision=${encodeURIComponent(initial.revision)}`,
  });
  assert.equal(after.statusCode, 200, after.body);
  assert.equal(after.json().unchanged, false, after.body);
  assert.notEqual(after.json().revision, initial.revision);
  assert.equal(after.json().snapshot.rows.find((row: { team: { team_id: string } }) => row.team.team_id === 'team-a').solved, 1);
});

test('Contest API supports Basic jury auth, canonical errors, ID filters, and token validation', async (t) => {
  const now = new Date('2026-08-30T04:00:00.000Z');
  const hub = createHubApplication({ databasePath: ':memory:', adminToken, now: () => now });
  t.after(() => hub.app.close());
  await configure(hub);

  const anonymous = await hub.app.inject({ method: 'GET', url: '/api' });
  assert.equal(anonymous.statusCode, 401);
  assert.deepEqual(anonymous.json(), { code: 401, message: 'Authentication credentials are required' });
  assert.match(String(anonymous.headers['www-authenticate'] ?? ''), /^Basic /);

  const wrongBasic = await hub.app.inject({
    method: 'GET',
    url: '/api',
    headers: { authorization: `Basic ${Buffer.from(`not-jury:${adminToken}`).toString('base64')}` },
  });
  assert.equal(wrongBasic.statusCode, 401);
  const challenge = wrongBasic.headers['www-authenticate'];
  assert.match(Array.isArray(challenge) ? challenge[0] ?? '' : challenge ?? '', /^Basic /);
  assert.deepEqual(wrongBasic.json(), { code: 401, message: 'The jury credentials are invalid' });

  const basic = { authorization: `Basic ${Buffer.from(`jury:${adminToken}`).toString('base64')}` };
  assert.equal((await hub.app.inject({ method: 'GET', url: '/api', headers: basic })).statusCode, 200);

  const siteApiPath = `/api/contests/${leagueId}/teams`;
  const siteApiAuth = signed(now, siteApiPath, 'GET');
  assert.equal((await hub.app.inject({ method: 'GET', url: siteApiPath, headers: siteApiAuth.headers })).statusCode, 200,
    'school servers remain in the explicitly trusted jury domain');

  const publicBoard = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/scoreboard?view=public`,
  });
  assert.equal(publicBoard.statusCode, 200, publicBoard.body);
  assert.equal((await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/scoreboard?view=jury`,
  })).statusCode, 401);

  const payload = eventBatch(acceptedEvent());
  const ingestPath = '/api/v1/sites/site-a/events:batch';
  const ingestAuth = signed(now, ingestPath, 'POST', payload);
  const ingest = await hub.app.inject({
    method: 'POST',
    url: ingestPath,
    headers: ingestAuth.headers,
    payload: ingestAuth.rawBody,
  });
  assert.equal(ingest.statusCode, 200, ingest.body);

  const bearer = { authorization: `Bearer ${adminToken}` };
  const teams = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/teams?organization_id=school-a`,
    headers: bearer,
  });
  assert.equal(teams.statusCode, 200, teams.body);
  assert.deepEqual(teams.json().map((team: { id: string }) => team.id), ['team-a']);

  const submissions = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/submissions?team_id=team-a&problem_id=problem-a`,
    headers: bearer,
  });
  assert.equal(submissions.statusCode, 200, submissions.body);
  assert.equal(submissions.json().length, 1);
  const otherTeamSubmissions = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/submissions?team_id=team-b`,
    headers: bearer,
  });
  assert.deepEqual(otherTeamSubmissions.json(), []);

  const unsupportedFilter = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/teams?id=team-a`,
    headers: bearer,
  });
  assert.equal(unsupportedFilter.statusCode, 400);
  assert.deepEqual(unsupportedFilter.json(), { code: 400, message: "Filtering by property 'id' is not supported" });

  const missingItem = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/teams/missing`,
    headers: bearer,
  });
  assert.equal(missingItem.statusCode, 404);
  assert.deepEqual(missingItem.json(), { code: 404, message: 'teams resource not found' });
  const missingEndpoint = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/not-an-endpoint`,
    headers: bearer,
  });
  assert.equal(missingEndpoint.statusCode, 404);
  assert.deepEqual(missingEndpoint.json(), { code: 404, message: 'Endpoint not found' });

  const initialFeed = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/event-feed?since_token=0&stream=false`,
    headers: bearer,
  });
  assert.equal(initialFeed.statusCode, 200, initialFeed.body);
  const tokens = initialFeed.body.trim().split('\n').map((line) => Number(JSON.parse(line).token));
  const futureToken = Math.max(...tokens) + 100;
  const future = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/event-feed?since_token=${futureToken}&stream=false`,
    headers: bearer,
  });
  assert.equal(future.statusCode, 400);
  assert.deepEqual(future.json(), { code: 400, message: 'since_token does not identify an available event' });
  const malformed = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/event-feed?since_token=not-a-token&stream=false`,
    headers: bearer,
  });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(malformed.json(), { code: 400, message: 'since_token is invalid' });
});
