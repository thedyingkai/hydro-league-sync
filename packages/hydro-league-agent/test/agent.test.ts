import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Schema from 'schemastery';
import { describe, expect, it, vi } from 'vitest';
import {
  SubmissionEventSchema,
  verifyRequest,
} from '../../protocol/src/index.js';
import { Config, DEFAULT_CENTER_URL, normalizeConfig } from '../src/config.js';
import {
  WIRE_EVENT_KEYS,
  assertMetadataOnlyEvent,
  createEventDraft,
  mapHydroStatus,
} from '../src/event-factory.js';
import {
  CAPTURE_COLLECTION,
  MongoOutbox,
  OUTBOX_COLLECTION,
} from '../src/outbox.js';
import { RecordCaptureService } from '../src/capture.js';
import { DeliveryWorker, interpretAck } from '../src/worker.js';
import { HttpHubTransport } from '../src/transport.js';
import { ReconciliationService } from '../src/reconciliation.js';
import { applyAgent, type HydroContextLike } from '../src/hydro-adapter.js';
import {
  parseScoreboardResponse,
  parseSiteStatusResponse,
  parseSubmissionFeedResponse,
  parseXcpcioAllInOneResponse,
} from '../src/hub-response.js';
import type {
  AgentConfig,
  BatchAck,
  ContestBindingConfig,
  HydroRecordLike,
  HubTransport,
  OutboxDocument,
  SnapshotEnvelope,
} from '../src/types.js';
import {
  MemoryMongo,
  MutableClock,
  silentLogger,
  transportStub,
} from './fakes.js';
import { createXcpcioFrameUrl } from '../frontend/xcpcio-frame.js';

const CONTEST_ID = '64f000000000000000000001';
const RID = '64f000010000000000000002';
const SHARED_SECRET = 'test-shared-secret-with-32-bytes!!';
const PACKAGE_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function hydroBeta9SettingProxy<T>(value: T): T {
  const blacklist = ['__proto__', 'prototype', 'constructor'];
  const getAccess = (pathParts: Array<string | symbol>): unknown => {
    if (pathParts.some((part) => blacklist.includes(part.toString()))) {
      throw new Error('Invalid path');
    }
    let current: any = value;
    for (const part of pathParts) current = current[part];
    if (typeof current !== 'object' || !current) return current;
    return new Proxy(current, {
      get(_target, key) {
        return getAccess([...pathParts, key]);
      },
    });
  };
  return getAccess([]) as T;
}

function makeAck(overrides: Partial<BatchAck> = {}): BatchAck {
  return {
    protocol_version: '1.0',
    batch_id: '00000000-0000-4000-8000-000000000000',
    league_id: 'league-2026',
    site_id: 'school-a',
    accepted_count: 0,
    duplicate_count: 0,
    rejected: [],
    high_watermark: 0,
    received_at: '2026-08-30T05:00:07.000Z',
    ...overrides,
  };
}

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return normalizeConfig({
    enabled: true,
    centerUrl: DEFAULT_CENTER_URL,
    leagueId: 'league-2026',
    siteId: 'school-a',
    sharedSecret: SHARED_SECRET,
    contests: [{ domainId: 'system', contestId: CONTEST_ID }],
    ...overrides,
  });
}

function record(overrides: Partial<HydroRecordLike> = {}): HydroRecordLike {
  return {
    _id: RID,
    domainId: 'system',
    contest: CONTEST_ID,
    uid: 1001,
    pid: 1,
    status: 7,
    score: 0,
    lang: 'cpp17',
    judgeAt: new Date('2026-08-30T05:00:05.000Z'),
    rejudged: false,
    code: '#include <secret>',
    source: 'do not upload',
    files: { 'answer.cpp': 'do not upload' },
    testdata: [{ input: 'secret', output: 'secret' }],
    compilerText: 'private compiler output',
    ...overrides,
  };
}

function xcpcioAllInOne() {
  return {
    contest: {
      contest_name: 'League 2026',
      start_time: 1_777_520_000,
      end_time: 1_777_538_000,
      frozen_time: 3_600,
      penalty: 1_200,
      problem_quantity: 1,
      problem_id: ['A'],
      group: { official: 'Official' },
      organization: 'School',
      status_time_display: { correct: true, incorrect: true, pending: true },
      medal: 'icpc' as const,
      logo: { preset: 'ICPC' as const },
      options: { submission_timestamp_unit: 'millisecond' as const },
    },
    teams: [{
      team_id: 'TEAM-001',
      name: 'Team 1',
      organization: 'School A',
      members: ['Alice'],
      group: ['official'],
    }],
    submissions: [{
      problem_id: 0,
      team_id: 'TEAM-001',
      timestamp: 60_000,
      status: 'CORRECT' as const,
      language: 'cpp17',
      submission_id: 'school-a/system/contest/rid',
    }],
  };
}

