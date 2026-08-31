import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDirectory = path.join(packageDirectory, 'public');
const contestId = '64f000000000000000000001';
const dataPath = `/d/system/contest/${contestId}/scoreboard/league-xcpcio?json=true`;
const teamDefinitions = [
  ['FRESHMAN-1', 'Freshman One', ['official', 'freshman'], 8],
  ['SENIOR-1', 'Senior One', ['official', 'senior'], 7],
  ['STAR-1', 'Star One', ['unofficial', 'star'], 6],
  ['FRESHMAN-2', 'Freshman Two', ['official', 'freshman'], 5],
  ['SENIOR-2', 'Senior Two', ['official', 'senior'], 4],
  ['FRESHMAN-3', 'Freshman Three', ['official', 'freshman'], 3],
  ['STAR-2', 'Star Two', ['unofficial', 'star'], 2],
  ['FRESHMAN-4', 'Freshman Four', ['official', 'freshman'], 1],
];
const board = {
  contest: {
    contest_name: 'League 2026',
    start_time: Math.floor(Date.now() / 1_000) - 3_600,
    end_time: Math.floor(Date.now() / 1_000) + 10_800,
    frozen_time: 3_600,
    penalty: 1_200,
    problem_quantity: 8,
    problem_id: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'],
    group: {
      official: 'Official',
      unofficial: 'Unofficial',
      freshman: 'Freshman',
      senior: 'Senior',
      star: 'Star',
    },
    organization: 'School',
    status_time_display: { correct: true, incorrect: true, pending: true },
    medal: {
      freshman: { gold: 1, silver: 1, bronze: 1 },
      senior: { gold: 1, silver: 0, bronze: 0 },
      star: { gold: 1, silver: 0, bronze: 0 },
    },
    logo: { preset: 'ICPC' },
    options: { submission_timestamp_unit: 'millisecond' },
  },
  teams: teamDefinitions.map(([teamId, name, group]) => ({
    team_id: teamId,
    name,
    organization: 'School A',
    members: ['Alice'],
    group,
  })),
  submissions: teamDefinitions.flatMap(([teamId, , , solved], teamIndex) => (
    Array.from({ length: solved }, (_, problemId) => ({
      problem_id: problemId,
      team_id: teamId,
      timestamp: (teamIndex + problemId + 1) * 60_000,
      status: 'CORRECT',
      language: 'cpp17',
      submission_id: `school-a/system/contest/${teamId}-${problemId}`,
    }))
  )),
};

const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();

    socket.addEventListener('message', (event) => {
      void this.handleMessage(event.data).catch((error) => this.fail(error));
    });
    socket.addEventListener('close', () => this.fail(new Error('Chromium CDP connection closed')));
    socket.addEventListener('error', () => this.fail(new Error('Chromium CDP connection failed')));
  }

  static connect(url, timeoutMilliseconds = 10_000) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('Timed out connecting to Chromium CDP'));
      }, timeoutMilliseconds);
      const onError = () => {
        clearTimeout(timeout);
        reject(new Error(`Could not connect to Chromium CDP at ${url}`));
      };
      socket.addEventListener('error', onError, { once: true });
      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        socket.removeEventListener('error', onError);
        resolve(new CdpConnection(socket));
      }, { once: true });
    });
  }

  async handleMessage(data) {
    let text;
    if (typeof data === 'string') {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      text = Buffer.from(data).toString('utf8');
    } else if (ArrayBuffer.isView(data)) {
      text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
    } else if (typeof data?.text === 'function') {
      text = await data.text();
    } else {
      throw new Error('Received an unsupported CDP WebSocket message');
    }

    const message = JSON.parse(text);
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    for (const listener of this.listeners.get(message.method) ?? []) listener(message);
  }

  send(method, params = {}, sessionId, timeoutMilliseconds = 10_000) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Cannot send ${method}: Chromium CDP is not open`));
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Chromium CDP method ${method}`));
      }, timeoutMilliseconds);
      this.pending.set(id, { method, reject, resolve, timeout });
      try {
        this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  fail(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.fail(new Error('Chromium CDP connection was closed by the smoke test'));
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }
}

