import { strToU8, zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import type { HubDatabase, StoredEvent } from './database.js';
import type { ScoreboardSnapshot } from './scoreboard.js';

interface FeedEvent {
  id: string | null;
  type: string;
  data: unknown;
  token: string;
}

const judgementTypes = [
  { id: 'AC', name: 'Accepted', penalty: false, solved: true },
  { id: 'WA', name: 'Wrong Answer', penalty: true, solved: false },
  { id: 'TLE', name: 'Time Limit Exceeded', penalty: true, solved: false },
  { id: 'MLE', name: 'Memory Limit Exceeded', penalty: true, solved: false },
  { id: 'OLE', name: 'Output Limit Exceeded', penalty: true, solved: false },
  { id: 'RTE', name: 'Run-Time Error', penalty: true, solved: false },
  { id: 'CE', name: 'Compile Error', penalty: false, solved: false },
  { id: 'JE', name: 'Judging Error', penalty: false, solved: false },
];

export function contestApiResourceId(value: string, prefix: string): string {
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,35}$/.test(value) && !value.endsWith('.')) return value;
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 20);
  return `${prefix}-${digest}`;
}

function duration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function judgementType(status: string): string {
  const normalized = status.toUpperCase();
  const aliases: Record<string, string> = {
    ACCEPTED: 'AC',
    WRONG_ANSWER: 'WA',
    TIME_LIMIT_EXCEEDED: 'TLE',
    MEMORY_LIMIT_EXCEEDED: 'MLE',
    OUTPUT_LIMIT_EXCEEDED: 'OLE',
    RUNTIME_ERROR: 'RTE',
    COMPILE_ERROR: 'CE',
    SYSTEM_ERROR: 'JE',
    FORMAT_ERROR: 'JE',
    IGNORED: 'JE',
    CANCELED: 'JE',
    JUDGING: 'JE',
    WAITING: 'JE',
  };
  return aliases[normalized] ?? normalized;
}

function contestObject(database: HubDatabase): Record<string, unknown> {
  const contest = database.getContest();
  if (!contest) throw new Error('League configuration is not loaded');
  const startMs = Date.parse(contest.start_time);
  const endMs = Date.parse(contest.end_time);
  return {
    id: contestApiResourceId(contest.contest_id, 'contest'),
    name: contest.name,
    formal_name: contest.name,
    start_time: contest.start_time,
    duration: duration(endMs - startMs),
    scoreboard_freeze_duration: contest.freeze_time
      ? duration(endMs - Date.parse(contest.freeze_time))
      : '0:00:00',
    scoreboard_type: 'pass-fail',
    penalty_time: contest.penalty_minutes ?? 20,
  };
}

function organizations(database: HubDatabase): Array<Record<string, unknown>> {
  const seen = new Map<string, Record<string, unknown>>();
  for (const team of database.getTeams().filter((item) => !item.hidden)) {
    if (!seen.has(team.school_id)) {
      seen.set(team.school_id, {
        id: contestApiResourceId(team.school_id, 'org'),
        name: team.school_name ?? team.school_id,
        formal_name: team.school_name ?? team.school_id,
      });
    }
  }
  return [...seen.values()];
}

function groups(): Array<Record<string, unknown>> {
  return [
    { id: 'official', name: 'Official', type: 'eligibility' },
    { id: 'unofficial', name: 'Unofficial', type: 'eligibility' },
  ];
}

function teams(database: HubDatabase): Array<Record<string, unknown>> {
  return database.getTeams().filter((team) => !team.hidden).map((team) => ({
    id: contestApiResourceId(team.team_id, 'team'),
    name: team.name,
    display_name: team.name,
    organization_id: contestApiResourceId(team.school_id, 'org'),
    group_ids: [team.official === false ? 'unofficial' : 'official'],
  }));
}

function problems(database: HubDatabase): Array<Record<string, unknown>> {
  return database.getProblems().map((problem, index) => ({
    id: contestApiResourceId(problem.problem_id, 'problem'),
    label: problem.label,
    name: problem.name,
    ordinal: problem.ordinal ?? index,
    ...(problem.color ? { color: problem.color } : {}),
    ...(problem.rgb ? { rgb: problem.rgb } : {}),
  }));
}