describe('configuration and event privacy', () => {
  it('uses a Hydro beta9-safe package name as the Schemastery config scope', async () => {
    const packageJson = JSON.parse(await readFile(path.join(PACKAGE_DIRECTORY, 'package.json'), 'utf8')) as {
      name: string;
      bundledDependencies: string[];
    };
    expect(packageJson.name).toBe('hydro-league-agent');
    expect(packageJson.name).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(packageJson.bundledDependencies).toEqual(['@react-spring/web', 'schemastery']);
    expect(() => Schema.object({ [packageJson.name]: Config })).not.toThrow();
  });

  it('locks the self-contained runtime dependency bundle', async () => {
    const shrinkwrap = JSON.parse(
      await readFile(path.join(PACKAGE_DIRECTORY, 'npm-shrinkwrap.json'), 'utf8'),
    ) as { packages: Record<string, unknown> };

    expect(shrinkwrap.packages['node_modules/@react-spring/web']).toBeDefined();
    expect(shrinkwrap.packages['node_modules/schemastery']).toBeDefined();
    expect(shrinkwrap.packages['node_modules/hydrooj']).toBeUndefined();
  });

  it('survives Hydro beta9 double schema resolution through its settings proxy', async () => {
    const packageJson = JSON.parse(await readFile(path.join(PACKAGE_DIRECTORY, 'package.json'), 'utf8')) as {
      name: string;
    };
    const requestSchema = Schema.object({ [packageJson.name]: Config });
    const requested = requestSchema({
      [packageJson.name]: {
        contests: [{ domainId: 'system', contestId: CONTEST_ID }],
      },
    }) as Record<string, unknown>;
    const proxied = hydroBeta9SettingProxy(requested)[packageJson.name] as Parameters<typeof normalizeConfig>[0];

    expect(() => Config(proxied)).not.toThrow();
    expect(normalizeConfig(proxied).contests).toEqual([{
      domainId: 'system',
      contestId: CONTEST_ID,
    }]);
  });

  it('defaults to the local loopback hub and blocks accidental remote plain HTTP', () => {
    expect(normalizeConfig().centerUrl).toBe('http://127.0.0.1:3000');
    expect(() => normalizeConfig({ centerUrl: 'http://example.com:3000' })).toThrow(/Plain HTTP/);
    expect(normalizeConfig({ centerUrl: 'https://hub.example.com' }).centerUrl).toBe('https://hub.example.com');
    expect(() => normalizeConfig({ centerUrl: 'https://hub.example.com/prefix' })).toThrow(/without a path prefix/);
    expect(() => normalizeConfig({
      enabled: true,
      leagueId: 'league-2026',
      siteId: 'school-a',
      sharedSecret: 'too-short',
      contests: [{ domainId: 'system', contestId: CONTEST_ID }],
    })).toThrow(/at least 32 UTF-8 bytes/);
  });

  it('maps beta.9 statuses to protocol v1 names', () => {
    expect(mapHydroStatus(1)).toBe('ACCEPTED');
    expect(mapHydroStatus(3)).toBe('TIME_LIMIT_EXCEEDED');
    expect(mapHydroStatus(4)).toBe('MEMORY_LIMIT_EXCEEDED');
    expect(mapHydroStatus(5)).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(mapHydroStatus(6)).toBe('RUNTIME_ERROR');
    expect(mapHydroStatus(7)).toBe('COMPILE_ERROR');
  });

  it('builds a strict metadata-only event without fake global IDs', () => {
    const draft = createEventDraft(record(), config(), new Date('2026-08-30T05:00:06.000Z'));
    expect(draft).not.toBeNull();
    const event = draft!.create(1);
    expect(() => SubmissionEventSchema.parse(event)).not.toThrow();
    expect(() => assertMetadataOnlyEvent(event)).not.toThrow();
    expect(Object.keys(event).every((key) => (WIRE_EVENT_KEYS as readonly string[]).includes(key))).toBe(true);
    expect(event).not.toHaveProperty('global_team_id');
    expect(event).not.toHaveProperty('global_problem_id');
    expect(event).not.toHaveProperty('code');
    expect(event).not.toHaveProperty('source');
    expect(event).not.toHaveProperty('files');
    expect(event).not.toHaveProperty('testdata');
    expect(event.status).toBe('COMPILE_ERROR');
  });

  it('adds global mapping hints only when explicitly configured', () => {
    const event = createEventDraft(record(), config({
      contests: [{
        domainId: 'system',
        contestId: CONTEST_ID,
        teamMapping: { '1001': 'TEAM-001' },
        problemMapping: { '1': 'A' },
      }],
    }), new Date('2026-08-30T05:00:06.000Z'))!.create(8);
    expect(event.global_team_id).toBe('TEAM-001');
    expect(event.global_problem_id).toBe('A');
  });
});