function launchChrome(chromePath, profile) {
  const child = spawn(chromePath, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-first-run',
    '--disable-features=MediaRouter,OptimizationHints,Translate',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    '--remote-allow-origins=*',
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const state = { child, error: null, stderr: '' };
  child.once('error', (error) => {
    state.error = error;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    state.stderr = `${state.stderr}${chunk}`.slice(-8_000);
  });
  return state;
}

async function waitForDevToolsEndpoint(profile, chromeState, timeoutMilliseconds = 15_000) {
  const activePortFile = path.join(profile, 'DevToolsActivePort');
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (chromeState.error) throw chromeState.error;
    // Edge's Windows launcher may hand the browser process off and exit before
    // DevToolsActivePort is written. CDP remains the authoritative readiness
    // and lifecycle boundary in that case.
    if (process.platform !== 'win32'
      && (chromeState.child.exitCode !== null || chromeState.child.signalCode !== null)) {
      throw new Error(`Chromium exited before CDP was ready: ${chromeState.stderr.slice(-2_000)}`);
    }
    try {
      const [portValue, browserPath] = (await fs.readFile(activePortFile, 'utf8')).trim().split(/\r?\n/);
      const port = Number(portValue);
      if (Number.isInteger(port) && port > 0 && browserPath?.startsWith('/')) {
        return `ws://127.0.0.1:${port}${browserPath}`;
      }
    } catch (error) {
      if (!['ENOENT', 'EBUSY', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
    await delay(50);
  }
  throw new Error(`Timed out waiting for Chromium CDP endpoint: ${chromeState.stderr.slice(-2_000)}`);
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child, timeoutMilliseconds) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMilliseconds);
    const onExit = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

async function terminateProcessTree(child) {
  if (!child || childHasExited(child)) return;
  if (await waitForChildExit(child, 2_000)) return;

  if (process.platform === 'win32' && child.pid) {
    await new Promise((resolve) => {
      const taskkill = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      const timeout = setTimeout(() => {
        taskkill.kill();
        resolve();
      }, 5_000);
      taskkill.once('error', () => {
        clearTimeout(timeout);
        resolve();
      });
      taskkill.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } else {
    child.kill('SIGKILL');
  }
  await waitForChildExit(child, 5_000);
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
}

async function removeTemporaryDirectory(directory) {
  if (!directory) return;
  let lastError;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      lastError = error;
      await delay(250);
    }
  }
  throw lastError;
}

function isExternalHttpRequest(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return !(hostname === '::1' || hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\./.test(hostname));
  } catch {
    return false;
  }
}

const chromePath = process.argv[2] || process.env.CHROME_PATH;
if (!chromePath) throw new Error('Pass a Chromium executable path or set CHROME_PATH');

const requests = [];
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  requests.push(`${url.pathname}${url.search}`);
  if (`${url.pathname}${url.search}` === dataPath) {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(board));
    return;
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const absolute = path.resolve(publicDirectory, relative);
  if (!absolute.startsWith(`${publicDirectory}${path.sep}`)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const data = await fs.readFile(absolute);
    response.writeHead(200, {
      'content-type': contentTypes.get(path.extname(absolute)) ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    response.end(data);
  } catch {
    response.writeHead(404).end();
  }
});

let cdp;
let chromeState;
let temporary;
const removeNetworkListeners = [];
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Smoke server did not bind a TCP port');
  const origin = `http://127.0.0.1:${address.port}`;
  const url = `${origin}/hydro-league-xcpcio/index.html?source=${encodeURIComponent(dataPath)}`;

  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'hydro-league-xcpcio-'));
  const profile = path.join(temporary, 'profile');
  chromeState = launchChrome(chromePath, profile);
  cdp = await CdpConnection.connect(await waitForDevToolsEndpoint(profile, chromeState));

  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  const networkUrls = [];
  const browserErrors = [];
  const inFlightRequests = new Set();
  let lastNetworkActivity = Date.now();
  removeNetworkListeners.push(cdp.on('Network.requestWillBeSent', (message) => {
    if (message.sessionId !== sessionId) return;
    networkUrls.push(message.params.request.url);
    inFlightRequests.add(message.params.requestId);
    lastNetworkActivity = Date.now();
  }));
  const finishRequest = (message) => {
    if (message.sessionId !== sessionId) return;
    inFlightRequests.delete(message.params.requestId);
    lastNetworkActivity = Date.now();
  };
  removeNetworkListeners.push(cdp.on('Network.loadingFinished', finishRequest));
  removeNetworkListeners.push(cdp.on('Network.loadingFailed', finishRequest));
  removeNetworkListeners.push(cdp.on('Runtime.exceptionThrown', (message) => {
    if (message.sessionId !== sessionId) return;
    browserErrors.push(message.params.exceptionDetails.exception?.description
      ?? message.params.exceptionDetails.text
      ?? 'Uncaught browser exception');
  }));
  removeNetworkListeners.push(cdp.on('Log.entryAdded', (message) => {
    if (message.sessionId !== sessionId || message.params.entry.level !== 'error') return;
    browserErrors.push(message.params.entry.text);
  }));
  removeNetworkListeners.push(cdp.on('Runtime.consoleAPICalled', (message) => {
    if (message.sessionId !== sessionId || message.params.type !== 'error') return;
    browserErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
  }));

  await cdp.send('Network.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Log.enable', {}, sessionId);
  const navigation = await cdp.send('Page.navigate', { url }, sessionId);
  if (navigation.errorText) throw new Error(`Chromium navigation failed: ${navigation.errorText}`);

  let rendered = false;
  const renderDeadline = Date.now() + 20_000;
  while (Date.now() < renderDeadline) {
    if (chromeState.error) throw chromeState.error;
    if (process.platform !== 'win32' && childHasExited(chromeState.child)) {
      throw new Error(`Chromium exited while rendering: ${chromeState.stderr.slice(-2_000)}`);
    }
    const evaluation = await cdp.send('Runtime.evaluate', {
      expression: 'document.body?.innerText ?? ""',
      returnByValue: true,
    }, sessionId);
    if (evaluation.result?.value?.includes('Freshman One')) {
      rendered = true;
      break;
    }
    await delay(100);
  }
  if (!rendered) throw new Error('XCPCIO board did not render the mock team within 20 seconds');

  const idleDeadline = Date.now() + 5_000;
  while (Date.now() < idleDeadline && (inFlightRequests.size > 0 || Date.now() - lastNetworkActivity < 500)) {
    await delay(50);
  }
  if (!requests.includes(dataPath)) throw new Error('XCPCIO board did not request the local Hydro JSON proxy');

  const readMedalState = async () => {
    const evaluation = await cdp.send('Runtime.evaluate', {
      expression: `(() => ({
        rows: document.querySelectorAll('table.standings tbody tr.h-10').length,
        gold: document.querySelectorAll('table.standings tbody tr.h-10 > td.stnd.gold').length,
        silver: document.querySelectorAll('table.standings tbody tr.h-10 > td.stnd.silver').length,
        bronze: document.querySelectorAll('table.standings tbody tr.h-10 > td.stnd.bronze').length,
        honorable: document.querySelectorAll('table.standings tbody tr.h-10 > td.stnd.honorable').length,
      }))()`,
      returnByValue: true,
    }, sessionId);
    return evaluation.result?.value;
  };
  const assertMedalState = (group, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Unexpected ${group} medal state: ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`);
    }
  };
  const switchGroup = async (label) => {
    const click = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const item = [...document.querySelectorAll('.second-level-menu-item')]
          .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
        if (!item) return false;
        item.click();
        return true;
      })()`,
      returnByValue: true,
    }, sessionId);
    if (click.result?.value !== true) throw new Error(`XCPCIO group menu item was not found: ${label}`);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const active = await cdp.send('Runtime.evaluate', {
        expression: `document.querySelector('.second-level-menu-item-current')?.textContent?.trim() ?? ''`,
        returnByValue: true,
      }, sessionId);
      if (active.result?.value === label) return;
      await delay(50);
    }
    throw new Error(`XCPCIO did not activate group: ${label}`);
  };

  const medalStates = {};
  medalStates.all = await readMedalState();
  assertMedalState('all', medalStates.all, { rows: 8, gold: 0, silver: 0, bronze: 0, honorable: 0 });
  for (const [key, label, expected] of [
    ['official', 'Official', { rows: 6, gold: 0, silver: 0, bronze: 0, honorable: 0 }],
    ['freshman', 'Freshman', { rows: 4, gold: 1, silver: 1, bronze: 1, honorable: 0 }],
    ['senior', 'Senior', { rows: 2, gold: 1, silver: 0, bronze: 0, honorable: 0 }],
    ['star', 'Star', { rows: 2, gold: 1, silver: 0, bronze: 0, honorable: 0 }],
  ]) {
    await switchGroup(label);
    medalStates[key] = await readMedalState();
    assertMedalState(key, medalStates[key], expected);
  }

  const external = [...new Set(networkUrls.filter(isExternalHttpRequest))];
  if (external.length) throw new Error(`XCPCIO browser attempted external requests: ${external.join(', ')}`);
  if (browserErrors.length) throw new Error(`XCPCIO browser errors: ${browserErrors.join(' | ')}`);
  process.stdout.write(`${JSON.stringify({
    rendered: true,
    requestedLocalJson: true,
    requests: requests.length,
    observedBrowserRequests: networkUrls.length,
    externalRequests: 0,
    browserErrors: 0,
    medalStates,
  })}\n`);
} finally {
  for (const removeListener of removeNetworkListeners) removeListener();
  if (cdp) {
    try {
      await cdp.send('Browser.close', {}, undefined, 2_000);
    } catch {
      // Browser.close commonly closes the socket before sending a response.
    }
    cdp.close();
  }
  await terminateProcessTree(chromeState?.child);
  await closeServer(server);
  await removeTemporaryDirectory(temporary);
}
