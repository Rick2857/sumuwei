import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

/** Existing closed bridge protocol, private child, no production core connection. */
export async function startLG({ endpoint, token, onDiagnostic = () => {}, production = false, coexist }) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(CHARACTER_|OPENAI_|POSTGRES_|PGLITE_|LG_PG_|LG_PRODUCTION_|PROJECT_LG_SANDBOX|OMNI_CORE_)/.test(key)
    && (!production || !/^(https?|all)_proxy$/i.test(key))));
  const child = spawn(process.execPath, [root + 'node_modules/tsx/dist/cli.mjs', root + 'experiments/omni-realtime/lg-core-entry.ts', ...(production ? ['--production'] : []), ...(coexist ? ['--coexist'] : [])], {
    cwd: production && process.env.LG_3D_OPERATION_ROOT ? process.env.LG_3D_OPERATION_ROOT : root,
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...env, ...(coexist ? { ...coexist.qqEnv, CHARACTER_COEXIST_QQ_PORT: String(coexist.qqPort),
      CHARACTER_COEXIST_QQ_TOKEN: coexist.qqToken, CHARACTER_COEXIST_AVATAR_PORT: String(coexist.avatarPort),
      CHARACTER_COEXIST_AVATAR_TOKEN: coexist.avatarToken } : {}), OMNI_CORE_REPLY_ENDPOINT: endpoint, OMNI_CORE_REPLY_TOKEN: token },
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
  let transport = child.stdin, socket, protocolLines, qqShell, qqExit;
  let readyResolve, readyReject;
  const coreReady = new Promise((done, reject) => { readyResolve = done; readyReject = reject; });
  const lines = createInterface({ input: child.stdout });
  const readProtocol = line => {
    let value; try { value = JSON.parse(line); } catch { onDiagnostic(line); return; }
    const item = pending.get(`${value.kind}:${value.requestId}`);
    if (!item) return;
    pending.delete(`${value.kind}:${value.requestId}`); clearTimeout(item.timer); item.resolve(value);
  };
  lines.on('line', line => {
    if (coexist) {
      if (line.startsWith('COEXIST_READY')) readyResolve();
      onDiagnostic(line);
    } else readProtocol(line);
  });
  if (coexist) {
    const timer = setTimeout(() => readyReject(new Error('lg_coexist_start_timeout')), 120000);
    child.once('exit', () => readyReject(new Error('lg_coexist_exited_before_ready')));
    try {
      await coreReady;
      socket = connect({ host: '127.0.0.1', port: coexist.avatarPort });
      socket.on('error', () => onDiagnostic('lg_avatar_transport_error'));
      await new Promise((done, reject) => { socket.once('connect', done); socket.once('error', reject); });
      socket.write(`LG_ENTRY ${coexist.avatarToken} v1\n`);
      protocolLines = createInterface({ input: socket });
      protocolLines.on('line', readProtocol); transport = socket;
      qqShell = spawn(process.execPath, [root + 'node_modules/tsx/dist/cli.mjs', root + 'scripts/qq/chat.ts'], {
        cwd: production && process.env.LG_3D_OPERATION_ROOT ? process.env.LG_3D_OPERATION_ROOT : root,
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...env,
          QQ_COEXIST_CONNECT_PORT: String(coexist.qqPort), QQ_COEXIST_CONNECT_TOKEN: coexist.qqToken },
      });
      qqExit = new Promise(done => qqShell.once('exit', (code, signal) => done({ code, signal })));
      qqShell.stdout.on('data', bytes => onDiagnostic(String(bytes)));
      qqShell.stderr.on('data', bytes => onDiagnostic(String(bytes)));
      qqShell.on('error', () => onDiagnostic('lg_qq_shell_spawn_failed'));
    } catch (error) { socket?.end(); child.stdin.end(); await exit; throw error; }
    finally { clearTimeout(timer); }
  }
  function request(value, kind, timeout = 120000) {
    if (exited) return Promise.reject(new Error('lg_core_exited'));
    return new Promise((resolve, reject) => {
      const key = `${kind}:${value.requestId}`;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error('lg_core_timeout')); }, timeout);
      pending.set(key, { resolve, reject, timer });
      transport.write(JSON.stringify(value) + '\n');
    });
  }
  const api = {
    submit(userText, requestId = `omni-${randomUUID()}`) {
      return request({ kind: 'SUBMIT_TURN', requestId, userText, streamSpeech: true }, 'TURN_RESULT');
    },
    cancel(requestId) { return request({ kind: 'CANCEL_TURN', requestId, reason: 'omni_interruption' }, 'CANCEL_RESULT', 15000); },
    async close() {
      for (const key of pending.keys()) if (key.startsWith('TURN_RESULT:')) await api.cancel(key.slice(12)).catch(() => {});
      if (qqShell) { qqShell.stdin.end(); const stopped = await qqExit;
        if (stopped.code !== 0) onDiagnostic('lg_qq_shell_close_failed'); }
      socket?.end();
      child.stdin.end();
      const timer = setTimeout(() => onDiagnostic('lg_core_shutdown_pending'), 30000);
      try { return await exit; } finally { clearTimeout(timer); lines.close(); protocolLines?.close(); }
    },
  };
  try { await api.cancel('omni-readiness'); } catch (error) { child.stdin.end(); await exit; throw error; }
  return api;
}