function eligibleEvents(database: HubDatabase, generatedAt?: string): StoredEvent[] {
  const contest = database.getContest();
  if (!contest) return [];
  const startMs = Date.parse(contest.start_time);
  const visibleThroughMs = Math.min(
    Date.parse(contest.end_time),
    generatedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(generatedAt),
  );
  const visibleTeamIds = new Set(database.getTeams().filter((team) => !team.hidden).map((team) => team.team_id));
  return database.getEvents(contest.contest_id).filter((event) => {
    const submittedAtMs = Date.parse(event.submitted_at ?? event.occurred_at);
    return event.team_id && visibleTeamIds.has(event.team_id) && event.problem_id
      && submittedAtMs >= startMs
      && submittedAtMs <= visibleThroughMs;
  });
}

function submissions(database: HubDatabase, generatedAt: string): Array<Record<string, unknown>> {
  const contest = database.getContest();
  if (!contest) return [];
  const startMs = Date.parse(contest.start_time);
  return eligibleEvents(database, generatedAt).map((event) => {
    const time = event.submitted_at ?? event.occurred_at;
    const contestTime = event.contest_time_ms ?? Math.max(0, Date.parse(time) - startMs);
    return {
      id: event.event_id,
      language_id: contestApiResourceId(event.language ?? 'unknown', 'lang'),
      problem_id: contestApiResourceId(event.problem_id!, 'problem'),
      team_id: contestApiResourceId(event.team_id!, 'team'),
      time,
      contest_time: duration(contestTime),
    };
  });
}

function judgements(database: HubDatabase, generatedAt: string): Array<Record<string, unknown>> {
  const contest = database.getContest();
  if (!contest) return [];
  const startMs = Date.parse(contest.start_time);
  return eligibleEvents(database, generatedAt)
    .filter((event) => !['PENDING', 'JUDGING'].includes(event.status.toUpperCase()))
    .map((event) => {
    const submissionTime = event.submitted_at ?? event.occurred_at;
    const judgedTime = event.judged_at ?? event.occurred_at;
    const submissionContestMs = event.contest_time_ms ?? Math.max(0, Date.parse(submissionTime) - startMs);
    const judgedContestMs = Math.max(submissionContestMs, Date.parse(judgedTime) - startMs);
    return {
      id: `j-${event.event_id}`,
      submission_id: event.event_id,
      judgement_type_id: judgementType(event.status),
      start_time: submissionTime,
      start_contest_time: duration(submissionContestMs),
      end_time: judgedTime,
      end_contest_time: duration(judgedContestMs),
    };
  });
}

function runs(database: HubDatabase): Array<Record<string, unknown>> {
  // Hydro's record event has no per-testcase data. An empty runs collection is
  // truthful and valid; fabricating a run would corrupt Resolver semantics.
  void database;
  return [];
}

type ScoreboardRow = ScoreboardSnapshot['rows'][number];

function sameRankScore(left: ScoreboardRow, right: ScoreboardRow): boolean {
  return left.solved === right.solved
    && left.penalty_minutes === right.penalty_minutes
    && left.last_solve_time_ms === right.last_solve_time_ms;
}

function rankCohort(rows: ScoreboardRow[], offset: number): Array<{ row: ScoreboardRow; rank: number }> {
  let rank = offset + 1;
  return rows.map((row, index) => {
    if (index === 0 || !sameRankScore(row, rows[index - 1]!)) rank = offset + index + 1;
    return { row, rank };
  });
}

function scoreboardRows(snapshot: ScoreboardSnapshot): Array<Record<string, unknown>> {
  const official = snapshot.rows.filter((row) => row.team.official !== false);
  const unofficial = snapshot.rows.filter((row) => row.team.official === false);
  const ranked = [
    ...rankCohort(official, 0),
    ...rankCohort(unofficial, official.length),
  ];
  return ranked.map(({ row, rank }) => ({
    rank,
    team_id: contestApiResourceId(row.team.team_id, 'team'),
    score: {
      num_solved: row.solved,
      total_time: row.penalty_minutes,
      time: row.last_solve_time_ms === null ? null : Math.floor(row.last_solve_time_ms / 60_000),
    },
    problems: row.problems.map((problem) => ({
      problem_id: contestApiResourceId(problem.problem_id, 'problem'),
      num_judged: problem.num_judged,
      num_pending: problem.pending,
      solved: problem.solved,
      ...(problem.solve_time_ms === null ? {} : { time: Math.floor(problem.solve_time_ms / 60_000) }),
    })),
  }));
}

