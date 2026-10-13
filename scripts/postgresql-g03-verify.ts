/**
 * PG-G03 生命周期与写入资格（WP3 的门）。
 *
 * ============================================================================
 *  这道门回答什么
 * ============================================================================
 *  验收契约 `PG-G03` 与计划 §3.2/§5：
 *
 *    G03.1 正常退出：只关本进程连接池；**服务继续可用**
 *    G03.3 锁连接丢失 ⇒ 撤销资格（**必须由可观测事件判定**）
 *    G03.5 第二核心 ⇒ 拒绝；**只读**连接**仍可进入**
 *    G03.6 服务器持续运行（其它客户端不受影响）
 *    + ADR-132 `D05` 的纯函数部分：lockId 派生**与 plugin-sql 迁移锁不同源**
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 必须是**两个真实 OS 进程**（计划 §5 逐字）
 * ---------------------------------------------------------------------------
 *  在同一进程里"模拟第二个核心"证明不了任何事 ——
 *  资格锁的整个意义就是跨进程的。本门用 `qualification-probe.ts` 起**多个进程**。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 失败关闭：拿不到实例就不报 PASS
 * ---------------------------------------------------------------------------
 *  与 `PG-G02` 同一条纪律：只要有关键断言未运行，本门**非零退出**并具名报 notRun。
 *  （`PG-G02` 第一版在实例不可达时以 0 退出 —— 那是个假绿出口，已修。）
 *
 * 跑法：pnpm postgresql:g03:verify
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  PG_CONTAINER,
  PG_CREDENTIALS_FILE,
  PG_HOST_PORT,
  loadPgCredentials,
  missingCredentialKeys,
} from './postgresql/credentials.ts'
import { isSameBackendSession, singleCoreLockId, dedicatedPoolOf } from '../src/infrastructure/persistence/single-core-qualification.ts'

// ===========================================================================
// 配置
// ===========================================================================
// ⚠️ 凭据读取走**共用模块**（理由见 `scripts/postgresql/credentials.ts` 的文件头：
//    本文件原来自己读一遍且**没剥 BOM** ⇒ 第一个 key 被静默读坏、靠兜底默认值盖住）。
const CONTAINER = PG_CONTAINER
const TSX = resolve('node_modules/tsx/dist/cli.mjs')
const PROBE = resolve('scripts/postgresql/qualification-probe.ts')
const HOST_PORT = PG_HOST_PORT
const SENTINEL = '__QUAL_JSON__'
const CHARACTER_ID = 'pg-g03-qualification'

const credentials = loadPgCredentials()
const missingKeys = missingCredentialKeys(credentials)

// ===========================================================================
// 报告骨架
// ===========================================================================
const checks: { name: string; pass: boolean; detail?: string }[] = []
const notRun: { id: string; what: string; why: string }[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

// ===========================================================================
// 驱动
// ===========================================================================
interface PsqlResult {
  rc: number
  out: string
  err: string
}

function psql(user: string, password: string, database: string, sql: string): PsqlResult {
  const result = spawnSync(
    'docker',
    ['exec', '-e', 'PGPASSWORD', CONTAINER, 'psql', '-h', '127.0.0.1', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: password }, timeout: 60_000 }
  )
  return { rc: result.status ?? -1, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

function admin(sql: string, database = 'postgres'): PsqlResult {
  return psql(
    credentials?.LG_PG_BOOTSTRAP_USER ?? 'lg_bootstrap',
    credentials?.LG_PG_BOOTSTRAP_PASSWORD ?? '',
    database,
    sql
  )
}

function manageTestDb(script: 'create-test-db.sql' | 'drop-test-db.sql', dbName: string): PsqlResult {
  const result = spawnSync(
    'docker',
    [
      'exec', '-e', 'PGPASSWORD', '-e', `LG_TEST_DB_NAME=${dbName}`, '-e', 'LG_PG_MIGRATE_USER=lg_migrate',
      CONTAINER, 'psql', '-h', '127.0.0.1', '-U', credentials?.LG_PG_BOOTSTRAP_USER ?? 'lg_bootstrap',
      '-d', credentials?.LG_PG_BOOTSTRAP_DB ?? 'lg_trial', '-v', 'ON_ERROR_STOP=1', '-f', `/opt/lg/${script}`,
    ],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: credentials?.LG_PG_BOOTSTRAP_PASSWORD ?? '' }, timeout: 120_000 }
  )
  return { rc: result.status ?? -1, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

interface QualReading {
  mode: string
  ok: boolean
  acquired?: boolean
  denial?: string
  backendPid?: number
  lockId?: string
  heldAfterWait?: boolean
  invalidationReason?: string | null
  verifyResults?: boolean[]
  readValue?: number
  error?: string
}

function parseSentinel(stdout: string): QualReading | undefined {
  const line = stdout.split(/\r?\n/).find((value) => value.startsWith(SENTINEL))
  if (line === undefined) return undefined
  try {
    return JSON.parse(line.slice(SENTINEL.length).trim()) as QualReading
  } catch {
    return undefined
  }
}

/** 起一个探针进程（异步，可后台跑） */
function startProbe(mode: string, url: string, seconds?: number): {
  child: ReturnType<typeof spawn>
  done: Promise<QualReading | undefined>
} {
  const args = [TSX, PROBE, `--mode=${mode}`]
  if (seconds !== undefined) args.push(`--seconds=${seconds}`)
  const child = spawn(process.execPath, args, {
    env: { ...process.env, POSTGRES_URL: url, LG_QUAL_CHARACTER_ID: CHARACTER_ID },
  })
  let stdout = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8')
  })
  const done = new Promise<QualReading | undefined>((resolveDone) => {
    child.on('close', () => resolveDone(parseSentinel(stdout)))
  })
  return { child, done }
}

