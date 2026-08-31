import { randomUUID } from 'node:crypto';
import type {
  CaptureReservationDocument,
  Clock,
  CollectionLike,
  MongoServiceLike,
  OutboxDocument,
  SequenceDocument,
  SubmissionEvent,
} from './types.js';
import { systemClock } from './types.js';
import type { EventDraft } from './event-factory.js';

export const OUTBOX_COLLECTION = 'league.sync.outbox';
export const SEQUENCE_COLLECTION = 'league.sync.sequence';
export const CAPTURE_COLLECTION = 'league.sync.capture';

const CAPTURE_LEASE_MS = 30_000;
const CAPTURE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const CAPTURE_WAIT_ATTEMPTS = 200;
const CAPTURE_WAIT_MS = 25;

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  random?: () => number;
}

function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}

function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (
    (error as { code?: unknown }).code === 11000
    || (error as { code?: unknown }).code === 'E11000'
  ));
}

export function retryDelayMs(attempt: number, policy: RetryPolicy): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  const raw = Math.min(policy.maxMs, policy.baseMs * (2 ** exponent));
  const random = policy.random ?? Math.random;
  const jitter = 0.8 + (Math.max(0, Math.min(1, random())) * 0.4);
  return Math.max(policy.baseMs, Math.round(raw * jitter));
}

export class SequenceAllocator {
  constructor(
    private readonly collection: CollectionLike<SequenceDocument>,
    private readonly siteId: string,
  ) {}

  async next(): Promise<number> {
    const updated = await this.collection.findOneAndUpdate(
      { _id: this.siteId },
      { $inc: { value: 1 }, $setOnInsert: { _id: this.siteId } },
      { upsert: true, returnDocument: 'after' },
    );
    if (!updated || !Number.isSafeInteger(updated.value) || updated.value < 1) {
      throw new Error('Failed to allocate a valid source_seq');
    }
    return updated.value;
  }
}

export class MongoOutbox {
  constructor(
    private readonly collection: CollectionLike<OutboxDocument>,
    private readonly sequence: SequenceAllocator,
    private readonly captures: CollectionLike<CaptureReservationDocument>,
    private readonly clock: Clock = systemClock,
  ) {}

  static async fromMongo(
    mongo: MongoServiceLike,
    siteId: string,
    clock: Clock = systemClock,
  ): Promise<MongoOutbox> {
    const outbox = mongo.collection<OutboxDocument>(OUTBOX_COLLECTION);
    const sequences = mongo.collection<SequenceDocument>(SEQUENCE_COLLECTION);
    const captures = mongo.collection<CaptureReservationDocument>(CAPTURE_COLLECTION);
    if (mongo.ensureIndexes) {
      await mongo.ensureIndexes(
        outbox as unknown as CollectionLike<unknown>,
        { key: { state: 1, availableAt: 1, sourceSeq: 1 }, name: 'delivery_due' },
        { key: { submissionKey: 1, sourceSeq: -1 }, name: 'submission_latest' },
        { key: { domainId: 1, contestId: 1, sourceSeq: 1 }, name: 'contest_snapshot' },
        { key: { ackedAt: 1 }, name: 'acked_expiry', expireAfterSeconds: 604_800 },
      );
      await mongo.ensureIndexes(
        captures as unknown as CollectionLike<unknown>,
        { key: { expiresAt: 1 }, name: 'capture_expiry', expireAfterSeconds: 0 },
        { key: { state: 1, leaseUntil: 1 }, name: 'capture_lease' },
      );
    }
    return new MongoOutbox(outbox, new SequenceAllocator(sequences, siteId), captures, clock);
  }

