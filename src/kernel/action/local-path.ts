/**
 * LocalPath —— **本机文件域**的纯路径判定（第二批计划 §2.1 第 1 点）。
 *
 * ============================================================================
 *  它与 `target-resolver.ts` 是**两个域**，因此刻意不复用它
 * ============================================================================
 * ```text
 * target-resolver.ts   沙箱**相对**路径：绝对路径 / 盘符 / `..` 一律是"越界"
 * local-path.ts        本机**绝对**路径：恰恰要求一个确定的本地卷，拒绝网络/设备
 * ```
 * 把两者合成一个函数会让"M4.5 的沙箱守卫"与"全盘授权"共用一条判据 ——
 * 而它们的方向是**相反**的（一个把绝对路径当越界，一个把非绝对路径当越界）。
 * 旧沙箱判定因此**一个字节都不改**（计划书 §2.1 的"保留旧沙箱能力"）。
 *
 * ============================================================================
 *  这个文件里没有 IO
 * ============================================================================
 * 与 `target-resolver.ts` 同一条纪律：**越界永远不会变成一次真实的文件系统访问**。
 * 这里只做语法判定 + 规范化，因此整条判定可以在离线被穷举。
 * "重解析点（symlink / junction）之后是不是还在本地卷"是**适配器**的事
 * （它才有 IO）—— 本文件给它一个确定的绝对路径，它负责按最终位置复核。
 *
 * ============================================================================
 *  首版的四类拒绝（每一类都是一条如实的能力边界，不是保守）
 * ============================================================================
 * ```text
 * unc / device_namespace   网络共享与设备命名空间**不属于**本轮"本机本地文件"范围
 *                          （计划书 §0.2 逐字："网络共享不属于本轮'本机本地文件'范围"）
 * reserved_name            CON / PRN / AUX / NUL / COM1… / LPT1… 在 Windows 上是设备别名
 * trailing_dot_or_space    Windows 会**静默**去掉尾随的 `.` 与空格
 *                          ⇒ "用户给的名字"与"真实落地的名字"会分叉，那正是猜
 * alternate_data_stream    `file.txt:stream` 是 NTFS 备用数据流；
 *                          首版不主张 ADS 保真（计划书 §2.1 末段）
 * ```
 */

import type { ActionEvidence } from './action-request.ts'

export type LocalPathRejectReason =
  | 'empty'
  | 'nul'
  | 'not_absolute'
  | 'unc'
  | 'device_namespace'
  | 'reserved_name'
  | 'trailing_dot_or_space'
  | 'alternate_data_stream'
  | 'invalid_character'
  | 'escapes_volume'

export interface LocalPathAccepted {
  ok: true
  /** 规范化后的绝对路径：盘符大写、`\` 分隔、无 `.`/`..` 段、根之外无尾随分隔符 */
  absolutePath: string
  /** 确定的本地卷根（`C:\`；POSIX 上是 `/`） */
  volume: string
  /** 相对卷根的段（只读证据用） */
  segments: readonly string[]
}

export interface LocalPathRejected {
  ok: false
  reason: LocalPathRejectReason
  /** 人类可读说明（**不含文件内容**） */
  detail: string
}

export type LocalPathVerdict = LocalPathAccepted | LocalPathRejected

/** Windows 保留设备名（大小写不敏感；**带扩展名也算** —— `NUL.txt` 同样是设备） */
const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
])

