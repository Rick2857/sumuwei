import { spawn, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

/** Bodies and diagnostic logs remain private; the child opens only its isolated database. */
export async function runM111PrivateWorker(mode: 'seed' | 'arm' | 'short', id: string, input: string, output: string, arm: string, control: boolean) {
  const local = resolve('artifacts/m11.1/local')
  if (![input, output].every(path => resolve(path).startsWith(local + sep))) throw new Error('Private worker files required')
  for (const path of [input, output]) execFileSync('git', ['check-ignore', '--quiet', path])
  let log = ''
  const exitCode = await new Promise<number | null>((accept, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('scripts/m11.1-behavior-worker.ts'), mode, id, input, output, arm, control ? 'control' : 'live'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', data => { log += String(data) })
    child.stderr.on('data', data => { log += String(data) })
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); accept(code) })
  })
  writeFileSync(join(dirname(output), `${id}.log`), log)
  return { exitCode, output: existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) as Record<string, any> : {} }
}
