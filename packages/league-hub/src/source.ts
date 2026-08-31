import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, type Zippable } from 'fflate';

const archiveMtime = new Date('1980-01-01T00:00:00.000Z');
let correspondingSourceCache: Uint8Array | null = null;

function packageRoot(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (dirname(current) !== current) {
    const manifest = join(current, 'package.json');
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
        if (parsed.name === '@hydro-league-sync/league-hub') return current;
      } catch {
        // Keep walking; a parent manifest may be the package root.
      }
    }
    current = dirname(current);
  }
  throw new Error('Unable to locate the league-hub package source');
}

function regularFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) return regularFiles(path);
      return entry.isFile() ? [path] : [];
    });
}

function addFile(files: Zippable, diskPath: string, archivePath: string): void {
  if (!existsSync(diskPath)) return;
  files[archivePath.replaceAll('\\', '/')] = [new Uint8Array(readFileSync(diskPath)), { mtime: archiveMtime }];
}

function addTree(files: Zippable, diskRoot: string, archiveRoot: string): void {
  for (const path of regularFiles(diskRoot)) {
    addFile(files, path, join(archiveRoot, relative(diskRoot, path)));
  }
}

/** Builds a deterministic corresponding-source archive from an explicit allowlist. */
export function buildCorrespondingSourceZip(): Uint8Array {
  if (correspondingSourceCache) return correspondingSourceCache;
  const hubRoot = packageRoot();
  const candidateRepoRoot = resolve(hubRoot, '..', '..');
  const repoManifest = join(candidateRepoRoot, 'package.json');
  const repoRoot = existsSync(repoManifest) ? candidateRepoRoot : hubRoot;
  const protocolRoot = join(repoRoot, 'packages', 'protocol');
  const files: Zippable = {};

  for (const name of [
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    '.npmrc',
    '.env.example',
    '.dockerignore',
    'Dockerfile.hub',
    'compose.local.yml',
    'README.md',
    'LICENSE',
    'NOTICE',
  ]) {
    addFile(files, join(repoRoot, name), join('hydro-league-sync', name));
  }
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', 'NOTICE']) {
    addFile(files, join(hubRoot, name), join('hydro-league-sync', 'packages', 'league-hub', name));
  }
  addTree(files, join(hubRoot, 'src'), join('hydro-league-sync', 'packages', 'league-hub', 'src'));
  addTree(files, join(hubRoot, 'test'), join('hydro-league-sync', 'packages', 'league-hub', 'test'));
  addTree(files, join(hubRoot, 'tools'), join('hydro-league-sync', 'packages', 'league-hub', 'tools'));
  addTree(files, join(hubRoot, 'public'), join('hydro-league-sync', 'packages', 'league-hub', 'public'));
  addTree(files, join(hubRoot, 'upstream'), join('hydro-league-sync', 'packages', 'league-hub', 'upstream'));

  if (existsSync(protocolRoot)) {
    for (const name of ['package.json', 'tsconfig.json', 'tsconfig.test.json', 'vitest.config.ts', 'README.md']) {
      addFile(files, join(protocolRoot, name), join('hydro-league-sync', 'packages', 'protocol', name));
    }
    addTree(files, join(protocolRoot, 'src'), join('hydro-league-sync', 'packages', 'protocol', 'src'));
    addTree(files, join(protocolRoot, 'test'), join('hydro-league-sync', 'packages', 'protocol', 'test'));
  }

  if (Object.keys(files).length === 0) throw new Error('No corresponding source files were found');
  correspondingSourceCache = zipSync(files, { level: 6 });
  return correspondingSourceCache;
}
