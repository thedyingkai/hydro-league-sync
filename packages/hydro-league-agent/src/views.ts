import type {
  AgentConfig,
  BoardView,
  HubTransport,
  LoggerLike,
} from './types.js';
import { findBinding } from './config.js';
import { idString } from './event-factory.js';
import { SegregatedRemoteCache } from './cache.js';

interface ContestLike {
  _id?: string | { toHexString?: () => string; toString: () => string };
  docId?: string | { toHexString?: () => string; toString: () => string };
  domainId: string;
  rule?: string;
}

interface HandlerLike {
  user: {
    own(document: unknown): boolean;
    hasPerm(permission: unknown): boolean;
  };
  request: {
    json?: boolean;
    query?: Record<string, unknown>;
  };
  response: {
    body?: unknown;
    template?: string;
  };
}

interface ScoreboardRegistryLike {
  addView(
    name: string,
    title: string,
    params: Record<string, unknown>,
    definition: {
      display(this: HandlerLike, params: Record<string, unknown>): Promise<void>;
      supportedRules: string[];
    },
  ): void;
}

export interface ViewDependencies {
  scoreboard: ScoreboardRegistryLike;
  types: { String: unknown; Boolean: unknown };
  hiddenScoreboardPermission: unknown;
  config: AgentConfig;
  transport: HubTransport;
  cache: SegregatedRemoteCache;
  logger: LoggerLike;
}

function contestId(tdoc: ContestLike): string {
  const value = tdoc._id ?? tdoc.docId;
  if (!value) throw new Error('Hydro contest has no ObjectId');
  return idString(value).toLowerCase();
}

function requireConfiguredContest(config: AgentConfig, tdoc: ContestLike): void {
  if (!findBinding(config, tdoc.domainId, contestId(tdoc))) {
    throw new Error(`Contest ${tdoc.domainId}/${contestId(tdoc)} is not configured for this league`);
  }
}

export function boardViewFor(handler: HandlerLike, tdoc: ContestLike, permission: unknown): BoardView {
  return handler.user.own(tdoc) || handler.user.hasPerm(permission) ? 'jury' : 'public';
}

function localViewUrl(tdoc: ContestLike, viewName: string): string {
  return `/d/${encodeURIComponent(tdoc.domainId)}/contest/${encodeURIComponent(contestId(tdoc))}/scoreboard/${viewName}`;
}

export function registerLeagueViews(deps: ViewDependencies): void {
  const { scoreboard, config, transport, cache, hiddenScoreboardPermission, logger } = deps;

  const registerXcpcioView = (name: string, title: string) => {
    scoreboard.addView(name, title, {
      tdoc: 'tdoc',
      json: deps.types.Boolean,
    }, {
      async display({ tdoc: rawTdoc, json }) {
        const tdoc = rawTdoc as ContestLike;
        requireConfiguredContest(config, tdoc);
        // Deliberately ignore all client-provided view/realtime flags. Only Hydro's
        // ownership and hidden-scoreboard permission can select the jury feed.
        const view = boardViewFor(this, tdoc, hiddenScoreboardPermission);
        const board = await cache.get(
          `xcpcio:${config.leagueId}:${view}`,
          () => transport.getXcpcio(view),
        );
        const payload = {
          board: board.value,
          meta: {
            view,
            stale: board.stale,
            fetchedAt: board.fetchedAt,
            ...(board.error ? { error: board.error } : {}),
          },
          dataUrl: `${localViewUrl(tdoc, name)}?json=true`,
          sourceUrl: config.sourceUrl,
        };
        if (json || this.request.json) {
          this.response.body = board.value;
          return;
        }
        logger.debug('Rendering %s with XCPCIO for %s view', name, view);
        this.response.body = { page_name: name, payload, tdoc };
        this.response.template = 'league-xcpcio.html';
      },
      supportedRules: ['acm', 'icpc'],
    });
  };

  registerXcpcioView('leagueboard', 'League Board');

  scoreboard.addView('league-realboard', 'League Realboard', {
    tdoc: 'tdoc',
    json: deps.types.Boolean,
  }, {
    async display({ tdoc: rawTdoc, json }) {
      const tdoc = rawTdoc as ContestLike;
      requireConfiguredContest(config, tdoc);
      const view = boardViewFor(this, tdoc, hiddenScoreboardPermission);
      const board = await cache.get(
        `xcpcio:${config.leagueId}:${view}`,
        () => transport.getXcpcio(view),
      );
      const payload = {
        board: board.value,
        meta: {
          view,
          stale: board.stale,
          fetchedAt: board.fetchedAt,
          ...(board.error ? { error: board.error } : {}),
        },
        dataUrl: `${localViewUrl(tdoc, 'league-realboard')}?json=true`,
        sourceUrl: config.sourceUrl,
      };
      if (json || this.request.json) {
        this.response.body = payload;
        return;
      }
      logger.debug('Rendering league-realboard fork for %s view', view);
      this.response.body = { page_name: 'league-realboard', payload, tdoc };
      this.response.template = 'league-realboard.html';
    },
    supportedRules: ['acm', 'icpc'],
  });

  registerXcpcioView('league-xcpcio', 'League XCPCIO');
}
