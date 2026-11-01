import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkHub, contestResourceId, generateProfile, liveApiUrl, parseArguments } from './icpc-live.mjs';
import { javaArguments } from './launcher.mjs';

const token = 'a-test-broadcast-token-at-least-thirty-two-bytes';
const toolDirectory = dirname(fileURLToPath(import.meta.url));

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hydro-live-tools-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('profile separates credentials, maps starred teams and creates a portable localhost launcher', async (t) => {
  const directory = join(await scratch(t), 'live profile');
  const result = await generateProfile({ hubUrl: 'http://127.0.0.1:3000', contestId: 'league-2026', outputDirectory: directory, token });
  const settings = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'));
  assert.deepEqual(settings.feeds[0], {
    source: { url: 'http://127.0.0.1:3000/api/live', login: 'broadcast', password: '$creds.hub_token' },
    contestId: 'league-2026', feedVersion: '2023_06',
  });
  assert.equal(settings.type, 'clics');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'advanced.json'), 'utf8')), [
    { type: 'overrideGroups', rules: { unofficial: { isOutOfContest: true } } },
  ]);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'creds.json'), 'utf8')), { hub_token: token });
  for (const name of await readdir(directory)) {
    if (name !== 'creds.json') assert.equal((await readFile(join(directory, name), 'utf8')).includes(token), false);
  }
  assert.equal(JSON.stringify(result).includes(token), false);
  const args = javaArguments({ jar: '/path with spaces/live.jar', profileDirectory: directory, port: 12345 });
  assert.ok(args.includes('--ktor-arg=-host=127.0.0.1'));
  assert.ok(args.includes(`--creds=${join(directory, 'creds.json')}`));
  assert.equal(args[1], '/path with spaces/live.jar');
  assert.equal(args.at(-1), '12345');
  assert.throws(() => javaArguments({ port: 70000 }), /port/);
  const help = spawnSync(process.execPath, [join(directory, 'start.mjs'), '--help'], { encoding: 'utf8', cwd: tmpdir() });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--jar/);
});

test('generation never overwrites an existing profile or credential', async (t) => {
  const directory = join(await scratch(t), 'profile');
  const input = { hubUrl: 'https://hub.example.edu', contestId: 'contest', outputDirectory: directory, token };
  await generateProfile(input);
  await assert.rejects(generateProfile({ ...input, token: 'a-different-token-more-than-thirty-two-bytes' }), /already exists/);
  assert.equal(JSON.parse(await readFile(join(directory, 'creds.json'), 'utf8')).hub_token, token);
});

test('URLs cannot leak authentication over HTTP to a remote or lookalike loopback host', () => {
  for (const url of ['http://hub.example.edu', 'http://127.example.edu', 'https://user:password@hub.example.edu',
    'https://hub.example.edu/api', 'https://hub.example.edu/?key=value', 'https://hub.example.edu/#secret']) {
    assert.throws(() => liveApiUrl(url), url);
  }
  assert.equal(liveApiUrl('http://[::1]:3000'), 'http://[::1]:3000/api/live');
  assert.equal(liveApiUrl('https://hub.example.edu/'), 'https://hub.example.edu/api/live');
});

test('CLI consumes private Hub configuration and secret files without printing credentials', async (t) => {
  const directory = await scratch(t);
  const hubConfig = join(directory, 'hub-config.json');
  const secretsFile = join(directory, 'site-secrets.json');
  const profile = join(directory, 'profile');
  await writeFile(hubConfig, JSON.stringify({ contest: { contest_id: '中文联赛' } }));
  await writeFile(secretsFile, JSON.stringify({ broadcast_token: token, admin_token: 'not-used' }));
  const result = spawnSync(process.execPath, [join(toolDirectory, 'icpc-live.mjs'), 'generate',
    '--hub-url', 'https://hub.example.edu', '--hub-config', hubConfig, '--secrets-file', secretsFile,
    '--output', profile], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout + result.stderr).includes(token), false);
  const settings = JSON.parse(await readFile(join(profile, 'settings.json'), 'utf8'));
  assert.equal(settings.feeds[0].contestId, contestResourceId('中文联赛'));
  assert.match(settings.feeds[0].contestId, /^contest-[a-f\d]{20}$/);
  await writeFile(secretsFile, `{"broadcast_token":"${token}`);
  const bad = spawnSync(process.execPath, [join(toolDirectory, 'icpc-live.mjs'), 'check',
    '--hub-url', 'https://hub.example.edu', '--contest-id', 'c', '--secrets-file', secretsFile], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.equal((bad.stdout + bad.stderr).includes(token), false);
  assert.match(bad.stderr, /Unable to read/);
});

test('invalid credentials and argument combinations fail before creating output', async (t) => {
  const parent = await scratch(t);
  await assert.rejects(generateProfile({ hubUrl: 'http://localhost:3000', contestId: 'contest', outputDirectory: join(parent, 'output'), token: 'short' }), /broadcast token/);
  assert.deepEqual(await readdir(parent), []);
  assert.throws(() => parseArguments(['generate', '--hub-url', 'http://localhost:3000', '--contest-id', 'a', '--hub-config', 'b']), /exactly one/);
  assert.throws(() => parseArguments(['check', '--hub-url']), /requires a value/);
  assert.throws(() => parseArguments(['check', '--hub-url', 'http://localhost:3000', '--contest-id', 'a', '--token', token]), /Unknown argument/);
});

const feed = [
  { type: 'contest', id: null, data: { id: 'c', name: '联赛', scoreboard_freeze_duration: '0:00:00' } },
  { type: 'state', id: null, data: { started: null, finalized: null } },
  { type: 'teams', id: 't', data: { id: 't' } },
  { type: 'problems', id: 'p', data: { id: 'p' } },
].map((event, index) => ({ ...event, token: String(index + 1) }));

async function fakeHub(t, handle) {
  const server = createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('check validates a real HTTP snapshot and streaming feed then disconnects', async (t) => {
  let streamRequests = 0;
  const url = await fakeHub(t, (request, response) => {
    assert.equal(request.headers.authorization, `Basic ${Buffer.from(`broadcast:${token}`).toString('base64')}`);
    if (request.url === '/api/live') response.end(JSON.stringify({ version: '2023-06' }));
    else if (request.url === '/api/live/contests') response.end(JSON.stringify([{ id: 'c' }]));
    else if (request.url === '/api/live/contests/c/event-feed?stream=false') {
      response.end(feed.map((event) => JSON.stringify(event)).join('\n') + '\n');
    } else if (request.url === '/api/live/contests/c/event-feed') {
      streamRequests += 1;
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.write(JSON.stringify(feed[0]) + '\n');
    } else { response.writeHead(404); response.end(); }
  });
  assert.deepEqual(await checkHub({ hubUrl: url, contestId: 'c', token }), {
    contestId: 'c', events: 4, teams: 1, problems: 1, submissions: 0, judgements: 0, streaming: true,
  });
  assert.equal(streamRequests, 1);
});

test('check rejects missing credentials/server errors without echoing a response containing a secret', async (t) => {
  const url = await fakeHub(t, (_, response) => { response.writeHead(401); response.end(`secret ${token}`); });
  await assert.rejects(checkHub({ hubUrl: url, contestId: 'c', token }), (error) => {
    assert.match(error.message, /HTTP 401/);
    assert.equal(error.message.includes(token), false);
    return true;
  });
});

test('check times out on a server that never finishes its response', async (t) => {
  const url = await fakeHub(t, (_, response) => { response.writeHead(200); response.write('{'); });
  await assert.rejects(checkHub({ hubUrl: url, contestId: 'c', token, timeoutMs: 50 }));
});
