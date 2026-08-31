import {
  Context,
  Logger,
  ObjectId,
  PERM,
  Types,
} from 'hydrooj';
import { Config, type RawAgentConfig } from './config.js';
import { applyAgent } from './hydro-adapter.js';

export const name = 'hydro-league-agent';
export { Config };

export async function apply(ctx: Context, config: RawAgentConfig): Promise<void> {
  const logger = new Logger(name);
  await applyAgent(ctx as never, config, {
    logger,
    objectId: (value) => new ObjectId(value),
    types: Types,
    hiddenScoreboardPermission: PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD,
    hydroVersion: '5.0.0-beta.9',
  });
}

export * from './cache.js';
export * from './capture.js';
export * from './config.js';
export * from './event-factory.js';
export * from './hydro-adapter.js';
export * from './hub-response.js';
export * from './outbox.js';
export * from './protocol.js';
export * from './reconciliation.js';
export * from './transport.js';
export * from './types.js';
export * from './views.js';
export * from './worker.js';
