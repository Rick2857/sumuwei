/**
 * ActionIntentDetector —— 从**用户真实文本**判定"她该不该动世界"（M4.5 §36 / D-A）。
 *
 * ============================================================================
 *  为什么是规则，而不是让模型决定
 * ============================================================================
 * 用户已确认的方向（D-A）：**LLM 永不应该决定执行**。三条理由：
 *
 *   1. **确定性**：L3 自然语言集成与 L4 真实链路要能被复现。
 *      让模型决定"要不要写这个文件"，就等于让一次副作用依赖一次采样。
 *   2. **可解释**：命中哪条规则、抽出了哪个目标，都能被打印出来。
 *   3. **协议不变**：`ActionRequest` 不关心是谁产生的。以后要让模型
 *      提议动作（`requestedBy.kind = 'character'`），加一层适配即可，
 *      不需要动 Gateway 与 Policy。
 *
 * 判定顺序是刻意的（与 M4 的显式意图同一条纪律）：
 *
 * ```text
 * 把 A 写进 B   ← 最具体，先匹配（否则会被"写"字的泛规则抢走）
 * 写 / 创建 / 新建 / 修改 …（write）
 * 读 / 看一下 / 打开 …（read）
 * echo
 * ```
 *
 * ⚠️ 它**只**产生"请求"，不判定权限、不判定目标确定性。
 *    那两件事在 Policy 与 TargetResolver 里（ADR-030/032）。
 */

import { SANDBOX_FILE_READ, SANDBOX_FILE_WRITE, SYSTEM_ECHO } from './capability-registry.ts'
import { normalizeHint } from './target-resolver.ts'

export interface ActionIntent {
  capability: string
  operation: string
  /** 请求参数（path / content / text） */
  args: Record<string, unknown>
  /** 目标提示：用户这句话里出现的路径（按出现顺序） */
  hints: string[]
  /** 命中的规则名（审计 / 诊断用） */
  rule: string
  /** 用户原话里触发的那一段（截断，便于排查） */
  phrase: string
}

export interface ActionIntentDetector {
  detect(text: string): ActionIntent | undefined
}

/** 常见扩展名 —— 目标提示必须**看起来像一个文件**，否则不猜 */
const EXTENSIONS =
  'txt|md|json|log|csv|ts|js|mjs|cjs|yml|yaml|ini|conf|toml|xml|html|css|sh|ps1|bat|sql|dat|out|env|rst|tex|py'

const PATH_TOKEN = new RegExp(
  `[A-Za-z0-9_\\-./\\\\\\u4e00-\\u9fa5]*[A-Za-z0-9_\\-\\u4e00-\\u9fa5]\\.(?:${EXTENSIONS})`,
  'gi'
)

/** 抽出文本里所有像路径的片段（去重、保序） */
export function extractPathTokens(text: string): string[] {
  const found = text.match(PATH_TOKEN)
  if (found === null) return []
  const out: string[] = []
  for (const raw of found) {
    const cleaned = raw.replace(/^[的个了把在将]+/, '').trim()
    if (cleaned === '') continue
    if (!out.includes(cleaned)) out.push(cleaned)
  }
  return out
}

const WRITE_PHRASE = /(写进|写入到|写到|写进|保存到|存到)/
const WRITE_KEYWORDS = /(写入|写一个|写个|写一份|创建|新建|建一个|生成|保存|记录到|修改|改成|改为|更新|覆盖|write|create)/i
const READ_KEYWORDS = /(读一下|读一读|读取|读出|读出来|看一下|看看|打开|念念|read|show me)/i
/**
 * echo 的触发词。
 *
 * ⚠️ 它是唯一"提到就触发"的能力，而那是可以接受的：
 *    `system.echo` 的 `sideEffect = none`、`riskLevel = R0` ——
 *    它不改变世界，因此误触发的代价只是一次无副作用的自检。
 *    任何有副作用的能力都**不允许**用这种宽松规则（见 ADR-032）。
 */
const ECHO_KEYWORDS = /(回声|(^|\s)echo\b)/i

