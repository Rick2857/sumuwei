/**
 * ★ S4（ADR-129 D08）：**补说的"继续吗？"与批次边界** —— 冻结纯函数。
 *
 * ============================================================================
 *  用户裁定（2026-10-10，三问全确认）
 * ============================================================================
 * ```text
 * ① 关键词表照草案：continue / stop 两组，**锚定**匹配（不是"包含"）
 * ② **不明确 = 不继续**（安全侧；剩余项保留在账上）
 * ③ **一个批次只问一次**（避免"她反复追着问"）
 * 另：逐条 · 不受时间/额度约束 · 一次最多 10 条 · 超了 ⇒ 末句加"未补说的事件还没完"并询问
 * ```
 *
 * ============================================================================
 *  为什么必须"锚定"（这条不是风格，是判据）
 * ============================================================================
 * ```text
 * 用户："继续帮我看看那个回收站"        ← 这是一个**新任务**
 *   · 按"包含"判 ⇒ 一边执行新任务、一边倒 10 条补说 = 打断她正在做的事（答非所问的另一种形态）
 *   · 按"锚定"判 ⇒ unrelated ⇒ 不补说（正确）
 * 先例：`reminder-turn.ts` 的确认判据就是锚定的
 *       /^(?:默认吧|就按默认|不是一回事|对[，,\s]*(.+)|好|行)[。！!\s]*$/u
 * ```
 *
 *  ⚠️ 本模块不碰数据库：跨重启的"错过"账要落库（迁移，另案待授权）。
 *     这里的三个判据先冻结 —— 迁移到位后调用方直接调用它们即可。
 */

/** "继续补说"（锚定：整句就是它，允许尾随标点/空白） */
const CONTINUE = /^(?:继续|接着说|说下去|接着|往下说|还有吗|还有呢|都说了|全说|继续吧|继续补|go on|continue)[。！!？?\s]*$/iu

/** "不必再补"（同样锚定） */
const STOP = /^(?:不用了|算了|不听了|别说了|够了|不需要|到此为止)[。！!？?\s]*$/u

/**
 * 用户这一句对"还要不要继续补说"的意思。闭集三值：
 *   `continue` 明确要继续 · `stop` 明确不要 · `unrelated` 其它（含**新任务**、空话、无关回复）
 *
 * ⚠️ `unrelated` 的处置由调用方按裁定 ② 办：**不继续**，且把剩余项**保留在账上**。
 */
export type CatchupContinuation = 'continue' | 'stop' | 'unrelated'

export function readCatchupContinuation(text: string): CatchupContinuation {
  const trimmed = text.trim()
  if (trimmed === '') return 'unrelated'
  if (CONTINUE.test(trimmed)) return 'continue'
  if (STOP.test(trimmed)) return 'stop'
  return 'unrelated'
}

/** 一次补说最多几条（用户裁定） */
export const CATCHUP_BATCH_LIMIT = 10

/**
 * 取本批要补说的条目 + 还剩多少（> 0 ⇒ 末句要加"未补说的事件还没完"并询问）。
 * 纯函数 ⇒ 顺序、边界（恰好 10 条、11 条）都能被门钉住。
 */
export function takeCatchupBatch<T>(items: readonly T[], limit: number = CATCHUP_BATCH_LIMIT): {
  batch: readonly T[]
  remaining: number
} {
  const size = limit > 0 ? limit : 0
  return { batch: items.slice(0, size), remaining: Math.max(0, items.length - size) }
}

/**
 * 现在要不要**问**"还有 N 条，要继续吗？"
 *
 * 裁定 ③ 的机器形态：**一个批次只问一次** —— 问过就不再自动追问
 * （否则她会反复追着问；那是"模板刷屏"的同类毛病）。
 * 只有用户主动提（`readCatchupContinuation` 给 `continue`）或**新的批次**开始时，才重新允许问。
 */
export function shouldAskCatchupContinuation(input: {
  /** 本批之外还剩多少条没补说 */
  remaining: number
  /** 这一批**已经问过**了吗（落库/内存由调用方定，这里只要事实） */
  alreadyAsked: boolean
}): boolean {
  return input.remaining > 0 && input.alreadyAsked !== true
}

/**
 * ★ S4 ②（ADR-129 D08）：**补说的正文**（程序追加，逐条）。
 *
 * 裁定：逐条（不合并成一句）· 一次最多 10 条 · 超了 ⇒ 末句加
 * "**未补说的事件还没完**"并**询问是否继续** —— 但**一个批次只问一次**
 * （`alreadyAsked` 为真时只说"还没完"，**不再追问**，避免她反复追着问）。
 *
 * ⚠️ 返回**要追加到她回复后面的那段文本**；空数组 ⇒ 返回空串（调用方据此不追加）。
 * ⚠️ 纯函数：不碰数据库、不决定"哪批"（那是 `takeCatchupBatch` 的事），只负责**措辞**。
 */
export function renderCatchupAnnouncement(input: {
  /** 本批要补说的条目（正文；`text` 为空的行按 F2 规则跳过） */
  items: readonly { text?: string | undefined }[]
  remaining: number
  alreadyAsked: boolean
}): string {
  const lines = input.items
    .map(item => (typeof item.text === 'string' ? item.text.trim() : ''))
    .filter(text => text !== '')
    .map(text => `• ${text}`)
  if (lines.length === 0 && input.remaining === 0) return ''
  const tail = shouldAskCatchupContinuation(input)
    ? '未补说的事件还没完，要继续吗？'
    : input.remaining > 0
      ? '未补说的事件还没完。'
      : ''
  return [...lines, ...(tail === '' ? [] : [tail])].join('\n')
}
