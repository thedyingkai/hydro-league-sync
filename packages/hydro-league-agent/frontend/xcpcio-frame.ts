const XCPCIO_DATA_PATH = /^\/d\/[^/]+\/contest\/[a-f\d]{24}\/scoreboard\/(?:leagueboard|league-xcpcio)$/i;

/** Builds a same-origin iframe URL without carrying any client-selected jury flag. */
export function createXcpcioFrameUrl(dataUrl: string, origin: string): string {
  const source = new URL(dataUrl, origin);
  if (source.origin !== origin || !XCPCIO_DATA_PATH.test(source.pathname)) {
    throw new TypeError('XCPCIO data source must be a local league board view');
  }
  if (source.searchParams.get('json') !== 'true' || [...source.searchParams.keys()].some((key) => key !== 'json')) {
    throw new TypeError('XCPCIO data source query is invalid');
  }
  source.hash = '';
  const frame = new URL('/hydro-league-xcpcio/index.html', origin);
  frame.searchParams.set('source', `${source.pathname}?json=true`);
  return `${frame.pathname}${frame.search}`;
}
