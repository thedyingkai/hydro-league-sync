import { z } from 'zod';

export const PROTOCOL_VERSION = '1.0' as const;
export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** IDs are opaque, case-sensitive values. Slash and control characters are excluded. */
export const OpaqueIdSchema = z.string().min(1).max(128).regex(ID_PATTERN);
export const GroupNameSchema = z.string().trim().min(1).max(128)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);

const BADGE_URL_FORBIDDEN_CHARACTERS = /[\p{Cc}\\]/u;

function repeatedlyDecode(value: string): string | undefined {
  let decoded = value;
  for (let pass = 0; pass < 16; pass += 1) {
    let invalidUtf8 = false;
    const next = decoded.replace(/(?:%[0-9a-f]{2})+/giu, (sequence: string) => {
      try {
        return decodeURIComponent(sequence);
      } catch {
        invalidUtf8 = true;
        return '';
      }
    });
    if (invalidUtf8) return undefined;
    if (next === decoded) return decoded;
    decoded = next;
  }
  return undefined;
}

function decodedPathIsSafe(path: string): boolean {
  const decoded = repeatedlyDecode(path);
  if (decoded === undefined) return false;
  if (BADGE_URL_FORBIDDEN_CHARACTERS.test(decoded) || decoded.includes('//')) return false;
  return !decoded.split('/').some((segment) => segment === '..');
}