const CONTENT_PATTERNS: readonly RegExp[] = [
  /内容(?:是|为|:|：)\s*[「『"“']?([^"”'」』\n]+?)[」』"”']?\s*(?:的?文件)?$/,
  /内容(?:是|为|:|：)\s*[「『"“']?([^"”'」』\n]+)/,
  /[，,]\s*(?:内容)?(?:是|为|写成)\s*[「『"“']?([^"”'」』\n]+)/,
]

/**
 * 从文本里抽出"要写什么"。
 *
 * ⚠️ 抽不出来时**返回 `undefined`**，而不是给一个空串：
 *    空内容与"没说要写什么"是两件事，后者必须触发
 *    `validation_failed`（"不知道要写什么"），而不是写一个空文件。
 */
export function extractContent(text: string): string | undefined {
  for (const pattern of CONTENT_PATTERNS) {
    const matched = pattern.exec(text)
    const value = matched?.[1]?.trim()
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

export function createActionIntentDetector(): ActionIntentDetector {
  return {
    detect(text: string): ActionIntent | undefined {
      const trimmed = text.trim()
      if (trimmed === '') return undefined

      /*
       * 抽出的路径**先规范化**（去引号、去 `sandbox/` 前缀、统一斜杠）。
       *
       * 这样 `arguments.path` 与账本里记的目标就是同一种形状 ——
       * 否则"她说的是 sandbox/test.txt、系统记的是 test.txt"会在
       * 事后审计时变成一个小谜题（而谜题总会有人猜错）。
       *
       * ⚠️ **第二批的一个真实教训（2026-10-04，记在这里免得重犯）**：
       *    曾在这里"先把本机绝对路径整段挖掉"再抽 token，好让本机文件域的
       *    检测器独占绝对路径。那让 `pnpm m4.5:ci` 的 `NL-05` 三条断言**全红**
       *    （它逐字要求 `读一下 C:\Windows\…` 得到一条
       *    `permission_denied` + "未触碰真实文件系统" 的账本证据）。
       *    ⇒ 本文件**逐字回到原状**；本机域的正确性改由**链序**解决：
       *      `createLocalFileIntentDetector()` 排在**本检测器之前**
       *      （见 `main.ts` 的检测器链）。
       */
      const paths = extractPathTokens(trimmed)
        .map((token) => normalizeHint(token))
        .filter((token) => token !== '')

      // ① 把 A 写进 B
      if (WRITE_PHRASE.test(trimmed) && paths.length > 0) {
        const content = extractContent(trimmed) ?? quoteOf(trimmed)
        return {
          capability: SANDBOX_FILE_WRITE,
          operation: 'write',
          args: {
            path: paths[paths.length - 1]!,
            ...(content !== undefined ? { content } : {}),
          },
          hints: [paths[paths.length - 1]!],
          rule: 'write_into',
          phrase: trimmed.slice(0, 60),
        }
      }

      // ② 写 / 创建 / 修改 …
      if (WRITE_KEYWORDS.test(trimmed) && paths.length > 0) {
        const content = extractContent(trimmed) ?? quoteOf(trimmed)
        return {
          capability: SANDBOX_FILE_WRITE,
          operation: 'write',
          args: { path: paths[0]!, ...(content !== undefined ? { content } : {}) },
          hints: [paths[0]!],
          rule: 'write',
          phrase: trimmed.slice(0, 60),
        }
      }

      // ③ 读
      if (READ_KEYWORDS.test(trimmed) && paths.length > 0) {
        return {
          capability: SANDBOX_FILE_READ,
          operation: 'read',
          args: { path: paths[0]! },
          hints: [paths[0]!],
          rule: 'read',
          phrase: trimmed.slice(0, 60),
        }
      }

      // ④ echo（诊断用；只在明确说"回声/echo"时触发）
      if (ECHO_KEYWORDS.test(trimmed)) {
        const payload = trimmed.replace(ECHO_KEYWORDS, ' ').trim()
        return {
          capability: SYSTEM_ECHO,
          operation: 'echo',
          args: { text: payload },
          hints: [],
          rule: 'echo',
          phrase: trimmed.slice(0, 60),
        }
      }

      return undefined
    },
  }
}

/** 引号里的原文（"把 hello 写进 a.txt" 里的 hello） */
function quoteOf(text: string): string | undefined {
  const matched = /[「『"“']([^"”'」』\n]{1,200})[」』"”']/.exec(text)
  const value = matched?.[1]?.trim()
  return value === undefined || value === '' ? undefined : value
}
