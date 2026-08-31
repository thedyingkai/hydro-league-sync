import { describe, expect, it } from 'vitest';
import {
  coalesceSubmissionEvents,
  EventSequenceConflictError,
  SubmissionIdentityConflictError,
  submissionKey,
} from '../src/index.js';
import { event } from './fixtures.js';

describe('event stream reduction', () => {
  it('deduplicates retries and selects a later rejudge despite out-of-order input', () => {
    const accepted = event({ source_seq: 4, status: 'ACCEPTED' });
    const rejudged = event({ source_seq: 9, status: 'WRONG_ANSWER', rejudged: true });
    const result = coalesceSubmissionEvents([rejudged, accepted, accepted]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(rejudged);
  });

  it('rejects conflicting payloads at the same site sequence', () => {
    expect(() => coalesceSubmissionEvents([
      event({ source_seq: 2, rid: 'rid-1' }),
      event({ source_seq: 2, rid: 'rid-2' }),
    ])).toThrow(EventSequenceConflictError);
  });

  it('rejects a rejudge that mutates the authoritative submission identity', () => {
    expect(() => coalesceSubmissionEvents([
      event({ source_seq: 2, uid: 10 }),
      event({ source_seq: 3, uid: 11, rejudged: true }),
    ])).toThrow(SubmissionIdentityConflictError);
  });

  it('builds an unambiguous four-part source key', () => {
    expect(submissionKey(event())).toBe('site-1/system/contest-1/rid-1');
  });
});
