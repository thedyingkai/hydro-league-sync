import type {
  BoardView,
  ScoreboardResponse,
  SubmissionFeedResponse,
  XcpcioAllInOneResponse,
} from './types.js';

const STATUS_VALUES = new Set([
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
  'FROZEN',
]);

const SITE_STATES = new Set(['ONLINE', 'DELAYED', 'OFFLINE']);
const PROBLEM_STATES = new Set(['UNATTEMPTED', 'PENDING', 'WRONG', 'SOLVED']);
const XCPCIO_STATUSES = new Set([
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

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${name} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
  name: string,
): void {
  const missing = required.find((key) => !Object.hasOwn(value, key));
  if (missing) throw new TypeError(`${name} is missing ${missing}`);
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  if (unknown) throw new TypeError(`${name} contains unknown field ${unknown}`);
}

function text(value: unknown, name: string, maximum = 500): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function string(value: unknown, name: string, maximum = 500): string {
  if (typeof value !== 'string' || value.length > maximum) {
    throw new TypeError(`${name} must be a string no longer than ${maximum} characters`);
  }
  return value;
}

function nullableText(value: unknown, name: string, maximum = 500): string | null {
  return value === null ? null : text(value, name, maximum);
}

function integer(value: unknown, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value as number;
}

function finite(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`${name} must be a finite number greater than or equal to ${minimum}`);
  }
  return value;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`);
  return value;
}

function dateTime(value: unknown, name: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${name} must be an ISO date-time`);
  }
  return value;
}

function nullableDateTime(value: unknown, name: string): string | null {
  return value === null ? null : dateTime(value, name);
}

function array(value: unknown, name: string, maximum = 100_000): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new TypeError(`${name} must be an array`);
  return value;
}

const BADGE_URL_FORBIDDEN_CHARACTERS = /[\p{Cc}\\]/u;

