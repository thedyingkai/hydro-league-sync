#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function javaArguments({ jar, profileDirectory, port = 8080 }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('port must be between 1 and 65535');
  return [
    '-jar', jar,
    `--config-directory=${profileDirectory}`,
    `--creds=${join(profileDirectory, 'creds.json')}`,
    '--no-auth',
    '--ktor-arg=-host=127.0.0.1',
    '-p', String(port),
  ];
}

async function main(argv) {
  let jar;
  let port = 8080;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      console.log('node start.mjs --jar /path/to/live-v3.5.1.jar [--port 8080]');
      return;
    }
    if (!['--jar', '--port'].includes(argument)) throw new Error(`Unknown argument: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    if (argument === '--jar') jar = value;
    else if (!/^\d+$/.test(value)) throw new Error('--port must be an integer');
    else port = Number(value);
  }
  if (!jar) throw new Error('--jar is required (ICPC Live v3.5.1, Java 17 or later)');
  const profileDirectory = dirname(fileURLToPath(import.meta.url));
  for (const filename of ['settings.json', 'advanced.json', 'creds.json']) await access(join(profileDirectory, filename));
  const args = javaArguments({ jar: await realpath(resolve(jar)), profileDirectory, port });
  console.log(`ICPC Live admin: http://127.0.0.1:${port}/admin`);
  console.log(`OBS browser source: http://127.0.0.1:${port}/overlay?noStatus&teamMediaAudio=false`);
  const child = spawn('java', args, { cwd: profileDirectory, stdio: 'inherit', shell: false, windowsHide: true });
  const stop = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') {
      // Oracle javapath can spawn a second java.exe. Terminate only our still-running
      // child and its descendants, otherwise a stopped launcher can leave Live running.
      const cleanup = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', shell: false, windowsHide: true,
      });
      cleanup.once('error', () => child.kill('SIGTERM'));
    } else child.kill('SIGTERM');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  child.once('error', (error) => {
    console.error(`Unable to start Java: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
