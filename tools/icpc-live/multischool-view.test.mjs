import assert from 'node:assert/strict';
import test from 'node:test';
import { Script } from 'node:vm';
import { multischoolPage } from './multischool-view.mjs';

test('the generated dashboard contains valid browser scripts', () => {
  const html = multischoolPage('http://127.0.0.1:8080');
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, 'The dashboard must contain its update script');
  for (const [index, match] of scripts.entries()) {
    assert.doesNotThrow(() => new Script(match[1], { filename: `dashboard-${index}.js` }));
  }
});
