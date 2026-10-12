/**
 * 受限计算的**契约部分**（上限 / 白名单 / 读数形状）—— **刻意不 import mathjs**。
 *
 * ============================================================================
 *  为什么这个文件要存在（真实原因，不是洁癖）
 * ============================================================================
 * 计划书 §2 第 5 点逐字：「关闭时不加载重组件、不启动执行器、不访问目标。」
 *
 * 而第一版把上限与类型和 mathjs 一起放在 `restricted-math.ts` 里，
 * 于是 `src/main.ts` → `math-calculate.ts` → `restricted-math.ts` 这条**静态**导入链
 * 会在**进程启动时**就把 mathjs 装进内存 —— 即使 `CHARACTER_MATH_CALCULATE_ENABLED=false`。
 * 那是"开关关了但仍然加载了重组件"，与该条要求相反。
 *
 * 因此把**不需要 mathjs** 的那一部分（上限常量、白名单、读数类型、拒绝措辞）搬到这里：
 *   · `math-calculate.ts`（父进程）只 import 本文件 ⇒ 关闭时**零 mathjs**
 *   · `math-calculate-worker.ts`（子进程）才 import `restricted-math.ts` ⇒ 真正要算时才装载
 * `restricted-math.ts` 仍然 re-export 本文件的全部符号（既有导入点逐字不动）。
 */

/** 首版硬上限（计划书 §3.1 逐字给出的那一组） */
export const RESTRICTED_MATH_LIMITS = {
  /** 输入算式最多多少字符 */
  maxChars: 512,
  /** AST 最多多少节点 */
  maxNodes: 128,
  /** AST 最大深度 */
  maxDepth: 16,
  /** 整数幂指数的绝对值上限 */
  maxIntExponent: 1000,
  /** 格式化结果最多多少字符（超过就**明确拒绝**，不截成一个貌似完整的答案） */
  maxResultChars: 4096,
  /** 求值墙钟上限（由**可终止的独立执行器**执行，见适配器） */
  timeoutMs: 2000,
  /** 有效数字位数 */
  precision: 64,
} as const

/** 允许的操作符（按 mathjs `OperatorNode.fn` 名） */
export const ALLOWED_OPERATOR_FNS: readonly string[] = [
  'add',
  'subtract',
  'multiply',
  'divide',
  'pow',
  'unaryMinus',
  'unaryPlus',
]

/** 允许的函数（按 mathjs `FunctionNode.fn.name`） */
export const ALLOWED_FUNCTION_NAMES: readonly string[] = ['abs', 'sqrt', 'round']

/** 允许的 AST 节点类型 */
export const ALLOWED_NODE_TYPES: readonly string[] = [
  'ConstantNode',
  'OperatorNode',
  'ParenthesisNode',
  'FunctionNode',
]

export type RestrictedMathRejection =
  | 'too_long'
  | 'empty'
  | 'parse_error'
  | 'forbidden_node'
  | 'forbidden_operator'
  | 'forbidden_function'
  | 'forbidden_constant'
  | 'too_many_nodes'
  | 'too_deep'
  | 'exponent_too_large'
  | 'not_finite'
  | 'result_too_large'
  | 'evaluation_failed'

export interface RestrictedMathSuccess {
  ok: true
  /** 精确结果（BigNumber 字符串） */
  value: string
  /** 展示用文本（可能带 `≈`） */
  display: string
  precision: number
  approx: boolean
  nodeCount: number
  depth: number
  /** 出现过的最大整数幂指数（无幂则为 0） */
  maxIntExponentUsed: number
}

export interface RestrictedMathFailure {
  ok: false
  reason: RestrictedMathRejection
  detail: string
}

export type RestrictedMathOutcome = RestrictedMathSuccess | RestrictedMathFailure

/** 一行式的拒绝说明（进 `ActionFailure.detail`；**不含**任何用户正文之外的东西） */
export const RESTRICTED_MATH_REJECTION_TEXT: Readonly<Record<RestrictedMathRejection, string>> = {
  too_long: '算式太长',
  empty: '算式为空',
  parse_error: '算式无法解析',
  forbidden_node: '算式里有不允许的结构',
  forbidden_operator: '算式里有不允许的运算',
  forbidden_function: '算式里有不允许的函数',
  forbidden_constant: '算式里有非数值常量',
  too_many_nodes: '算式太复杂（节点太多）',
  too_deep: '算式太复杂（嵌套太深）',
  exponent_too_large: '幂指数超出允许范围',
  not_finite: '结果不是有限数',
  result_too_large: '结果太大',
  evaluation_failed: '算式求值失败',
}
