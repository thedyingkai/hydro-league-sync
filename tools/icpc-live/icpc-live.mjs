#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const toolDirectory = dirname(fileURLToPath(import.meta.url));

export function contestResourceId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A non-empty contest ID is required');
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,35}$/.test(value) && !value.endsWith('.')) return value;
  return `contest-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
}

export function liveApiUrl(hubUrl) {
  const url = new URL(hubUrl);
  if (url.username || url.password || url.search || url.hash) throw new Error('Hub URL must not contain credentials, a query, or a fragment');
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('Use the Hub origin, without /api or another path prefix');
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
    || (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'));
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('HTTPS is required except on loopback');
  return `${url.origin}/api/live`;
}

function validateToken(token) {
  if (typeof token !== 'string' || Buffer.byteLength(token, 'utf8') < 32) {
    throw new Error('A broadcast token of at least 32 UTF-8 bytes is required; set HYDRO_LEAGUE_BROADCAST_TOKEN or use --secrets-file');
  }
  if (/[\x00-\x1f\x7f]/.test(token)) throw new Error('Broadcast token must not contain control characters');
  return token;
}

export async function generateProfile({ hubUrl, contestId, outputDirectory, token }) {
  const source = liveApiUrl(hubUrl);
  const id = contestResourceId(contestId);
  validateToken(token);
  const directory = resolve(outputDirectory);
  const files = {
    'settings.json': JSON.stringify({
      type: 'clics',
      feeds: [{
        source: { url: source, login: 'broadcast', password: '$creds.hub_token' },
        contestId: id,
        feedVersion: '2023_06',
      }],
    }, null, 2) + '\n',
    'advanced.json': JSON.stringify([
      { type: 'overrideGroups', rules: { unofficial: { isOutOfContest: true } } },
    ], null, 2) + '\n',
    'creds.json': JSON.stringify({ hub_token: token }, null, 2) + '\n',
    'start.mjs': await readFile(join(toolDirectory, 'launcher.mjs'), 'utf8'),
    'start.ps1': [
      'param([Parameter(Mandatory=$true)][string]$Jar, [int]$Port = 8080)',
      "& node (Join-Path $PSScriptRoot 'start.mjs') --jar $Jar --port $Port",
      'exit $LASTEXITCODE', '',
    ].join('\n'),
    'start.sh': [
      '#!/bin/sh', 'set -eu',
      'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
      'exec node "$SCRIPT_DIR/start.mjs" "$@"', '',
    ].join('\n'),
    'README.txt': [
      'Hydro League Sync — ICPC Live data-only profile',
      'Tested target: ICPC Live v3.5.1; Java 17+; Node.js 22+.',
      '',
      'Keep this directory private: creds.json contains a read-only broadcast credential.',
      'The same credential must be set as HYDRO_LEAGUE_BROADCAST_TOKEN on the Hub.',
      `Contest: ${id}`, `Hub data source: ${source}`, '',
      'Start from any working directory:',
      '  node /path/to/this-directory/start.mjs --jar /path/to/live-v3.5.1.jar',
      '  PowerShell: ./start.ps1 -Jar C:/path/to/live-v3.5.1.jar',
      '  Linux/macOS: ./start.sh --jar /path/to/live-v3.5.1.jar',
      '',
      'Open http://127.0.0.1:8080/admin and enable the scoreboard and/or submission queue.',
      'OBS: add a Browser source, 1920 x 1080:',
      '  http://127.0.0.1:8080/overlay?noStatus&teamMediaAudio=false',
      'No camera, screen capture, microphone, or team media is needed.',
      'The launcher binds to 127.0.0.1; its local admin interface has no password.',
      '',
      'The Hub applies public freeze rules before sending results. Do not switch to the jury /api endpoint.',
      'The Live contest advertises zero additional freeze duration so Hub result publication can update it automatically.',
      'The unofficial group is displayed as out of contest (*).',
      'Download the official jar: https://github.com/icpc/live-v3/releases/tag/v3.5.1', '',
    ].join('\n'),
  };
  await mkdir(dirname(directory), { recursive: true });
  try {
    // Exclusive directory creation prevents overwriting an existing credential or user tuning.
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Output directory already exists; choose a new directory to preserve existing credentials and settings');
    throw error;
  }
  for (const [filename, content] of Object.entries(files)) {
    await writeFile(join(directory, filename), content, { flag: 'wx', mode: filename === 'start.sh' ? 0o700 : 0o600 });
  }
  return { directory, contestId: id, apiUrl: source, files: Object.keys(files) };
}

async function responseText(response, maxBytes = 16 * 1024 * 1024) {
  if (!response.body) throw new Error('Hub returned no response body');
  let length = 0;
  const buffers = [];
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > maxBytes) throw new Error('Hub response exceeds the 16 MiB check limit');
    buffers.push(chunk);
  }
  return Buffer.concat(buffers).toString('utf8');
}

export async function checkHub({ hubUrl, contestId, token, timeoutMs = 10000 }) {
  const source = liveApiUrl(hubUrl);
  const id = contestResourceId(contestId);
  validateToken(token);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('timeoutMs must be between 1 and 60000');
  const headers = { authorization: `Basic ${Buffer.from(`broadcast:${token}`).toString('base64')}` };
  async function get(path) {
    const response = await fetch(`${source}${path}`, { headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`Hub ${path.split('?')[0]} returned HTTP ${response.status}`);
    return responseText(response);
  }
  const api = JSON.parse(await get(''));
  if (api.version !== '2023-06') throw new Error('Hub live endpoint does not advertise Contest API 2023-06');
  const contests = JSON.parse(await get('/contests'));
  if (!Array.isArray(contests) || !contests.some((contest) => contest.id === id)) throw new Error('Contest ID was not found in the Hub live endpoint');
  const prefix = `/contests/${encodeURIComponent(id)}`;
  const raw = await get(`${prefix}/event-feed?stream=false`);
  const events = raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
  const current = new Map();
  for (const event of events) {
    if (typeof event.type !== 'string' || typeof event.token !== 'string' || !Object.hasOwn(event, 'data')) {
      throw new Error('Invalid CLICS 2023-06 event');
    }
    const key = `${event.type}\0${event.id ?? ''}`;
    if (event.data === null) current.delete(key);
    else current.set(key, event);
  }
  if (!current.has('contest\0') || !current.has('state\0')) throw new Error('Event feed is missing contest or state');
  if (current.get('contest\0').data.scoreboard_freeze_duration !== '0:00:00') {
    throw new Error('Live endpoint must let the Hub handle freezing (scoreboard_freeze_duration must be 0:00:00)');
  }
  const count = (type) => [...current.values()].filter((event) => event.type === type).length;
  if (!count('teams') || !count('problems')) throw new Error('No teams or problems are visible in the live event feed');
  // Read one real streaming event (not only stream=false) and then close the connection.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${source}${prefix}/event-feed`, { headers, redirect: 'error', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Streaming event feed returned HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('application/x-ndjson')) throw new Error('Streaming event feed did not return NDJSON');
    const reader = response.body.getReader();
    try {
      let buffered = '';
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) throw new Error('Streaming event feed closed before its first event');
        buffered += decoder.decode(value, { stream: true });
        if (buffered.length > 1024 * 1024) throw new Error('Streaming event exceeds the check limit');
        const line = buffered.split('\n').find((candidate, index, lines) => index < lines.length - 1 && candidate.trim());
        if (line) { JSON.parse(line); break; }
      }
    } finally { await reader.cancel(); }
  } finally { clearTimeout(timer); controller.abort(); }
  return { contestId: id, events: events.length, teams: count('teams'), problems: count('problems'), submissions: count('submissions'), judgements: count('judgements'), streaming: true };
}

