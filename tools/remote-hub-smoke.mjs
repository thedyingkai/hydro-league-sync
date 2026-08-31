import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { strFromU8, unzipSync } from 'fflate';
import {
  HMAC_HEADER_NAMES as AUTH_HEADERS,
  canonicalJson,
  signRequest as createRequestSignature,
} from '../packages/protocol/dist/index.js';

const baseUrl = new URL(process.env.HYDRO_LEAGUE_SMOKE_URL ?? 'http://127.0.0.1:3100');
const adminToken = process.env.HYDRO_LEAGUE_SMOKE_ADMIN_TOKEN ?? '';
const confirmation = process.env.HYDRO_LEAGUE_SMOKE_CONFIRM ?? '';

assert.equal(confirmation, 'isolated-smoke-volume', 'set HYDRO_LEAGUE_SMOKE_CONFIRM=isolated-smoke-volume');
assert.ok(Buffer.byteLength(adminToken, 'utf8') >= 32, 'HYDRO_LEAGUE_SMOKE_ADMIN_TOKEN must contain at least 32 UTF-8 bytes');
assert.equal(baseUrl.pathname, '/', 'smoke URL must use an origin without a path');
assert.equal(baseUrl.search, '', 'smoke URL must not include a query');
assert.equal(baseUrl.hash, '', 'smoke URL must not include a fragment');
assert.ok(['http:', 'https:'].includes(baseUrl.protocol), 'smoke URL must use HTTP or HTTPS');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname), 'smoke testing is allowed only over loopback');
assert.equal(baseUrl.port || (baseUrl.protocol === 'https:' ? '443' : '80'), '3100', 'smoke testing is restricted to the isolated port 3100');

const runId = new Date().toISOString().replaceAll(/[-:.TZ]/g, '').slice(0, 14);
const leagueId = `remote-smoke-${runId}`;
const secrets = Object.fromEntries(['school-a', 'school-b', 'school-c'].map((siteId) => [
  siteId,
  randomBytes(32).toString('hex'),
]));
const siteNumbers = { 'school-a': 1, 'school-b': 2, 'school-c': 3 };

const clock = Date.now();
const contestStart = new Date(clock - 4 * 60 * 60 * 1000);
const freezeTime = new Date(clock - 2 * 60 * 60 * 1000);
const contestEnd = new Date(clock - 60 * 60 * 1000);
const atMinutes = (minutes) => new Date(contestStart.getTime() + minutes * 60_000).toISOString();

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
      name: '远程三校联赛验收',
      start_time: contestStart.toISOString(),
      freeze_time: freezeTime.toISOString(),
      end_time: contestEnd.toISOString(),
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
  return {
    protocol_version: '1.0',
    event_type: 'submission.upsert',
    league_id: leagueId,
    site_id: siteId,
    source_seq: values.source_seq,
    domain_id: 'system',
    contest_id: String(siteNumbers[siteId]),
    rid: values.rid,
    uid: values.uid,
    pid: values.pid,
    status: values.status,
    submitted_at: values.submitted_at,
    ...(values.judged_at ? { judged_at: values.judged_at } : {}),
    rejudged: values.rejudged ?? false,
    emitted_at: values.emitted_at ?? values.submitted_at,
  };
}

function batch(siteId, events, batchId = randomUUID()) {
  return {
    protocol_version: '1.0',
    batch_id: batchId,
    league_id: leagueId,
    site_id: siteId,
    sent_at: new Date().toISOString(),
    events,
  };
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), { redirect: 'manual', ...options });
  const raw = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(raw);
  let json;
  if (text && response.headers.get('content-type')?.includes('json')) json = JSON.parse(text);
  return { response, raw, text, json };
}

function expectStatus(result, expected, label) {
  assert.equal(result.response.status, expected, `${label}: ${result.response.status} ${result.text}`);
  return result;
}

