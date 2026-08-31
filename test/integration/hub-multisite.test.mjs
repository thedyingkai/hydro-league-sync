import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import {
  AUTH_HEADERS,
  canonicalJson,
  createHubApplication,
  createRequestSignature,
} from '../../packages/league-hub/dist/src/index.js';

const leagueId = 'three-school-league';
const adminToken = 'integration-admin-token-kept-local-only';
const secrets = {
  'school-a': 'integration-school-a-secret-at-least-32-bytes',
  'school-b': 'integration-school-b-secret-at-least-32-bytes',
  'school-c': 'integration-school-c-secret-at-least-32-bytes',
};

let now = new Date('2026-08-30T04:00:00.000Z');

function configuration() {
  const sites = Object.keys(secrets).map((siteId) => ({
    site_id: siteId,
    name: `${siteId.toUpperCase()} Hydro`,
    school_name: `${siteId.toUpperCase()} 学校`,
    secret: secrets[siteId],
  }));
  const teams = [
    { team_id: 'team-a', name: 'A 队', school_id: 'school-a', school_name: 'A 学校', official: true },
    { team_id: 'team-b-star', name: 'B 打星队', school_id: 'school-b', school_name: 'B 学校', official: false },
    { team_id: 'team-c', name: 'C 队', school_id: 'school-c', school_name: 'C 学校', official: true },
  ];
  const localUids = { 'school-a': '101', 'school-b': '201', 'school-c': '301' };
  return {
    contest: {
      contest_id: leagueId,
      name: '三校联赛集成测试',
      start_time: '2026-08-30T02:00:00.000Z',
      freeze_time: '2026-08-30T03:20:00.000Z',
      end_time: '2026-08-30T06:00:00.000Z',
      penalty_minutes: 20,
    },
    sites,
    teams,
    problems: [
      { problem_id: 'problem-a', label: 'A', name: 'Alpha', ordinal: 0 },
      { problem_id: 'problem-b', label: 'B', name: 'Beta', ordinal: 1 },
    ],
    team_mappings: sites.map(({ site_id: siteId }, index) => ({
      site_id: siteId,
      domain_id: 'system',
      contest_id: String(index + 1),
      local_uid: localUids[siteId],
      team_id: teams[index].team_id,
    })),
    problem_mappings: sites.flatMap(({ site_id: siteId }, index) => [
      {
        site_id: siteId,
        domain_id: 'system',
        contest_id: String(index + 1),
        local_pid: String((index + 1) * 1000 + 1),
        problem_id: 'problem-a',
      },
      {
        site_id: siteId,
        domain_id: 'system',
        contest_id: String(index + 1),
        local_pid: String((index + 1) * 1000 + 2),
        problem_id: 'problem-b',
      },
    ]),
  };
}

function submission(siteId, values) {
  const siteNumber = Number(siteId.at(-1).charCodeAt(0) - 96);
  const submittedAt = values.submitted_at;
  return {
    protocol_version: '1.0',
    event_type: 'submission.upsert',
    league_id: leagueId,
    site_id: siteId,
    source_seq: values.source_seq,
    domain_id: 'system',
    contest_id: String(siteNumber),
    rid: values.rid,
    uid: values.uid,
    pid: values.pid,
    status: values.status,
    submitted_at: submittedAt,
    ...(values.judged_at ? { judged_at: values.judged_at } : {}),
    rejudged: values.rejudged ?? false,
    emitted_at: values.emitted_at ?? submittedAt,
  };
}

function batch(siteId, events, batchId = randomUUID()) {
  return {
    protocol_version: '1.0',
    batch_id: batchId,
    league_id: leagueId,
    site_id: siteId,
    sent_at: now.toISOString(),
    events,
  };
}

function signed(siteId, path, method, body) {
  const rawBody = body === undefined ? '' : canonicalJson(body);
  const timestamp = String(Math.floor(now.getTime() / 1000));
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
        secret: secrets[siteId],
      }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  };
}

