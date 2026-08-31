import { describe, expect, it } from 'vitest';
import {
  EventBatchEnvelopeSchema,
  EventBatchAckSchema,
  LeagueConfigSchema,
  SubmissionEventSchema,
} from '../src/index.js';
import { atMinute, event } from './fixtures.js';

describe('versioned schemas', () => {
  it('accepts a wire event without untrusted global mapping hints', () => {
    const parsed = SubmissionEventSchema.parse(event());
    expect(parsed.protocol_version).toBe('1.0');
    expect(parsed.global_team_id).toBeUndefined();
    expect(parsed.global_problem_id).toBeUndefined();
  });

  it('rejects reused sequence zero and non-canonical rid values', () => {
    expect(SubmissionEventSchema.safeParse({ ...event(), source_seq: 0 }).success).toBe(false);
    expect(SubmissionEventSchema.safeParse({ ...event(), rid: 'folder/rid' }).success).toBe(false);
    expect(SubmissionEventSchema.safeParse({ ...event(), rid: ' rid-1 ' }).success).toBe(false);
  });

  it('rejects an event whose site differs from its batch envelope', () => {
    const parsed = EventBatchEnvelopeSchema.safeParse({
      protocol_version: '1.0',
      batch_id: '84d90cbf-8367-4ed6-b498-83c6144824a2',
      league_id: 'league-1',
      site_id: 'site-2',
      sent_at: atMinute(20),
      events: [event()],
    });
    expect(parsed.success).toBe(false);
  });

  it('validates freeze and unfreeze boundaries', () => {
    const parsed = LeagueConfigSchema.safeParse({
      protocol_version: '1.0',
      league_id: 'league-1',
      title: 'Invalid',
      rule: 'acm',
      starts_at: atMinute(0),
      ends_at: atMinute(300),
      freeze_at: atMinute(301),
      unfreeze_at: atMinute(200),
    });
    expect(parsed.success).toBe(false);
  });

  it('does not let a high watermark cross a retryable rejection', () => {
    const parsed = EventBatchAckSchema.safeParse({
      protocol_version: '1.0',
      batch_id: '84d90cbf-8367-4ed6-b498-83c6144824a2',
      league_id: 'league-1',
      site_id: 'site-1',
      accepted_count: 4,
      duplicate_count: 0,
      rejected: [{
        source_seq: 3,
        rid: 'rid-3',
        code: 'TEMPORARY_STORAGE_FAILURE',
        message: 'retry later',
        retryable: true,
      }],
      high_watermark: 4,
      received_at: atMinute(20),
    });
    expect(parsed.success).toBe(false);
  });
});
