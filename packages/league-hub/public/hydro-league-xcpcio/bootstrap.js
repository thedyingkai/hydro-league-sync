const namespace = '/hydro-league-xcpcio/';
const app = document.querySelector('#app');

function fail(message) {
  app.className = 'xcpcio-load-error';
  app.textContent = message;
}

function localDataSource() {
  const requested = new URLSearchParams(window.location.search).get('source');
  if (!requested) throw new TypeError('Missing XCPCIO data source');
  const source = new URL(requested, window.location.origin);
  if (source.origin !== window.location.origin) {
    throw new TypeError('Invalid XCPCIO data source');
  }

  if (source.pathname === '/api/v1/scoreboard/xcpcio.json') {
    if ([...source.searchParams.keys()].length > 0) {
      throw new TypeError('Invalid XCPCIO data source query');
    }
    return { source: `${source.pathname}#allInOne=true`, hub: true };
  }

  const hydro = /^\/d\/[^/]+\/contest\/[a-f\d]{24}\/scoreboard\/(?:leagueboard|league-xcpcio)$/i;
  if (!hydro.test(source.pathname)
    || source.searchParams.get('json') !== 'true'
    || [...source.searchParams.keys()].some((key) => key !== 'json')) {
    throw new TypeError('Invalid XCPCIO data source query');
  }
  return { source: `${source.pathname}?json=true#allInOne=true`, hub: false };
}

function localAsset(value) {
  if (typeof value !== 'string' || !/^vendor\/assets\/[\w.-]+$/.test(value)) {
    throw new TypeError('Invalid XCPCIO asset manifest');
  }
  const asset = new URL(value, `${window.location.origin}${namespace}`);
  if (asset.origin !== window.location.origin || !asset.pathname.startsWith(`${namespace}vendor/assets/`)) {
    throw new TypeError('XCPCIO assets must be self-hosted');
  }
  return asset.pathname;
}

try {
  const dataSource = localDataSource();
  const source = dataSource.source;
  const response = await fetch(`${namespace}asset-manifest.json`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new TypeError('XCPCIO board assets are not installed');
  const manifest = await response.json();
  if (manifest.version !== '0.85.4-league-scoreboard-only.2' || Object.keys(manifest).some((key) => (
    key !== 'version' && key !== 'entry' && key !== 'stylesheet' && key !== 'sha256'
  ))) {
    throw new TypeError('XCPCIO asset manifest version is invalid');
  }
  if (typeof manifest.sha256 !== 'string' || !/^[a-f\d]{64}$/.test(manifest.sha256)) {
    throw new TypeError('XCPCIO asset manifest digest is invalid');
  }
  const entry = localAsset(manifest.entry);
  const stylesheet = localAsset(manifest.stylesheet);

  window.CDN_HOST = `${namespace}vendor/`;
  window.__toAssetUrl = (value) => new URL(value, `${window.location.origin}${window.CDN_HOST}`).pathname;
  window.DATA_HOST = '/';
  window.DATA_REGION = 'Hydro';
  window.DEFAULT_LANG = document.documentElement.lang;
  window.DATA_SOURCE = source;
  window.REFETCH_INTERVAL = 15_000;
  window.RUNTIME_CONFIG = {
    component: 'board',
    dataSource: source,
    baseUrl: '/',
    cdnHost: window.CDN_HOST,
    dataHost: '/',
    dataRegion: 'Hydro',
    defaultLang: document.documentElement.lang,
    refetchInterval: window.REFETCH_INTERVAL,
    ...(dataSource.hub ? { sourceCodeUrl: '/source' } : {}),
  };

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = stylesheet;
  document.head.append(link);
  await import(entry);
} catch (error) {
  fail(error instanceof Error ? error.message : 'XCPCIO board is unavailable');
}
