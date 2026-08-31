import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from './event-factory.js';
import type {
  AgentConfig,
  BatchAck,
  Clock,
  HeartbeatEnvelope,
  HubTransport,
  LoggerLike,
  OutboxDocument,
} from './types.js';
import { systemClock } from './types.js';
import { MongoOutbox } from './outbox.js';
import { isContestFinalizedError } from './transport.js';

export interface AckDisposition {
  acked: number[];
  rejected: Array<{ sourceSeq: number; message?: string }>;
  retry: number[];
}

function unique(values: number[]): number[] {
  return [...new Set(values)].filter(Number.isSafeInteger);
}

export function interpretAck(ack: BatchAck, documents: OutboxDocument[]): AckDisposition {
  const delivered = new Set(documents.map((document) => document.sourceSeq));
  const canonicalRejected = ack.rejected.filter((entry) => delivered.has(entry.source_seq));
  const canonicalRetry = canonicalRejected.filter((entry) => entry.retryable).map((entry) => entry.source_seq);
  const canonicalTerminalRejects = canonicalRejected
    .filter((entry) => !entry.retryable)
    .map((entry) => ({ sourceSeq: entry.source_seq, message: `${entry.code}: ${entry.message}` }));
  const acked = documents
    .map((document) => document.sourceSeq)
    .filter((sourceSeq) => sourceSeq <= ack.high_watermark && !canonicalRetry.includes(sourceSeq));
  const rejected = canonicalTerminalRejects;
  const terminal = new Set([...acked, ...rejected.map((entry) => entry.sourceSeq)]);
  return {
    acked: unique(acked),
    rejected: [...new Map(rejected.map((entry) => [entry.sourceSeq, entry])).values()],
    retry: documents
      .map((document) => document.sourceSeq)
      .filter((sourceSeq) => canonicalRetry.includes(sourceSeq) || !terminal.has(sourceSeq)),
  };
}

export class DeliveryWorker {
  private readonly workerId = randomUUID();
  private flushing = false;
  private finalized = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly outbox: MongoOutbox,
    private readonly transport: HubTransport,
    private readonly logger: LoggerLike,
    private readonly hydroVersion = '5.0.0-beta.9',
    private readonly clock: Clock = systemClock,
  ) {}

  async applyAck(ack: BatchAck, documents: OutboxDocument[]): Promise<void> {
    const disposition = interpretAck(ack, documents);
    await this.outbox.markAcked(disposition.acked);
    await this.outbox.markRejected(disposition.rejected);
    const retryDocs = documents.filter((document) => disposition.retry.includes(document.sourceSeq));
    if (retryDocs.length) {
      await this.outbox.markRetry(retryDocs, 'Hub response omitted an ACK for the event', {
        baseMs: this.config.retryBaseMs,
        maxMs: this.config.retryMaxMs,
      });
    }
  }

  isFinalized(): boolean {
    return this.finalized;
  }

  pauseIfFinalized(error: unknown): boolean {
    if (!isContestFinalizedError(error)) return false;
    if (!this.finalized) {
      this.finalized = true;
      this.logger.error(
        'League contest is finalized by CDP export; event and snapshot uploads are paused and the local outbox is retained',
      );
    }
    return true;
  }

  async flushOnce(): Promise<number> {
    if (this.flushing || this.finalized) return 0;
    this.flushing = true;
    let claimed: OutboxDocument[] = [];
    try {
      claimed = await this.outbox.claimBatch(this.config.batchSize, this.workerId, this.config.leaseMs);
      if (!claimed.length) return 0;
      const ack = await this.transport.sendBatch(claimed.map((document) => document.event));
      await this.applyAck(ack, claimed);
      return claimed.length;
    } catch (error) {
      if (claimed.length) {
        await this.outbox.markRetry(claimed, error, {
          baseMs: this.config.retryBaseMs,
          maxMs: this.config.retryMaxMs,
        });
      }
      if (this.pauseIfFinalized(error)) return 0;
      this.logger.warn('League event delivery failed; the local outbox will retry: %s', error);
      return 0;
    } finally {
      this.flushing = false;
    }
  }

  async heartbeatOnce(): Promise<void> {
    const lastAcked = await this.outbox.lastAckedSourceSeq();
    const heartbeat: HeartbeatEnvelope = {
      protocol_version: PROTOCOL_VERSION,
      league_id: this.config.leagueId,
      site_id: this.config.siteId,
      sent_at: this.clock.now().toISOString(),
      pending_events: await this.outbox.pendingCount(),
      rejected_events: await this.outbox.rejectedCount(),
      ...(lastAcked !== undefined ? { last_acked_source_seq: lastAcked } : {}),
      agent_version: '0.1.0',
      hydro_version: this.hydroVersion,
    };
    try {
      await this.transport.sendHeartbeat(heartbeat);
    } catch (error) {
      this.logger.warn('League heartbeat failed: %s', error);
    }
  }
}
