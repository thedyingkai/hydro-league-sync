import { createHash } from 'node:crypto';
import { PROTOCOL_VERSION, validateSubmissionEvent } from './protocol.js';
import type {
  AgentConfig,
  CanonicalStatus,
  ContestBindingConfig,
  HydroRecordLike,
  SubmissionEvent,
} from './types.js';
import { findBinding } from './config.js';

export { PROTOCOL_VERSION };

const STATUS_MAP: Readonly<Record<number, CanonicalStatus>> = {
  0: 'PENDING',
  1: 'ACCEPTED',
  2: 'WRONG_ANSWER',
  3: 'TIME_LIMIT_EXCEEDED',
  4: 'MEMORY_LIMIT_EXCEEDED',
  5: 'OUTPUT_LIMIT_EXCEEDED',
  6: 'RUNTIME_ERROR',
  7: 'COMPILE_ERROR',
  8: 'SYSTEM_ERROR',
  9: 'CANCELED',
  10: 'SYSTEM_ERROR',
  11: 'WRONG_ANSWER',
  20: 'JUDGING',
  21: 'JUDGING',
  22: 'PENDING',
  30: 'IGNORED',
  31: 'FORMAT_ERROR',
  32: 'SYSTEM_ERROR',
  33: 'SYSTEM_ERROR',
};

const NON_TERMINAL_STATUSES = new Set([0, 20, 21, 22]);

export interface EventDraft {
  captureKey: string;
  submissionKey: string;
  domainId: string;
  contestId: string;
  rid: string;
  create(sourceSeq: number): SubmissionEvent;
}

export function idString(value: string | { toHexString?: () => string; toString: () => string }): string {
  if (typeof value === 'string') return value;
  return value.toHexString?.() ?? value.toString();
}

function isoDate(value: Date | string | null | undefined, fallback: Date): string {
  const date = value instanceof Date ? value : value ? new Date(value) : fallback;
  if (!Number.isFinite(date.getTime())) return fallback.toISOString();
  return date.toISOString();
}

export function objectIdSubmittedAt(value: HydroRecordLike['_id'], fallback: Date): string {
  if (typeof value !== 'string' && value.getTimestamp) {
    const timestamp = value.getTimestamp();
    if (Number.isFinite(timestamp.getTime())) return timestamp.toISOString();
  }
  const hex = idString(value);
  if (/^[a-f\d]{24}$/i.test(hex)) {
    const milliseconds = Number.parseInt(hex.slice(0, 8), 16) * 1_000;
    const timestamp = new Date(milliseconds);
    if (Number.isFinite(timestamp.getTime())) return timestamp.toISOString();
  }
  return fallback.toISOString();
}

function mappedId(mapping: Record<string, string> | undefined, key: number): string | undefined {
  const value = mapping?.[String(key)]?.trim();
  return value || undefined;
}

export function mapHydroStatus(status: number): CanonicalStatus {
  return STATUS_MAP[status] ?? 'SYSTEM_ERROR';
}

export function isTerminalHydroStatus(status: number): boolean {
  return !NON_TERMINAL_STATUSES.has(status);
}

export function isProgressHydroStatus(status: number): boolean {
  return NON_TERMINAL_STATUSES.has(status);
}

function fingerprint(parts: Array<string | number | boolean | null | undefined>): string {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\u001f')).digest('hex');
}

function buildDraft(
  record: HydroRecordLike,
  binding: ContestBindingConfig,
  config: AgentConfig,
  now: Date,
): EventDraft {
  const contestId = idString(record.contest!).toLowerCase();
  const rid = idString(record._id);
  const status = mapHydroStatus(record.status);
  const submittedAt = objectIdSubmittedAt(record._id, now);
  const judgedAt = record.judgeAt ? isoDate(record.judgeAt, now) : undefined;
  const globalTeamId = mappedId(binding.teamMapping, record.uid);
  const globalProblemId = mappedId(binding.problemMapping, record.pid);
  const score = typeof record.score === 'number' && Number.isFinite(record.score) && record.score >= 0
    ? record.score
    : undefined;
  const lang = typeof record.lang === 'string' && record.lang.trim() ? record.lang.trim().slice(0, 64) : undefined;
  const rejudged = Boolean(record.rejudged);
  const submissionKey = `${config.siteId}:${record.domainId}:${contestId}:${rid}`;
  const captureKey = fingerprint([
    submissionKey,
    record.status,
    score,
    judgedAt,
    rejudged,
  ]);

  return {
    captureKey,
    submissionKey,
    domainId: record.domainId,
    contestId,
    rid,
    create(sourceSeq: number): SubmissionEvent {
      return {
        protocol_version: PROTOCOL_VERSION,
        event_type: 'submission.upsert',
        league_id: config.leagueId,
        site_id: config.siteId,
        source_seq: sourceSeq,
        domain_id: record.domainId,
        contest_id: contestId,
        rid,
        uid: record.uid,
        pid: record.pid,
        ...(globalTeamId ? { global_team_id: globalTeamId } : {}),
        ...(globalProblemId ? { global_problem_id: globalProblemId } : {}),
        status,
        ...(score !== undefined ? { score } : {}),
        ...(lang ? { lang } : {}),
        submitted_at: submittedAt,
        ...(judgedAt ? { judged_at: judgedAt } : {}),
        rejudged,
        emitted_at: now.toISOString(),
      };
    },
  };
}

export function createEventDraft(
  record: HydroRecordLike,
  config: AgentConfig,
  now = new Date(),
): EventDraft | null {
  if (!record.contest || !isTerminalHydroStatus(record.status)) return null;
  const contestId = idString(record.contest).toLowerCase();
  const binding = findBinding(config, record.domainId, contestId);
  if (!binding) return null;
  return buildDraft(record, binding, config, now);
}

export function createProgressEventDraft(
  record: HydroRecordLike,
  config: AgentConfig,
  now = new Date(),
): EventDraft | null {
  if (!record.contest || !isProgressHydroStatus(record.status)) return null;
  const contestId = idString(record.contest).toLowerCase();
  const binding = findBinding(config, record.domainId, contestId);
  if (!binding) return null;
  return buildDraft(record, binding, config, now);
}

export const WIRE_EVENT_KEYS = [
  'protocol_version',
  'event_type',
  'league_id',
  'site_id',
  'source_seq',
  'domain_id',
  'contest_id',
  'rid',
  'uid',
  'pid',
  'global_team_id',
  'global_problem_id',
  'status',
  'score',
  'lang',
  'submitted_at',
  'judged_at',
  'rejudged',
  'emitted_at',
] as const;

export function assertMetadataOnlyEvent(event: SubmissionEvent): void {
  const extraKeys = Object.keys(event).filter((key) => !(WIRE_EVENT_KEYS as readonly string[]).includes(key));
  if (extraKeys.length) throw new Error(`Submission event contains forbidden fields: ${extraKeys.join(', ')}`);
  validateSubmissionEvent(event);
}
