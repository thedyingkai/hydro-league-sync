import type { AgentConfig, Clock, HydroRecordLike, LoggerLike, OutboxDocument } from './types.js';
import { systemClock } from './types.js';
import {
  assertMetadataOnlyEvent,
  createEventDraft,
  createProgressEventDraft,
} from './event-factory.js';
import { MongoOutbox } from './outbox.js';

export class RecordCaptureService {
  constructor(
    private readonly config: AgentConfig,
    private readonly outbox: MongoOutbox,
    private readonly logger: LoggerLike,
    private readonly clock: Clock = systemClock,
  ) {}

  async capture(record: HydroRecordLike): Promise<OutboxDocument | null> {
    const draft = createEventDraft(record, this.config, this.clock.now());
    if (!draft) return null;
    const result = await this.outbox.enqueue(draft);
    assertMetadataOnlyEvent(result.document.event);
    if (result.inserted) {
      this.logger.debug(
        'Captured final judgement %s as source_seq=%s',
        result.document.rid,
        result.document.sourceSeq,
      );
    }
    return result.document;
  }

  async captureProgress(record: HydroRecordLike): Promise<OutboxDocument | null> {
    const draft = createProgressEventDraft(record, this.config, this.clock.now());
    if (!draft) return null;
    const result = await this.outbox.enqueue(draft);
    assertMetadataOnlyEvent(result.document.event);
    return result.document;
  }
}
