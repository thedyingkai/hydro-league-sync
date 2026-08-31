import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalRequest,
  createSignedHeaders,
  sha256Hex,
  verifyRequest,
} from '../src/index.js';

describe('HMAC request authentication', () => {
  const body = canonicalJson({ z: 2, nested: { b: true, a: null }, a: [3, 'x'] });
  const signed = {
    method: 'POST',
    path: '/api/v1/sites/site-1/events:batch?mode=append',
    siteId: 'site-1',
    body,
    secret: 'test-secret',
    timestamp: 1_788_134_400,
    nonce: 'abcdefghijklmnop',
  } as const;

  it('canonicalizes JSON object keys recursively', () => {
    expect(body).toBe('{"a":[3,"x"],"nested":{"a":null,"b":true},"z":2}');
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('creates and verifies deterministic signed headers', () => {
    const headers = createSignedHeaders(signed);
    expect(headers['x-hydro-league-site-id']).toBe('site-1');
    expect(verifyRequest({
      method: signed.method,
      path: signed.path,
      body,
      secret: signed.secret,
      headers,
      nowSeconds: signed.timestamp,
    })).toEqual({
      ok: true,
      siteId: 'site-1',
      timestamp: signed.timestamp,
      nonce: signed.nonce,
    });
  });

  it('binds the signature to raw path and body bytes', () => {
    const headers = createSignedHeaders(signed);
    expect(verifyRequest({
      method: signed.method,
      path: `${signed.path}&extra=1`,
      body,
      secret: signed.secret,
      headers,
      nowSeconds: signed.timestamp,
    })).toEqual({ ok: false, reason: 'invalid_signature' });
    expect(verifyRequest({
      method: signed.method,
      path: signed.path,
      body: `${body}\n`,
      secret: signed.secret,
      headers,
      nowSeconds: signed.timestamp,
    })).toEqual({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects stale requests before nonce replay processing', () => {
    const headers = createSignedHeaders(signed);
    expect(verifyRequest({
      method: signed.method,
      path: signed.path,
      body,
      secret: signed.secret,
      headers,
      nowSeconds: signed.timestamp + 301,
    })).toEqual({ ok: false, reason: 'timestamp_out_of_window' });
  });

  it('rejects non-JSON values and unsafe request paths', () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(TypeError);
    expect(() => canonicalRequest({ ...signed, path: '/ok\nnot-ok' })).toThrow(TypeError);
  });
});
