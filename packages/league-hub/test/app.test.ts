import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { unzipSync, strFromU8 } from 'fflate';
import { EventBatchAckSchema } from '@hydro-league-sync/protocol';
import {
  AUTH_HEADERS,
  canonicalJson,
  createHubApplication,
  createRequestSignature,
  type HubApplication,
} from '../src/index.js';
import type { EventBatch, HubConfiguration, IngestEvent } from '../src/types.js';

const adminToken = 'test-admin-token-that-is-not-used-in-production';
const siteSecret = 'site-secret-must-be-at-least-thirty-two-bytes-long';
const siteId = 'school-a';
const leagueId = 'league-2026';
let now = new Date('2026-08-30T04:00:00.000Z');

function configuration(): HubConfiguration {
  return {
    contest: {
      contest_id: leagueId,
      name: '2026 多校程序设计联赛',
      start_time: '2026-08-30T02:00:00.000Z',
      freeze_time: '2026-08-30T03:20:00.000Z',
      end_time: '2026-08-30T06:00:00.000Z',
      penalty_minutes: 20,
      xcpcio_medals: {
        official: { gold: 1, silver: 1, bronze: 0 },
        freshman: { gold: 1, silver: 0, bronze: 0 },
      },
    },
    sites: [{ site_id: siteId, name: 'A 校测评站', school_name: 'A 校', secret: siteSecret }],
    teams: [
      {
        team_id: 'team-1',
        name: '一队',
        school_id: 'school-a',
        school_name: 'A 校',
        official: true,
        groups: ['freshman'],
        badge_url: 'https://scoreboard.example/assets/school-a.png',
      },
      { team_id: 'team-2', name: '二队', school_id: 'school-a', school_name: 'A 校', official: true },
      { team_id: 'team-star', name: '打星队', school_id: 'school-a', school_name: 'A 校', official: false },
    ],
    problems: [
      { problem_id: 'problem-a', label: 'A', name: 'Alpha', ordinal: 0 },
      { problem_id: 'problem-b', label: 'B', name: 'Beta', ordinal: 1 },
    ],
    team_mappings: [
      { site_id: siteId, domain_id: 'system', contest_id: '1', local_uid: '101', team_id: 'team-1' },
      { site_id: siteId, domain_id: 'system', contest_id: '1', local_uid: '102', team_id: 'team-star' },
      { site_id: siteId, domain_id: 'system', contest_id: '1', local_uid: '103', team_id: 'team-2' },
    ],
    problem_mappings: [
      { site_id: siteId, domain_id: 'system', contest_id: '1', local_pid: '1001', problem_id: 'problem-a' },
      { site_id: siteId, domain_id: 'system', contest_id: '1', local_pid: '1002', problem_id: 'problem-b' },
    ],
    awards: [
      { award_id: 'winner', citation: 'Champion', team_ids: ['team-1'] },
      { award_id: 'first-to-solve-a', citation: 'First to solve problem A', team_ids: ['team-2'] },
      { award_id: 'first-to-solve-b', citation: 'First to solve problem B', team_ids: [] },
    ],
  };
}

function event(input: Partial<IngestEvent> & Pick<IngestEvent, 'rid' | 'source_seq' | 'status' | 'uid' | 'pid'> & { occurred_at: string; contest_time_ms?: number }): IngestEvent {
  const occurredAt = input.occurred_at;
  return {
    protocol_version: '1.0',
    event_type: 'submission.upsert',
    league_id: leagueId,
    site_id: siteId,
    domain_id: 'system',
    contest_id: '1',
    rid: input.rid,
    source_seq: input.source_seq,
    status: input.status,
    uid: Number(input.uid),
    pid: Number(input.pid),
    submitted_at: input.submitted_at ?? occurredAt,
    emitted_at: input.emitted_at ?? occurredAt,
    rejudged: false,
    ...(input.score === undefined ? {} : { score: input.score }),
    ...(input.lang === undefined ? {} : { lang: input.lang }),
    ...(input.judged_at === undefined ? {} : { judged_at: input.judged_at }),
    ...(input.global_team_id === undefined ? {} : { global_team_id: input.global_team_id }),
    ...(input.global_problem_id === undefined ? {} : { global_problem_id: input.global_problem_id }),
  };
}

function batch(events: IngestEvent[], batchId: string = randomUUID()): EventBatch {
  return {
    protocol_version: '1.0',
    batch_id: batchId,
    league_id: leagueId,
    site_id: siteId,
    sent_at: now.toISOString(),
    events,
  };
}

function signed(path: string, method: string, body?: unknown, nonce: string = randomUUID()) {
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const rawBody = body === undefined ? '' : canonicalJson(body);
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
        secret: siteSecret,
      }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  };
}

async function createConfiguredHub(): Promise<HubApplication> {
  now = new Date('2026-08-30T04:00:00.000Z');
  const hub = createHubApplication({
    databasePath: ':memory:',
    adminToken,
    delayedAfterMs: 30_000,
    offlineAfterMs: 120_000,
    now: () => now,
  });
  const response = await hub.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: configuration(),
  });
  assert.equal(response.statusCode, 200, response.body);
  return hub;
}

