import { z } from 'zod';
import { coalesceSubmissionEvents } from './events.js';
import { isScoreboardFrozen, ScoreboardInputError } from './scoring.js';
import {
  BadgeUrlSchema,
  isAcceptedStatus,
  isPenaltyStatus,
  isPendingStatus,
  LeagueConfigSchema,
  MappedSubmissionEventSchema,
  ProblemSchema,
  ScoreboardViewSchema,
  TeamSchema,
  XcpcioMedalsSchema,
  type CanonicalStatus,
  type LeagueConfig,
  type LeagueConfigInput,
  type MappedSubmissionEvent,
  type Problem,
  type ScoreboardView,
  type Team,
  type TeamInput,
} from './schemas.js';

export const XcpcioSubmissionStatusSchema = z.enum([
  'CORRECT',
  'REJECTED',
  'PENDING',
  'FROZEN',
  'WRONG_ANSWER',
  'TIME_LIMIT_EXCEEDED',
  'MEMORY_LIMIT_EXCEEDED',
  'OUTPUT_LIMIT_EXCEEDED',
  'RUNTIME_ERROR',
  'COMPILATION_ERROR',
  'SYSTEM_ERROR',
  'CANCELED',
]);
export type XcpcioSubmissionStatus = z.infer<typeof XcpcioSubmissionStatusSchema>;

export const XcpcioContestSchema = z.strictObject({
  contest_name: z.string().min(1),
  start_time: z.number().int(),
  end_time: z.number().int(),
  frozen_time: z.number().int().nonnegative(),
  penalty: z.number().int().nonnegative(),
  problem_quantity: z.number().int().nonnegative(),
  problem_id: z.array(z.string()),
  group: z.record(z.string(), z.string()),
  organization: z.string(),
  status_time_display: z.strictObject({
    correct: z.boolean(),
    incorrect: z.boolean(),
    pending: z.boolean(),
  }),
  medal: z.union([z.enum(['icpc', 'ccpc']), XcpcioMedalsSchema]),
  balloon_color: z.array(z.strictObject({
    color: z.string(),
    background_color: z.string(),
  })).optional(),
  logo: z.strictObject({ preset: z.enum(['ICPC', 'CCPC']) }),
  options: z.strictObject({ submission_timestamp_unit: z.literal('millisecond') }),
});

export const XcpcioTeamSchema = z.strictObject({
  team_id: z.string(),
  name: z.string(),
  organization: z.string(),
  members: z.array(z.string()),
  coach: z.string().optional(),
  group: z.array(z.string()),
  badge: z.strictObject({ url: BadgeUrlSchema }).optional(),
});

export const XcpcioSubmissionSchema = z.strictObject({
  problem_id: z.number().int().nonnegative(),
  team_id: z.string(),
  timestamp: z.number().int().nonnegative(),
  status: XcpcioSubmissionStatusSchema,
  language: z.string(),
  submission_id: z.string(),
});

export const XcpcioLeagueSiteStatusSchema = z.strictObject({
  site_id: z.string().min(1),
  name: z.string().min(1),
  school_name: z.string().min(1).optional(),
  status: z.enum(['ONLINE', 'DELAYED', 'OFFLINE']),
});

export const XcpcioLeagueStatusSchema = z.strictObject({
  generated_at: z.string().datetime({ offset: true }),
  complete: z.boolean(),
  message: z.string().nullable(),
  sites: z.array(XcpcioLeagueSiteStatusSchema),
});

export const XcpcioAllInOneSchema = z.strictObject({
  contest: XcpcioContestSchema,
  teams: z.array(XcpcioTeamSchema),
  submissions: z.array(XcpcioSubmissionSchema),
  league_status: XcpcioLeagueStatusSchema.optional(),
});

export type XcpcioAllInOne = z.infer<typeof XcpcioAllInOneSchema>;
export type XcpcioLeagueStatus = z.infer<typeof XcpcioLeagueStatusSchema>;

export interface ToXcpcioAllInOneInput {
  config: LeagueConfigInput | LeagueConfig;
  teams: readonly TeamInput[] | readonly Team[];
  problems: readonly Problem[];
  /** Events must already be resolved against hub-owned Excel mappings. */
  events: readonly MappedSubmissionEvent[];
  view: ScoreboardView;
  now?: Date | string;
}

function parseNow(value: Date | string | undefined): Date {
  const date = value === undefined ? new Date() : value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ScoreboardInputError('now must be a valid date');
  return date;
}

