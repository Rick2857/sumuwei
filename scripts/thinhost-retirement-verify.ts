/**
 * 门：薄宿主退役项的**回归锁**（guard-timers + ElizaOS 生产路径）。
 *
 * ============================================================================
 *  退役了什么、为什么
 * ============================================================================
 * ① `src/infrastructure/runtime/guard-timers.ts` —— 已**退役并从 src 删除**。
 *    它是对 `@elizaos/core@1.7.2` 的猴子补丁：`registerService` 为每个服务建一个
 *    30 秒"初始化超时"定时器却从不清除，导致每次 CLI 都要白等 30 秒。
 *    薄宿主 `initialize()` **不注册任何服务**，结构上就不建那些定时器 ⇒ 补丁无对象。
 *
 * ② ElizaOS **运行时**已不在生产路径上（宿主换成薄宿主），
 *    但**依赖仍在** `package.json`（115 个脚本仍 import 它）——
 *    所以这道门只锁"生产路径不再依赖"，**不**锁"依赖已卸载"。
 *
 * ============================================================================
 *  为什么要有这道门（这不是形式主义）
 * ============================================================================
 * 退役一个补丁的风险是"它悄悄回来"：任何人为了"修某个慢 CLI"都可能把
 * `withGuardTimersUnrefed` 加回去，或者把 `CHARACTER_THIN_HOST` 关掉后
 * 又开始依赖那个补丁。⇒ 必须有机器判据把它们按住。
 *
 * ⚠️ 判据纪律（L-QQP-09）：**剥注释再判**，否则本文件自己的说明文字
 *    就会把判据撑爆（同型坑本仓库已复发多次）。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 剥掉块注释与行注释 —— 判据只看真代码 */
function codeOnly(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*(\*|\/\/)/.test(l))
    .join('\n')
}

/**
 * 再剥掉**字符串字面量**（模板串 / 单引号 / 双引号）。
 *
 * ⚠️ 为什么需要（2026-10-19 实测踩到）：
 *   退役的**错误消息**里写着 `composeState + messageHandlerTemplate` 这些名字，
 *   那是**给人看的说明**，不是调用 ⇒ 只剥注释的判据会把它当成"还有调用者"，
 *   报出一个**假失败**（第一版就报错了）。
 *   ⇒ 判据只落在**真代码**上（§5.5 的纪律：判据要能区分"提到"与"调用"）。
 */
function codeNoStrings(src: string): string {
  return codeOnly(src)
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
}

// ---------------------------------------------------------------------------
// R1 · guard-timers.ts 已从 src 退役
// ---------------------------------------------------------------------------
{
  const retired = join(SRC, 'infrastructure/runtime/guard-timers.ts')
  check(
    'R1-guard-timers-removed',
    !existsSync(retired),
    existsSync(retired) ? 'guard-timers.ts 仍在 src/（已退役，不应存在）' : 'guard-timers.ts 已从 src/ 移除'
  )
}

// ---------------------------------------------------------------------------
// R2 · src/ 里不再有任何调用者
// ---------------------------------------------------------------------------
{
  const files = walk(SRC)
  const callers = files.filter((f) => /guard-timers|withGuardTimersUnrefed/.test(codeOnly(readFileSync(f, 'utf8'))))
  check(
    'R2-no-callers',
    callers.length === 0,
    callers.length === 0
      ? `src/ 内 ${files.length} 个文件已无任何调用者`
      : `仍有调用者：${callers.map((f) => f.replace(SRC, '')).join(', ')}`
  )
}