const wait = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

// ===========================================================================
// §1 纯函数（不依赖实例）
// ===========================================================================
check('D05.1 lockId 派生是**确定性**的（同一角色每次相同）', () => {
  const a = singleCoreLockId('sumuwei')
  const b = singleCoreLockId('sumuwei')
  assert.equal(a, b)
  assert.match(a, /^\d+$/, '必须是十进制字符串（63 位放不进 JS number）')
})

check('D05.2 不同角色 ⇒ 不同 lockId', () => {
  const ids = new Set(['sumuwei', 'other', 'sumuwei-2'].map(singleCoreLockId))
  assert.equal(ids.size, 3, `期望 3 个不同 id，实际 ${ids.size}`)
})

check('D05.3 ★ lockId **与 plugin-sql 迁移锁的派生不同源**（否则迁移与核心会互相锁住）', () => {
  // 复刻 plugin-sql 的派生（dist/node/index.node.js 的 getAdvisoryLockId）：
  //   sha256(input) → **前 8 字节** → BigInt → & 0x7fff… → 0 则 1
  const pluginSqlDerivation = (input: string): string => {
    const digest = createHash('sha256').update(input).digest()
    let value = BigInt(`0x${digest.subarray(0, 8).toString('hex')}`) & 0x7fffffffffffffffn
    if (value === 0n) value = 1n
    return value.toString()
  }
  // 两种"最容易被顺手复用"的写法都必须与本模块不同：
  //   ① 直接拿角色 id 当 pluginName
  //   ② 拿带命名空间的串当 pluginName（即"只改输入、不改字节范围"）
  const naiveSameInput = pluginSqlDerivation(CHARACTER_ID)
  const naiveNamespacedInput = pluginSqlDerivation(`lg:single-core:v1:${CHARACTER_ID}`)
  const mine = singleCoreLockId(CHARACTER_ID)
  assert.notEqual(mine, naiveSameInput, '与"直接拿角色 id 走插件派生"撞了')
  assert.notEqual(
    mine,
    naiveNamespacedInput,
    '与"只改输入、不改字节范围"撞了 ⇒ 说明只靠命名空间不够，必须同时换字节范围'
  )
})

