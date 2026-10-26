/**
 * 服务器仿真环境 · 灌库（2026-10-20）
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 *  把一份**逻辑转储**灌进仿真自己的 PostgreSQL，让仿真库的**数据**也同形
 *  （schema 同形是默认状态；这一步是额外加上数据）。
 *
 * ============================================================================
 *  🔴 红线（10-14 事故的根因，10-16 复盘的原话）
 * ============================================================================
 *  · **绝不复制 PGDATA**。只走 `pg_dump` 的逻辑转储。
 *  · 仿真与生产**不共享任何卷**（preflight 的 P3 项会核这一条）。
 *  · 灌进来的数据是**真实数据**（她的记忆、对话、关系、情绪）。
 *    ⇒ 落盘位置是**本机**，目录在 `artifacts/serversim/local/seed/`（已 gitignore）。
 *    ⇒ 每次灌库都会**先覆盖**上一次的转储文件（不留历史副本）。
 *
 * ============================================================================
 *  三条来源路径
 * ============================================================================
 *  ```bash
 *  # ① 从服务器拉（需要 SSH 能连上那台机器）
 *  pnpm serversim:seed -- --from server --host <ip> --user aiagent [--port 22] [--key ~/.ssh/id_ed25519]
 *
 *  # ② 用本地已有的转储文件
 *  pnpm serversim:seed -- --from file --dump <路径>
 *
 *  # ③ 从本机的生产容器转储（注意：那是**开发机**那份，可能已过时）
 *  pnpm serversim:seed -- --from local-container
 *  ```
 *
 * ============================================================================
 *  ⚠️ 体积：转储**不经过内存**
 * ============================================================================
 *  本机那份开发机残留库的单次转储实测 **> 512 MB**。
 *  Node 的 `execFileSync` 有两道硬限制：
 *    · 默认 `maxBuffer` 只有 **1 MB** ⇒ 直接 `spawnSync docker ENOBUFS`；
 *    · 就算放大到 512 MB，`encoding:'utf8'` 仍会撞上
 *      `Cannot create a string longer than 0x1fffffe8 characters`。
 *  ⇒ 所以这里**把 stdout 直接接到文件描述符**（`stdio:['ignore', fd, 'inherit']`），
 *    一块内存都不占；清单里的 sha256 / 表数 / 行数用**流式扫描**算。
 *  （实测踩过两次，2026-10-20。）
 * ============================================================================
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, closeSync, copyFileSync, existsSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const COMPOSE = join(REPO, 'serversim', 'compose.yml')
const LOCAL_DIR = join(REPO, 'artifacts', 'serversim', 'local', 'seed')
const DUMP = join(LOCAL_DIR, 'dump.sql')
const MANIFEST = join(LOCAL_DIR, 'manifest.json')
const PG_CONTAINER = 'lg-serversim-postgresql'
const IN_CONTAINER = '/tmp/serversim-seed.sql'

const args = process.argv.slice(2)
function arg (name: string): string | undefined {
  const at = args.indexOf(`--${name}`)
  return at >= 0 ? args[at + 1] : undefined
}
const FROM = arg('from') ?? 'file'

function compose (composeArgs: string[]): string {
  return spawnSync('docker', ['compose', '-f', COMPOSE, ...composeArgs], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).stdout ?? ''
}

function sh (command: string, commandArgs: string[]): { status: number | null; stderr: string } {
  const result = spawnSync(command, commandArgs, {
    cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: result.status, stderr: result.stderr ?? '' }
}

function die (message: string): never {
  console.error(`\n❌ ${message}`)
  process.exit(1)
}

/**
 * 把某个命令的 stdout **直接接到文件**（不经过 Node 的字符串缓冲）。
 * ⚠️ 体积理由见文件头。
 */
function captureToFile (label: string, command: string, commandArgs: string[], outPath: string): void {
  const fd = openSync(outPath, 'w')
  try {
    const result = spawnSync(command, commandArgs, { cwd: REPO, stdio: ['ignore', fd, 'inherit'] })
    if (result.status !== 0) {
      die(`${label} 失败（退出码 ${String(result.status)}）`)
    }
  } finally {
    closeSync(fd)
  }
}

