#!/usr/bin/env node
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHubApplication } from '../../packages/league-hub/dist/src/index.js';
import { generateProfile } from './icpc-live.mjs';

// A persistent, isolated rehearsal: never reads the user's existing Live config.
const args = { port: 8080, java: 'java', open: true };
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (flag === '--no-open') { args.open = false; continue; }
  if (flag === '--help') {
    console.log('node --experimental-sqlite tools/icpc-live/preview.mjs --jar PATH [--port 8080] [--java PATH] [--no-open]');
    process.exit(0);
  }
  if (!['--jar', '--port', '--java'].includes(flag) || !process.argv[index + 1]) {
    throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  const value = process.argv[++index];
  args[flag.slice(2)] = flag === '--port' ? Number(value) : value;
}
if (!args.jar) throw new Error('--jar is required');
if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('Invalid port');
const jar = path.resolve(args.jar);
await access(jar);
const reservation = createServer();
await new Promise((resolve, reject) => {
  reservation.once('error', () => reject(new Error(`Port ${args.port} is busy; pass --port 8081 instead`)));
  reservation.listen(args.port, '127.0.0.1', resolve);
});
await new Promise((resolve) => reservation.close(resolve));

const directory = await mkdtemp(path.join(tmpdir(), 'hydro-live-preview-'));
const broadcastToken = randomBytes(32).toString('hex');
const hub = createHubApplication({ databasePath: ':memory:', adminToken: randomBytes(32).toString('hex'), broadcastToken });
const start = Date.now() - 40 * 60_000;
const teamNames = ['星河队', '递归小队', '二分答案', '持续输出', '编译通过', '边界条件', '路径探索', '邀请队'];
const teamIds = teamNames.map((_, index) => `demo-${index + 1}`);
const problemIds = ['a', 'b', 'c', 'd', 'e'];
const configuration = {
  contest: {
    contest_id: 'hydro-live-preview', name: 'Hydro 直播演示（模拟数据）',
    start_time: new Date(start).toISOString(),
    end_time: new Date(start + 5 * 60 * 60_000).toISOString(),
    freeze_time: new Date(start + 4 * 60 * 60_000).toISOString(), penalty_minutes: 20,
  },
  sites: [{ site_id: 'demo', name: '本地演示', secret: randomBytes(32).toString('hex') }],
  teams: teamIds.map((id, index) => ({
    team_id: id, name: teamNames[index], school_id: `school-${index % 3}`,
    school_name: `演示学校 ${String.fromCharCode(65 + index % 3)}`, official: index !== 7,
  })),
  problems: problemIds.map((id, index) => ({
    problem_id: id, label: id.toUpperCase(), name: `演示题目 ${id.toUpperCase()}`, ordinal: index,
    rgb: ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6'][index],
  })),
  team_mappings: teamIds.map((id, index) => ({
    site_id: 'demo', domain_id: 'system', contest_id: 'demo', local_uid: String(index + 1), team_id: id,
  })),
  problem_mappings: problemIds.map((id, index) => ({
    site_id: 'demo', domain_id: 'system', contest_id: 'demo', local_pid: String(index + 1), problem_id: id,
  })),
};
hub.database.importConfiguration(configuration, new Date().toISOString());
let sequence = 0;
let iteration = 0;
let child;
let childClosed;
let javaError;
let interval;
let settleTimer;
let stopping = false;
let finish;
const finished = new Promise((resolve) => { finish = resolve; });
const logs = createWriteStream(path.join(directory, 'live.log'));
const local = `http://127.0.0.1:${args.port}`;