  async enqueue(draft: EventDraft): Promise<{ document: OutboxDocument; inserted: boolean }> {
    const existing = await this.collection.findOne({ _id: draft.captureKey });
    if (existing) return { document: existing, inserted: false };

    const owner = randomUUID();
    let reservation: CaptureReservationDocument | null;
    try {
      reservation = await this.captures.findOneAndUpdate(
        { _id: draft.captureKey },
        {
          $setOnInsert: {
            _id: draft.captureKey,
            state: 'allocating',
            owner,
            leaseUntil: new Date(this.clock.now().getTime() + CAPTURE_LEASE_MS),
            createdAt: this.clock.now(),
            updatedAt: this.clock.now(),
            expiresAt: new Date(this.clock.now().getTime() + CAPTURE_RETENTION_MS),
          },
        },
        { upsert: true, returnDocument: 'after' },
      );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      reservation = await this.captures.findOne({ _id: draft.captureKey });
    }

    for (let attempt = 0; reservation?.owner !== owner; attempt += 1) {
      const stored = await this.collection.findOne({ _id: draft.captureKey });
      if (stored) return { document: stored, inserted: false };
      if (reservation?.state === 'done' && reservation.sourceSeq !== undefined) {
        return this.restoreReserved(draft, reservation.sourceSeq);
      }
      if (attempt >= CAPTURE_WAIT_ATTEMPTS) {
        throw new Error('Timed out waiting for a concurrent outbox capture');
      }
      const now = this.clock.now();
      reservation = await this.captures.findOneAndUpdate(
        {
          _id: draft.captureKey,
          state: 'allocating',
          leaseUntil: { $lte: now },
        },
        {
          $set: {
            owner,
            leaseUntil: new Date(now.getTime() + CAPTURE_LEASE_MS),
            updatedAt: now,
            expiresAt: new Date(now.getTime() + CAPTURE_RETENTION_MS),
          },
        },
        { returnDocument: 'after' },
      ) ?? await this.captures.findOne({ _id: draft.captureKey });
      if (reservation?.owner !== owner) {
        await new Promise((resolve) => setTimeout(resolve, CAPTURE_WAIT_MS));
      }
    }

    try {
      let sourceSeq = reservation.sourceSeq;
      if (sourceSeq === undefined) {
        const fenceTime = this.clock.now();
        const fenced = await this.captures.findOneAndUpdate(
          {
            _id: draft.captureKey,
            owner,
            state: 'allocating',
            leaseUntil: { $gt: fenceTime },
          },
          {
            $set: {
              leaseUntil: new Date(fenceTime.getTime() + CAPTURE_LEASE_MS),
              updatedAt: fenceTime,
            },
          },
          { returnDocument: 'after' },
        );
        if (!fenced || fenced.owner !== owner) {
          throw new Error('Outbox capture ownership changed before source_seq allocation');
        }

        const allocated = await this.sequence.next();
        const persisted = await this.captures.findOneAndUpdate(
          {
            _id: draft.captureKey,
            owner,
            state: 'allocating',
            sourceSeq: { $exists: false },
          },
          {
            $set: {
              sourceSeq: allocated,
              updatedAt: this.clock.now(),
            },
          },
          { returnDocument: 'after' },
        );
        if (!persisted || persisted.owner !== owner || persisted.sourceSeq !== allocated) {
          throw new Error('Outbox capture ownership changed during source_seq allocation');
        }
        sourceSeq = allocated;
      }
      const result = await this.restoreReserved(draft, sourceSeq);
      const now = this.clock.now();
      await this.captures.findOneAndUpdate(
        { _id: draft.captureKey, owner, state: 'allocating', sourceSeq },
        {
          $set: {
            state: 'done',
            sourceSeq,
            leaseUntil: now,
            updatedAt: now,
            expiresAt: new Date(now.getTime() + CAPTURE_RETENTION_MS),
          },
        },
        { returnDocument: 'after' },
      );
      return result;
    } catch (error) {
      const now = this.clock.now();
      await this.captures.updateOne(
        { _id: draft.captureKey, owner, state: 'allocating' },
        { $set: { leaseUntil: now, updatedAt: now } },
      );
      throw error;
    }
  }