describe('durable outbox and delivery', () => {
  it('deduplicates identical record/judge callbacks while assigning source_seq atomically', async () => {
    const mongo = new MemoryMongo();
    const clock = new MutableClock(new Date('2026-08-30T05:00:06.000Z'));
    const outbox = await MongoOutbox.fromMongo(mongo, 'school-a', clock);
    const capture = new RecordCaptureService(config(), outbox, silentLogger, clock);

    const first = await capture.capture(record());
    const second = await capture.capture(record());

    expect(first?.sourceSeq).toBe(1);
    expect(second?.sourceSeq).toBe(1);
    expect(mongo.collection<OutboxDocument>(OUTBOX_COLLECTION).documents).toHaveLength(1);
    expect(await outbox.pendingCount()).toBe(1);
  });

  it('does not burn a source_seq when identical callbacks arrive concurrently', async () => {
    const mongo = new MemoryMongo();
    const clock = new MutableClock(new Date('2026-08-30T05:00:06.000Z'));
    const outbox = await MongoOutbox.fromMongo(mongo, 'school-a', clock);
    const capture = new RecordCaptureService(config(), outbox, silentLogger, clock);

    const [first, duplicate] = await Promise.all([
      capture.capture(record()),
      capture.capture(record()),
    ]);
    const next = await capture.capture(record({
      status: 1,
      score: 100,
      judgeAt: new Date('2026-08-30T05:00:07.000Z'),
    }));

    expect(first?.sourceSeq).toBe(1);
    expect(duplicate?.sourceSeq).toBe(1);
    expect(next?.sourceSeq).toBe(2);
    expect(mongo.collection<OutboxDocument>(OUTBOX_COLLECTION).documents).toHaveLength(2);
  });

  it('captures pending-to-accepted revisions for one rid without serializing change payloads', async () => {
    const mongo = new MemoryMongo();
    const clock = new MutableClock(new Date('2026-08-30T05:00:06.000Z'));
    const outbox = await MongoOutbox.fromMongo(mongo, 'school-a', clock);
    const capture = new RecordCaptureService(config(), outbox, silentLogger, clock);

    const pending = await capture.captureProgress(record({
      status: 20,
      score: 0,
      judgeAt: null,
      body: { source: 'must not leave Hydro' },
    }));
    const accepted = await capture.capture(record({ status: 1, score: 100 }));

    expect(pending?.rid).toBe(RID);
    expect(pending?.event.status).toBe('JUDGING');
    expect(pending?.sourceSeq).toBe(1);
    expect(accepted?.rid).toBe(RID);
    expect(accepted?.event.status).toBe('ACCEPTED');
    expect(accepted?.sourceSeq).toBe(2);
    expect(pending?.event).not.toHaveProperty('body');
    expect(pending?.event).not.toHaveProperty('source');
  });

  it('reuses a fenced source_seq when the outbox insert fails once', async () => {
    const mongo = new MemoryMongo();
    const clock = new MutableClock(new Date('2026-08-30T05:00:06.000Z'));
    const outbox = await MongoOutbox.fromMongo(mongo, 'school-a', clock);
    const capture = new RecordCaptureService(config(), outbox, silentLogger, clock);
    const collection = mongo.collection<OutboxDocument>(OUTBOX_COLLECTION);
    vi.spyOn(collection, 'updateOne').mockRejectedValueOnce(new Error('injected insert failure'));

    await expect(capture.capture(record())).rejects.toThrow(/injected insert failure/);
    const recovered = await capture.capture(record());
    const next = await capture.capture(record({ status: 1, score: 100 }));

    expect(recovered?.sourceSeq).toBe(1);
    expect(next?.sourceSeq).toBe(2);
  });

  it('fences a paused capture owner after another callback takes over its expired lease', async () => {
    const mongo = new MemoryMongo();
    const clock = new MutableClock(new Date('2026-08-30T05:00:06.000Z'));
    const captures = mongo.collection<any>(CAPTURE_COLLECTION);
    const original = captures.findOneAndUpdate.bind(captures);
    let releaseFence!: () => void;
    let signalFence!: () => void;
    const fenceReleased = new Promise<void>((resolve) => { releaseFence = resolve; });
    const fenceReached = new Promise<void>((resolve) => { signalFence = resolve; });
    let delayed = false;
    vi.spyOn(captures, 'findOneAndUpdate').mockImplementation(async (filter, update, options) => {
      const result = await original(filter, update, options);
      if (!delayed && (filter.leaseUntil as any)?.$gt) {
        delayed = true;
        signalFence();
        await fenceReleased;
      }
      return result;
    });

    const outbox = await MongoOutbox.fromMongo(mongo, 'school-a', clock);
    const capture = new RecordCaptureService(config(), outbox, silentLogger, clock);
    const pausedOutcome = capture.capture(record()).then(
      () => undefined,
      (error: unknown) => error,
    );
    await fenceReached;
    clock.advance(31_000);
    const takeover = await capture.capture(record());
    releaseFence();
    const pausedError = await pausedOutcome;
    const next = await capture.capture(record({ status: 1, score: 100 }));

    expect(pausedError).toBeInstanceOf(Error);
    expect(String(pausedError)).toMatch(/ownership changed/);
    expect(takeover?.sourceSeq).toBe(1);
    expect(next?.sourceSeq).toBe(2);
  });

  it('keeps failed rows locally, backs off, then clears them only through high_watermark ACK', async () => {
    const mongo = new MemoryMongo();
    const clock = new MutableClock(new Date('2026-08-30T05:00:06.000Z'));
    const outbox = await MongoOutbox.fromMongo(mongo, 'school-a', clock);
    const capture = new RecordCaptureService(config(), outbox, silentLogger, clock);
    await capture.capture(record());
    const sendBatch = vi.fn<HubTransport['sendBatch']>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(makeAck({ high_watermark: 1 }));
    const worker = new DeliveryWorker(config(), outbox, transportStub({ sendBatch }), silentLogger, '5.0.0-beta.9', clock);

    expect(await worker.flushOnce()).toBe(0);
    const stored = mongo.collection<OutboxDocument>(OUTBOX_COLLECTION).documents[0]!;
    expect(stored.state).toBe('pending');
    expect(stored.attempts).toBe(1);
    expect(stored.availableAt.getTime()).toBeGreaterThan(clock.now().getTime());

    clock.advance(10 * 60_000);
    expect(await worker.flushOnce()).toBe(1);
    expect(stored.state).toBe('acked');
    expect(await outbox.pendingCount()).toBe(0);
  });

  it('pauses uploads after contest_finalized without deleting or hot-looping the outbox', async () => {
    const mongo = new MemoryMongo();
    const clock = new MutableClock(new Date('2026-08-30T05:00:06.000Z'));
    const outbox = await MongoOutbox.fromMongo(mongo, 'school-a', clock);
    await new RecordCaptureService(config(), outbox, silentLogger, clock).capture(record());
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: 'contest_finalized' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    ));
    const logger = {
      ...silentLogger,
      warn: vi.fn(),
      error: vi.fn(),
    };
    const worker = new DeliveryWorker(
      config(), outbox, new HttpHubTransport(config(), fetchMock), logger, '5.0.0-beta.9', clock,
    );

    expect(await worker.flushOnce()).toBe(0);
    clock.advance(60 * 60_000);
    expect(await worker.flushOnce()).toBe(0);
    expect(worker.isFinalized()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(await outbox.pendingCount()).toBe(1);
  });

  it('retries retryable rejections and retains non-retryable quarantine diagnostics', () => {
    const docs = [1, 2, 3].map((sourceSeq) => ({ sourceSeq }) as OutboxDocument);
    const ack: BatchAck = makeAck({
      high_watermark: 2,
      rejected: [
        { source_seq: 2, rid: 'r2', code: 'UNMAPPED', message: 'No mapping', retryable: false },
        { source_seq: 3, rid: 'r3', code: 'TEMP', message: 'Try again', retryable: true },
      ],
    });
    expect(interpretAck(ack, docs)).toEqual({
      acked: [1, 2],
      rejected: [{ sourceSeq: 2, message: 'UNMAPPED: No mapping' }],
      retry: [3],
    });
  });
});