test('health checks and admin configuration keep secrets out of responses', async (t) => {
  assert.throws(
    () => createHubApplication({ databasePath: ':memory:', adminToken: 'too-short' }),
    /at least 32 UTF-8 bytes/,
  );
  const hub = createHubApplication({ databasePath: ':memory:', adminToken, now: () => now });
  t.after(() => hub.app.close());
  assert.equal(hub.options.host, '127.0.0.1');

  const health = await hub.app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(health.statusCode, 200);
  assert.equal(health.json().configured, false);
  assert.equal((await hub.app.inject({ method: 'GET', url: '/readyz' })).statusCode, 503);
  assert.equal((await hub.app.inject({ method: 'PUT', url: '/api/v1/admin/config', payload: configuration() })).statusCode, 401);

  const imported = await hub.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: configuration(),
  });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal((await hub.app.inject({ method: 'GET', url: '/readyz' })).statusCode, 200);

  const secretPreservingReplacement = configuration();
  delete secretPreservingReplacement.sites[0]!.secret;
  const replaced = await hub.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: secretPreservingReplacement,
  });
  assert.equal(replaced.statusCode, 200, replaced.body);

  const exported = await hub.app.inject({
    method: 'GET',
    url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(exported.statusCode, 200);
  assert.equal(exported.body.includes(siteSecret), false);
  assert.equal(exported.json().sites[0].has_secret, true);

  const page = await hub.app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 302);
  assert.equal(
    page.headers.location,
    '/hydro-league-xcpcio/index.html?source=%2Fapi%2Fv1%2Fscoreboard%2Fxcpcio.json',
  );
  assert.doesNotMatch(page.body, /<table/i);

  const wrapper = await hub.app.inject({ method: 'GET', url: String(page.headers.location) });
  assert.equal(wrapper.statusCode, 200, wrapper.body);
  assert.match(wrapper.body, /hydro-league-xcpcio\/bootstrap\.js/);
  assert.doesNotMatch(wrapper.body, /<table/i);
  assert.match(String(wrapper.headers['content-security-policy'] ?? ''), /frame-ancestors 'self'/);
  assert.match(
    String(wrapper.headers['content-security-policy'] ?? ''),
    /img-src 'self' data: blob: http: https:;/,
  );
  assert.match(wrapper.body, /img-src 'self' data: blob: http: https:;/);
  assert.equal(wrapper.headers['x-content-type-options'], 'nosniff');

  const bootstrap = await hub.app.inject({ method: 'GET', url: '/hydro-league-xcpcio/bootstrap.js' });
  assert.equal(bootstrap.statusCode, 200, bootstrap.body);
  assert.match(bootstrap.body, /\/api\/v1\/scoreboard\/xcpcio\.json/);
  assert.match(bootstrap.body, /leagueboard\|league-xcpcio/);
  const bundledBadge = await hub.app.inject({
    method: 'GET',
    url: '/hydro-league-xcpcio/school-badges/besti.png',
  });
  assert.equal(bundledBadge.statusCode, 200, bundledBadge.body);
  assert.equal(bundledBadge.headers['content-type'], 'image/png');
  assert.equal(
    createHash('sha256').update(bundledBadge.rawPayload).digest('hex'),
    '4af16620f91d5472087f1d41d1f4e4d20503f5a22aa2b0ee8de26b6e62300d17',
  );
  assert.equal((await hub.app.inject({
    method: 'GET',
    url: '/hydro-league-xcpcio/%2e%2e/package.json',
  })).statusCode, 404);

  const source = await hub.app.inject({ method: 'GET', url: '/source' });
  assert.equal(source.statusCode, 200, source.body);
  const sourceFiles = unzipSync(new Uint8Array(source.rawPayload));
  for (const filename of [
    'hydro-league-sync/package.json',
    'hydro-league-sync/package-lock.json',
    'hydro-league-sync/.env.example',
    'hydro-league-sync/Dockerfile.hub',
    'hydro-league-sync/LICENSE',
    'hydro-league-sync/packages/league-hub/src/app.ts',
    'hydro-league-sync/packages/league-hub/public/hydro-league-xcpcio/asset-manifest.json',
    'hydro-league-sync/packages/league-hub/upstream/xcpcio-board-app-scoreboard-only/FORK.md',
    'hydro-league-sync/packages/league-hub/upstream/xcpcio-board-app-scoreboard-only/LICENSE',
    'hydro-league-sync/packages/protocol/src/index.ts',
  ]) {
    assert.ok(sourceFiles[filename], `corresponding source contains ${filename}`);
  }
  assert.equal(Object.keys(sourceFiles).some((name) => (
    /(?:^|\/)(?:node_modules|dist|data)(?:\/|$)|(?:^|\/)\.env$|\.sqlite/i.test(name)
  )), false);
});

test('authoritative configuration import revokes sites omitted by the replacement', async (t) => {
  const hub = await createConfiguredHub();
  t.after(() => hub.app.close());
  const replacement = configuration();
  replacement.sites = [];
  replacement.team_mappings = [];
  replacement.problem_mappings = [];
  const imported = await hub.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: replacement,
  });
  assert.equal(imported.statusCode, 200, imported.body);
  const exported = await hub.app.inject({
    method: 'GET',
    url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const oldSite = exported.json().sites.find((site: { site_id: string }) => site.site_id === siteId);
  assert.equal(oldSite.enabled, false);
  assert.equal(oldSite.has_secret, false);

  const heartbeatPath = `/api/v1/sites/${siteId}/heartbeat`;
  const heartbeatBody = {
    protocol_version: '1.0', league_id: leagueId, site_id: siteId, sent_at: now.toISOString(),
    pending_events: 0, rejected_events: 0, agent_version: '0.1.0', hydro_version: '5.0.0-beta.9',
  };
  const request = signed(heartbeatPath, 'POST', heartbeatBody);
  assert.equal((await hub.app.inject({
    method: 'POST', url: heartbeatPath, headers: request.headers, payload: request.rawBody,
  })).statusCode, 401);
});

