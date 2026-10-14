import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPreviewServer } from '../server.mjs';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('preview serves only static assets; no database/config/control surface', async () => {
  const server = createPreviewServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const page = await fetch(base);
    assert.equal(page.status, 200); assert.match(await page.text(), /未连接聊天/);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'self' blob:/);
    assert.equal((await fetch(base + '/vendor/vrm.js')).status, 200);
    assert.equal((await fetch(base + '/vendor/three/examples/jsm/loaders/GLTFLoader.js')).status, 200);
    for (const path of ['/.env', '/package.json', '/.git/config', '/src/main.ts', '/lg/status', '/dev/query/memory', '/%2e%2e%2f.env', '/%ZZ']) {
      assert.ok([403, 404].includes((await fetch(base + path)).status), path);
    }
    assert.equal((await fetch(base + '/', { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(base + '/playback.js', { method: 'HEAD' })).status, 200);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('live proxy is opt-in, loopback-only, limited to voice routes and serves only the canonical factory', async () => {
  assert.throws(() => createPreviewServer({ shellUrl: 'https://example.com' }));
  assert.throws(() => createPreviewServer({ shellUrl: 'http://127.0.0.1:12393' }));
  const root = mkdtempSync(join(tmpdir(), 'lg-3d-proxy-'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/postlv2_speech_client.js'), "import { expressionPlayback } from './postlv2_expression_client.js';\nexport function createSpeechPlayback() {}\nexport const speechPlayback = legacyDocumentBinding();");
  const received = [];
  const shell = createServer(async (req, res) => { let body = ''; for await (const part of req) body += part; received.push({ path: req.url, body }); res.setHeader('Content-Type', 'application/json'); res.end('{"accepted":true}'); });
  shell.listen(0, '127.0.0.1'); await once(shell, 'listening');
  const server = createPreviewServer({ shellUrl: `http://127.0.0.1:${shell.address().port}`, runtimeRoot: root });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(base + '/session.json').then(r => r.json())).live, true);
    const factory = await fetch(base + '/lg-adapter/speech.js').then(r => r.text());
    assert.match(factory, /export function createSpeechPlayback/); assert.doesNotMatch(factory, /expressionPlayback|legacyDocumentBinding/);
    assert.equal((await fetch(base + '/lg/playback', { method: 'POST', body: '{"state":"played"}', headers: { origin: base } })).status, 200);
    assert.deepEqual(received, [{ path: '/lg/playback', body: '{"state":"played"}' }]);
    assert.equal((await fetch(base + '/lg/interrupt', { method: 'POST', headers: { origin: 'http://evil.invalid' } })).status, 403);
    assert.equal((await fetch(base + '/lg/opportunity', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/scripts/postlv2_vtuber_runtime.py')).status, 404);
    assert.equal(received.length, 1);
  } finally {
    server.closeAllConnections(); shell.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => shell.close(r))]); rmSync(root, { recursive: true });
  }
});
