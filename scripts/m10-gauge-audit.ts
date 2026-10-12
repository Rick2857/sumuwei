/**
 * **判据审计**（`L-M10-64` / `L-M10-65` 的产物；常驻，供量具门调用）。
 *
 * ============================================================================
 *  为什么需要它
 * ============================================================================
 * 本仓库已经抓到**三例**"读数看起来确定、其实量错了东西"：
 * ```text
 * ① `m10:e2e:verify` 的 `G39`：判据是 `members.length <= allRows.length
 *    && members.join(',') === [...members].sort().join(',')`
 *    ⇒ 子集不可能比全集大（恒真）+ 有序恒真 ⇒ **任何输入都过**
 *    ⇒ 一条"关于冲突"的检查，**观察到 0 个冲突**却始终是绿的（`L-M10-64`）
 * ② `m10-completion:verify` 的 `I1`/`I3`：`goalCompletionUnitOf(marker)
 *    === goalCompletionUnitOf(marker)`
 *    ⇒ 纯函数、**同一个参数**、同一个表达式里调两次 ⇒ **恒真**
 * ③ `m10:gateway:verify` 的 `S5`：判据就是字面量 `true`，而 expected 却写着
 *    '排序规则不变'（用断言的口吻声称一件**它没验**的事）
 * ```
 * 共同形状：**"测了个 0"与"什么都没测"在输出上长得一样**（AGENTS §6.8）。
 *
 * ============================================================================
 *  它断言什么（三条，都机械可判）
 * ============================================================================
 * ```text
 * A) **分母自证**：解析到的 `record(...)` 调用数必须 > 0
 *    （"一条都没解析到"与"全部健康"在输出上长得一样）
 * B) **无条件为真必须自报家门**：pass 文本恰为 `true` 的调用，必须满足其一：
 *    ① 同一 `(file, id)` 还出现过**至少一次 pass 非 `true`**
 *       ⇒ 它是**两分支判据的绿半边**（例：`m10:measurement:verify` 的
 *          `V-<注入>`：找不到注入点记 `false`、找到记 `true` —— **能红，是真判据**）
 *    ② 它的 `expected` 文本里含**非断言声明**
 *       （`不作断言` / `如实报出` / `如实列出` / `如实登记` / `登记为` /
 *         `清单在场` / `具名交接` / `两档分列`）
 *    ⇒ 否则红：**一条永远绿、又不承认自己是登记的检查，就是空量具**
 * C) **自比较恒真**：pass 文本里出现 `f(...) === f(...)` 且两个调用文本**逐字相同** ⇒ 红
 * ```
 *
 * ⚠️ **它是筛子，不是判决**：启发式会漏（子集关系要靠数据流才能判），也会误报
 *    —— 实测误报过一次（`V-<注入>` 被当成"无条件为真"，而它其实是两分支）。
 *    ⇒ 所以它只报**候选**并要求"自报家门"，不自动改任何东西。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

/** `expected` 里出现这些词 ⇒ 该行**自己承认**它不作断言 */
export const NON_ASSERTION_MARKERS = [
  '不作断言',
  '如实报出',
  '如实列出',
  '如实登记',
  '登记为',
  '清单在场',
  '具名交接',
  '两档分列',
] as const

export interface GaugeCall {
  readonly file: string
  readonly id: string
  readonly label: string
  /** `record()` 的第 4 个参数（expected）—— 用它判"是否自报家门" */
  readonly expected: string
  /** `record()` 的第 6 个参数（pass）的源码文本 */
  readonly pass: string
}

export interface GaugeAudit {
  readonly callSites: number
  readonly scanned: number
  /** pass 恰为 `true` 的调用数（**不等于**违规数：两分支绿半边也算在内） */
  readonly unconditional: readonly GaugeCall[]
  /** 违规：无条件为真 **且** 未自报家门 **且** 不是两分支的绿半边 */
  readonly undeclared: readonly GaugeCall[]
  /** 违规：`f(...) === f(...)` 自比较恒真 */
  readonly selfComparison: readonly GaugeCall[]
  /** 自报家门的无条件为真（合规，但要在读数里如实报出条数） */
  readonly declared: readonly GaugeCall[]
}

function calleeName(node: ts.CallExpression): string {
  const callee = node.expression
  if (ts.isIdentifier(callee)) return callee.text
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text
  return ''
}

/** 扫一个目录下的 `m10-*.ts`，抽出全部 `record(...)` */
export function auditGaugeConditions(scriptsDir: string): GaugeAudit {
  const files = readdirSync(scriptsDir)
    .filter((name) => /^m10-.*\.ts$/.test(name))
    .sort()

  const perFileIds = new Map<string, Map<string, string[]>>()
  const all: GaugeCall[] = []
  let callSites = 0

  for (const file of files) {
    const text = readFileSync(join(scriptsDir, file), 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && calleeName(node) === 'record') {
        callSites += 1
        const args = node.arguments
        if (args.length >= 6) {
          const idArg = args[1]!
          const id = ts.isStringLiteral(idArg) ? idArg.text : idArg.getText(source)
          const labelArg = args[2]!
          const label = ts.isStringLiteral(labelArg) ? labelArg.text : labelArg.getText(source)
          const expectedArg = args[3]!
          const expected = ts.isStringLiteral(expectedArg) ? expectedArg.text : expectedArg.getText(source).replace(/^['"`]|['"`]$/g, '')
          const pass = args[5]!.getText(source)
          all.push({ file, id, label, expected, pass })
          const byId = perFileIds.get(file) ?? new Map<string, string[]>()
          byId.set(id, [...(byId.get(id) ?? []), pass.trim()])
          perFileIds.set(file, byId)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  const unconditional = all.filter((call) => call.pass.trim() === 'true')
  const selfComparison = all.filter((call) => {
    /* `f(X) === f(X)`：等号两侧**逐字相同**且都含一次调用 */
    const match = /^(.+?)\s*===\s*(.+)$/.exec(call.pass.trim())
    if (match === null) return false
    const left = match[1]!.trim()
    const right = match[2]!.trim()
    return left === right && left.includes('(')
  })

  const declared: GaugeCall[] = []
  const undeclared: GaugeCall[] = []
  for (const call of unconditional) {
    const passes = perFileIds.get(call.file)?.get(call.id) ?? []
    const twoBranch = passes.some((text) => text !== 'true')
    const declares = NON_ASSERTION_MARKERS.some((marker) => call.expected.includes(marker))
    if (twoBranch || declares) declared.push(call)
    else undeclared.push(call)
  }

  return {
    callSites,
    scanned: all.length,
    unconditional,
    undeclared,
    selfComparison,
    declared,
  }
}
