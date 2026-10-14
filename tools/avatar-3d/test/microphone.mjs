// Native browser capture with a fake device; protocol checks only, no claim of ASR or human audio.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { createPreviewServer, closePreviewServer } from '../server.mjs';
const out = resolve('evidence/local', `microphone-${new Date().toISOString().replace(/[:.]/g, '-')}`); mkdirSync(out, { recursive: true });
const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const shell = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ mode: 'sandbox-copy', lg_process_alive: true })); });
shell.listen(0, '127.0.0.1'); await once(shell, 'listening');
const server = createPreviewServer({ shellUrl: `http://127.0.0.1:${shell.address().port}`, runtimeRoot: resolve(process.env.AVATAR3D_RUNTIME_ROOT) });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const page = await browser.newPage({ permissions: ['microphone'], viewport: { width: 1360, height: 940 } });
let failure = null;
try {
  await page.addInitScript(() => {
    window.micProbe = { calls: 0, tracks: [], sent: [], denied: false };
    const get = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async options => {
      window.micProbe.calls++;
      if (window.micProbe.denied) throw new DOMException('permission fixture', 'NotAllowedError');
      const stream = await get(options); window.micProbe.tracks.push(...stream.getTracks()); return stream;
    };
    window.WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor() { setTimeout(() => this.onopen?.(), 0); }
      send(text) { window.micProbe.sent.push(JSON.parse(text)); }
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.lgAvatar3d?.reading().live?.connected);
  check('connection never requests microphone', await page.evaluate(() => window.micProbe.calls === 0));
  await page.locator('#microphone').click(); await page.waitForFunction(() => window.lgAvatar3d.reading().live.recording);
  await page.waitForTimeout(900); await page.locator('#interrupt').click();
  check('cancelled recording releases native tracks and sends no audio', await page.evaluate(() => window.micProbe.tracks.every(t => t.readyState === 'ended') && !window.micProbe.sent.some(p => p.type === 'mic-audio-data')));
  await page.locator('#microphone').click(); await page.waitForFunction(() => window.lgAvatar3d.reading().live.recording);
  await page.waitForTimeout(900); await page.locator('#microphone').click();
  check('explicit submit sends mono float PCM and mic-audio-end in order', await page.evaluate(() => {
    const sent = window.micProbe.sent, chunks = sent.filter(p => p.type === 'mic-audio-data');
    return chunks.length > 0 && chunks.every(p => p.audio.length === 4096 && p.audio.every(v => Number.isFinite(v) && Math.abs(v) <= 1)) && sent.at(-1).type === 'mic-audio-end';
  }));
  check('submit releases native microphone tracks', await page.evaluate(() => window.micProbe.tracks.every(t => t.readyState === 'ended') && !window.lgAvatar3d.reading().live.recording));
  await page.locator('#interrupt').click(); await page.evaluate(() => { window.micProbe.denied = true; });
  await page.locator('#microphone').click(); await page.waitForFunction(() => document.getElementById('status-text').textContent.includes('录音失败'));
  check('permission denial is visible and leaves no capture', await page.evaluate(() => !window.lgAvatar3d.reading().live.recording));
  await page.screenshot({ path: resolve(out, 'permission-denied.png') });
} catch (error) { failure = error.message; throw error; }
finally {
  writeFileSync(resolve(out, 'microphone.json'), JSON.stringify({ checks, failure, device: 'Chromium fake audio device', asr: 'NOT RUN' }, null, 2));
  await browser.close(); server.closeAllConnections(); shell.closeAllConnections();
  await Promise.all([new Promise(r => server.close(r)), new Promise(r => shell.close(r))]);
  console.log(JSON.stringify({ checks, failure, evidence: out }));
}
