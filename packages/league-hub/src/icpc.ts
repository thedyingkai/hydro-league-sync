import { strToU8, zipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { badgeUrlKind } from './badge-url.js';
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

interface LogoReference {
  href: string;
  filename: string;
  mime: string;
  hash?: string;
  width?: number;
  height?: number;
}

interface BundledLogo {
  archivePath: string;
  bytes: Buffer;
  width: number;
  height: number;
}

interface OrganizationExport {
  resource: Record<string, unknown>;
  bundledLogos: BundledLogo[];
}

const xcpcioPublicPrefix = '/hydro-league-xcpcio/';

function packageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (dirname(current) !== current) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
        if (parsed.name === '@hydro-league-sync/league-hub') return current;
      } catch {
        // Keep walking; a parent manifest may be the package root.
      }
    }
    current = dirname(current);
  }
  throw new Error('Unable to locate the league-hub package root');
}

function imageMime(pathname: string): string | null {
  switch (posix.extname(pathname).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: return null;
  }
}

function imageDimensions(bytes: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png') {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime !== 'image/jpeg' || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (startOfFrame.has(marker) && segmentLength >= 7) {
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }
    offset += segmentLength;
  }
  return null;
}

function logoPathname(url: string): string {
  const parsed = badgeUrlKind(url) === 'root-relative'
    ? new URL(url, 'https://league.invalid')
    : new URL(url);
  try {
    return decodeURIComponent(parsed.pathname);
  } catch {
    return parsed.pathname;
  }
}

function bundledLogo(
  url: string,
  pathname: string,
  organizationId: string,
  filename: string,
  mime: string,
): BundledLogo | null {
  if (badgeUrlKind(url) !== 'root-relative' || !pathname.startsWith(xcpcioPublicPrefix)) return null;
  const relativeUrl = pathname.slice(xcpcioPublicPrefix.length);
  const publicRoot = realpathSync(join(packageRoot(), 'public', 'hydro-league-xcpcio'));
  const unresolved = resolve(publicRoot, relativeUrl);
  const unresolvedRelativePath = relative(publicRoot, unresolved);
  if (!unresolvedRelativePath || unresolvedRelativePath === '..'
    || unresolvedRelativePath.startsWith(`..${sep}`) || isAbsolute(unresolvedRelativePath)) return null;
  if (!existsSync(unresolved)) return null;
  const candidate = realpathSync(unresolved);
  const relativePath = relative(publicRoot, candidate);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return null;
  }
  if (!statSync(candidate).isFile()) return null;
  const bytes = readFileSync(candidate);
  const dimensions = imageDimensions(bytes, mime);
  if (!dimensions) return null;
  return {
    archivePath: `organizations/${organizationId}/${filename}`,
    bytes,
    ...dimensions,
  };
}

