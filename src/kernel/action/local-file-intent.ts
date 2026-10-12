/**
 * 本机文件域的**意图检测**（第二批计划 §2.1；与 `utility-intent.ts` 同一条纪律）。
 *
 * ============================================================================
 *  三条边界
 * ============================================================================
 * 1. **只认显式触发**：句子里必须真的有一个**本机绝对路径 token**，
 *    并且有一个读/列的动作词。于是"我昨天看了一份报告"不会触发任何东西。
 * 2. **不碰旧沙箱的触发词形**：`.txt/.md/.csv/.json` 这些扩展名仍归 M4.5 的
 *    `sandbox.file.read`（它接受沙箱**相对**路径）。本文件只在路径**带盘符**时才产生请求 ——
 *    于是"读一下 notes.txt"照旧走 M4.5（行为一个字节不变），
 *    而 `读一下 C:\work\notes.txt` 才走本机文件域。
 * 3. **不做写触发**：`local.file.write` 的请求只由**任务执行环**产生
 *    （它才带着一份程序签发的任务授权）。理由见下。
 *
 * ============================================================================
 *  为什么这里**没有** write 检测器（刻意的）
 * ============================================================================
 * 一句自然语言里"要写什么内容"抽不出来：用户说「把这段总结存到 C:\a\b.txt」时，
 * "这段总结"是**上一轮的模型输出**，不是这句话里的字。用一个启发式从原话里
 * 抽正文 ⇒ 写下一个**用户没说过的东西**，而它会被当成本机文件永久留下。
 * ⇒ 写入的正文只能来自两处：① 任务的计划（模型给出的结构化内容）
 *    ② 明确的 `payloadRef`。两处都由任务执行环负责，本文件不越权。
 *
 * ============================================================================
 *  一条**如实的**触发边界（不是缺陷，是首版范围）
 * ============================================================================
 * 单动作路径只接受**带引号**或**不含空格**的绝对路径。
 * ```text
 * 读一下 C:\work\a.txt               ✅ 触发
 * 读一下 "C:\My Files\a b.txt"       ✅ 触发（引号给出了明确边界）
 * 读一下 C:\My Files\a b.txt         ❌ 不触发 —— 空格让"路径到哪结束"没有确定答案
 *                                       （任务执行环不受此限：它拿的是结构化 JSON）
 * ```
 * 猜一次边界 = 可能把 `C:\My` 当成路径，而那是**另一个位置**。
 */

import type { ActionIntent, ActionIntentDetector } from './intent-detector.ts'
import {
  LOCAL_FILE_LIST,
  LOCAL_FILE_LIST_OPERATION,
  LOCAL_FILE_READ,
  LOCAL_FILE_READ_OPERATION,
} from './local-file-capabilities.ts'

/**
 * 引号里的带盘符路径（**最可信**：用户自己划了边界）。
 * 网络/设备路径也收 —— 让它们在目标解析层得到一条**可审计的** `permission_denied`，
 * 而不是"她装作没听懂"。
 */
export const QUOTED_LOCAL_PATH =
  /["'`「『]([A-Za-z]:[\\/][^"'`」』\n\r]{0,400}|\\\\[^"'`」』\n\r]{0,400})["'`」』]/g

/**
 * 不带引号、**不含空格**的带盘符路径（到空白或中文停顿标点为止）。
 *
 * ⚠️ 前置的 `(?<![A-Za-z0-9:])` 是实测逼出来的（2026-07-… 本批整定期）：
 *    没有它时 `https://news.example.com/feed.xml` 里的 **`s:`** 会被当成盘符 `s`，
 *    于是"读一下这个订阅源 https://…/feed.xml"被本检测器抢成
 *    `local.file.read`，目标是 `s://news.example.com/feed.xml` —— 一个**根本不存在**的位置。
 *    盘符前面不可能紧挨着字母/数字/冒号 ⇒ 这个否定环视正好把 URL 挡在外面。
 */
