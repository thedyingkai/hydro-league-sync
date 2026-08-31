import { z } from 'zod';
import { coalesceSubmissionEvents, submissionKey } from './events.js';
import {
  isAcceptedStatus,
  isMappedSubmissionEvent,
  isPenaltyStatus,
  isPendingStatus,
  LeagueConfigSchema,
  ProblemSchema,
  PROTOCOL_VERSION,
  ScoreboardSnapshotSchema,
  ScoreboardViewSchema,
  SiteStatusSchema,
  SubmissionEventSchema,
  TeamSchema,
  type LeagueConfig,
  type LeagueConfigInput,
  type MappedSubmissionEvent,
  type Problem,
  type ProblemScore,
  type ScoreboardSnapshot,
  type ScoreboardView,
  type ScoreboardWarning,
  type SiteStatus,
  type SubmissionEvent,
  type Team,
  type TeamInput,
  type TeamScoreRow,
} from './schemas.js';

export class ScoreboardInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoreboardInputError';
  }
}

export interface ComputeScoreboardInput {
  config: LeagueConfigInput | LeagueConfig;
  teams: readonly TeamInput[] | readonly Team[];
  problems: readonly Problem[];
  events: readonly SubmissionEvent[];
  view: ScoreboardView;
  now?: Date | string;
  siteStatuses?: readonly SiteStatus[];
}

interface ComputedProblem {
  score: ProblemScore;
  acceptedAtMs: number | null;
}

interface WorkingRow {
  row: TeamScoreRow;
  acceptedAtByProblem: Map<string, number>;
}

function uniqueMap<T>(items: readonly T[], keyOf: (item: T) => string, label: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const key = keyOf(item);
    if (map.has(key)) throw new ScoreboardInputError(`Duplicate ${label}: ${key}`);
    map.set(key, item);
  }
  return map;
}

function parseNow(value: Date | string | undefined): Date {
  const date = value === undefined ? new Date() : value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ScoreboardInputError('now must be a valid date');
  return date;
}

export function isScoreboardFrozen(
  config: LeagueConfig,
  view: ScoreboardView,
  at: Date,
): boolean {
  if (view !== 'public' || config.freeze_at === null) return false;
  const nowMs = at.getTime();
  if (nowMs < Date.parse(config.freeze_at)) return false;
  return config.unfreeze_at === null || nowMs < Date.parse(config.unfreeze_at);
}

function computeProblemScore(
  problem: Problem,
  events: readonly SubmissionEvent[],
  startMs: number,
  penaltySeconds: number,
  frozen: boolean,
  freezeMs: number | null,
): ComputedProblem {
  let wrongAttempts = 0;
  let pendingAttempts = 0;
  let frozenAttempts = 0;
  let acceptedAtMs: number | null = null;

  for (const event of events) {
    const submittedAtMs = Date.parse(event.submitted_at);
    if (frozen && freezeMs !== null && submittedAtMs >= freezeMs) {
      frozenAttempts += 1;
      continue;
    }
    if (isAcceptedStatus(event.status)) {
      acceptedAtMs = submittedAtMs;
      break;
    }
    if (isPenaltyStatus(event.status)) wrongAttempts += 1;
    else if (isPendingStatus(event.status)) pendingAttempts += 1;
  }

  const solved = acceptedAtMs !== null;
  const solveTimeSeconds = acceptedAtMs === null
    ? null
    : Math.max(0, Math.floor((acceptedAtMs - startMs) / 1000));
  const solveTimeMinutes = solveTimeSeconds === null ? null : Math.floor(solveTimeSeconds / 60);
  const penaltyMinutes = solveTimeSeconds === null
    ? 0
    : Math.floor((solveTimeSeconds + wrongAttempts * penaltySeconds) / 60);

  return {
    acceptedAtMs,
    score: {
      global_problem_id: problem.global_problem_id,
      label: problem.label,
      solved,
      wrong_attempts: wrongAttempts,
      pending_attempts: pendingAttempts,
      frozen_attempts: frozenAttempts,
      solve_time_minutes: solveTimeMinutes,
      penalty_minutes: penaltyMinutes,
      first_to_solve: false,
    },
  };
}

