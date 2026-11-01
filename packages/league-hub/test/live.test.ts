import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHubApplication, buildEventFeed, buildScoreboard, resolveHubOptions, type HubApplication } from '../src/index.js';
import type { HubConfiguration, IngestEvent } from '../src/types.js';

const adminToken = 'admin-token-only-for-the-live-integration-tests';
const broadcastToken = 'broadcast-token-only-for-live-integration-tests';
const headers = { authorization: `Bearer ${broadcastToken}` };
const root = '/api/live/contests/league';
const start = '2026-08-30T02:00:00.000Z';
const freeze = '2026-08-30T03:00:00.000Z';
const end = '2026-08-30T06:00:00.000Z';

function config(): HubConfiguration {
  return {
    contest: { contest_id: 'league', name: 'Broadcast rehearsal', start_time: start, freeze_time: freeze, end_time: end },
    sites: [{ site_id: 'site', name: 'Site', secret: 'site-secret-for-live-tests-only-123456789' }],
    teams: [{ team_id: 'team', name: 'Team', school_id: 'school' }],
    problems: [{ problem_id: 'a', label: 'A', name: 'Alpha' }, { problem_id: 'b', label: 'B', name: 'Beta' }],
    team_mappings: [{ site_id: 'site', domain_id: 'system', contest_id: 'local', local_uid: '1', team_id: 'team' }],
    problem_mappings: [
      { site_id: 'site', domain_id: 'system', contest_id: 'local', local_pid: '1', problem_id: 'a' },
      { site_id: 'site', domain_id: 'system', contest_id: 'local', local_pid: '2', problem_id: 'b' },
    ],
    awards: [{ award_id: 'winner', citation: 'Winner', team_ids: ['team'] }],
  };
}

function event(rid: string, source_seq: number, status: string, submitted_at: string, pid = 1): IngestEvent {
  const canonical: Record<string, string> = { AC: 'ACCEPTED', WA: 'WRONG_ANSWER', CE: 'COMPILE_ERROR' };
  return {
    protocol_version: '1.0', event_type: 'submission.upsert', league_id: 'league', site_id: 'site',
    domain_id: 'system', contest_id: 'local', rid, source_seq, status: canonical[status] ?? status, uid: 1, pid, submitted_at,
    emitted_at: submitted_at, judged_at: submitted_at, lang: 'cpp', rejudged: false,
  };
}

function ingest(hub: HubApplication, events: IngestEvent[]) {
  const now = hub.options.now().toISOString();
  hub.database.ingestBatch({ protocol_version: '1.0', batch_id: randomUUID(), league_id: 'league', site_id: 'site', sent_at: now, events }, now);
}

function makeHub(now: () => Date = () => new Date('2026-08-30T03:30:00.000Z'), databasePath = ':memory:') {
  const hub = createHubApplication({ databasePath, adminToken, broadcastToken, now });
  if (!hub.database.getContest()) hub.database.importConfiguration(config(), now().toISOString());
  return hub;
}

interface FeedEvent { id: string | null; type: string; data: Record<string, unknown> | null; token: string }
async function feed(hub: HubApplication, token?: string): Promise<FeedEvent[]> {
  const response = await hub.app.inject({ url: `${root}/event-feed?stream=false${token ? `&since_token=${token}` : ''}`, headers });
  assert.equal(response.statusCode, 200, response.body);
  return response.body.split('\n').filter(Boolean).map((line) => JSON.parse(line) as FeedEvent);
}

