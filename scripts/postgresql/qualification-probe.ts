/**
 * PostgreSQL 迁移 WP3 探针：**单认知执行者资格**（ADR-132 `D05`）的真 PG 验证。
 *
 * ============================================================================
 *  为什么它必须是**独立进程**
 * ============================================================================
 *  计划 §5 的 `PG-G03` 逐字要求"真 PG + **两个 OS 进程**"。
 *  在同一个进程里"模拟第二个核心"证明不了任何事 ——
 *  资格锁的整个意义就是**跨进程**的。
 *  ⇒ 本探针由门以不同 `--mode` 起**多个进程**，各自输出一行 JSON 供门解析。
 *
 * ---------------------------------------------------------------------------
 *  三种模式
 * ---------------------------------------------------------------------------
 * ```text
 *   --mode=hold --seconds=N   取得资格 → 持有 N 秒（每秒做一次轻量核对）
 *                             → 打印"是否仍持有 / 失效原因" → 释放
 *   --mode=try                只尝试取得一次 → 打印结果（第二个核心应当被拒）
 *   --mode=read               只用**只读**连接跑一条查询 → 证明读客户端不受资格限制
 * ```
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 输出用**哨兵行**（与 `init-probe.ts` 的 pretty JSON 不同）
 * ---------------------------------------------------------------------------
 *  PG-G02 落门时踩过一次：pretty JSON 里嵌套对象的行 trim 后也以 `{` 开头，
 *  于是"筛出以 `{` 开头的行再拼起来"得到的不是合法 JSON。
 *  新探针一律在最后打一行 `__QUAL_JSON__ {…}`（紧凑、单行、有哨兵）
 *  ⇒ 解析不再依赖"哪一行看起来像 JSON"。
 *
 *  跑法（环境由调用方给；`POSTGRES_URL` 指向**测试库**）：
 *    node node_modules/tsx/dist/cli.mjs scripts/postgresql/qualification-probe.ts --mode=try
 */
import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  acquireSingleCoreQualification,
  type DedicatedPool,
  type SingleCoreInvalidationReason,
} from '../../src/infrastructure/persistence/single-core-qualification.ts'

const SENTINEL = '__QUAL_JSON__'

/**
 * 取命令行参数。两种写法都支持：
 *
 * ```text
 *   --mode=hold        ← 本仓库其它脚本的写法（pnpm 里常见）
 *   --mode hold        ← 空格分隔
 * ```
 *
 * ⚠️ 第一版只支持后者，而调用方用的是前者 ⇒ `mode` 拿到 `(none)`，
 *    三个进程全都在跑"未知模式"。这种错**不报错**、只是静默跑错分支 ——
 *    所以这里两种都收。
 */
function argOf(name: string): string | undefined {
  const withEquals = process.argv.find((value) => value.startsWith(`${name}=`))
  if (withEquals !== undefined) return withEquals.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/**
 * 取一个真实的 `pg.Pool`。
 *
 * ⚠️ `pg` 在本仓库**不是根依赖**（由 plugin-sql 的依赖图提供）⇒
 *    裸 `import 'pg'` 会 `ERR_MODULE_NOT_FOUND`（WP0 实测）。
 *    这里按插件在 pnpm store 里的**真实路径**解析它 —— 与 WP0 两个探针同源。
 */
function createPgPool(connectionString: string): DedicatedPool {
  const candidates: string[] = []
  const store = resolve('node_modules/.pnpm')
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (!entry.startsWith('@elizaos+plugin-sql@')) continue
      candidates.push(join(store, entry, 'node_modules', '@elizaos', 'plugin-sql', 'package.json'))
    }
  }
  candidates.push(resolve('node_modules/@elizaos/plugin-sql/package.json'))
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const requireFromHere = createRequire(candidate)
      const pgEntry = requireFromHere.resolve('pg')
      const pg = requireFromHere(pgEntry) as { Pool: new (config: unknown) => DedicatedPool }
      return new pg.Pool({
        connectionString,
        max: 4,
        // ⚠️ 刻意**短**：资格锁那条连接应当尽快建立，且失败要快
        connectionTimeoutMillis: 5000,
      })
    } catch {
      /* 换下一个候选 */
    }
  }
  throw new Error('找不到 pg：plugin-sql 的 pnpm 布局与预期不同')
}

interface Reading {
  mode: string
  ok: boolean
  acquired?: boolean
  denial?: string
  backendPid?: number
  lockId?: string
  heldAfterWait?: boolean
  invalidationReason?: SingleCoreInvalidationReason | null
  verifyResults?: boolean[]
  readValue?: number
  error?: string
}

const reading: Reading = { mode: argOf('--mode') ?? '(none)', ok: false }

function emit(): void {
  console.log(`${SENTINEL} ${JSON.stringify(reading)}`)
}

async function main(): Promise<void> {
  const url = process.env.POSTGRES_URL
  if (url === undefined || url.trim() === '') throw new Error('缺少 POSTGRES_URL')
  const characterId = process.env.LG_QUAL_CHARACTER_ID ?? 'sumuwei-qualification-probe'

  if (reading.mode === 'read') {
    // 只读客户端：**不参与**资格锁。它必须能在"另一个进程持有资格"时照常查询。
    const pool = createPgPool(url)
    const client = await (pool as unknown as { connect: () => Promise<{ query: (s: string) => Promise<{ rows: unknown[] }>; release: () => void }> }).connect()
    try {
      const result = await client.query('select count(*)::int as n from pg_class')
      const row = result.rows[0] as { n?: number } | undefined
      reading.readValue = Number(row?.n ?? -1)
      reading.ok = true
    } finally {
      client.release()
      await (pool as unknown as { end?: () => Promise<void> }).end?.()
    }
    return
  }

  const pool = createPgPool(url)
  const seconds = Number(argOf('--seconds') ?? '3')
  const generation = 1

  const qualification = await acquireSingleCoreQualification({
    pool,
    characterId,
    generation,
    onInvalidated: (reason) => {
      reading.invalidationReason = reason
    },
  })

  reading.acquired = qualification.acquired
  reading.denial = qualification.denial
  reading.backendPid = qualification.backendPid
  reading.lockId = qualification.lockId

  if (reading.mode === 'try') {
    // 第二个核心：被拒就是**正确**结果。这里不判断对错，只如实报读数 ——
    // 期望值由**门**给出（探针不做"我觉得应该怎样"的判断）。
    reading.ok = true
    await qualification.release()
    await (pool as unknown as { end?: () => Promise<void> }).end?.()
    return
  }

  if (reading.mode === 'hold') {
    const verifications: boolean[] = []
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
      const stillHeld = await qualification.verifyStillHeld()
      verifications.push(stillHeld)
      if (!stillHeld) break
    }
    reading.verifyResults = verifications
    reading.heldAfterWait = qualification.isHeld()
    reading.ok = true
    await qualification.release()
    await (pool as unknown as { end?: () => Promise<void> }).end?.()
    return
  }

  throw new Error(`未知 --mode：${reading.mode}`)
}

await main().catch((error: unknown) => {
  reading.error = error instanceof Error ? error.message : String(error)
})

emit()
if (!reading.ok) process.exitCode = 1
