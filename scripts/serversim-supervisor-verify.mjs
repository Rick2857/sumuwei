import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform, 'linux', 'run inside serversim')
const directory = mkdtempSync(join(tmpdir(), 'lg-relay-supervisor-'))
const marker = join(directory, 'first-exit')
const fixture = join(directory, 'child.mjs')
writeFileSync(fixture, `import { existsSync, writeFileSync } from 'node:fs';
if (!existsSync(${JSON.stringify(marker)})) { writeFileSync(${JSON.stringify(marker)}, '1'); process.exit(1) }
process.once('SIGINT', () => process.exit(0)); setInterval(() => {}, 1000);
`)
const child = spawn(process.execPath, [resolve('serversim/supervisor.mjs')], { env: { ...process.env,
  SIM_STATE_DIR: directory, SIM_RESTART_SEC: '3', SIM_STOP_TIMEOUT_SEC: '5', SIM_SERVICE_COMMAND: `${process.execPath} ${fixture}` }, stdio: ['ignore', 'pipe', 'pipe'] })
let stdout = '', stderr = ''
child.stdout.on('data', data => { stdout += data })
child.stderr.on('data', data => { stderr += data })
const exited = new Promise(resolveExit => child.once('exit', code => resolveExit(code)))
try {
  await delay(6500)
  const starts = stdout.split('\n').filter(line => line.includes('"event":"starting"'))
  assert.equal(starts.length, 2, `heartbeat restart and delayed restart must not launch parallel service groups: ${stdout}\n${stderr}`)
  console.log('PASS supervisor: failed child restarts once; delayed timer cannot start a second live process group')
} finally { child.kill('SIGINT'); assert.equal(await exited, 0) }
