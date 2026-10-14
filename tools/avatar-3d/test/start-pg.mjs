// Fresh test-only PostgreSQL instance. No production volume, credentials or configuration are reused.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const runtime = resolve(process.env.AVATAR3D_RUNTIME_ROOT);
const name = `lg-avatar3d-test-${Date.now()}`, volume = `${name}-data`, port = 55433;
const out = resolve('evidence/local', name); mkdirSync(out, { recursive: true });
const credentials = { LG_PG_BOOTSTRAP_USER: 'lg_avatar3d_bootstrap', LG_PG_BOOTSTRAP_DB: 'lg_avatar3d_seed' };
for (const key of ['LG_PG_BOOTSTRAP_PASSWORD', 'LG_PG_MIGRATE_PASSWORD', 'LG_PG_RUNTIME_PASSWORD', 'LG_PG_READONLY_PASSWORD', 'LG_PG_TEST_PASSWORD']) credentials[key] = randomBytes(24).toString('hex');
const file = resolve(out, 'credentials.private.env'); assert.ok(!existsSync(file));
writeFileSync(file, Object.entries(credentials).map(([k, v]) => `${k}=${v}`).join('\n'));
const env = { ...process.env, ...credentials, POSTGRES_USER: credentials.LG_PG_BOOTSTRAP_USER, POSTGRES_PASSWORD: credentials.LG_PG_BOOTSTRAP_PASSWORD,
  POSTGRES_DB: credentials.LG_PG_BOOTSTRAP_DB, POSTGRES_INITDB_ARGS: '--data-checksums', PGDATA: '/var/lib/postgresql/data/pgdata' };
const image = 'pgvector/pgvector@sha256:ac08538c6f8b9904c33c8224c5e5706dbe760aca29db1d096972b4052c22a75d';
const args = ['run', '-d', '--pull=never', '--name', name, '--label', 'lg.avatar3d-test=1', '--restart', 'no', '-p', `127.0.0.1:${port}:5432`,
  '--mount', `type=volume,source=${volume},target=/var/lib/postgresql/data`,
  '--mount', `type=bind,source=${resolve(runtime, 'scripts/postgresql/init')},target=/docker-entrypoint-initdb.d,readonly`,
  '--mount', `type=bind,source=${resolve(runtime, 'scripts/postgresql')},target=/opt/lg,readonly`];
for (const key of [...Object.keys(credentials).filter(k => k.endsWith('_PASSWORD')), 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB', 'POSTGRES_INITDB_ARGS', 'PGDATA']) args.push('-e', key);
args.push(image, 'postgres', '-c', 'fsync=on', '-c', 'synchronous_commit=on');
const created = spawnSync('docker', args, { env, encoding: 'utf8' }); assert.equal(created.status, 0, created.stderr);
let ready = false;
for (let i = 0; i < 60; i++) {
  const probe = spawnSync('docker', ['exec', name, 'pg_isready', '-U', credentials.LG_PG_BOOTSTRAP_USER, '-d', credentials.LG_PG_BOOTSTRAP_DB], { encoding: 'utf8' });
  if (probe.status === 0) { ready = true; break; } await delay(1000);
}
assert.ok(ready, 'dedicated PostgreSQL readiness');
const manifest = { name, volume, port, image, credentialsFile: file, productionVolumeUsed: false, autoRestart: false };
writeFileSync(resolve(out, 'server.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest));