describe('signed transport and reconciliation', () => {
  it('signs the exact canonical request body accepted by the shared protocol verifier', async () => {
    const event = createEventDraft(record(), config(), new Date('2026-08-30T05:00:06.000Z'))!.create(1);
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body = String(init?.body ?? '');
      const envelope = JSON.parse(body);
      const allHeaders = init?.headers as Record<string, string>;
      const hmacHeaders = Object.fromEntries(
        Object.entries(allHeaders).filter(([name]) => name.startsWith('x-hydro-league-')),
      );
      const verification = verifyRequest({
        method: String(init?.method),
        path: `${url.pathname}${url.search}`,
        body,
        secret: SHARED_SECRET,
        headers: hmacHeaders,
      });
      expect(verification.ok).toBe(true);
      return new Response(JSON.stringify({
        protocol_version: '1.0',
        batch_id: envelope.batch_id,
        league_id: 'league-2026',
        site_id: 'school-a',
        accepted_count: 1,
        duplicate_count: 0,
        rejected: [],
        high_watermark: 1,
        received_at: '2026-08-30T05:00:07.000Z',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const transport = new HttpHubTransport(config(), fetchMock);
    await expect(transport.sendBatch([event])).resolves.toMatchObject({ high_watermark: 1 });
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:3000/api/v1/sites/school-a/events:batch',
    );
  });

  it('reconciles current terminal records through metadata-only snapshot chunks', async () => {
    const mongo = new MemoryMongo();
    const clock = new MutableClock(new Date('2026-08-30T05:00:06.000Z'));
    const outbox = await MongoOutbox.fromMongo(mongo, 'school-a', clock);
    const capture = new RecordCaptureService(config({ batchSize: 1 }), outbox, silentLogger, clock);
    const snapshots: SnapshotEnvelope[] = [];
    const transport = transportStub({
      sendSnapshot: async (snapshot) => {
        snapshots.push(snapshot);
        return makeAck({
          batch_id: snapshot.snapshot_id,
          high_watermark: snapshot.events.at(-1)?.source_seq ?? 0,
        });
      },
    });
    const worker = new DeliveryWorker(config({ batchSize: 1 }), outbox, transport, silentLogger, '5.0.0-beta.9', clock);
    const records = {
      findContestRecords: async (_binding: ContestBindingConfig) => [
        record(),
        record({ _id: '64f000020000000000000003', uid: 1002, status: 1, code: 'secret 2' }),
      ],
    };
    const service = new ReconciliationService(
      config({ batchSize: 1 }), records, capture, worker, transport, silentLogger, clock,
    );

    expect(await service.runOnce()).toBe(2);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]?.complete).toBe(true);
    expect(snapshots.flatMap((snapshot) => snapshot.events).every((event) => !('code' in event))).toBe(true);
  });

  it('requires a snapshot ACK whose batch_id is the uploaded snapshot_id', async () => {
    const snapshotId = randomUUID();
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const snapshot = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        protocol_version: '1.0',
        batch_id: snapshot.snapshot_id,
        league_id: snapshot.league_id,
        site_id: snapshot.site_id,
        accepted_count: 0,
        duplicate_count: 0,
        rejected: [],
        high_watermark: 0,
        received_at: '2026-08-30T05:00:07.000Z',
      }), { status: 200 });
    });
    const snapshot: SnapshotEnvelope = {
      protocol_version: '1.0',
      snapshot_id: snapshotId,
      league_id: 'league-2026',
      site_id: 'school-a',
      generated_at: '2026-08-30T05:00:06.000Z',
      chunk_index: 0,
      complete: true,
      events: [],
    };

    await expect(new HttpHubTransport(config(), fetchMock).sendSnapshot(snapshot))
      .resolves.toMatchObject({ batch_id: snapshotId });
  });

  it('signs the exact jury XCPCIO path and validates the all-in-one response', async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = init?.headers as Record<string, string>;
      const verification = verifyRequest({
        method: String(init?.method),
        path: `${url.pathname}${url.search}`,
        body: '',
        secret: SHARED_SECRET,
        headers: Object.fromEntries(
          Object.entries(headers).filter(([name]) => name.startsWith('x-hydro-league-')),
        ),
      });
      expect(verification.ok).toBe(true);
      return new Response(JSON.stringify(xcpcioAllInOne()), { status: 200 });
    });

    await expect(new HttpHubTransport(config(), fetchMock).getXcpcio('jury'))
      .resolves.toEqual(xcpcioAllInOne());
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'http://127.0.0.1:3000/api/v1/leagues/league-2026/xcpcio.json?view=jury',
    );
  });
});

