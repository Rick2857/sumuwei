// Real LG + PostgreSQL + canonical CosyVoice shell + real VRM, only under the test-model wrapper.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createPreviewServer, closePreviewServer } from '../server.mjs';

assert.equal(process.env.DSH_TEST_MODEL_WRAPPER, '1', 'Use with-test-model; never inherit a production model');
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtime = resolve(process.env.AVATAR3D_RUNTIME_ROOT);
const source = resolve(process.env.AVATAR3D_SOURCE_ROOT);
const deps = resolve(process.env.AVATAR3D_DEPS_ROOT);
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(packageRoot, 'evidence/local', `pg-session-${runId}`);
mkdirSync(out, { recursive: true });
const { parse } = createRequire(resolve(runtime, 'package.json'))('dotenv');
const credentials = parse(readFileSync(process.env.AVATAR3D_PG_CREDENTIALS_FILE || resolve(source, 'artifacts/post-lv2/local/pg-migration/pg-trial.env'), 'utf8'));
for (const key of ['LG_PG_BOOTSTRAP_USER', 'LG_PG_BOOTSTRAP_PASSWORD', 'LG_PG_BOOTSTRAP_DB', 'LG_PG_MIGRATE_PASSWORD']) assert.ok(credentials[key], key);
const database = `lg_test_avatar3d_${Date.now()}`;
assert.match(database, /^lg_test_[a-z0-9_]+$/);
const container = process.env.LG_PG_CONTAINER || 'lg-postgresql-trial';
const port = process.env.LG_PG_HOST_PORT || '55432';
const url = new URL(`postgresql://127.0.0.1:${port}/${database}`);
url.username = 'lg_migrate'; url.password = credentials.LG_PG_MIGRATE_PASSWORD;
const production = parse(readFileSync(resolve(source, '.env'), 'utf8')).POSTGRES_URL;
assert.ok(production && new URL(production).pathname !== url.pathname);
const psql = sql => {
  const result = spawnSync('docker', ['exec', '-e', 'PGPASSWORD', container, 'psql', '-h', '127.0.0.1', '-U', 'lg_migrate', '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
    { env: { ...process.env, PGPASSWORD: credentials.LG_PG_MIGRATE_PASSWORD }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
};
const created = spawnSync('docker', ['exec', '-e', 'PGPASSWORD', '-e', 'LG_TEST_DB_NAME', '-e', 'LG_PG_MIGRATE_USER', container, 'psql', '-U', credentials.LG_PG_BOOTSTRAP_USER,
  '-d', credentials.LG_PG_BOOTSTRAP_DB, '-v', 'ON_ERROR_STOP=1', '-f', '/opt/lg/create-test-db.sql'],
  { env: { ...process.env, PGPASSWORD: credentials.LG_PG_BOOTSTRAP_PASSWORD, LG_TEST_DB_NAME: database, LG_PG_MIGRATE_USER: 'lg_migrate' }, encoding: 'utf8' });
assert.equal(created.status, 0, created.stderr);
const freePort = async () => { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const [qqPort, avatarPort] = await Promise.all([freePort(), freePort()]);
const token = randomBytes(24).toString('hex');
const features = Object.fromEntries([...readFileSync(resolve(runtime, 'src/kernel/app/flags.ts'), 'utf8').matchAll(/env\.(CHARACTER_[A-Z_]+_ENABLED)/g)].map(m => [m[1], 'false']));
const env = { ...process.env, ...features, CHARACTER_DB_BACKEND: 'postgres', POSTGRES_URL: url.href, LG_PG_EXPECT_DATABASE: database,
  LG_PRODUCTION_POSTGRES_URL: production, USER_NAME: 'avatar3d-test-owner', CHARACTER_KERNEL_ENABLED: 'true', CHARACTER_MEMORY_ENABLED: 'true',
  CHARACTER_MEMORY_EXPLICIT_ENABLED: 'true', CHARACTER_TOOL_DECISION_MODE: 'rules', CHARACTER_MEMORY_SEMANTIC_MODE: 'off', CHARACTER_MEMORY_WRITE_MODE: 'legacy',
  CHARACTER_ROLLUP_TOKENS: '0', CHARACTER_EXPRESSIVE_SPEECH: 'true', CHARACTER_ENTRY_SCOPED_CONVERSATIONS: 'true',
  CHARACTER_COEXIST_QQ_PORT: String(qqPort), CHARACTER_COEXIST_AVATAR_PORT: String(avatarPort), CHARACTER_COEXIST_QQ_TOKEN: randomBytes(24).toString('hex'),
  CHARACTER_COEXIST_AVATAR_TOKEN: token, QQ_OWNER_ID: '123456789', QQ_BOT_ID: '987654321', QQ_ONEBOT_WS_URL: 'ws://127.0.0.1:6701/',
  QQ_ONEBOT_ACCESS_TOKEN: 'offline-avatar3d-token-1234567890', LOG_LEVEL: 'info' };
const children = [], checks = [], errors = [], external = [], packets = [], playbackVerdicts = [];
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); console.log(`PASS ${name}`); };
const start = (name, exe, args, options) => {
  const child = spawn(exe, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { name, child, text: '', code: null, exited: null };
  state.exited = new Promise(r => child.once('close', code => { state.code = code; r(code); }));
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { state.text += bytes.toString(); });
  children.push(state); return state;
};
const wait = async (label, predicate, timeout = 180000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) { if (await predicate()) return; await delay(250); }
  throw new Error(`${label}: timeout`);
};
let server, browser, page, failure = null, finalReading, shellReading, identity, recognition = null;
const connectionFile = resolve(out, 'connection.private.json');
try {
  const core = start('core', process.execPath, [resolve(runtime, 'node_modules/tsx/dist/cli.mjs'), resolve(runtime, 'avatar3d-core.mjs')], { cwd: runtime, env });
  await wait('core readiness', () => { if (core.child.exitCode !== null) throw new Error('core exited before readiness'); return core.text.includes('COEXIST_READY'); });
  check('actual main.ts coexist core ready on PostgreSQL', core.text.includes('本次实验已隔离（PostgreSQL）'));
  identity = psql('SELECT current_database()'); check('actual database identity is this fresh test database', identity === database);
  if (process.env.AVATAR3D_CORE_ONLY !== '1') {
  writeFileSync(connectionFile, JSON.stringify({ host: '127.0.0.1', port: avatarPort, token, runtimeRoot: runtime, depsRoot: deps }));
  const shell = start('shell', resolve(deps, 'cosyvoice3-venv/Scripts/python.exe'), ['-B', '-X', 'utf8', resolve(packageRoot, 'shell-connected.py'), '--connection', connectionFile],
    { cwd: packageRoot, env: { ...env, PYTHONUTF8: '1' } });
  await wait('shell readiness', () => { if (shell.child.exitCode !== null) throw new Error('shell exited before readiness'); return shell.text.includes('LG_AVATAR_READY'); }, 240000);
  check('canonical shell connected with real TTS and ASR', true);
  server = createPreviewServer({ shellUrl: 'http://127.0.0.1:12393', runtimeRoot: runtime }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  page = await browser.newPage({ viewport: { width: 1360, height: 940 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(base + '/')) external.push(r.url()); });
  page.on('websocket', ws => ws.on('framereceived', ({ payload }) => { try { const p = JSON.parse(String(payload)); if (p.type === 'lg-audio-chunk') packets.push(p); } catch {} }));
  page.on('response', async response => { if (response.url() === base + '/lg/playback') playbackVerdicts.push(await response.json().catch(() => null)); });
  await page.goto(base);
  await page.waitForFunction(() => { const r = window.lgAvatar3d?.reading(); return r?.avatar.loaded && r.live?.connected; }, null, { timeout: 60000 });
  check('Aoba VRM and same-origin live websocket ready', await page.locator('#model-label').textContent() === '蒼葉 aoba · 戴帽');
  await page.locator('#chat-input').fill('晚上好，沐薇。请只用一句简短的话打个招呼。'); await page.locator('#chat-form button').click();
  await page.waitForFunction(() => { const r = window.lgAvatar3d.reading(); return r.playback.active && r.avatar.actualMouth > 0.05; }, null, { timeout: 180000 });
  check('real checked PCM speech starts and moves actual VRM mouth', true);
  await page.screenshot({ path: resolve(out, 'speaking.png') });
  await page.waitForFunction(() => window.lgAvatar3d.reading().live.speech.events.some(e => e.state === 'ended'), null, { timeout: 120000 });
  await wait('accepted played ledger', async () => { shellReading = await fetch(base + '/lg/status').then(r => r.json()); return shellReading.playback_reports?.accepted > 0; }, 30000);
  check('server accepts playback facts', shellReading.playback_reports.accepted > 0);
  await page.waitForFunction(() => { const r = window.lgAvatar3d.reading(); return !r.live.running && r.avatar.actualMouth === 0; });
  check('natural completion resets actual VRM mouth', true);
  const displayed = packets.filter(p => p.display_text?.text);
  check('displayed speech segments match checked text hashes', displayed.length > 0 && displayed.every(p => createHash('sha256').update(p.display_text.text).digest('hex') === p.actions.lg_expression.text_sha256));
  const firstReply = packets[0].actions.lg_expression.replyId;
  const voiceChunks = packets.filter(p => p.actions.lg_expression.replyId === firstReply && p.audio).map(p => Buffer.from(p.audio, 'base64'));
  const f32 = Buffer.concat(voiceChunks), frameCount = f32.length / 4, rate = 24000;
  // Feed a real synthesized greeting through the browser's microphone device and real SenseVoice.
  const wav = Buffer.alloc(44 + (frameCount + rate) * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < frameCount; i++) wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, f32.readFloatLE(i * 4))) * 32767), 44 + i * 2);
  const micFile = resolve(out, 'microphone-from-tts.wav'); writeFileSync(micFile, wav);
  await page.locator('#chat-input').fill('请用三句话介绍你喜欢怎样度过周末。'); await page.locator('#chat-form button').click();
  await page.waitForFunction(() => window.lgAvatar3d.reading().avatar.actualMouth > 0.05, null, { timeout: 180000 });
  await page.locator('#interrupt').click();
  await page.waitForFunction(() => { const r = window.lgAvatar3d.reading(); return r.playback.revoked && !r.playback.active && r.avatar.actualMouth === 0 && r.live.acknowledgements.some(a => a.status === 'acknowledged'); }, null, { timeout: 15000 });
  check('interrupt silences real PCM, resets VRM and receives core ACK', true);
  await delay(2000);
  check('late PCM cannot reopen cancelled mouth', await page.evaluate(() => { const r = window.lgAvatar3d.reading(); return r.playback.revoked && r.avatar.actualMouth === 0; }));
  await browser.close();
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}%noloop`] });
  page = await browser.newPage({ viewport: { width: 1360, height: 940 }, permissions: ['microphone'] });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base); await page.waitForFunction(() => window.lgAvatar3d?.reading().live?.connected, null, { timeout: 60000 });
  check('page never starts microphone on connection', !(await page.evaluate(() => window.lgAvatar3d.reading().live.recording)));
  await page.locator('#microphone').click();
  await page.waitForFunction(() => window.lgAvatar3d.reading().live.recording);
  await delay(Math.ceil(frameCount / rate * 1000) + 1400);
  await page.locator('#microphone').click();
  check('explicit microphone submit releases capture', !(await page.evaluate(() => window.lgAvatar3d.reading().live.recording)));
  await wait('real ASR recognition', async () => { shellReading = await fetch(base + '/lg/status').then(r => r.json()); return shellReading.last_recognition?.final_empty === false; }, 90000);
  recognition = shellReading.last_recognition;
  const transcript = await page.locator('#chat-log p').allTextContents();
  const recognized = transcript.find(text => text.startsWith('语音识别：'))?.slice('语音识别：'.length);
  check('real SenseVoice recognizes browser microphone audio', recognition.speech_detected && !!recognized && createHash('sha256').update(recognized).digest('hex') === recognition.final_text_sha256);
  await page.waitForFunction(() => window.lgAvatar3d.reading().avatar.actualMouth > 0.05, null, { timeout: 180000 });
  check('recognized voice reaches LG and returns actual speaking VRM', true);
  await page.locator('#interrupt').click();
  await page.waitForFunction(() => window.lgAvatar3d.reading().live.acknowledgements.some(a => a.status === 'acknowledged'), null, { timeout: 15000 });
  shellReading = await fetch(base + '/lg/status').then(r => r.json());
  check('no browser external HTTP requests or page errors', external.length === 0 && errors.length === 0);
  finalReading = await page.evaluate(() => window.lgAvatar3d.reading());
  await page.screenshot({ path: resolve(out, 'stopped.png') });
  }
} catch (error) {
  failure = error.message; console.error(failure);
  if (page) { finalReading = await page.evaluate(() => window.lgAvatar3d?.reading()).catch(() => null); await page.screenshot({ path: resolve(out, 'failure.png') }).catch(() => {}); }
} finally {
  await browser?.close();
  if (server) await closePreviewServer(server);
  for (const state of [...children].reverse()) {
    state.child.stdin.end();
    try { await wait(`${state.name} graceful shutdown`, () => state.child.exitCode !== null, 60000); await state.exited; check(`${state.name} exits cleanly`, state.code === 0); }
    catch (error) { failure ||= error.message; }
    const secrets = [url.href, production, ...Object.values(credentials), token, env.CHARACTER_COEXIST_QQ_TOKEN, process.env.OPENAI_API_KEY].filter(Boolean).sort((a, b) => b.length - a.length);
    let safe = state.text; for (const secret of secrets) safe = safe.split(secret).join('[redacted]');
    writeFileSync(resolve(out, `${state.name}.log`), safe);
  }
  try { unlinkSync(connectionFile); } catch {}
  writeFileSync(resolve(out, 'session.json'), JSON.stringify({ runId, container, port, database, identity, replyMaxTokens: env.CHARACTER_REPLY_MAX_TOKENS || 'default:4096', checks, failure, errors, external, recognition, playbackVerdicts, finalReading, shellReading }, null, 2));
  console.log(`Evidence: ${out}`); if (failure) process.exitCode = 1;
}
