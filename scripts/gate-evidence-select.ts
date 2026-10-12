/**
 * **共享选档器** —— "这一道门的最新一份读数到底是哪一份" 的**唯一**实现。
 *
 * ============================================================================
 *  为什么要有这个模块（`TD-23` / `AUD-20261005-02`）
 * ============================================================================
 * 同一个缺陷在三个聚合门上出现过三次，形态完全一样：
 *
 * ```text
 * 旧实现：readdirSync(...).sort(by mtimeMs).at(-1)
 *   ⇒ "最新一份"按**文件系统时间**判 —— 而 mtime 会因为复制 / 检出 / 恢复 /
 *     甚至"两边在同一秒写盘"而与**提交先后**不一致（`R-34` 的实测反例：
 *     四份档目录 mtime 完全相同 ⇒ 并列落到目录名字典序最后 = 那份 FAIL）。
 *   ⇒ 后果：同一批档案，"最新"会漂移 ⇒ 判定看起来确定、其实不确定。
 * ```
 *
 * 现在按**信号强弱**取值（先到先得），并把用的是哪一段**写进读数**（具名，不许静默）：
 *
 * ```text
 * ① `reported-time`        读数 / 清单自报的 `ended` / `finishedAt` / `generatedAt` / `started`
 * ② `head-commit-time`     **这份档测的是哪个提交**（清单 `head`，否则从 `runId` 的 `-<head12>-` 提取）
 *                          ⇒ 用**那个提交的提交时刻**排序
 * ③ `evidence-commit-time` 该证据文件在 git 里的提交时刻（同一 head 重跑时用它分先后）
 * ④ `manifest-date`        清单只有 `date`（**日粒度**，最弱 —— 同一天的所有档会并列）
 * ⑤ `none`                 **具名降级**：什么时间戳都没有 ⇒ 只按 `runId` 字典序，调用方必须打印出来
 * ```
 *
 * **mtime 永不参与**（`TD-23`）：本模块里没有一处 `statSync(...).mtimeMs`。
 *
 * 并列（时间相同）⇒ 按 `runId` 升序裁决，并把并列的档名记进 `tiedWith`。
 * **刻意不优先取 PASS 的那一份**：归属必须如实。并列组里**判定不同** ⇒
 * `conflictingVerdicts = true`，调用方**失败关闭**（报 `AMBIGUOUS`），
 * 而不是靠 `runId` 字典序偷偷定一个。
 *
 * ⚠️ 本模块**只读**文件与 git，不起数据库、不出网、不写任何东西。
 *
 * 使用者：`scripts/m10.1-gate-select.ts`（`R-34`/`TD-23` 的原修法）·
 * `scripts/m10-gates.ts` · `scripts/m11.1-gates.ts`（`AUD-20261005-02` 的修法）。
 * 三段式量具在 `scripts/gates-selection-verify.ts`。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'

export type SelectionBasis =
  | 'reported-time'
  | 'head-commit-time'
  | 'evidence-commit-time'
  | 'manifest-date'
  | 'none'

const READ_TIME_KEYS = ['ended', 'finishedAt', 'generatedAt', 'started'] as const
const MANIFEST_TIME_KEYS = ['ended', 'finishedAt', 'generatedAt', 'started'] as const

export const toMs = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    /* 秒 vs 毫秒：> 1e11 只可能是毫秒（1e11 ms ≈ 1973 年；1e11 s 太远） */
    return value > 1e11 ? value : value * 1000
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export const firstTime = (record: Record<string, unknown>, keys: readonly string[]): number | null => {
  for (const key of keys) {
    const ms = toMs(record[key])
    if (ms !== null) return ms
  }
  return null
}