describe('hub response boundaries', () => {
  it('accepts the hub shapes and rejects view confusion, frozen leaks, and malformed site state', () => {
    const board = {
      contest: {
        contest_id: 'league-2026',
        name: 'League 2026',
        start_time: '2026-08-30T05:00:00.000Z',
        end_time: '2026-08-30T10:00:00.000Z',
      },
      view: 'public',
      generated_at: '2026-08-30T06:00:00.000Z',
      cursor: 7,
      frozen: true,
      freeze_time: '2026-08-30T09:00:00.000Z',
      accuracy: { complete: true, message: null, affected_sites: [] },
      sites: [{
        site_id: 'school-a',
        name: 'School A',
        status: 'ONLINE',
        last_seen_at: '2026-08-30T06:00:00.000Z',
        last_event_at: null,
        age_ms: 0,
        unmapped_count: 0,
        pending_events: 2,
        rejected_events: 1,
        last_acked_source_seq: 17,
        hub_high_watermark: 17,
        watermark_consistent: true,
        agent_version: '0.1.1',
        hydro_version: '5.0.0-beta.9',
      }],
      problems: [{ problem_id: 'problem-a', label: 'A', name: 'Problem A', ordinal: 0, color: null, rgb: null }],
      rows: [{
        rank: 1,
        team: {
          team_id: 'TEAM-001',
          name: 'Team 1',
          school_id: 'school-a',
          school_name: 'School A',
          official: true,
          hidden: false,
        },
        solved: 1,
        penalty_minutes: 21,
        last_solve_time_ms: 60_000,
        problems: [{
          problem_id: 'problem-a',
          solved: true,
          status: 'SOLVED',
          attempts: 1,
          num_judged: 2,
          pending: 0,
          solve_time_ms: 60_000,
          first_to_solve: true,
        }],
      }],
      teams: [{
        rank: 1,
        team_id: 'TEAM-001',
        name: 'Team 1',
        school: 'School A',
        official: true,
        solved: 1,
        penalty: 21,
        problems: {
          A: { attempts: 1, pending: 0, solved: true, time: 60_000, frozen: false, first_to_solve: true },
        },
      }],
    };
    expect(parseScoreboardResponse(board, 'public')).toBe(board);
    expect(() => parseScoreboardResponse({ ...board, view: 'jury' }, 'public')).toThrow(/view/);

    const frozenFeed = {
      cursor: 8,
      items: [{
        event_id: 'event-1',
        rid: RID,
        team_id: 'TEAM-001',
        team_name: 'Team 1',
        school: 'School A',
        problem_id: 'problem-a',
        problem_label: 'A',
        status: 'FROZEN',
        score: null,
        submitted_at: '2026-08-30T09:01:00.000Z',
        judged_at: null,
      }],
      has_more: false,
    };
    expect(parseSubmissionFeedResponse(frozenFeed, 'public')).toBe(frozenFeed);
    expect(() => parseSubmissionFeedResponse({
      ...frozenFeed,
      items: [{ ...frozenFeed.items[0], score: 100 }],
    }, 'public')).toThrow(/leaks a frozen result/);

    const siteStatus = {
      generated_at: '2026-08-30T06:00:00.000Z',
      complete: false,
      message: 'School A connection delayed',
      sites: [{ ...board.sites[0], status: 'DELAYED' }],
    };
    expect(parseSiteStatusResponse(siteStatus)).toBe(siteStatus);
    expect(() => parseSiteStatusResponse({
      ...siteStatus,
      sites: [{ ...board.sites[0], status: 'disconnected' }],
    })).toThrow(/status is invalid/);
  });

  it('accepts only strict, internally consistent XCPCIO all-in-one data', () => {
    const valid = xcpcioAllInOne();
    const withLeagueStatus = {
      ...valid,
      league_status: {
        generated_at: '2026-08-30T06:00:00.000Z',
        complete: false,
        message: 'A School is offline; standings may be incomplete',
        sites: [{ site_id: 'site-a', name: 'A Judge', school_name: 'A School', status: 'OFFLINE' }],
      },
    };
    expect(parseXcpcioAllInOneResponse(withLeagueStatus)).toBe(withLeagueStatus);
    for (const url of [
      'https://assets.example.edu/badges/school-a.png',
      'http://assets.example.edu:8080/badges/school-a.png?version=2',
      'https://assets.example.edu/%E6%A0%A1%E5%BE%BD.png?cache=100%25',
      'https://assets.example.edu/%E5%8C%97%E5%AD%97%F0%9F%8F%AB.png',
      '/hydro-league-xcpcio/school-badges/besti.png',
      '/hydro-league-xcpcio/school-badges/%E6%A0%A1%E5%BE%BD.png?cache=100%25',
      '/hydro-league-xcpcio/school-badges/%E5%8C%97%E5%AD%97%F0%9F%8F%AB.png',
    ]) {
      const withBadge = {
        ...valid,
        teams: [{ ...valid.teams[0], badge: { url } }],
      };
      expect(parseXcpcioAllInOneResponse(withBadge)).toBe(withBadge);
    }
    for (const url of [
      'https://user:password@assets.example.edu/logo.png',
      'https://@assets.example.edu/logo.png',
      '//assets.example.edu/logo.png',
      'data:image/png;base64,AAAA',
      'file:///tmp/logo.png',
      'javascript:alert(1)',
      'badges/logo.png',
      '/%2fassets.example.edu/logo.png',
      '/badges/../secret.png',
      '/badges/%2e%2e/secret.png',
      '/badges/%252e%252e/secret.png',
      '/badges/%25252e%25252e/secret.png',
      '/badges//secret.png',
      '/badges/%252fsecret.png',
      '/badges\\secret.png',
      '/badges/%5csecret.png',
      '/badges/%00secret.png',
      '/badges/%C2%85secret.png',
      '/badges/%E5%8C.png',
      '/badges/%FF.png',
      'https://assets.example.edu/badges/../secret.png',
      'https://assets.example.edu/badges/%2e%2e/secret.png',
      'https://assets.example.edu/badges/%25252e%25252e/secret.png',
      'https://assets.example.edu/badges//secret.png',
      'https://assets.example.edu/logo.png?label=%00',
      'https://assets.example.edu/logo.png#%5c',
      'https://assets.example.edu/%E5%8C.png',
      `/badges/${String.fromCharCode(0)}secret.png`,
      `/badges/${String.fromCharCode(0x85)}secret.png`,
    ]) {
      expect(() => parseXcpcioAllInOneResponse({
        ...valid,
        teams: [{ ...valid.teams[0], badge: { url } }],
      }), url).toThrow(/credential-free HTTP\(S\)|safe root-relative path/);
    }
    const withGroupMedals = {
      ...valid,
      contest: {
        ...valid.contest,
        medal: {
          official: { gold: 9, silver: 18, bronze: 27 },
          unofficial: { gold: 2, silver: 0, bronze: 0 },
        },
      },
    };
    expect(parseXcpcioAllInOneResponse(withGroupMedals)).toBe(withGroupMedals);

    for (const medal of [
      { official: { gold: -1, silver: 18, bronze: 27 } },
      { official: { gold: 9.5, silver: 18, bronze: 27 } },
      { official: { gold: 9, silver: 18 } },
      { official: { gold: 9, silver: 18, bronze: 27, honorable: 1 } },
    ]) {
      expect(() => parseXcpcioAllInOneResponse({
        ...valid,
        contest: { ...valid.contest, medal },
      })).toThrow();
    }
    expect(() => parseXcpcioAllInOneResponse({
      ...valid,
      contest: { ...valid.contest, extra: 'unexpected' },
    })).toThrow(/unknown field/);
    expect(() => parseXcpcioAllInOneResponse({
      ...valid,
      submissions: [{ ...valid.submissions[0], team_id: 'UNKNOWN' }],
    })).toThrow(/team_id is unknown/);
    expect(() => parseXcpcioAllInOneResponse({
      ...withLeagueStatus,
      league_status: {
        ...withLeagueStatus.league_status,
        sites: [{ ...withLeagueStatus.league_status.sites[0], pending_events: 3 }],
      },
    })).toThrow(/unknown field/);
  });
});

