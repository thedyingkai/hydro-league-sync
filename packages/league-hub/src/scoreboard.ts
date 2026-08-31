import type { ResolvedHubOptions } from './config.js';
import type { HubDatabase, StoredEvent, StoredSite } from './database.js';
import type { HubProblem, HubTeam, SiteStatus } from './types.js';
import {
  CanonicalStatusSchema,
  isAcceptedStatus,
  isPenaltyStatus,
} from '@hydro-league-sync/protocol';

export interface SiteStatusView {
  site_id: string;
  name: string;
  school_name?: string;
  status: SiteStatus;
  last_seen_at: string | null;
  last_event_at: string | null;
  age_ms: number | null;
  unmapped_count: number;
  pending_events: number;
  rejected_events: number;
  last_acked_source_seq: number | null;
  hub_high_watermark: number;
  watermark_consistent: boolean;
  agent_version: string | null;
  hydro_version: string | null;
}

interface ProblemScore {
  problem_id: string;
  solved: boolean;
  status: 'UNATTEMPTED' | 'PENDING' | 'WRONG' | 'SOLVED';
  attempts: number;
  num_judged: number;
  pending: number;
  solve_time_ms: number | null;
  first_to_solve: boolean;
}

interface ScoreRow {
  rank: number | null;
  team: HubTeam;
  solved: number;
  penalty_minutes: number;
  last_solve_time_ms: number | null;
  problems: ProblemScore[];
}

export interface ScoreboardSnapshot {
  contest: NonNullable<ReturnType<HubDatabase['getContest']>>;
  view: 'public' | 'jury';
  generated_at: string;
  cursor: number;
  frozen: boolean;
  freeze_time: string | null;
  accuracy: {
    complete: boolean;
    message: string | null;
    affected_sites: SiteStatusView[];
  };
  sites: SiteStatusView[];
  problems: HubProblem[];
  rows: ScoreRow[];
  diagnostics?: {
    unmapped_events: number;
    out_of_contest_events: number;
  };
}

function eventTimeMs(event: StoredEvent, contestStartMs: number): number {
  if (event.contest_time_ms !== undefined) return Math.max(0, event.contest_time_ms);
  return Math.max(0, Date.parse(event.submitted_at ?? event.occurred_at) - contestStartMs);
}

function visibleEvents(
  events: StoredEvent[],
  view: 'public' | 'jury',
  freezeMs: number | null,
  frozen: boolean,
  contestStartMs: number,
): { scoring: StoredEvent[]; pending: number } {
  if (view === 'jury' || !frozen || freezeMs === null) return { scoring: events, pending: 0 };
  const scoring: StoredEvent[] = [];
  let pending = 0;
  for (const event of events) {
    const absoluteTime = contestStartMs + eventTimeMs(event, contestStartMs);
    if (absoluteTime < freezeMs) scoring.push(event);
    else pending += 1;
  }
  return { scoring, pending };
}

function scoreProblem(
  problem: HubProblem,
  events: StoredEvent[],
  view: 'public' | 'jury',
  freezeMs: number | null,
  frozen: boolean,
  contestStartMs: number,
): ProblemScore {
  const ordered = [...events].sort((left, right) => {
    const delta = eventTimeMs(left, contestStartMs) - eventTimeMs(right, contestStartMs);
    return delta || left.source_seq - right.source_seq;
  });
  const visible = visibleEvents(ordered, view, freezeMs, frozen, contestStartMs);
  let attempts = 0;
  let numJudged = 0;
  let pending = 0;
  let solveTimeMs: number | null = null;
  for (const event of visible.scoring) {
    const normalized = CanonicalStatusSchema.safeParse(event.status.toUpperCase());
    if (!normalized.success) continue;
    if (['PENDING', 'JUDGING'].includes(normalized.data)) {
      pending += 1;
      continue;
    }
    numJudged += 1;
    if (isAcceptedStatus(normalized.data)) {
      solveTimeMs = eventTimeMs(event, contestStartMs);
      break;
    }
    if (isPenaltyStatus(normalized.data)) attempts += 1;
  }
  const solved = solveTimeMs !== null;
  if (solved) pending = 0;
  else pending += visible.pending;
  const status = solved
    ? 'SOLVED'
    : pending > 0
      ? 'PENDING'
      : attempts > 0
        ? 'WRONG'
        : 'UNATTEMPTED';
  return {
    problem_id: problem.problem_id,
    solved,
    status,
    attempts,
    num_judged: numJudged,
    pending,
    solve_time_ms: solveTimeMs,
    first_to_solve: false,
  };
}

