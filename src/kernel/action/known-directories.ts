/**
 * KnownDirectories —— **程序给出的已知目录事实**（WP2 / ADR-104 D14）。
 *
 * ============================================================================
 *  它解决的是哪一个具体故障
 * ============================================================================
 * 计划书 §4 缺口 2 逐字：「程序提供 Windows 已知目录证据（个人桌面、公共桌面等），
 * 处理重定向后的实际路径；模型不能猜 `user` / `Administrator`。」
 *
 * 实测形态（2026-10-04 的真模型 live）：同一个 trace 里 12 次 `local.file.list`，
 * 其中两次是模型**猜**出来的 `C:\Users\user\Desktop` / `C:\Users\Administrator\Desktop`
 * —— 它没有任何办法知道真实用户名，于是只能猜。⇒ 规划器永远收敛不了。
 *
 * 本文件把"这台机器上的个人桌面 / 公共桌面**实际**在哪"变成一条**程序事实**：
 * ```text
 * 探测（infrastructure）→ 原始输出 → 本文件的**纯解析** → 事实 → 渲染进
 *   决策器输入（WP1 的目录块旁边）与规划器输入（WP2 的重新规划）
 * ```
 *
 * ============================================================================
 *  三条纪律
 * ============================================================================
 * ```text
 * ① **不猜**：路径只有两个来源 —— 系统 API 给的，或"探测失败"这条如实事实。
 *    本文件**不组装** `%USERPROFILE%\Desktop` 这类猜测（重定向后它会指向不存在的地方）。
 * ② **处理重定向**：探测走的是系统"已知文件夹"API（OneDrive 把桌面搬走时它给的是
 *    新位置），而不是把一个固定相对路径拼出来。
 * ③ **失败也是读数**：探测超时 / 没有解释器 / 输出不可解析 ⇒ 如实记 `probe_failed`，
 *    而不是悄悄回落到一个猜出来的路径（那正是要修的那个故障）。
 * ```
 *
 * ⚠️ 本文件是**纯函数**：不读环境、不 spawn、不碰文件系统。
 *    "这个目录在不在"由调用方给一个 `exists` 函数（离线门因此可以注入）。
 */

/** 已知目录的**闭集**键（扩一个键 = 改探测 + 改渲染 + 加一条用例） */
export const KNOWN_DIRECTORY_KEYS = ['personal_desktop', 'public_desktop'] as const
export type KnownDirectoryKey = (typeof KNOWN_DIRECTORY_KEYS)[number]

/** 用户可读的名字（**只**用于渲染，不参与判定） */
export const KNOWN_DIRECTORY_LABELS: Readonly<Record<KnownDirectoryKey, string>> = {
  personal_desktop: '个人桌面',
  public_desktop: '公共桌面',
}

export type KnownDirectorySource =
  /** 探测给的，且目录真的在 */
  | 'probe'
  /** 探测给了，但那个目录不在（过期的重定向 / 被删掉）—— 如实说"不在了" */
  | 'probe_missing'
  /** 探测本身失败（超时 / 没有解释器 / 输出不可解析） */
  | 'probe_failed'
  /** 没有探测（非 Windows / 没接探测器） */
  | 'probe_absent'

export interface KnownDirectoryFact {
  readonly key: KnownDirectoryKey
  /** 只有 `probe` / `probe_missing` 才有路径；其余两档如实没有路径 */
  readonly path?: string
  readonly source: KnownDirectorySource
  readonly exists: boolean
}

/** 一行 `key=path` 的分隔符（路径里可能有 `=`，因此**只按第一个**切） */
const PROBE_LINE_SEPARATOR = '='

function isKnownDirectoryKey(value: string): value is KnownDirectoryKey {
  return (KNOWN_DIRECTORY_KEYS as readonly string[]).includes(value)
}