function xcpcioStatus(status: CanonicalStatus, detailed: boolean): XcpcioSubmissionStatus {
  if (isAcceptedStatus(status)) return 'CORRECT';
  if (isPendingStatus(status)) return 'PENDING';
  if (isPenaltyStatus(status)) {
    if (!detailed) return 'REJECTED';
    switch (status) {
      case 'WRONG_ANSWER':
      case 'TIME_LIMIT_EXCEEDED':
      case 'MEMORY_LIMIT_EXCEEDED':
      case 'OUTPUT_LIMIT_EXCEEDED':
      case 'RUNTIME_ERROR':
        return status;
      default:
        throw new TypeError(`Unexpected penalty status: ${status}`);
    }
  }
  if (status === 'COMPILE_ERROR') return 'COMPILATION_ERROR';
  if (status === 'CANCELED') return 'CANCELED';
  return 'SYSTEM_ERROR';
}

function xcpcioTeam(team: Team): z.infer<typeof XcpcioTeamSchema> {
  const classification = team.is_official ? 'official' : 'unofficial';
  const group = [classification, ...team.groups.filter((item) => item !== 'official' && item !== 'unofficial')];
  return {
    team_id: team.global_team_id,
    name: team.name,
    organization: team.organization_name,
    members: team.members,
    group,
    ...(team.coach === undefined ? {} : { coach: team.coach }),
    ...(team.badge_url === undefined ? {} : { badge: { url: team.badge_url } }),
  };
}

/** Produces the all-in-one JSON consumed by Hydro's XCPCIO board wrapper. */
export function toXcpcioAllInOne(input: ToXcpcioAllInOneInput): XcpcioAllInOne {
  const config = LeagueConfigSchema.parse(input.config);
  const teams = z.array(TeamSchema).parse(input.teams);
  const problems = z.array(ProblemSchema).parse(input.problems).sort((a, b) => a.ordinal - b.ordinal);
  const events = coalesceSubmissionEvents(z.array(MappedSubmissionEventSchema).parse(input.events));
  const view = ScoreboardViewSchema.parse(input.view);
  const now = parseNow(input.now);
  const startMs = Date.parse(config.starts_at);
  const endMs = Date.parse(config.ends_at);
  const freezeMs = config.freeze_at === null ? null : Date.parse(config.freeze_at);
  const frozen = isScoreboardFrozen(config, view, now);
  const detailed = now.getTime() >= endMs;
  const teamIds = new Set(teams.map((team) => team.global_team_id));
  const problemIndex = new Map(problems.map((problem, index) => [problem.global_problem_id, index]));
  const extraGroups = new Set(teams.flatMap((team) => team.groups));
  extraGroups.delete('official');
  extraGroups.delete('unofficial');
  const groups: Record<string, string> = {
    official: '正式队伍',
    unofficial: '打星队伍',
  };
  for (const group of [...extraGroups].sort()) groups[group] = group;

  if (events.some((event) => event.league_id !== config.league_id)) {
    throw new ScoreboardInputError('All events must belong to config.league_id');
  }

  const submissions = events.flatMap((event) => {
    const submittedAtMs = Date.parse(event.submitted_at);
    const index = problemIndex.get(event.global_problem_id);
    if (index === undefined || !teamIds.has(event.global_team_id)) return [];
    if (submittedAtMs < startMs || submittedAtMs > endMs || submittedAtMs > now.getTime()) return [];
    const status = frozen && freezeMs !== null && submittedAtMs >= freezeMs
      ? 'FROZEN'
      : xcpcioStatus(event.status, detailed);
    return [{
      problem_id: index,
      team_id: event.global_team_id,
      timestamp: submittedAtMs - startMs,
      status,
      language: event.lang ?? '',
      submission_id: `${event.site_id}/${event.domain_id}/${event.contest_id}/${event.rid}`,
    }];
  });

  const hasCompleteColors = problems.length > 0 && problems.every((problem) => problem.color !== undefined);
  const frozenTime = config.freeze_at === null ? 0 : Math.max(0, Math.floor((endMs - freezeMs!) / 1000));
  return XcpcioAllInOneSchema.parse({
    contest: {
      contest_name: config.title,
      start_time: Math.floor(startMs / 1000),
      end_time: Math.floor(endMs / 1000),
      frozen_time: frozenTime,
      penalty: config.penalty_seconds,
      problem_quantity: problems.length,
      problem_id: problems.map((problem) => problem.label),
      group: groups,
      organization: 'School',
      status_time_display: { correct: true, incorrect: true, pending: true },
      medal: config.xcpcio_medals ?? (config.xcpcio_preset === 'ICPC' ? 'icpc' : 'ccpc'),
      ...(hasCompleteColors ? {
        balloon_color: problems.map((problem) => ({
          color: '#000000',
          background_color: problem.color!,
        })),
      } : {}),
      logo: { preset: config.xcpcio_preset },
      options: { submission_timestamp_unit: 'millisecond' },
    },
    teams: teams.map(xcpcioTeam),
    submissions,
  });
}