/** 读一份 JSON 成对象；读不到 / 不是对象 ⇒ 空对象（**不抛**：缺字段本身就是一种读数）。 */
export const parseJsonObject = (path: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 每个路径 / ref 只问一次 git（同一道门的候选不会太多，但避免重复调用）。 */
const gitTimeCache = new Map<string, number | null>()

/** Windows 盘符 / UNC / POSIX 绝对路径都算"不在仓库内"。 */
const isAbsoluteLike = (rel: string): boolean => /^([a-zA-Z]:|\/|\\)/.test(rel)

/** `<ref>` 的提交时刻（毫秒）；取不到 ⇒ null。 */
export const gitRefTime = (ref: string): number | null => {
  const key = `ref:${ref}`
  const cached = gitTimeCache.get(key)
  if (cached !== undefined) return cached
  let result: number | null = null
  try {
    const seconds = execFileSync('git', ['log', '-1', '--format=%ct', ref], { encoding: 'utf8' }).trim()
    if (seconds !== '' && Number.isFinite(Number(seconds))) result = Number(seconds) * 1000
  } catch {
    result = null
  }
  gitTimeCache.set(key, result)
  return result
}

/** 证据文件自身的提交时刻（毫秒）；未入库 / **不在仓库内** ⇒ null。 */
export const gitPathTime = (path: string): number | null => {
  const key = `path:${path}`
  const cached = gitTimeCache.get(key)
  if (cached !== undefined) return cached
  let result: number | null = null
  const rel = relative(process.cwd(), path).replace(/\\/g, '/')
  /* 仓库外的路径（量具的三段式夹具就在 %TEMP%）⇒ 直接不问了：`git` 会往 stderr 喷 "outside repository" */
  if (!rel.startsWith('..') && !isAbsoluteLike(rel)) {
    try {
      const seconds = execFileSync('git', ['log', '-1', '--format=%ct', '--', rel], { encoding: 'utf8' }).trim()
      if (seconds !== '' && Number.isFinite(Number(seconds))) result = Number(seconds) * 1000
    } catch {
      result = null
    }
  }
  gitTimeCache.set(key, result)
  return result
}

/**
 * 从 `runId` 里取 head（12 位十六进制）：形如 `…-<YYYYMMDD>-<head12>-<hash4>`
 * （`m10-*` 与 `m11-*` 两种 runId 都是这个形状）。
 * 取不到 ⇒ undefined（那就只剩 `evidence-commit-time` / `manifest-date` 可用）。
 */
export const headFromRunId = (runId: string): string | undefined => {
  const match = /-(\d{8})-([0-9a-f]{7,40})-([0-9a-f]{4,})$/.exec(runId)
  return match?.[2]
}

export interface BasisInput {
  readonly runId: string
  readonly manifest: Record<string, unknown>
  /** 该档的**读数文件**内容（`{}` = 读不到） */
  readonly reading: Record<string, unknown>
  /** 证据文件路径（用于 `evidence-commit-time`）；不给 ⇒ 不查 git 路径时刻 */
  readonly evidencePath?: string
}

/**
 * 算一份档的时间与**用的是哪一段**。五段按强弱先到先得（见文件头）。
 * ⚠️ **没有任何一段涉及 mtime**。
 */
export function basisTime(input: BasisInput): { time: number | null; basis: SelectionBasis } {
  /* ① 读数自报 */
  let time = firstTime(input.reading, READ_TIME_KEYS)
  let basis: SelectionBasis = time === null ? 'none' : 'reported-time'

  /* ①′ 清单自报（与读数同一段：都是"这份档自己说它什么时候结束的"） */
  if (time === null) {
    const selfReported = firstTime(input.manifest, MANIFEST_TIME_KEYS)
    if (selfReported !== null) {
      time = selfReported
      basis = 'reported-time'
    }
  }

  /* ② 这一档测的是哪个提交 ⇒ 用那个提交的提交时刻 */
  if (time === null) {
    const head =
      (typeof input.manifest.head === 'string' && input.manifest.head !== '' ? input.manifest.head : undefined) ??
      headFromRunId(input.runId)
    if (head !== undefined) {
      const headTime = gitRefTime(head)
      if (headTime !== null) {
        time = headTime
        basis = 'head-commit-time'
      }
    }
  }

  /* ③ 同一 head 重跑时靠证据文件自己的提交时刻分先后 */
  if (time === null && input.evidencePath !== undefined) {
    const committed = gitPathTime(input.evidencePath)
    if (committed !== null) {
      time = committed
      basis = 'evidence-commit-time'
    }
  }

  /* ④ 最弱的一段：清单只有 date（日粒度） */
  if (time === null) {
    const day = toMs(input.manifest.date)
    if (day !== null) {
      time = day
      basis = 'manifest-date'
    }
  }

  return { time, basis }
}

export interface RankInput<T> {
  readonly item: T
  readonly dir: string
  readonly runId: string
  readonly manifest: Record<string, unknown>
  readonly reading: Record<string, unknown>
  readonly evidencePath?: string
  /**
   * 这一档的**判定标签**（用于"并列组里判定不同 ⇒ 失败关闭"）。
   * `undefined` ⇒ 不参与冲突检测（调用方自己决定要不要报 AMBIGUOUS）。
   */
  readonly verdict?: string | null | undefined
}

export interface RankedReading<T> {
  readonly item: T
  readonly dir: string
  readonly runId: string
  /** 选定依据的那段时间（毫秒）；`basis === 'none'` 时是 `-Infinity` */
  readonly time: number
  readonly basis: SelectionBasis
  readonly verdict: string | null | undefined
}

/** 按 `(time 升序, runId 升序)` 排序。`none`（-Infinity）排最前 ⇒ 只按 runId 裁决。 */
export function rankReadings<T>(inputs: readonly RankInput<T>[]): RankedReading<T>[] {
  return inputs
    .map((input) => {
      const { time, basis } = basisTime({
        runId: input.runId,
        manifest: input.manifest,
        reading: input.reading,
        ...(input.evidencePath === undefined ? {} : { evidencePath: input.evidencePath }),
      })
      return {
        item: input.item,
        dir: input.dir,
        runId: input.runId,
        time: time ?? Number.NEGATIVE_INFINITY,
        basis,
        verdict: input.verdict,
      }
    })
    .sort((a, b) => a.time - b.time || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0))
}

