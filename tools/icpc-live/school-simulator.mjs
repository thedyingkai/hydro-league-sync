#!/usr/bin/env node
// Rehearsal only: this JSON outbox models a school process. Production Hydro uses
// MongoOutbox. Network delivery below is the real Agent HTTP/HMAC transport.
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeConfig } from '../../packages/hydro-league-agent/dist/config.js';
import { HttpHubTransport } from '../../packages/hydro-league-agent/dist/transport.js';

function validateConfig(config) {
  const result = {
    domainId: 'system', intervalMs: 4000, judgementDelayMs: 2000,
    heartbeatIntervalMs: 2000, flushIntervalMs: 500, requestTimeoutMs: 1500,
    ...config,
  };
  for (const key of ['centerUrl', 'leagueId', 'siteId', 'sharedSecret', 'domainId', 'contestId', 'outputFile', 'startTime']) {
    if (typeof result[key] !== 'string' || !result[key]) throw new Error(`Simulator config requires ${key}`);
  }
  if (!/^[a-f\d]{24}$/i.test(result.contestId)) throw new Error('Simulator contestId must be a 24-character ObjectId');
  if (!Number.isFinite(Date.parse(result.startTime))) throw new Error('Invalid simulator startTime');
  for (const key of ['teamUids', 'problemPids']) {
    if (!Array.isArray(result[key]) || result[key].length < (key === 'problemPids' ? 2 : 1)
      || !result[key].every((item) => Number.isSafeInteger(item) && item > 0)
      || new Set(result[key]).size !== result[key].length) throw new Error(`Invalid simulator ${key}`);
  }
  for (const key of ['intervalMs', 'judgementDelayMs', 'heartbeatIntervalMs', 'flushIntervalMs', 'requestTimeoutMs']) {
    if (!Number.isInteger(result[key]) || result[key] < 20) throw new Error(`Invalid simulator ${key}`);
  }
  result.outputFile = resolve(result.outputFile);
  return result;
}

