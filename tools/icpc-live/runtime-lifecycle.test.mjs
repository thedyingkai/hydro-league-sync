import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDirectory = dirname(fileURLToPath(import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port > 65515 ? freePort() : port;
}

for (const name of ['preview', 'multischool-preview']) {
  test(`${name} cleans its isolated runtime and school children when Java exits during startup`, { timeout: 15000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), 'hydro-lifecycle-test-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const jar = join(directory, 'empty.jar');
    await writeFile(jar, '');
    const report = join(directory, 'report.json');
    const args = ['--experimental-sqlite', join(toolsDirectory, `${name}.mjs`),
      '--jar', jar, '--port', String(await freePort()), '--java', process.execPath, '--no-open'];
    if (name === 'multischool-preview') args.push('--report-file', report);
    // Node deliberately rejects Java's -jar option, exercising an immediate
    // executable failure without requiring a JVM or downloading a Live jar.
    const child = spawn(process.execPath, args, {
      env: { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    assert.notEqual(code, 0, output);
    assert.equal((await readdir(directory)).some((entry) => entry.startsWith('hydro-live-preview-') || entry.startsWith('hydro-three-school-')), false, output);
    if (name === 'multischool-preview') {
      const state = JSON.parse(await readFile(report, 'utf8'));
      assert.equal(state.stopped, true);
      for (const school of state.schools) {
        if (school.pid) assert.throws(() => process.kill(school.pid, 0), /ESRCH/, `School process ${school.pid} is still running`);
      }
    }
  });
}