export function isSafeBadgeUrl(value: string): boolean {
  const decoded = repeatedlyDecode(value);
  if (value.length < 1 || value.length > 2_048 || decoded === undefined
    || BADGE_URL_FORBIDDEN_CHARACTERS.test(decoded)) return false;
  if (value.startsWith('/')) {
    if (value.startsWith('//')) return false;
    return decodedPathIsSafe(value.split(/[?#]/u, 1)[0]!);
  }

  const match = value.match(/^https?:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/iu);
  if (!match || match[1]!.includes('@')) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return false;
  return decodedPathIsSafe(match[2] ?? '/');
}

export const BadgeUrlSchema = z.string().refine(isSafeBadgeUrl, {
  message: 'Badge URL must be credential-free HTTP(S) or a safe root-relative path',
});

export const SourceSeqSchema = z.number().int().safe().positive();
export const HydroUidSchema = z.number().int().safe().nonnegative();
export const HydroPidSchema = z.number().int().safe().positive();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const NonceSchema = z.string().regex(NONCE_PATTERN);

export const CanonicalStatusSchema = z.enum([
  'PENDING',
  'JUDGING',
  'ACCEPTED',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'OUTPUT_LIMIT_EXCEEDED',
  'RUNTIME_ERROR',
  'COMPILE_ERROR',
  'SYSTEM_ERROR',
  'FORMAT_ERROR',
  'IGNORED',
  'CANCELED',
]);

export type CanonicalStatus = z.infer<typeof CanonicalStatusSchema>;

export type PendingStatus = 'PENDING' | 'JUDGING';
export type PenaltyStatus =
  | 'WRONG_ANSWER'
  | 'TIME_LIMIT_EXCEEDED'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'RUNTIME_ERROR';
export type NonPenaltyRejectionStatus =
  | 'COMPILE_ERROR'
  | 'SYSTEM_ERROR'
  | 'FORMAT_ERROR'
  | 'IGNORED'
  | 'CANCELED';

export const PENDING_STATUSES: ReadonlySet<PendingStatus> = new Set(['PENDING', 'JUDGING']);
export const PENALTY_STATUSES: ReadonlySet<PenaltyStatus> = new Set([
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'OUTPUT_LIMIT_EXCEEDED',
  'RUNTIME_ERROR',
]);
export const NON_PENALTY_REJECTION_STATUSES: ReadonlySet<NonPenaltyRejectionStatus> = new Set([
  'COMPILE_ERROR',
  'SYSTEM_ERROR',
  'FORMAT_ERROR',
  'IGNORED',
  'CANCELED',
]);

export function isAcceptedStatus(status: CanonicalStatus): status is 'ACCEPTED' {
  return status === 'ACCEPTED';
}

export function isPendingStatus(status: CanonicalStatus): status is PendingStatus {
  return PENDING_STATUSES.has(status as PendingStatus);
}

export function isPenaltyStatus(status: CanonicalStatus): status is PenaltyStatus {
  return PENALTY_STATUSES.has(status as PenaltyStatus);
}

export const SubmissionEventSchema = z.strictObject({
  protocol_version: ProtocolVersionSchema,
  event_type: z.literal('submission.upsert'),
  league_id: OpaqueIdSchema,
  site_id: OpaqueIdSchema,
  source_seq: SourceSeqSchema,
  domain_id: OpaqueIdSchema,
  contest_id: OpaqueIdSchema,
  rid: OpaqueIdSchema,
  uid: HydroUidSchema,
  pid: HydroPidSchema,
  /** Optional, untrusted cache hint. The hub resolves the authoritative mapping. */
  global_team_id: OpaqueIdSchema.optional(),
  /** Optional, untrusted cache hint. The hub resolves the authoritative mapping. */
  global_problem_id: OpaqueIdSchema.optional(),
  status: CanonicalStatusSchema,
  score: z.number().finite().nonnegative().optional(),
  lang: z.string().trim().max(64).optional(),
  submitted_at: IsoDateTimeSchema,
  judged_at: IsoDateTimeSchema.optional(),
  rejudged: z.boolean(),
  emitted_at: IsoDateTimeSchema,
});

export const SyncEventSchema = SubmissionEventSchema;
export type SubmissionEvent = z.infer<typeof SubmissionEventSchema>;
export type SyncEvent = SubmissionEvent;

export const MappedSubmissionEventSchema = SubmissionEventSchema.extend({
  global_team_id: OpaqueIdSchema,
  global_problem_id: OpaqueIdSchema,
});
export type MappedSubmissionEvent = z.infer<typeof MappedSubmissionEventSchema>;

export function isMappedSubmissionEvent(event: SubmissionEvent): event is MappedSubmissionEvent {
  return event.global_team_id !== undefined && event.global_problem_id !== undefined;
}

export const EventBatchEnvelopeSchema = z.strictObject({
  protocol_version: ProtocolVersionSchema,
  batch_id: z.string().uuid(),
  league_id: OpaqueIdSchema,
  site_id: OpaqueIdSchema,
  sent_at: IsoDateTimeSchema,
  events: z.array(SubmissionEventSchema).min(1).max(1000),
}).superRefine((batch, ctx) => {
  batch.events.forEach((event, index) => {
    if (event.league_id !== batch.league_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'event league_id must match envelope league_id',
        path: ['events', index, 'league_id'],
      });
    }
    if (event.site_id !== batch.site_id) {
      ctx.addIssue({
        code: 'custom',
        message: 'event site_id must match envelope site_id',
        path: ['events', index, 'site_id'],
      });
    }
  });
});

export type EventBatchEnvelope = z.infer<typeof EventBatchEnvelopeSchema>;

export const EventRejectionSchema = z.strictObject({
  source_seq: SourceSeqSchema,
  rid: OpaqueIdSchema,
  code: z.string().trim().min(1).max(64),
  message: z.string().trim().min(1).max(500),
  retryable: z.boolean(),
});

export const EventBatchAckSchema = z.strictObject({
  protocol_version: ProtocolVersionSchema,
  batch_id: z.string().uuid(),
  league_id: OpaqueIdSchema,
  site_id: OpaqueIdSchema,
  accepted_count: z.number().int().nonnegative(),
  duplicate_count: z.number().int().nonnegative(),
  rejected: z.array(EventRejectionSchema),
  /**
   * Highest contiguous sequence durably classified as accepted, duplicate, or
   * non-retryable quarantine. It never crosses a gap or retryable rejection.
   */
  high_watermark: z.number().int().safe().nonnegative(),
  received_at: IsoDateTimeSchema,
}).superRefine((ack, ctx) => {
  ack.rejected.forEach((rejection, index) => {
    if (rejection.retryable && rejection.source_seq <= ack.high_watermark) {
      ctx.addIssue({
        code: 'custom',
        message: 'high_watermark must not cross a retryable rejection',
        path: ['rejected', index, 'source_seq'],
      });
    }
  });
});

export type EventBatchAck = z.infer<typeof EventBatchAckSchema>;

export const XcpcioMedalCountsSchema = z.strictObject({
  gold: z.number().int().safe().nonnegative(),
  silver: z.number().int().safe().nonnegative(),
  bronze: z.number().int().safe().nonnegative(),
});

export const XcpcioMedalsSchema = z.record(GroupNameSchema, XcpcioMedalCountsSchema);

export const LeagueConfigSchema = z.strictObject({
  protocol_version: ProtocolVersionSchema,
  league_id: OpaqueIdSchema,
  title: z.string().trim().min(1).max(200),
  rule: z.literal('acm'),
  starts_at: IsoDateTimeSchema,
  ends_at: IsoDateTimeSchema,
  freeze_at: IsoDateTimeSchema.nullable().default(null),
  /** Public results stay frozen until this instant; null means until an explicit config update. */
  unfreeze_at: IsoDateTimeSchema.nullable().default(null),
  penalty_seconds: z.number().int().nonnegative().default(1200),
  xcpcio_preset: z.enum(['ICPC', 'CCPC']).default('ICPC'),
  xcpcio_medals: XcpcioMedalsSchema.optional(),
}).superRefine((config, ctx) => {
  const startsAt = Date.parse(config.starts_at);
  const endsAt = Date.parse(config.ends_at);
  if (endsAt <= startsAt) {
    ctx.addIssue({ code: 'custom', message: 'ends_at must be after starts_at', path: ['ends_at'] });
  }
  if (config.freeze_at !== null) {
    const freezeAt = Date.parse(config.freeze_at);
    if (freezeAt < startsAt || freezeAt > endsAt) {
      ctx.addIssue({
        code: 'custom',
        message: 'freeze_at must be within the contest interval',
        path: ['freeze_at'],
      });
    }
  }
  if (config.unfreeze_at !== null && Date.parse(config.unfreeze_at) < endsAt) {
    ctx.addIssue({
      code: 'custom',
      message: 'unfreeze_at must not be earlier than ends_at',
      path: ['unfreeze_at'],
    });
  }
});

export type LeagueConfig = z.output<typeof LeagueConfigSchema>;
export type LeagueConfigInput = z.input<typeof LeagueConfigSchema>;

export const TeamSchema = z.strictObject({
  global_team_id: OpaqueIdSchema,
  name: z.string().trim().min(1).max(200),
  organization_id: OpaqueIdSchema,
  organization_name: z.string().trim().min(1).max(200),
  site_id: OpaqueIdSchema,
  is_official: z.boolean(),
  members: z.array(z.string().trim().min(1).max(100)).max(10).default([]),
  coach: z.string().trim().max(100).optional(),
  groups: z.array(GroupNameSchema).max(20).default([]),
  badge_url: BadgeUrlSchema.optional(),
});

export type Team = z.output<typeof TeamSchema>;
export type TeamInput = z.input<typeof TeamSchema>;

export const ProblemSchema = z.strictObject({
  global_problem_id: OpaqueIdSchema,
  label: z.string().trim().min(1).max(16),
  name: z.string().trim().min(1).max(200),
  ordinal: z.number().int().nonnegative(),
  color: z.string().trim().min(1).max(64).optional(),
});

export type Problem = z.infer<typeof ProblemSchema>;

export const TeamAccountMappingSchema = z.strictObject({
  league_id: OpaqueIdSchema,
  site_id: OpaqueIdSchema,
  domain_id: OpaqueIdSchema,
  contest_id: OpaqueIdSchema,
  uid: HydroUidSchema,
  global_team_id: OpaqueIdSchema,
});
export type TeamAccountMapping = z.infer<typeof TeamAccountMappingSchema>;

export const LocalProblemMappingSchema = z.strictObject({
  league_id: OpaqueIdSchema,
  site_id: OpaqueIdSchema,
  domain_id: OpaqueIdSchema,
  contest_id: OpaqueIdSchema,
  pid: HydroPidSchema,
  global_problem_id: OpaqueIdSchema,
});
export type LocalProblemMapping = z.infer<typeof LocalProblemMappingSchema>;

export const SiteConnectionStateSchema = z.enum(['ONLINE', 'DELAYED', 'OFFLINE']);
export const SiteStatusSchema = z.strictObject({
  site_id: OpaqueIdSchema,
  school_name: z.string().trim().min(1).max(200),
  state: SiteConnectionStateSchema,
  last_success_at: IsoDateTimeSchema.nullable(),
  lag_seconds: z.number().int().nonnegative(),
});
export type SiteStatus = z.infer<typeof SiteStatusSchema>;

export const ScoreboardViewSchema = z.enum(['public', 'jury']);
export type ScoreboardView = z.infer<typeof ScoreboardViewSchema>;

export const ProblemScoreSchema = z.strictObject({
  global_problem_id: OpaqueIdSchema,
  label: z.string().trim().min(1).max(16),
  solved: z.boolean(),
  wrong_attempts: z.number().int().nonnegative(),
  pending_attempts: z.number().int().nonnegative(),
  frozen_attempts: z.number().int().nonnegative(),
  solve_time_minutes: z.number().int().nonnegative().nullable(),
  penalty_minutes: z.number().int().nonnegative(),
  first_to_solve: z.boolean(),
});

export type ProblemScore = z.infer<typeof ProblemScoreSchema>;

export const TeamScoreRowSchema = z.strictObject({
  rank: z.number().int().positive().nullable(),
  global_team_id: OpaqueIdSchema,
  name: z.string(),
  organization_id: OpaqueIdSchema,
  organization_name: z.string(),
  site_id: OpaqueIdSchema,
  is_official: z.boolean(),
  solved: z.number().int().nonnegative(),
  penalty_minutes: z.number().int().nonnegative(),
  last_solved_seconds: z.number().int().nonnegative().nullable(),
  problems: z.array(ProblemScoreSchema),
});

export type TeamScoreRow = z.infer<typeof TeamScoreRowSchema>;

export const ScoreboardWarningSchema = z.strictObject({
  code: z.enum(['SITE_DELAYED', 'SITE_OFFLINE', 'UNMAPPED_EVENT', 'OUT_OF_CONTEST_EVENT']),
  message: z.string().trim().min(1).max(500),
  site_id: OpaqueIdSchema.optional(),
  last_sync_at: IsoDateTimeSchema.nullable().optional(),
  event_key: z.string().optional(),
});

export type ScoreboardWarning = z.infer<typeof ScoreboardWarningSchema>;

export const ScoreboardSnapshotSchema = z.strictObject({
  protocol_version: ProtocolVersionSchema,
  league_id: OpaqueIdSchema,
  view: ScoreboardViewSchema,
  generated_at: IsoDateTimeSchema,
  frozen: z.boolean(),
  data_complete: z.boolean(),
  warnings: z.array(ScoreboardWarningSchema),
  rows: z.array(TeamScoreRowSchema),
});

export type ScoreboardSnapshot = z.infer<typeof ScoreboardSnapshotSchema>;

export const HmacHeaderSchema = z.strictObject({
  'x-hydro-league-site-id': OpaqueIdSchema,
  'x-hydro-league-timestamp': z.string().regex(/^\d{1,16}$/),
  'x-hydro-league-nonce': NonceSchema,
  'x-hydro-league-signature': z.string().regex(/^v1=[a-f0-9]{64}$/),
});

export type HmacHeaders = z.infer<typeof HmacHeaderSchema>;