export function parseArguments(argv) {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) return { help: true };
  const [command, ...rest] = argv;
  if (!['generate', 'check'].includes(command)) throw new Error('Command must be generate or check');
  const result = { command };
  const names = { '--hub-url': 'hubUrl', '--contest-id': 'contestId', '--hub-config': 'hubConfig', '--output': 'outputDirectory', '--secrets-file': 'secretsFile' };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    const key = names[argument];
    if (!key) throw new Error(`Unknown argument: ${argument}`);
    if (result[key] !== undefined) throw new Error(`${argument} may only be specified once`);
    const value = rest[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    result[key] = value;
  }
  if (!result.hubUrl) throw new Error('--hub-url is required');
  if (Boolean(result.contestId) === Boolean(result.hubConfig)) throw new Error('Specify exactly one of --contest-id or --hub-config');
  if (command === 'check' && result.outputDirectory) throw new Error('--output is only used with generate');
  result.outputDirectory ??= 'private-config/icpc-live';
  return result;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    console.log([
      'node tools/icpc-live/icpc-live.mjs generate|check --hub-url URL',
      '  (--contest-id ID | --hub-config hub-config.json)',
      '  [--secrets-file site-secrets.json] [--output private-config/icpc-live]',
      'Token: site-secrets.json broadcast_token, otherwise HYDRO_LEAGUE_BROADCAST_TOKEN.',
      'The output directory must not already exist. Never pass credentials as command-line arguments.',
    ].join('\n'));
    return;
  }
  if (options.hubConfig) {
    try {
      const config = JSON.parse((await readFile(options.hubConfig, 'utf8')).replace(/^\uFEFF/, ''));
      options.contestId = config.contest?.contest_id;
    } catch {
      throw new Error('Unable to read --hub-config as JSON');
    }
  }
  if (options.secretsFile) {
    try {
      options.token = JSON.parse((await readFile(options.secretsFile, 'utf8')).replace(/^\uFEFF/, '')).broadcast_token;
    } catch {
      // JSON parser errors can include the malformed value; never echo a secret file's contents.
      throw new Error('Unable to read --secrets-file as JSON');
    }
  } else options.token = process.env.HYDRO_LEAGUE_BROADCAST_TOKEN;
  if (options.command === 'generate') {
    const result = await generateProfile(options);
    console.log(`ICPC Live profile created: ${result.directory}`);
    console.log(`Contest: ${result.contestId}; ${result.files.length} files. Credentials were not printed.`);
  } else {
    console.log(JSON.stringify(await checkHub(options), null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
