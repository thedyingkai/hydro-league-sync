import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifyRequest } from '../../packages/protocol/dist/hmac.js';
import { SchoolSimulator } from './school-simulator.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hydro-school-simulator-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { centerUrl: 'http://127.0.0.1:3000', leagueId: 'demo', siteId: 'school-a',
    sharedSecret: 'test-school-secret-with-at-least-thirty-two-bytes', domainId: 'system',
    contestId: '0123456789abcdef01234567', outputFile: join(directory, 'outbox.json'),
    startTime: '2026-01-01T00:00:00Z', teamUids: [101, 102, 103], problemPids: [1001, 1002, 1003],
    intervalMs: 4000, judgementDelayMs: 2000 };
}

function acceptingTransport() {
  return {
    batches: [], heartbeats: [],
    async sendBatch(events) {
      this.batches.push(structuredClone(events));
      return { high_watermark: Math.max(...events.map((event) => event.source_seq)), rejected: [] };
    },
    async sendHeartbeat(body) { this.heartbeats.push(structuredClone(body)); },
  };
}

test('offline generation persists and restart reuses source sequences and pending judgements', async (t) => {
  const config = await fixture(t);
  let clock = new Date('2026-01-01T00:10:00Z');
  const transport = acceptingTransport();
  const simulator = await SchoolSimulator.create(config, { transport, now: () => clock });
  await simulator.setOnline(false);
  await simulator.seed();
  const rid = await simulator.generateSubmission();
  assert.equal(simulator.status().queued, 7);
  await simulator.flushOnce();
  await simulator.heartbeatOnce();
  assert.equal(transport.batches.length, 0);
  assert.equal(transport.heartbeats.length, 0);
  await simulator.stop();
  assert.equal((await readFile(config.outputFile, 'utf8')).includes(config.sharedSecret), false);
  const restored = await SchoolSimulator.create(config, { transport, now: () => clock });
  t.after(() => restored.stop());
  await restored.seed();
  assert.equal(restored.status().records, 7, 'seed is not repeated on restart');
  clock = new Date(clock.getTime() + 2500);
  await restored.finishJudgements();
  assert.equal(restored.status().generated, 8);
  await restored.flushOnce();
  assert.equal(restored.status().queued, 0);
  assert.equal(restored.status().acked, 8);
  const revisions = transport.batches.flat().filter((event) => event.rid === rid);
  assert.equal(revisions.length, 2);
  assert.equal(revisions[0].status, 'PENDING');
  assert.notEqual(revisions[1].status, 'PENDING');
  assert.equal(revisions[0].submitted_at, revisions[1].submitted_at);
  assert.deepEqual(transport.batches[0].map((event) => event.source_seq), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('lost ACK retries exact events and concurrent generation is never removed by an earlier ACK', async (t) => {
  const config = await fixture(t);
  const delivered = [];
  let release;
  let attempts = 0;
  const transport = {
    async sendBatch(events) {
      delivered.push(structuredClone(events));
      attempts += 1;
      if (attempts === 1) throw new Error('ACK was lost after server commit');
      if (attempts === 2) await new Promise((resolve) => { release = resolve; });
      return { high_watermark: events.at(-1).source_seq, rejected: [] };
    }, async sendHeartbeat() {},
  };
  const simulator = await SchoolSimulator.create(config, { transport });
  t.after(() => simulator.stop());
  await simulator.seed();
  await simulator.flushOnce();
  assert.equal(simulator.status().queued, 6);
  const flushing = simulator.flushOnce();
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  await simulator.generateSubmission();
  release();
  await flushing;
  assert.deepEqual(delivered[0], delivered[1]);
  assert.equal(simulator.status().queued, 1, 'new unsent event survives the ACK');
  assert.equal(simulator.status().lastAckedSourceSeq, 6);
  await simulator.flushOnce();
  assert.equal(simulator.status().acked, 7);
  assert.equal(simulator.status().queued, 0);
});

test('retryable and terminal rejections have different durable dispositions', async (t) => {
  const config = await fixture(t);
  let calls = 0;
  const transport = {
    async sendBatch(events) {
      calls += 1;
      return { high_watermark: 6, rejected: calls === 1 ? [
        { source_seq: 2, retryable: true, code: 'temporary' },
        { source_seq: 3, retryable: false, code: 'invalid_mapping' },
      ] : [] };
    }, async sendHeartbeat() {},
  };
  const simulator = await SchoolSimulator.create(config, { transport });
  t.after(() => simulator.stop());
  await simulator.seed();
  await simulator.flushOnce();
  assert.equal(simulator.status().acked, 4);
  assert.equal(simulator.status().rejected, 1);
  assert.equal(simulator.status().queued, 1);
  const state = JSON.parse(await readFile(config.outputFile, 'utf8'));
  assert.equal(state.queue[0].source_seq, 2);
  assert.equal(state.rejected[0].event.source_seq, 3);
  await simulator.flushOnce();
  assert.equal(simulator.status().acked, 5);
  assert.equal(simulator.status().rejected, 1);
  assert.equal(simulator.status().queued, 0);
});

test('first rejudge changes an unsolved WA to AC without changing submission identity', async (t) => {
  const config = await fixture(t);
  const transport = acceptingTransport();
  const messages = [];
  const simulator = await SchoolSimulator.create(config, { transport, onMessage: (message) => messages.push(message) });
  t.after(() => simulator.stop());
  await simulator.seed();
  await simulator.flushOnce();
  const original = transport.batches[0].find((event) => event.status === 'WRONG_ANSWER');
  const result = await simulator.rejudge();
  const revision = transport.batches[1][0];
  assert.equal(revision.rid, original.rid);
  assert.equal(revision.submitted_at, original.submitted_at);
  assert.equal(revision.uid, 102);
  assert.equal(revision.pid, 1001);
  assert.equal(revision.status, 'ACCEPTED');
  assert.equal(revision.rejudged, true);
  assert.equal(result.rid, original.rid);
  assert.ok(messages.some((message) => message.type === 'rejudged' && message.fromStatus === 'WRONG_ANSWER' && message.sourceSeq === 7));
});

test('default transport signs actual HTTP uploads and blocks both uploads and heartbeats while offline', async (t) => {
  const config = await fixture(t);
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const hmacHeaders = Object.fromEntries(Object.entries(request.headers).filter(([name]) => name.startsWith('x-hydro-league-')));
    const verification = verifyRequest({ method: request.method, path: request.url, headers: hmacHeaders,
      body, secret: config.sharedSecret });
    assert.equal(verification.ok, true);
    const payload = JSON.parse(body);
    received.push({ path: request.url, payload });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(request.url.endsWith('/heartbeat') ? { ok: true } : {
      protocol_version: '1.0', batch_id: payload.batch_id, league_id: config.leagueId, site_id: config.siteId,
      accepted_count: payload.events.length, duplicate_count: 0, rejected: [],
      high_watermark: payload.events.at(-1).source_seq, received_at: new Date().toISOString(),
    }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  config.centerUrl = `http://127.0.0.1:${server.address().port}`;
  const simulator = await SchoolSimulator.create(config);
  t.after(() => simulator.stop());
  await simulator.seed();
  await simulator.flushOnce();
  await simulator.heartbeatOnce();
  assert.equal(received.length, 2);
  assert.equal(received[1].payload.pending_events, 0);
  assert.equal(received[1].payload.last_acked_source_seq, 6);
  await simulator.setOnline(false);
  await simulator.generateSubmission();
  await simulator.flushOnce();
  await simulator.heartbeatOnce();
  assert.equal(received.length, 2);
  assert.equal(simulator.status().queued, 1);
  await simulator.setOnline(true);
  assert.equal(received.length, 4);
  assert.equal(simulator.status().queued, 0);
});
