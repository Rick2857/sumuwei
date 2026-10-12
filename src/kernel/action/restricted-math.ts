/**
 * 受限计算核心（计划书 §3.1「精确计算」）—— **纯函数，不读时间/环境/文件**。
 *
 * ============================================================================
 *  为什么"白名单"必须落在 AST 上，而不是正则上
 * ============================================================================
 * 计划书 §3.1 逐字：「允许数值常量、括号、列举操作符/函数，禁止赋值、访问器、
 * 数组、导入、随机、嵌套解析执行及未知函数；函数名与 AST 类型共同检查」，
 * 以及 §4A 计算第 ⑤ 组：「禁止的输入在**执行前**拒绝（**不是**正则黑名单）」。
 *
 * mathjs 的解析器本身支持赋值、数组、函数定义、`import`、属性访问等
 * （准备包 §2 已核对固定源码）。因此本文件做两件事，**顺序不可颠倒**：
 * ```text
 * ① parse（只是解析，不求值）
 * ② 走一遍 AST：类型白名单 + 函数名白名单 + 结构性上限（节点数/深度/整数幂指数）
 * ③ 通过之后才 compile().evaluate()
 * ```
 * 任何一步不通过 ⇒ **不执行**，返回一条可解释的拒绝原因。
 *
 * ⚠️ 输入**不得先转 JS 浮点数**：mathjs 用 `number: 'BigNumber'` + `precision: 64`
 *    建立实例，`0.1+0.2` 得到精确的 `0.3`（这正是 §4A 计算第 ① 组的判据）。
 *
 * ⚠️ 有限精度是**如实标注**的：除法与开方按 64 位有效数字给出，`approx: true`；
 *    加法/减法/乘法/整数幂是精确的，`approx: false`。首版**不谎称无限精度**。
 */

/*
 * ⚠️ **上限 / 白名单 / 读数类型刻意住在 `restricted-math-contract.ts`**（那个文件不 import mathjs）：
 *    于是 `math-calculate.ts`（父进程）只碰契约 ⇒ 能力关闭时**不加载 mathjs**（计划书 §2 第 5 点）。
 *    本文件只保留**需要 mathjs** 的那一半，并把契约符号**原样 re-export**（既有导入点不动）。
 */
import { all, create, type MathNode } from 'mathjs'

import {
  ALLOWED_FUNCTION_NAMES,
  ALLOWED_NODE_TYPES,
  ALLOWED_OPERATOR_FNS,
  RESTRICTED_MATH_LIMITS,
  type RestrictedMathFailure,
  type RestrictedMathOutcome,
  type RestrictedMathRejection,
} from './restricted-math-contract.ts'

export {
  ALLOWED_FUNCTION_NAMES,
  ALLOWED_NODE_TYPES,
  ALLOWED_OPERATOR_FNS,
  RESTRICTED_MATH_LIMITS,
  RESTRICTED_MATH_REJECTION_TEXT,
} from './restricted-math-contract.ts'
export type {
  RestrictedMathFailure,
  RestrictedMathOutcome,
  RestrictedMathRejection,
  RestrictedMathSuccess,
} from './restricted-math-contract.ts'

/**
 * 受限 mathjs 实例。
 *
 * ⚠️ 它**只**在本模块里建一次：配置（BigNumber / precision）与"允许的函数子集"
 *    必须与白名单是同一份事实 —— 两处各写一遍，早晚会分叉。
 */
const restricted = create(all, { number: 'BigNumber', precision: RESTRICTED_MATH_LIMITS.precision })

function nodeTypeOf(node: MathNode): string {
  return (node as unknown as { type: string }).type
}

/**
 * 一个数值常量节点的**数值**（不是数值 ⇒ `undefined`）。
 *
 * ⚠️ 真实事故（本批实测，2026-10-04）：在 `{ number: 'BigNumber' }` 实例里，
 *    `ConstantNode.value` **不是 JS number，而是 decimal.js 的 Decimal 对象**。
 *    第一版白名单写的是 `typeof value !== 'number'` ⇒ **所有合法算式都被拒**，
 *    而 19 条禁止构造全都被"正确地"拒绝 —— 于是"看起来在工作"，实际一个数都算不出来。
 *    这正是 AGENTS.md §6.9 那一类：读数是真的，量的是错的东西。
 *
 * 因此这里**同时**接受两种形状，并且**只**接受这两种：
 *   · `typeof value === 'number'`（JS number 模式）
 *   · mathjs 的 BigNumber（`isBigNumber === true`）
 * 字符串（`"abc"`）与 `undefined`（`#comment` 会产出这种节点）一律拒绝。
 */
