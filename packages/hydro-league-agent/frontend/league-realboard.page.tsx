// @ts-nocheck
/**
 * League adapter for HandsomeRun/hydro-realboard at
 * fa662b5a1b817d4e73f3f44f5cc0ee9441851a3c.
 *
 * The upstream React components, ranking model, two-stage queues, and
 * react-spring transitions are retained. The local-contest WebSocket input is
 * replaced by Hydro's authenticated same-origin league XCPCIO proxy so this
 * fork can animate the merged multi-school contest without exposing the hub.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { addPage, NamedPage, React, ReactDOM } from '@hydrooj/ui-default';
import { animated, easings, useSprings, useTransition } from '@react-spring/web';
import type { ResolverInput } from '../upstream/hydro-realboard/interface.js';

const MAX_QUEUE = 9;
const FADEOUT_TIME = 5_000;
const POLL_INTERVAL = 2_000;

type LeagueSubmission = ResolverInput['submissions'][number] & { id: string };
type LeagueResolverInput = Omit<ResolverInput, 'submissions'> & {
  submissions: LeagueSubmission[];
};

function isACM(rule: string): boolean {
  return ['acm', 'icpc'].includes(rule?.toLowerCase() || 'acm');
}

function isPenaltyVerdict(verdict: string): boolean {
  return ['WA', 'TLE', 'MLE', 'OLE', 'RE'].includes(verdict);
}

function problemStatus(problem, rule: string, verdict?: string): string {
  if (!problem) return 'untouched';
  if (problem.frozen) return 'frozen';
  if (problem.pass) return 'ac';
  if (verdict) {
    if (/^(ce|se|ign)/i.test(verdict)) return 'ce';
    if (/^(tle|mle|ole)/i.test(verdict)) return 'tle';
    if (/^re/i.test(verdict)) return 're';
  }
  if (isACM(rule)) return problem.old ? 'failed' : 'untouched';
  return problem.touched ? 'failed' : 'untouched';
}

function problemText(problem, rule: string, verdict?: string): string | number {
  const status = problemStatus(problem, rule, verdict);
  if (status === 'frozen') return `${problem.old}+${problem.frozen}`;
  if (isACM(rule)) {
    if (status === 'ac') return `${problem.old} / ${problem.time}`;
    if (['failed', 'ce', 'tle', 're'].includes(status)) {
      return problem.old || verdict || String.fromCharCode(65 + problem.index);
    }
    return String.fromCharCode(65 + problem.index);
  }
  return status === 'untouched' ? String.fromCharCode(65 + problem.index) : problem.score;
}

function processRank(teams, rule: string): void {
  const acm = isACM(rule);
  teams.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (acm && a.penalty !== b.penalty) return a.penalty - b.penalty;
    return a.name.localeCompare(b.name);
  });
  let officialPosition = 0;
  let previousOfficial = null;
  for (const team of teams) {
    if (team.exclude) {
      team.rank = -1;
      continue;
    }
    officialPosition += 1;
    const tied = previousOfficial
      && previousOfficial.score === team.score
      && (!acm || previousOfficial.penalty === team.penalty);
    team.rank = tied ? previousOfficial.rank : officialPosition;
    previousOfficial = team;
  }
}

function verdictFromXcpcio(status: string): string {
  const verdicts: Record<string, string> = {
    CORRECT: 'AC',
    REJECTED: 'WA',
    WRONG_ANSWER: 'WA',
    TIME_LIMIT_EXCEEDED: 'TLE',
    MEMORY_LIMIT_EXCEEDED: 'MLE',
    OUTPUT_LIMIT_EXCEEDED: 'OLE',
    RUNTIME_ERROR: 'RE',
    COMPILATION_ERROR: 'CE',
    SYSTEM_ERROR: 'SE',
    CANCELED: 'IGN',
    PENDING: 'PND',
    FROZEN: 'FROZEN',
  };
  return verdicts[status] ?? 'SE';
}

export function toRealboardInput(board): LeagueResolverInput {
  const start = Number(board.contest.start_time);
  const end = Number(board.contest.end_time);
  const duration = Math.max(0, end - start);
  const frozenDuration = Number(board.contest.frozen_time ?? 0);
  const frozen = frozenDuration > 0 ? Math.max(0, duration - frozenDuration) : 0;
  return {
    name: String(board.contest.contest_name),
    rule: 'icpc',
    duration,
    frozen,
    penalty: Math.floor(Number(board.contest.penalty ?? 1_200) / 60),
    problems: board.contest.problem_id.map((name, index) => ({
      name: String(name),
      id: String(index),
    })),
    teams: board.teams.map((team) => ({
      id: String(team.team_id),
      name: String(team.name),
      avatar: '',
      institution: String(team.organization ?? ''),
      exclude: !team.group?.includes('official'),
    })),
    submissions: board.submissions.map((submission) => ({
      id: String(submission.submission_id),
      team: String(submission.team_id),
      problem: String(submission.problem_id),
      verdict: verdictFromXcpcio(String(submission.status)),
      time: Math.max(0, Math.floor(Number(submission.timestamp) / 1_000)),
    })),
  };
}

function buildTeams(data: LeagueResolverInput) {
  const teams = data.teams.map((team) => ({
    id: team.id,
    name: team.name,
    rank: 0,
    score: 0,
    penalty: 0,
    exclude: team.exclude,
    total: 0,
    problems: data.problems.map((problem, index) => ({
      old: 0,
      frozen: 0,
      pass: false,
      id: problem.id,
      index,
      time: 0,
      score: 0,
      touched: false,
      verdict: '',
    })),
  }));

  const ordered = [...data.submissions].sort((a, b) => a.time - b.time);
  for (const submission of ordered) {
    const team = teams.find((candidate) => candidate.id === submission.team);
    const problem = team?.problems.find((candidate) => candidate.id === submission.problem);
    if (!team || !problem || (isACM(data.rule) && problem.pass)) continue;
    if (submission.verdict === 'PND') continue;
    team.total += 1;
    if (submission.verdict === 'FROZEN') {
      problem.frozen += 1;
      continue;
    }
    problem.verdict = submission.verdict;
    if (submission.verdict === 'AC') {
      problem.pass = true;
      problem.time = Math.floor(submission.time / 60);
      team.score += 1;
      team.penalty += problem.time + problem.old * data.penalty;
      problem.old += 1;
    } else if (isPenaltyVerdict(submission.verdict)) {
      problem.old += 1;
    }
  }
  processRank(teams, data.rule);
  return teams;
}

function TeamItem({ team, style, data, className = '' }) {
  const teamInfo = data.teams.find((candidate) => candidate.id === team.id);
  const [blink, setBlink] = React.useState(false);
  React.useEffect(() => {
    if (!team.isPending) return undefined;
    const interval = window.setInterval(() => setBlink((value) => !value), 500);
    return () => window.clearInterval(interval);
  }, [team.isPending]);

  const displayProblem = (problemId: string) => {
    const problem = team.problems.find((candidate) => candidate.id === problemId);
    if (problemId === team.submissionProblem) {
      if (team.isPending) return { className: `pnd item ${blink ? 'blink' : ''}`, text: 'PND' };
      if (team.submissionVerdict === 'FROZEN') return { className: 'frozen item', text: 'FROZEN' };
      return {
        className: `${problemStatus(problem, data.rule, team.submissionVerdict)} item`,
        text: team.submissionVerdict,
      };
    }
    return {
      className: `${problemStatus(problem, data.rule, problem?.verdict)} item`,
      text: problemText(problem, data.rule, problem?.verdict),
    };
  };

  return (
    <animated.div className={`rank-list-item clearfix ${className}`} style={style}>
      <div className="rank">{team.rank === -1 ? '*' : team.rank}</div>
      <div className="avatar" aria-hidden="true">{teamInfo?.name?.slice(0, 1) || '?'}</div>
      <div className="content">
        <div className="name">{teamInfo?.institution} - {teamInfo?.name}</div>
        <div className="problems">
          {data.problems.map((problem) => {
            const display = displayProblem(problem.id);
            return <span key={problem.id} className={display.className}>{display.text}</span>;
          })}
        </div>
      </div>
      <div className="solved">{team.score}</div>
      <div className="penalty">{team.penalty}</div>
    </animated.div>
  );
}

function displayItem(submission: LeagueSubmission, teams) {
  const team = teams.find((candidate) => candidate.id === submission.team);
  if (!team) return null;
  return {
    ...team,
    problems: team.problems.map((problem) => ({ ...problem })),
    fadeKey: `${submission.id}:${submission.verdict}:${Date.now()}:${Math.random()}`,
    createdAt: Date.now(),
    submissionId: submission.id,
    submissionProblem: submission.problem,
    submissionVerdict: submission.verdict,
    isPending: submission.verdict === 'PND',
  };
}

function RealboardMain({ data }: { data: LeagueResolverInput }) {
  const initialSeen = React.useRef(new Map(data.submissions.map((item) => [item.id, item.verdict])));
  const [bStageQueue, setBStageQueue] = React.useState([]);
  const [singleStageQueue, setSingleStageQueue] = React.useState([]);
  const [pendingAQueue, setPendingAQueue] = React.useState([]);

  React.useEffect(() => {
    const changed = data.submissions.filter(
      (submission) => initialSeen.current.get(submission.id) !== submission.verdict,
    );
    initialSeen.current = new Map(data.submissions.map((item) => [item.id, item.verdict]));
    if (!changed.length) return;
    const teams = buildTeams(data);
    const pending = [];
    const final = [];
    for (const submission of changed) {
      const item = displayItem(submission, teams);
      if (!item) continue;
      if (item.isPending) pending.push(item);
      else final.push(item);
    }
    if (pending.length) setPendingAQueue((queue) => [...queue, ...pending]);
    if (final.length) {
      const ids = new Set(final.map((item) => item.submissionId));
      setPendingAQueue((queue) => queue.filter((item) => !ids.has(item.submissionId)));
      setSingleStageQueue((queue) => queue.filter((item) => !ids.has(item.submissionId)));
      setBStageQueue((queue) => [...queue, ...final].slice(-MAX_QUEUE));
    }
  }, [data]);

  React.useEffect(() => {
    if (!pendingAQueue.length || singleStageQueue.length) return undefined;
    const [next, ...remaining] = pendingAQueue;
    setSingleStageQueue([next]);
    setPendingAQueue(remaining);
    return undefined;
  }, [pendingAQueue, singleStageQueue]);

  React.useEffect(() => {
    if (!singleStageQueue.length) return undefined;
    const timer = window.setTimeout(() => setSingleStageQueue([]), FADEOUT_TIME);
    return () => window.clearTimeout(timer);
  }, [singleStageQueue]);

  React.useEffect(() => {
    if (!bStageQueue.length) return undefined;
    const timer = window.setTimeout(() => {
      const now = Date.now();
      setBStageQueue((queue) => queue.filter((item) => now - item.createdAt < FADEOUT_TIME));
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [bStageQueue]);

  const transitions = useTransition(bStageQueue, {
    keys: (item) => item.fadeKey,
    from: { y: 720, opacity: 0 },
    enter: (item) => ({
      y: bStageQueue.findIndex((candidate) => candidate.fadeKey === item.fadeKey) * 80,
      opacity: 1,
    }),
    update: (item) => ({
      y: bStageQueue.findIndex((candidate) => candidate.fadeKey === item.fadeKey) * 80,
    }),
    leave: { opacity: 0 },
    config: { duration: 500, easing: easings.easeInOutCubic },
  });
  const [singleSprings, singleApi] = useSprings(singleStageQueue.length, () => ({ y: 0, opacity: 1 }), [singleStageQueue.length]);
  React.useEffect(() => void singleApi.start({ opacity: 1, y: 0 }), [singleStageQueue, singleApi]);

  return (
    <>
      {data.leagueStatus?.message && !data.leagueStatus.complete
        ? <div className="realboard-warning">{data.leagueStatus.message}</div>
        : null}
      <div className="rank-list-b-stage">
        {transitions((style, item, _transition, index) => item && (
          <TeamItem
            key={item.fadeKey}
            team={item}
            style={style}
            data={data}
            className={index % 2 === 0 ? 'even' : 'odd'}
          />
        ))}
      </div>
      <div className="rank-list-single">
        {singleSprings.map((style, index) => singleStageQueue[index] && (
          <TeamItem
            key={singleStageQueue[index].fadeKey}
            team={singleStageQueue[index]}
            style={style}
            data={data}
          />
        ))}
      </div>
    </>
  );
}

function RealboardApplication({ initialPayload }) {
  const [payload, setPayload] = React.useState(initialPayload);
  const endpoint = React.useMemo(() => {
    const url = new URL(String(initialPayload.dataUrl), window.location.origin);
    if (url.origin !== window.location.origin) throw new Error('Realboard data URL must be same-origin');
    return `${url.pathname}${url.search}`;
  }, [initialPayload.dataUrl]);

  React.useEffect(() => {
    let stopped = false;
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const next = await response.json();
        if (!next?.board?.contest || !Array.isArray(next.board.submissions)) {
          throw new Error('Malformed Realboard payload');
        }
        if (!stopped) setPayload(next);
      } catch {
        if (!stopped) setPayload((current) => ({
          ...current,
          meta: { ...current.meta, stale: true },
        }));
      } finally {
        busy = false;
      }
    };
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [endpoint]);

  const data = React.useMemo(() => {
    const result = toRealboardInput(payload.board);
    result.leagueStatus = payload.board.league_status;
    return result;
  }, [payload.board]);

  React.useEffect(() => {
    document.title = `${data.name} - Realboard`;
    const title = document.querySelector('.league-realboard-fork .header .title');
    if (title) title.textContent = data.name;
    const status = document.querySelector('#league-realboard-status');
    if (status) {
      const view = payload.meta?.view === 'jury' ? 'Jury' : 'Public';
      status.textContent = payload.meta?.stale ? `${view} - stale` : `${view} - connected`;
    }
  }, [data.name, payload.meta?.stale, payload.meta?.view]);

  return <RealboardMain data={data} />;
}

function startLeagueRealboard(): void {
  const root = document.querySelector('#league-realboard-root');
  const payload = (window as any).UiContext?.payload;
  if (!root || !payload?.board) return;
  ReactDOM.createRoot(root).render(<RealboardApplication initialPayload={payload} />);
}

addPage(new NamedPage(['league-realboard'], startLeagueRealboard));