  private async restoreReserved(
    draft: EventDraft,
    sourceSeq: number,
  ): Promise<{ document: OutboxDocument; inserted: boolean }> {
    const now = this.clock.now();
    const document: OutboxDocument = {
      _id: draft.captureKey,
      captureKey: draft.captureKey,
      submissionKey: draft.submissionKey,
      sourceSeq,
      domainId: draft.domainId,
      contestId: draft.contestId,
      rid: draft.rid,
      state: 'pending',
      attempts: 0,
      availableAt: now,
      createdAt: now,
      updatedAt: now,
      event: draft.create(sourceSeq),
    };
    await this.collection.updateOne(
      { _id: document._id },
      { $setOnInsert: document },
      { upsert: true },
    );
    const stored = await this.collection.findOne({ _id: document._id });
    if (!stored) throw new Error('Outbox insert did not return a stored event');
    return { document: stored, inserted: stored.sourceSeq === sourceSeq };
  }

  async claimBatch(limit: number, workerId: string, leaseMs: number): Promise<OutboxDocument[]> {
    const now = this.clock.now();
    const candidates = await this.collection.find({
      $or: [
        { state: 'pending', availableAt: { $lte: now } },
        { state: 'inflight', leaseUntil: { $lte: now } },
      ],
    }).sort({ sourceSeq: 1 }).limit(limit).toArray();
    const claimed: OutboxDocument[] = [];
    for (const candidate of candidates) {
      const current = await this.collection.findOneAndUpdate(
        {
          _id: candidate._id,
          $or: [
            { state: 'pending', availableAt: { $lte: now } },
            { state: 'inflight', leaseUntil: { $lte: now } },
          ],
        },
        {
          $set: {
            state: 'inflight',
            leaseOwner: workerId,
            leaseUntil: new Date(now.getTime() + leaseMs),
            updatedAt: now,
          },
        },
        { returnDocument: 'after' },
      );
      if (current) claimed.push(current);
    }
    return claimed;
  }

  async markAcked(sourceSeqs: number[]): Promise<void> {
    if (!sourceSeqs.length) return;
    const now = this.clock.now();
    await this.collection.updateMany(
      { sourceSeq: { $in: sourceSeqs } },
      {
        $set: { state: 'acked', ackedAt: now, updatedAt: now },
        $unset: { leaseOwner: '', leaseUntil: '', lastError: '' },
      },
    );
  }

  async markRejected(entries: Array<{ sourceSeq: number; message?: string }>): Promise<void> {
    const now = this.clock.now();
    for (const entry of entries) {
      await this.collection.updateOne(
        { sourceSeq: entry.sourceSeq },
        {
          $set: {
            state: 'rejected',
            rejectedAt: now,
            updatedAt: now,
            lastError: (entry.message ?? 'Hub rejected the event').slice(0, 1_000),
          },
          $unset: { leaseOwner: '', leaseUntil: '' },
        },
      );
    }
  }

  async markRetry(documents: OutboxDocument[], error: unknown, policy: RetryPolicy): Promise<void> {
    const now = this.clock.now();
    for (const document of documents) {
      const attempts = document.attempts + 1;
      await this.collection.updateOne(
        { _id: document._id, state: 'inflight' },
        {
          $set: {
            state: 'pending',
            attempts,
            availableAt: new Date(now.getTime() + retryDelayMs(attempts, policy)),
            updatedAt: now,
            lastError: boundedMessage(error),
          },
          $unset: { leaseOwner: '', leaseUntil: '' },
        },
      );
    }
  }

  async pendingCount(): Promise<number> {
    return this.collection.countDocuments({ state: { $in: ['pending', 'inflight'] } });
  }

  async rejectedCount(): Promise<number> {
    return this.collection.countDocuments({ state: 'rejected' });
  }

  async lastAckedSourceSeq(): Promise<number | undefined> {
    const docs = await this.collection.find({ state: 'acked' }).sort({ sourceSeq: -1 }).limit(1).toArray();
    return docs[0]?.sourceSeq;
  }
}