check('D05.4 isSameBackendSession 真值表（"同连接"判据）', () => {
  assert.equal(isSameBackendSession(100, 100), true)
  assert.equal(isSameBackendSession(100, 101), false, 'pid 变了 ⇒ 不是同一条连接')
  assert.equal(isSameBackendSession(undefined, 100), false, '拿不到期望值 ⇒ 失败关闭')
  assert.equal(isSameBackendSession(100, undefined), false, '拿不到实际值 ⇒ 失败关闭')
  assert.equal(isSameBackendSession(undefined, undefined), false)
})

check('D05.7 dedicatedPoolOf：**按形状**区分两种后端（这是"纯追加"的关键判据）', () => {
  // PostgreSQL：adapter.manager.getConnection() 是 pg.Pool（**有** connect）
  const pgLike = { adapter: { manager: { getConnection: () => ({ connect: async () => ({}) }) } } }
  assert.ok(dedicatedPoolOf(pgLike) !== undefined, 'PG 形状应当被认出来')
  // PGlite：嵌入式客户端**没有** connect ⇒ 返回 undefined
  const pgliteLike = { adapter: { manager: { getConnection: () => ({ query: async () => ({ rows: [] }) }) } } }
  assert.equal(dedicatedPoolOf(pgliteLike), undefined, 'PGlite 形状不该被当成池')
  // 没有 adapter / 没有 manager ⇒ 同样是 undefined（只读命令那几条路径）
  assert.equal(dedicatedPoolOf({}), undefined)
  assert.equal(dedicatedPoolOf(undefined), undefined)
})

// ===========================================================================
// §1b 装配根接线（**结构性**断言）
// ===========================================================================
/**
 * ⚠️ 这一组是**结构性**的，不是行为性的 —— 必须说清楚它证明了什么。
 *
 * 它证明：`src/main.ts` 的装配根**确实**在"开库之后、状态引导之前"取得资格、
 * 拿不到就抛、收尾时释放、丢失时接上有序停机。
 *
 * 它**不**证明：真的起两个生产核心时第二个会被拒（那需要跑两个完整核心，
 * 属于 WP6 的演练/Runbook；本门不做，也不假装做了）。
 * 行为面由本门上面那几条**两个真实 OS 进程**的读数覆盖（模块级）。
 */
check('W3.1 装配根：在**开库之后**取得资格，且用 `dedicatedPoolOf` 判后端（纯追加）', () => {
  const source = readFileSync(resolve('src/main.ts'), 'utf8')
  const acquireAt = source.indexOf('await acquireSingleCoreQualification({')
  assert.ok(acquireAt > 0, '找不到取得资格的那一处')
  const poolAt = source.indexOf('dedicatedPoolOf(runtime)')
  assert.ok(poolAt > 0, '找不到 dedicatedPoolOf(runtime) 的判据')
  const openAt = source.indexOf('ready = await initDatabase(runtime, sqlPlugin)')
  assert.ok(openAt > 0, '找不到 initDatabase 的调用点')
  assert.ok(openAt < acquireAt, '取得资格**早于**开库 ⇒ 那时还没有连接池')
})

