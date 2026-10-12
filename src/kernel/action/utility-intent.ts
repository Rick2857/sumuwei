/**
 * 实用能力的**意图检测**（计划书 §2 第 6 点 / §3.1「明确触发」）。
 *
 * ============================================================================
 *  它与 M4.5 / M5.5 的检测器是同一条纪律：规则产生请求，判定另有其人
 * ============================================================================
 * 本文件**只**把"用户明确说了要做这一件事"翻译成一个 `ActionIntent`：
 *   · 不判定权限（那是 Policy）
 *   · 不判定目标确定性（那是 TargetResolver）
 *   · 不做模糊匹配、不猜（M4/D1 的教训）
 *
 * ============================================================================
 *  三条"不抢别人活"的边界（计划书 §3 WP3 的完成条件之一）
 * ============================================================================
 * 1. **只认明确触发**：
 *    ```text
 *    计算   需要句中真的有一个**可抽取的算式**（至少一个数字 + 一个运算符/括号/白名单函数）
 *    文档   需要句中真的有一个 .pdf/.docx/.pptx/.xlsx 形态的路径 + 一个读的动作词
 *    OCR    需要句中真的有一个 .png/.jpg/.jpeg 形态的路径 + 一个识别的动作词
 *    网页   需要句中真的有一个 **https:// URL** + 一个读的动作词
 *    ```
 *    于是"我算了一下，今天该交作业了"这种日常话**不会**触发计算能力
 *    （抽不出算式），"随便聊聊"更不会。
 * 2. **不碰 M4.5 的既有触发词形**：`.txt/.md/.csv/.json/...` 仍归 M4.5 的
 *    `sandbox.file.read`（本文件的扩展名白名单里**没有**它们）⇒ 旧文件读写行为不变。
 * 3. **每项能力有自己的开关**：关掉的能力**不产生请求**（连候选都不产生）。
 *    于是"关闭"表现为"什么都没发生"，而不是"产生一条注定被拒的请求" ——
 *    后者会让默认关闭的配置在用户随口提到一个 PDF 时就留下一条 `permission_denied`。
 *    ⚠️ 能力仍然**恒登记**（装配层），因此"没启用"这件事在开发者面上仍然可查；
 *       而真要在证据里看到可审计的拒绝，验收脚本用"检测器开 + 权限不授予"那一档
 *       （计划书 §4A 公共第 ① 组的"权限拒绝"半边）。
 */

import type { ActionIntent, ActionIntentDetector } from './intent-detector.ts'
import { normalizeHint } from './target-resolver.ts'
import { ALLOWED_FUNCTION_NAMES } from './restricted-math-contract.ts'
import {
  DOCUMENT_READ,
  DOCUMENT_READ_OPERATION,
  IMAGE_OCR,
  IMAGE_OCR_OPERATION,
  MATH_CALCULATE,
  MATH_CALCULATE_OPERATION,
  WEB_READ,
  WEB_READ_OPERATION,
} from './utility-capabilities.ts'

/** 文档能力认的扩展名（**刻意不含** M4.5 的 txt/md/csv/json… —— 见文件头第 2 条） */
export const DOCUMENT_EXTENSIONS = 'pdf|docx|pptx|xlsx'
export const IMAGE_EXTENSIONS = 'png|jpg|jpeg'