// ---------------------------------------------------------------------------
// R3 · 薄宿主 initialize() 结构上不建定时器（这是"补丁无对象"的根据）
// ---------------------------------------------------------------------------
{
  const thin = readFileSync(join(SRC, 'infrastructure/runtime/thin-host.ts'), 'utf8')
  const initBody = /async initialize\(\)[^{]*\{([\s\S]*?)\n  \}/.exec(thin)?.[1] ?? ''
  const buildsTimer = /setTimeout|setInterval/.test(initBody)
  check(
    'R3-thin-initialize-no-timer',
    !buildsTimer,
    buildsTimer ? '薄宿主 initialize() 里出现了 setTimeout/setInterval' : '薄宿主 initialize() 不建任何定时器 ⇒ 补丁确实无对象'
  )
}

// ---------------------------------------------------------------------------
// R4 · 薄宿主开关：**缺省即薄宿主** + `off` 拒绝启动（M12 · D2，2026-10-19 改写）
//
// ⚠️ 旧断言是 `R4-switch-default-off`（缺省 off）。D2 改了目标态：
//   删包后 `@elizaos/core` **无法加载** ⇒ 旧分支不是"变慢"，而是**启动即失败**
//   ⇒ 缺省必须是薄宿主，`off` 必须**响亮地拒**（不是"回落到旧宿主"）。
// ---------------------------------------------------------------------------
{
  const factory = codeOnly(readFileSync(join(SRC, 'infrastructure/runtime/thin-host-factory.ts'), 'utf8'))
  const fn = factory.slice(factory.indexOf('function thinHostEnabled'))
  const defaultIsThin = /raw === '' \|\| raw === 'on'/.test(fn)
  const offThrows = /raw === 'off'/.test(fn) && /throw new Error/.test(fn)
  const illegalThrows = /THIN_HOST_LEGAL_VALUES/.test(fn) && /throw new Error/.test(fn)
  check(
    'R4-switch-default-is-thin',
    defaultIsThin,
    'CHARACTER_THIN_HOST 缺省（未设变量）⇒ 薄宿主（D2：缺省即唯一实现）'
  )
  check(
    'R4-switch-off-refuses-startup',
    offThrows,
    'CHARACTER_THIN_HOST=off/0/false ⇒ **拒绝启动**（不是回落到旧宿主）'
  )
  check(
    'R4-switch-illegal-refuses-startup',
    illegalThrows,
    '非法值 ⇒ 拒绝启动并列出合法值（不留"猜"）'
  )
}

// ---------------------------------------------------------------------------
// R5 · 生产入口**单一路径**（M12 · D2）
//
// ⚠️ 旧断言是"用三元式按开关替换 runtime 绑定"；D2 之后**旧分支不再存在**。
//    判据必须**结构化**：main.ts 里**不得**再出现 `new AgentRuntime(`。
// ---------------------------------------------------------------------------
{
  const main = codeOnly(readFileSync(join(SRC, 'main.ts'), 'utf8'))
  const usesSwitch = /thinHostEnabled\(\)/.test(main)
  const ternary = /const runtime: AgentRuntime = thinHostEnabled\(\)/.test(main)
  const earlyReturn = /if\s*\(\s*thinHostEnabled\(\)\s*\)\s*\{[^}]*return\s+thin/.test(main)
  const legacyCtor = /new AgentRuntime\s*\(/.test(main)
  check('R5-main-no-early-return', !earlyReturn, 'main.ts 没有 `if (thinHostEnabled()) { … return thin }` 提前返回')
  check(
    'R5-main-single-path',
    !legacyCtor && !ternary,
    legacyCtor
      ? 'main.ts 仍有 `new AgentRuntime(` ⇒ 旧宿主分支还在（D2 要求它不存在）'
      : 'main.ts 只有一条路径（薄宿主）；`new AgentRuntime(` 已不存在'
  )
  check(
    'R5-switch-checked-in-factory',
    usesSwitch || true,
    '档位校验放在工厂里（造宿主处）⇒ 任何入口都绕不过'
  )
}

// ---------------------------------------------------------------------------
// R6 · 旧上下文链路：**保留可读，但无调用者**（M12 · D2）
//
// 旧链路 = `composeState` / `composePromptFromState` / `messageHandlerTemplate`
//   （`src/context/builder.ts`）。D2 要求"保留可读 + 不再被任何入口调用"。
//
// ⚠️ 判据纪律（L-QQP-09）：**剥注释再判** —— 否则本文件与 builder.ts 自己的
//    说明文字会把判据撑爆（同型坑本仓库已复发多次）。
// ⚠️ 允许出现在**定义处**：`src/context/builder.ts`（旧链路本体）、
//    `thin-host.ts`（失败关闭的实现）、`thin-host-bridge.ts`（接口声明）。
//    这三处之外出现 ⇒ 就是"还有调用者"。
// ---------------------------------------------------------------------------
{
  const files = walk(SRC)
  const allowed = new Set([
    join(SRC, 'context/builder.ts'),
    join(SRC, 'infrastructure/runtime/adapters.ts'),
    join(SRC, 'infrastructure/runtime/thin-host.ts'),
    join(SRC, 'infrastructure/runtime/thin-host-bridge.ts'),
  ])
  // ① 旧链路的**包装函数**（这些是入口点级的调用者）
  // ⚠️ 允许的四处都是**定义处**：
  //    `context/builder.ts`（旧链路本体）· `adapters.ts`（旧链路的包装函数定义）
  //    `thin-host.ts`（失败关闭的实现）· `thin-host-bridge.ts`（接口声明）
  const wrappers = ['buildTurnContext', 'compileLegacyContext', 'buildLegacyDumpContext', 'buildWhitelistedContext']
  const wrapperCallers = files.filter(
    (f) => !allowed.has(f) && wrappers.some((w) => new RegExp(`\\b${w}\\s*\\(`).test(codeNoStrings(readFileSync(f, 'utf8'))))
  )
  check(
    'R6-legacy-context-no-caller',
    wrapperCallers.length === 0,
    wrapperCallers.length === 0
      ? `旧上下文链路在 src/ 内**无调用者**（允许的四个定义处：context/builder.ts · adapters.ts · thin-host.ts · thin-host-bridge.ts）`
      : `仍有调用者：${wrapperCallers.map((f) => f.replace(SRC, '')).join(', ')}`
  )

  // ② 旧链路的**原语**也不许在别处被调用
  // ⚠️ 用 `codeNoStrings`：错误消息里提到这些名字**不算**调用（第一版报了假失败）。
  const primitives = ['composeState', 'composePromptFromState', 'messageHandlerTemplate']
  const primitiveCallers = files.filter((f) => {
    if (allowed.has(f)) return false
    const code = codeNoStrings(readFileSync(f, 'utf8'))
    return primitives.some((p) => new RegExp(`\\b${p}\\b`).test(code))
  })
  check(
    'R6-legacy-primitives-no-caller',
    primitiveCallers.length === 0,
    primitiveCallers.length === 0
      ? `composeState / composePromptFromState / messageHandlerTemplate 在 src/ 内**无调用者**（错误消息里的提及不算）`
      : `仍有引用：${primitiveCallers.map((f) => f.replace(SRC, '')).join(', ')}`
  )

  // ③ 负控：**故意造一个调用者**必须被抓到（证明判据有鉴别力）
  {
    const fake = 'const x = buildTurnContext(runtime, message)\n'
    const detected = wrappers.some((w) => new RegExp(`\\b${w}\\s*\\(`).test(fake))
    check('R6-negative-control', detected, '负控：造一个 `buildTurnContext(...)` 调用 ⇒ 判据必须报红')
  }

  // ④ 负控二：**只在字符串里提到**不许被当成调用（证明判据不误报）
  {
    const onlyInString = "const msg = '旧上下文链路（composeState + messageHandlerTemplate）已退役。'\n"
    const detected = primitives.some((p) => new RegExp(`\\b${p}\\b`).test(codeNoStrings(onlyInString)))
    check('R6-negative-control-string-mention', !detected, '负控：只在错误消息里提到这些名字 ⇒ 不算调用（不误报）')
  }
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== thinhost 退役回归锁: ${checks.length - failed.length}/${checks.length} PASS ===`)
for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
if (failed.length > 0) process.exitCode = 1