test('broadcast credentials are optional, distinct, and restricted to the read-only API', async (t) => {
  const disabled = createHubApplication({ databasePath: ':memory:', adminToken, broadcastToken: '' });
  t.after(() => disabled.app.close());
  assert.equal((await disabled.app.inject({ url: '/api/live', headers })).statusCode, 503);
  assert.throws(() => resolveHubOptions({ databasePath: ':memory:', broadcastToken: 'short' }), /32/);
  assert.throws(() => resolveHubOptions({ databasePath: ':memory:', adminToken, broadcastToken: adminToken }), /differ/);
  const hub = makeHub();
  t.after(() => hub.app.close());
  for (const url of ['/api/live', '/api/live/contests', `${root}/teams`, `${root}/event-feed?stream=false`]) {
    assert.equal((await hub.app.inject({ url })).statusCode, 401);
    assert.equal((await hub.app.inject({ url, headers: { authorization: `Bearer ${adminToken}` } })).statusCode, 401);
    assert.equal((await hub.app.inject({ url, headers })).statusCode, 200);
  }
  const basic = `Basic ${Buffer.from(`broadcast:${broadcastToken}`).toString('base64')}`;
  assert.equal((await hub.app.inject({ url: '/api/live/', headers: { authorization: basic } })).json().version, '2023-06');
  for (const authorization of [headers.authorization, basic]) {
    assert.equal((await hub.app.inject({ url: '/api/contests/league/submissions', headers: { authorization } })).statusCode, 401);
    assert.equal((await hub.app.inject({ method: 'PUT', url: '/api/v1/admin/config', headers: { authorization }, payload: config() })).statusCode, 401);
  }
  assert.equal((await hub.app.inject({ method: 'PUT', url: `${root}/teams/team`, headers, payload: { name: 'Changed' } })).statusCode, 404);
  assert.equal((await hub.app.inject({ url: `${root}/event-feed?since_token=-1&stream=false`, headers })).statusCode, 400);
  assert.equal((await hub.app.inject({ url: `${root}/event-feed?since_token=999999&stream=false`, headers })).statusCode, 400);
});

test('broadcast credentials cannot be reused as a site HMAC secret on import or existing-database startup', async (t) => {
  const hub = makeHub();
  t.after(() => hub.app.close());
  const original = hub.database.getSite('site')!.secret;
  const conflicting = config();
  conflicting.sites[0]!.secret = broadcastToken;
  const response = await hub.app.inject({ method: 'PUT', url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` }, payload: conflicting });
  assert.equal(response.statusCode, 400);
  assert.match(response.body, /must differ/);
  assert.equal(response.body.includes(broadcastToken), false);
  assert.equal(hub.database.getSite('site')!.secret, original);

  const directory = mkdtempSync(join(tmpdir(), 'hydro-live-credentials-'));
  const path = join(directory, 'hub.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const legacy = createHubApplication({ databasePath: path, adminToken, broadcastToken: '' });
  legacy.database.importConfiguration(conflicting, new Date().toISOString());
  await legacy.app.close();
  assert.throws(() => createHubApplication({ databasePath: path, adminToken, broadcastToken }), /must differ/);
  // Failed startup must close SQLite so the existing deployment can still be
  // opened with broadcasting disabled and its school credential rotated.
  const recovered = createHubApplication({ databasePath: path, adminToken, broadcastToken: '' });
  assert.equal(recovered.database.getSite('site')!.secret, broadcastToken);
  await recovered.app.close();

  // Library callers can import directly; a subsequent public config update
  // that preserves an omitted secret must still reject the conflict.
  hub.database.importConfiguration(conflicting, new Date().toISOString());
  delete conflicting.sites[0]!.secret;
  const omitted = await hub.app.inject({ method: 'PUT', url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` }, payload: conflicting });
  assert.equal(omitted.statusCode, 400);
});