function compareRows(left: ScoreRow, right: ScoreRow): number {
  return right.solved - left.solved
    || left.penalty_minutes - right.penalty_minutes
    || (left.last_solve_time_ms ?? Number.MAX_SAFE_INTEGER) - (right.last_solve_time_ms ?? Number.MAX_SAFE_INTEGER)
    || left.team.name.localeCompare(right.team.name, 'zh-CN')
    || left.team.team_id.localeCompare(right.team.team_id);
}

export function calculateSiteStatuses(
  sites: StoredSite[],
  now: Date,
  options: Pick<ResolvedHubOptions, 'delayedAfterMs' | 'offlineAfterMs'>,
): SiteStatusView[] {
  return sites.filter((site) => site.enabled).map((site) => {
    const lastSeen = site.last_heartbeat_at ?? site.last_event_at;
    const ageMs = lastSeen ? Math.max(0, now.getTime() - Date.parse(lastSeen)) : null;
    let status: SiteStatus = 'OFFLINE';
    if (ageMs !== null && ageMs <= options.delayedAfterMs) status = 'ONLINE';
    else if (ageMs !== null && ageMs <= options.offlineAfterMs) status = 'DELAYED';
    return {
      site_id: site.site_id,
      name: site.name,
      ...(site.school_name ? { school_name: site.school_name } : {}),
      status,
      last_seen_at: lastSeen,
      last_event_at: site.last_event_at,
      age_ms: ageMs,
      unmapped_count: 0,
      pending_events: site.pending_events,
      rejected_events: site.rejected_events,
      last_acked_source_seq: site.last_acked_source_seq,
      hub_high_watermark: 0,
      watermark_consistent: true,
      agent_version: site.agent_version,
      hydro_version: site.hydro_version,
    };
  });
}

