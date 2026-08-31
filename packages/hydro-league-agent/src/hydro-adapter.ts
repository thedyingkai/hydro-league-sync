import type {
  AgentConfig,
  Clock,
  ContestBindingConfig,
  HydroRecordLike,
  HubTransport,
  LoggerLike,
  MongoServiceLike,
} from './types.js';
import { systemClock } from './types.js';
import { normalizeConfig, type RawAgentConfig } from './config.js';
import { MongoOutbox } from './outbox.js';
import { RecordCaptureService } from './capture.js';
import { HttpHubTransport } from './transport.js';
import { DeliveryWorker } from './worker.js';
import {
  RECONCILIATION_RECORD_PROJECTION,
  ReconciliationService,
  type RecordRepository,
} from './reconciliation.js';
import { SegregatedRemoteCache } from './cache.js';
import { registerLeagueViews } from './views.js';

interface ScoreboardInjection {
  scoreboard: Parameters<typeof registerLeagueViews>[0]['scoreboard'];
}

export interface HydroContextLike {
  db: MongoServiceLike;
  on(
    event: 'record/judge' | 'record/change',
    handler: (record: HydroRecordLike, ...details: unknown[]) => Promise<void>,
  ): unknown;
  inject(dependencies: string[], callback: (services: ScoreboardInjection) => void): unknown;
  effect(callback: () => void | (() => void)): unknown;
}

export interface HydroAdapterDependencies {
  logger: LoggerLike;
  objectId(value: string): unknown;
  types: { String: unknown; Boolean: unknown };
  hiddenScoreboardPermission: unknown;
  transport?: HubTransport;
  clock?: Clock;
  hydroVersion?: string;
  processInstance?: string;
  hydroCli?: boolean;
}

class HydroRecordRepository implements RecordRepository {
  constructor(
    private readonly mongo: MongoServiceLike,
    private readonly objectId: (value: string) => unknown,
  ) {}

  async findContestRecords(binding: ContestBindingConfig): Promise<HydroRecordLike[]> {
    const collection = this.mongo.collection<HydroRecordLike>('record');
    const cursor = collection.find({
      domainId: binding.domainId,
      contest: this.objectId(binding.contestId),
      status: { $nin: [0, 20, 21, 22] },
    });
    const projected = cursor.project
      ? cursor.project<HydroRecordLike>(RECONCILIATION_RECORD_PROJECTION)
      : cursor;
    return projected.sort({ _id: 1 }).toArray();
  }
}

export interface AppliedAgent {
  config: AgentConfig;
  outbox?: MongoOutbox;
  capture?: RecordCaptureService;
  worker?: DeliveryWorker;
  reconciliation?: ReconciliationService;
  transport?: HubTransport;
}

function schedule(ctx: HydroContextLike, intervalMs: number, operation: () => Promise<unknown>, logger: LoggerLike): void {
  ctx.effect(() => {
    let active = true;
    const run = () => {
      if (!active) return;
      void operation().catch((error) => logger.warn('Scheduled league operation failed: %s', error));
    };
    queueMicrotask(run);
    const timer = setInterval(run, intervalMs);
    timer.unref?.();
    return () => {
      active = false;
      clearInterval(timer);
    };
  });
}

export async function applyAgent(
  ctx: HydroContextLike,
  rawConfig: RawAgentConfig,
  dependencies: HydroAdapterDependencies,
): Promise<AppliedAgent> {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) {
    dependencies.logger.info('Hydro League Agent is disabled');
    return { config };
  }

  const clock = dependencies.clock ?? systemClock;
  const transport = dependencies.transport ?? new HttpHubTransport(config);
  const outbox = await MongoOutbox.fromMongo(ctx.db, config.siteId, clock);
  const capture = new RecordCaptureService(config, outbox, dependencies.logger, clock);
  const worker = new DeliveryWorker(
    config,
    outbox,
    transport,
    dependencies.logger,
    dependencies.hydroVersion ?? '5.0.0-beta.9',
    clock,
  );
  const records = new HydroRecordRepository(ctx.db, dependencies.objectId);
  const reconciliation = new ReconciliationService(
    config,
    records,
    capture,
    worker,
    transport,
    dependencies.logger,
    clock,
  );
  const cache = new SegregatedRemoteCache(config.cacheTtlMs, config.cacheMaxStaleMs, clock);

  ctx.on('record/judge', async (record) => {
    try {
      await capture.capture(record);
    } catch (error) {
      dependencies.logger.error('Failed to persist final judgement in the league outbox: %s', error);
      throw error;
    }
  });

  ctx.on('record/change', async (record) => {
    try {
      await capture.captureProgress(record);
    } catch (error) {
      dependencies.logger.error('Failed to persist a judgement progress event in the league outbox: %s', error);
      throw error;
    }
  });

  ctx.inject(['scoreboard'], ({ scoreboard }) => {
    registerLeagueViews({
      scoreboard,
      types: dependencies.types,
      hiddenScoreboardPermission: dependencies.hiddenScoreboardPermission,
      config,
      transport,
      cache,
      logger: dependencies.logger,
    });
  });

  const isPrimaryWorker = (dependencies.processInstance ?? process.env.NODE_APP_INSTANCE ?? '0') === '0';
  const isCli = dependencies.hydroCli ?? Boolean(process.env.HYDRO_CLI);
  if (isPrimaryWorker && !isCli) {
    schedule(ctx, config.flushIntervalMs, () => worker.flushOnce(), dependencies.logger);
    schedule(ctx, config.heartbeatIntervalMs, () => worker.heartbeatOnce(), dependencies.logger);
    schedule(ctx, config.reconciliationIntervalMs, () => reconciliation.runOnce(), dependencies.logger);
  }

  dependencies.logger.info(
    'Hydro League Agent enabled for site %s with loopback-safe hub %s',
    config.siteId,
    config.centerUrl,
  );
  return { config, outbox, capture, worker, reconciliation, transport };
}