function logoExport(url: string, organizationId: string): { references: LogoReference[]; bundled: BundledLogo[] } | null {
  const pathname = logoPathname(url);
  const filename = posix.basename(pathname);
  const extension = posix.extname(filename);
  if (!filename || !imageMime(pathname) || badgeUrlKind(url) !== 'root-relative') return null;
  const stem = filename.slice(0, -extension.length);
  const exports = [56, 160].map((size) => {
    const variantFilename = `${stem}.${size}x${size}.png`;
    const variantPathname = posix.join(posix.dirname(pathname), variantFilename);
    const parsed = new URL(url, 'https://league.invalid');
    parsed.pathname = variantPathname;
    parsed.search = '';
    parsed.hash = '';
    const variantUrl = parsed.pathname;
    const bundled = bundledLogo(
      variantUrl,
      logoPathname(variantUrl),
      organizationId,
      variantFilename,
      'image/png',
    );
    if (!bundled || bundled.width !== size || bundled.height !== size) return null;
    return {
      reference: {
        href: variantUrl,
        filename: variantFilename,
        mime: 'image/png',
        hash: createHash('md5').update(bundled.bytes).digest('hex'),
        width: size,
        height: size,
      } satisfies LogoReference,
      bundled,
    };
  });
  if (exports.some((item) => item === null)) return null;
  const complete = exports as Array<{ reference: LogoReference; bundled: BundledLogo }>;
  return {
    references: complete.map((item) => item.reference),
    bundled: complete.map((item) => item.bundled),
  };
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

function organizationExports(database: HubDatabase): OrganizationExport[] {
  const seen = new Map<string, {
    id: string;
    name: string;
    formalName: string;
    badgeUrl: string | null;
  }>();
  for (const team of database.getTeams().filter((item) => !item.hidden)) {
    if (!seen.has(team.school_id)) {
      seen.set(team.school_id, {
        id: contestApiResourceId(team.school_id, 'org'),
        name: team.school_name ?? team.school_id,
        formalName: team.school_name ?? team.school_id,
        badgeUrl: team.badge_url ?? null,
      });
    } else if (team.badge_url && !seen.get(team.school_id)!.badgeUrl) {
      seen.get(team.school_id)!.badgeUrl = team.badge_url;
    }
  }
  return [...seen.values()].map((item) => {
    const logo = item.badgeUrl ? logoExport(item.badgeUrl, item.id) : null;
    return {
      resource: {
        id: item.id,
        name: item.name,
        formal_name: item.formalName,
        ...(logo ? { logo: logo.references } : {}),
      },
      bundledLogos: logo?.bundled ?? [],
    };
  });
}

function organizations(database: HubDatabase): Array<Record<string, unknown>> {
  return organizationExports(database).map((item) => item.resource);
}

function groups(database: HubDatabase): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [
    { id: 'official', name: 'Official', type: 'eligibility' },
    { id: 'unofficial', name: 'Unofficial', type: 'eligibility' },
  ];
  const custom = new Set(database.getTeams()
    .filter((team) => !team.hidden)
    .flatMap((team) => team.groups ?? [])
    .filter((group) => group !== 'official' && group !== 'unofficial'));
  for (const group of [...custom].sort()) {
    result.push({ id: contestApiResourceId(group, 'group'), name: group });
  }
  return result;
}

function teams(database: HubDatabase): Array<Record<string, unknown>> {
  return database.getTeams().filter((team) => !team.hidden).map((team) => ({
    id: contestApiResourceId(team.team_id, 'team'),
    name: team.name,
    display_name: team.name,
    organization_id: contestApiResourceId(team.school_id, 'org'),
    group_ids: [
      team.official === false ? 'unofficial' : 'official',
      ...new Set((team.groups ?? [])
        .filter((group) => group !== 'official' && group !== 'unofficial')
        .map((group) => contestApiResourceId(group, 'group'))),
    ],
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

function awards(database: HubDatabase): Array<Record<string, unknown>> {
  return database.getAwards().map((award) => ({
    id: award.award_id,
    citation: award.citation,
    team_ids: award.team_ids.map((teamId) => contestApiResourceId(teamId, 'team')),
  }));
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
    groups: groups(database),
    organizations: organizations(database),
    teams: teams(database),
    problems: problems(database),
    submissions: submissions(database, effectiveGeneratedAt),
    judgements: judgements(database, effectiveGeneratedAt),
    runs: runs(database),
    awards: awards(database),
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
  for (const item of resources.awards) add('awards', item);
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
    provider: { name: 'Hydro League Hub', version: '0.1.1' },
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
    'awards.json': strToU8(JSON.stringify(resources.awards, null, 2) + '\n'),
    'state.json': strToU8(JSON.stringify(resources.state, null, 2) + '\n'),
    'scoreboard.json': strToU8(JSON.stringify(resources.scoreboard, null, 2) + '\n'),
    'event-feed.ndjson': strToU8(feed),
  };
  for (const organization of organizationExports(database)) {
    for (const logo of organization.bundledLogos) {
      files[logo.archivePath] = logo.bytes;
    }
  }
  return zipSync(files, { level: 6 });
}
