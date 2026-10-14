import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

/** Existing closed bridge protocol, private child, no production core connection. */
export async function startLG({ endpoint, token, onDiagnostic = () => {}, production = false }) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CHARACTER_|OPENAI_|POSTGRES_|PGLITE_|LG_PG_|LG_PRODUCTION_|PROJECT_LG_SANDBOX|OMNI_CORE_)/.test(key)
    && (!production || !/^(https?|all)_proxy$/i.test(key))));
  const child = spawn(process.execPath, [root + 'node_modules/tsx/dist/cli.mjs', root + 'experiments/omni-realtime/lg-core-entry.ts', ...(production ? ['--production'] : [])], {
    cwd: production && process.env.LG_3D_OPERATION_ROOT ? process.env.LG_3D_OPERATION_ROOT : root,
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, OMNI_CORE_REPLY_ENDPOINT: endpoint, OMNI_CORE_REPLY_TOKEN: token },
  });
  const pending = new Map();
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', (code, signal) => {
    exited = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('lg_core_exited')); }
    pending.clear(); resolve({ code, signal });
  }));
  child.on('error', () => onDiagnostic('lg_core_spawn_failed'));
  // Logs can contain prompt/body; never relay them to the browser or public evidence.
  child.stderr.on('data', bytes => onDiagnostic(String(bytes)));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let value; try { value = JSON.parse(line); } catch { onDiagnostic(line); return; }
    const item = pending.get(`${value.kind}:${value.requestId}`);
    if (!item) return;
    pending.delete(`${value.kind}:${value.requestId}`); clearTimeout(item.timer); item.resolve(value);
  });
  function request(value, kind, timeout = 120000) {
    if (exited) return Promise.reject(new Error('lg_core_exited'));
    return new Promise((resolve, reject) => {
      const key = `${kind}:${value.requestId}`;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error('lg_core_timeout')); }, timeout);
      pending.set(key, { resolve, reject, timer });
      child.stdin.write(JSON.stringify(value) + '\n');
    });
  }
  const api = {
    submit(userText, requestId = `omni-${randomUUID()}`) {
      return request({ kind: 'SUBMIT_TURN', requestId, userText, streamSpeech: true }, 'TURN_RESULT');
    },
    cancel(requestId) { return request({ kind: 'CANCEL_TURN', requestId, reason: 'omni_interruption' }, 'CANCEL_RESULT', 15000); },
    async close() {
      for (const key of pending.keys()) if (key.startsWith('TURN_RESULT:')) await api.cancel(key.slice(12)).catch(() => {});
      child.stdin.end();
      const timer = setTimeout(() => onDiagnostic('lg_core_shutdown_pending'), 30000);
      try { return await exit; } finally { clearTimeout(timer); lines.close(); }
    },
  };
  try { await api.cancel('omni-readiness'); } catch (error) { child.stdin.end(); await exit; throw error; }
  return api;
}