check('W3.2 装配根：拿不到资格 ⇒ **抛具名 KernelError**（拒绝启动，不是警告后继续）', () => {
  const source = readFileSync(resolve('src/main.ts'), 'utf8')
  assert.ok(
    /if \(!qualification\.acquired\) \{[\s\S]{0,400}?throw new KernelError\(/.test(source),
    '没有"未取得就抛"的分支 ⇒ 第二个核心会被放行'
  )
  assert.ok(
    source.includes('singleCoreDenialMessage('),
    '没有用单核心的具名拒绝文案'
  )
})

check('W3.3 装配根：收尾时**释放**资格（放在 afterRun，不影响退出码）', () => {
  const source = readFileSync(resolve('src/main.ts'), 'utf8')
  assert.ok(
    source.includes('await singleCoreQualification.release()'),
    '收尾路径里找不到释放资格'
  )
})

check('W3.4 装配根：资格**丢失**时接上**既有的**有序停机链（不另发明一条收尾路径）', () => {
  const source = readFileSync(resolve('src/main.ts'), 'utf8')
  assert.ok(source.includes('onInvalidated:'), '取得资格时没接 onInvalidated')
  assert.ok(
    /stopAfterQualificationLoss = \(\): void => \{[\s\S]{0,300}?void shutdown\(\)/.test(source),
    '丢失资格后没有接上既有的 shutdown()'
  )
  assert.ok(
    source.includes('停止接收新轮次'),
    '丢失资格的日志里没有明确说出"停止接收新轮次"'
  )
})

// ===========================================================================
// §2 真 PG：两个真实 OS 进程
// ===========================================================================
const instanceUp = ((): boolean => {
  if (credentials === undefined) return false
  const probe = admin('select 1 as ok')
  return probe.rc === 0 && probe.out.includes('1')
})()

if (credentials === undefined) {
  notRun.push({
    id: 'all-pg-cases',
    what: '全部需要真 PG 实例与两个 OS 进程的断言',
    why: `凭据文件不存在：${PG_CREDENTIALS_FILE}`,
  })
} else if (missingKeys.length > 0) {
  notRun.push({
    id: 'all-pg-cases',
    what: '全部需要真 PG 实例与两个 OS 进程的断言',
    why: `凭据文件缺这些 key：${missingKeys.join(', ')}（文件：${PG_CREDENTIALS_FILE}）`,
  })
} else if (!instanceUp) {
  notRun.push({
    id: 'all-pg-cases',
    what: '全部需要真 PG 实例与两个 OS 进程的断言',
    why: `容器 ${CONTAINER} 不可达。起实例：docker compose -f scripts/postgresql/compose.yml --env-file <凭据> up -d`,
  })
}

if (credentials !== undefined && instanceUp) {
  const testDb = 'lg_test_g03'
  manageTestDb('drop-test-db.sql', testDb)
  const created = manageTestDb('create-test-db.sql', testDb)
  const url = `postgres://lg_migrate:${credentials.LG_PG_MIGRATE_PASSWORD ?? ''}@127.0.0.1:${HOST_PORT}/${testDb}`

  check('G03.0 前置：本门的测试库已从零建立', () => {
    assert.equal(created.rc, 0, created.err)
  })

  // -------------------------------------------------------------------------
  // G03.5 第二核心被拒 + G03.5b 只读连接仍可进入
  // -------------------------------------------------------------------------
  const holder = startProbe('hold', url, 16)
  await wait(4000) // 等它真的拿到锁

  const challenger = startProbe('try', url)
  const challengerReading = await challenger.done
  check('G03.5 **第二核心被拒**（真第二个 OS 进程，不是同进程模拟）', () => {
    assert.ok(challengerReading !== undefined, '挑战者没有输出可解析的读数')
    assert.equal(challengerReading.acquired, false, '第二个进程竟然拿到了资格')
    assert.equal(challengerReading.denial, 'lock_not_acquired', JSON.stringify(challengerReading))
  })

  const reader = startProbe('read', url)
  const readerReading = await reader.done
  check('G03.5b **只读连接不受资格限制**（它在别人持有资格时照常查询）', () => {
    assert.ok(readerReading !== undefined, '读探针没有输出')
    assert.equal(readerReading.ok, true, JSON.stringify(readerReading))
    assert.ok((readerReading.readValue ?? -1) > 0, `读到的值不合理：${readerReading.readValue}`)
  })

  check('D05.5 持有者与挑战者派生出**同一个** lockId（同一角色的同一把锁）', () => {
    assert.ok(challengerReading?.lockId !== undefined, '挑战者没有报 lockId')
    assert.equal(challengerReading.lockId, singleCoreLockId(CHARACTER_ID))
  })

  // -------------------------------------------------------------------------
  // G03.3 锁连接丢失 ⇒ 由**可观测事件**撤销资格
  // -------------------------------------------------------------------------
  const killed = admin(
    "select count(pg_terminate_backend(pid)) as n from pg_stat_activity where usename = 'lg_migrate'"
  )
  check('G03.3-前置：确实终止了持有者的专用连接', () => {
    assert.equal(killed.rc, 0, killed.err)
    assert.ok(Number(killed.out) >= 1, `没有终止到任何连接：${killed.out}`)
  })

  const holderReading = await holder.done
  check('G03.3 锁连接丢失 ⇒ 资格被撤销，且**失效原因是可观测事件**', () => {
    assert.ok(holderReading !== undefined, '持有者没有输出可解析的读数')
    assert.equal(holderReading.heldAfterWait, false, '连接已被终止，却仍报"持有"')
    assert.ok(
      holderReading.invalidationReason !== null && holderReading.invalidationReason !== undefined,
      `没有具名失效原因：${JSON.stringify(holderReading)}`
    )
    assert.ok(
      ['connection_error', 'connection_ended', 'verify_failed'].includes(holderReading.invalidationReason),
      `失效原因不是"可观测事件"：${holderReading.invalidationReason}`
    )
  })

  check('G03.3b 轻量核对的读数序列**由真变假**（不是一上来就 false，也不是一直 true）', () => {
    const sequence = holderReading?.verifyResults ?? []
    assert.ok(sequence.length >= 2, `核对次数太少：${JSON.stringify(sequence)}`)
    assert.equal(sequence[0], true, '第一次核对就该是"仍持有"')
    assert.equal(sequence[sequence.length - 1], false, '最后一次核对应当是"已失效"')
    assert.ok(
      sequence.some((value) => value === false),
      `序列里没有 false：${JSON.stringify(sequence)}`
    )
  })

  // -------------------------------------------------------------------------
  // 锁随会话消失 ⇒ 另一个进程可以取得
  // -------------------------------------------------------------------------
  const afterDeath = startProbe('try', url)
  const afterReading = await afterDeath.done
  check('D05.6 持有者会话消失后，另一个进程**可以**取得资格（session 锁随会话释放）', () => {
    assert.ok(afterReading !== undefined, '没有输出')
    assert.equal(afterReading.acquired, true, `仍然拿不到：${JSON.stringify(afterReading)}`)
  })

  // -------------------------------------------------------------------------
  // G03.1 / G03.6 服务持续运行
  // -------------------------------------------------------------------------
  check('G03.1/G03.6 上述折腾之后**服务器仍在运行**，普通查询照常', () => {
    const r = admin('select 1 as ok', testDb)
    assert.equal(r.rc, 0, r.err)
    assert.equal(r.out, '1')
  })

  // =========================================================================
  // §2c G03.6 服务器重启 ⇒ 资格必须**重新建立**，不能假设还在
  // =========================================================================
  /*
   * 计划 §4/WP3 必交付物逐字包含"服务器重连"；§5 的 `G03.6` 是
   * "服务器重启 ⇒ 核心重连；重连后资格重新建立或如实拒绝"。
   *
   * 这一条测的是 `D05` 里最容易被"想当然"的一格：
   *
   * ```text
   *   服务器重启 ⇒ 所有会话消失 ⇒ **那条 session 级 advisory lock 也随之消失**
   *   ⇒ 旧资格**已经不成立**了。一个只在启动时取一次锁、之后不再核对的实现，
   *     会在服务器重启后继续以为自己是唯一执行者 —— 而实际上锁没了，
   *     另一个核心可以正当地取得它。
   * ```
   *
   * 所以这里断言三件事：
   *   ① 持有者的核对序列**由真变假**（重启被**观测到**，不是"以为还在"）
   *   ② 服务器**确实回来了**（不能把实例留在停着的状态）
   *   ③ 重启后**另一个进程可以取得**资格（证明旧锁真的随会话消失了）
   *
   * ⚠️ 本条会**重启容器**。它因此必须 serial（manifest 已标），
   *    而且**无论断言成败都要把实例带回来** —— 见下面的 waitForHealthy。
   */
  const restarter = startProbe('hold', url, 30)
  await wait(4000) // 等它拿到资格

  const restartAt = Date.now()
  const restart = spawnSync('docker', ['restart', '--time', '20', CONTAINER], {
    encoding: 'utf8',
    timeout: 180_000,
  })
  check('G03.6-前置：容器重启命令成功', () => {
    assert.equal(restart.status, 0, `docker restart 失败：${(restart.stderr ?? '').slice(-300)}`)
  })

  /** 等实例重新健康（**无论断言结果如何都要走到**） */
  const waitForHealthy = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const probe = admin('select 1 as ok')
      if (probe.rc === 0 && probe.out === '1') return true
      await wait(1000)
    }
    return false
  }
  const healthyAgain = await waitForHealthy(90_000)
  check('G03.6 重启后服务器**确实回来了**（不把实例留在停着的状态）', () => {
    assert.equal(healthyAgain, true, `重启 ${Math.round((Date.now() - restartAt) / 1000)}s 后仍不可达`)
  })

  const restarterReading = await restarter.done
  check('G03.6b 服务器重启 ⇒ 持有者的资格被**观测到**失效（不是"以为还在"）', () => {
    assert.ok(restarterReading !== undefined, '持有者没有输出可解析的读数')
    assert.equal(
      restarterReading.heldAfterWait,
      false,
      '服务器都重启了，却仍报"持有" ⇒ 这个实现在重启后会以为自己是唯一执行者'
    )
    assert.ok(
      ['connection_error', 'connection_ended', 'verify_failed', 'backend_pid_changed'].includes(
        restarterReading.invalidationReason ?? ''
      ),
      `失效原因不是"可观测事件"：${restarterReading.invalidationReason}`
    )
  })

  const afterRestart = startProbe('try', url)
  const afterRestartReading = await afterRestart.done
  check('G03.6c 重启后**另一个进程可以取得**资格（旧锁真的随会话消失了）', () => {
    assert.ok(afterRestartReading !== undefined, '没有输出')
    assert.equal(
      afterRestartReading.acquired,
      true,
      `重启后仍拿不到 ⇒ 旧锁没随会话释放：${JSON.stringify(afterRestartReading)}`
    )
  })

  const dropped = manageTestDb('drop-test-db.sql', testDb)
  check('G03.7 本门自建的测试库已清理', () => {
    assert.equal(dropped.rc, 0, dropped.err)
  })
}

// ===========================================================================
// 报告
// ===========================================================================
const passed = checks.filter((c) => c.pass).length
const failed = checks.length - passed
const measured = checks.length

console.log('')
console.log('PG-G03 生命周期与写入资格')
console.log('─'.repeat(72))
console.log(`  实例：${CONTAINER} · 可达=${instanceUp} · 凭据文件=${credentials === undefined ? '缺失' : '在'}`)
console.log('─'.repeat(72))
for (const c of checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!c.pass && c.detail !== undefined) console.log(`        └─ ${c.detail}`)
}
console.log('─'.repeat(72))
console.log(`  断言        : ${passed}/${checks.length}`)
console.log(`  未运行      : ${notRun.length}`)
for (const n of notRun) console.log(`      · ${n.id} —— ${n.what}（${n.why}）`)
console.log(`  measured_count = ${measured}`)
console.log(`  失败总数 = ${failed}`)
console.log('')

if (measured === 0) {
  console.error('measured_count = 0 ⇒ INVALID（不得当绿用）')
  process.exitCode = 1
} else if (failed > 0) {
  process.exitCode = 1
} else if (notRun.length > 0) {
  console.error(
    `\n${notRun.length} 项未运行 ⇒ 本门**不报 PASS**（关键断言缺证据 ⇒ 拒收）。\n` +
      '  这不是"通过"，也不是"失败"—— 它是"没量到"。要取得读数，先让前置条件成立。'
  )
  process.exitCode = 1
}