function constantValueOf(node: MathNode): unknown {
  return (node as unknown as { value: unknown }).value
}

function isBigNumberValue(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { isBigNumber?: unknown }).isBigNumber === true
  )
}

function isNumericConstantValue(value: unknown): boolean {
  return typeof value === 'number' || isBigNumberValue(value)
}

/** 常量节点的值转成 JS number（用于**整数幂指数**这种必须是小整数的判断） */
function numericConstantToNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (isBigNumberValue(value)) {
    const text = String(value)
    const asNumber = Number(text)
    return Number.isFinite(asNumber) ? asNumber : undefined
  }
  return undefined
}

function childrenOf(node: MathNode): MathNode[] {
  const maybe = node as unknown as { args?: MathNode[]; content?: MathNode }
  if (Array.isArray(maybe.args)) return maybe.args
  if (maybe.content !== undefined) return [maybe.content]
  return []
}

/**
 * **静态检查**：只走 AST，不做任何求值。返回 null = 通过。
 *
 * 这是"执行前拒绝"唯一的地方：适配器在调用它之前不会碰到 mathjs 的求值路径。
 */
export function inspectRestrictedExpression(expression: string): RestrictedMathFailure | null {
  return scanRestrictedExpression(expression).problem
}

interface RestrictedMathScan {
  problem: RestrictedMathFailure | null
  nodeCount: number
  depth: number
  maxIntExponentUsed: number
}

/**
 * 走一遍 AST 的**唯一**实现（静态检查与读数来自同一趟 —— 两趟早晚会分叉）。
 *
 * ⚠️ 它**不求值**：这是"执行前拒绝"的全部内容。
 */
function scanRestrictedExpression(expression: string): RestrictedMathScan {
  const fail0 = (problem: RestrictedMathFailure): RestrictedMathScan => ({
    problem,
    nodeCount: 0,
    depth: 0,
    maxIntExponentUsed: 0,
  })

  if (expression.trim() === '') {
    return fail0({ ok: false, reason: 'empty', detail: '算式为空' })
  }
  if (expression.length > RESTRICTED_MATH_LIMITS.maxChars) {
    return fail0({
      ok: false,
      reason: 'too_long',
      detail: `算式 ${String(expression.length)} 字符，超过上限 ${String(RESTRICTED_MATH_LIMITS.maxChars)}`,
    })
  }

  let root: MathNode
  try {
    root = restricted.parse(expression)
  } catch (error) {
    return fail0({ ok: false, reason: 'parse_error', detail: (error as Error).message })
  }

  let nodeCount = 0
  let fail: RestrictedMathFailure | null = null
  let maxIntExponentUsed = 0

  const visit = (node: MathNode, depth: number): void => {
    if (fail !== null) return
    nodeCount += 1
    if (nodeCount > RESTRICTED_MATH_LIMITS.maxNodes) {
      fail = {
        ok: false,
        reason: 'too_many_nodes',
        detail: `AST 节点数超过上限 ${String(RESTRICTED_MATH_LIMITS.maxNodes)}`,
      }
      return
    }
    if (depth > RESTRICTED_MATH_LIMITS.maxDepth) {
      fail = {
        ok: false,
        reason: 'too_deep',
        detail: `AST 深度超过上限 ${String(RESTRICTED_MATH_LIMITS.maxDepth)}`,
      }
      return
    }

    const type = nodeTypeOf(node)
    if (!ALLOWED_NODE_TYPES.includes(type)) {
      fail = { ok: false, reason: 'forbidden_node', detail: `不允许的 AST 节点类型：${type}` }
      return
    }

    if (type === 'ConstantNode') {
      const value = constantValueOf(node)
      if (!isNumericConstantValue(value)) {
        fail = {
          ok: false,
          reason: 'forbidden_constant',
          detail: `只允许数值常量，收到 ${value === undefined ? 'undefined（例如 #comment 这种节点）' : typeof value}`,
        }
        return
      }
    }

    if (type === 'OperatorNode') {
      const fn = (node as unknown as { fn: string }).fn
      const args = (node as unknown as { args: MathNode[] }).args
      if (!ALLOWED_OPERATOR_FNS.includes(fn)) {
        fail = { ok: false, reason: 'forbidden_operator', detail: `不允许的运算：${fn}` }
        return
      }
      if (fn === 'pow') {
        const exponent = args[1]
        const raw =
          exponent !== undefined && nodeTypeOf(exponent) === 'ConstantNode'
            ? constantValueOf(exponent)
            : undefined
        const value = numericConstantToNumber(raw)
        if (value === undefined || !Number.isSafeInteger(value)) {
          fail = {
            ok: false,
            reason: 'exponent_too_large',
            detail: '幂指数必须是**整数字面量**（首版只允许受限整数幂）',
          }
          return
        }
        if (Math.abs(value) > RESTRICTED_MATH_LIMITS.maxIntExponent) {
          fail = {
            ok: false,
            reason: 'exponent_too_large',
            detail: `幂指数 ${String(value)} 超过上限 ±${String(RESTRICTED_MATH_LIMITS.maxIntExponent)}`,
          }
          return
        }
        maxIntExponentUsed = Math.max(maxIntExponentUsed, Math.abs(value))
      }
    }

    if (type === 'FunctionNode') {
      const fnNode = (node as unknown as { fn: MathNode }).fn
      if (nodeTypeOf(fnNode) !== 'SymbolNode') {
        fail = { ok: false, reason: 'forbidden_function', detail: '函数名必须是普通标识符' }
        return
      }
      const name = String((fnNode as unknown as { name: string }).name)
      if (!ALLOWED_FUNCTION_NAMES.includes(name)) {
        fail = { ok: false, reason: 'forbidden_function', detail: `不允许的函数：${name}` }
        return
      }
    }

    for (const child of childrenOf(node)) visit(child, depth + 1)
  }

  visit(root, 1)
  if (fail !== null) return { problem: fail, nodeCount, depth: 0, maxIntExponentUsed: 0 }
  if (nodeCount === 0) {
    return {
      problem: { ok: false, reason: 'empty', detail: 'AST 是空的' },
      nodeCount: 0,
      depth: 0,
      maxIntExponentUsed: 0,
    }
  }
  return { problem: null, nodeCount, depth: depthOf(root), maxIntExponentUsed }
}

