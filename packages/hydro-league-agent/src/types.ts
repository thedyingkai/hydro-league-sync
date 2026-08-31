export type CanonicalStatus =
  | 'PENDING'
  | 'JUDGING'
  | 'ACCEPTED'
  | 'WRONG_ANSWER'
  | 'TIME_LIMIT_EXCEEDED'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'RUNTIME_ERROR'
  | 'COMPILE_ERROR'
  | 'SYSTEM_ERROR'
  | 'FORMAT_ERROR'
  | 'IGNORED'
  | 'CANCELED';

export interface SubmissionEvent {
  protocol_version: '1.0';
  event_type: 'submission.upsert';
  league_id: string;
  site_id: string;
  source_seq: number;
  domain_id: string;
  contest_id: string;
  rid: string;
  uid: number;
  pid: number;
  global_team_id?: string;
  global_problem_id?: string;
  status: CanonicalStatus;
  score?: number;
  lang?: string;
  submitted_at: string;
  judged_at?: string;
  rejudged: boolean;
  emitted_at: string;
}

export interface BatchEnvelope {
  protocol_version: '1.0';
  batch_id: string;
  league_id: string;
  site_id: string;
  sent_at: string;
  events: SubmissionEvent[];
}

export interface ObjectIdLike {
  toHexString?: () => string;
  toString: () => string;
  getTimestamp?: () => Date;
}

export interface HydroRecordLike {
  _id: string | ObjectIdLike;
  domainId: string;
  contest?: string | ObjectIdLike | null;
  uid: number;
  pid: number;
  status: number;
  score?: number | null;
  lang?: string | null;
  judgeAt?: Date | string | null;
  rejudged?: boolean;
  [key: string]: unknown;
}

export interface ContestBindingConfig {
  domainId: string;
  contestId: string;
  teamMapping?: Record<string, string>;
  problemMapping?: Record<string, string>;
}

export interface AgentConfig {
  enabled: boolean;
  centerUrl: string;
  allowInsecureHttp: boolean;
  leagueId: string;
  siteId: string;
  sharedSecret: string;
  contests: ContestBindingConfig[];
  batchSize: number;
  flushIntervalMs: number;
  heartbeatIntervalMs: number;
  reconciliationIntervalMs: number;
  requestTimeoutMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  leaseMs: number;
  cacheTtlMs: number;
  cacheMaxStaleMs: number;
  sourceUrl: string;
}

export type OutboxState = 'pending' | 'inflight' | 'acked' | 'rejected';

export interface OutboxDocument {
  _id: string;
  captureKey: string;
  submissionKey: string;
  sourceSeq: number;
  domainId: string;
  contestId: string;
  rid: string;
  state: OutboxState;
  attempts: number;
  availableAt: Date;
  leaseUntil?: Date;
  leaseOwner?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
  ackedAt?: Date;
  rejectedAt?: Date;
  event: SubmissionEvent;
}

export interface SequenceDocument {
  _id: string;
  value: number;
}