function contestState(database: HubDatabase, generatedAt: string, markFinal = false): Record<string, string | null> {
  const contest = database.getContest();
  if (!contest) throw new Error('League configuration is not loaded');
  const now = Date.parse(generatedAt);
  const started = now >= Date.parse(contest.start_time) ? contest.start_time : null;
  const frozen = contest.freeze_time && now >= Date.parse(contest.freeze_time) ? contest.freeze_time : null;
  const ended = started && now >= Date.parse(contest.end_time) ? contest.end_time : null;
  const thawed = frozen && contest.unfreeze_at && now >= Date.parse(contest.unfreeze_at)
    ? contest.unfreeze_at
    : null;
  const persistedFinalizedAt = database.getContestFinalizedAt(contest.contest_id);
  const finalizationTime = new Date(Math.max(Date.parse(generatedAt), Date.parse(contest.end_time) + 1)).toISOString();
  const finalized = ended
    ? persistedFinalizedAt ?? (markFinal ? finalizationTime : null)
    : null;
  const effectiveThawed = thawed ?? (frozen && finalized ? finalized : null);
  const endOfUpdates = finalized && (!frozen || effectiveThawed)
    ? new Date(Math.max(Date.parse(finalized), Date.parse(effectiveThawed ?? finalized)) + 1).toISOString()
    : null;
  return { started, frozen, ended, thawed: effectiveThawed, finalized, end_of_updates: endOfUpdates };
}

export function buildContestApiResources(database: HubDatabase, scoreboard: ScoreboardSnapshot, markFinal = false) {
  const state = contestState(database, scoreboard.generated_at, markFinal);
  const contest = database.getContest();
  if (!contest) throw new Error('League configuration is not loaded');
  const effectiveGeneratedAt = state.finalized ?? scoreboard.generated_at;
  const contestTimeMs = Math.max(0, Date.parse(effectiveGeneratedAt) - Date.parse(contest.start_time));
  return {
    contests: [contestObject(database)],
    judgement_types: judgementTypes,
    languages: [...new Set(eligibleEvents(database, effectiveGeneratedAt).map((event) => event.language ?? 'unknown'))]
      .map((name) => ({ id: contestApiResourceId(name, 'lang'), name })),
    groups: groups(),
    organizations: organizations(database),
    teams: teams(database),
    problems: problems(database),
    submissions: submissions(database, effectiveGeneratedAt),
    judgements: judgements(database, effectiveGeneratedAt),
    runs: runs(database),
    state,
    scoreboard: {
      time: effectiveGeneratedAt,
      contest_time: duration(contestTimeMs),
      state,
      rows: scoreboardRows(scoreboard),
    },
  };
}

export function buildEventFeed(
  database: HubDatabase,
  scoreboard: ScoreboardSnapshot,
  markFinal = false,
  afterToken = 0,
): FeedEvent[] {
  const resources = buildContestApiResources(database, scoreboard, markFinal);
  const current: Array<Omit<FeedEvent, 'token'>> = [];
  const add = (type: string, data: Record<string, unknown>, id: string | null = String(data.id)): void => {
    current.push({ id, type, data });
  };
  for (const contest of resources.contests) add('contest', contest, null);
  if (!markFinal) add('state', resources.state, null);
  for (const item of resources.judgement_types) add('judgement-types', item);
  for (const item of resources.languages) add('languages', item);
  for (const item of resources.groups) add('groups', item);
  for (const item of resources.organizations) add('organizations', item);
  for (const item of resources.teams) add('teams', item);
  for (const item of resources.problems) add('problems', item);
  for (const item of resources.submissions) add('submissions', item);
  for (const item of resources.judgements) add('judgements', item);
  for (const item of resources.runs) add('runs', item);
  if (markFinal) add('state', resources.state, null);
  if (markFinal) {
    const finalizedAt = resources.state.finalized;
    const contest = database.getContest();
    if (typeof finalizedAt !== 'string') throw new Error('Contest cannot be finalized before it has ended');
    if (!contest) throw new Error('League configuration is not loaded');
    database.finalizeContestAtomically({
      contestId: contest.contest_id,
      finalizedAt,
      notificationCreatedAt: scoreboard.generated_at,
      notifications: current,
    });
  } else {
    database.synchronizeContestNotifications(current, scoreboard.generated_at);
  }
  return database.getContestNotifications(afterToken).map((notification) => ({
    ...notification,
    token: String(notification.token),
  }));
}

