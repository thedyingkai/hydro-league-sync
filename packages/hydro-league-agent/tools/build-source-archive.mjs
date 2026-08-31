import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(toolsDirectory, '..', '..', '..');
const packageDirectory = path.resolve(toolsDirectory, '..');
const output = path.join(packageDirectory, 'public', 'hydro-league-agent-source.zip');
const archivePrefix = 'hydro-league-sync';

const excludedDirectories = new Set(['.git', 'coverage', 'dist', 'node_modules']);
const excludedFiles = new Set(['hydro-league-agent-source.zip']);
const fixedDosDate = (1 << 5) | 1;
const fixedDosTime = 0;

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  crcTable[index] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function collectFiles(directory, result) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    if (excludedFiles.has(entry.name) || entry.name.endsWith('.tgz') || entry.name.startsWith('.env')) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(absolute, result);
    else if (entry.isFile()) result.push(absolute);
  }
}

async function existingFiles(paths) {
  const result = [];
  for (const candidate of paths) {
    try {
      if ((await fs.stat(candidate)).isFile()) result.push(candidate);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return result;
}

function makeZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name.replaceAll('\\', '/'), 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(fixedDosTime, 10);
    local.writeUInt16LE(fixedDosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(fixedDosTime, 12);
    central.writeUInt16LE(fixedDosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

const protocolDirectory = path.join(workspace, 'packages', 'protocol');
const files = await existingFiles([
  path.join(packageDirectory, 'index.js'),
  path.join(packageDirectory, 'LICENSE'),
  path.join(packageDirectory, 'NOTICE'),
  path.join(packageDirectory, 'package.json'),
  path.join(packageDirectory, 'npm-shrinkwrap.json'),
  path.join(packageDirectory, 'README.md'),
  path.join(packageDirectory, 'tsconfig.json'),
  path.join(packageDirectory, 'vitest.config.mts'),
  path.join(packageDirectory, 'public', 'league-agent.css'),
  path.join(packageDirectory, 'public', 'hydro-league-realboard.css'),
  path.join(protocolDirectory, 'package.json'),
  path.join(protocolDirectory, 'README.md'),
  path.join(protocolDirectory, 'tsconfig.json'),
  path.join(protocolDirectory, 'tsconfig.test.json'),
  path.join(protocolDirectory, 'vitest.config.ts'),
  path.join(workspace, 'LICENSE'),
  path.join(workspace, 'NOTICE'),
  path.join(workspace, 'package.json'),
  path.join(workspace, 'package-lock.json'),
  path.join(workspace, 'tsconfig.base.json'),
]);
for (const directory of ['docs', 'frontend', 'src', 'templates', 'test', 'tools', 'upstream']) {
  await collectFiles(path.join(packageDirectory, directory), files);
}
await collectFiles(path.join(packageDirectory, 'public', 'hydro-league-xcpcio'), files);
for (const directory of ['src', 'test']) {
  await collectFiles(path.join(protocolDirectory, directory), files);
}

const unique = [...new Set(files.map((file) => path.resolve(file)))].sort((left, right) => (
  path.relative(workspace, left).localeCompare(path.relative(workspace, right), 'en')
));
const entries = await Promise.all(unique.map(async (file) => ({
  name: `${archivePrefix}/${path.relative(workspace, file).replaceAll('\\', '/')}`,
  data: await fs.readFile(file),
})));

if (entries.length > 0xffff) throw new Error('Source archive contains too many files for ZIP32');
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, makeZip(entries));
process.stdout.write(`Wrote ${output} (${entries.length} files)\n`);
