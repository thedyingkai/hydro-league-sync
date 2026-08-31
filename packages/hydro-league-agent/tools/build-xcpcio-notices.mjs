import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forkDirectory = path.resolve(process.argv[2] ?? path.join(
  packageDirectory,
  'upstream',
  'xcpcio-board-app-scoreboard-only',
));
const output = path.join(packageDirectory, 'public', 'hydro-league-xcpcio', 'THIRD_PARTY_NOTICES.txt');

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function resolveDependency(name, fromDirectory) {
  let current = path.resolve(fromDirectory);
  for (;;) {
    const candidate = path.join(current, 'node_modules', ...name.split('/'), 'package.json');
    if (await exists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

const rootManifestPath = path.join(forkDirectory, 'package.json');
const rootManifest = JSON.parse(await fs.readFile(rootManifestPath, 'utf8'));
const pending = [
  ...Object.keys(rootManifest.dependencies ?? {}).map((name) => ({ name, from: forkDirectory, optional: false })),
  ...Object.keys(rootManifest.optionalDependencies ?? {}).map((name) => ({ name, from: forkDirectory, optional: true })),
];
const packages = new Map();
while (pending.length) {
  const request = pending.shift();
  const manifestPath = await resolveDependency(request.name, request.from);
  if (!manifestPath) {
    if (request.optional) continue;
    throw new Error(`Cannot resolve XCPCIO runtime dependency ${request.name} from ${request.from}`);
  }
  const directory = path.dirname(manifestPath);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const key = `${manifest.name}@${manifest.version}`;
  if (packages.has(key)) continue;
  packages.set(key, { directory, manifest });
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    pending.push({ name, from: directory, optional: false });
  }
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    pending.push({ name, from: directory, optional: true });
  }
}

const forbidden = [...packages.keys()].filter((name) => /highcharts|highstock|highsoft|\bgsap@/i.test(name));
if (forbidden.length) throw new Error(`Forbidden XCPCIO dependency in notice closure: ${forbidden.join(', ')}`);

const sections = [];
for (const [key, entry] of [...packages.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))) {
  const repository = typeof entry.manifest.repository === 'string'
    ? entry.manifest.repository
    : entry.manifest.repository?.url;
  const names = (await fs.readdir(entry.directory))
    .filter((name) => /^(?:copying|licen[cs]e|notice)(?:\.|$)/i.test(name))
    .sort((left, right) => left.localeCompare(right, 'en'));
  const texts = [];
  for (const name of names) {
    const file = path.join(entry.directory, name);
    if ((await fs.stat(file)).isFile()) texts.push(`--- ${name} ---\n${(await fs.readFile(file, 'utf8')).trim()}`);
  }
  sections.push([
    '================================================================================',
    key,
    `Declared license: ${entry.manifest.license ?? 'not declared'}`,
    `Source: ${repository ?? entry.manifest.homepage ?? 'not declared'}`,
    texts.length ? texts.join('\n\n') : 'No license file was included in the installed package.',
  ].join('\n'));
}

const header = [
  'THIRD-PARTY NOTICES FOR THE XCPCIO SCOREBOARD-ONLY WEB ASSETS',
  '',
  'Generated from the installed runtime dependency closure used to build the',
  'pinned @xcpcio/board-app@0.85.4 scoreboard-only fork. Inclusion here does',
  'not change the license of any dependency. The fork itself is covered by',
  'the XCPCIO MIT license stored under upstream/xcpcio-board-app-scoreboard-only.',
  '',
].join('\n');
await fs.writeFile(output, `${header}${sections.join('\n\n')}\n`, 'utf8');
process.stdout.write(`Wrote ${output} (${packages.size} dependency packages)\n`);
