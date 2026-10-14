/**
 * U1 · `main.ts` 接线门（`u1:main-wiring:verify`）—— `G18` 的**生产接线**存在性 + 量具有效性
 *
 * ⚠️ **这是结构判据（text-lock），不是行为判据** —— 本仓库自己踩过它的坑
 *    （`L-QQP-09`：判据被自己的注释/新增代码打败）。因此它按"**量具有效性**"来写：
 *    ```text
 *    ① 对**真实** `src/main.ts` 跑检查器 ⇒ 必须 0 违规
 *    ② 对**四处人为削弱**的副本各跑一次 ⇒ **必须每次都判红**（且红的正是那一条）
 *    ```
 *    只有 ② 全过，① 才算有信息量（否则一个永远返回"通过"的检查器也能过 ①）。
 *
 * 行为读数（真会话走一轮、看召回是否按作用域过滤）**本门不做** —— 见交接单的"未取得"清单。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAIN_PATH = join(REPO_ROOT, 'src', 'main.ts')

interface Check {
  readonly id: string
  readonly label: string
  readonly pass: boolean
  readonly detail: string
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string): void => {
  checks.push({ id, label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

/** 违规 id（空数组 = 通过）。**纯函数**：喂真源码与喂削弱副本各跑一次。 */
export function mainWiringViolations(source: string): string[] {
  const violations: string[] = []
  /* ① 入口作用域：只对本机交互入口给 scope */
  if (!/this\.entryMode === 'interactive_human_console'/.test(source)) violations.push('scope_only_for_console')
  if (!/entryKind: 'cli_local'/.test(source)) violations.push('entry_kind_cli_local')
  /* ② 网关转交：本会话作用域进网关选项 */
  if (!/\.\.\.\(this\.turnScope !== undefined \? \{ scope: this\.turnScope \} : \{\}\)/.test(source)) {
    violations.push('gateway_scope_option')
  }
  /* ③ 召回授权器：注入 + 用真过滤函数 + 缺省来源域 */
  if (!/authorizeCandidates: async/.test(source)) violations.push('authorizer_injected')
  if (!/filterAuthorizedMemoryCandidates\(db, \{/.test(source)) violations.push('authorizer_uses_filter')
  if (!/defaultOriginRoom: ownerPrivateOriginRoom\(/.test(source)) violations.push('authorizer_default_origin')
  /* ④ 失败关闭：拿不到 scope ⇒ 全拒且计数如实 */
  if (!/authorized: \[\], denied: candidateIds\.length, deniedForMissingLabel: 0/.test(source)) {
    violations.push('authorizer_fail_closed')
  }
  /* ⑤ 不注入的那一路必须**不出现**授权器（否则"不接线"等于全拒） */
  const injectedGuard = /\.\.\.\(this\.turnScope !== undefined\s*\n\s*\?\s*\{/.test(source)
  if (!injectedGuard) violations.push('authorizer_only_when_scoped')
  /* ⑥ 写侧打标：只在**真的写下来了**那条上打，且用本轮作用域 */
  if (!/labelWrittenMemory\(\{/.test(source)) violations.push('write_side_labeling')
  if (!/result\.kind === 'written'/.test(source)) violations.push('write_side_only_when_written')
  /* ⑦ 自动记忆（**生产主路径**）也要打标：读数带 id 才打、没有作用域就跳过 */
  if (!/labelReadingCreatedMemories\(\{/.test(source)) violations.push('auto_path_labeling')
  if (!/reading\.createdMemoryIds !== undefined/.test(source)) violations.push('auto_path_ids_guard')
  /*
   * ⑧ ★ U1 / `WP2b-2b`（`ADR-139` `D01`）：**入站平台事实 ⇒ 本轮作用域** 的整条链。
   *
   * ⚠️ 这一组判据的存在理由是"**接线会静默回退**"：这条链横跨 5 个文件、全是**可选**参数，
   *   任何一处被删掉都**不会**让 typecheck 报错、也**不会**让别的门变红 ——
   *   它只会让"多用户身份解析"悄悄变成"永远不解析"，而那正是本仓库最忌讳的
   *   "看起来接了其实没接"。⇒ 每处落点都要能被源码文本判到（先例：T8/T9 的接线登记表）。
   */
  if (!/resolveInboundTurnScope\(\{/.test(source)) violations.push('inbound_scope_resolved')
  if (!/const ownerUserId = resolveIds\(input\.userName\)\.userId/.test(source)) violations.push('inbound_scope_owner_from_binding')
  if (!/db: input\.kernel\.stores\.db, ownerUserId/.test(source)) violations.push('inbound_scope_uses_real_store')
  /* 实际会话选择链：解析失败直接拒绝，不能回落到 owner 会话。 */
  if (!/if \(outcome\.failClosed \|\| outcome\.scope === undefined \|\| outcome\.userId === undefined\) throw new Error\('qq_identity_resolution_failed'\)/.test(source)) {
    violations.push('inbound_scope_fail_closed')
  }
  /* 本轮作用域**只**在 compileTurn 里用出去（每轮优先）；缺席 ⇒ 字段不出现 */
  if (!/\.\.\.\(turnScope !== undefined \? \{ scope: turnScope \} : \{\}\)/.test(source)) {
    violations.push('per_turn_scope_passed')
  }
  return violations
}

const real = readFileSync(MAIN_PATH, 'utf8')

// ===========================================================================
// ① 真实源码 ⇒ 0 违规
// ===========================================================================
{
  const violations = mainWiringViolations(real)
  record(
    'T1.1',
    '真实 `src/main.ts`：五组接线点齐备',
    violations.length === 0,
    violations.length === 0 ? 'violations=0' : `violations=${violations.join(',')}`
  )
}

// ===========================================================================
// ② 量具有效性 · 四处**人为削弱**各必须判红
// ===========================================================================
const mutations: { id: string; label: string; mutate: (source: string) => string; expect: string }[] = [
  {
    id: 'T2.1',
    label: '把"只对本机入口给 scope"放宽成**对所有入口**',
    mutate: (source) => source.replace(/this\.entryMode === 'interactive_human_console'/, 'true'),
    expect: 'scope_only_for_console',
  },
  {
    id: 'T2.2',
    label: '**掐掉**网关的 scope 转交',
    mutate: (source) =>
      source.replace(/\.\.\.\(this\.turnScope !== undefined \? \{ scope: this\.turnScope \} : \{\}\)/, ''),
    expect: 'gateway_scope_option',
  },
  {
    id: 'T2.3',
    label: '把授权器换成**永远放行**（不查标签）',
    mutate: (source) =>
      source.replace(/filterAuthorizedMemoryCandidates\(db, \{/, 'Promise.resolve({ authorized: candidateIds, denied: 0, deniedForMissingLabel: 0 }) || ({'),
    expect: 'authorizer_uses_filter',
  },
  {
    id: 'T2.4',
    label: '把失败关闭改成**放行全部**（缺 scope 也照过）',
    mutate: (source) =>
      source.replace(
        /authorized: \[\], denied: candidateIds\.length, deniedForMissingLabel: 0/,
        'authorized: candidateIds, denied: 0, deniedForMissingLabel: 0'
      ),
    expect: 'authorizer_fail_closed',
  },
  {
    id: 'T2.5',
    label: '**掐掉**写侧打标（新记忆不再带归属标签）',
    mutate: (source) => source.replace(/labelWrittenMemory\(\{/, 'void 0 /*'),
    expect: 'write_side_labeling',
  },
  {
    id: 'T2.6',
    label: '**掐掉**自动记忆路径的打标（生产主路径又变成不打标）',
    mutate: (source) => source.replace(/labelReadingCreatedMemories\(\{/, 'void 0 /*'),
    expect: 'auto_path_labeling',
  },
  /*
   * ★ U1 / `WP2b-2b`（`ADR-139` `D01`）：**入站平台事实 ⇒ 本轮作用域** 那一组的正控。
   * ⚠️ 没有这两条，"⑧ 组"就是**没人验过的判据** —— 判据自己也可能永远不触发，
   *   那就是"门看起来守住了，其实守的是空气"。
   */
  {
    id: 'T2.7',
    label: '**掐掉**入站身份解析（每轮作用域永远解析不出来 ⇒ 静默回到会话级）',
    mutate: (source) => source.replace(/resolveInboundTurnScope\(\{/, 'void 0 /*'),
    expect: 'inbound_scope_resolved',
  },
  {
    id: 'T2.8',
    label: '把身份解析失败改成返回原主人会话',
    mutate: (source) =>
      source.replace(
        /if \(outcome\.failClosed \|\| outcome\.scope === undefined \|\| outcome\.userId === undefined\) throw new Error\('qq_identity_resolution_failed'\)/,
        'if (outcome.failClosed) return input.owner'
      ),
    expect: 'inbound_scope_fail_closed',
  },
]
for (const mutation of mutations) {
  const mutated = mutation.mutate(real)
  const changed = mutated !== real
  const violations = mainWiringViolations(mutated)
  record(
    mutation.id,
    `量具有效性 · 削弱后必须判红：${mutation.label}`,
    changed && violations.includes(mutation.expect),
    `changed=${String(changed)} · violations=${violations.join(',') || '（无）'}`
  )
}

// ===========================================================================
// 汇总
// ===========================================================================
const failed = checks.filter((c) => !c.pass)
const passed = failed.length === 0
console.log('')
console.log(`  measured_count = ${checks.length}`)
console.log(`  ${passed ? '✅' : '❌'} u1:main-wiring:verify = ${passed ? 'PASS' : 'FAIL'}`)
console.log('  ⚠️ 结构判据（text-lock）：只证"接线点在"，**不证**行为；行为读数见交接单"未取得"清单。')
if (!passed) {
  console.log('  失败项：')
  for (const c of failed) console.log(`    - ${c.id} ${c.label}：${c.detail}`)
}
process.exitCode = passed ? 0 : 1
