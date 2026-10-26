/**
 * S-1 · "一次性沙箱"通行证的**三段式**判据（2026-10-20 新增）
 *
 * ============================================================================
 *  它守的是什么
 * ============================================================================
 *  `src/db/index.ts` 的 `initDatabase()` 里，原本在"六张基础表缺失"时**无条件**
 *  调 `runtime.runPluginMigrations()`。薄宿主对它是**失败关闭**
 *  （`thin_host_refuses_startup_ddl`）⇒ **空沙箱上的门一个都起不来**。
 *
 *  S-1 的做法：**一次性 PGlite 沙箱**先把版本化迁移跑完（迁移 0023 覆盖那六张表），
 *  再判缺不缺表；真实库路径**一个字没改**。
 *
 *  ⇒ 所以本门要证明的是**"通行证不会被误发"**，不是"功能好用"：
 *     · **正控**：沙箱标记与数据目录**逐字相同** ⇒ 发证；
 *     · **负控**：少任何一个条件 ⇒ **不发证**（四条各自独立）；
 *     · **结构**：真实库分支**仍然**调 `runPluginMigrations()`（没有被删掉/短路）。
 *
 * ============================================================================
 *  ⚠️ 为什么负控要落在**纯函数**上（而不是跑一次真初始化）
 * ============================================================================
 *  想通过 `initDatabase()` 观察"没拿证时会不会去建表"，前面还有一道
 *  `assertDatabaseAccessAllowed()`：它也要求"沙箱标记 === 数据目录"。
 *  ⇒ 没拿证时**先被访问闸拒**，根本到不了 DDL 那一步 —— 那样的"负控"会
 *    **因为错误的原因变绿**。
 *  ⇒ 所以负控直接打判据本身（`oneShotPgliteSandboxDir`），零数据库风险、结论无歧义。
 *    结构判据另外守住"真实库那条路还在"。
 *
 * ============================================================================
 *  跑法
 * ============================================================================
 *  ```bash
 *  pnpm thinhost:sandbox-ddl:verify
 *  ```
 */

import { readFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('../', import.meta.url)))

let checks = 0
let failures = 0

function check (id: string, passed: boolean, reading: string): void {
  checks += 1
  if (passed) console.log(`  PASS ${id.padEnd(5)} ${reading}`)
  else { failures += 1; console.log(`  FAIL ${id.padEnd(5)} ${reading}`) }
}

function section (title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
}

/** 只在本进程内摆弄环境变量；结束一定还原 */
const originalSandbox = process.env.PROJECT_LG_SANDBOX
function withSandbox (value: string | undefined, run: () => void): void {
  if (value === undefined) delete process.env.PROJECT_LG_SANDBOX
  else process.env.PROJECT_LG_SANDBOX = value
  try { run() } finally {
    if (originalSandbox === undefined) delete process.env.PROJECT_LG_SANDBOX
    else process.env.PROJECT_LG_SANDBOX = originalSandbox
  }
}

const { oneShotPgliteSandboxDir } = await import('../src/db/index.ts')

const sandboxDir = mkdtempSync(join(tmpdir(), 'lg-s1-sandbox-'))
const otherDir = mkdtempSync(join(tmpdir(), 'lg-s1-other-'))
/** 真实库目录（**绝不打开**，只用作判据输入） */
const productionDir = join(REPO, 'data', 'pglite')

try {
  // ==========================================================================
  section('① 正控：沙箱标记 === 数据目录 ⇒ 发证')
  // ==========================================================================
  withSandbox(sandboxDir, () => {
    const got = oneShotPgliteSandboxDir(sandboxDir)
    check('P1', got === sandboxDir, `沙箱（${sandboxDir}）拿到通行证`)
  })

  // ==========================================================================
  section('② 负控：少任何一个条件都必须**不发证**（四条互相独立）')
  // ==========================================================================
  withSandbox(undefined, () => {
    const got = oneShotPgliteSandboxDir(sandboxDir)
    check('N1', got === undefined, '没有沙箱标记 ⇒ 不发证（临时目录也不行）')
  })

  withSandbox(otherDir, () => {
    const got = oneShotPgliteSandboxDir(sandboxDir)
    check('N2', got === undefined, '沙箱标记指向**别处** ⇒ 不发证')
  })

  withSandbox(productionDir, () => {
    const got = oneShotPgliteSandboxDir(productionDir)
    check('N3', got === undefined, '数据目录是**生产库** ⇒ 即使标记也指过来，也不发证（生产判断优先）')
  })

  withSandbox(sandboxDir, () => {
    const got = oneShotPgliteSandboxDir(undefined)
    check('N4', got === undefined, '没有数据目录（undefined）⇒ 不发证')
  })

  // ==========================================================================
  section('③ 结构：真实库那条路**还在**（没有被删掉或短路）')
  // ==========================================================================
  /*
   * ⚠️ 判据纪律（`L-QQP-09`）：**不按全文找词**。
   *    这里读源码但只做两件**结构化**的事：
   *      ① 数 `runPluginMigrations(` 的**调用点**个数（必须恰好 1）；
   *      ② 确认这个调用所在的 `else` 分支**不是**沙箱支路
   *         （即 `else if (sandboxDataDir !== undefined)` 在前、`else` 在后）。
   *    注释里出现这些字样不会被判成命中（判据锚在 `await runtime.` 这个调用形状上）。
   */
  const source = readFileSync(join(REPO, 'src', 'db', 'index.ts'), 'utf8')
  const callSites = [...source.matchAll(/await runtime\.runPluginMigrations\(\)/g)].length
  check('S1', callSites === 1, `runPluginMigrations 的调用点 = ${String(callSites)}（应恰好 1）`)

  const sandboxBranchAt = source.indexOf('else if (sandboxDataDir !== undefined)')
  const callAt = source.indexOf('await runtime.runPluginMigrations()')
  check(
    'S2',
    sandboxBranchAt >= 0 && callAt > sandboxBranchAt,
    sandboxBranchAt >= 0 && callAt > sandboxBranchAt
      ? '调用点在**沙箱支路之后**的 else 里（真实库路径未被短路）'
      : `沙箱支路位置=${String(sandboxBranchAt)} 调用点位置=${String(callAt)}（顺序不对）`
  )

  // ==========================================================================
  section('④ 恢复：判据本身可重复（环境变量已还原）')
  // ==========================================================================
  const restored = process.env.PROJECT_LG_SANDBOX === originalSandbox
  check('R1', restored, '本门跑完后 PROJECT_LG_SANDBOX 已还原')
  withSandbox(sandboxDir, () => {
    check('R2', oneShotPgliteSandboxDir(sandboxDir) === sandboxDir, '再问一次，答案与第一次相同')
  })
} finally {
  rmSync(sandboxDir, { recursive: true, force: true })
  rmSync(otherDir, { recursive: true, force: true })
}

console.log(`\n${'='.repeat(72)}`)
console.log(`  S-1 判据：${String(checks)} 项 · 通过 ${String(checks - failures)} · 失败 ${String(failures)}`)
console.log('='.repeat(72))
process.exit(failures === 0 ? 0 : 1)