/** 流式扫描转储：sha256 / 字节数 / CREATE TABLE 数 / 数据块数 */
async function scanDump (path: string): Promise<{ bytes: number; sha256: string; createTable: number; copyBlocks: number; insertInto: number }> {
  const hash = createHash('sha256')
  let bytes = 0
  let createTable = 0
  let copyBlocks = 0
  let insertInto = 0
  let tail = ''
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path, { encoding: 'utf8' })
    stream.on('data', (chunk) => {
      // ⚠️ 即使给了 `encoding: 'utf8'`，TS 的流类型仍是 `string | Buffer`
      //    （运行时才是 string）。显式收敛，不靠断言。
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      hash.update(text, 'utf8')
      bytes += Buffer.byteLength(text, 'utf8')
      const lines = (tail + text).split('\n')
      tail = lines.pop() ?? ''
      for (const line of lines) {
        /*
         * ⚠️ `pg_dump` **默认用 `COPY … FROM stdin`**，不是 `INSERT INTO`。
         *    第一版只数 INSERT ⇒ 一个装满了数据的转储会显示 "INSERT INTO: 0"，
         *    看起来像"转储是空的"（实测误导，2026-10-20）。两种都数。
         */
        if (line.startsWith('CREATE TABLE ')) createTable += 1
        else if (line.startsWith('COPY ')) copyBlocks += 1
        else if (line.startsWith('INSERT INTO ')) insertInto += 1
      }
    })
    stream.on('end', () => {
      if (tail.startsWith('CREATE TABLE ')) createTable += 1
      else if (tail.startsWith('COPY ')) copyBlocks += 1
      else if (tail.startsWith('INSERT INTO ')) insertInto += 1
      resolvePromise()
    })
    stream.on('error', reject)
  })
  return { bytes, sha256: hash.digest('hex'), createTable, copyBlocks, insertInto }
}

/**
 * 生成**用于恢复的副本**：去掉扩展 DDL。
 *
 * ============================================================================
 *  ⚠️ 为什么必须去掉（实测 2026-10-20）
 * ============================================================================
 *  生产 dump 里有：
 *      DROP EXTENSION IF EXISTS vector;   ← 要求**扩展的所有者**
 *  而仿真里扩展是 `lg_bootstrap`（超级用户）装的，应用角色 `lg_migrate`
 *  **不是所有者** ⇒ 恢复直接报 `must be owner of extension vector`。
 *
 *  → 扩展在仿真里**已经按生产同形装好了**（`db-init.ts` 装 vector /
 *    pgcrypto / fuzzystrmatch），所以这几句 DDL 在仿真里是**冗余**的。
 *  → 去掉它们**不改变数据**：表、约束、数据全保留。
 *
 *  ⚠️ 刻意**不**用"恢复时忽略错误"（`ON_ERROR_STOP=0`）绕过：
 *    那会把真正的导入错误一起吞掉，与本仓库"失败关闭"的纪律相反。
 * ============================================================================
 */
async function writeRestoreCopy (src: string, dest: string): Promise<{ kept: number; droppedExtensions: number }> {
  let droppedExtensions = 0
  let kept = 0
  let tail = ''
  const out = createWriteStream(dest)
  const write = (text: string): void => { if (text !== '') out.write(text) }
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(src, { encoding: 'utf8' })
    input.on('data', (chunk) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      const lines = (tail + text).split('\n')
      tail = lines.pop() ?? ''
      const buffer: string[] = []
      for (const line of lines) {
        if (/^(CREATE|DROP|ALTER)\s+EXTENSION\b/i.test(line) || /^COMMENT ON EXTENSION\b/i.test(line)) {
          droppedExtensions += 1
          continue
        }
        buffer.push(line)
        kept += 1
      }
      if (buffer.length > 0) write(buffer.join('\n') + '\n')
    })
    input.on('end', () => {
      if (tail !== '') {
        if (!/^(CREATE|DROP|ALTER)\s+EXTENSION\b/i.test(tail) && !/^COMMENT ON EXTENSION\b/i.test(tail)) {
          write(tail)
          kept += 1
        } else droppedExtensions += 1
      }
      out.end(() => resolvePromise())
    })
    input.on('error', reject)
    out.on('error', reject)
  })
  return { kept, droppedExtensions }
}