/** Windows 上非法或语义特殊的字符（`:` 另判 ADS；`\` 与 `/` 已被当作分隔符） */
const INVALID_CHARS = /[<>"|?*]/

function reject(reason: LocalPathRejectReason, detail: string): LocalPathRejected {
  return { ok: false, reason, detail }
}

function isReservedName(segment: string): boolean {
  const stem = segment.split('.')[0] ?? segment
  return RESERVED_NAMES.has(stem.toUpperCase())
}

/**
 * 判定一个**用户/模型给出的本机绝对路径**。
 *
 * 返回的是"确定的本地卷上的确定文件（或其父目录）"，不含任何 IO。
 *
 * ⚠️ `platform` 是**显式参数**而不是读 `process.platform`：kernel 不读运行环境，
 *    而"这条路径在这台机器上意味着什么"必须能被离线穷举（两种平台都测）。
 *    缺省保留历史 `win32`；运行时装配必须传入实际宿主平台。
 */
export function inspectLocalPath(
  raw: string,
  options?: { platform?: 'win32' | 'posix' }
): LocalPathVerdict {
  const platform = options?.platform ?? 'win32'
  if (typeof raw !== 'string') return reject('empty', '路径不是字符串')
  const trimmed = raw.trim()
  if (trimmed === '') return reject('empty', '路径为空')
  if (trimmed.includes('\u0000')) return reject('nul', '路径含 NUL 字节')

  if (platform === 'posix') {
    if (!trimmed.startsWith('/')) {
      return reject('not_absolute', `本机文件域只接受绝对路径，收到相对路径：${trimmed}`)
    }
    if (trimmed.startsWith('//')) {
      return reject('unc', `网络路径不属于本轮"本机本地文件"范围：${trimmed}`)
    }
    const segments: string[] = []
    for (const segment of trimmed.split('/').filter((s) => s !== '')) {
      if (segment === '.') continue
      if (segment === '..') {
        if (segments.length === 0) return reject('escapes_volume', `路径用 .. 跳出了卷根：${trimmed}`)
        segments.pop()
        continue
      }
      if (segment.includes('\u0000')) return reject('nul', '路径含 NUL 字节')
      segments.push(segment)
    }
    return { ok: true, absolutePath: `/${segments.join('/')}`, volume: '/', segments }
  }

  const unified = trimmed.replace(/\//g, '\\')

  // ① 网络共享 / 设备命名空间：`\\server\share`、`\\?\C:\…`、`\\.\PHYSICALDRIVE0`
  if (unified.startsWith('\\\\')) {
    if (/^\\\\[?.]\\/.test(unified)) {
      return reject('device_namespace', `设备命名空间路径不在本机文件域内：${trimmed}`)
    }
    return reject('unc', `网络共享路径不属于本轮"本机本地文件"范围：${trimmed}`)
  }

  // ② 卷：必须有盘符；`\foo` 落在"当前盘"上 ⇒ 不是一个确定的本地卷
  let volume: string
  let rest: string
  const drive = /^([a-zA-Z]):(?=\\|$)/.exec(unified)
  if (drive !== null) {
    volume = `${drive[1]!.toUpperCase()}:\\`
    rest = unified.slice(2)
  } else if (unified.startsWith('\\')) {
    return reject('not_absolute', `没有盘符的根相对路径无法确定所在卷：${trimmed}`)
  } else {
    return reject('not_absolute', `本机文件域只接受绝对路径，收到相对路径：${trimmed}`)
  }

  const rawSegments = rest.split('\\').filter((segment) => segment !== '')
  const segments: string[] = []
  for (const segment of rawSegments) {
    if (segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) {
        return reject('escapes_volume', `路径用 .. 跳出了卷根：${trimmed}`)
      }
      segments.pop()
      continue
    }
    if (segment.includes(':')) {
      return reject('alternate_data_stream', `备用数据流（NTFS ADS）不在首版范围内：${trimmed}`)
    }
    if (INVALID_CHARS.test(segment)) {
      return reject('invalid_character', `路径段含 Windows 非法字符：${segment}`)
    }
    if (/[ .]$/.test(segment)) {
      return reject(
        'trailing_dot_or_space',
        `路径段以 . 或空格结尾，Windows 会静默改名（不能拿它当确定目标）：${segment}`
      )
    }
    if (isReservedName(segment)) {
      return reject('reserved_name', `路径段是 Windows 设备别名，不能当普通文件：${segment}`)
    }
    segments.push(segment)
  }

  /*
   * ⚠️ **卷根本身是合法目标**（`C:\`）：`local.file.list` 要能枚举一个卷的根。
   *    "根不能读/不能写"是**适配器**按操作判的（读一个目录 ⇒ 目标是目录，不是文件），
   *    不是路径域判定的职责 —— 在这里拒掉会让"列一下 D 盘"变成一条语法错误。
   */
  const absolutePath = segments.length === 0 ? volume : `${volume}${segments.join('\\')}`
  return { ok: true, absolutePath, volume, segments }
}

/** 规范化后的绝对路径的最后一段（卷根时返回卷本身） */
export function localBasenameOf(absolutePath: string): string {
  const unified = absolutePath.replace(/\//g, '\\')
  const withoutTrailing = unified.endsWith('\\') ? unified.slice(0, -1) : unified
  const index = withoutTrailing.lastIndexOf('\\')
  return index < 0 ? withoutTrailing : withoutTrailing.slice(index + 1)
}

/** 父目录（**纯字符串**；kernel 不许 import `node:path`） */
export function localDirnameOf(absolutePath: string): string {
  const unified = absolutePath.replace(/\//g, '\\')
  const withoutTrailing = unified.endsWith('\\') ? unified.slice(0, -1) : unified
  const index = withoutTrailing.lastIndexOf('\\')
  if (index < 0) return withoutTrailing
  // 保留卷根形态：`C:\a` 的父目录是 `C:\` 而不是 `C:`
  if (index === 2 && /^[a-zA-Z]:$/.test(withoutTrailing.slice(0, 2))) {
    return `${withoutTrailing.slice(0, 2)}\\`
  }
  return withoutTrailing.slice(0, index)
}

export function localJoinSegments(volume: string, segments: readonly string[]): string {
  return segments.length === 0 ? volume : `${volume}${segments.join('\\')}`
}

/**
 * 路径域**证据**。
 *
 * ============================================================================
 *  它存在的唯一理由：Policy 与 trace 不许把它说成"沙箱范围内"
 * ============================================================================
 * 计划书 §2.1 第 2 点逐字：「全盘目标携带真实的本地路径域证据，Policy/trace
 * 不能把它错误描述为'沙箱范围内'」。因此这里产出的每一条都是**本地域**的陈述，
 * 并且**明说**它在沙箱约束之外。
 */
export function localPathDomainEvidence(input: {
  absolutePath: string
  volume: string
  segments: readonly string[]
}): ActionEvidence[] {
  const depth = input.segments.length
  const inSandbox = false
  return [
    {
      kind: 'filesystem',
      detail:
        `本机文件域（已授权的全盘域，**不是**沙箱）：卷 ${input.volume} · ` +
        `绝对路径 · 层级 ${String(depth)} · 在沙箱约束内=${String(inSandbox)}`,
      ref: input.absolutePath,
    },
    {
      kind: 'adapter',
      detail: '目标由本机绝对路径解析而来（未经过沙箱相对路径判定）',
    },
  ]
}

/** 拒绝原因 → 用户可见的一句话（**只说事实，不猜**） */
export function localPathRejectDetail(reason: LocalPathRejectReason): string {
  switch (reason) {
    case 'empty':
      return '路径为空'
    case 'nul':
      return '路径含 NUL 字节'
    case 'not_absolute':
      return '不是本机绝对路径'
    case 'unc':
      return '网络共享路径不属于本机本地文件范围'
    case 'device_namespace':
      return '设备命名空间路径不属于本机本地文件范围'
    case 'reserved_name':
      return '路径段是 Windows 设备别名'
    case 'trailing_dot_or_space':
      return '路径段以点或空格结尾，Windows 会静默改名'
    case 'alternate_data_stream':
      return 'NTFS 备用数据流不在首版范围内'
    case 'invalid_character':
      return '路径段含 Windows 非法字符'
    case 'escapes_volume':
      return '路径用 .. 跳出了卷根'
  }
}
