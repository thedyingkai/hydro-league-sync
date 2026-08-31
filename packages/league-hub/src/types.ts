export type SiteStatus = 'ONLINE' | 'DELAYED' | 'OFFLINE';

export interface HubContestConfig {
  contest_id: string;
  name: string;
  start_time: string;
  end_time: string;
  freeze_time?: string | null;
  unfreeze_at?: string | null;
  penalty_minutes?: number;
}

export interface HubSite {
  site_id: string;
  name: string;
  school_name?: string;
  enabled?: boolean;
  secret?: string;
}

export interface HubTeam {
  team_id: string;
  name: string;
  school_id: string;
  school_name?: string;
  official?: boolean;
  hidden?: boolean;
}

export interface HubProblem {
  problem_id: string;
  label: string;
  name: string;
  ordinal?: number;
  color?: string | null;
  rgb?: string | null;
}

export interface TeamMapping {
  league_id?: string;
  site_id: string;
  domain_id: string;
  contest_id: string;
  local_uid: string;
  team_id: string;
}

export interface ProblemMapping {
  league_id?: string;
  site_id: string;
  domain_id: string;
  contest_id: string;
  local_pid: string;
  problem_id: string;
}

export interface HubConfiguration {
  contest: HubContestConfig;
  sites: HubSite[];
  teams: HubTeam[];
  problems: HubProblem[];
  team_mappings: TeamMapping[];
  problem_mappings: ProblemMapping[];
}

export interface IngestEvent {
  protocol_version: '1.0';
  event_type: 'submission.upsert';
  league_id: string;
  site_id: string;
  domain_id: string;
  contest_id: string;
  rid: string;
  source_seq: number;
  status: string;
  uid: number;
  pid: number;
  submitted_at: string;
  lang?: string | null | undefined;
  score?: number | null | undefined;
  judged_at?: string | null | undefined;
  emitted_at: string;
  rejudged: boolean;
  global_team_id?: string | undefined;
  global_problem_id?: string | undefined;
}

export interface EventBatch {
  protocol_version: '1.0';
  batch_id: string;
  league_id: string;
  site_id: string;
  sent_at: string;
  events: IngestEvent[];
  /** Internal key used for chunked snapshot idempotency; never serialized. */
  idempotency_key?: string;
  snapshot_id?: string;
  snapshot_complete?: boolean;
}

export interface AuthenticatedPrincipal {
  kind: 'admin' | 'site';
  siteId?: string;
}