export function buildCdpZip(database: HubDatabase, scoreboard: ScoreboardSnapshot): Uint8Array {
  const contest = database.getContest();
  if (!contest) throw new Error('League configuration is not loaded');
  if (!database.getContestFinalizedAt(contest.contest_id)) throw new Error('Contest is not finalized');
  const resources = buildContestApiResources(database, scoreboard);
  const notifications = database.getContestNotifications(0).map((notification) => ({
    ...notification,
    token: String(notification.token),
  }));
  const terminal = notifications.at(-1);
  const terminalData = terminal?.data && typeof terminal.data === 'object' && !Array.isArray(terminal.data)
    ? terminal.data as Record<string, unknown>
    : null;
  if (terminal?.type !== 'state' || !terminalData?.end_of_updates) {
    throw new Error('Finalized contest feed has no terminal end_of_updates state');
  }
  const feed = notifications.map((event) => JSON.stringify(event)).join('\n') + '\n';
  const readme = [
    'Hydro League Sync - ICPC Contest Data Package',
    '',
    'event-feed.ndjson contains one ICPC Contest API 2023-06 notification per line.',
    'All files follow the ICPC Contest Package endpoint filename convention.',
    'Official Resolver run: resolver.bat/sh <this-folder> --groups ^official$',
    'The eligibility group is a filter label; group type alone does not exclude unofficial teams.',
    'Unofficial teams and submissions remain in this package for audit and separate display.',
    `Generated at ${scoreboard.generated_at}`,
    '',
  ].join('\n');
  const api = {
    version: '2023-06',
    version_url: 'https://ccs-specs.icpc.io/2023-06/contest_api',
    provider: { name: 'Hydro League Hub', version: '0.1.0' },
  };
  const contestYaml = Object.entries(resources.contests[0] ?? {})
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n') + '\n';
  const files: Record<string, Uint8Array> = {
    'README.txt': strToU8(readme),
    'api.json': strToU8(JSON.stringify(api, null, 2) + '\n'),
    'contest.json': strToU8(JSON.stringify(resources.contests[0], null, 2) + '\n'),
    'contest.yaml': strToU8(contestYaml),
    'problems.json': strToU8(JSON.stringify(resources.problems, null, 2) + '\n'),
    'problems.yaml': strToU8(JSON.stringify(resources.problems, null, 2) + '\n'),
    'judgement-types.json': strToU8(JSON.stringify(resources.judgement_types, null, 2) + '\n'),
    'languages.json': strToU8(JSON.stringify(resources.languages, null, 2) + '\n'),
    'groups.json': strToU8(JSON.stringify(resources.groups, null, 2) + '\n'),
    'organizations.json': strToU8(JSON.stringify(resources.organizations, null, 2) + '\n'),
    'teams.json': strToU8(JSON.stringify(resources.teams, null, 2) + '\n'),
    'submissions.json': strToU8(JSON.stringify(resources.submissions, null, 2) + '\n'),
    'judgements.json': strToU8(JSON.stringify(resources.judgements, null, 2) + '\n'),
    'runs.json': strToU8(JSON.stringify(resources.runs, null, 2) + '\n'),
    'state.json': strToU8(JSON.stringify(resources.state, null, 2) + '\n'),
    'scoreboard.json': strToU8(JSON.stringify(resources.scoreboard, null, 2) + '\n'),
    'event-feed.ndjson': strToU8(feed),
  };
  return zipSync(files, { level: 6 });
}