function event(rid, uid, pid, status, submittedAt) {
  return {
    protocol_version: '1.0', event_type: 'submission.upsert', league_id: 'hydro-live-preview',
    site_id: 'demo', domain_id: 'system', contest_id: 'demo', rid, source_seq: ++sequence,
    uid, pid, status, lang: 'cpp', submitted_at: submittedAt,
    judged_at: new Date().toISOString(), emitted_at: new Date().toISOString(), rejudged: false,
  };
}
function ingest(events) {
  const now = new Date().toISOString();
  hub.database.ingestBatch({
    protocol_version: '1.0', batch_id: randomUUID(), league_id: 'hydro-live-preview',
    site_id: 'demo', sent_at: now, events,
  }, now);
}
function nextSubmission() {
  const turn = iteration++;
  const uid = turn % 8 + 1;
  const pid = (Math.floor(turn / 8) + 3) % 5 + 1;
  const rid = `live-${turn}`;
  const submittedAt = new Date().toISOString();
  ingest([event(rid, uid, pid, 'PENDING', submittedAt)]);
  settleTimer = setTimeout(() => {
    const status = turn % 5 === 0 ? 'WRONG_ANSWER' : turn % 11 === 0 ? 'COMPILE_ERROR' : 'ACCEPTED';
    ingest([event(rid, uid, pid, status, submittedAt)]);
  }, 2000);
}
async function close() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  clearTimeout(settleTimer);
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        cleanup.once('error', () => { child.kill('SIGTERM'); resolve(); });
        cleanup.once('exit', resolve);
      });
    } else child.kill('SIGTERM');
  }
  if (childClosed) await childClosed;
  if (!logs.closed) await new Promise((resolve) => logs.end(resolve));
  await hub.app.close();
  const target = path.resolve(directory);
  if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('hydro-live-preview-')) {
    throw new Error('Unexpected cleanup target');
  }
  await rm(target, { recursive: true, force: true });
  finish();
}
const signal = () => { void close().catch((error) => { console.error(error.message); process.exitCode = 1; finish(); }); };
process.once('SIGINT', signal);
process.once('SIGTERM', signal);

try {
  const initial = [];
  for (let uid = 1; uid <= 8; uid += 1) {
    for (let pid = 1; pid <= (uid % 3) + 1; pid += 1) {
      initial.push(event(`initial-${uid}-${pid}`, uid, pid,
        pid === 1 || uid % 2 === 0 ? 'ACCEPTED' : 'WRONG_ANSWER',
        new Date(start + (uid * 2 + pid * 3) * 60_000).toISOString()));
    }
  }
  ingest(initial);
  await hub.app.listen({ host: '127.0.0.1', port: 0 });
  const hubPort = hub.app.server.address().port;
  const profile = path.join(directory, 'config');
  await generateProfile({ hubUrl: `http://127.0.0.1:${hubPort}`, contestId: 'hydro-live-preview', outputDirectory: profile, token: broadcastToken });
  child = spawn(args.java, [
    '-jar', jar, `--config-directory=${profile}`, `--creds=${path.join(profile, 'creds.json')}`,
    `--port=${args.port}`, '--ktor-arg=-host=127.0.0.1', '--no-auth', '--disable-log-file',
  ], { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  childClosed = new Promise((resolve) => child.once('close', resolve));
  child.once('error', (error) => { javaError = error; });
  child.stdout.pipe(logs, { end: false });
  child.stderr.pipe(logs, { end: false });
  console.log('正在启动本地 Hydro + ICPC Live 演示……');
  let ready = false;
  for (let attempt = 0; attempt < 100 && !stopping; attempt += 1) {
    if (javaError) throw javaError;
    if (child.exitCode !== null) throw new Error(`ICPC Live exited with code ${child.exitCode}`);
    try {
      const response = await fetch(`${local}/api/overlay/scoreboard/normal`, { signal: AbortSignal.timeout(1000) });
      const board = await response.json();
      if (response.ok && board.order?.length === 8) { ready = true; break; }
    } catch { /* Wait for the JVM to load its initial event feed. */ }
    await sleep(300);
  }
  if (stopping) await finished;
  else {
    if (!ready) throw new Error('Live did not load the demo data within 30 seconds');
    for (const widget of ['scoreboard', 'queue']) {
      const response = await fetch(`${local}/api/admin/${widget}/show`, { method: 'POST' });
      if (!response.ok) throw new Error(`Could not enable ${widget}: HTTP ${response.status}`);
    }
    interval = setInterval(nextSubmission, 5000);
    child.once('exit', signal);
    const url = `${local}/overlay?noStatus&teamMediaAudio=false`;
    console.log(`榜单画面：${url}`);
    console.log(`控制台：${local}/admin`);
    console.log('这是本地模拟比赛，每 5 秒新增一次提交。保持终端开启，按 Ctrl+C 停止。');
    if (args.open) {
      const browser = process.platform === 'win32'
        ? spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'ignore' })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
      browser.once('error', () => console.log('请手动打开上面的榜单地址。'));
    }
    await finished;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await close();
}