const DOC_PATH_TOKEN = new RegExp(
  `[A-Za-z0-9_\\-./\\\\\\u4e00-\\u9fa5]*[A-Za-z0-9_\\-\\u4e00-\\u9fa5]\\.(?:${DOCUMENT_EXTENSIONS})`,
  'gi'
)
const IMAGE_PATH_TOKEN = new RegExp(
  `[A-Za-z0-9_\\-./\\\\\\u4e00-\\u9fa5]*[A-Za-z0-9_\\-\\u4e00-\\u9fa5]\\.(?:${IMAGE_EXTENSIONS})`,
  'gi'
)
/** 句中的 HTTPS URL（去掉尾随的中文标点/引号） */
export const HTTPS_URL_TOKEN = /https:\/\/[^\s"'<>，。；、）】》]+/gi

const READ_VERBS = /(读一下|读一读|阅读|读取|读读|看看|看一下|打开|念念|帮我读|给我读|念一下|read)/i
const OCR_VERBS = /(识别|ocr|认字|认一下|图里|图片里|图上有|读图|看看这图|写的什么|写了什么|text)/i
const MATH_VERBS = /(算一下|算一算|算算|计算|求值|等于多少|是多少|帮我算|给我算|算出来|精确计算|=)/i
/** 白名单函数名（与 `math-calculate` 适配器共享同一份清单的**触发侧子集**） */
const MATH_FUNCTION_NAMES = /(abs|sqrt|round)\s*\(/i

export interface UtilityIntentOptions {
  readonly math: boolean
  readonly document: boolean
  readonly web: boolean
  readonly ocr: boolean
}

/** 抽出一类扩展名的路径 token（去重、保序、规范化） */
export function extractPathTokensOf(text: string, extensions: 'document' | 'image'): string[] {
  const pattern = extensions === 'document' ? DOC_PATH_TOKEN : IMAGE_PATH_TOKEN
  pattern.lastIndex = 0
  const found = text.match(pattern)
  if (found === null) return []
  const out: string[] = []
  for (const raw of found) {
    const cleaned = normalizeHint(raw.replace(/^[的个了把在将]+/, '').trim())
    if (cleaned === '') continue
    if (!out.includes(cleaned)) out.push(cleaned)
  }
  return out
}

/** 抽出世句里的 HTTPS URL（保序、去重；**不做**任何规范化改写 —— URL 由适配器再校验） */
export function extractHttpsUrls(text: string): string[] {
  HTTPS_URL_TOKEN.lastIndex = 0
  const found = text.match(HTTPS_URL_TOKEN)
  if (found === null) return []
  const out: string[] = []
  for (const raw of found) {
    const cleaned = raw.replace(/[.,;:]+$/, '')
    if (cleaned === '') continue
    if (!out.includes(cleaned)) out.push(cleaned)
  }
  return out
}

/**
 * 抽出一个**可计算的算式**。
 *
 * 三条刻意的限制（都是为了"不抢闲聊"）：
 *   · 必须至少有一个数字
 *   · 必须有运算符 / 括号 / 白名单函数调用之一（否则"3"这种裸数字也会触发）
 *   · 只取**最长**的一段连续数学字符（引号里的优先，用户明确圈出来的最可信）
 *
 * ⚠️ 这里**不做任何安全性判断**：`import(...)`、`a=1` 这类东西照样能被抽出来，
 *    然后由 `math-calculate` 的受限 AST 白名单在**执行前**拒绝
 *    （计划书 §3.1：「禁止的输入在执行前拒绝；不是靠正则名称黑名单」）。
 */
export function extractExpression(text: string): string | undefined {
  /*
   * ⚠️ **白名单之外的函数调用 ⇒ 不抽算式、不产生请求**（实测逼出来的规则，2026-10-04）。
   *
   * ```text
   * 用户说  帮我算一下 evaluate("1+1")
   * 第一版  引号优先 ⇒ 抽出内层 `1+1` ⇒ 产生请求 ⇒ 算出 2
   *         —— 用户要算的是 `evaluate("1+1")` 这个整体，抽出内层等于**悄悄改写**了他的请求
   * 现在    句子里出现白名单之外的调用名 ⇒ extractExpression 返回 undefined ⇒ 连请求都没有
   * ```
   * ⚠️ 这**不是**安全检查（安全仍在 `restricted-math.ts` 的 AST 白名单，执行前拒绝）——
   *    它是**触发精度**规则：不猜、不改写用户给的算式。
   *    于是 `sqrt(2)` / `round(2.345, 2)` / `abs(-4.5)` 照常触发，
   *    而 `evaluate(...)` / `sin(0)` / `max(1,2)` / `import("x")` 连请求都不产生。
   */
  const calls = text.match(/[A-Za-z_][A-Za-z0-9_]*\s*\(/g)
  if (calls !== null) {
    for (const call of calls) {
      const name = call.replace(/\s*\($/, '').toLowerCase()
      if (!ALLOWED_FUNCTION_NAMES.includes(name)) return undefined
    }
  }

  const quoted = /[「『"“'`]([0-9A-Za-z_+\-*/^%().,\s]{3,200})[」』"”'`]/.exec(text)
  if (quoted?.[1] !== undefined && looksLikeExpression(quoted[1])) return quoted[1].trim()

  const runs = text.match(/[0-9A-Za-z_+\-*/^%().,\s]{3,200}/g)
  if (runs === null) return undefined
  let best: string | undefined
  for (const raw of runs) {
    const trimmed = raw.trim().replace(/^(等于|是多少|多少)/, '').trim()
    if (!looksLikeExpression(trimmed)) continue
    if (best === undefined || trimmed.length > best.length) best = trimmed
  }
  return best
}

/** 一个字符串"像不像一个算式"（数字 + 运算符/括号/白名单函数） */
export function looksLikeExpression(candidate: string): boolean {
  const text = candidate.trim()
  if (!/[0-9]/.test(text)) return false
  if (!/[+\-*/^%()]/.test(text) && !MATH_FUNCTION_NAMES.test(text)) return false
  // 纯中文/纯字母自然语言里没有数字与运算符的组合 ⇒ 上面两条已经把大部分闲聊挡掉了
  return true
}

/**
 * 构造实用能力的检测器。
 *
 * ⚠️ **它排在链的中间**（`main.ts` 的检测器链）：
 *    M4.5（本地文件/echo）→ **本检测器** → M5.5（联网搜索）。
 *    理由与 M4.5 排在 M5.5 之前是同一条**代价不对称**：
 *    用户显式指定的本地资源 / 显式算式 / 显式 URL 比"要不要搜"更确定，
 *    而搜索是出站不可撤回的那一侧。
 */
export function createUtilityIntentDetector(
  options: UtilityIntentOptions
): ActionIntentDetector {
  return {
    detect(text: string): ActionIntent | undefined {
      const trimmed = text.trim()
      if (trimmed === '') return undefined

      // ① 网页深读：显式 HTTPS URL + 读的动作词
      if (options.web) {
        const urls = extractHttpsUrls(trimmed)
        if (urls.length > 0 && READ_VERBS.test(trimmed)) {
          return {
            capability: WEB_READ,
            operation: WEB_READ_OPERATION,
            args: { url: urls[0]! },
            hints: [],
            rule: 'web_read_url',
            phrase: trimmed.slice(0, 60),
          }
        }
      }

      // ② 图片识别：图片路径 + 识别动作词
      if (options.ocr) {
        const images = extractPathTokensOf(trimmed, 'image')
        if (images.length > 0 && (OCR_VERBS.test(trimmed) || READ_VERBS.test(trimmed))) {
          return {
            capability: IMAGE_OCR,
            operation: IMAGE_OCR_OPERATION,
            args: { path: images[0]! },
            hints: [images[0]!],
            rule: 'image_ocr_path',
            phrase: trimmed.slice(0, 60),
          }
        }
      }

      // ③ 文档阅读：文档路径 + 读的动作词
      if (options.document) {
        const docs = extractPathTokensOf(trimmed, 'document')
        if (docs.length > 0 && READ_VERBS.test(trimmed)) {
          return {
            capability: DOCUMENT_READ,
            operation: DOCUMENT_READ_OPERATION,
            args: { path: docs[0]! },
            hints: [docs[0]!],
            rule: 'document_read_path',
            phrase: trimmed.slice(0, 60),
          }
        }
      }

      // ④ 精确计算：算式 + 计算动作词（二者缺一不可）
      if (options.math && MATH_VERBS.test(trimmed)) {
        const expression = extractExpression(trimmed)
        if (expression !== undefined) {
          return {
            capability: MATH_CALCULATE,
            operation: MATH_CALCULATE_OPERATION,
            args: { expression },
            hints: [],
            rule: 'math_expression',
            phrase: trimmed.slice(0, 60),
          }
        }
      }

      return undefined
    },
  }
}