function repeatedlyDecodeBadgeUrl(value: string): string | undefined {
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

function decodedBadgePathIsSafe(path: string): boolean {
  const decoded = repeatedlyDecodeBadgeUrl(path);
  if (decoded === undefined) return false;
  if (BADGE_URL_FORBIDDEN_CHARACTERS.test(decoded) || decoded.includes('//')) return false;
  return !decoded.split('/').some((segment) => segment === '..');
}

function badgeUrl(value: unknown, name: string): string {
  const urlText = string(value, name, 2_048);
  const decoded = repeatedlyDecodeBadgeUrl(urlText);
  if (!urlText || decoded === undefined || BADGE_URL_FORBIDDEN_CHARACTERS.test(decoded)) {
    throw new TypeError(`${name} must be credential-free HTTP(S) or a safe root-relative path`);
  }
  if (urlText.startsWith('/')) {
    if (!urlText.startsWith('//') && decodedBadgePathIsSafe(urlText.split(/[?#]/u, 1)[0]!)) return urlText;
    throw new TypeError(`${name} must be credential-free HTTP(S) or a safe root-relative path`);
  }

  const match = urlText.match(/^https?:\/\/([^/?#]+)(\/[^?#]*)?(?:[?#].*)?$/iu);
  if (match && !match[1]!.includes('@') && decodedBadgePathIsSafe(match[2] ?? '/')) {
    try {
      const parsed = new URL(urlText);
      if (['http:', 'https:'].includes(parsed.protocol) && parsed.hostname && !parsed.username && !parsed.password) {
        return urlText;
      }
    } catch {
      // The common error below deliberately avoids reflecting URL contents.
    }
  }
  throw new TypeError(`${name} must be credential-free HTTP(S) or a safe root-relative path`);
}

const SITE_KEYS = [
  'site_id',
  'name',
  'school_name',
  'status',
  'last_seen_at',
  'last_event_at',
  'age_ms',
  'unmapped_count',
  'pending_events',
  'rejected_events',
  'last_acked_source_seq',
  'hub_high_watermark',
  'watermark_consistent',
  'agent_version',
  'hydro_version',
] as const;

function validateSite(input: unknown, name: string): Record<string, unknown> {
  const site = record(input, name);
  keys(site, ['site_id', 'name', 'status', 'last_seen_at', 'last_event_at', 'age_ms', 'unmapped_count'], SITE_KEYS, name);
  text(site.site_id, `${name}.site_id`, 128);
  text(site.name, `${name}.name`, 200);
  if (site.school_name !== undefined) text(site.school_name, `${name}.school_name`, 200);
  if (typeof site.status !== 'string' || !SITE_STATES.has(site.status)) throw new TypeError(`${name}.status is invalid`);
  nullableDateTime(site.last_seen_at, `${name}.last_seen_at`);
  nullableDateTime(site.last_event_at, `${name}.last_event_at`);
  if (site.age_ms !== null) integer(site.age_ms, `${name}.age_ms`);
  integer(site.unmapped_count, `${name}.unmapped_count`);
  integer(site.pending_events, `${name}.pending_events`);
  integer(site.rejected_events, `${name}.rejected_events`);
  if (site.last_acked_source_seq !== null) integer(site.last_acked_source_seq, `${name}.last_acked_source_seq`);
  integer(site.hub_high_watermark, `${name}.hub_high_watermark`);
  boolean(site.watermark_consistent, `${name}.watermark_consistent`);
  if (site.agent_version !== null) text(site.agent_version, `${name}.agent_version`, 128);
  if (site.hydro_version !== null) text(site.hydro_version, `${name}.hydro_version`, 128);
  return site;
}

function validateContest(input: unknown): void {
  const contest = record(input, 'scoreboard.contest');
  keys(
    contest,
    ['contest_id', 'name', 'start_time', 'end_time'],
    ['contest_id', 'name', 'start_time', 'end_time', 'freeze_time', 'unfreeze_at', 'penalty_minutes'],
    'scoreboard.contest',
  );
  text(contest.contest_id, 'scoreboard.contest.contest_id', 128);
  text(contest.name, 'scoreboard.contest.name', 200);
  dateTime(contest.start_time, 'scoreboard.contest.start_time');
  dateTime(contest.end_time, 'scoreboard.contest.end_time');
  if (contest.freeze_time !== undefined) nullableDateTime(contest.freeze_time, 'scoreboard.contest.freeze_time');
  if (contest.unfreeze_at !== undefined) nullableDateTime(contest.unfreeze_at, 'scoreboard.contest.unfreeze_at');
  if (contest.penalty_minutes !== undefined) integer(contest.penalty_minutes, 'scoreboard.contest.penalty_minutes');
}

function validateProblem(input: unknown, index: number): string {
  const name = `scoreboard.problems[${index}]`;
  const problem = record(input, name);
  keys(problem, ['problem_id', 'label', 'name'], ['problem_id', 'label', 'name', 'ordinal', 'color', 'rgb'], name);
  const problemId = text(problem.problem_id, `${name}.problem_id`, 128);
  text(problem.label, `${name}.label`, 16);
  text(problem.name, `${name}.name`, 200);
  if (problem.ordinal !== undefined) integer(problem.ordinal, `${name}.ordinal`);
  if (problem.color !== undefined && problem.color !== null) text(problem.color, `${name}.color`, 64);
  if (problem.rgb !== undefined && problem.rgb !== null) text(problem.rgb, `${name}.rgb`, 64);
  return problemId;
}

function validateTeam(input: unknown, name: string): string {
  const team = record(input, name);
  keys(team, ['team_id', 'name', 'school_id'], ['team_id', 'name', 'school_id', 'school_name', 'official', 'hidden'], name);
  const teamId = text(team.team_id, `${name}.team_id`, 128);
  text(team.name, `${name}.name`, 200);
  text(team.school_id, `${name}.school_id`, 128);
  if (team.school_name !== undefined) text(team.school_name, `${name}.school_name`, 200);
  if (team.official !== undefined) boolean(team.official, `${name}.official`);
  if (team.hidden !== undefined) boolean(team.hidden, `${name}.hidden`);
  return teamId;
}

function validateScoreRow(input: unknown, index: number, problemIds: ReadonlySet<string>): string {
  const name = `scoreboard.rows[${index}]`;
  const row = record(input, name);
  keys(row, ['rank', 'team', 'solved', 'penalty_minutes', 'last_solve_time_ms', 'problems'], [
    'rank', 'team', 'solved', 'penalty_minutes', 'last_solve_time_ms', 'problems',
  ], name);
  if (row.rank !== null) integer(row.rank, `${name}.rank`, 1);
  const teamId = validateTeam(row.team, `${name}.team`);
  integer(row.solved, `${name}.solved`);
  integer(row.penalty_minutes, `${name}.penalty_minutes`);
  if (row.last_solve_time_ms !== null) finite(row.last_solve_time_ms, `${name}.last_solve_time_ms`);
  const scores = array(row.problems, `${name}.problems`, 10_000);
  const seen = new Set<string>();
  scores.forEach((inputScore, scoreIndex) => {
    const scoreName = `${name}.problems[${scoreIndex}]`;
    const score = record(inputScore, scoreName);
    keys(score, ['problem_id', 'solved', 'status', 'attempts', 'num_judged', 'pending', 'solve_time_ms', 'first_to_solve'], [
      'problem_id', 'solved', 'status', 'attempts', 'num_judged', 'pending', 'solve_time_ms', 'first_to_solve',
    ], scoreName);
    const problemId = text(score.problem_id, `${scoreName}.problem_id`, 128);
    if (!problemIds.has(problemId) || seen.has(problemId)) throw new TypeError(`${scoreName}.problem_id is unknown or duplicated`);
    seen.add(problemId);
    boolean(score.solved, `${scoreName}.solved`);
    if (typeof score.status !== 'string' || !PROBLEM_STATES.has(score.status)) throw new TypeError(`${scoreName}.status is invalid`);
    integer(score.attempts, `${scoreName}.attempts`);
    integer(score.num_judged, `${scoreName}.num_judged`);
    integer(score.pending, `${scoreName}.pending`);
    if (score.solve_time_ms !== null) finite(score.solve_time_ms, `${scoreName}.solve_time_ms`);
    boolean(score.first_to_solve, `${scoreName}.first_to_solve`);
  });
  if (seen.size !== problemIds.size) throw new TypeError(`${name}.problems does not match scoreboard.problems`);
  return teamId;
}

function validateFlatTeam(input: unknown, index: number): string {
  const name = `scoreboard.teams[${index}]`;
  const team = record(input, name);
  keys(team, ['rank', 'team_id', 'name', 'school', 'official', 'solved', 'penalty', 'problems'], [
    'rank', 'team_id', 'name', 'school', 'official', 'solved', 'penalty', 'problems',
  ], name);
  if (team.rank !== null) integer(team.rank, `${name}.rank`, 1);
  const teamId = text(team.team_id, `${name}.team_id`, 128);
  text(team.name, `${name}.name`, 200);
  text(team.school, `${name}.school`, 200);
  boolean(team.official, `${name}.official`);
  integer(team.solved, `${name}.solved`);
  integer(team.penalty, `${name}.penalty`);
  const problems = record(team.problems, `${name}.problems`);
  Object.entries(problems).forEach(([label, inputState]) => {
    text(label, `${name}.problem label`, 128);
    const stateName = `${name}.problems.${label}`;
    const state = record(inputState, stateName);
    keys(state, ['attempts', 'pending', 'solved', 'time', 'frozen', 'first_to_solve'], [
      'attempts', 'pending', 'solved', 'time', 'frozen', 'first_to_solve',
    ], stateName);
    integer(state.attempts, `${stateName}.attempts`);
    integer(state.pending, `${stateName}.pending`);
    boolean(state.solved, `${stateName}.solved`);
    if (state.time !== null) finite(state.time, `${stateName}.time`);
    boolean(state.frozen, `${stateName}.frozen`);
    boolean(state.first_to_solve, `${stateName}.first_to_solve`);
  });
  return teamId;
}

export function parseScoreboardResponse(value: unknown, expectedView: BoardView): ScoreboardResponse {
  const board = record(value, 'scoreboard');
  keys(board, [
    'contest', 'view', 'generated_at', 'cursor', 'frozen', 'freeze_time', 'accuracy', 'sites', 'problems', 'rows', 'teams',
  ], [
    'contest', 'view', 'generated_at', 'cursor', 'frozen', 'freeze_time', 'accuracy', 'sites', 'problems', 'rows', 'teams', 'diagnostics',
  ], 'scoreboard');
  if (board.view !== expectedView) throw new TypeError(`scoreboard.view must be ${expectedView}`);
  validateContest(board.contest);
  dateTime(board.generated_at, 'scoreboard.generated_at');
  integer(board.cursor, 'scoreboard.cursor');
  boolean(board.frozen, 'scoreboard.frozen');
  nullableDateTime(board.freeze_time, 'scoreboard.freeze_time');

  const sites = array(board.sites, 'scoreboard.sites', 10_000).map((site, index) => validateSite(site, `scoreboard.sites[${index}]`));
  const siteIds = new Set(sites.map((site) => String(site.site_id)));
  const accuracy = record(board.accuracy, 'scoreboard.accuracy');
  keys(accuracy, ['complete', 'message', 'affected_sites'], ['complete', 'message', 'affected_sites'], 'scoreboard.accuracy');
  boolean(accuracy.complete, 'scoreboard.accuracy.complete');
  if (accuracy.message !== null) text(accuracy.message, 'scoreboard.accuracy.message', 500);
  array(accuracy.affected_sites, 'scoreboard.accuracy.affected_sites', 10_000).forEach((site, index) => {
    const parsed = validateSite(site, `scoreboard.accuracy.affected_sites[${index}]`);
    if (!siteIds.has(String(parsed.site_id))) throw new TypeError('scoreboard affected site is not in sites');
  });

  const problemIds = new Set(array(board.problems, 'scoreboard.problems', 10_000).map(validateProblem));
  const rowTeamIds = array(board.rows, 'scoreboard.rows', 100_000).map((row, index) => validateScoreRow(row, index, problemIds));
  const flatTeamIds = array(board.teams, 'scoreboard.teams', 100_000).map(validateFlatTeam);
  if (rowTeamIds.length !== flatTeamIds.length || rowTeamIds.some((teamId, index) => teamId !== flatTeamIds[index])) {
    throw new TypeError('scoreboard rows and teams aliases do not match');
  }

  if (expectedView === 'public' && board.diagnostics !== undefined) {
    throw new TypeError('public scoreboard must not contain jury diagnostics');
  }
  if (board.diagnostics !== undefined) {
    const diagnostics = record(board.diagnostics, 'scoreboard.diagnostics');
    keys(diagnostics, ['unmapped_events', 'out_of_contest_events'], ['unmapped_events', 'out_of_contest_events'], 'scoreboard.diagnostics');
    integer(diagnostics.unmapped_events, 'scoreboard.diagnostics.unmapped_events');
    integer(diagnostics.out_of_contest_events, 'scoreboard.diagnostics.out_of_contest_events');
  }
  return board as ScoreboardResponse;
}

export function parseSubmissionFeedResponse(value: unknown, view: BoardView): SubmissionFeedResponse {
  const feed = record(value, 'submission feed');
  keys(feed, ['cursor', 'items', 'has_more'], ['cursor', 'items', 'has_more'], 'submission feed');
  integer(feed.cursor, 'submission feed.cursor');
  boolean(feed.has_more, 'submission feed.has_more');
  const baseKeys = [
    'event_id', 'rid', 'team_id', 'team_name', 'school', 'problem_id', 'problem_label', 'status', 'score', 'submitted_at', 'judged_at',
  ];
  const juryKeys = [...baseKeys, 'site_id', 'source_seq', 'quarantined'];
  array(feed.items, 'submission feed.items', 500).forEach((input, index) => {
    const name = `submission feed.items[${index}]`;
    const item = record(input, name);
    const required = view === 'jury'
      ? ['event_id', 'rid', 'team_name', 'school', 'problem_label', 'status', 'score', 'submitted_at', 'judged_at', 'site_id', 'source_seq', 'quarantined']
      : baseKeys;
    keys(item, required, view === 'jury' ? juryKeys : baseKeys, name);
    text(item.event_id, `${name}.event_id`, 128);
    text(item.rid, `${name}.rid`, 128);
    if (view === 'public') {
      text(item.team_id, `${name}.team_id`, 128);
      text(item.problem_id, `${name}.problem_id`, 128);
    } else {
      if (item.team_id !== undefined && item.team_id !== null) text(item.team_id, `${name}.team_id`, 128);
      if (item.problem_id !== undefined && item.problem_id !== null) text(item.problem_id, `${name}.problem_id`, 128);
      text(item.site_id, `${name}.site_id`, 128);
      integer(item.source_seq, `${name}.source_seq`, 1);
      boolean(item.quarantined, `${name}.quarantined`);
    }
    if (item.team_name !== null) text(item.team_name, `${name}.team_name`, 200);
    if (item.school !== null) text(item.school, `${name}.school`, 200);
    if (item.problem_label !== null) text(item.problem_label, `${name}.problem_label`, 16);
    if (typeof item.status !== 'string' || !STATUS_VALUES.has(item.status)) throw new TypeError(`${name}.status is invalid`);
    if (item.score !== null) finite(item.score, `${name}.score`);
    dateTime(item.submitted_at, `${name}.submitted_at`);
    if (item.judged_at !== null) dateTime(item.judged_at, `${name}.judged_at`);
    if (item.status === 'FROZEN' && (item.score !== null || item.judged_at !== null)) {
      throw new TypeError(`${name} leaks a frozen result`);
    }
    if (view === 'public' && item.status === 'FROZEN' && !Boolean(item.team_id && item.problem_id)) {
      throw new TypeError(`${name} is missing public identity fields`);
    }
  });
  return feed as unknown as SubmissionFeedResponse;
}

export function parseSiteStatusResponse(value: unknown): unknown {
  const status = record(value, 'site status response');
  keys(status, ['generated_at', 'complete', 'message', 'sites'], ['generated_at', 'complete', 'message', 'sites'], 'site status response');
  dateTime(status.generated_at, 'site status response.generated_at');
  boolean(status.complete, 'site status response.complete');
  if (status.message !== null) text(status.message, 'site status response.message', 500);
  array(status.sites, 'site status response.sites', 10_000).forEach((site, index) => validateSite(site, `site status response.sites[${index}]`));
  return status;
}

/** Strictly validates the XCPCIO all-in-one document before it reaches a browser. */
export function parseXcpcioAllInOneResponse(value: unknown): XcpcioAllInOneResponse {
  const allInOne = record(value, 'XCPCIO response');
  keys(
    allInOne,
    ['contest', 'teams', 'submissions'],
    ['contest', 'teams', 'submissions', 'league_status'],
    'XCPCIO response',
  );

  const contest = record(allInOne.contest, 'XCPCIO response.contest');
  keys(contest, [
    'contest_name',
    'start_time',
    'end_time',
    'frozen_time',
    'penalty',
    'problem_quantity',
    'problem_id',
    'group',
    'organization',
    'status_time_display',
    'medal',
    'logo',
    'options',
  ], [
    'contest_name',
    'start_time',
    'end_time',
    'frozen_time',
    'penalty',
    'problem_quantity',
    'problem_id',
    'group',
    'organization',
    'status_time_display',
    'medal',
    'balloon_color',
    'logo',
    'options',
  ], 'XCPCIO response.contest');
  text(contest.contest_name, 'XCPCIO response.contest.contest_name', 500);
  integer(contest.start_time, 'XCPCIO response.contest.start_time', Number.MIN_SAFE_INTEGER);
  integer(contest.end_time, 'XCPCIO response.contest.end_time', Number.MIN_SAFE_INTEGER);
  integer(contest.frozen_time, 'XCPCIO response.contest.frozen_time');
  integer(contest.penalty, 'XCPCIO response.contest.penalty');
  const problemQuantity = integer(contest.problem_quantity, 'XCPCIO response.contest.problem_quantity');
  const problemIds = array(contest.problem_id, 'XCPCIO response.contest.problem_id', 10_000);
  if (problemIds.length !== problemQuantity) {
    throw new TypeError('XCPCIO response.contest.problem_quantity does not match problem_id');
  }
  problemIds.forEach((item, index) => string(item, `XCPCIO response.contest.problem_id[${index}]`, 128));
  const groups = record(contest.group, 'XCPCIO response.contest.group');
  Object.entries(groups).forEach(([key, group]) => {
    string(key, 'XCPCIO response.contest.group key', 128);
    string(group, `XCPCIO response.contest.group.${key}`, 200);
  });
  string(contest.organization, 'XCPCIO response.contest.organization', 200);
  const display = record(contest.status_time_display, 'XCPCIO response.contest.status_time_display');
  keys(display, ['correct', 'incorrect', 'pending'], ['correct', 'incorrect', 'pending'], 'XCPCIO response.contest.status_time_display');
  boolean(display.correct, 'XCPCIO response.contest.status_time_display.correct');
  boolean(display.incorrect, 'XCPCIO response.contest.status_time_display.incorrect');
  boolean(display.pending, 'XCPCIO response.contest.status_time_display.pending');
  if (contest.medal !== 'icpc' && contest.medal !== 'ccpc') {
    const medals = record(contest.medal, 'XCPCIO response.contest.medal');
    Object.entries(medals).forEach(([group, input]) => {
      string(group, 'XCPCIO response.contest.medal group', 128);
      const name = `XCPCIO response.contest.medal.${group}`;
      const counts = record(input, name);
      keys(counts, ['gold', 'silver', 'bronze'], ['gold', 'silver', 'bronze'], name);
      integer(counts.gold, `${name}.gold`);
      integer(counts.silver, `${name}.silver`);
      integer(counts.bronze, `${name}.bronze`);
    });
  }
  if (contest.balloon_color !== undefined) {
    const colors = array(contest.balloon_color, 'XCPCIO response.contest.balloon_color', 10_000);
    colors.forEach((input, index) => {
      const name = `XCPCIO response.contest.balloon_color[${index}]`;
      const color = record(input, name);
      keys(color, ['color', 'background_color'], ['color', 'background_color'], name);
      string(color.color, `${name}.color`, 128);
      string(color.background_color, `${name}.background_color`, 128);
    });
  }
  const logo = record(contest.logo, 'XCPCIO response.contest.logo');
  keys(logo, ['preset'], ['preset'], 'XCPCIO response.contest.logo');
  if (logo.preset !== 'ICPC' && logo.preset !== 'CCPC') throw new TypeError('XCPCIO response.contest.logo.preset is invalid');
  const options = record(contest.options, 'XCPCIO response.contest.options');
  keys(options, ['submission_timestamp_unit'], ['submission_timestamp_unit'], 'XCPCIO response.contest.options');
  if (options.submission_timestamp_unit !== 'millisecond') {
    throw new TypeError('XCPCIO response.contest.options.submission_timestamp_unit is invalid');
  }

  const teamIds = new Set<string>();
  array(allInOne.teams, 'XCPCIO response.teams', 100_000).forEach((input, index) => {
    const name = `XCPCIO response.teams[${index}]`;
    const team = record(input, name);
    keys(team, ['team_id', 'name', 'organization', 'members', 'group'], [
      'team_id', 'name', 'organization', 'members', 'coach', 'group', 'badge',
    ], name);
    const teamId = string(team.team_id, `${name}.team_id`, 128);
    if (teamIds.has(teamId)) throw new TypeError(`${name}.team_id is duplicated`);
    teamIds.add(teamId);
    string(team.name, `${name}.name`, 500);
    string(team.organization, `${name}.organization`, 500);
    array(team.members, `${name}.members`, 100).forEach((member, memberIndex) => (
      string(member, `${name}.members[${memberIndex}]`, 500)
    ));
    if (team.coach !== undefined) string(team.coach, `${name}.coach`, 500);
    array(team.group, `${name}.group`, 100).forEach((group, groupIndex) => (
      string(group, `${name}.group[${groupIndex}]`, 128)
    ));
    if (team.badge !== undefined) {
      const badge = record(team.badge, `${name}.badge`);
      keys(badge, ['url'], ['url'], `${name}.badge`);
      badgeUrl(badge.url, `${name}.badge.url`);
    }
  });

  const submissionIds = new Set<string>();
  array(allInOne.submissions, 'XCPCIO response.submissions', 1_000_000).forEach((input, index) => {
    const name = `XCPCIO response.submissions[${index}]`;
    const submission = record(input, name);
    keys(submission, ['problem_id', 'team_id', 'timestamp', 'status', 'language', 'submission_id'], [
      'problem_id', 'team_id', 'timestamp', 'status', 'language', 'submission_id',
    ], name);
    const problemId = integer(submission.problem_id, `${name}.problem_id`);
    if (problemId >= problemQuantity) throw new TypeError(`${name}.problem_id is out of range`);
    const teamId = string(submission.team_id, `${name}.team_id`, 128);
    if (!teamIds.has(teamId)) throw new TypeError(`${name}.team_id is unknown`);
    integer(submission.timestamp, `${name}.timestamp`);
    if (typeof submission.status !== 'string' || !XCPCIO_STATUSES.has(submission.status)) {
      throw new TypeError(`${name}.status is invalid`);
    }
    string(submission.language, `${name}.language`, 128);
    const submissionId = string(submission.submission_id, `${name}.submission_id`, 500);
    if (submissionIds.has(submissionId)) throw new TypeError(`${name}.submission_id is duplicated`);
    submissionIds.add(submissionId);
  });

  if (allInOne.league_status !== undefined) {
    const leagueStatus = record(allInOne.league_status, 'XCPCIO response.league_status');
    keys(
      leagueStatus,
      ['generated_at', 'complete', 'message', 'sites'],
      ['generated_at', 'complete', 'message', 'sites'],
      'XCPCIO response.league_status',
    );
    dateTime(leagueStatus.generated_at, 'XCPCIO response.league_status.generated_at');
    boolean(leagueStatus.complete, 'XCPCIO response.league_status.complete');
    if (leagueStatus.message !== null) {
      text(leagueStatus.message, 'XCPCIO response.league_status.message', 500);
    }
    array(leagueStatus.sites, 'XCPCIO response.league_status.sites', 10_000).forEach((input, index) => {
      const name = `XCPCIO response.league_status.sites[${index}]`;
      const site = record(input, name);
      keys(site, ['site_id', 'name', 'status'], ['site_id', 'name', 'school_name', 'status'], name);
      text(site.site_id, `${name}.site_id`, 128);
      text(site.name, `${name}.name`, 200);
      if (site.school_name !== undefined) text(site.school_name, `${name}.school_name`, 200);
      if (typeof site.status !== 'string' || !SITE_STATES.has(site.status)) {
        throw new TypeError(`${name}.status is invalid`);
      }
    });
  }

  return allInOne as unknown as XcpcioAllInOneResponse;
}
