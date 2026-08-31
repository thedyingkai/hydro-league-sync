import {
  MappedSubmissionEventSchema,
  toXcpcioAllInOne,
  type ScoreboardView,
  type XcpcioAllInOne,
} from '@hydro-league-sync/protocol';
import type { HubDatabase } from './database.js';

export function buildXcpcio(
  database: HubDatabase,
  view: ScoreboardView,
  now: Date,
): XcpcioAllInOne {
  const contest = database.getContest();
  if (!contest) throw new Error('League configuration is not loaded');
  const teamMappings = database.getTeamMappings();
  const fallbackSiteId = database.getSites()[0]?.site_id ?? 'hub';
  const teams = database.getTeams().filter((team) => !team.hidden).map((team) => ({
    global_team_id: team.team_id,
    name: team.name,
    organization_id: team.school_id,
    organization_name: team.school_name ?? team.school_id,
    site_id: teamMappings.find((mapping) => mapping.team_id === team.team_id)?.site_id ?? fallbackSiteId,
    is_official: team.official !== false,
    members: [],
    groups: team.groups ?? [],
    ...(team.badge_url ? { badge_url: team.badge_url } : {}),
  }));
  const problems = database.getProblems().map((problem, index) => {
    const color = problem.rgb ?? problem.color;
    return {
      global_problem_id: problem.problem_id,
      label: problem.label,
      name: problem.name,
      ordinal: problem.ordinal ?? index,
      ...(color ? { color } : {}),
    };
  });
  const events = database.getEvents(contest.contest_id).flatMap((event) => {
    if (!event.team_id || !event.problem_id) return [];
    return [MappedSubmissionEventSchema.parse({
      protocol_version: event.protocol_version,
      event_type: event.event_type,
      league_id: event.league_id,
      site_id: event.site_id,
      domain_id: event.domain_id,
      contest_id: event.contest_id,
      rid: event.rid,
      source_seq: event.source_seq,
      status: event.status,
      uid: event.uid,
      pid: event.pid,
      submitted_at: event.submitted_at,
      ...(typeof event.lang === 'string' ? { lang: event.lang } : {}),
      ...(typeof event.score === 'number' ? { score: event.score } : {}),
      ...(typeof event.judged_at === 'string' ? { judged_at: event.judged_at } : {}),
      emitted_at: event.emitted_at,
      rejudged: event.rejudged,
      global_team_id: event.team_id,
      global_problem_id: event.problem_id,
    })];
  });

  return toXcpcioAllInOne({
    config: {
      protocol_version: '1.0',
      league_id: contest.contest_id,
      title: contest.name,
      rule: 'acm',
      starts_at: contest.start_time,
      ends_at: contest.end_time,
      freeze_at: contest.freeze_time ?? null,
      unfreeze_at: database.getContestPublishedAt(contest.contest_id) ?? contest.unfreeze_at ?? null,
      penalty_seconds: (contest.penalty_minutes ?? 20) * 60,
      xcpcio_preset: 'ICPC',
      ...(contest.xcpcio_medals ? { xcpcio_medals: contest.xcpcio_medals } : {}),
    },
    teams,
    problems,
    events,
    view,
    now,
  });
}
