import { canonicalJson } from './hmac.js';
import type { SubmissionEvent } from './schemas.js';

export type SubmissionIdentity = Pick<
  SubmissionEvent,
  'site_id' | 'domain_id' | 'contest_id' | 'rid'
>;

export type EventSequenceIdentity = Pick<SubmissionEvent, 'site_id' | 'source_seq'>;

export class EventSequenceConflictError extends Error {
  readonly sequence_key: string;

  constructor(sequenceKey: string) {
    super(`Conflicting payloads use the same event sequence: ${sequenceKey}`);
    this.name = 'EventSequenceConflictError';
    this.sequence_key = sequenceKey;
  }
}

export class SubmissionIdentityConflictError extends Error {
  readonly submission_key: string;

  constructor(submissionKeyValue: string) {
    super(`A submission revision changed immutable identity fields: ${submissionKeyValue}`);
    this.name = 'SubmissionIdentityConflictError';
    this.submission_key = submissionKeyValue;
  }
}

export function submissionKey(identity: SubmissionIdentity): string {
  return [identity.site_id, identity.domain_id, identity.contest_id, identity.rid].join('/');
}

export function eventSequenceKey(identity: EventSequenceIdentity): string {
  return `${identity.site_id}/${identity.source_seq}`;
}

export function compareEventVersion(a: SubmissionEvent, b: SubmissionEvent): -1 | 0 | 1 {
  const aKey = submissionKey(a);
  const bKey = submissionKey(b);
  if (aKey !== bKey) {
    throw new TypeError(`Cannot compare revisions for different submissions: ${aKey} and ${bKey}`);
  }
  if (a.source_seq === b.source_seq) return 0;
  return a.source_seq < b.source_seq ? -1 : 1;
}

function immutableIdentity(event: SubmissionEvent): string {
  return canonicalJson({
    contest_id: event.contest_id,
    domain_id: event.domain_id,
    league_id: event.league_id,
    pid: event.pid,
    rid: event.rid,
    site_id: event.site_id,
    submitted_at: event.submitted_at,
    uid: event.uid,
  });
}

/**
 * Resolves retries, out-of-order delivery, and rejudgements into the current
 * revision for each Hydro submission. A site-wide source sequence may identify
 * only one payload; a submission revision may not change identity fields.
 */
export function coalesceSubmissionEvents<T extends SubmissionEvent>(
  events: readonly T[],
): T[] {
  const seenSequences = new Map<string, string>();
  const currentBySubmission = new Map<string, T>();

  for (const event of events) {
    const sequenceKey = eventSequenceKey(event);
    const serialized = canonicalJson(event);
    const seen = seenSequences.get(sequenceKey);
    if (seen !== undefined) {
      if (seen !== serialized) throw new EventSequenceConflictError(sequenceKey);
      continue;
    }
    seenSequences.set(sequenceKey, serialized);

    const key = submissionKey(event);
    const current = currentBySubmission.get(key);
    if (current === undefined) {
      currentBySubmission.set(key, event);
      continue;
    }
    if (immutableIdentity(current) !== immutableIdentity(event)) {
      throw new SubmissionIdentityConflictError(key);
    }
    if (event.source_seq > current.source_seq) currentBySubmission.set(key, event);
  }

  return [...currentBySubmission.values()].sort((a, b) => {
    const submitted = Date.parse(a.submitted_at) - Date.parse(b.submitted_at);
    if (submitted !== 0) return submitted;
    if (a.source_seq !== b.source_seq) return a.source_seq - b.source_seq;
    return submissionKey(a).localeCompare(submissionKey(b), 'en-US');
  });
}