export interface LatestPick<T> {
  readonly picked: RankedReading<T>
  /** 与选定档**时间并列**的其它档（`runId` 升序）；空数组 = 无并列 */
  readonly tiedWith: readonly string[]
  /** 并列组里**判定不同** ⇒ 调用方必须失败关闭（"刻意不优先取 PASS"的另一面） */
  readonly conflictingVerdicts: boolean
}

/**
 * 取**最新的一份**。没有候选 ⇒ `undefined`（调用方按 `NOT RUN` 处理，**不是** PASS）。
 * ⚠️ 它**不**替你选 PASS：并列且判定不同时，它只回 `conflictingVerdicts = true`。
 */
export function pickLatest<T>(ranked: readonly RankedReading<T>[]): LatestPick<T> | undefined {
  const picked = ranked[ranked.length - 1]
  if (picked === undefined) return undefined
  const tiedGroup = ranked.filter((candidate) => candidate.time === picked.time)
  const tiedWith = tiedGroup.filter((candidate) => candidate.runId !== picked.runId).map((candidate) => candidate.runId)
  const conflictingVerdicts = tiedGroup.some((candidate) => candidate.verdict !== picked.verdict)
  return { picked, tiedWith, conflictingVerdicts }
}

/*
 * ⚠️ **本模块刻意没有"mtime 后备"这种函数** —— 连一个可注入的版本都不留。
 *    "万一以后有人想切回 mtime"这条口子本身就是 `TD-23` 要关的东西：
 *    量具里的**mtime 反证**（`gates-selection-verify.ts` 的负控）用 `statSync`
 *    在**量具文件自己**里搭一个对照排序，而不是在这里留一个能用的 mtime 入口。
 *    ⇒ 结构锁因此可以断言"本文件里一处 `mtime` 都没有"（注入即响）。
 */