async function sendBatch(hub, siteId, payload) {
  const path = `/api/v1/sites/${siteId}/events:batch`;
  const request = signed(siteId, path, 'POST', payload);
  return hub.app.inject({ method: 'POST', url: path, headers: request.headers, payload: request.rawBody });
}

async function heartbeat(hub, siteId) {
  const path = `/api/v1/sites/${siteId}/heartbeat`;
  const payload = {
    protocol_version: '1.0',
    league_id: leagueId,
    site_id: siteId,
    sent_at: now.toISOString(),
    pending_events: 0,
    rejected_events: 0,
    last_acked_source_seq: hub.database.highWatermark(siteId, leagueId),
    agent_version: '0.1.0',
    hydro_version: '5.0.0-beta.9',
  };
  const request = signed(siteId, path, 'POST', payload);
  const response = await hub.app.inject({ method: 'POST', url: path, headers: request.headers, payload: request.rawBody });
  assert.equal(response.statusCode, 200, response.body);
}

test('three schools merge reliably into frozen public, jury, and Resolver views', async (t) => {
  const hub = createHubApplication({
    databasePath: ':memory:',
    adminToken,
    delayedAfterMs: 30_000,
    offlineAfterMs: 120_000,
    now: () => now,
  });
  t.after(() => hub.app.close());

  const configured = await hub.app.inject({
    method: 'PUT',
    url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` },
    payload: configuration(),
  });
  assert.equal(configured.statusCode, 200, configured.body);

  const schoolAEvents = [
    submission('school-a', { rid: 'a-ac', source_seq: 3, status: 'ACCEPTED', uid: 101, pid: 1001, submitted_at: '2026-08-30T02:40:00.000Z' }),
    submission('school-a', { rid: 'a-ce', source_seq: 1, status: 'COMPILE_ERROR', uid: 101, pid: 1001, submitted_at: '2026-08-30T02:05:00.000Z' }),
    submission('school-a', { rid: 'a-frozen-ac', source_seq: 4, status: 'ACCEPTED', uid: 101, pid: 1002, submitted_at: '2026-08-30T03:30:00.000Z', judged_at: '2026-08-30T03:31:00.000Z' }),
    submission('school-a', { rid: 'a-wa', source_seq: 2, status: 'WRONG_ANSWER', uid: 101, pid: 1001, submitted_at: '2026-08-30T02:20:00.000Z' }),
  ];
  const aBatch = batch('school-a', schoolAEvents, '10000000-0000-4000-8000-000000000001');
  const noAuth = await hub.app.inject({
    method: 'POST',
    url: '/api/v1/sites/school-a/events:batch',
    payload: aBatch,
  });
  assert.equal(noAuth.statusCode, 401);
  const acceptedA = await sendBatch(hub, 'school-a', aBatch);
  assert.equal(acceptedA.statusCode, 200, acceptedA.body);
  assert.equal(acceptedA.json().accepted_count, 4);
  assert.equal(acceptedA.json().high_watermark, 4, 'out-of-order delivery still closes the contiguous sequence');
  const duplicateA = await sendBatch(hub, 'school-a', aBatch);
  assert.deepEqual(duplicateA.json(), acceptedA.json(), 'batch retry is idempotent');

  const acceptedB = await sendBatch(hub, 'school-b', batch('school-b', [
    submission('school-b', { rid: 'b-star-ac', source_seq: 1, status: 'ACCEPTED', uid: 201, pid: 2001, submitted_at: '2026-08-30T02:30:00.000Z' }),
    submission('school-b', { rid: 'b-unmapped', source_seq: 2, status: 'ACCEPTED', uid: 999, pid: 9999, submitted_at: '2026-08-30T02:35:00.000Z' }),
  ], '20000000-0000-4000-8000-000000000001'));
  assert.equal(acceptedB.statusCode, 200, acceptedB.body);
  assert.equal(acceptedB.json().high_watermark, 2);

  const cSubmittedAt = '2026-08-30T02:15:00.000Z';
  const initialC = await sendBatch(hub, 'school-c', batch('school-c', [
    submission('school-c', { rid: 'c-rejudge', source_seq: 1, status: 'WRONG_ANSWER', uid: 301, pid: 3001, submitted_at: cSubmittedAt, judged_at: '2026-08-30T02:16:00.000Z' }),
  ], '30000000-0000-4000-8000-000000000001'));
  assert.equal(initialC.statusCode, 200, initialC.body);
  const beforeRejudge = hub.database.getEvents().find((event) => event.rid === 'c-rejudge');
  assert.ok(beforeRejudge);
  const acceptedC = await sendBatch(hub, 'school-c', batch('school-c', [
    submission('school-c', { rid: 'c-rejudge', source_seq: 2, status: 'ACCEPTED', uid: 301, pid: 3001, submitted_at: cSubmittedAt, judged_at: '2026-08-30T02:18:00.000Z', rejudged: true }),
  ], '30000000-0000-4000-8000-000000000002'));
  assert.equal(acceptedC.statusCode, 200, acceptedC.body);
  assert.equal(acceptedC.json().high_watermark, 2);
  const cStored = hub.database.getEvents().filter((event) => event.rid === 'c-rejudge');
  assert.equal(cStored.length, 1);
  assert.equal(cStored[0].status, 'ACCEPTED');
  assert.equal(cStored[0].event_id, beforeRejudge.event_id, 'rejudge retains one stable submission identity');

  now = new Date('2026-08-30T04:03:00.000Z');
  await heartbeat(hub, 'school-a');
  await heartbeat(hub, 'school-b');

  const publicBoardResponse = await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/scoreboard?view=public` });
  assert.equal(publicBoardResponse.statusCode, 200, publicBoardResponse.body);
  const publicBoard = publicBoardResponse.json();
  const teamA = publicBoard.rows.find((row) => row.team.team_id === 'team-a');
  const starTeam = publicBoard.rows.find((row) => row.team.team_id === 'team-b-star');
  assert.equal(teamA.solved, 1);
  assert.equal(teamA.penalty_minutes, 60, '40-minute AC plus one WA; CE adds no penalty');
  assert.equal(teamA.problems.find((problem) => problem.problem_id === 'problem-b').status, 'PENDING');
  assert.equal(starTeam.rank, null, 'unofficial team is retained but unranked');
  assert.equal(publicBoard.accuracy.complete, false);
  assert.match(publicBoard.accuracy.message, /SCHOOL-C 学校已断开连接.*当前名次可能不完整/);
  assert.equal(publicBoard.rows.some((row) => row.team.team_id === 'team-c'), true, 'offline school remains on the board');
  assert.equal(publicBoard.sites.find((site) => site.site_id === 'school-c').status, 'OFFLINE');

  const publicFeed = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/submissions?view=public&cursor=0&limit=100`,
  });
  const frozenSubmission = publicFeed.json().items.find((item) => item.rid === 'a-frozen-ac');
  assert.equal(frozenSubmission.status, 'FROZEN');
  assert.equal(frozenSubmission.judged_at, null, 'public cursor feed does not leak a frozen verdict');

  const unauthorizedJury = await hub.app.inject({ method: 'GET', url: `/api/v1/leagues/${leagueId}/scoreboard?view=jury` });
  assert.equal(unauthorizedJury.statusCode, 401);
  const juryBoardResponse = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/scoreboard?view=jury`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  const juryTeamA = juryBoardResponse.json().rows.find((row) => row.team.team_id === 'team-a');
  assert.equal(juryTeamA.solved, 2);
  assert.equal(juryTeamA.penalty_minutes, 150);

  const publicXcpcioResponse = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/xcpcio.json?view=public`,
  });
  assert.equal(publicXcpcioResponse.statusCode, 200, publicXcpcioResponse.body);
  const publicXcpcio = publicXcpcioResponse.json();
  assert.equal(publicXcpcio.contest.penalty, 1_200);
  assert.equal(publicXcpcio.teams.find((team) => team.team_id === 'team-b-star').group.includes('unofficial'), true);
  assert.equal(publicXcpcio.submissions.find((item) => item.submission_id.endsWith('/a-frozen-ac')).status, 'FROZEN');
  assert.equal(publicXcpcio.submissions.find((item) => item.submission_id.endsWith('/a-ce')).status, 'COMPILATION_ERROR');
  assert.equal(publicXcpcio.submissions.find((item) => item.submission_id.endsWith('/a-wa')).status, 'REJECTED');

  const unauthorizedXcpcioJury = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/xcpcio.json?view=jury`,
  });
  assert.equal(unauthorizedXcpcioJury.statusCode, 401);
  const juryXcpcioResponse = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/xcpcio.json?view=jury`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(juryXcpcioResponse.statusCode, 200, juryXcpcioResponse.body);
  assert.equal(juryXcpcioResponse.json().submissions.find((item) => item.submission_id.endsWith('/a-frozen-ac')).status, 'CORRECT');

  const quarantine = await hub.app.inject({
    method: 'GET',
    url: '/api/v1/admin/quarantine',
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(quarantine.json().count, 1);
  assert.equal(quarantine.json().items[0].rid, 'b-unmapped');

  const earlyCdp = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/cdp.zip`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(earlyCdp.statusCode, 409);
  assert.equal(earlyCdp.json().error, 'contest_not_ended');

  now = new Date('2026-08-30T07:30:00.000Z');
  const finalize = await hub.app.inject({
    method: 'POST',
    url: `/api/v1/leagues/${leagueId}/finalize`,
    headers: { authorization: `Bearer ${adminToken}` },
    payload: { force: true },
  });
  assert.equal(finalize.statusCode, 200, finalize.body);
  assert.equal(finalize.json().forced, true);
  const cdp = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/cdp.zip`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(cdp.statusCode, 200, cdp.body);
  const files = unzipSync(new Uint8Array(cdp.rawPayload));
  for (const filename of ['api.json', 'contest.json', 'contest.yaml', 'problems.json', 'problems.yaml', 'event-feed.ndjson']) {
    assert.ok(files[filename], `Resolver CDP contains ${filename}`);
  }
  const contest = JSON.parse(strFromU8(files['contest.json']));
  assert.equal(contest.penalty_time, 20);
  const feed = strFromU8(files['event-feed.ndjson']).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(feed.some((notification) => Object.hasOwn(notification, 'op')), false);
  assert.equal(feed.some((notification) => notification.type === 'scoreboard'), false);
  const finalState = feed.filter((notification) => notification.type === 'state').at(-1);
  assert.equal(finalState.id, null);
  assert.ok(finalState.data.thawed);
  assert.ok(finalState.data.finalized);
  assert.ok(finalState.data.end_of_updates);

  const published = await hub.app.inject({
    method: 'POST',
    url: `/api/v1/leagues/${leagueId}/publish-results`,
    headers: { authorization: `Bearer ${adminToken}` },
  });
  assert.equal(published.statusCode, 200, published.body);
  assert.equal(published.json().frozen, false);
  const publishedXcpcio = await hub.app.inject({
    method: 'GET',
    url: `/api/v1/leagues/${leagueId}/xcpcio.json?view=public`,
  });
  assert.equal(publishedXcpcio.statusCode, 200, publishedXcpcio.body);
  assert.equal(
    publishedXcpcio.json().submissions.find((item) => item.submission_id.endsWith('/a-frozen-ac')).status,
    'CORRECT',
    'publishing results also thaws the public XCPCIO board',
  );
});
