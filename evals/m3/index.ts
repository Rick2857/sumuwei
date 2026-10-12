/**
 * M3 评测套件的**总出口**。
 *
 * ============================================================================
 *  这个文件是"哪些评测存在"的唯一清单
 * ============================================================================
 * 三种消费者都只读它：
 *
 *   `scripts/eval-m3.ts`              离线跑（echo，秒级，PR smoke）
 *   `scripts/eval-m3-live.ts`         真实模型跑（Release Gate）
 *   `scripts/build-m3-promptfoo-config.ts`  生成每个套件一个 YAML
 *
 * 它们**都不**各自维护一份列表 —— 否则"新增了套件但 Promptfoo 里没有"
 * 这类漏配会一直存在，而且没人会发现（因为两边都是绿的）。
 *
 * ---------------------------------------------------------------------------
 *  套件与计划书第 49 节目录的对应关系
 * ---------------------------------------------------------------------------
 *      evals/m3/identity/            identity-core / value-consistency / boundary-consistency
 *      evals/m3/integrity/           assistant-fabrication / source-separation / user-correction
 *      evals/m3/drift/               long-dialogue / adversarial-role-change
 *      evals/m3/session/             restart / new-conversation
 *      evals/m3/anonymous/           anonymous-persona
 *      evals/m3/personality-interview/  interview-bank
 *
 * 计划书第 49 节列了 10 个 YAML；这里多出两个（anonymous / personality-interview），
 * 因为第 110/111 节把它们列为 T12/T13 测试组，而第 66/111 节也要求
 * 有 anonymous 与 personality-interview 目录。多出来的两个**不是**偏离计划，
 * 而是把"测试矩阵里有、目录清单里漏了"的两项补上。
 */

import type { EvalSuite } from './types.ts'
import { identityCoreSuite } from './suites/identity-core.ts'
import { valueConsistencySuite } from './suites/value-consistency.ts'
import { boundaryConsistencySuite } from './suites/boundary-consistency.ts'
import { assistantFabricationSuite } from './suites/assistant-fabrication.ts'
import { sourceSeparationSuite } from './suites/source-separation.ts'
import { userCorrectionSuite } from './suites/user-correction.ts'
import { longDialogueSuite } from './suites/long-dialogue.ts'
import { adversarialRoleChangeSuite } from './suites/adversarial-role-change.ts'
import { sessionRestartSuite } from './suites/session-restart.ts'
import { newConversationSuite } from './suites/new-conversation.ts'
import { anonymousPersonaSuite } from './suites/anonymous-persona.ts'
import { personalityInterviewSuite } from './suites/personality-interview.ts'

/**
 * 全部 M3 套件（顺序 = 报告里的顺序 = Promptfoo 生成的顺序）。
 *
 * 顺序刻意与计划书第 47 节的三层人格评测一致：
 *   行为规则 → 事实完整性 → 漂移 → 会话 → 匿名 → 访谈
 * 即"从硬保证到软倾向"。读报告的人一眼就能看出哪一层在掉分。
 */
export const M3_SUITES: readonly EvalSuite[] = [
  // --- 第一层：行为规则一致性（几乎全是确定性检查）------------------------
  identityCoreSuite,
  valueConsistencySuite,
  boundaryConsistencySuite,

  // --- 事实完整性（T4–T8）-------------------------------------------------
  assistantFabricationSuite,
  sourceSeparationSuite,
  userCorrectionSuite,

  // --- 长对话与对抗（T9/T11）---------------------------------------------
  longDialogueSuite,
  adversarialRoleChangeSuite,

  // --- 会话连续性（T1/T2/T10）--------------------------------------------
  sessionRestartSuite,
  newConversationSuite,

  // --- 第二/三层：表层风格与深层倾向（T12/T13）----------------------------
  anonymousPersonaSuite,
  personalityInterviewSuite,
]

/** 按 id 取一个套件（不存在时 undefined —— 调用方自己决定怎么报错） */
export function findM3Suite(id: string): EvalSuite | undefined {
  return M3_SUITES.find((suite) => suite.id === id)
}

/** 全部套件 id（CLI 的 `--suite` 帮助文本与校验用） */
export function m3SuiteIds(): string[] {
  return M3_SUITES.map((suite) => suite.id)
}

/** 全部用例（拍平，供计数与"PR Smoke Set 有多大"这类问题使用） */
export function m3Cases(): { suiteId: string; caseId: string }[] {
  return M3_SUITES.flatMap((suite) =>
    suite.cases.map((item) => ({ suiteId: suite.id, caseId: item.id }))
  )
}

/** 每条用例的检查条数（用于报告头部的"这次跑了多少条断言"） */
export function m3CheckCount(): number {
  return M3_SUITES.reduce(
    (total, suite) =>
      total + suite.cases.reduce((count, item) => count + item.checks.length, 0),
    0
  )
}