/**
 * 解析探测的**原始输出**（纯函数，失败关闭）。
 *
 * 输入形状 = 探测脚本的一行行 `key=path`（本仓库的探测脚本按这个形状打印）。
 * 判据：
 * ```text
 * · 不认识的键 ⇒ 忽略（不新增事实，也不报错 —— 那是探测脚本的事）
 * · 同一个键出现两次 ⇒ **取第一条**（保序、可复现）
 * · 路径为空 / 只有空白 ⇒ 当作"这一档没拿到"
 * · 路径存在与否由 `exists()` 回答 ⇒ `probe` / `probe_missing`
 * ```
 * ⚠️ **不校验路径形状**：这条事实的权威是系统 API，不是我们的正则。
 *    一个不存在的路径会被如实标成 `probe_missing`（而不是被丢弃）。
 */
export function parseKnownDirectoryProbe(
  stdout: string,
  options: { exists: (path: string) => boolean }
): readonly KnownDirectoryFact[] {
  const found = new Map<KnownDirectoryKey, KnownDirectoryFact>()
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const separator = line.indexOf(PROBE_LINE_SEPARATOR)
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (!isKnownDirectoryKey(key)) continue
    if (found.has(key)) continue
    const path = line.slice(separator + 1).trim()
    if (path === '') continue
    const exists = options.exists(path)
    found.set(key, { key, path, source: exists ? 'probe' : 'probe_missing', exists })
  }
  return KNOWN_DIRECTORY_KEYS.map(
    (key) => found.get(key) ?? { key, source: 'probe_failed' as const, exists: false }
  )
}

/**
 * 探测整体失败时的事实（**如实**：没有路径，而不是"用猜的补上"）。
 *
 * ⚠️ 为什么"整档失败"也要产出事实而不是返回 `undefined`：调用方需要能区分
 *    "没有探测"（`probe_absent`，非 Windows）与"探测了但没成"（`probe_failed`），
 *    而两者的**下游行为**相同（都不许猜）。混成一个 `undefined` 会让报告说不清发生了什么。
 */
export function knownDirectoryProbeFailed(
  source: Extract<KnownDirectorySource, 'probe_failed' | 'probe_absent'>
): readonly KnownDirectoryFact[] {
  return KNOWN_DIRECTORY_KEYS.map((key) => ({ key, source, exists: false }))
}

/** 渲染成**给模型看的**事实块（决策器与规划器共用同一份渲染 ⇒ 两处不会分叉） */
export function renderKnownDirectoriesForModel(
  facts: readonly KnownDirectoryFact[],
  options: { header?: string } = {}
): string {
  const lines: string[] = [
    options.header ??
      '# 程序给出的已知目录（**这些是事实**）\n' +
        '\n' +
        '下面是这台机器上这几个目录的**实际位置**（已经处理过"被重定向到别处"的情况）。\n' +
        '需要这些位置时**逐字使用**它们；**不要**用 `user` / `Administrator` 之类拼一个路径。',
  ]
  for (const fact of facts) {
    const label = KNOWN_DIRECTORY_LABELS[fact.key]
    if (fact.source === 'probe' && fact.path !== undefined) {
      lines.push(`- ${label}（${fact.key}）：${fact.path}`)
      continue
    }
    if (fact.source === 'probe_missing' && fact.path !== undefined) {
      lines.push(`- ${label}（${fact.key}）：程序查到的是 ${fact.path}，但**它现在不在**`)
      continue
    }
    lines.push(
      `- ${label}（${fact.key}）：**探测失败**（这一轮不能假设它在哪 —— 需要时请先列一层目录）`
    )
  }
  return lines.join('\n')
}

/** 机器证据用的一行摘要（**不含**任何用户内容；只有键 / 档位 / 路径长度） */
export function describeKnownDirectories(facts: readonly KnownDirectoryFact[]): string {
  return facts
    .map(
      (fact) =>
        `${fact.key}:${fact.source}` +
        `${fact.path === undefined ? '' : `(${String(fact.path.length)}字符)`}`
    )
    .join(' ')
}
