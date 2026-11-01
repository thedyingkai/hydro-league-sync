#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, access, writeFile, rename, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHubApplication, buildScoreboard } from '../../packages/league-hub/dist/src/index.js';
import { generateProfile } from './icpc-live.mjs';
import { multischoolPage } from './multischool-view.mjs';

const args = { port: 8080, java: 'java', open: true, exitAfter: 0 };
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (flag === '--no-open') { args.open = false; continue; }
  if (flag === '--help') {
    console.log('node --experimental-sqlite tools/icpc-live/multischool-preview.mjs --jar PATH [--port 8080] [--java PATH] [--no-open] [--report-file PATH] [--exit-after SECONDS]');
    process.exit(0);
  }
  const keys = { '--jar': 'jar', '--port': 'port', '--java': 'java', '--report-file': 'reportFile', '--exit-after': 'exitAfter' };
  const key = keys[flag];
  if (!key || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${flag}`);
  const value = process.argv[++index];
  args[key] = ['port', 'exitAfter'].includes(key) ? Number(value) : value;
}
if (!args.jar) throw new Error('--jar is required');
if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65515) throw new Error('Invalid port');
if (!Number.isFinite(args.exitAfter) || args.exitAfter < 0) throw new Error('Invalid --exit-after');
const jar = path.resolve(args.jar);
await access(jar);
const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
await access(path.join(toolDirectory, 'school-simulator.mjs'));
async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 20; port += 1) {
    const server = createServer();
    const available = await new Promise((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (available) { await new Promise((resolve) => server.close(resolve)); return port; }
  }
  throw new Error('No free Live port; use --port to choose another starting port');
}
const livePort = await availablePort(args.port);
const liveUrl = `http://127.0.0.1:${livePort}`;
const directory = await mkdtemp(path.join(tmpdir(), 'hydro-three-school-'));
const broadcastToken = randomBytes(32).toString('hex');
const hub = createHubApplication({
  databasePath: path.join(directory, 'hub.sqlite'), adminToken: randomBytes(32).toString('hex'), broadcastToken,
  delayedAfterMs: 3000, offlineAfterMs: 6000,
});
const startTime = new Date(Date.now() - 40 * 60_000).toISOString();
const start = Date.parse(startTime);
const leagueId = 'three-school-demo';
const schools = ['a', 'b', 'c'].map((letter, index) => ({
  siteId: `school-${letter}`, schoolName: ['甲校', '乙校', '丙校'][index],
  sharedSecret: randomBytes(32).toString('hex'), domainId: 'system', contestId: letter.repeat(24),
  teamUids: [101, 102, 103], problemPids: [1001, 1002, 1003, 1004, 1005, 1006],
}));
const configuration = {
  contest: { contest_id: leagueId, name: '三校联调演示（模拟数据）', start_time: startTime,
    end_time: new Date(start + 5 * 60 * 60_000).toISOString(), freeze_time: new Date(start + 4 * 60 * 60_000).toISOString(), penalty_minutes: 20 },
  sites: schools.map((school) => ({ site_id: school.siteId, name: school.schoolName, school_name: school.schoolName, secret: school.sharedSecret })),
  teams: schools.flatMap((school) => school.teamUids.map((uid, index) => ({
    team_id: `${school.siteId}-${uid}`, name: `${school.schoolName}·${['星河队', '二分答案', '探索队'][index]}`,
    school_id: school.siteId, school_name: school.schoolName, official: !(school.siteId === 'school-c' && index === 2),
  }))),
  problems: schools[0].problemPids.map((_, index) => ({ problem_id: `problem-${index + 1}`, label: String.fromCharCode(65 + index), name: `演示题 ${index + 1}`, ordinal: index,
    rgb: ['#e74c3c', '#3498db', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22'][index] })),
  team_mappings: schools.flatMap((school) => school.teamUids.map((uid) => ({ site_id: school.siteId, domain_id: school.domainId, contest_id: school.contestId, local_uid: String(uid), team_id: `${school.siteId}-${uid}` }))),
  problem_mappings: schools.flatMap((school) => school.problemPids.map((pid, index) => ({ site_id: school.siteId, domain_id: school.domainId, contest_id: school.contestId, local_pid: String(pid), problem_id: `problem-${index + 1}` }))),
};
hub.database.importConfiguration(configuration, new Date().toISOString());
const children = [];
const streams = [];
const schoolState = new Map();
const logs = [];
let hubUrl = '';
let readyAt = 0;
let phase = 'connecting';
let phaseLabel = '启动三个学校进程并连接 ICPC Live…';
let stopping = false;
let shutdown;
let fatalError;
let reportTimer;
let scenarioTimer;
let stopTimer;
let reporting = false;
let cycle = -1;
let disconnected = false;
let recovered = false;
let rejudged = false;
let finish;
const finished = new Promise((resolve) => { finish = resolve; });
function log(message) {
  const entry = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), message };
  logs.push(entry); if (logs.length > 30) logs.shift();
  console.log(`[${entry.time}] ${message}`);
}
function status() {
  const elapsedSeconds = readyAt ? Math.floor((Date.now() - readyAt) / 1000) : 0;
  const board = buildScoreboard(hub.database, 'public', hub.options);
  return {
    ready: Boolean(readyAt), hubUrl, liveUrl, dashboardUrl: `${hubUrl}/demo`, leagueId,
    scoreboardUrl: `${hubUrl}/api/v1/leagues/${leagueId}/scoreboard?view=public`,
    elapsedSeconds, cycleSeconds: elapsedSeconds % 80, phase, phaseLabel,
    complete: board?.accuracy.complete ?? false, stopped: stopping,
    schools: schools.map((school) => ({ siteId: school.siteId, name: school.schoolName,
      ...schoolState.get(school.siteId), hub: board?.sites.find((site) => site.site_id === school.siteId) ?? null })), logs,
  };
}
async function report() {
  if (!args.reportFile || reporting || stopping) return;
  reporting = true;
  try {
    const target = path.resolve(args.reportFile);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(`${target}.tmp`, JSON.stringify(status(), null, 2));
    await rename(`${target}.tmp`, target);
  } catch (error) { log(`状态报告暂时无法写入：${error.code ?? error.name}`); }
  finally { reporting = false; }
}
hub.app.get('/demo', async (_request, reply) => reply.type('text/html; charset=utf-8').send(multischoolPage(liveUrl)));
hub.app.get('/demo/status', async (_request, reply) => reply.header('cache-control', 'no-store').send(status()));
function track(child, name) {
  const closed = new Promise((resolve) => child.once('close', resolve));
  const item = { child, name, closed }; children.push(item);
  child.once('error', (error) => { fatalError = new Error(`${name}: ${error.message}`); if (readyAt) void close(); });
  child.once('exit', (code) => {
    if (!stopping) { fatalError = new Error(`${name} unexpectedly stopped (${code})`); log(fatalError.message); void close(); }
  });
  return item;
}
async function terminate(item) {
  const child = item.child;
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { child.kill('SIGTERM'); resolve(); }); killer.once('exit', resolve);
      });
    } else child.kill('SIGTERM');
  }
  await item.closed;
}
function close() {
  if (shutdown) return shutdown;
  stopping = true;
  shutdown = (async () => {
    clearInterval(reportTimer); clearInterval(scenarioTimer); clearTimeout(stopTimer);
    for (const item of children.filter((item) => item.name !== 'ICPC Live')) {
      if (item.child.connected) item.child.send({ type: 'stop' }, () => {});
    }
    // Graceful school shutdown persists its queue before process-tree cleanup.
    await Promise.race([Promise.all(children.filter((item) => item.name !== 'ICPC Live').map((item) => item.closed)), sleep(2000)]);
    await Promise.all(children.map(terminate));
    await Promise.all(streams.map((stream) => stream.closed ? undefined : new Promise((resolve) => stream.end(resolve))));
    if (args.reportFile) {
      while (reporting) await sleep(20);
      try { await writeFile(path.resolve(args.reportFile), JSON.stringify(status(), null, 2)); }
      catch (error) { console.error(`Final report unavailable: ${error.code ?? error.name}`); }
    }
    await hub.app.close();
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('hydro-three-school-')) throw new Error('Unexpected cleanup target');
    await rm(target, { recursive: true, force: true });
    if (fatalError) process.exitCode = 1;
  })().finally(finish);
  return shutdown;
}
const onSignal = () => { void close().catch((error) => { console.error(error.message); process.exitCode = 1; }); };
process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
function sendSchool(id, message) {
  const child = children.find((item) => item.name === id)?.child;
  if (!child?.connected) throw new Error(`${id} is not connected`);
  child.send(message, (error) => { if (error && !stopping) { fatalError = error; onSignal(); } });
}
function scenario() {
  const elapsed = Math.floor((Date.now() - readyAt) / 1000);
  const currentCycle = Math.floor(elapsed / 80);
  const second = elapsed % 80;
  if (currentCycle !== cycle) { cycle = currentCycle; disconnected = false; recovered = false; rejudged = false; phase = 'online'; phaseLabel = '三校正常上报，榜单持续更新'; }
  if (second >= 20 && !disconnected) {
    disconnected = true; sendSchool('school-b', { type: 'network', online: false });
    phase = 'school-b-offline'; phaseLabel = '乙校断联演练：本地继续评测，提交进入待发送队列'; log('乙校上报网络已断开；甲校、丙校继续同步。');
  }
  if (second >= 38 && !recovered) {
    recovered = true; sendSchool('school-b', { type: 'network', online: true });
    phase = 'recovering'; phaseLabel = '乙校恢复网络：自动补传积压，校对中心序列水位'; log('乙校网络恢复，开始补传独立队列。');
  }
  if (second >= 48 && !rejudged) {
    rejudged = true; sendSchool('school-c', { type: 'rejudge' });
    phase = 'rejudging'; phaseLabel = '丙校重判演练：更新原提交，重新计算排名'; log('请求丙校将一条历史 WA 重判为 AC。');
  }
}
try {
  await hub.app.listen({ host: '127.0.0.1', port: 0 });
  hubUrl = `http://127.0.0.1:${hub.app.server.address().port}`;
  for (const school of schools) {
    const configPath = path.join(directory, `${school.siteId}.json`);
    await writeFile(configPath, JSON.stringify({ ...school, centerUrl: hubUrl, leagueId, startTime,
      outputFile: path.join(directory, `${school.siteId}-outbox.json`), intervalMs: 4000,
      heartbeatIntervalMs: 1000, flushIntervalMs: 500, judgementDelayMs: 2000 }), { mode: 0o600 });
    const child = spawn(process.execPath, [path.join(toolDirectory, 'school-simulator.mjs'), '--config', configPath], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    track(child, school.siteId);
    const stream = createWriteStream(path.join(directory, `${school.siteId}.log`)); streams.push(stream);
    child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream, { end: false });
    schoolState.set(school.siteId, { pid: child.pid, simulator: {} });
    child.on('message', (message) => {
      if (!message || message.siteId !== school.siteId) return;
      const current = schoolState.get(school.siteId);
      if (message.type === 'status') current.simulator = message;
      if (message.type === 'ready') log(`${school.schoolName}独立模拟进程已启动，通过 HTTP/HMAC 上报。`);
      if (message.type === 'rejudged') { current.lastRejudge = message; log(`${school.schoolName}已重判 ${message.rid}：${message.fromStatus} → ${message.toStatus}`); }
    });
  }
  const profile = path.join(directory, 'live-config');
  await generateProfile({ hubUrl, contestId: leagueId, outputDirectory: profile, token: broadcastToken });
  const live = spawn(args.java, ['-jar', jar, `--config-directory=${profile}`, `--creds=${path.join(profile, 'creds.json')}`,
    `--port=${livePort}`, '--ktor-arg=-host=127.0.0.1', '--no-auth', '--disable-log-file'],
  { cwd: directory, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  track(live, 'ICPC Live');
  const liveLog = createWriteStream(path.join(directory, 'live.log')); streams.push(liveLog);
  live.stdout.pipe(liveLog, { end: false }); live.stderr.pipe(liveLog, { end: false });
  log('正在启动三校模拟联调与 ICPC Live…');
  reportTimer = setInterval(() => { void report(); }, 1000);
  let connected = false;
  for (let attempt = 0; attempt < 150 && !stopping; attempt += 1) {
    if (fatalError) throw fatalError;
    try {
      const response = await fetch(`${liveUrl}/api/overlay/scoreboard/normal`, { signal: AbortSignal.timeout(1000) });
      const board = await response.json();
      const synced = status().schools.every((school) => school.hub?.status === 'ONLINE'
        && school.hub.hub_high_watermark > 0 && school.hub.rejected_events === 0
        && school.hub.unmapped_count === 0 && school.hub.watermark_consistent);
      if (response.ok && board.order?.length === 9 && synced) { connected = true; break; }
    } catch { /* Wait for JVM startup and the schools' first heartbeats. */ }
    await sleep(300);
  }
  if (!stopping) {
    if (!connected) throw new Error('The three schools and Live did not connect within 45 seconds');
    for (const widget of ['scoreboard', 'queue']) {
      const response = await fetch(`${liveUrl}/api/admin/${widget}/show`, { method: 'POST' });
      if (!response.ok) throw new Error(`Unable to show ${widget}: HTTP ${response.status}`);
    }
    readyAt = Date.now(); scenario();
    scenarioTimer = setInterval(() => { try { scenario(); } catch (error) { fatalError = error; onSignal(); } }, 500);
    if (args.exitAfter) stopTimer = setTimeout(onSignal, args.exitAfter * 1000);
    await report();
    log(`三校联调页面：${hubUrl}/demo`);
    log(`独立直播画面：${liveUrl}/overlay?noStatus&teamMediaAudio=false`);
    log('每校3队，独立密钥和磁盘队列。20秒乙校断联，38秒恢复，48秒丙校重判；每80秒重复。Ctrl+C停止。');
    if (args.open) {
      const browser = process.platform === 'win32'
        ? spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${hubUrl}/demo'`], { windowsHide: true, stdio: 'ignore' })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [`${hubUrl}/demo`], { stdio: 'ignore' });
      browser.once('error', () => log('请手动打开上面的三校联调页面。'));
    }
    await finished;
  }
} catch (error) {
  fatalError = error; console.error(error.message); process.exitCode = 1;
} finally { await close(); }