function comparePerformance(a: TeamScoreRow, b: TeamScoreRow): number {
  if (a.solved !== b.solved) return b.solved - a.solved;
  if (a.penalty_minutes !== b.penalty_minutes) return a.penalty_minutes - b.penalty_minutes;
  const aLast = a.last_solved_seconds ?? Number.POSITIVE_INFINITY;
  const bLast = b.last_solved_seconds ?? Number.POSITIVE_INFINITY;
  if (aLast !== bLast) return aLast - bLast;
  const byName = a.name.localeCompare(b.name, 'en-US');
  if (byName !== 0) return byName;
  return a.global_team_id.localeCompare(b.global_team_id, 'en-US');
}

function sameRankScore(a: TeamScoreRow, b: TeamScoreRow): boolean {
  return a.solved === b.solved
    && a.penalty_minutes === b.penalty_minutes
    && a.last_solved_seconds === b.last_solved_seconds;
}

function rankOfficialTeams(rows: readonly TeamScoreRow[]): Map<string, number> {
  const official = rows.filter((row) => row.is_official).sort(comparePerformance);
  const ranks = new Map<string, number>();
  let rank = 0;
  official.forEach((row, index) => {
    if (index === 0 || !sameRankScore(row, official[index - 1]!)) rank = index + 1;
    ranks.set(row.global_team_id, rank);
  });
  return ranks;
}

function siteWarnings(statuses: readonly SiteStatus[]): ScoreboardWarning[] {
  return statuses.flatMap((status) => {
    if (status.state === 'ONLINE') return [];
    const code = status.state === 'OFFLINE' ? 'SITE_OFFLINE' : 'SITE_DELAYED';
    const connection = status.state === 'OFFLINE' ? 'offline' : 'delayed';
    return [{
      code,
      message: `${status.school_name} is ${connection}; the scoreboard may be incomplete.`,
      site_id: status.site_id,
      last_sync_at: status.last_success_at,
    } satisfies ScoreboardWarning];
  });
}