test('freeze boundary, public REST and isolated replay never expose jury judgements', async (t) => {
  let now = new Date('2026-08-30T03:30:00.000Z');
  const hub = makeHub(() => now);
  t.after(() => hub.app.close());
  ingest(hub, [
    { ...event('before', 1, 'AC', '2026-08-30T02:59:59.999Z'), judged_at: '2026-08-30T03:10:00.000Z' },
    event('boundary', 2, 'AC', freeze, 2),
    event('after', 3, 'WA', '2026-08-30T03:10:00.000Z', 2),
  ]);
  // Populate the original jury journal first, so accidentally sharing its log
  // would leak both post-freeze judgements on the first broadcast connection.
  const jury = buildEventFeed(hub.database, buildScoreboard(hub.database, 'jury', hub.options)!);
  assert.equal(jury.filter((item) => item.type === 'judgements').length, 3);
  const submissions = (await hub.app.inject({ url: `${root}/submissions`, headers })).json<Array<{ id: string; time: string }>>();
  assert.equal(submissions.length, 3);
  const beforeId = submissions.find((submission) => submission.time === '2026-08-30T02:59:59.999Z')!.id;
  const judgements = (await hub.app.inject({ url: `${root}/judgements`, headers })).json<Array<{ submission_id: string }>>();
  assert.deepEqual(judgements.map((item) => item.submission_id), [beforeId]);
  const boundaryId = submissions.find((submission) => submission.time === freeze)!.id;
  assert.equal((await hub.app.inject({ url: `${root}/judgements/j-${boundaryId}`, headers })).statusCode, 404);
  assert.deepEqual((await hub.app.inject({ url: `${root}/judgements?submission_id=${boundaryId}`, headers })).json(), []);
  assert.deepEqual((await hub.app.inject({ url: `${root}/awards`, headers })).json(), []);
  assert.equal((await hub.app.inject({ url: root, headers })).json().scoreboard_freeze_duration, '0:00:00');
  const first = await feed(hub);
  assert.equal(first.filter((item) => item.type === 'submissions').length, 3);
  assert.deepEqual(first.filter((item) => item.type === 'judgements').map((item) => item.data!.submission_id), [beforeId]);
  assert.deepEqual(await feed(hub, first.at(-1)!.token), []);
  const board = (await hub.app.inject({ url: `${root}/scoreboard`, headers })).json();
  assert.equal(board.rows[0].score.num_solved, 1);
  assert.equal(board.rows[0].problems[1].num_pending, 2);

  const updated = config();
  updated.contest.unfreeze_at = '2026-08-30T06:05:00.000Z';
  now = new Date('2026-08-30T06:10:00.000Z');
  hub.database.importConfiguration(updated, hub.options.now().toISOString());
  const released = await feed(hub, first.at(-1)!.token);
  assert.equal(released.filter((item) => item.type === 'judgements').length, 2);
  assert.equal(released.at(-1)!.data!.thawed, updated.contest.unfreeze_at);
  assert.equal((await hub.app.inject({ url: `${root}/scoreboard`, headers })).json().rows[0].score.num_solved, 2);
});

test('jury finalization does not unfreeze broadcast; publication releases verdicts before terminal state', async (t) => {
  let now = new Date('2026-08-30T06:01:00.000Z');
  const hub = makeHub(() => now);
  t.after(() => hub.app.close());
  ingest(hub, [event('frozen', 1, 'AC', freeze)]);
  const first = await feed(hub);
  buildEventFeed(hub.database, buildScoreboard(hub.database, 'jury', hub.options)!, true);
  assert.deepEqual(await feed(hub, first.at(-1)!.token), []);
  const state = (await hub.app.inject({ url: `${root}/state`, headers })).json();
  assert.equal(state.thawed, null);
  assert.equal(state.finalized, null);
  assert.equal(state.end_of_updates, null);
  now = new Date('2026-08-30T06:02:00.000Z');
  hub.database.publishContestResults('league', now.toISOString());
  const released = await feed(hub, first.at(-1)!.token);
  assert.equal(released.filter((item) => item.type === 'judgements').length, 1);
  assert.equal(released.filter((item) => item.type === 'awards').length, 1);
  assert.equal(released.at(-1)!.type, 'state');
  assert.equal(released.at(-1)!.data!.thawed, now.toISOString());
  assert.ok(released.at(-1)!.data!.end_of_updates);
  const streaming = await hub.app.inject({ url: `${root}/event-feed`, headers });
  assert.equal(streaming.statusCode, 200);
  assert.ok(streaming.body.includes('end_of_updates'));
});