// ---------------------------------------------------------------------------
//  1. 拿到转储
// ---------------------------------------------------------------------------
mkdirSync(LOCAL_DIR, { recursive: true })
// ⚠️ 上一次的转储**先删**（含真实数据，不留副本）
if (existsSync(DUMP)) rmSync(DUMP, { force: true })

let source: { kind: string; detail: string }

if (FROM === 'server') {
  const host = arg('host')
  const user = arg('user') ?? 'aiagent'
  const port = arg('port') ?? '22'
  const key = arg('key')
  if (host === undefined) die('--from server 需要 --host <服务器地址>')
  /*
   * ⚠️ `BatchMode=yes`：绝不让 ssh 在"要口令"上**挂住**。
   *    挂住的表现是命令一直不返回，很难与"转储很大"区分开。
   *    `StrictHostKeyChecking=accept-new`：第一次连时记录主机密钥；
   *    本机已有连接档的话，主机密钥在 `known_hosts` 里（10-16 验证过）。
   */
  const sshBase = ['-p', port, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20',
    '-o', 'StrictHostKeyChecking=accept-new', ...(key === undefined ? [] : ['-i', key]), `${user}@${host}`]
  console.log(`▸ 在服务器上执行 pg_dump（只读转储，不动生产库）…`)
  captureToFile('服务器上的 pg_dump', 'ssh', [...sshBase,
    'docker exec lg-postgresql-production pg_dump -U lg_migrate -d sumuwei --no-owner --no-privileges --clean --if-exists'], DUMP)
  source = { kind: 'server', detail: `ssh ${user}@${host}:${port} → docker exec lg-postgresql-production pg_dump` }

} else if (FROM === 'local-container') {
  console.log('▸ 从本机生产容器转储（lg-postgresql-production）…')
  captureToFile('本机 pg_dump', 'docker', ['exec', 'lg-postgresql-production', 'pg_dump', '-U', 'lg_migrate', '-d', 'sumuwei',
    '--no-owner', '--no-privileges', '--clean', '--if-exists'], DUMP)
  source = { kind: 'local-container', detail: 'docker exec lg-postgresql-production pg_dump' }

} else if (FROM === 'file') {
  const path = arg('dump')
  if (path === undefined || !existsSync(path)) die('--from file 需要 --dump <存在的文件路径>')
  /*
   * ⚠️ 用 Node 的 `copyFileSync`，**不**用 `cmd /c copy`：
   *    `captureToFile` 把 stdout 接到目标文件 ⇒ `copy` 打印的
   *    "1 file(s) copied." 会被**写进转储**，psql 随后在第 10 行报语法错误。
   *    实测踩过（2026-10-20）。
   */
  copyFileSync(path, DUMP)
  source = { kind: 'file', detail: path }

} else {
  die(`未知的 --from：${FROM}（可用：server / file / local-container）`)
}

// ---------------------------------------------------------------------------
//  2. 核对转储本身（流式）
// ---------------------------------------------------------------------------
const scan = await scanDump(DUMP)
console.log('\n▸ 转储读数')
console.log(`  字节         : ${scan.bytes.toLocaleString('en-US')}`)
console.log(`  sha256       : ${scan.sha256}`)
console.log(`  CREATE TABLE : ${scan.createTable}`)
console.log(`  COPY 数据块  : ${scan.copyBlocks}`)
console.log(`  INSERT INTO  : ${scan.insertInto}`)
if (scan.bytes < 1024) die('转储文件小得可疑（< 1 KB）—— 拒绝把空转储灌进仿真')

