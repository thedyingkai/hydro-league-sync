declare module '@hydrooj/ui-default' {
  export class NamedPage {
    constructor(names: string[], start: () => void | Promise<void>);
  }

  export function addPage(page: NamedPage): void;

  export const React: any;
  export const ReactDOM: any;
}