test('broadcast preserves millisecond last-AC tie-breaks and judgement times without changing the jury API', async (t) => {
  const hub = makeHub();
  t.after(() => hub.app.close());
  const configured = config();
  configured.contest.end_time = '2026-08-30T06:00:00.123Z';
  configured.teams.push({ team_id: 'later', name: 'Later', school_id: 'school' });
  configured.team_mappings.push({ site_id: 'site', domain_id: 'system', contest_id: 'local', local_uid: '2', team_id: 'later' });
  hub.database.importConfiguration(configured, hub.options.now().toISOString());
  ingest(hub, [
    { ...event('early', 1, 'AC', '2026-08-30T02:10:00.001Z'), judged_at: '2026-08-30T02:10:01.123Z' },
    { ...event('late', 2, 'AC', '2026-08-30T02:10:00.999Z'), uid: 2, judged_at: '2026-08-30T02:10:01.987Z' },
  ]);
  const submissions = (await hub.app.inject({ url: `${root}/submissions`, headers })).json();
  assert.deepEqual(submissions.map((item: { contest_time: string }) => item.contest_time), ['0:10:00.001', '0:10:00.999']);
  const judgements = (await hub.app.inject({ url: `${root}/judgements`, headers })).json();
  assert.deepEqual(judgements.map((item: { start_contest_time: string }) => item.start_contest_time), ['0:10:00.001', '0:10:00.999']);
  assert.deepEqual(judgements.map((item: { end_contest_time: string }) => item.end_contest_time), ['0:10:01.123', '0:10:01.987']);
  assert.equal((await hub.app.inject({ url: root, headers })).json().duration, '4:00:00.123');
  const board = (await hub.app.inject({ url: `${root}/scoreboard`, headers })).json();
  assert.deepEqual(board.rows.map((row: { team_id: string; rank: number }) => [row.team_id, row.rank]), [['team', 1], ['later', 2]]);
  const broadcast = await feed(hub);
  assert.deepEqual(broadcast.filter((item) => item.type === 'submissions').map((item) => item.data!.contest_time), ['0:10:00.001', '0:10:00.999']);
  const jury = (await hub.app.inject({ url: '/api/contests/league/submissions', headers: { authorization: `Bearer ${adminToken}` } })).json();
  assert.deepEqual(jury.map((item: { contest_time: string }) => item.contest_time), ['0:10:00', '0:10:00']);
});

test('rejudging replaces/deletes the same verdict and replay tokens survive a Hub restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hydro-live-'));
  const path = join(directory, 'hub.sqlite');
  let hub = makeHub(undefined, path);
  t.after(async () => { await hub.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const submitted = '2026-08-30T02:10:00.000Z';
  ingest(hub, [event('rejudge', 1, 'CE', submitted)]);
  const first = await feed(hub);
  const verdict = first.find((item) => item.type === 'judgements')!;
  assert.equal(verdict.data!.judgement_type_id, 'CE');
  assert.equal(first.find((item) => item.type === 'judgement-types' && item.id === 'CE')!.data!.penalty, false);
  ingest(hub, [event('rejudge', 2, 'JUDGING', submitted)]);
  const pending = await feed(hub, first.at(-1)!.token);
  assert.deepEqual(pending.filter((item) => item.type === 'judgements').map(({ id, data }) => ({ id, data })), [{ id: verdict.id, data: null }]);
  const cursor = pending.at(-1)!.token;
  await hub.app.close();
  hub = makeHub(undefined, path);
  assert.deepEqual(await feed(hub, cursor), []);
  ingest(hub, [event('rejudge', 3, 'AC', submitted)]);
  const accepted = await feed(hub, cursor);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0]!.id, verdict.id);
  assert.equal(accepted[0]!.data!.judgement_type_id, 'AC');
  assert.ok(Number(accepted[0]!.token) > Number(cursor));
});