// ---------------------------------------------------------------------------
//  3. 灌进仿真库
// ---------------------------------------------------------------------------
console.log('\n▸ 灌进仿真库（lg-serversim-postgresql / 角色 lg_migrate）…')
/*
 * ⚠️ 走 `docker cp` + `psql -f`，**不用 stdin 管道**：
 *    几百 MB 的 SQL 走 execFileSync 的 input 会撞上 Node 的字符串上限。
 */
const PSQL = ['exec', '-T', '-e', 'PGPASSWORD=lg_migrate_local_only', 'pg', 'psql',
  '-h', '127.0.0.1', '-p', '5432', '-U', 'lg_migrate', '-d', 'sumuwei']
const RESTORE_COPY = join(LOCAL_DIR, 'restore-filtered.sql')
const filtered = await writeRestoreCopy(DUMP, RESTORE_COPY)
console.log(`  恢复副本     : 去掉 ${filtered.droppedExtensions} 句扩展 DDL（扩展已按生产同形装好），保留 ${filtered.kept.toLocaleString('en-US')} 行`)
try {
  const copy = sh('docker', ['cp', RESTORE_COPY, `${PG_CONTAINER}:${IN_CONTAINER}`])
  if (copy.status !== 0) die(`把恢复副本拷进容器失败：${copy.stderr.trim().slice(0, 200)}`)
  const restore = sh('docker', ['compose', '-f', COMPOSE, ...PSQL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', IN_CONTAINER])
  if (restore.status !== 0) {
    console.error(restore.stderr.trim().split(/\r?\n/).slice(-25).join('\n'))
    die('灌库失败（上面是 psql 的原话）')
  }
} finally {
  try { sh('docker', ['exec', PG_CONTAINER, 'rm', '-f', IN_CONTAINER]) } catch { /* 清理失败不掩盖主结果 */ }
  try { rmSync(RESTORE_COPY, { force: true }) } catch { /* 同上 */ }
}

// ---------------------------------------------------------------------------
//  4. 读回
// ---------------------------------------------------------------------------
const tables = Number(compose([...PSQL, '-tAc',
  "select count(*) from information_schema.tables where table_schema='public'"]).trim())
const liveRows = Number(compose([...PSQL, '-tAc',
  'select coalesce(sum(n_live_tup),0) from pg_stat_user_tables']).trim())
const schemaVersion = Number(compose([...PSQL, '-tAc',
  'select coalesce(max(version),0) from character_schema_migrations']).trim())

// ---------------------------------------------------------------------------
//  5. 留痕
// ---------------------------------------------------------------------------
writeFileSync(MANIFEST, JSON.stringify({
  seededAt: new Date().toISOString(),
  source,
  dumpBytes: scan.bytes,
  dumpSha256: scan.sha256,
  createTableCount: scan.createTable,
  copyBlockCount: scan.copyBlocks,
  insertIntoCount: scan.insertInto,
  restoredPublicTables: tables,
  restoredLiveRows: liveRows,
  restoredSchemaVersion: schemaVersion,
  note: '行数是 pg_stat 的估算值，不是精确计数；精确计数请逐表 count(*) 。',
}, null, 2), 'utf8')

console.log('\n✅ 灌库完成')
console.log(`  来源      : ${source.detail}`)
console.log(`  public 表 : ${tables}`)
console.log(`  schema v  : ${schemaVersion}`)
console.log(`  估算行数  : ${liveRows}`)
console.log(`  清单      : ${MANIFEST.replace(REPO, '<repo>')}`)
if (schemaVersion < 23) {
  console.log(`\n  ⚠️ 转储的 schema 是 v${String(schemaVersion)}，仓库当前是 v23 ⇒ 灌完要补迁移：pnpm serversim:migrate`)
}
console.log('\n  ⚠️ 转储含**真实数据**，已落盘在本机 artifacts/serversim/local/seed/（已 gitignore）。')
console.log('     用完请删：rm -rf artifacts/serversim/local/seed')