test('HMAC batch ingestion is authenticated, replay-safe, idempotent, and versioned', async (t) => {
  const hub = await createConfiguredHub();
  t.after(() => hub.app.close());
  const path = `/api/v1/sites/${siteId}/events:batch`;
  const payload = batch([event({
    rid: 'r1', source_seq: 1, status: 'WRONG_ANSWER', uid: 101, pid: 1001,
    occurred_at: '2026-08-30T02:10:00.000Z', contest_time_ms: 600_000,
  })], '00000000-0000-4000-8000-000000000001');
  assert.equal((await hub.app.inject({ method: 'POST', url: path, payload })).statusCode, 401);

  const request = signed(path, 'POST', payload, '0123456789abcdef-first');
  const accepted = await hub.app.inject({ method: 'POST', url: path, headers: request.headers, payload: request.rawBody });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(EventBatchAckSchema.safeParse(accepted.json()).success, true, accepted.body);
  assert.equal(accepted.json().accepted_count, 1);
  assert.equal(accepted.json().high_watermark, 1);

  const replay = await hub.app.inject({ method: 'POST', url: path, headers: request.headers, payload: request.rawBody });
  assert.equal(replay.statusCode, 409);

  const retry = signed(path, 'POST', payload, '0123456789abcdef-retry');
  const duplicateBatch = await hub.app.inject({ method: 'POST', url: path, headers: retry.headers, payload: retry.rawBody });
  assert.equal(duplicateBatch.statusCode, 200);
  assert.deepEqual(duplicateBatch.json(), accepted.json());

  const reusedBatchId = {
    ...payload,
    events: [event({
      rid: 'must-not-be-ingested', source_seq: 2, status: 'ACCEPTED', uid: 101, pid: 1001,
      occurred_at: '2026-08-30T02:11:00.000Z',
    })],
  };
  const reusedRequest = signed(path, 'POST', reusedBatchId);
  const reused = await hub.app.inject({
    method: 'POST', url: path, headers: reusedRequest.headers, payload: reusedRequest.rawBody,
  });
  assert.equal(reused.statusCode, 409, reused.body);
  assert.equal(reused.json().error, 'BATCH_ID_CONFLICT');
  assert.equal(hub.database.getEvents().some((item) => item.rid === 'must-not-be-ingested'), false);

  const updatedPayload = batch([event({
    rid: 'r1', source_seq: 3, status: 'ACCEPTED', uid: 101, pid: 1001,
    occurred_at: '2026-08-30T02:12:00.000Z', submitted_at: '2026-08-30T02:10:00.000Z', contest_time_ms: 720_000,
  })], '00000000-0000-4000-8000-000000000003');
  const updatedRequest = signed(path, 'POST', updatedPayload);
  const updated = await hub.app.inject({ method: 'POST', url: path, headers: updatedRequest.headers, payload: updatedRequest.rawBody });
  assert.equal(updated.json().accepted_count, 1);
  const stalePayload = batch([event({
    rid: 'r1', source_seq: 2, status: 'WRONG_ANSWER', uid: 101, pid: 1001,
    occurred_at: '2026-08-30T02:11:00.000Z', submitted_at: '2026-08-30T02:10:00.000Z', contest_time_ms: 660_000,
  })], '00000000-0000-4000-8000-000000000002');
  const staleRequest = signed(path, 'POST', stalePayload);
  const stale = await hub.app.inject({ method: 'POST', url: path, headers: staleRequest.headers, payload: staleRequest.rawBody });
  assert.equal(stale.json().duplicate_count, 1);
  assert.equal(stale.json().high_watermark, 3);
  assert.equal(hub.database.getEvents()[0]?.status, 'ACCEPTED');

  const sensitivePayload = {
    ...batch([event({
      rid: 'sensitive', source_seq: 4, status: 'PENDING', uid: 101, pid: 1001,
      occurred_at: '2026-08-30T02:13:00.000Z',
    })]),
    events: [{
      ...event({ rid: 'sensitive', source_seq: 4, status: 'PENDING', uid: 101, pid: 1001, occurred_at: '2026-08-30T02:13:00.000Z' }),
      payload: { source: 'must never reach the hub' },
    }],
  };
  const sensitiveRequest = signed(path, 'POST', sensitivePayload);
  const sensitive = await hub.app.inject({ method: 'POST', url: path, headers: sensitiveRequest.headers, payload: sensitiveRequest.rawBody });
  assert.equal(sensitive.statusCode, 400);
  assert.equal(hub.database.getEvents().some((item) => item.rid === 'sensitive'), false);
});