test('restricting public visibility filters historical replay across restart and preserves previously issued cursors', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'hydro-live-visibility-'));
  const path = join(directory, 'hub.sqlite');
  let now = new Date('2026-08-30T03:30:00.000Z');
  let hub = makeHub(() => now, path);
  t.after(async () => { await hub.app.close(); rmSync(directory, { recursive: true, force: true }); });
  const update = async (configuration: HubConfiguration) => {
    const response = await hub.app.inject({ method: 'PUT', url: '/api/v1/admin/config',
      headers: { authorization: `Bearer ${adminToken}` }, payload: configuration });
    assert.equal(response.statusCode, 200, response.body);
  };
  const assertMatchesRest = async (events: FeedEvent[], types: string[]) => {
    for (const type of types) {
      const current = new Map<string | null, unknown>();
      for (const item of events.filter((event) => event.type === type)) {
        if (item.data === null) current.delete(item.id);
        else current.set(item.id, item.data);
      }
      const response = await hub.app.inject({ url: `${root}/${type}`, headers });
      assert.equal(response.statusCode, 200);
      assert.deepEqual([...current.values()], response.json());
    }
  };

  const initialConfig = config();
  initialConfig.contest.freeze_time = '2026-08-30T04:00:00.000Z';
  await update(initialConfig);
  ingest(hub, [event('restricted', 1, 'AC', freeze)]);
  const initial = await feed(hub);
  const verdict = initial.find((item) => item.type === 'judgements')!;
  assert.equal(verdict.data!.judgement_type_id, 'AC');

  // Move the configured freeze into the past after a client has already read
  // the verdict. REST and new full-replay clients must now see only pending.
  await update(config());
  const restricted = await feed(hub);
  assert.ok(restricted.some((item) => item.type === 'judgements' && item.data === null));
  assert.ok(restricted.filter((item) => item.type === 'judgements').every((item) => item.data === null));
  await assertMatchesRest(restricted, ['teams', 'submissions', 'judgements']);
  const resumed = await feed(hub, verdict.token);
  assert.ok(resumed.some((item) => item.type === 'judgements' && item.id === verdict.id && item.data === null));
  const cursor = resumed.at(-1)!.token;
  assert.ok(Number(cursor) > Number(verdict.token));
  assert.deepEqual(await feed(hub, cursor), []);

  await hub.app.close();
  hub = makeHub(() => now, path);
  assert.ok((await feed(hub)).filter((item) => item.type === 'judgements').every((item) => item.data === null));
  await feed(hub, verdict.token); // A valid old token remains valid after restart.
  assert.deepEqual(await feed(hub, cursor), []);
  ingest(hub, [event('restricted', 2, 'WA', freeze)]);
  assert.deepEqual(await feed(hub, cursor), []);
  const releasedConfig = config();
  releasedConfig.contest.unfreeze_at = '2026-08-30T06:00:00.000Z';
  now = new Date('2026-08-30T06:01:00.000Z');
  await update(releasedConfig);
  const released = await feed(hub, cursor);
  assert.ok(released.some((item) => item.type === 'judgements' && item.data?.judgement_type_id === 'WA'));
  assert.ok(released.every((item) => Number(item.token) > Number(cursor)));
  await assertMatchesRest(await feed(hub), ['teams', 'submissions', 'judgements']);

  const submissionToken = initial.find((item) => item.type === 'submissions')!.token;
  releasedConfig.teams[0]!.hidden = true;
  releasedConfig.awards = [];
  await update(releasedConfig);
  const hidden = await feed(hub);
  for (const type of ['teams', 'submissions', 'judgements']) {
    assert.ok(hidden.filter((item) => item.type === type).every((item) => item.data === null));
  }
  await assertMatchesRest(hidden, ['teams', 'submissions', 'judgements']);
  const hiddenResumed = await feed(hub, submissionToken);
  assert.ok(hiddenResumed.some((item) => item.type === 'submissions' && item.data === null));
  assert.ok(hiddenResumed.filter((item) => ['teams', 'submissions', 'judgements'].includes(item.type)).every((item) => item.data === null));
});

