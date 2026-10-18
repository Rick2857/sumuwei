/**
 * 门：薄宿主**接口面穷举**（第三次事故的直接补丁）。
 *
 * ============================================================================
 *  为什么必须有这道门
 * ============================================================================
 * 启用薄宿主时连续三次在生产失败，第三次是：
 *     `this.runtime.ensureWorldExists is not a function`
 * 根因不是漏写实现，而是**我用"预估"挑方法**：我读了几处调用点，列出"12 个方法"，
 * 就当那是全部。`ensureWorldExists` 与 `getSetting` 都在**没扫到的地方**被调用。
 *
 * ⇒ 正确做法：**穷举 `src/**` 里所有 `runtime.<标识符>(` 与 `runtime.<属性>`**，
 *    逐个断言薄宿主上存在。这道门把"接口面"从**人的记忆**变成**机器判据**。
 *
 * ⚠️ 判据纪律（L-QQP-09）：必须**剥注释**再判定 ——
 *    否则本文件自己写的说明文字（里面就举着 `ensureWorldExists` 等名字）
 *    会把判据撑爆（同型坑已复发多次）。
 *
 * 断言：
 *   S1  `src/**` 穷举出的宿主方法集 ⊆ 薄宿主实现集（无遗漏）
 *   S2  薄宿主没有多实现一堆没人调的方法（避免"实现了但没人验证"）
 *   S3  关键方法逐个可调用（非 undefined 的函数）
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ThinHostRuntime } from '../src/infrastructure/runtime/thin-host.ts'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

// ⚠️ 用 `fileURLToPath` 而不是 `URL.pathname` 的手工拼接：
//    后者在 Windows 上要处理 `%20` 与盘符，在 Linux 上又会因仓库路径含空格而出错
//    （服务器实测：拼出来的路径扫不到任何文件 ⇒ 门静默输出空）。
const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 剥掉注释，避免本文件的说明文字把判据撑爆 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n')
}

// ---------------------------------------------------------------------------
// 穷举：所有 `runtime.<name>(` 与 `this.runtime.<name>(` 与 `runtime.<name>` 赋值
// ---------------------------------------------------------------------------
const CALL = /(?:this\.)?runtime\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g
const PROP = /(?:this\.)?runtime\.([a-zA-Z_][a-zA-Z0-9_]*)\b(?!\s*\()/g

// 明显不是宿主 API 的：
//  · `now` / `withDeadline` —— GoalUnderstandingRuntime 端口（kernel 自己的，不是宿主）
//  · `ok` / `ts` / `call` / `package` / `version` / `snapshot` / `operate`
//    —— 正则扫到的**同名局部变量**（`runtime.ok`、`runtime.ts` 之类），
//       或 ActionRequest / 快照端口的字段，不是宿主 runtime 的 API。
const NOT_HOST = new Set([
  'now', 'withDeadline',
  'ok', 'ts', 'call', 'package', 'version', 'snapshot', 'operate',
])

const methods = new Set<string>()
const props = new Set<string>()
let filesScanned = 0
for (const f of walk(SRC)) {
  // 薄宿主自己的文件跳过（它是实现，不是调用方）
  if (f.includes('thin-host')) continue
  const code = stripComments(readFileSync(f, 'utf8'))
  filesScanned += 1
  let m: RegExpExecArray | null
  CALL.lastIndex = 0
  while ((m = CALL.exec(code)) !== null) if (!NOT_HOST.has(m[1])) methods.add(m[1])
  PROP.lastIndex = 0
  while ((m = PROP.exec(code)) !== null) if (!NOT_HOST.has(m[1])) props.add(m[1])
}

const expected = new Set([...methods, ...props])
console.log(`scanned ${filesScanned} ts files under src/`)
console.log(`required host surface (${expected.size}): ${[...expected].sort().join(', ')}`)

// ---------------------------------------------------------------------------
// 薄宿主上是否存在
//
// ⚠️ 属性（adapter/agentId/events/character/logger/settings）声明在**实例字段**上，
//    不在 prototype 上 ⇒ 不能用 `proto[p]` 判（第一版这么写，12 个属性全报 MISSING）。
//    必须真的造一个实例来查。
// ---------------------------------------------------------------------------
// 造实例需要一个 pool；这里给个假 pool —— 本门**只做结构判定，不碰数据库**。
const fakePool = {
  ended: false,
  end: async function (): Promise<void> {
    ;(fakePool as { ended: boolean }).ended = true
  },
  query: (async () => ({ rows: [] })) as unknown,
}
const instance = new ThinHostRuntime({
  character: { name: '探针角色', id: 'probe' },
  agentId: '00000000-0000-4000-8000-0000000000ff',
  settings: {},
  pool: fakePool as never,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
})
const proto = ThinHostRuntime.prototype as unknown as Record<string, unknown>

const missingMethods = [...methods].filter((m) => typeof proto[m] !== 'function')
// ⚠️ `adapter` 是**注册后才存在**的字段（`registerPlugin()` 才赋值）。
//    旧宿主同样如此：`db/index.ts:440-445` 明确处理"runtime.adapter 仍为空"并给出
//    「plugin-sql 未能注册数据库适配器」的错误 ⇒ 新实例上为 undefined 是**同形**的，
//    不是缺陷。所以它只判"字段存在于类上"，不判"新实例上已有值"。
const LAZY_FIELDS = new Set(['adapter'])
const missingProps = [...props].filter((p) => {
  const v = (instance as unknown as Record<string, unknown>)[p]
  if (v !== undefined) return false
  // 惰性字段：只要原型/类声明里有这个名字就算存在
  return !(p in (ThinHostRuntime.prototype as object)) && !(p in (instance as object))
})

check(
  'S1-methods-covered',
  missingMethods.length === 0,
  missingMethods.length === 0
    ? `穷举出的 ${String(methods.size)} 个方法全部已实现`
    : `缺少方法：${missingMethods.join(', ')}`
)
check(
  'S1-props-covered',
  missingProps.length === 0,
  missingProps.length === 0
    ? `穷举出的 ${String(props.size)} 个属性全部存在（实例字段上）`
    : `缺少属性：${missingProps.join(', ')}`
)

// 逐个打印，确保读数可核对
for (const m of [...methods].sort()) {
  console.log(`   method ${m}: ${typeof proto[m] === 'function' ? 'OK' : 'MISSING'}`)
}

// --- S2：薄宿主不该多实现一堆没人调的方法 ---
//   允许清单：穷举集 + 宿主自身基础设施 + 内部实现细节（exec/exec2/ensureRow/
//   ensureAgentRow 是私有辅助，不是"对外 API"，但它们是实打实被 ensure* 调用的）。
const ALLOWED_EXTRA = new Set([
  'registerPlugin', 'runPluginMigrations', 'closeDatabase', 'isDatabaseClosed', 'initialize', 'stop',
  'exec', 'exec2', 'ensureRow', 'ensureAgentRow',
])
const implemented = Object.getOwnPropertyNames(ThinHostRuntime.prototype).filter(
  (n) => n !== 'constructor' && typeof proto[n] === 'function'
)
const extras = implemented.filter((n) => !expected.has(n) && !ALLOWED_EXTRA.has(n))
check(
  'S2-no-dead-methods',
  extras.length === 0,
  extras.length === 0 ? `没有多余方法（实现 ${implemented.length} 个）` : `多余方法：${extras.join(', ')}`
)

// --- S3：关键方法逐个确认为函数 ---
const CRITICAL = ['initialize', 'stop', 'registerPlugin', 'runPluginMigrations', 'useModel',
  'getMemories', 'createMemory', 'ensureAgentRow', 'ensureEntity', 'ensureWorldExists',
  'ensureRoomExists', 'ensureParticipantInRoom', 'getSetting']
const notCallable = CRITICAL.filter((m) => typeof proto[m] !== 'function')
check(
  'S3-critical-callable',
  notCallable.length === 0,
  notCallable.length === 0 ? `${CRITICAL.length} 个关键方法全部可调用` : `不可调用：${notCallable.join(', ')}`
)

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== thinhost 接口面穷举: ${checks.length - failed.length}/${checks.length} PASS ===`)
for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
if (failed.length > 0) process.exitCode = 1