/** Computes an ACM/ICPC scoreboard from the current revision of every submission. */
export function computeScoreboard(input: ComputeScoreboardInput): ScoreboardSnapshot {
  const config = LeagueConfigSchema.parse(input.config);
  const teams = z.array(TeamSchema).parse(input.teams);
  const problems = z.array(ProblemSchema).parse(input.problems).sort((a, b) => a.ordinal - b.ordinal);
  const events = z.array(SubmissionEventSchema).parse(input.events);
  const view = ScoreboardViewSchema.parse(input.view);
  const statuses = input.siteStatuses === undefined ? [] : z.array(SiteStatusSchema).parse(input.siteStatuses);
  const now = parseNow(input.now);
  const nowMs = now.getTime();
  const startMs = Date.parse(config.starts_at);
  const endMs = Date.parse(config.ends_at);
  const teamById = uniqueMap(teams, (team) => team.global_team_id, 'team id');
  const problemById = uniqueMap(problems, (problem) => problem.global_problem_id, 'problem id');
  uniqueMap(problems, (problem) => String(problem.ordinal), 'problem ordinal');
  uniqueMap(problems, (problem) => problem.label, 'problem label');

  if (events.some((event) => event.league_id !== config.league_id)) {
    throw new ScoreboardInputError('All events must belong to config.league_id');
  }

  const currentEvents = coalesceSubmissionEvents(events);
  const warnings = siteWarnings(statuses);
  const usableEvents: MappedSubmissionEvent[] = [];
  for (const event of currentEvents) {
    if (!isMappedSubmissionEvent(event)) {
      warnings.push({
        code: 'UNMAPPED_EVENT',
        message: `Submission ${submissionKey(event)} has not been resolved to global IDs.`,
        site_id: event.site_id,
        event_key: submissionKey(event),
      });
      continue;
    }
    const team = teamById.get(event.global_team_id);
    const problem = problemById.get(event.global_problem_id);
    if (team === undefined || problem === undefined || team.site_id !== event.site_id) {
      warnings.push({
        code: 'UNMAPPED_EVENT',
        message: `Submission ${submissionKey(event)} has no matching team/problem mapping.`,
        site_id: event.site_id,
        event_key: submissionKey(event),
      });
      continue;
    }
    const submittedAtMs = Date.parse(event.submitted_at);
    if (submittedAtMs < startMs || submittedAtMs > endMs) {
      warnings.push({
        code: 'OUT_OF_CONTEST_EVENT',
        message: `Submission ${submissionKey(event)} is outside the contest interval.`,
        site_id: event.site_id,
        event_key: submissionKey(event),
      });
      continue;
    }
    if (submittedAtMs <= nowMs) usableEvents.push(event);
  }

  const frozen = isScoreboardFrozen(config, view, now);
  const freezeMs = config.freeze_at === null ? null : Date.parse(config.freeze_at);
  const eventsByTeamProblem = new Map<string, MappedSubmissionEvent[]>();
  for (const event of usableEvents) {
    const key = `${event.global_team_id}/${event.global_problem_id}`;
    const bucket = eventsByTeamProblem.get(key) ?? [];
    bucket.push(event);
    eventsByTeamProblem.set(key, bucket);
  }

  const workingRows: WorkingRow[] = teams.map((team) => {
    const acceptedAtByProblem = new Map<string, number>();
    const problemScores = problems.map((problem) => {
      const key = `${team.global_team_id}/${problem.global_problem_id}`;
      const computed = computeProblemScore(
        problem,
        eventsByTeamProblem.get(key) ?? [],
        startMs,
        config.penalty_seconds,
        frozen,
        freezeMs,
      );
      if (computed.acceptedAtMs !== null) {
        acceptedAtByProblem.set(problem.global_problem_id, computed.acceptedAtMs);
      }
      return computed.score;
    });
    const solved = problemScores.filter((problem) => problem.solved).length;
    const penaltyMinutes = problemScores.reduce((sum, problem) => sum + problem.penalty_minutes, 0);
    const acceptedTimes = [...acceptedAtByProblem.values()];
    const lastSolvedAtMs = acceptedTimes.length === 0 ? null : Math.max(...acceptedTimes);
    return {
      acceptedAtByProblem,
      row: {
        rank: null,
        global_team_id: team.global_team_id,
        name: team.name,
        organization_id: team.organization_id,
        organization_name: team.organization_name,
        site_id: team.site_id,
        is_official: team.is_official,
        solved,
        penalty_minutes: penaltyMinutes,
        last_solved_seconds: lastSolvedAtMs === null ? null : Math.floor((lastSolvedAtMs - startMs) / 1000),
        problems: problemScores,
      },
    };
  });

  for (const problem of problems) {
    const solvers = workingRows
      .flatMap((working) => {
        const acceptedAt = working.acceptedAtByProblem.get(problem.global_problem_id);
        return acceptedAt === undefined ? [] : [{ acceptedAt, working }];
      })
      .sort((a, b) => a.acceptedAt - b.acceptedAt
        || a.working.row.global_team_id.localeCompare(b.working.row.global_team_id, 'en-US'));
    const first = solvers[0];
    if (first !== undefined) {
      const problemScore = first.working.row.problems.find(
        (score) => score.global_problem_id === problem.global_problem_id,
      );
      if (problemScore !== undefined) problemScore.first_to_solve = true;
    }
  }

  const rows = workingRows.map((working) => working.row);
  const officialRanks = rankOfficialTeams(rows);
  for (const row of rows) row.rank = officialRanks.get(row.global_team_id) ?? null;
  rows.sort(comparePerformance);

  return ScoreboardSnapshotSchema.parse({
    protocol_version: PROTOCOL_VERSION,
    league_id: config.league_id,
    view,
    generated_at: now.toISOString(),
    frozen,
    data_complete: warnings.length === 0,
    warnings,
    rows,
  });
}