async function openStream(url: string) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 25_000);
  const response = await fetch(url, { headers, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    async line(): Promise<string | null> {
      while (!buffered.includes('\n')) {
        const next = await reader.read();
        if (next.done) return null;
        buffered += decoder.decode(next.value, { stream: true });
      }
      const newline = buffered.indexOf('\n');
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      return line;
    },
    close() { clearTimeout(deadline); controller.abort(); },
  };
}

test('real HTTP resume accepts a now-filtered token and continues after the visibility change', { timeout: 10_000 }, async (t) => {
  const hub = makeHub();
  t.after(() => hub.app.close());
  const initialConfig = config();
  initialConfig.contest.freeze_time = '2026-08-30T04:00:00.000Z';
  hub.database.importConfiguration(initialConfig, hub.options.now().toISOString());
  ingest(hub, [event('now-frozen', 1, 'AC', freeze)]);
  const initial = await feed(hub);
  const token = initial.find((item) => item.type === 'judgements')!.token;
  const changed = await hub.app.inject({ method: 'PUT', url: '/api/v1/admin/config',
    headers: { authorization: `Bearer ${adminToken}` }, payload: config() });
  assert.equal(changed.statusCode, 200);
  const url = await hub.app.listen({ host: '127.0.0.1', port: 0 });
  const stream = await openStream(`${url}${root}/event-feed?since_token=${token}`);
  t.after(() => stream.close());
  let lastToken = Number(token);
  let sawDeletion = false;
  while (true) {
    const item = JSON.parse((await stream.line())!) as FeedEvent;
    assert.ok(Number(item.token) > lastToken);
    lastToken = Number(item.token);
    if (item.type === 'judgements') { assert.equal(item.data, null); sawDeletion = true; }
    if (item.type === 'state' && item.data?.frozen === freeze) break;
  }
  assert.ok(sawDeletion);
  ingest(hub, [event('new-visible', 2, 'WA', '2026-08-30T02:15:00.000Z', 2)]);
  while (true) {
    const item = JSON.parse((await stream.line())!) as FeedEvent;
    assert.ok(Number(item.token) > lastToken);
    lastToken = Number(item.token);
    if (item.type === 'judgements' && item.data !== null) {
      assert.equal(item.data.judgement_type_id, 'WA');
      break;
    }
  }
  stream.close();
});

test('real HTTP stream pushes incremental verdicts, resumes, and sends idle heartbeats', { timeout: 30_000 }, async (t) => {
  const hub = makeHub();
  t.after(() => hub.app.close());
  const initial = await feed(hub);
  const url = await hub.app.listen({ host: '127.0.0.1', port: 0 });
  const stream = await openStream(`${url}${root}/event-feed?since_token=${initial.at(-1)!.token}`);
  t.after(() => stream.close());
  const submitted = '2026-08-30T02:10:00.000Z';
  ingest(hub, [event('streamed', 1, 'PENDING', submitted)]);
  let latest: FeedEvent | undefined;
  do {
    const line = await stream.line();
    assert.notEqual(line, null);
    if (line) latest = JSON.parse(line) as FeedEvent;
  } while (latest?.type !== 'submissions');
  const submissionId = latest.id;
  ingest(hub, [event('streamed', 2, 'AC', submitted)]);
  do {
    const line = await stream.line();
    assert.notEqual(line, null);
    if (line) latest = JSON.parse(line) as FeedEvent;
  } while (latest?.type !== 'judgements');
  assert.equal(latest.data!.submission_id, submissionId);
  assert.equal(latest.data!.judgement_type_id, 'AC');
  const cursor = latest.token;
  stream.close();

  const resumed = await openStream(`${url}${root}/event-feed?since_token=${cursor}`);
  t.after(() => resumed.close());
  // With no new data, the next line must be a heartbeat, not a replayed event.
  assert.equal(await resumed.line(), '');
  ingest(hub, [event('streamed', 3, 'WA', submitted)]);
  const next = JSON.parse((await resumed.line())!) as FeedEvent;
  assert.equal(next.type, 'judgements');
  assert.equal(next.data!.judgement_type_id, 'WA');
  assert.ok(Number(next.token) > Number(cursor));
  resumed.close();
});