test('sequence and immutable identity conflicts are rejected without changing the stored submission', async (t) => {
  const hub = await createConfiguredHub();
  t.after(() => hub.app.close());
  const path = `/api/v1/sites/${siteId}/events:batch`;
  const send = async (payload: EventBatch) => {
    const request = signed(path, 'POST', payload);
    const response = await hub.app.inject({ method: 'POST', url: path, headers: request.headers, payload: request.rawBody });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(EventBatchAckSchema.safeParse(response.json()).success, true, response.body);
    return response.json();
  };

  const firstEvent = event({
    rid: 'identity-rid', source_seq: 1, status: 'WRONG_ANSWER', uid: 101, pid: 1001,
    occurred_at: '2026-08-30T02:10:00.000Z',
  });
  const first = await send(batch([firstEvent], '10000000-0000-4000-8000-000000000001'));
  assert.equal(first.accepted_count, 1);
  assert.equal(first.high_watermark, 1);

  const exactRetry = await send(batch([firstEvent], '10000000-0000-4000-8000-000000000002'));
  assert.equal(exactRetry.duplicate_count, 1);
  assert.deepEqual(exactRetry.rejected, []);

  const sequenceConflict = await send(batch([event({
    rid: 'identity-rid', source_seq: 1, status: 'ACCEPTED', uid: 101, pid: 1001,
    occurred_at: '2026-08-30T02:10:00.000Z',
  })], '10000000-0000-4000-8000-000000000003'));
  assert.equal(sequenceConflict.rejected[0].code, 'SOURCE_SEQ_CONFLICT');
  assert.equal(sequenceConflict.rejected[0].retryable, false);
  assert.equal(sequenceConflict.high_watermark, 1);

  const immutableConflictEvent = event({
    rid: 'identity-rid', source_seq: 2, status: 'ACCEPTED', uid: 101, pid: 1002,
    occurred_at: '2026-08-30T02:10:00.000Z',
  });
  const immutableConflict = await send(batch(
    [immutableConflictEvent],
    '10000000-0000-4000-8000-000000000004',
  ));
  assert.equal(immutableConflict.rejected[0].code, 'IMMUTABLE_IDENTITY_CONFLICT');
  assert.equal(immutableConflict.rejected[0].retryable, false);
  assert.equal(immutableConflict.high_watermark, 2, 'non-retryable rejection is a processed sequence');
  const unchanged = hub.database.getEvents()[0]!;
  const stableSubmissionId = unchanged.event_id;
  assert.equal(unchanged.source_seq, 1);
  assert.equal(unchanged.status, 'WRONG_ANSWER');
  assert.equal(unchanged.pid, 1001);

  const feedBeforeRevision = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/event-feed?since_token=0&stream=false`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(feedBeforeRevision.statusCode, 200, feedBeforeRevision.body);
  const initialNotifications = feedBeforeRevision.body.trim().split('\n').map((line) => JSON.parse(line));
  const priorToken = Math.max(...initialNotifications.map((item) => Number(item.token)));

  const validRevision = await send(batch([event({
    rid: 'identity-rid', source_seq: 3, status: 'ACCEPTED', uid: 101, pid: 1001,
    occurred_at: '2026-08-30T02:10:00.000Z', judged_at: '2026-08-30T02:12:00.000Z',
  })], '10000000-0000-4000-8000-000000000005'));
  assert.equal(validRevision.accepted_count, 1);
  assert.equal(validRevision.high_watermark, 3);
  const revised = hub.database.getEvents()[0]!;
  assert.equal(revised.event_id, stableSubmissionId, 'rejudgement preserves the Contest API submission id');
  assert.equal(revised.source_seq, 3);
  assert.equal(revised.status, 'ACCEPTED');
  assert.equal(revised.pid, 1001);
  const eventChangeIds = hub.database.getChanges(0)
    .filter((change) => change.kind === 'event')
    .map((change) => change.event_id);
  assert.deepEqual([...new Set(eventChangeIds)], [stableSubmissionId], 'cursor history never points at a removed submission id');

  const feedAfterRevision = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/event-feed?since_token=${priorToken}&stream=false`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(feedAfterRevision.statusCode, 200, feedAfterRevision.body);
  const revisionNotifications = feedAfterRevision.body.trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(revisionNotifications.length > 0, 'a rejudge remains visible after reconnecting with the previous token');
  assert.ok(revisionNotifications.every((item) => Number(item.token) > priorToken));
  const revisedJudgement = revisionNotifications.find((item) => item.type === 'judgements');
  assert.equal(revisedJudgement.id, `j-${stableSubmissionId}`);
  assert.equal(revisedJudgement.data.submission_id, stableSubmissionId);
  assert.equal(revisedJudgement.data.judgement_type_id, 'AC');

  const submissions = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/submissions`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(submissions.statusCode, 200, submissions.body);
  assert.equal(submissions.json().length, 1);
  assert.equal(submissions.json()[0].id, stableSubmissionId);
  const judgements = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/judgements`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(judgements.json()[0].submission_id, stableSubmissionId);
});

