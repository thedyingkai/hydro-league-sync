import type { ViteSSGContext } from "vite-ssg";

export type UserModule = (ctx: ViteSSGContext) => void;

export interface RuntimeConfig {
  dataSource?: string;
  baseUrl?: string;
  cdnHost?: string;
  dataHost?: string;
  dataRegion?: string;
  defaultLang?: string;
  refetchInterval?: number;
  sourceCodeUrl?: string;
}
