/**
 * M3 阈值与 baseline 读取（计划书第 119 / 120 节）。
 *
 * ============================================================================
 *  第一轮只建立 Baseline，第二轮才冻结 Gate Threshold
 * ============================================================================
 * 计划书第 119 节的原话：
 *
 *   > 例如 PC >= 0.90 这种阈值应该先通过 Baseline 决定。
 *   > M3 第一轮：建立 Baseline。第二轮才冻结 Gate Threshold。
 *   > 否则容易拍脑袋设指标。
 *
 * 所以这个文件里**没有**任何写死的人格阈值：`minimums` 是空的，
 * 等 `evals/m3/baseline.json` 里有了实测值（`--write-baseline` 写出来）之后
 * 才由人**显式**冻结进 `minimums`。
 *
 * 唯一无条件判定的是 `hardZero` —— 那四条不是"目标"，而是
 * "任何一次不为零都属于 critical failure"（计划书第 115–118 节），
 * 它们不需要 baseline 就能定，因为正确答案只有一个：0。
 *
 * ---------------------------------------------------------------------------
 *  为什么 baseline 读不到时**不报错**
 * ---------------------------------------------------------------------------
 * 因为"还没有 baseline"是**正常状态**：M3 第一轮本来就只有 baseline 建立。
 * 如果读不到就抛异常，那第一次跑评测的人会卡在一句
 * "baseline.json 不存在"上，而正确行为其实是"照跑，只是不做阈值判定"。
 * 所以这里返回 undefined，由调用方在报告里写清楚"未冻结阈值"。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { M3_HARD_ZERO_METRICS, type EvalThresholds, type M3Metric } from './types.ts'

/** baseline 文件的位置（相对项目根） */
export const M3_BASELINE_PATH = join('evals', 'm3', 'baseline.json')

/**
 * 默认阈值。
 *
 * `minimums` **刻意留空**：人格指标的通过线必须由实测 baseline 决定，
 * 而不是在写代码的时候顺手填一个 0.9 —— 那正是计划书第 119 节反对的事。
 */
export function defaultThresholds(): EvalThresholds {
  return {
    hardZero: [...M3_HARD_ZERO_METRICS],
    minimums: {},
  }
}

/** baseline 文件的形状（由 `scripts/eval-m3-live.ts --write-baseline` 写出） */
export interface M3BaselineFile {
  /** 怎么测出来的（计划书第 120 节：固定 model / temperature / runs） */
  baseline: { model: string; temperature?: number; runs: number; measuredAt: string }
  /** 各指标的实测均值 */
  values: Partial<Record<M3Metric, number>>
  /** 实测方差（第 120 节要求算 mean 与 variance） */
  variance?: Partial<Record<M3Metric, number>>
  /** 每条用例的实测结果（便于日后比对"是不是同一批用例"） */
  cases?: { caseId: string; suiteId: string; passed: boolean; score?: number }[]
}

/**
 * 读 baseline（文件不存在 / 解析失败时返回 undefined，**绝不抛**）。
 *
 * 解析失败也返回 undefined 而不是抛错：一份手改坏的 baseline
 * 不该让整个评测跑不起来 —— 它应当表现为"这次不做阈值判定"，
 * 并在报告里如实说明。
 */
export function readBaseline(path: string = M3_BASELINE_PATH): M3BaselineFile | undefined {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as Partial<M3BaselineFile>
    if (!candidate.baseline || !candidate.values) return undefined
    return candidate as M3BaselineFile
  } catch {
    return undefined
  }
}

/**
 * 把 baseline 的实测值装进阈值结构。
 *
 * ⚠️ 它**不会**自动把 `values` 变成 `minimums`。
 * 从"实测均值"到"可接受的回退线"中间有一个人的判断
 * （计划书第 120 节：acceptable regression threshold），
 * 那一步必须显式做（改 `minimums.ts` 或直接改 baseline 里的 `minimums`），
 * 不能被自动化掉 —— 自动生成的门槛会在第一次跑偏时被一起带偏。
 */
export function thresholdsWithBaseline(
  base: EvalThresholds = defaultThresholds(),
  baseline: M3BaselineFile | undefined = readBaseline()
): EvalThresholds {
  if (!baseline) return base
  return {
    ...base,
    baselineValues: baseline.values,
    baseline: baseline.baseline,
    // 显式冻结的 minimums 优先；没有就不判定
    minimums: { ...(base.minimums ?? {}), ...frozenMinimumsFrom(baseline) },
  }
}

/**
 * baseline 文件里可以带一个 `minimums` 字段来**显式冻结**门槛。
 *
 * 这是"第二轮才冻结"的落地方式：第一轮只写 `values`；
 * 人工看过实测值之后，在这里补 `minimums`，于是门槛是从数据来的，
 * 而且**改动是可见的**（一次 diff 就能看出门槛被调过）。
 */
function frozenMinimumsFrom(baseline: M3BaselineFile): Partial<Record<M3Metric, number>> {
  const explicit = (baseline as { minimums?: Partial<Record<M3Metric, number>> }).minimums
  return explicit ?? {}
}

/** 报告里怎么描述"这次有没有门槛" */
export function describeThresholds(thresholds: EvalThresholds): string {
  const frozen = Object.keys(thresholds.minimums ?? {}).length
  if (frozen === 0) {
    return thresholds.baseline
      ? `已建立 baseline（${thresholds.baseline.model}，${thresholds.baseline.runs} 次），但人格阈值尚未冻结（计划书第 119 节：第二轮才冻结）`
      : '尚未建立 baseline，人格阈值未冻结（M3 第一轮只建立 baseline）'
  }
  return `已冻结 ${frozen} 条人格阈值；硬零指标 ${thresholds.hardZero.length} 条无条件判定`
}
