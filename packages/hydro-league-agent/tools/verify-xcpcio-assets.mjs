import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const namespace = path.join(packageDirectory, 'public', 'hydro-league-xcpcio');
const vendor = path.join(namespace, 'vendor');
const expected = {
  version: '0.85.4-league-scoreboard-only.2',
  entry: 'vendor/assets/index-CCpXRCnK.js',
  stylesheet: 'vendor/assets/index-BNXIDeGh.css',
  sha256: '1090eb94a2b162b7cf1532bcca80a2f0afb118850dd3e1a8eb40234dab555138',
  files: 15,
  bytes: 2_546_912,
};
const forbidden = /highcharts|highstock|highsoft|highcharts\.com|\bgsap\b|greensock/i;

async function filesUnder(directory) {
  const result = [];
  const walk = async (current) => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result.push(absolute);
    }
  };
  await walk(directory);
  return result;
}

const manifest = JSON.parse(await fs.readFile(path.join(namespace, 'asset-manifest.json'), 'utf8'));
if (JSON.stringify(manifest) !== JSON.stringify({
  version: expected.version,
  entry: expected.entry,
  stylesheet: expected.stylesheet,
  sha256: expected.sha256,
})) {
  throw new Error('XCPCIO asset manifest does not match the reviewed scoreboard-only build');
}

const files = await filesUnder(vendor);
const digest = createHash('sha256');
let bytes = 0;
const fileSet = new Set();
for (const file of files) {
  const relative = path.relative(vendor, file).replaceAll('\\', '/');
  const data = await fs.readFile(file);
  fileSet.add(relative);
  bytes += data.length;
  digest.update(relative);
  digest.update(Buffer.from([0]));
  digest.update(data);
  digest.update(Buffer.from([0]));
  if (/\.(?:css|html|js|json)$/i.test(file) && forbidden.test(data.toString('utf8'))) {
    throw new Error(`XCPCIO asset ${relative} contains a forbidden non-free dependency marker`);
  }
}
const actualDigest = digest.digest('hex');
if (files.length !== expected.files || bytes !== expected.bytes || actualDigest !== expected.sha256) {
  throw new Error(`XCPCIO asset tree changed: files=${files.length}, bytes=${bytes}, sha256=${actualDigest}`);
}

for (const required of [
  expected.entry,
  expected.stylesheet,
  'XCPCIO-LICENSE.txt',
  'THIRD_PARTY_NOTICES.txt',
]) {
  await fs.access(path.join(namespace, required));
}
for (const required of ['LICENSE', 'FORK.md', 'SCOREBOARD_ONLY.patch']) {
  await fs.access(path.join(
    packageDirectory,
    'upstream',
    'xcpcio-board-app-scoreboard-only',
    required,
  ));
}
for (const file of files.filter((candidate) => candidate.endsWith('.js'))) {
  const source = await fs.readFile(file, 'utf8');
  const sameDirectory = /(?:from\s*|import\s*\()(["'])\.\/([^"']+)\1/g;
  for (const match of source.matchAll(sameDirectory)) {
    const target = path.resolve(path.dirname(file), match[2]);
    if (!target.startsWith(`${vendor}${path.sep}`)) throw new Error(`XCPCIO import leaves vendor namespace: ${match[2]}`);
    await fs.access(target);
  }
  const runtimeAsset = /__toAssetUrl\((["'])assets\/([^"']+)\1\)/g;
  for (const match of source.matchAll(runtimeAsset)) {
    if (!fileSet.has(`assets/${match[2]}`)) throw new Error(`XCPCIO runtime asset is missing: ${match[2]}`);
  }
}

const [wrapper, bootstrap] = await Promise.all([
  fs.readFile(path.join(namespace, 'index.html'), 'utf8'),
  fs.readFile(path.join(namespace, 'bootstrap.js'), 'utf8'),
]);
if (!wrapper.includes("connect-src 'self'") || /googletagmanager|jsdelivr|hm\.baidu/i.test(`${wrapper}\n${bootstrap}`)) {
  throw new Error('XCPCIO wrapper does not preserve the offline CSP boundary');
}

const forkPackage = JSON.parse(await fs.readFile(
  path.join(packageDirectory, 'upstream', 'xcpcio-board-app-scoreboard-only', 'package.json'),
  'utf8',
));
const forkDependencies = { ...forkPackage.dependencies, ...forkPackage.devDependencies };
for (const dependency of ['highcharts', 'highcharts-vue', 'gsap']) {
  if (Object.hasOwn(forkDependencies, dependency)) throw new Error(`Scoreboard-only source still depends on ${dependency}`);
}

process.stdout.write(`Verified XCPCIO scoreboard-only assets (${files.length} files, ${bytes} bytes, ${actualDigest})\n`);