export const BARE_LOCAL_PATH =
  /(?<![A-Za-z0-9:])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`「」『』，。；、）】》]{1,400}/g

const READ_VERBS =
  /(读一下|读一读|阅读|读取|读读|看看|看一下|打开|念念|帮我读|给我读|念一下|内容|写了什么|read)/i
const LIST_VERBS =
  /(列一下|列一列|列举|列目录|列出来|列出|清单|有什么|有哪些|有哪些文件|里面有什么|目录|文件夹里|list|dir)/i

export interface LocalFileIntentOptions {
  /**
   * **保留但当前不参与判定**——它记录"哪一项被启用"，而检测器本身**不受开关门控**。
   *
   * ==========================================================================
   *  第二批的一个真实教训（2026-10-04）：为什么这里**不能**"关闭即沉默"
   * ==========================================================================
   * 第一版照抄 `utility-intent.ts` 的"关闭 ⇒ 不产生请求"。但本机文件域与
   * 第一批四项有一个关键差异：
   * ```text
   * 绝对路径**同时也是 M4.5 沙箱检测器的触发面** —— 它的 `PATH_TOKEN` 以扩展名结尾、
   * 字符类里没有 `:`，于是 `C:\x\a.txt` 会被它切成 `\x\a.txt`，
   * 然后报一条"**越出沙箱范围**"的 permission_denied。
   * ```
   * 那是计划书 §2.1 第 2 点明令禁止的**说错域**（把本机域说成沙箱）。
   *
   * ⇒ 本检测器排在 **M4.5 之前**、且**不受开关门控**：
   * ```text
   * 打开 ⇒ 正常执行
   * 关闭 ⇒ 一条**可审计的** `permission_denied`，措辞是**本机域**的
   *        —— 正是"能力恒登记、权限条件授予"的意图（先例 ADR-045 `D-12`）
   * ```
   * ⚠️ 这一条是 `pnpm m4.5:ci` 的 `NL-05` 逼出来的：曾经改成"在 M4.5 里先挖掉
   *    绝对路径"，结果 `NL-05` 三条断言全红（它逐字要求那条沙箱越界证据）。
   *    **链序**是对的解法，**改 M4.5**不是。
   */
  readonly read: boolean
  readonly list: boolean
}

/** 从一句话里抽出本机路径候选（保序、去重；**不做**任何规范化改写） */
export function extractLocalPathTokens(text: string): string[] {
  const out: string[] = []
  const push = (raw: string): void => {
    const trimmed = raw.trim().replace(/[.,;:]+$/, '')
    if (trimmed === '') return
    if (!out.includes(trimmed)) out.push(trimmed)
  }

  /*
   * ① 先把**引号里**的路径收下来，并把那些区间从文本里挖掉。
   *
   * ⚠️ 挖掉是必要的，不是保险：`读一下 "C:\My Files\a.txt"` 里裸正则也会命中
   *    `C:\My`（在空格处断句）—— 那是一个**错误**的位置。让它留在候选里
   *    就等于"路径到哪结束"由正则的贪婪性决定，而那是猜。
   */
  QUOTED_LOCAL_PATH.lastIndex = 0
  let masked = ''
  let cursor = 0
  for (const match of text.matchAll(QUOTED_LOCAL_PATH)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    masked += text.slice(cursor, start)
    masked += ' '.repeat(end - start)
    cursor = end
    if (match[1] !== undefined) push(match[1])
  }
  masked += text.slice(cursor)

  // ② 剩下的是"没有被引号圈起来的"部分：只接受**不含空格**的路径
  BARE_LOCAL_PATH.lastIndex = 0
  const bare = masked.match(BARE_LOCAL_PATH)
  if (bare !== null) for (const token of bare) push(token)
  return out
}

export function createLocalFileIntentDetector(): ActionIntentDetector {
  return {
    detect(text: string): ActionIntent | undefined {
      const trimmed = text.trim()
      if (trimmed === '') return undefined
      const tokens = extractLocalPathTokens(trimmed)
      if (tokens.length === 0) return undefined
      const path = tokens[0]!

      /*
       * 列举优先：`dir C:\a` 与 `列一下 C:\a` 的动作词与读的动作词有重叠
       * （"看看"两边都收），而"看一眼一个目录"在真实用法里指的是**列出它**。
       * ⚠️ 只在路径**没有扩展名**时才允许列举优先 —— 否则
       *    「看看 C:\a\b.txt 里有什么」会被判成列举一个**文件**路径。
       *
       * ⚠️ `options.list` / `options.read` **不参与**这里的取舍（见接口注释）：
       *    它们描述的是"哪一项被启用"，而"这句话像哪一种请求"是形状问题。
       *    真正的闸在策略第 ③ 步（权限）。
       */
      const looksLikeDirectory = !/\.[A-Za-z0-9]{1,8}$/.test(path)
      if (looksLikeDirectory && LIST_VERBS.test(trimmed)) {
        return {
          capability: LOCAL_FILE_LIST,
          operation: LOCAL_FILE_LIST_OPERATION,
          args: { path },
          hints: [path],
          rule: 'local_file_list_path',
          phrase: trimmed.slice(0, 60),
        }
      }
      if (READ_VERBS.test(trimmed)) {
        return {
          capability: LOCAL_FILE_READ,
          operation: LOCAL_FILE_READ_OPERATION,
          args: { path },
          hints: [path],
          rule: 'local_file_read_path',
          phrase: trimmed.slice(0, 60),
        }
      }
      return undefined
    },
  }
}
