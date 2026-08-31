import { addPage, NamedPage } from '@hydrooj/ui-default';
import { createXcpcioFrameUrl } from './xcpcio-frame.js';

type AnyRecord = Record<string, any>;

function element<K extends keyof HTMLElementTagNameMap>(
  name: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function replace(root: HTMLElement, child: HTMLElement): void {
  root.replaceChildren(child);
}

async function startXcpcio(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#league-xcpcio-root');
  if (!root) return;
  const payload = (window as any).UiContext.payload;
  const iframe = element('iframe', 'league-xcpcio-frame');
  iframe.title = 'League XCPCIO';
  iframe.loading = 'eager';
  iframe.referrerPolicy = 'same-origin';
  iframe.src = createXcpcioFrameUrl(String(payload.dataUrl), window.location.origin);
  replace(root, iframe);
}

addPage(new NamedPage(['leagueboard', 'league-xcpcio'], startXcpcio));