/** 这个算式的结果是不是**有限精度**（除法 / 开方 ⇒ 是） */
function isApproximate(expression: string): boolean {
  return /[/]/.test(expression) || /sqrt\s*\(/.test(expression)
}

function depthOf(root: MathNode): number {
  let max = 0
  const walk = (node: MathNode, depth: number): void => {
    if (depth > max) max = depth
    for (const child of childrenOf(node)) walk(child, depth + 1)
  }
  walk(root, 1)
  return max
}

/**
 * 受限求值（**同步**；墙钟超时由调用方的可终止执行器负责）。
 *
 * 顺序：静态检查 → 求值 → 有限性检查 → 结果长度检查。
 */
export function evaluateRestrictedExpression(expression: string): RestrictedMathOutcome {
  const scan = scanRestrictedExpression(expression)
  if (scan.problem !== null) return scan.problem

  // 静态检查已经通过 ⇒ 这里的 parse 不会再抛（同一条输入、同一个实例）
  const root = restricted.parse(expression)
  let value: unknown
  try {
    value = (root as unknown as { compile(): { evaluate(): unknown } }).compile().evaluate()
  } catch (error) {
    return { ok: false, reason: 'evaluation_failed', detail: (error as Error).message }
  }

  const text = typeof value === 'number' ? String(value) : String(value)
  if (text === 'NaN' || text === 'Infinity' || text === '-Infinity' || text.includes('Infinity')) {
    return { ok: false, reason: 'not_finite', detail: `结果不是有限数：${text}` }
  }
  if (text.length > RESTRICTED_MATH_LIMITS.maxResultChars) {
    return {
      ok: false,
      reason: 'result_too_large',
      detail: `结果 ${String(text.length)} 字符，超过上限 ${String(RESTRICTED_MATH_LIMITS.maxResultChars)}`,
    }
  }

  const approx = isApproximate(expression)
  return {
    ok: true,
    value: text,
    display: approx ? `≈ ${text}` : text,
    precision: RESTRICTED_MATH_LIMITS.precision,
    approx,
    nodeCount: scan.nodeCount,
    depth: scan.depth,
    maxIntExponentUsed: scan.maxIntExponentUsed,
  }
}

/** 一行式的拒绝说明（进 `ActionFailure.detail`；**不含**用户正文之外的任何东西） */
