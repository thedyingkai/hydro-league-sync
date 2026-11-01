import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHubApplication, AUTH_HEADERS, canonicalJson, createRequestSignature, buildScoreboard } from '../../packages/league-hub/dist/src/index.js';
import { generateProfile } from '../../tools/icpc-live/icpc-live.mjs';

const cli = process.argv.slice(2);
const args = {};
for (let i = 0; i < cli.length; i += 2) {
  const flag = cli[i];
  if (!['--jar', '--java', '--evidence'].includes(flag) || !cli[i + 1] || cli[i + 1].startsWith('--')) {
    throw new Error('Usage: node test/integration/icpc-live-runtime.mjs --jar PATH [--java PATH] [--evidence PATH]');
  }
  args[flag.slice(2)] = cli[i + 1];
}
if (!args.jar) throw new Error('--jar PATH is required; download an official ICPC Live release first');
const jar = path.resolve(args.jar);
const java = args.java ?? 'java';
const evidencePath = args.evidence ? path.resolve(args.evidence) : null;
const base = await mkdtemp(path.join(tmpdir(), 'hydro-live-runtime-'));
const adminToken = randomBytes(32).toString('hex');
const broadcastToken = randomBytes(32).toString('hex');
const siteSecret = randomBytes(32).toString('hex');
const start = Date.now() - 10 * 60_000;
let now = new Date(start + 4 * 60_000 + 1000);
const iso = (offset) => new Date(start + offset).toISOString();
const leagueId = 'live-integration';
const siteId = 'school-a';
const teamIds = ['team-1', 'team-2', 'team-star', 'team-tie-fast', 'team-tie-slow'];
const config = {
  contest: { contest_id: leagueId, name: 'Hydro Live integration', start_time: iso(0), freeze_time: iso(300_000), end_time: iso(600_000), penalty_minutes: 20 },
  sites: [{ site_id: siteId, name: 'School A', school_name: 'School A', secret: siteSecret }],
  teams: teamIds.map((id) => ({ team_id: id, name: id, school_id: siteId, school_name: 'School A', official: id !== 'team-star' })),
  problems: [{ problem_id: 'a', label: 'A', name: 'Alpha', ordinal: 0 }, { problem_id: 'b', label: 'B', name: 'Beta', ordinal: 1 }],
  team_mappings: teamIds.map((id, i) => ({ site_id: siteId, domain_id: 'system', contest_id: '1', local_uid: String(i + 101), team_id: id })),
  problem_mappings: ['a','b'].map((id, i) => ({ site_id: siteId, domain_id: 'system', contest_id: '1', local_pid: String(i + 1), problem_id: id })),
};
const hub = createHubApplication({databasePath: ':memory:', adminToken, broadcastToken, now: () => now});
let child;
let childLog;
let sequence = 0;
const evidence = [];
const profile=path.join(base,`e2e-config-${Date.now()}`);
async function stopLive() {
  if(child?.pid && child.exitCode===null) {
    const stopped=new Promise(resolve=>child.once('close',resolve));
    // Windows java.exe may be a launcher shim with the real JVM as its child.
    // Stop only the process tree started by this runner.
    if (process.platform === 'win32') {
      await new Promise((resolve, reject) => {
        const kill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true, stdio:'ignore'});
        kill.once('error', reject);
        kill.once('exit', resolve);
      });
    } else child.kill('SIGTERM');
    await stopped;
  }
  if (childLog && !childLog.closed) await new Promise(resolve=>childLog.once('close',resolve));
}
async function launchLive() {
  const logs=createWriteStream(path.join(base,'e2e-live.log'), {flags:'a'});
  childLog=logs;
  child=spawn(java,['-jar',jar,`--config-directory=${profile}`,`--creds=${path.join(profile,'creds.json')}`,`--port=${livePort}`,'--ktor-arg=-host=127.0.0.1','--no-auth','--disable-log-file'],{cwd:base,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.pipe(logs,{end:false}); child.stderr.pipe(logs,{end:false});
  child.once('close',()=>logs.end());
  child.on('error',error=>console.error(error.message));
}
async function admin(url, payload = {}) {
  const result = await hub.app.inject({method:'POST', url, headers:{authorization:`Bearer ${adminToken}`}, payload});
  assert.equal(result.statusCode, 200, result.body);
  return result.json();
}
function event(rid, uid, pid, status, time, rejudged = false) {
  return {protocol_version:'1.0', event_type:'submission.upsert', league_id:leagueId, site_id:siteId, domain_id:'system', contest_id:'1', rid,
    source_seq:++sequence, uid, pid, status: ({AC:'ACCEPTED',WA:'WRONG_ANSWER',CE:'COMPILE_ERROR'})[status] ?? status, submitted_at:iso(time), emitted_at:now.toISOString(), judged_at:now.toISOString(), rejudged};
}
async function ingest(events) {
  const url=`/api/v1/sites/${siteId}/events:batch`;
  const payload = {protocol_version:'1.0', batch_id:randomUUID(), league_id:leagueId, site_id:siteId, sent_at:now.toISOString(), events};
  const body=canonicalJson(payload), timestamp=String(Math.floor(now.getTime()/1000)), nonce=randomUUID();
  const headers={ 'content-type':'application/json', [AUTH_HEADERS.siteId]:siteId, [AUTH_HEADERS.timestamp]:timestamp, [AUTH_HEADERS.nonce]:nonce,
    [AUTH_HEADERS.signature]:createRequestSignature({method:'POST', path:url, siteId, timestamp, nonce, body, secret:siteSecret})};
  const result = await hub.app.inject({method:'POST',url,headers,payload:body});
  assert.equal(result.statusCode,200,result.body);
  assert.equal(result.json().rejected.length, 0, result.body);
}
// Allocate an unused local port immediately before launching the JVM.
const { createServer } = await import('node:net');
const reservation = createServer();
await new Promise(resolve=>reservation.listen(0, '127.0.0.1', resolve));
const livePort = reservation.address().port;
await new Promise(resolve=>reservation.close(resolve));
const liveBase=`http://127.0.0.1:${livePort}`;
async function getLive(route) {
  const response=await fetch(`${liveBase}${route}`, {signal:AbortSignal.timeout(2000)});
  assert.equal(response.status,200);
  return response.json();
}
async function verify(stage) {
  const expected=buildScoreboard(hub.database,'public',hub.options);
  let actual, runs, info, lastError;
  for (let n=0;n<80;n++) {
    try {
      actual=await getLive('/api/overlay/scoreboard/normal');
      runs=await getLive('/api/overlay/runs');
      info=await getLive('/api/admin/advancedJsonPreview?fields=all');
      for (const row of expected.rows) {
        const live=actual.rows[row.team.team_id];
        assert.ok(live,`${stage}: missing ${row.team.team_id}`);
        assert.equal(live.totalScore,row.solved,`${stage}: ${row.team.team_id} solved`);
        assert.equal(live.penalty,row.penalty_minutes*60,`${stage}: ${row.team.team_id} penalty seconds`);
        assert.equal(live.lastAcceptedMs,row.last_solve_time_ms ?? 0,`${stage}: exact last AC milliseconds`);
        if (row.rank !== null) assert.equal(actual.ranks[actual.order.indexOf(row.team.team_id)],row.rank,`${stage}: rank`);
        for (let i=0;i<row.problems.length;i++) {
          assert.equal(live.problemResults[i].isSolved,row.problems[i].solved,`${stage}: solved per problem`);
          assert.equal(live.problemResults[i].pendingAttempts,row.problems[i].pending,`${stage}: pending per problem`);
        }
      }
      assert.equal(info.find(x=>x.type==='overrideTeams').rules['team-star'].isOutOfContest,true);
      assert.notEqual(actual.ranks[actual.order.indexOf('team-tie-fast')],actual.ranks[actual.order.indexOf('team-tie-slow')],`${stage}: same-second last AC must break tie`);
      lastError=null;
      break;
    } catch (error) { lastError=error; await new Promise(r=>setTimeout(r,250)); }
  }
  if (lastError) throw lastError;
  const entry={stage, virtualTime:now.toISOString(), frozen:expected.frozen, scoreboard:actual, runs, preview:info};
  evidence.push(entry);
  if (evidencePath) await writeFile(evidencePath,JSON.stringify(evidence,null,2));
  console.log(`PASS ${stage}: ${expected.rows.map(row=>`${row.team.team_id}=${row.solved}/${row.penalty_minutes} rank=${row.rank??'*'}`).join(', ')}`);
  return entry;
}
try {
  const configured=await hub.app.inject({method:'PUT',url:'/api/v1/admin/config',headers:{authorization:`Bearer ${adminToken}`},payload:config});
  assert.equal(configured.statusCode,200,configured.body);
  await hub.app.listen({host:'127.0.0.1',port:0});
  const port=hub.app.server.address().port;
  await ingest([event('ce',101,1,'CE',60_000),event('wa',101,1,'WA',120_000),event('ac1',101,1,'AC',180_000),event('ac2',102,1,'AC',240_000),event('star-a',103,1,'AC',120_000),event('star-b',103,2,'AC',180_000),event('tie-fast',104,1,'AC',180_499),event('tie-slow',105,1,'AC',180_999)]);
  await generateProfile({hubUrl:`http://127.0.0.1:${port}`,contestId:leagueId,outputDirectory:profile,token:broadcastToken});
  await launchLive();
  await verify('before-freeze');
  now=new Date(start+250_000);
  await ingest([event('ac2',102,1,'WA',240_000,true)]);
  await verify('rejudge-before-freeze');
  now=new Date(start+360_000);
  await ingest([event('edge-before',102,1,'AC',299_999),event('edge-exact',101,2,'AC',300_000),event('after-freeze',102,2,'AC',360_000)]);
  const frozen=await verify('frozen-boundary');
  assert.equal(frozen.runs.filter(x=>x.result.type==='IN_PROGRESS').length,2);
  await stopLive(); await launchLive();
  await verify('frozen-reconnect');
  now=new Date(start+610_000);
  await admin(`/api/v1/leagues/${leagueId}/finalize`,{force:true});
  await verify('finalized-still-frozen');
  now=new Date(start+620_000);
  await admin(`/api/v1/leagues/${leagueId}/publish-results`);
  await verify('published-results');
  await stopLive(); await launchLive();
  await verify('published-new-client');
  const html=await fetch(`${liveBase}/overlay?noStatus`);
  assert.equal(html.status,200);
  assert.match(await html.text(),/<html/i);
  console.log('PASS overlay HTML and all live scoring stages');
} finally {
  await stopLive();
  await hub.app.close();
  assert.equal(path.dirname(path.resolve(base)),path.resolve(tmpdir()),'cleanup must stay in the intended temporary directory');
  assert.ok(path.basename(base).startsWith('hydro-live-runtime-'),'cleanup must target the runner-created directory');
  await rm(base, {recursive:true, force:true});
}
