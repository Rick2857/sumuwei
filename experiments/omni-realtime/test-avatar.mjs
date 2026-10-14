import assert from 'node:assert/strict';
import { chromium } from '../../tools/avatar-3d/node_modules/playwright/index.mjs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { startServer } from './server.mjs';
import { startLG } from './lg-process.mjs';

const live = process.argv.includes('--live');
if (live) loadEnvFile(fileURLToPath(new URL('.env.local', import.meta.url)));
const evidence = new URL(`live-runs/avatar-${Date.now()}/`, import.meta.url);
mkdirSync(evidence, { recursive: true });
const errors = [], events = [], mouths = [];
const app = await startServer({ port: 0, live, avatar3d: true, ...(live ? { coreFactory: options => startLG({ ...options,
  onDiagnostic: line => appendFileSync(new URL('core.local.log', evidence), line + '\n') }) } : {}) });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1250, height: 1000 } });
page.on('pageerror', e => errors.push(e.message));
page.on('websocket', ws => ws.on('framereceived', ({ payload }) => { try { events.push(JSON.parse(payload)); } catch {} }));
let failure, shutdown;
try {
  await page.goto(`http://127.0.0.1:${app.port}`);
  await page.waitForFunction(() => window.lgAvatar3d?.reading().avatar.loaded, { timeout: 30000 });
  assert.ok((await page.evaluate(() => window.lgAvatar3d.reading().avatar)).drawCalls > 0);
  await page.click('#connect');
  await page.waitForFunction(() => !document.getElementById('submit').disabled, { timeout: 30000 });
  await page.fill('#text', live ? '17乘24是多少？请直接简短回答。' : '播放测试');
  await page.click('#submit');
  for (let i = 0; i < 1000; i++) {
    mouths.push(await page.evaluate(() => window.lgAvatar3d.reading().avatar.actualMouth));
    if (mouths.at(-1) > 0.02) break;
    await page.waitForTimeout(100);
  }
  assert.ok(mouths.some(x => x > 0.02), 'actual scheduled PCM must move the VRM mouth');
  if (live) {
    await page.waitForFunction(() => document.getElementById('log').textContent.includes('lg_turn_result'), { timeout: 120000 });
    const result = events.find(x => x.type === 'lg.turn_result');
    assert.equal(result?.outcome, 'replied');
    assert.match(await page.locator('#transcript').innerText(), /408|四百零八/);
  }
  await page.waitForFunction(() => window.lgAvatar3d.reading().queued === 0 && window.lgAvatar3d.reading().avatar.actualMouth === 0, { timeout: 60000 });
  await page.fill('#text', live ? '请慢慢介绍一下四季的景色，稍微长一点。' : '第二轮');
  await page.click('#submit');
  await page.waitForFunction(() => window.lgAvatar3d.reading().avatar.actualMouth > 0.02, { timeout: 120000 });
  await page.click('#interrupt');
  await page.waitForFunction(() => window.lgAvatar3d.reading().queued === 0 && window.lgAvatar3d.reading().avatar.actualMouth === 0);
  await page.waitForTimeout(1000);
  assert.equal(await page.evaluate(() => window.lgAvatar3d.reading().avatar.actualMouth), 0);
  if (live) assert.ok(events.some(x => x.type === 'lg.cancel_result'), 'LG cancellation ACK required');
  assert.deepEqual(errors, []);
  await page.screenshot({ path: fileURLToPath(new URL('page.png', evidence)) });
} catch (e) { failure = e; }
finally {
  await browser.close(); shutdown = await app.close();
  if (live && shutdown?.code !== 0) failure ??= Error('core_shutdown_failed');
  const result = { status: failure ? 'FAIL' : 'PASS', live, actualMouthObserved: mouths.some(x => x > 0.02),
    errors, reason: failure?.message, coreShutdown: shutdown, eventTypes: events.map(e => e.type) };
  writeFileSync(new URL('result.json', evidence), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, eventTypes: [...new Set(result.eventTypes)], evidence: fileURLToPath(evidence) }));
}
if (failure) process.exitCode = 1;