export function buildScoreboard(
  database: HubDatabase,
  view: 'public' | 'jury',
  options: ResolvedHubOptions,
): ScoreboardSnapshot | null {
  const contest = database.getContest();
  if (!contest) return null;
  const now = options.now();
  const nowMs = now.getTime();
  const startMs = Date.parse(contest.start_time);
  const endMs = Date.parse(contest.end_time);
  const freezeMs = contest.freeze_time ? Date.parse(contest.freeze_time) : null;
  const publishedAt = database.getContestPublishedAt(contest.contest_id);
  const unfreezeAt = publishedAt ?? contest.unfreeze_at;
  const frozen = view === 'public'
    && freezeMs !== null
    && nowMs >= freezeMs
    && (unfreezeAt === null || unfreezeAt === undefined || nowMs < Date.parse(unfreezeAt));
  const sites = calculateSiteStatuses(database.getSites(), now, options);
  const allContestEvents = database.getEvents(contest.contest_id);
  for (const site of sites) {
    site.unmapped_count = allContestEvents.filter((event) => event.site_id === site.site_id && event.quarantine_reason).length;
    site.hub_high_watermark = database.highWatermark(site.site_id, contest.contest_id);
    site.watermark_consistent = site.last_acked_source_seq === null
      ? site.hub_high_watermark === 0
      : site.last_acked_source_seq === site.hub_high_watermark;
  }
  const affectedSites = sites.filter((site) => (
    site.status !== 'ONLINE' || site.pending_events > 0 || site.rejected_events > 0
      || site.unmapped_count > 0 || !site.watermark_consistent
  ));
  const problems = database.getProblems();
  const mappedEvents = allContestEvents.filter((event) => event.team_id && event.problem_id);
  const events = mappedEvents.filter((event) => {
    const submittedAt = Date.parse(event.submitted_at);
    return submittedAt >= startMs && submittedAt <= endMs && submittedAt <= nowMs;
  });

  const rows: ScoreRow[] = database.getTeams()
    .filter((team) => !team.hidden)
    .map((team) => {
      const problemScores = problems.map((problem) => scoreProblem(
        problem,
        events.filter((event) => event.team_id === team.team_id && event.problem_id === problem.problem_id),
        view,
        freezeMs,
        frozen,
        startMs,
      ));
      const solvedScores = problemScores.filter((score) => score.solved);
      const penaltyMinutes = solvedScores.reduce((sum, score) => {
        const solveMinutes = Math.floor((score.solve_time_ms ?? 0) / 60_000);
        return sum + solveMinutes + score.attempts * (contest.penalty_minutes ?? 20);
      }, 0);
      return {
        rank: null,
        team,
        solved: solvedScores.length,
        penalty_minutes: penaltyMinutes,
        last_solve_time_ms: solvedScores.length
          ? Math.max(...solvedScores.map((score) => score.solve_time_ms ?? 0))
          : null,
        problems: problemScores,
      };
    });

  const firstSolveByProblem = new Map<string, number>();
  for (const row of rows) {
    for (const problem of row.problems) {
      if (!problem.solved || problem.solve_time_ms === null) continue;
      const previous = firstSolveByProblem.get(problem.problem_id);
      if (previous === undefined || problem.solve_time_ms < previous) {
        firstSolveByProblem.set(problem.problem_id, problem.solve_time_ms);
      }
    }
  }
  for (const row of rows) {
    for (const problem of row.problems) {
      problem.first_to_solve = problem.solved
        && problem.solve_time_ms === firstSolveByProblem.get(problem.problem_id);
    }
  }

  rows.sort(compareRows);
  let officialRank = 0;
  let officialPosition = 0;
  let previousOfficial: ScoreRow | null = null;
  rows.forEach((row) => {
    if (row.team.official === false) {
      row.rank = null;
      return;
    }
    officialPosition += 1;
    const tied = previousOfficial
      && row.solved === previousOfficial.solved
      && row.penalty_minutes === previousOfficial.penalty_minutes
      && row.last_solve_time_ms === previousOfficial.last_solve_time_ms;
    if (!tied) officialRank = officialPosition;
    row.rank = officialRank;
    previousOfficial = row;
  });

  const connectionWarnings = affectedSites.flatMap((site) => {
    const name = site.school_name ?? site.name;
    const warnings: string[] = [];
    if (site.status !== 'ONLINE') warnings.push(`${name}${site.status === 'OFFLINE' ? '已断开连接' : '同步延迟'}`);
    if (site.pending_events > 0) warnings.push(`${name}同步积压 ${site.pending_events} 条`);
    if (site.rejected_events > 0) warnings.push(`${name}存在 ${site.rejected_events} 条拒绝事件`);
    if (site.unmapped_count > 0) warnings.push(`${name}存在 ${site.unmapped_count} 条未映射事件`);
    if (!site.watermark_consistent) {
      warnings.push(`${name}确认水位 ${site.last_acked_source_seq ?? '无'} 与中心 ${site.hub_high_watermark} 不一致`);
    }
    return warnings;
  });
  return {
    contest,
    view,
    generated_at: now.toISOString(),
    cursor: database.latestCursor(),
    frozen,
    freeze_time: contest.freeze_time ?? null,
    accuracy: {
      complete: affectedSites.length === 0,
      message: affectedSites.length
        ? `${connectionWarnings.join('；')}；当前名次可能不完整`
        : null,
      affected_sites: affectedSites,
    },
    sites,
    problems,
    rows,
    ...(view === 'jury'
      ? { diagnostics: {
        unmapped_events: allContestEvents.filter((event) => event.quarantine_reason).length,
        out_of_contest_events: mappedEvents.length - events.length,
      } }
      : {}),
  };
}
