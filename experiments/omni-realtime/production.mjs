import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { appendFileSync, mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { startServer } from './server.mjs';
import { startLG } from './lg-process.mjs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

loadEnvFile(process.env.OMNI_PRODUCTION_VOICE_ENV_FILE || fileURLToPath(new URL('.env.local', import.meta.url)));
const local = process.env.LG_3D_OPERATION_ROOT
  ? process.env.LG_3D_OPERATION_ROOT + '/artifacts/post-lv2/local/activation-3d-omni-20261014/'
  : fileURLToPath(new URL('../../artifacts/post-lv2/local/activation-3d-omni-20261014/', import.meta.url));
mkdirSync(local, { recursive: true });
const log = local + 'production-core.local.log';
const sentinel = local + 'STOP';
if (existsSync(sentinel)) unlinkSync(sentinel);
const operationRoot = process.env.LG_3D_OPERATION_ROOT || fileURLToPath(new URL('../../', import.meta.url));
const qqEnv = Object.fromEntries(Object.entries(parse(readFileSync(resolve(operationRoot, '.env.qq'), 'utf8')))
  .filter(([key]) => key.startsWith('QQ_')));
const tokens = qqEnv.QQ_MULTI_USER_ENABLED === 'true'
  ? JSON.parse(readFileSync(resolve(operationRoot, 'artifacts/post-lv2/local/coexist-runtime/entry-tokens.json'), 'utf8')) : undefined;
const coexist = tokens ? { qqEnv, qqPort: tokens.qqPort, qqToken: tokens.qq, avatarPort: tokens.avatarPort, avatarToken: tokens.avatar } : undefined;
const app = await startServer({ live: true, avatar3d: true, production: true,
  coreFactory: options => startLG({ ...options, production: true, coexist, onDiagnostic: line => appendFileSync(log, line + '\n') }) });
writeFileSync(local + 'runtime.json', JSON.stringify({ pid: process.pid, port: app.port, database: 'sumuwei', mode: 'production', startedAt: new Date().toISOString() }, null, 2));
console.log(`LG_3D_OMNI_READY url=http://127.0.0.1:${app.port} database=sumuwei voice=Liora-Mira`);
let stopping = false;
const timer = setInterval(() => { if (existsSync(sentinel)) void stop(); }, 500);
async function stop() {
  if (stopping) return;
  stopping = true; clearInterval(timer);
  const result = await app.close();
  writeFileSync(local + 'closed.json', JSON.stringify({ ...result, closedAt: new Date().toISOString() }, null, 2));
  console.log(`LG_3D_OMNI_CLOSED code=${result?.code}`);
  if (result?.code !== 0) process.exitCode = 1;
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
