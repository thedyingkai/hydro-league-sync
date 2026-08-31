import {
  LeagueConfigSchema,
  MappedSubmissionEventSchema,
  SubmissionEventSchema,
  type LeagueConfig,
  type MappedSubmissionEvent,
  type SubmissionEvent,
} from '../src/index.js';

export const contestStart = '2026-09-01T00:00:00.000Z';

export function atMinute(minute: number): string {
  return new Date(Date.parse(contestStart) + minute * 60_000).toISOString();
}

export function leagueConfig(overrides: Record<string, unknown> = {}): LeagueConfig {
  return LeagueConfigSchema.parse({
    protocol_version: '1.0',
    league_id: 'league-1',
    title: 'Hydro League',
    rule: 'acm',
    starts_at: contestStart,
    ends_at: atMinute(300),
    freeze_at: atMinute(240),
    unfreeze_at: null,
    penalty_seconds: 1200,
    xcpcio_preset: 'ICPC',
    ...overrides,
  });
}

export function event(overrides: Record<string, unknown> = {}): SubmissionEvent {
  return SubmissionEventSchema.parse({
    protocol_version: '1.0',
    event_type: 'submission.upsert',
    league_id: 'league-1',
    site_id: 'site-1',
    source_seq: 1,
    domain_id: 'system',
    contest_id: 'contest-1',
    rid: 'rid-1',
    uid: 10,
    pid: 1001,
    status: 'WRONG_ANSWER',
    submitted_at: atMinute(10),
    rejudged: false,
    emitted_at: atMinute(10),
    ...overrides,
  });
}

export function mappedEvent(overrides: Record<string, unknown> = {}): MappedSubmissionEvent {
  return MappedSubmissionEventSchema.parse({
    ...event(overrides),
    global_team_id: 'team-1',
    global_problem_id: 'problem-a',
    ...overrides,
  });
}

export const teams = [
  {
    global_team_id: 'team-1',
    name: 'Alpha',
    organization_id: 'school-1',
    organization_name: 'First School',
    site_id: 'site-1',
    is_official: true,
  },
  {
    global_team_id: 'team-2',
    name: 'Beta',
    organization_id: 'school-2',
    organization_name: 'Second School',
    site_id: 'site-2',
    is_official: true,
  },
];

export const problems = [
  { global_problem_id: 'problem-a', label: 'A', name: 'A + B', ordinal: 0, color: '#ef4444' },
  { global_problem_id: 'problem-b', label: 'B', name: 'Bridges', ordinal: 1, color: '#22c55e' },
];
