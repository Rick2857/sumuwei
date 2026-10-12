/**
 * 检查 → 指标的映射（计划书第 114/115 节）。
 *
 * ============================================================================
 *  为什么要"声明式"映射，而不是在脚本里散着算
 * ============================================================================
 * `M3_METRICS` 里的十二个名字会出现在报告、baseline 文件与 Gate 判定里，
 * 因此"哪条检查算进了哪个指标"必须能被一行一行读出来。
 * 如果这件事散在运行脚本的十几个 if 里，半年后没人说得清
 * `SourceClassificationAccuracy` 到底统计了哪些断言。
 *
 * 所以规则很简单：**每条检查自己声明它属于哪个指标**。
 * 检查是 `DeterministicCheck` / `JudgeCheck`，冻结类型里没有 `metric` 字段
 * （judge 只有 `metric: 'PC' | 'SA' | …` 这种**评分维度**，不是指标名），
 * 于是这里用交叉类型补一个可选字段 —— 属于本目录的能力增强，
 * 不改冻结文件、也不另造一套检查类型。
 */

import type { EvalCheck, M3Metric } from '../types.ts'

/** 声明了自己归属指标的检查 */
export type MetrickedCheck = EvalCheck & { metric?: M3Metric }

export function metricOf(check: EvalCheck): M3Metric | undefined {
  return (check as MetrickedCheck).metric
}

/**
 * judge 的评分维度 → M3 指标名。
 *
 * 两套名字必须分开：`PC` 是"This reply shows the trait direction"，
 * 而 `PersonalityConsistency` 是"整份报告里 PC 的均值"。
 * 把它们混成一个字段，就没法在同一份报告里既回答
 * "哪一轮漂了"又回答"整体 PC 是多少"。
 */
export const JUDGE_DIMENSION_TO_METRIC = {
  PC: 'PersonalityConsistency',
  SA: 'StyleAdherence',
  DRIFT: 'DriftRate',
  RECOVERY: 'RecoveryRate',
  TRAIT_ALIGNMENT: 'PersonalityConsistency',
} as const

/** 十二个指标的**方向**：哪一侧是"好" */
export type MetricDirection = 'higher-better' | 'lower-better' | 'zero'

export const METRIC_DIRECTIONS: Record<M3Metric, MetricDirection> = {
  IdentityStabilityRate: 'higher-better',
  SeedMutationViolationCount: 'zero',
  CharacterIdContinuity: 'higher-better',
  SourceClassificationAccuracy: 'higher-better',
  AssistantToFactContaminationRate: 'zero',
  ConversationEventLossRate: 'zero',
  EventOrderingErrorRate: 'zero',
  PersonalityConsistency: 'higher-better',
  StyleAdherence: 'higher-better',
  DriftRate: 'lower-better',
  RecoveryRate: 'higher-better',
  AnonymousPersonaGap: 'lower-better',
}

/**
 * 指标的**分子口径说明**（进报告与文档）。
 *
 * 计划书第 115 节把 AssistantToFactContaminationRate 定义成
 * `污染条数 / 受检条数`。因此这里给每个指标写清"受检的是什么"，
 * 这样报告里的 `12/12` 不会变成一个没人知道分母是什么的数字。
 */
export const METRIC_DENOMINATORS: Record<M3Metric, string> = {
  IdentityStabilityRate: '身份相关确定性检查（section 在不在 / Seed 有没有变）',
  SeedMutationViolationCount: '普通聊天导致 Seed 版本或指纹改变的次数',
  CharacterIdContinuity: '跨重启 / 跨会话的 CharacterId 比对次数',
  SourceClassificationAccuracy: '来源分类断言（actor↔kind↔authority 与隔离）',
  AssistantToFactContaminationRate: '受检的她的事件条数（有没有一条成为外部事实证据）',
  ConversationEventLossRate: '会话内序号连续性检查（处理了却没记账会在跳号处露出来）',
  EventOrderingErrorRate: '角色级序号单调性检查',
  PersonalityConsistency: 'judge 打分的回复条数（PC）',
  StyleAdherence: 'judge 打分的回复条数（SA）',
  DriftRate: 'drift 套件里的漂移检查条数',
  RecoveryRate: '施压结束之后的回稳检查条数',
  AnonymousPersonaGap: '具名 / 匿名两轮里可比的检查条数',
}

/** 硬零指标：任何非零都意味着 critical failure（计划书第 116–118 节） */
export const HARD_ZERO_DIRECTIONS = new Set<MetricDirection>(['zero'])

/**
 * "这一条观测是装置自己攒起来的"标记。
 *
 * 有些用例的判定对象不是**某一轮**，而是一段跨轮的**序列**
 * （例如 T6："她先说了一句 → 用户回复了她那句"）。
 * 那种局面由装置用若干具名操作拼出来，并把相关事件聚合成一条观测。
 *
 * 引擎看到这个标记就不再往上合并用例元数据 —— 因为聚合观测的
 * `newEvents` 是点名挑出来的事件，不是"这一轮新增的事件"，
 * 覆盖它的 attributes 会让"这条观测代表什么"变得含糊。
 */
export const AGGREGATE_OBSERVATION = '__m3_aggregate_observation__'

/**
 * `EvalObservation.attributes` 里标记聚合观测的键。
 *
 * ⚠️ 与 `M3_RUNTIME_PORT` 一样必须是**字符串**而不是 Symbol：
 * 报告会经 `JSON.stringify` 写进 `--json` 文件、并经 Promptfoo 的 provider
 * **跨进程**传递，而 Symbol 键在序列化时**静默消失** ——
 * 症状是"本地直接跑没问题，走 Promptfoo 就认不出聚合观测"。
 *
 * 一个只在部分运行方式下生效的通道，比一个可能撞名的通道危险得多。
 */
export const AGGREGATE_OBSERVATION_KEY = AGGREGATE_OBSERVATION
