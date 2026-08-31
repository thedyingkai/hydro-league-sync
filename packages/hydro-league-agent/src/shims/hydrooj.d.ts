export class Context {}

export class Logger {
  constructor(name: string);
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export class ObjectId {
  constructor(value: string);
}

export const PERM: {
  PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD: bigint;
};

export const Types: {
  String: unknown;
  Boolean: unknown;
};