async function persist(filename, state) {
  const temporary = `${filename}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state, null, 2) + '\n'); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export class SchoolSimulator {
  static async create(input, dependencies = {}) {
    const simulator = new SchoolSimulator(validateConfig(input), dependencies);
    await simulator.load();
    return simulator;
  }

  constructor(config, { transport, fetchImpl = fetch, now = () => new Date(), onMessage = () => {} } = {}) {
    this.config = config;
    this.now = now;
    this.onMessage = onMessage;
    this.online = true;
    this.stopped = false;
    this.started = false;
    this.flushing = false;
    this.heartbeatSending = false;
    this.mutation = Promise.resolve();
    this.timers = [];
    this.networkController = new AbortController();
    const agent = normalizeConfig({
      enabled: true, centerUrl: config.centerUrl, leagueId: config.leagueId,
      siteId: config.siteId, sharedSecret: config.sharedSecret,
      contests: [{ domainId: config.domainId, contestId: config.contestId }],
      requestTimeoutMs: config.requestTimeoutMs,
    });
    this.transport = transport ?? new HttpHubTransport(agent, (input, init = {}) => {
      if (!this.online || this.stopped) throw new Error('Simulated school network is offline');
      return fetchImpl(input, {
        ...init,
        signal: AbortSignal.any([...(init.signal ? [init.signal] : []), this.networkController.signal]),
      });
    });
  }

  identity() {
    const { leagueId, siteId, domainId, contestId } = this.config;
    return { leagueId, siteId, domainId, contestId };
  }

  async load() {
    await mkdir(dirname(this.config.outputFile), { recursive: true });
    try {
      const state = JSON.parse(await readFile(this.config.outputFile, 'utf8'));
      if (state.version !== 1 || JSON.stringify(state.identity) !== JSON.stringify(this.identity())
        || !Number.isSafeInteger(state.nextSeq) || state.nextSeq < 1
        || !Array.isArray(state.queue) || !Array.isArray(state.records) || !Array.isArray(state.pendingFinals)
        || !Array.isArray(state.rejected) || !Number.isSafeInteger(state.acked) || !Number.isSafeInteger(state.tickIndex)
        || !Number.isSafeInteger(state.lastAckedSourceSeq)
        || state.queue.some((event) => !Number.isSafeInteger(event.source_seq) || event.source_seq < 1 || event.source_seq >= state.nextSeq
          || event.site_id !== this.config.siteId || event.league_id !== this.config.leagueId)) {
        throw new Error('Invalid persisted simulator state');
      }
      this.state = state;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Unable to restore simulator outbox; retain the file for inspection');
      this.state = { version: 1, identity: this.identity(), nextSeq: 1, acked: 0,
        lastAckedSourceSeq: 0, tickIndex: 0, initialized: false, queue: [], records: [], pendingFinals: [], rejected: [] };
      await persist(this.config.outputFile, this.state);
    }
  }

  status() {
    return { type: 'status', siteId: this.config.siteId, schoolName: this.config.schoolName ?? this.config.siteId,
      pid: process.pid, generated: this.state.nextSeq - 1, submissions: this.state.records.length, records: this.state.records.length,
      queued: this.state.queue.length, acked: this.state.acked, lastAckedSourceSeq: this.state.lastAckedSourceSeq,
      rejected: this.state.rejected.length, online: this.online, running: !this.stopped };
  }

  emitStatus() { this.onMessage(this.status()); }
  log(message) { this.onMessage({ type: 'log', siteId: this.config.siteId, message }); }

  mutate(change) {
    const operation = this.mutation.then(async () => {
      const next = structuredClone(this.state);
      const result = change(next);
      await persist(this.config.outputFile, next);
      this.state = next;
      this.emitStatus();
      return result;
    });
    this.mutation = operation.catch(() => {});
    return operation;
  }

  append(state, record, status, judgedAt) {
    const event = {
      protocol_version: '1.0', event_type: 'submission.upsert', league_id: this.config.leagueId,
      site_id: this.config.siteId, source_seq: state.nextSeq++, domain_id: this.config.domainId,
      contest_id: this.config.contestId, rid: record.rid, uid: record.uid, pid: record.pid,
      status, submitted_at: record.submitted_at, emitted_at: this.now().toISOString(),
      lang: 'cpp', rejudged: Boolean(record.rejudged),
      ...(judgedAt ? { judged_at: judgedAt } : {}),
    };
    state.queue.push(event);
    record.status = status;
    return event;
  }

  record(uid, pid, submittedAt) {
    const timestamp = Math.floor(Date.parse(submittedAt) / 1000).toString(16).padStart(8, '0');
    return { rid: timestamp + randomBytes(8).toString('hex'), uid, pid, submitted_at: submittedAt, status: 'PENDING', rejudged: false };
  }

  async seed() {
    if (this.state.initialized) return;
    await this.mutate((state) => {
      if (state.initialized) return;
      const now = this.now().getTime();
      const begin = Math.max(Date.parse(this.config.startTime), now - 180000);
      if (begin > now) throw new Error('Simulator contest has not started yet');
      this.config.teamUids.forEach((uid, index) => {
        const statuses = ['COMPILE_ERROR', index % 2 === 1 ? 'WRONG_ANSWER' : 'ACCEPTED'];
        statuses.forEach((status, attempt) => {
          const time = new Date(Math.min(now, begin + (index * 2 + attempt) * 1000)).toISOString();
          const record = this.record(uid, this.config.problemPids[0], time);
          state.records.push(record);
          this.append(state, record, status, time);
        });
      });
      state.initialized = true;
    });
  }

  async generateSubmission() {
    if (this.stopped) return null;
    return this.mutate((state) => {
      const index = state.tickIndex++;
      const uid = this.config.teamUids[index % this.config.teamUids.length];
      const pid = this.config.problemPids[1 + Math.floor(index / this.config.teamUids.length) % (this.config.problemPids.length - 1)];
      const record = this.record(uid, pid, this.now().toISOString());
      const outcomes = ['WRONG_ANSWER', 'ACCEPTED', 'COMPILE_ERROR', 'ACCEPTED', 'TIME_LIMIT_EXCEEDED', 'ACCEPTED'];
      const siteOffset = [...this.config.siteId].reduce((sum, character) => sum + character.charCodeAt(0), 0);
      state.records.push(record);
      this.append(state, record, 'PENDING');
      state.pendingFinals.push({ rid: record.rid, dueAt: this.now().getTime() + this.config.judgementDelayMs,
        status: outcomes[(index + siteOffset) % outcomes.length] });
      return record.rid;
    });
  }

  async finishJudgements() {
    if (this.stopped || !this.state.pendingFinals.some((pending) => pending.dueAt <= this.now().getTime())) return;
    await this.mutate((state) => {
      const now = this.now();
      const due = state.pendingFinals.filter((pending) => pending.dueAt <= now.getTime());
      state.pendingFinals = state.pendingFinals.filter((pending) => pending.dueAt > now.getTime());
      for (const pending of due) {
        const record = state.records.find((item) => item.rid === pending.rid);
        if (record) this.append(state, record, pending.status, now.toISOString());
      }
    });
  }

  async rejudge() {
    if (this.stopped) return null;
    const result = await this.mutate((state) => {
      const record = state.records.find((item) => item.status === 'WRONG_ANSWER');
      if (!record) return null;
      record.rejudged = true;
      const event = this.append(state, record, 'ACCEPTED', this.now().toISOString());
      return { rid: record.rid, uid: record.uid, pid: record.pid, sourceSeq: event.source_seq,
        submittedAt: record.submitted_at, fromStatus: 'WRONG_ANSWER', toStatus: 'ACCEPTED' };
    });
    this.onMessage({ type: 'rejudged', siteId: this.config.siteId, ...result, changed: result !== null });
    await this.flushOnce();
    return result;
  }

  async flushOnce() {
    if (this.stopped || !this.online || this.flushing) return 0;
    this.flushing = true;
    try {
      await this.mutation;
      const sent = this.state.queue.slice(0, 100);
      if (!sent.length) return 0;
      const ack = await this.transport.sendBatch(structuredClone(sent));
      if (!Number.isSafeInteger(ack.high_watermark) || ack.high_watermark < 0 || !Array.isArray(ack.rejected)) throw new Error('Invalid ACK');
      const sentSequences = new Set(sent.map((event) => event.source_seq));
      const rejected = new Map(ack.rejected.filter((item) => sentSequences.has(item.source_seq)).map((item) => [item.source_seq, item]));
      await this.mutate((state) => {
        state.queue = state.queue.filter((event) => {
          if (!sentSequences.has(event.source_seq)) return true;
          const rejection = rejected.get(event.source_seq);
          if (rejection?.retryable) return true;
          if (rejection) {
            state.rejected.push({ event, code: rejection.code ?? 'rejected' });
            return false;
          }
          if (event.source_seq <= ack.high_watermark) { state.acked += 1; return false; }
          return true;
        });
        state.lastAckedSourceSeq = Math.max(state.lastAckedSourceSeq, Math.min(ack.high_watermark, state.nextSeq - 1));
      });
      return sent.length;
    } catch (error) {
      // No queue mutation on failed or ambiguous uploads. The Hub deduplicates
      // retransmitted source_seq values even when an ACK was lost on the network.
      this.log(error?.status ? `Upload retained for retry (HTTP ${error.status})` : 'Upload retained for retry');
      return 0;
    } finally { this.flushing = false; this.emitStatus(); }
  }

  async heartbeatOnce() {
    if (this.stopped || !this.online || this.heartbeatSending) return;
    this.heartbeatSending = true;
    try {
      await this.mutation;
      await this.transport.sendHeartbeat({ protocol_version: '1.0', league_id: this.config.leagueId,
        site_id: this.config.siteId, sent_at: this.now().toISOString(), pending_events: this.state.queue.length,
        rejected_events: this.state.rejected.length, last_acked_source_seq: this.state.lastAckedSourceSeq,
        agent_version: '0.1.2-simulator', hydro_version: 'simulated-5.0.0-beta.9' });
    } catch { this.log('Heartbeat deferred until network recovery'); }
    finally { this.heartbeatSending = false; }
  }

  async setOnline(online) {
    this.online = Boolean(online);
    if (!this.online) this.networkController.abort();
    else if (this.networkController.signal.aborted) this.networkController = new AbortController();
    this.emitStatus();
    if (this.online) { await this.flushOnce(); await this.heartbeatOnce(); }
  }

  async start() {
    if (this.started || this.stopped) return;
    this.started = true;
    await this.seed();
    if (this.stopped) return;
    const schedule = (interval, action) => this.timers.push(setInterval(() => {
      void action().catch(() => this.log('Simulator operation failed; persisted outbox retained'));
    }, interval));
    schedule(this.config.intervalMs, () => this.generateSubmission());
    schedule(Math.min(250, this.config.judgementDelayMs), () => this.finishJudgements());
    schedule(this.config.flushIntervalMs, () => this.flushOnce());
    schedule(this.config.heartbeatIntervalMs, () => this.heartbeatOnce());
    await this.flushOnce();
    await this.heartbeatOnce();
    if (!this.stopped) this.onMessage({ ...this.status(), type: 'ready' });
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    this.networkController.abort();
    await this.mutation;
    // The request abort above resolves real in-flight HTTP calls. Wait for their
    // ACK/retain paths before telling the parent it is safe to end this process.
    while (this.flushing || this.heartbeatSending) await new Promise((done) => setTimeout(done, 10));
    await this.mutation;
    this.emitStatus();
  }
}

async function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--config') throw new Error('Usage: node school-simulator.mjs --config private-school.json');
  let config;
  try { config = JSON.parse(await readFile(argv[1], 'utf8')); }
  catch { throw new Error('Unable to read simulator configuration'); }
  const send = (message) => { if (process.connected) process.send(message); };
  const simulator = await SchoolSimulator.create(config, { onMessage: send });
  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    await simulator.stop();
    if (process.connected) process.disconnect();
  };
  process.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    let operation;
    if (message.type === 'network' && typeof message.online === 'boolean') operation = simulator.setOnline(message.online);
    else if (message.type === 'rejudge') operation = simulator.rejudge();
    else if (message.type === 'stop') operation = stop();
    if (operation) void operation.catch(() => send({ type: 'log', siteId: config.siteId, message: 'Simulator control failed; outbox retained' }));
  });
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  process.once('disconnect', () => void stop());
  await simulator.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    console.error('School simulator failed. Check the private configuration and persisted outbox.');
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  });
}