export interface CaptureReservationDocument {
  _id: string;
  state: 'allocating' | 'done';
  owner: string;
  leaseUntil: Date;
  sourceSeq?: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface FindCursorLike<T> {
  sort(spec: Record<string, 1 | -1>): FindCursorLike<T>;
  limit(count: number): FindCursorLike<T>;
  project?<U>(spec: Record<string, 0 | 1>): FindCursorLike<U>;
  batchSize?(count: number): FindCursorLike<T>;
  toArray(): Promise<T[]>;
}

export interface CollectionLike<T> {
  findOne(filter: Record<string, unknown>): Promise<T | null>;
  findOneAndUpdate(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options: Record<string, unknown>,
  ): Promise<T | null>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  updateMany(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  countDocuments(filter?: Record<string, unknown>): Promise<number>;
  find(filter: Record<string, unknown>): FindCursorLike<T>;
}

export interface MongoServiceLike {
  collection<T = unknown>(name: string): CollectionLike<T>;
  ensureIndexes?(
    collection: CollectionLike<unknown>,
    ...indexes: Array<Record<string, unknown>>
  ): Promise<unknown>;
}

export interface LoggerLike {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface BatchAck {
  protocol_version: '1.0';
  batch_id: string;
  league_id: string;
  site_id: string;
  accepted_count: number;
  duplicate_count: number;
  rejected: Array<{
    source_seq: number;
    rid: string;
    code: string;
    message: string;
    retryable: boolean;
  }>;
  high_watermark: number;
  received_at: string;
}

export interface SnapshotEnvelope {
  protocol_version: '1.0';
  snapshot_id: string;
  league_id: string;
  site_id: string;
  generated_at: string;
  chunk_index: number;
  complete: boolean;
  events: SubmissionEvent[];
}

export interface HeartbeatEnvelope {
  protocol_version: '1.0';
  league_id: string;
  site_id: string;
  sent_at: string;
  pending_events: number;
  rejected_events: number;
  last_acked_source_seq?: number;
  agent_version: string;
  hydro_version: string;
}

export type BoardView = 'public' | 'jury';

export interface CacheResult<T> {
  value: T;
  stale: boolean;
  fetchedAt: string;
  error?: string;
}

export interface ScoreboardResponse {
  contest?: Record<string, unknown>;
  view?: BoardView;
  generated_at?: string;
  cursor?: string | number;
  frozen?: boolean;
  accuracy?: Record<string, unknown>;
  sites?: unknown[];
  problems?: unknown[];
  rows?: unknown[];
  teams?: unknown[];
  [key: string]: unknown;
}

export interface SubmissionFeedResponse {
  cursor: string | number;
  items: unknown[];
  has_more?: boolean;
  [key: string]: unknown;
}

export type XcpcioSubmissionStatus =
  | 'CORRECT'
  | 'REJECTED'
  | 'PENDING'
  | 'FROZEN'
  | 'WRONG_ANSWER'
  | 'TIME_LIMIT_EXCEEDED'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'RUNTIME_ERROR'
  | 'COMPILATION_ERROR'
  | 'SYSTEM_ERROR'
  | 'CANCELED';

export interface XcpcioAllInOneResponse {
  contest: {
    contest_name: string;
    start_time: number;
    end_time: number;
    frozen_time: number;
    penalty: number;
    problem_quantity: number;
    problem_id: string[];
    group: Record<string, string>;
    organization: string;
    status_time_display: {
      correct: boolean;
      incorrect: boolean;
      pending: boolean;
    };
    medal: 'icpc' | 'ccpc';
    balloon_color?: Array<{ color: string; background_color: string }>;
    logo: { preset: 'ICPC' | 'CCPC' };
    options: { submission_timestamp_unit: 'millisecond' };
  };
  teams: Array<{
    team_id: string;
    name: string;
    organization: string;
    members: string[];
    coach?: string;
    group: string[];
    badge?: { url: string };
  }>;
  submissions: Array<{
    problem_id: number;
    team_id: string;
    timestamp: number;
    status: XcpcioSubmissionStatus;
    language: string;
    submission_id: string;
  }>;
  league_status?: {
    generated_at: string;
    complete: boolean;
    message: string | null;
    sites: Array<{
      site_id: string;
      name: string;
      school_name?: string;
      status: 'ONLINE' | 'DELAYED' | 'OFFLINE';
    }>;
  };
}

export interface HubTransport {
  sendBatch(events: SubmissionEvent[]): Promise<BatchAck>;
  sendSnapshot(envelope: SnapshotEnvelope): Promise<BatchAck>;
  sendHeartbeat(envelope: HeartbeatEnvelope): Promise<void>;
  getScoreboard(view: BoardView): Promise<ScoreboardResponse>;
  getSubmissions(cursor: string, view: BoardView): Promise<SubmissionFeedResponse>;
  getXcpcio(view: BoardView): Promise<XcpcioAllInOneResponse>;
  getSiteStatus(): Promise<unknown>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
