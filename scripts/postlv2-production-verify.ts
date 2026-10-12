/** Formal-entry controls and an opt-in real-model copy/restart rehearsal. Never opens the real DB. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { config } from 'dotenv'
import { assertProductionAvatarEnvironment } from './postlv2-production-env.ts'
import { isolateDatabase, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'
import { detectByRule } from '../src/kernel/app/memory/intent-detector.ts'

const root = resolve('.')
const cli = resolve('node_modules/tsx/dist/cli.mjs')
const entry = resolve('scripts/postlv2-bridge-production.ts')
const runId = process.argv[process.argv.indexOf('--run-id') + 1]
if (process.argv.includes('--copy-worker')) {
  assert.match(runId ?? '', /^avatar-production-[0-9]+$/)
  config({ path: '.env', quiet: true })
  const test = config({ path: '.env.test', override: true, quiet: true })
  assert.ok(test.parsed?.OPENAI_API_KEY?.trim(), 'copy rehearsal requires the test key')
  isolateDatabase('avatar-production-rehearsal', { runId, keep: true })
  process.env.CHARACTER_EXPRESSIVE_SPEECH = 'true'
  process.argv = [process.argv[0]!, process.argv[1]!, '--bridge']
  await import('../src/main.ts')
} else {
  const checks: string[] = []
  const check = (name: string, body: () => void) => { body(); checks.push(name) }
  check('default and explicit canonical production paths accepted', () => {
    assertProductionAvatarEnvironment({}, root)
    assertProductionAvatarEnvironment({ PGLITE_DATA_DIR: resolve('data/pglite') }, root)
  })
  check('sandbox, empty sandbox marker, test wrapper and alternate database rejected', () => {
    for (const env of [{ PROJECT_LG_SANDBOX: 'copy' }, { PROJECT_LG_SANDBOX: '' },
      { DSH_TEST_MODEL_WRAPPER: '1' }, { PGLITE_DATA_DIR: tmpdir() }]) {
      assert.throws(() => assertProductionAvatarEnvironment(env, root))
    }
  })
  const fixture = mkdtempSync(resolve(tmpdir(), 'avatar-production-env-'))
  const cleanEnv = { ...process.env }
  delete cleanEnv.PROJECT_LG_SANDBOX
  delete cleanEnv.DSH_TEST_MODEL_WRAPPER
  delete cleanEnv.PGLITE_DATA_DIR
  check('actual bootstrap refuses test inheritance before production configuration', () => {
    const result = spawnSync(process.execPath, [cli, entry], { cwd: fixture,
      env: { ...cleanEnv, DSH_TEST_MODEL_WRAPPER: '1' }, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /refuses sandbox\/test-model/)
  })
  check('actual bootstrap refuses missing production key without falling back', () => {
    const result = spawnSync(process.execPath, [cli, entry], { cwd: fixture, env: cleanEnv, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /requires .env OPENAI_API_KEY/)
  })
  check('production .env cannot silently reroute the formal entry to a sandbox', () => {
    writeFileSync(resolve(fixture, '.env'), 'OPENAI_API_KEY=fixture-key\nPROJECT_LG_SANDBOX=fixture\n')
    const result = spawnSync(process.execPath, [cli, entry], { cwd: fixture, env: cleanEnv, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /refuses sandbox\/test-model/)
  })
  check('launchers force their respective mode after extra args, use CRLF and stay ASCII', () => {
    for (const [file, mode] of [['postlv2-avatar.cmd', 'sandbox-copy'], ['postlv2-avatar-production.cmd', 'production']]) {
      const text = readFileSync(resolve('scripts', file!), 'utf8')
      assert.ok(text.includes(`%* --mode ${mode}`))
      assert.ok(!/(?<!\r)\n/.test(text))
      /*
       * 2026-10-05：正式入口的中文横幅已搬进 `postlv2_vtuber_runtime.py`（`--mode production`）。
       * 原因是一条实测到的偶发故障：批处理文件里出现非 ASCII 行、又在同一个文件里中途
       * `chcp 65001` 时，cmd 的读取器会错位，把一行中文的**后半截当成命令执行**
       * （`'成后打开' is not recognized as an internal or external command`）。
       * 这条断言把"启动器保持纯 ASCII"钉住 —— 想加中文提示就加到 Python 侧。
       */
      assert.ok(!/[^\x00-\x7F]/.test(text), `${file} 必须是纯 ASCII（中文提示请由 Python 打印）`)
    }
  })
  const python = spawnSync(resolve(process.env.POSTLV2_DEPS_ROOT ?? 'C:/Users/user/postlv2-deps',
    'qwen3-tts-venv/Scripts/python.exe'), ['-B', '-X', 'utf8', resolve('scripts/postlv2-production-verify.py')], { encoding: 'utf8' })
  assert.equal(python.status, 0, python.stderr)
  const pythonReading = JSON.parse(python.stdout.trim().split('\n').at(-1)!) as { passed: number; checks: string[] }
  checks.push(...pythonReading.checks)

  let live: object = { state: 'NOT RUN' }
  if (process.argv.includes('--live-copy')) {
    const { digestTree } = await import('../src/infrastructure/persistence/production-db-safety.ts')
    const before = digestTree(PRODUCTION_DB_DIR)
    const liveId = `avatar-production-${Date.now()}`
    const isolated = isolateDatabase('avatar-production-rehearsal', { runId: liveId, keep: true })
    cpSync(PRODUCTION_DB_DIR, isolated.dir, { recursive: true })
    const replies: Record<string, unknown>[] = []
    async function session(packets: object[]) {
      const child = spawn(process.execPath, [cli, resolve('scripts/postlv2-production-verify.ts'), '--copy-worker', '--run-id', liveId],
        { cwd: root, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'] })
      let errors = ''
      child.stderr.on('data', data => { errors += String(data) })
      const lines = createInterface({ input: child.stdout })
      const exit = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done) })
      const sequence = [{ kind: 'LG_STARTUP_PROBE', requestId: 'lg-startup-probe' }, ...packets] as { requestId: string }[]
      let index = 0
      child.stdin.write(JSON.stringify(sequence[0]) + '\n')
      try {
        for await (const line of lines) {
          let response: Record<string, unknown>
          try { response = JSON.parse(line) } catch { continue }
          if (response.requestId !== sequence[index]?.requestId) continue
          if (index === 0) assert.equal(response.code, 'bridge_unknown_message_kind')
          else {
            assert.equal(response.outcome, 'replied')
            assert.equal(response.delivery, 'generated')
            replies.push(response)
          }
          index += 1
          if (index === sequence.length) child.stdin.end()
          else child.stdin.write(JSON.stringify(sequence[index]) + '\n')
        }
      } finally {
        child.stdin.end()
        assert.equal(await exit, 0, errors.slice(-2000))
      }
      assert.equal(index, sequence.length, 'all requested responses received')
    }
    const userText = '记住，叫我青禾灯。'
    assert.equal(detectByRule(userText)?.kind, 'remember', 'registered explicit-memory form')
    const turn = { kind: 'SUBMIT_TURN', requestId: 'copy-memory-1', userText }
    await session([turn, turn]) // same request id: no duplicate write/model call
    assert.deepEqual(replies[1], replies[0], 'retry reuses the committed reply and trace')
    async function persisted() {
      const db = await openRawPGlite(isolated.dir)
      try {
        const rows = await db.query('SELECT id, status, content FROM memory_records')
        return rows.rows.filter(row => JSON.stringify(row.content).includes('青禾灯'))
      } finally { await db.close() }
    }
    const written = await persisted()
    assert.equal(written.length, 1, 'one actual memory record in the copy')
    assert.equal(written[0]?.status, 'active', 'the written memory is eligible and active')
    await session([{ kind: 'SUBMIT_TURN', requestId: 'copy-memory-2', userText: '你记得应该怎么称呼我吗？' }])
    const afterRestart = await persisted()
    assert.deepEqual(afterRestart, written, 'memory survived a true process restart')
    assert.ok(String(replies.at(-1)?.replyText).includes('青禾灯'), 'recalled actual copy memory')
    assert.deepEqual(digestTree(PRODUCTION_DB_DIR), before, 'production tree unchanged')
    checks.push('real main.ts bridge stores exactly once, cleanly exits, restarts and recalls copy memory')
    live = { state: 'PASS', sandbox: isolated.dir, memoryRecords: written.length, replies: replies.map(r => ({
      replyId: r.replyId, traceId: r.traceId, domainEventIds: r.domainEventIds,
      replyTextSha256: createHash('sha256').update(String(r.replyText)).digest('hex'),
    })), productionTreeUnchanged: true, productionTree: before }
  }
  const output = resolve('artifacts/post-lv2/avatar-production-20261004')
  mkdirSync(output, { recursive: true })
  const reading = { head: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
    passed: checks.length, checks, live, productionActivation: 'NOT RUN' }
  writeFileSync(resolve(output, process.argv.includes('--live-copy') ? 'live-copy.json' : 'controls.json'), JSON.stringify(reading, null, 2) + '\n')
  console.log(JSON.stringify(reading, null, 2))
}
