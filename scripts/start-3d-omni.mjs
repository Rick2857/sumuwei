import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = resolve(root, 'artifacts/post-lv2/local/omni-production');
if (process.argv.includes('--stop')) {
  mkdirSync(local, { recursive: true });
  writeFileSync(resolve(local, 'STOP'), 'operator_stop\n');
  console.log('3D/Omni: orderly shutdown requested');
} else {
  for (const file of ['.env', 'experiments/omni-realtime/.env.local']) {
    if (!existsSync(resolve(root, file))) throw new Error(`Configure your own ${file} first; see docs/3D-VOICE.md`);
  }
  // This public checkout runs its own source, never a private release manifest.
  const child = spawn(process.execPath, [resolve(root, 'experiments/omni-realtime/production.mjs')], {
    cwd: root, stdio: 'inherit', windowsHide: true,
    env: { ...process.env, LG_3D_OPERATION_ROOT: root,
      OMNI_PRODUCTION_ENV_FILE: resolve(root, '.env'),
      OMNI_PRODUCTION_VOICE_ENV_FILE: resolve(root, 'experiments/omni-realtime/.env.local') },
  });
  child.on('error', () => { console.error('3D/Omni: failed to start'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
  process.once('SIGINT', () => { mkdirSync(local, { recursive: true }); writeFileSync(resolve(local, 'STOP'), 'operator_stop\n'); });
}