describe('XCPCIO self-hosted wrapper', () => {
  it('only accepts the same-origin leagueboard aliases and never carries a view flag', () => {
    const origin = 'https://school.example';
    const primary = `/d/system/contest/${CONTEST_ID}/scoreboard/leagueboard?json=true`;
    const alias = `/d/system/contest/${CONTEST_ID}/scoreboard/league-xcpcio?json=true`;
    for (const local of [primary, alias]) {
      const frame = createXcpcioFrameUrl(local, origin);
      expect(frame).toMatch(/^\/hydro-league-xcpcio\/index\.html\?source=/);
      expect(decodeURIComponent(frame)).not.toContain('view=');
      expect(() => createXcpcioFrameUrl(`${local}&view=jury`, origin)).toThrow(/query is invalid/);
      expect(() => createXcpcioFrameUrl(`https://hub.example${local}`, origin)).toThrow(/local/);
    }
    expect(() => createXcpcioFrameUrl(
      `/d/system/contest/${CONTEST_ID}/scoreboard/league-realboard?json=true`,
      origin,
    )).toThrow(/local league board/);
  });

  it('ships a CSP wrapper with no public network endpoint or analytics script', async () => {
    const [html, bootstrap] = await Promise.all([
      readFile(path.join(PACKAGE_DIRECTORY, 'public', 'hydro-league-xcpcio', 'index.html'), 'utf8'),
      readFile(path.join(PACKAGE_DIRECTORY, 'public', 'hydro-league-xcpcio', 'bootstrap.js'), 'utf8'),
    ]);
    expect(html).toContain("connect-src 'self'");
    expect(`${html}\n${bootstrap}`).not.toMatch(/googletagmanager|jsdelivr|hm\.baidu|https?:\/\/[^'"`]/i);
    expect(bootstrap).toContain('#allInOne=true');
  });
});

describe('league realboard fork', () => {
  it('ships the attributed upstream React animation fork instead of the former DOM feed', async () => {
    const [frontend, template, stylesheet, notice] = await Promise.all([
      readFile(path.join(PACKAGE_DIRECTORY, 'frontend', 'league-realboard.page.tsx'), 'utf8'),
      readFile(path.join(PACKAGE_DIRECTORY, 'templates', 'league-realboard.html'), 'utf8'),
      readFile(path.join(PACKAGE_DIRECTORY, 'public', 'hydro-league-realboard.css'), 'utf8'),
      readFile(path.join(PACKAGE_DIRECTORY, 'NOTICE'), 'utf8'),
    ]);
    expect(frontend).toContain("from '@react-spring/web'");
    expect(frontend).toContain('fa662b5a1b817d4e73f3f44f5cc0ee9441851a3c');
    expect(frontend).toContain("new NamedPage(['league-realboard']");
    expect(frontend).not.toContain('renderFeed');
    expect(template).toContain('@Hydro/Realboard fork');
    expect(stylesheet).toContain('Derived from HandsomeRun/hydro-realboard');
    expect(notice).toContain('frontend/league-realboard.page.tsx');
  });
});

describe('mock Hydro Context integration', () => {
  it('captures record/judge and segregates public/jury board caches and cursors', async () => {
    const mongo = new MemoryMongo();
    const handlers = new Map<string, (...args: any[]) => Promise<void>>();
    const views = new Map<string, any>();
    const scoreboard = {
      addView(name: string, _title: string, _params: unknown, definition: unknown) {
        views.set(name, definition);
      },
    };
    const ctx: HydroContextLike = {
      db: mongo,
      on(event, handler) {
        handlers.set(event, handler);
      },
      inject(_dependencies, callback) {
        callback({ scoreboard });
      },
      effect() {
        throw new Error('secondary worker must not schedule timers');
      },
    };
    const getXcpcio = vi.fn<HubTransport['getXcpcio']>(async () => xcpcioAllInOne());
    const transport = transportStub({ getXcpcio });
    const applied = await applyAgent(ctx, config({ cacheTtlMs: 60_000 }), {
      logger: silentLogger,
      objectId: (value) => value,
      types: { String: String, Boolean: Boolean },
      hiddenScoreboardPermission: 1n,
      transport,
      processInstance: '1',
    });

    await handlers.get('record/judge')!(record(), true);
    expect(await applied.outbox?.pendingCount()).toBe(1);
    expect(views.has('leagueboard')).toBe(true);
    expect(views.has('league-realboard')).toBe(true);
    expect(views.has('league-xcpcio')).toBe(true);
    expect(views.has('realboard')).toBe(false);
    expect(views.has('xcpcio')).toBe(false);

    const tdoc = { _id: CONTEST_ID, domainId: 'system', rule: 'acm' };
    const publicHandler = {
      user: { own: () => false, hasPerm: () => false },
      request: { json: true, query: { view: 'jury' } },
      response: {},
    };
    const juryHandler = {
      user: { own: () => true, hasPerm: () => false },
      request: { json: true, query: {} },
      response: {},
    };
    await views.get('leagueboard').display.call(publicHandler, { tdoc });
    await views.get('leagueboard').display.call(juryHandler, { tdoc });
    await views.get('leagueboard').display.call(publicHandler, { tdoc });
    expect(getXcpcio.mock.calls.map(([view]) => view)).toEqual(['public', 'jury']);
    expect((publicHandler.response as any).body).toEqual(xcpcioAllInOne());
    expect((juryHandler.response as any).body).toEqual(xcpcioAllInOne());

    const htmlHandler = {
      user: { own: () => false, hasPerm: () => false },
      request: { json: false, query: {} },
      response: {},
    };
    await views.get('leagueboard').display.call(htmlHandler, { tdoc, json: false });
    expect((htmlHandler.response as any).template).toBe('league-xcpcio.html');
    expect((htmlHandler.response as any).body.page_name).toBe('leagueboard');
    expect((htmlHandler.response as any).body.payload.dataUrl).toContain('/scoreboard/leagueboard?json=true');

    await views.get('league-realboard').display.call(publicHandler, { tdoc });
    expect((publicHandler.response as any).body).toMatchObject({
      board: xcpcioAllInOne(),
      meta: { view: 'public', stale: false },
    });
    expect((publicHandler.response as any).body.dataUrl).toContain('/scoreboard/league-realboard?json=true');

    await views.get('league-xcpcio').display.call(publicHandler, { tdoc });
    await views.get('league-xcpcio').display.call(juryHandler, { tdoc });
    expect(getXcpcio.mock.calls.map(([view]) => view)).toEqual(['public', 'jury']);
    expect((publicHandler.response as any).body).toEqual(xcpcioAllInOne());
  });
});
