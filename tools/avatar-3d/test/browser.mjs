import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createPreviewServer } from '../server.mjs';

const server = createPreviewServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
const errors = [], external = [], results = [];
const modelFile = process.argv[2] || 'sample.vrm';
const evidence = new URL(`../evidence/local/${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url);
await mkdir(evidence, { recursive: true });
let failure = null;
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(`http://127.0.0.1:${server.address().port}/`)) external.push(request.url()); });
const check = (name, condition) => { assert.ok(condition, name); results.push(name); };
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => window.lgAvatar3d?.reading().avatar.loaded, null, { timeout: 60000 });
  await page.locator('#model-file').setInputFiles(fileURLToPath(new URL(`../public/models/${modelFile}`, import.meta.url)));
  await page.waitForFunction(file => document.getElementById('model-label').textContent === file, modelFile);
  check('real VRM loaded, with mouth/blink/happy and head bone', await page.evaluate(() => ['aa', 'blink', 'happy'].every(name => window.lgAvatar3d.capabilities.expressions.includes(name)) && window.lgAvatar3d.capabilities.head));
  check('WebGL issued draw calls', await page.evaluate(() => window.lgAvatar3d.reading().avatar.drawCalls > 0));
  check('both hands rest below shoulders', await page.evaluate(() => window.lgAvatar3d.reading().avatar.arms.every(arm => arm.handY < arm.shoulderY - 0.1)));
  const beforeBreath = await page.evaluate(() => window.lgAvatar3d.reading().avatar.chestRotation[0]);
  await page.waitForFunction(before => Math.abs(window.lgAvatar3d.reading().avatar.chestRotation[0] - before) > 0.001, beforeBreath);
  check('idle breathing changes actual chest bone', true);
  const springBefore = await page.evaluate(() => window.lgAvatar3d.reading().avatar.springRotations);
  check('model contains active spring joints', springBefore.length > 0);
  await page.waitForFunction(() => window.lgAvatar3d.reading().avatar.actualBlink > 0.1, null, { timeout: 10000 });
  check('automatic blink applied to VRM', true);
  await page.getByRole('button', { name: '安慰 · 点头', exact: true }).click();
  await page.locator('#play').click();
  await page.waitForFunction(() => { const a = window.lgAvatar3d.reading().avatar; return a.actualMouth > 0.05 && a.actualHappy > 0.2 && Math.abs(a.headRotation[0]) > 0.005; });
  check('real audio drives mouth, happy expression and nod', true);
  await page.waitForFunction(before => window.lgAvatar3d.reading().avatar.springRotations.some((q, i) => q.some((v, k) => Math.abs(v - before[i][k]) > 0.0001)), springBefore);
  check('spring bone rotations respond while performing', true);
  await page.locator('#interrupt').click();
  await page.waitForFunction(() => { const r = window.lgAvatar3d.reading(); return r.playback.revoked && !r.playback.active && r.avatar.actualMouth === 0 && r.avatar.actualHappy === 0 && Math.abs(r.avatar.nod) < 1e-8; });
  check('interrupt resets actual VRM values', true);
  check('late packet rejected after interrupt', await page.evaluate(() => {
    const p = window.lgAvatar3d.controller, generation = p.reading().generation;
    const audio = { paused: false, ended: false, pause() { this.paused = true; } };
    return !p.start({ version: 'lg-expression@1', generation, replyId: 'late', segmentId: 'late#0', cue: 'natural', expression: 'neutral', gesture: 'none' }, audio) && audio.paused;
  }));
  await page.getByRole('button', { name: '俏皮 · 歪头', exact: true }).click();
  await page.locator('#play').click();
  await page.waitForFunction(() => window.lgAvatar3d.reading().avatar.headRotation[2] > 0.02);
  check('new generation recovers and tilts', true);
  await page.waitForFunction(() => window.lgAvatar3d.reading().playback.state === 'idle', null, { timeout: 10000 });
  check('natural audio end resets mouth and expression', await page.evaluate(() => { const a = window.lgAvatar3d.reading().avatar; return a.actualMouth === 0 && a.actualHappy === 0 && a.expression === 'neutral'; }));
  await page.getByRole('button', { name: '惊讶', exact: true }).click(); await page.locator('#play').click();
  const hasSurprised = await page.evaluate(() => window.lgAvatar3d.capabilities.expressions.includes('surprised'));
  if (hasSurprised) {
    await page.waitForFunction(() => window.lgAvatar3d.reading().avatar.actualSurprised > 0.2);
    check('registered surprised expression applied', true);
  } else {
    await page.waitForFunction(() => { const a = window.lgAvatar3d.reading().avatar; return a.requestedExpression === 'surprised' && a.fallback === 'missing_surprised' && a.expression === 'neutral' && a.actualHappy === 0 && a.actualSurprised === null; });
    check('unregistered surprised expression explicitly falls back to neutral', true);
  }
  await page.locator('#interrupt').click();
  await page.locator('#audio-file').setInputFiles({ name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('broken audio') });
  await page.locator('#play').click();
  await page.waitForFunction(() => document.getElementById('status-text').textContent.includes('失败') || document.getElementById('status-text').textContent.includes('无法播放'));
  check('audio decoding failure resets playback and mouth', await page.evaluate(() => { const r = window.lgAvatar3d.reading(); return r.playback.revoked && !r.playback.active && r.avatar.actualMouth === 0; }));
  await page.locator('#audio-file').setInputFiles([]);
  await page.getByRole('button', { name: '自然', exact: true }).click(); await page.locator('#play').click();
  await page.waitForFunction(() => window.lgAvatar3d.reading().avatar.actualMouth > 0.05);
  check('valid audio recovers after decoding failure', true); await page.locator('#interrupt').click();
  await page.locator('#model-file').setInputFiles({ name: 'broken.vrm', mimeType: 'application/octet-stream', buffer: Buffer.from('not a VRM') });
  await page.waitForFunction(() => document.getElementById('status-text').textContent.includes('模型加载失败'));
  check('invalid model reported while prior model survives', await page.evaluate(() => window.lgAvatar3d.reading().avatar.loaded));
  await page.locator('#model-file').setInputFiles(fileURLToPath(new URL(`../public/models/${modelFile}`, import.meta.url)));
  await page.waitForFunction(() => document.getElementById('status-text').textContent.startsWith('模型就绪'));
  check('local file import recovers', true);
  if (modelFile.startsWith('aoba')) {
    const other = modelFile === 'aoba.vrm' ? 'aoba-hatless.vrm' : 'aoba.vrm';
    await page.locator('#model-select').selectOption(other);
    await page.waitForFunction(label => document.getElementById('model-label').textContent === label, other === 'aoba.vrm' ? '蒼葉 aoba · 戴帽' : '蒼葉 aoba · 无帽');
    check('local model selector switches variants', await page.evaluate(() => window.lgAvatar3d.capabilities.version === '0' && window.lgAvatar3d.reading().avatar.arms.every(arm => arm.handY < arm.shoulderY - 0.1)));
    await page.locator('#model-select').selectOption(modelFile);
    await page.waitForFunction(label => document.getElementById('model-label').textContent === label, modelFile === 'aoba.vrm' ? '蒼葉 aoba · 戴帽' : '蒼葉 aoba · 无帽');
    check('local model selector restores target variant', true);
  }
  await page.screenshot({ path: fileURLToPath(new URL('desktop.png', evidence)) });
  await page.setViewportSize({ width: 430, height: 932 });
  check('mobile has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: fileURLToPath(new URL('mobile.png', evidence)) });
  check('no remote browser requests', external.length === 0); check('no unhandled page errors', errors.length === 0);
} catch (error) {
  failure = error.message;
  await page.screenshot({ path: fileURLToPath(new URL('failure.png', evidence)) }).catch(() => {});
  throw error;
} finally {
  const finalReading = await page.evaluate(() => window.lgAvatar3d?.reading()).catch(() => null);
  await writeFile(new URL('browser.json', evidence), JSON.stringify({ modelFile, measured_count: results.length, passed: results, failure, errors, external, finalReading, engine: await browser.version() }, null, 2));
  await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
console.log(JSON.stringify({ browserChecks: results.length, errors, external, evidence: fileURLToPath(evidence) }));
