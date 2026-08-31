import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from './event-factory.js';
import type {
  AgentConfig,
  BatchAck,
  ContestBindingConfig,
  Clock,
  HydroRecordLike,
  HubTransport,
  LoggerLike,
  OutboxDocument,
  SnapshotEnvelope,
} from './types.js';
import { systemClock } from './types.js';
import { RecordCaptureService } from './capture.js';
import { DeliveryWorker } from './worker.js';

export const RECONCILIATION_RECORD_PROJECTION = {
  _id: 1,
  domainId: 1,
  contest: 1,
  uid: 1,
  pid: 1,
  status: 1,
  score: 1,
  lang: 1,
  judgeAt: 1,
  rejudged: 1,
} as const;

export interface RecordRepository {
  findContestRecords(binding: ContestBindingConfig): Promise<HydroRecordLike[]>;
}

export class ReconciliationService {
  private running = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly records: RecordRepository,
    private readonly capture: RecordCaptureService,
    private readonly delivery: DeliveryWorker,
    private readonly transport: HubTransport,
    private readonly logger: LoggerLike,
    private readonly clock: Clock = systemClock,
  ) {}

  async runOnce(): Promise<number> {
    if (this.running || this.delivery.isFinalized()) return 0;
    this.running = true;
    try {
      const documents: OutboxDocument[] = [];
      for (const binding of this.config.contests) {
        const records = await this.records.findContestRecords(binding);
        for (const record of records) {
          const document = await this.capture.capture(record);
          if (document) documents.push(document);
        }
      }

      const latest = [...new Map(
        documents
          .sort((left, right) => left.sourceSeq - right.sourceSeq)
          .map((document) => [document.submissionKey, document]),
      ).values()];
      const snapshotId = randomUUID();
      const chunks: OutboxDocument[][] = [];
      for (let offset = 0; offset < latest.length; offset += this.config.batchSize) {
        chunks.push(latest.slice(offset, offset + this.config.batchSize));
      }
      if (!chunks.length) chunks.push([]);

      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]!;
        const envelope: SnapshotEnvelope = {
          protocol_version: PROTOCOL_VERSION,
          snapshot_id: snapshotId,
          league_id: this.config.leagueId,
          site_id: this.config.siteId,
          generated_at: this.clock.now().toISOString(),
          chunk_index: index,
          complete: index === chunks.length - 1,
          events: chunk.map((document) => document.event),
        };
        const ack: BatchAck = await this.transport.sendSnapshot(envelope);
        await this.delivery.applyAck(ack, chunk);
      }
      this.logger.info('League reconciliation completed with %s current submissions', latest.length);
      return latest.length;
    } catch (error) {
      if (this.delivery.pauseIfFinalized(error)) return 0;
      this.logger.warn('League reconciliation failed; outbox delivery remains active: %s', error);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