test('scoreboard applies ACM rules, excludes CE penalty, preserves freeze, and protects jury view', async (t) => {
  const hub = await createConfiguredHub();
  t.after(() => hub.app.close());
  const events = [
    event({ rid: 'ce', source_seq: 1, status: 'COMPILE_ERROR', uid: 101, pid: 1001, occurred_at: '2026-08-30T02:05:00.000Z', contest_time_ms: 300_000 }),
    event({ rid: 'wa', source_seq: 2, status: 'WRONG_ANSWER', uid: 101, pid: 1001, occurred_at: '2026-08-30T02:20:00.000Z', contest_time_ms: 1_200_000 }),
    event({ rid: 'ac', source_seq: 3, status: 'ACCEPTED', uid: 101, pid: 1001, occurred_at: '2026-08-30T02:40:00.000Z', contest_time_ms: 2_400_000 }),
    event({ rid: 'frozen-ac', source_seq: 4, status: 'ACCEPTED', uid: 101, pid: 1002, occurred_at: '2026-08-30T03:30:00.000Z', contest_time_ms: 5_400_000 }),
    event({ rid: 'star-ac', source_seq: 5, status: 'ACCEPTED', uid: 102, pid: 1001, occurred_at: '2026-08-30T02:30:00.000Z', contest_time_ms: 1_800_000 }),
    event({ rid: 'team-2-ac', source_seq: 6, status: 'ACCEPTED', uid: 103, pid: 1001, occurred_at: '2026-08-30T03:00:00.000Z', contest_time_ms: 3_600_000 }),
    event({ rid: 'future-ac', source_seq: 7, status: 'ACCEPTED', uid: 103, pid: 1002, occurred_at: '2026-08-30T04:01:00.000Z' }),
    event({ rid: 'pending', source_seq: 8, status: 'PENDING', uid: 103, pid: 1002, occurred_at: '2026-08-30T03:10:00.000Z' }),
  ];
  const payload = batch(events);
  const path = `/api/v1/sites/${siteId}/events:batch`;
  const request = signed(path, 'POST', payload);
  assert.equal((await hub.app.inject({ method: 'POST', url: path, headers: request.headers, payload: request.rawBody })).statusCode, 200);

  const publicBoard = await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/scoreboard?view=public` });
  assert.equal(publicBoard.statusCode, 200);
  const publicTeam = publicBoard.json().rows.find((row: { team: { team_id: string } }) => row.team.team_id === 'team-1');
  assert.equal(publicTeam.solved, 1);
  assert.equal(publicTeam.penalty_minutes, 60, '40 minute solve plus one WA; CE is not penalized');
  assert.equal(publicTeam.problems[1].status, 'PENDING');
  assert.equal(publicTeam.rank, 1);
  assert.equal(publicBoard.json().rows.find((row: { team: { team_id: string } }) => row.team.team_id === 'team-2').rank, 2,
    'last accepted time breaks an otherwise equal solved/penalty tie');
  assert.equal(publicBoard.json().rows.find((row: { team: { team_id: string } }) => row.team.team_id === 'team-2').solved, 1,
    'a future-dated submission does not enter the scoreboard before its submitted_at');
  assert.equal(publicBoard.json().rows.find((row: { team: { team_id: string } }) => row.team.team_id === 'team-2').problems[1].pending, 1,
    'a real pending submission remains pending outside the freeze mask');
  assert.equal(publicBoard.json().rows.find((row: { team: { team_id: string } }) => row.team.team_id === 'team-star').rank, null);

  const xcpcio = await hub.app.inject({ method: 'GET', url: '/api/v1/scoreboard/xcpcio.json' });
  assert.equal(xcpcio.statusCode, 200, xcpcio.body);
  assert.equal(xcpcio.json().submissions.find((item: { submission_id: string }) => (
    item.submission_id.endsWith('/frozen-ac')
  )).status, 'FROZEN');
  assert.equal(xcpcio.json().league_status.complete, false);
  assert.deepEqual(xcpcio.json().contest.medal, configuration().contest.xcpcio_medals);
  assert.deepEqual(
    xcpcio.json().teams.find((team: { team_id: string }) => team.team_id === 'team-1'),
    {
      team_id: 'team-1',
      name: '一队',
      organization: 'A 校',
      members: [],
      group: ['official', 'freshman'],
      badge: { url: 'https://scoreboard.example/assets/school-a.png' },
    },
  );
  assert.match(xcpcio.json().league_status.message, /当前名次可能不完整/);
  assert.deepEqual(
    Object.keys(xcpcio.json().league_status.sites[0]).sort(),
    ['name', 'school_name', 'site_id', 'status'],
  );
  assert.equal((await hub.app.inject({
    method: 'GET',
    url: '/api/v1/scoreboard/xcpcio.json?view=jury',
  })).statusCode, 400, 'the browser-facing XCPCIO source is always public');

  assert.equal((await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/scoreboard?view=jury` })).statusCode, 401);
  const juryBoard = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/scoreboard?view=jury`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(juryBoard.statusCode, 200);
  const juryTeam = juryBoard.json().rows.find((row: { team: { team_id: string } }) => row.team.team_id === 'team-1');
  assert.equal(juryTeam.solved, 2);
  assert.equal(juryTeam.penalty_minutes, 150);
  assert.equal(juryTeam.problems[0].num_judged, 3, 'CE, WA, and the first AC are all judged submissions');
  const contestApiScoreboard = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/scoreboard`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const contestApiTeam1 = contestApiScoreboard.json().rows.find((row: { team_id: string }) => row.team_id === 'team-1');
  const contestApiTeam2 = contestApiScoreboard.json().rows.find((row: { team_id: string }) => row.team_id === 'team-2');
  assert.equal(contestApiTeam1.problems[0].num_judged, 3);
  assert.equal(contestApiTeam2.problems[1].num_pending, 1);

  now = new Date('2026-08-30T07:00:00.000Z');
  const afterContest = await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/scoreboard?view=public` });
  const stillFrozenTeam = afterContest.json().rows.find((row: { team: { team_id: string } }) => row.team.team_id === 'team-1');
  assert.equal(afterContest.json().frozen, true, 'null unfreeze_at keeps results frozen after contest end');
  assert.equal(stillFrozenTeam.solved, 1);
});

test('public page polling observes time-based site status changes without a new submission cursor', async (t) => {
  const hub = await createConfiguredHub();
  t.after(() => hub.app.close());

  const heartbeatPath = `/api/v1/sites/${siteId}/heartbeat`;
  const heartbeatPayload = {
    protocol_version: '1.0', league_id: leagueId, site_id: siteId, sent_at: now.toISOString(),
    pending_events: 0, rejected_events: 0, agent_version: '0.1.0', hydro_version: '5.0.0-beta.9',
  };
  const heartbeat = signed(heartbeatPath, 'POST', heartbeatPayload);
  assert.equal((await hub.app.inject({
    method: 'POST', url: heartbeatPath, headers: heartbeat.headers, payload: heartbeat.rawBody,
  })).statusCode, 200);

  const online = await hub.app.inject({ method: 'GET', url: '/api/v1/scoreboard/public?cursor=0' });
  assert.equal(online.statusCode, 200, online.body);
  assert.equal(online.json().snapshot.sites[0].status, 'ONLINE');
  const { cursor, revision } = online.json();

  const unchanged = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/scoreboard/public?cursor=${cursor}&revision=${encodeURIComponent(revision)}`,
  });
  assert.equal(unchanged.json().unchanged, true);

  now = new Date(now.getTime() + 180_000);
  const offline = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/scoreboard/public?cursor=${cursor}&revision=${encodeURIComponent(revision)}`,
  });
  assert.equal(offline.statusCode, 200, offline.body);
  assert.equal(offline.json().unchanged, false);
  assert.equal(offline.json().cursor, cursor, 'site status can change while the submission cursor is stable');
  assert.notEqual(offline.json().revision, revision);
  assert.equal(offline.json().snapshot.sites[0].status, 'OFFLINE');
  assert.match(offline.json().snapshot.accuracy.message, /已断开连接/);
});

test('site status, cursor stream, quarantine, snapshot, Contest API, and CDP export work end-to-end', async (t) => {
  const hub = await createConfiguredHub();
  t.after(() => hub.app.close());

  const initialStatus = await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/sites/status` });
  assert.equal(initialStatus.json().sites[0].status, 'OFFLINE');
  assert.equal(initialStatus.json().complete, false);

  const heartbeatPath = `/api/v1/sites/${siteId}/heartbeat`;
  const heartbeatPayload = {
    protocol_version: '1.0', league_id: leagueId, site_id: siteId, sent_at: now.toISOString(),
    pending_events: 0, rejected_events: 0, agent_version: '0.1.0', hydro_version: '5.0.0-beta.9',
  };
  const heartbeat = signed(heartbeatPath, 'POST', heartbeatPayload);
  assert.equal((await hub.app.inject({ method: 'POST', url: heartbeatPath, headers: heartbeat.headers, payload: heartbeat.rawBody })).statusCode, 200);
  assert.equal((await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/sites/status` })).json().sites[0].status, 'ONLINE');
  const backlogHeartbeatPayload = {
    ...heartbeatPayload,
    pending_events: 3,
    rejected_events: 1,
    last_acked_source_seq: 7,
  };
  const backlogHeartbeat = signed(heartbeatPath, 'POST', backlogHeartbeatPayload);
  assert.equal((await hub.app.inject({
    method: 'POST', url: heartbeatPath, headers: backlogHeartbeat.headers, payload: backlogHeartbeat.rawBody,
  })).statusCode, 200);
  const backlogStatus = await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/sites/status` });
  assert.equal(backlogStatus.json().sites[0].status, 'ONLINE');
  assert.equal(backlogStatus.json().sites[0].pending_events, 3);
  assert.equal(backlogStatus.json().sites[0].rejected_events, 1);
  assert.equal(backlogStatus.json().complete, false, 'a live heartbeat with queued work is not complete');
  assert.match(backlogStatus.json().message, /同步积压 3 条.*存在 1 条拒绝事件/);
  const clearedHeartbeat = signed(heartbeatPath, 'POST', heartbeatPayload);
  assert.equal((await hub.app.inject({
    method: 'POST', url: heartbeatPath, headers: clearedHeartbeat.headers, payload: clearedHeartbeat.rawBody,
  })).statusCode, 200);
  assert.equal((await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/sites/status` })).json().complete, true);
  now = new Date(now.getTime() + 60_000);
  assert.equal((await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/sites/status` })).json().sites[0].status, 'DELAYED');
  now = new Date(now.getTime() + 120_000);
  assert.equal((await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/sites/status` })).json().sites[0].status, 'OFFLINE');

  const snapshotPath = `/api/v1/sites/${siteId}/snapshot`;
  const snapshotPayload = {
    protocol_version: '1.0',
    snapshot_id: '00000000-0000-4000-8000-000000000010',
    league_id: leagueId,
    site_id: siteId,
    generated_at: now.toISOString(),
    chunk_index: 0,
    complete: true,
    events: [
      event({ rid: 'mapped', source_seq: 10, status: 'ACCEPTED', uid: 101, pid: 1001, occurred_at: '2026-08-30T02:50:00.000Z', contest_time_ms: 3_000_000 }),
      event({ rid: 'unmapped', source_seq: 11, status: 'ACCEPTED', uid: 999, pid: 9999, occurred_at: '2026-08-30T02:55:00.000Z', contest_time_ms: 3_300_000 }),
    ],
  };
  const snapshotRequest = signed(snapshotPath, 'POST', snapshotPayload);
  const snapshotResponse = await hub.app.inject({ method: 'POST', url: snapshotPath, headers: snapshotRequest.headers, payload: snapshotRequest.rawBody });
  assert.equal(snapshotResponse.statusCode, 200, snapshotResponse.body);
  assert.equal(snapshotResponse.json().league_id, leagueId);
  assert.equal(EventBatchAckSchema.safeParse(snapshotResponse.json()).success, true, snapshotResponse.body);
  assert.equal(snapshotResponse.json().high_watermark, 11, 'complete snapshot reconciles permanent source sequence gaps');
  const conflictingSnapshotPayload = {
    ...snapshotPayload,
    events: [event({
      rid: 'snapshot-id-reused', source_seq: 12, status: 'ACCEPTED', uid: 101, pid: 1001,
      occurred_at: '2026-08-30T02:56:00.000Z',
    })],
  };
  const conflictingSnapshotRequest = signed(snapshotPath, 'POST', conflictingSnapshotPayload);
  const conflictingSnapshot = await hub.app.inject({
    method: 'POST',
    url: snapshotPath,
    headers: conflictingSnapshotRequest.headers,
    payload: conflictingSnapshotRequest.rawBody,
  });
  assert.equal(conflictingSnapshot.statusCode, 409, conflictingSnapshot.body);
  assert.equal(conflictingSnapshot.json().error, 'BATCH_ID_CONFLICT');
  assert.equal(hub.database.getEvents().some((item) => item.rid === 'snapshot-id-reused'), false);

  const quarantine = await hub.app.inject({
    method: 'GET', url: '/api/v1/admin/quarantine', headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(quarantine.json().count, 1);
  assert.equal(quarantine.json().items[0].rid, 'unmapped');

  const publicStream = await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/submissions?view=public&cursor=0` });
  assert.equal(publicStream.statusCode, 200);
  assert.equal(publicStream.json().items.some((item: { rid: string }) => item.rid === 'unmapped'), false);
  assert.ok(publicStream.json().cursor > 0);

  const juryStreamPath = `/api/v1/leagues/${leagueId}/submissions?view=jury&cursor=0`;
  const juryStreamAuth = signed(juryStreamPath, 'GET');
  const juryStream = await hub.app.inject({ method: 'GET', url: juryStreamPath, headers: juryStreamAuth.headers });
  assert.equal(juryStream.statusCode, 200, juryStream.body);
  assert.equal(juryStream.json().items.some((item: { quarantined: boolean }) => item.quarantined), true, juryStream.body);

  const feedPath = `/api/contests/${leagueId}/event-feed?since_token=0&stream=false`;
  assert.equal((await hub.app.inject({ method: 'GET', url: feedPath })).statusCode, 401);
  const feedAuth = signed(feedPath, 'GET');
  const feed = await hub.app.inject({ method: 'GET', url: feedPath, headers: feedAuth.headers });
  assert.equal(feed.statusCode, 200, feed.body);
  const notifications = feed.body.trim().split('\n').map((line) => JSON.parse(line) as {
    type: string; id: string | null; data: Record<string, unknown>; token?: string; op?: string;
  });
  assert.ok(notifications.some((item) => item.type === 'contest' && item.id === null));
  assert.ok(notifications.some((item) => item.type === 'state' && item.id === null));
  assert.ok(notifications.some((item) => item.type === 'awards' && item.id === 'winner'));
  assert.equal(notifications.some((item) => item.type === 'scoreboard'), false, 'aggregate scoreboard has no notification');
  assert.equal(notifications.some((item) => item.op !== undefined), false, '2023-06 notifications have no legacy op field');
  for (const notification of notifications.filter((item) => item.id !== null)) {
    assert.equal(notification.id, notification.data.id, `${notification.type} notification uses the object id`);
  }
  const invalidFeed = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/event-feed?since_token=not-a-token&stream=false`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(invalidFeed.statusCode, 400);

  const publicXcpcio = await hub.app.inject({
    method: 'GET', url: `/api/v1/leagues/${leagueId}/xcpcio.json?view=public`,
  });
  assert.equal(publicXcpcio.statusCode, 200, publicXcpcio.body);
  assert.equal(publicXcpcio.json().contest.penalty, 1_200);
  assert.equal(publicXcpcio.json().submissions.length, 1);
  assert.equal((await hub.app.inject({
    method: 'GET', url: `/api/v1/leagues/${leagueId}/xcpcio.json?view=jury`,
  })).statusCode, 401);
  const juryXcpcio = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/xcpcio.json?view=jury`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(juryXcpcio.statusCode, 200, juryXcpcio.body);
  assert.equal(juryXcpcio.json().submissions[0].status, 'CORRECT');

  const contestResource = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(contestResource.statusCode, 200, contestResource.body);
  assert.equal(contestResource.json().penalty_time, 20, 'Contest API penalty_time is measured in minutes');
  assert.equal(contestResource.json().scoreboard_type, 'pass-fail');
  const teamItem = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/teams/team-1`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(teamItem.statusCode, 200, teamItem.body);
  assert.equal(teamItem.json().id, 'team-1');
  assert.deepEqual(teamItem.json().group_ids, ['official', 'freshman']);
  const organizationItem = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/organizations/school-a`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(organizationItem.statusCode, 200, organizationItem.body);
  assert.equal(organizationItem.json().logo, undefined, 'unverified remote images are not Contest API FILEs');
  const awards = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/awards`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(awards.statusCode, 200, awards.body);
  assert.deepEqual(awards.json(), [
    { id: 'winner', citation: 'Champion', team_ids: ['team-1'] },
    { id: 'first-to-solve-a', citation: 'First to solve problem A', team_ids: ['team-2'] },
    { id: 'first-to-solve-b', citation: 'First to solve problem B', team_ids: [] },
  ]);
  const missingTeamItem = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/teams/missing-team`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(missingTeamItem.statusCode, 404, missingTeamItem.body);

  const earlyCdp = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/cdp.zip`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(earlyCdp.statusCode, 409);
  assert.equal(earlyCdp.json().error, 'contest_not_ended');

  now = new Date('2026-08-30T07:30:00.000Z');
  const unfinalizedCdp = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/cdp.zip`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(unfinalizedCdp.statusCode, 409, unfinalizedCdp.body);
  assert.equal(unfinalizedCdp.json().error, 'contest_not_finalized');

  const publishBeforeFinalization = await hub.app.inject({
    method: 'POST',
    url: `/api/v1/leagues/${leagueId}/publish-results`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(publishBeforeFinalization.statusCode, 409, publishBeforeFinalization.body);
  assert.equal(publishBeforeFinalization.json().error, 'contest_not_finalized');

  const incompleteFinalization = await hub.app.inject({
    method: 'POST',
    url: `/api/v1/leagues/${leagueId}/finalize`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {},
  });
  assert.equal(incompleteFinalization.statusCode, 409, incompleteFinalization.body);
  assert.equal(incompleteFinalization.json().error, 'sites_not_ready');

  const finalized = await hub.app.inject({
    method: 'POST',
    url: `/api/v1/leagues/${leagueId}/finalize`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { force: true },
  });
  assert.equal(finalized.statusCode, 200, finalized.body);
  assert.equal(finalized.json().forced, true);
  assert.ok(finalized.json().state.thawed);
  assert.ok(finalized.json().state.finalized);
  assert.ok(finalized.json().state.end_of_updates);

  const cdp = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/cdp.zip`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(cdp.statusCode, 200, cdp.body);
  const files = unzipSync(new Uint8Array(cdp.rawPayload));
  for (const filename of ['api.json', 'contest.json', 'contest.yaml', 'problems.json', 'problems.yaml', 'awards.json', 'event-feed.ndjson']) {
    assert.ok(files[filename], `CDP contains ${filename}`);
  }
  const cdpContest = JSON.parse(strFromU8(files['contest.json']!));
  assert.equal(cdpContest.penalty_time, 20);
  assert.equal(files['organizations/school-a/school-a.png'], undefined, 'absolute badge URLs are not local CDP files');
  assert.deepEqual(JSON.parse(strFromU8(files['awards.json']!)), awards.json());
  const cdpFeed = strFromU8(files['event-feed.ndjson']!).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(cdpFeed.some((item) => Object.hasOwn(item, 'op')), false);
  assert.deepEqual(
    cdpFeed.filter((item) => item.type === 'awards').map((item) => item.data),
    awards.json(),
  );
  assert.deepEqual(
    cdpFeed.find((item) => item.type === 'organizations')?.data.logo,
    organizationItem.json().logo,
  );
  assert.equal(cdpFeed.at(-1).type, 'state');
  assert.equal(cdpFeed.at(-1).id, null);
  assert.ok(cdpFeed.at(-1).data.thawed, 'a finalized frozen Resolver package is explicitly thawed');
  assert.ok(cdpFeed.at(-1).data.finalized);
  assert.ok(cdpFeed.at(-1).data.end_of_updates);
  assert.ok(Date.parse(cdpFeed.at(-1).data.end_of_updates) > Date.parse(cdpFeed.at(-1).data.thawed));
  assert.ok(Date.parse(cdpFeed.at(-1).data.end_of_updates) > Date.parse(cdpFeed.at(-1).data.finalized));
  const finalToken = Number(cdpFeed.at(-1).token);
  const persistedState = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/state`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(persistedState.json().finalized, cdpFeed.at(-1).data.finalized);
  assert.equal(persistedState.json().end_of_updates, cdpFeed.at(-1).data.end_of_updates);
  const noRollback = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/event-feed?since_token=${finalToken}&stream=false`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(noRollback.statusCode, 200, noRollback.body);
  assert.equal(noRollback.body, '', 'normal live feed does not append a finalized-to-null rollback');

  const latePayload = batch([event({
    rid: 'after-finalization', source_seq: 12, status: 'ACCEPTED', uid: 101, pid: 1002,
    occurred_at: '2026-08-30T03:10:00.000Z',
  })]);
  const lateRequest = signed(`/api/v1/sites/${siteId}/events:batch`, 'POST', latePayload);
  const lateEvent = await hub.app.inject({
    method: 'POST',
    url: `/api/v1/sites/${siteId}/events:batch`,
    headers: lateRequest.headers,
    payload: lateRequest.rawBody,
  });
  assert.equal(lateEvent.statusCode, 409, lateEvent.body);
  assert.equal(lateEvent.json().error, 'contest_finalized');
  assert.equal(hub.database.getEvents().some((item) => item.rid === 'after-finalization'), false);

  const postFinalConfig = await hub.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: configuration(),
  });
  assert.equal(postFinalConfig.statusCode, 409, postFinalConfig.body);
  assert.equal(postFinalConfig.json().error, 'contest_finalized');

  const frozenBeforePublication = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/scoreboard?view=public`,
  });
  assert.equal(frozenBeforePublication.json().frozen, true);
  const published = await hub.app.inject({
    method: 'POST',
    url: `/api/v1/leagues/${leagueId}/publish-results`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().frozen, false);
  const publicFinal = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/scoreboard?view=public`,
  });
  assert.equal(publicFinal.json().frozen, false);

  const terminalFeed = await hub.app.inject({
    method: 'GET',
    url: `/api/contests/${leagueId}/event-feed?since_token=${finalToken}&stream=false`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(terminalFeed.statusCode, 200, terminalFeed.body);
  assert.equal(terminalFeed.body, '', 'end_of_updates remains the last event after rejected late writes');
});