async function adminRequest(path, method = 'GET', body) {
  return request(path, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function signedRequest(siteId, path, method, body) {
  const rawBody = body === undefined ? '' : canonicalJson(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID();
  return request(path, {
    method,
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
    ...(body === undefined ? {} : { body: rawBody }),
  });
}

async function sendBatch(siteId, payload) {
  const path = `/api/v1/sites/${siteId}/events:batch`;
  return signedRequest(siteId, path, 'POST', payload);
}

async function heartbeat(siteId, highWatermark) {
  const path = `/api/v1/sites/${siteId}/heartbeat`;
  const payload = {
    protocol_version: '1.0',
    league_id: leagueId,
    site_id: siteId,
    sent_at: new Date().toISOString(),
    pending_events: 0,
    rejected_events: 0,
    last_acked_source_seq: highWatermark,
    agent_version: 'remote-smoke',
    hydro_version: '5.0.0-beta.9',
  };
  expectStatus(await signedRequest(siteId, path, 'POST', payload), 200, `${siteId} heartbeat`);
}

const initialHealth = expectStatus(await request('/healthz'), 200, 'health').json;
assert.equal(initialHealth.status, 'ok');
assert.equal(initialHealth.configured, false, 'refusing to overwrite a configured Hub; use a fresh isolated smoke volume');
assert.ok(Math.abs(Date.now() - Date.parse(initialHealth.time)) < 240_000, 'client and Hub clocks differ by at least four minutes');
expectStatus(await request('/readyz'), 503, 'not ready before configuration');
const emptyConfig = expectStatus(await adminRequest('/api/v1/admin/config'), 200, 'empty configuration').json;
assert.deepEqual(emptyConfig, { configured: false }, 'refusing to overwrite an existing Hub configuration');
const configured = expectStatus(await adminRequest('/api/v1/admin/config', 'PUT', configuration()), 200, 'configure');
assert.equal(configured.json.ok, true);
assert.ok(Number.isSafeInteger(configured.json.cursor) && configured.json.cursor >= 0);
expectStatus(await request('/readyz'), 200, 'ready after configuration');
const exportedConfig = expectStatus(await adminRequest('/api/v1/admin/config'), 200, 'exported configuration').json;
assert.equal(exportedConfig.contest.contest_id, leagueId);
assert.equal(exportedConfig.sites.every((site) => site.has_secret === true && !Object.hasOwn(site, 'secret')), true);

const aEvents = [
  submission('school-a', { rid: 'a-ac', source_seq: 3, status: 'ACCEPTED', uid: 101, pid: 1001, submitted_at: atMinutes(40) }),
  submission('school-a', { rid: 'a-ce', source_seq: 1, status: 'COMPILE_ERROR', uid: 101, pid: 1001, submitted_at: atMinutes(5) }),
  submission('school-a', { rid: 'a-frozen-ac', source_seq: 4, status: 'ACCEPTED', uid: 101, pid: 1002, submitted_at: new Date(freezeTime.getTime() + 10 * 60_000).toISOString() }),
  submission('school-a', { rid: 'a-wa', source_seq: 2, status: 'WRONG_ANSWER', uid: 101, pid: 1001, submitted_at: atMinutes(20) }),
];
const aBatch = batch('school-a', aEvents, '10000000-0000-4000-8000-000000000001');
expectStatus(await request('/api/v1/sites/school-a/events:batch', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(aBatch),
}), 401, 'unsigned batch');
const acceptedA = expectStatus(await sendBatch('school-a', aBatch), 200, 'school A batch');
assert.equal(acceptedA.json.accepted_count, 4);
assert.equal(acceptedA.json.high_watermark, 4);
const duplicateA = expectStatus(await sendBatch('school-a', aBatch), 200, 'school A duplicate batch');
assert.deepEqual(duplicateA.json, acceptedA.json);

const acceptedB = expectStatus(await sendBatch('school-b', batch('school-b', [
  submission('school-b', { rid: 'b-star-ac', source_seq: 1, status: 'ACCEPTED', uid: 201, pid: 2001, submitted_at: atMinutes(30) }),
  submission('school-b', { rid: 'b-unmapped', source_seq: 2, status: 'ACCEPTED', uid: 999, pid: 9999, submitted_at: atMinutes(35) }),
], '20000000-0000-4000-8000-000000000001')), 200, 'school B batch');
assert.equal(acceptedB.json.high_watermark, 2);

const cSubmittedAt = atMinutes(15);
expectStatus(await sendBatch('school-c', batch('school-c', [
  submission('school-c', { rid: 'c-rejudge', source_seq: 1, status: 'WRONG_ANSWER', uid: 301, pid: 3001, submitted_at: cSubmittedAt, judged_at: atMinutes(16) }),
], '30000000-0000-4000-8000-000000000001')), 200, 'school C initial batch');
const acceptedC = expectStatus(await sendBatch('school-c', batch('school-c', [
  submission('school-c', { rid: 'c-rejudge', source_seq: 2, status: 'ACCEPTED', uid: 301, pid: 3001, submitted_at: cSubmittedAt, judged_at: atMinutes(18), rejudged: true }),
], '30000000-0000-4000-8000-000000000002')), 200, 'school C rejudge');
assert.equal(acceptedC.json.high_watermark, 2);

await delay(3500);
await heartbeat('school-a', 4);
await heartbeat('school-b', 2);

const publicBoard = expectStatus(await request(`/api/v1/leagues/${leagueId}/scoreboard?view=public`), 200, 'public board').json;
const teamA = publicBoard.rows.find((row) => row.team.team_id === 'team-a');
const starTeam = publicBoard.rows.find((row) => row.team.team_id === 'team-b-star');
assert.equal(teamA.solved, 1);
assert.equal(teamA.penalty_minutes, 60, 'CE must not add penalty');
assert.equal(publicBoard.frozen, true);
assert.equal(teamA.problems.find((problem) => problem.problem_id === 'problem-b').status, 'PENDING');
assert.equal(starTeam.rank, null);
assert.equal(publicBoard.sites.find((site) => site.site_id === 'school-a').status, 'ONLINE');
assert.equal(publicBoard.sites.find((site) => site.site_id === 'school-b').status, 'ONLINE');
assert.equal(publicBoard.sites.find((site) => site.site_id === 'school-c').status, 'OFFLINE');
assert.equal(publicBoard.accuracy.complete, false);
assert.match(publicBoard.accuracy.message, /当前名次可能不完整/);

expectStatus(await request(`/api/v1/leagues/${leagueId}/scoreboard?view=jury`), 401, 'anonymous jury board');
const juryBoard = expectStatus(await adminRequest(`/api/v1/leagues/${leagueId}/scoreboard?view=jury`), 200, 'jury board').json;
const juryTeamA = juryBoard.rows.find((row) => row.team.team_id === 'team-a');
assert.equal(juryBoard.frozen, false);
assert.equal(juryTeamA.solved, 2);
assert.equal(juryTeamA.penalty_minutes, 190);

const publicSubmissions = expectStatus(await request(`/api/v1/leagues/${leagueId}/submissions?view=public&cursor=0&limit=100`), 200, 'public submissions').json;
const frozenPublicSubmission = publicSubmissions.items.find((item) => item.rid === 'a-frozen-ac');
assert.equal(frozenPublicSubmission.status, 'FROZEN');
assert.equal(frozenPublicSubmission.judged_at, null);

const publicXcpcio = expectStatus(await request(`/api/v1/leagues/${leagueId}/xcpcio.json?view=public`), 200, 'public XCPCIO').json;
assert.equal(publicXcpcio.submissions.find((item) => item.submission_id.endsWith('/a-frozen-ac')).status, 'FROZEN');
assert.equal(publicXcpcio.submissions.find((item) => item.submission_id.endsWith('/a-ce')).status, 'COMPILATION_ERROR');
assert.equal(publicXcpcio.teams.find((team) => team.team_id === 'team-b-star').group.includes('unofficial'), true);
expectStatus(await request('/api/v1/scoreboard/xcpcio.json?view=jury'), 400, 'fixed public endpoint query rejection');

const quarantine = expectStatus(await adminRequest('/api/v1/admin/quarantine'), 200, 'quarantine').json;
assert.equal(quarantine.count, 1);
assert.equal(quarantine.items[0].rid, 'b-unmapped');

const earlyCdp = expectStatus(await adminRequest(`/api/v1/leagues/${leagueId}/cdp.zip`), 409, 'unfinalized CDP');
assert.equal(earlyCdp.json.error, 'contest_not_finalized');
const earlyPublish = expectStatus(await adminRequest(`/api/v1/leagues/${leagueId}/publish-results`, 'POST'), 409, 'unfinalized publish');
assert.equal(earlyPublish.json.error, 'contest_not_finalized');
const guardedFinalize = expectStatus(await adminRequest(`/api/v1/leagues/${leagueId}/finalize`, 'POST', {}), 409, 'incomplete finalize guard');
assert.equal(guardedFinalize.json.error, 'sites_not_ready');
assert.equal(guardedFinalize.json.affected_sites.some((site) => site.site_id === 'school-c'), true);
const finalized = expectStatus(await adminRequest(`/api/v1/leagues/${leagueId}/finalize`, 'POST', { force: true }), 200, 'finalize').json;
assert.equal(finalized.forced, true);
assert.equal(finalized.complete, false);
assert.match(finalized.warning, /当前名次可能不完整/);
assert.ok(finalized.state.thawed);
assert.ok(finalized.state.finalized);
assert.ok(finalized.state.end_of_updates);

const lateEvent = batch('school-a', [
  submission('school-a', { rid: 'a-late', source_seq: 5, status: 'ACCEPTED', uid: 101, pid: 1001, submitted_at: atMinutes(45) }),
]);
assert.equal(expectStatus(await sendBatch('school-a', lateEvent), 409, 'post-finalize event guard').json.error, 'contest_finalized');
assert.equal(expectStatus(await adminRequest('/api/v1/admin/config', 'PUT', configuration()), 409, 'post-finalize config guard').json.error, 'contest_finalized');

const cdp = expectStatus(await adminRequest(`/api/v1/leagues/${leagueId}/cdp.zip`), 200, 'CDP export');
const cdpFiles = unzipSync(cdp.raw);
for (const filename of ['api.json', 'contest.json', 'contest.yaml', 'problems.json', 'problems.yaml', 'event-feed.ndjson']) {
  assert.ok(cdpFiles[filename], `CDP must contain ${filename}`);
}
const cdpContest = JSON.parse(strFromU8(cdpFiles['contest.json']));
assert.equal(cdpContest.penalty_time, 20);
const cdpFeed = strFromU8(cdpFiles['event-feed.ndjson']).trim().split('\n').map((line) => JSON.parse(line));
assert.equal(cdpFeed.some((notification) => Object.hasOwn(notification, 'op')), false);
assert.equal(cdpFeed.some((notification) => notification.type === 'scoreboard'), false);
const finalState = cdpFeed.at(-1);
assert.equal(finalState.type, 'state');
assert.equal(finalState.id, null);
assert.ok(finalState.data.thawed);
assert.ok(finalState.data.finalized);
assert.ok(finalState.data.end_of_updates);
assert.ok(Number.isFinite(Date.parse(finalState.data.thawed)));
assert.ok(Number.isFinite(Date.parse(finalState.data.finalized)));
assert.ok(Date.parse(finalState.data.end_of_updates) > Date.parse(finalState.data.thawed));
assert.ok(Date.parse(finalState.data.end_of_updates) > Date.parse(finalState.data.finalized));

const published = expectStatus(await adminRequest(`/api/v1/leagues/${leagueId}/publish-results`, 'POST'), 200, 'publish results').json;
assert.equal(published.ok, true);
assert.equal(published.frozen, false);
assert.ok(Number.isFinite(Date.parse(published.published_at)));
const republished = expectStatus(await adminRequest(`/api/v1/leagues/${leagueId}/publish-results`, 'POST'), 200, 'idempotent publish').json;
assert.equal(republished.published_at, published.published_at);
assert.equal(republished.frozen, false);
const publishedBoard = expectStatus(await request(`/api/v1/leagues/${leagueId}/scoreboard?view=public`), 200, 'published public board').json;
const publishedTeamA = publishedBoard.rows.find((row) => row.team.team_id === 'team-a');
assert.equal(publishedBoard.frozen, false);
assert.equal(publishedTeamA.solved, 2);
assert.equal(publishedTeamA.penalty_minutes, 190);
const publishedXcpcio = expectStatus(await request('/api/v1/scoreboard/xcpcio.json'), 200, 'published fixed XCPCIO').json;
assert.equal(publishedXcpcio.submissions.find((item) => item.submission_id.endsWith('/a-frozen-ac')).status, 'CORRECT');

const root = expectStatus(await request('/'), 302, 'root redirect');
assert.equal(root.response.headers.get('location'), '/hydro-league-xcpcio/index.html?source=%2Fapi%2Fv1%2Fscoreboard%2Fxcpcio.json');
expectStatus(await request('/hydro-league-xcpcio/index.html'), 200, 'XCPCIO wrapper');
expectStatus(await request('/source'), 200, 'corresponding source');

process.stdout.write(`${JSON.stringify({
  ok: true,
  base_url: baseUrl.origin,
  league_id: leagueId,
  teams: publicBoard.rows.length,
  public_solved_before_publish: teamA.solved,
  jury_solved_before_publish: juryTeamA.solved,
  ce_penalty_excluded: teamA.penalty_minutes === 60,
  star_team_rank: starTeam.rank,
  offline_site: 'school-c',
  quarantine_count: quarantine.count,
  cdp_files: Object.keys(cdpFiles).length,
  published: true,
}, null, 2)}\n`);
