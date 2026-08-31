import assert from 'node:assert/strict';
import { strFromU8, unzipSync } from 'fflate';

const baseUrl = new URL(process.env.HYDRO_LEAGUE_SMOKE_URL ?? 'http://127.0.0.1:3100');
const adminToken = process.env.HYDRO_LEAGUE_SMOKE_ADMIN_TOKEN ?? '';
const expectedLeagueId = process.env.HYDRO_LEAGUE_EXPECTED_SMOKE_LEAGUE ?? '';

assert.ok(Buffer.byteLength(adminToken, 'utf8') >= 32, 'smoke admin token must contain at least 32 UTF-8 bytes');
assert.match(expectedLeagueId, /^remote-smoke-\d{14}$/);
assert.equal(baseUrl.pathname, '/');
assert.equal(baseUrl.search, '');
assert.equal(baseUrl.hash, '');
assert.ok(['http:', 'https:'].includes(baseUrl.protocol));
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname), 'persistence checks are allowed only over loopback');
assert.equal(baseUrl.port || (baseUrl.protocol === 'https:' ? '443' : '80'), '3100');

async function request(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), { redirect: 'manual', ...options });
  const raw = new Uint8Array(await response.arrayBuffer());
  const text = new TextDecoder().decode(raw);
  const json = text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : undefined;
  return { response, raw, text, json };
}

function expectStatus(result, expected, label) {
  assert.equal(result.response.status, expected, `${label}: ${result.response.status} ${result.text}`);
  return result;
}

function adminRequest(path) {
  return request(path, { headers: { authorization: `Bearer ${adminToken}` } });
}

const health = expectStatus(await request('/healthz'), 200, 'health').json;
assert.equal(health.status, 'ok');
assert.equal(health.configured, true);
assert.equal(expectStatus(await request('/readyz'), 200, 'ready').json.status, 'ready');

const config = expectStatus(await adminRequest('/api/v1/admin/config'), 200, 'configuration').json;
assert.equal(config.contest.contest_id, expectedLeagueId);
assert.equal(config.sites.every((site) => site.has_secret === true && !Object.hasOwn(site, 'secret')), true);

const board = expectStatus(
  await request(`/api/v1/leagues/${expectedLeagueId}/scoreboard?view=public`),
  200,
  'published scoreboard',
).json;
const teamA = board.rows.find((row) => row.team.team_id === 'team-a');
assert.equal(board.frozen, false);
assert.equal(teamA.solved, 2);
assert.equal(teamA.penalty_minutes, 190);

const xcpcio = expectStatus(await request('/api/v1/scoreboard/xcpcio.json'), 200, 'published XCPCIO').json;
assert.equal(xcpcio.contest.contest_name, '远程三校联赛验收');
assert.equal(xcpcio.submissions.find((item) => item.submission_id.endsWith('/a-frozen-ac')).status, 'CORRECT');

const cdp = expectStatus(await adminRequest(`/api/v1/leagues/${expectedLeagueId}/cdp.zip`), 200, 'persisted CDP');
const cdpFiles = unzipSync(cdp.raw);
for (const filename of ['contest.json', 'problems.json', 'event-feed.ndjson']) {
  assert.ok(cdpFiles[filename], `CDP must contain ${filename}`);
}
const feed = strFromU8(cdpFiles['event-feed.ndjson']).trim().split('\n').map((line) => JSON.parse(line));
const finalState = feed.at(-1);
assert.equal(finalState.type, 'state');
assert.ok(finalState.data.finalized);
assert.ok(finalState.data.end_of_updates);

const root = expectStatus(await request('/'), 302, 'root redirect');
assert.equal(root.response.headers.get('location'), '/hydro-league-xcpcio/index.html?source=%2Fapi%2Fv1%2Fscoreboard%2Fxcpcio.json');
expectStatus(await request('/hydro-league-xcpcio/index.html'), 200, 'XCPCIO wrapper');
const source = expectStatus(await request('/source'), 200, 'AGPL corresponding source');
assert.equal(source.raw[0], 0x50);
assert.equal(source.raw[1], 0x4b);

process.stdout.write(`${JSON.stringify({
  ok: true,
  league_id: expectedLeagueId,
  ready_after_restart: true,
  public_solved_after_publish: teamA.solved,
  public_penalty_after_publish: teamA.penalty_minutes,
  published_submission_status: 'CORRECT',
  cdp_files_after_restart: Object.keys(cdpFiles).length,
  xcpcio_wrapper: true,
  corresponding_source: true,
}, null, 2)}\n`);
