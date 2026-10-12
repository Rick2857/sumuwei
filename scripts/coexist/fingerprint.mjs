/**
 * WP5 激活候选的**源码指纹**（只读）：把本次改动涉及的文件逐一 sha256，
 * 连同 HEAD 与真实库树摘要一起落盘（`artifacts/post-lv2/local/coexist-runtime/`）。
 *
 * ⚠️ 它**不**打开数据库、**不**改任何东西；真实库那一项只是文件树摘要。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..', '..')
const OUT = resolve(ROOT, 'artifacts/post-lv2/local/coexist-runtime')

const FILES = [
  'src/main.ts',
  'src/kernel/app/flags.ts',
  'src/kernel/app/bridge/turn-scheduler.ts',
  'src/infrastructure/runtime/adapters.ts',
  'src/infrastructure/runtime/entry-scope.ts',
  'src/infrastructure/qq/lg-stdio-client.ts',
  'scripts/qq/chat.ts',
  'scripts/postlv2_vtuber_runtime.py',
  'scripts/coexist/harness.ts',
  'scripts/coexist/readiness.ts',
  'scripts/coexist/supervise.ts',
  'scripts/coexist/stop.mjs',
  'scripts/postlv2-coexist-verify.ts',
  'scripts/postlv2-coexist-matrix.ts',
  'scripts/postlv2-coexist-live.ts',
  'scripts/postlv2-coexist-shells.ts',
  'package.json',
]

function sha256(path) {
  return createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')
}

function treeDigest(dir) {
  const rows = []
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current).sort()) {
      const absolute = join(current, entry)
      const relative = prefix === '' ? entry : `${prefix}/${entry}`
      const info = statSync(absolute)
      if (info.isDirectory()) walk(absolute, relative)
      else rows.push(`${relative}:${info.size}:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`)
    }
  }
  walk(dir, '')
  return { digest: createHash('sha256').update(rows.join('|')).digest('hex'), files: rows.length }
}

const head = execFileSync('git', ['log', '-1', '--format=%H %cI'], { cwd: ROOT, encoding: 'utf8' }).trim()
const dirty = execFileSync('git', ['status', '--short'], { cwd: ROOT, encoding: 'utf8' })
  .split(/\r?\n/)
  .filter((line) => line.trim() !== '').length

const payload = {
  capturedAt: new Date().toISOString(),
  head,
  workingTreeDirtyLines: dirty,
  productionDb: treeDigest(join(ROOT, 'data', 'pglite')),
  files: Object.fromEntries(FILES.map((path) => [path, sha256(path)])),
}
mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'activation-fingerprint.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
console.log(`HEAD=${head}`)
console.log(`真实库：${payload.productionDb.files} 文件 · ${payload.productionDb.digest.slice(0, 24)}…`)
for (const [path, hash] of Object.entries(payload.files)) console.log(`  ${hash.slice(0, 16)}…  ${path}`)
console.log(`指纹已写入 ${join(OUT, 'activation-fingerprint.json')}`)
