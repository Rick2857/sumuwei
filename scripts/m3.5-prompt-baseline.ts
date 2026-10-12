/**
 * M3.5 —— Prompt 基线（**FC-T08 的判据来源**）。
 *
 * ============================================================================
 *  为什么 M3.5 需要一个"逐字节"的 Prompt 基线
 * ============================================================================
 * M3.5 在 Character Kernel 的**输入边界**上新增了 Observation 与 Intent
 * （计划书第 18 / 87 / 88 节）：
 *
 *     User Message → ConversationEvent → ConversationObservation
 *                  → Character Kernel → SpeechIntent → Assistant Message
 *
 * 这条改造**唯一**允许的可见结果是：她收到的 prompt 与 M3 完全一致，一个字都不变。
 * 计划书第 92 节把它写成了硬约束：
 *
 *   > 回答风格、人格行为：应该和 M3 完全一致。
 *
 * 但"我改的是边界，不该影响 prompt"这类判断靠人读代码是**不可靠**的 ——
 * 一份格式化、一个 section 顺序变动、一次 renderer 复制，都会静悄悄改掉她看到的东西。
 * 因此这里把 M3 结束时的 prompt **原样固化**下来，改完 M3.5 再逐字节比一次：
 *
 *     scripts/snapshot-m3.5-prompt-baseline.ts   ← 先跑（M3 未改动时）写 fixture
 *     scripts/future-compat-tests.ts (FC-T08)     ← 每次 CI 比对
 *
 * ---------------------------------------------------------------------------
 *  为什么它是**纯**的（不连库、不调模型、不读时间）
 * ---------------------------------------------------------------------------
 * 判据必须永远可复现，否则它会在某天因为"库里有新事件""状态变了"而变成假信号
 * —— 而假信号比没有信号更糟（M3 的人格评测已经吃过这个教训）。因此：
 *
 *   · definition  —— 由**代码里的 Seed** 投影，不读数据库
 *   · identity    —— 快照由 definition 直接构造，不读数据库
 *   · recentLines —— 固定的两条合成对话，不读事实账本
 *   · stateSection—— 不注入（状态渲染依赖真实库；它不属于 Prompt 结构本身）
 *   · now         —— 固定常量
 *
 * 于是 `buildBaselinePrompt()` 的输出只由**代码**决定：Seed 改一个字节、
 * section 顺序变一步、renderer 措辞动一处，基线立刻不匹配。
 *
 * ⚠️ 它守的是 **Prompt 结构**（section 顺序 / 措辞 / 拼装），不守
 * "真实一轮里最近对话取了几条"（那需要库，由 `eval:scenarios` SC-006 守）。
 */

import { buildContextCompilerV2, composePromptFromPacket, type ConversationLine } from '../src/kernel/context/sections.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { hashSeed } from '../src/infrastructure/persistence/seed-hash.ts'
import { character } from '../src/character/index.ts'
import type { ContextPacket, IdentitySnapshot } from '../src/kernel/contracts/index.ts'
import { asConversationEventId } from '../src/kernel/contracts/index.ts'

// ---------------------------------------------------------------------------
// 固定输入（改动这些常量 = 改动基线，必须显式说明理由）
// ---------------------------------------------------------------------------

/** 固定"当前时间"：编译器不应读时钟，这里把它钉死 */
export const BASELINE_NOW = 1_760_000_000_000

/** 固定的本轮输入 */
export const BASELINE_CURRENT_INPUT = '你还记得我们第一次见面吗？'

/**
 * 固定的两条"最近对话"。
 *
 * 刻意同时包含 user 与 character 两条，因为它们的**渲染标签**不同
 * （`USER` / 角色名大写），是 prompt 结构里最容易在重构中被改掉的一处。
 */
export const BASELINE_RECENT_LINES: readonly ConversationLine[] = [
  {
    id: asConversationEventId('cev:baseline:dm-baseline:1'),
    sequence: 1,
    speaker: 'Alex',
    text: '今天降温了。',
    actorType: 'user',
    sourceKind: 'user_statement',
  },
  {
    id: asConversationEventId('cev:baseline:dm-baseline:2'),
    sequence: 2,
    speaker: '苏沐薇',
    text: '嗯，你出门记得加件外套。',
    actorType: 'character',
    sourceKind: 'character_output',
  },
]

// ---------------------------------------------------------------------------
// 夹具位置
// ---------------------------------------------------------------------------

export const BASELINE_FIXTURE_DIR = 'evals/fixtures/m3.5'
export const BASELINE_PROMPT_FILE = 'prompt-baseline.txt'
export const BASELINE_META_FILE = 'prompt-baseline.meta.json'

// ---------------------------------------------------------------------------
// 构造
// ---------------------------------------------------------------------------

export interface BaselineResult {
  /** 交给模型的**完整** prompt（逐字节比对的判据） */
  prompt: string
  packet: ContextPacket
  /** 与 prompt 一起固化的结构性事实（section 列表 / 编译器版本 / 指纹） */
  meta: {
    compilerVersion: string
    contextSectionIds: string[]
    droppedSectionIds: string[]
    seedVersion: number
    seedHash: string
    seedSlug: string
    estimatedTokens: number
    now: number
  }
}

/** 构造身份快照（纯：由代码里的 Seed 投影而来，不读库） */
export function baselineIdentity(): IdentitySnapshot {
  const definition = characterDefinitionFromCharacter(character as never, { now: 0 })
  return {
    characterId: definition.id,
    seedVersion: definition.seedVersion,
    definition,
    snapshotHash: hashSeed(definition),
    capturedAt: 0,
  }
}

/**
 * 生成基线 prompt。
 *
 * 走的是**与主链路同一个** `buildContextCompilerV2` + `composePromptFromPacket`
 * —— 这里不允许有第二套装配，否则基线守的是另一个东西。
 */
export async function buildBaselinePrompt(): Promise<BaselineResult> {
  const identity = baselineIdentity()
  const compiler = buildContextCompilerV2({
    identity,
    definition: identity.definition,
    recentLimit: 16,
  })

  const packet = await compiler.compile({
    characterId: identity.characterId,
    currentInput: BASELINE_CURRENT_INPUT,
    recentEvents: BASELINE_RECENT_LINES,
    now: BASELINE_NOW,
  })

  return {
    prompt: composePromptFromPacket(packet, identity.definition.name),
    packet,
    meta: {
      compilerVersion: packet.compilerVersion,
      contextSectionIds: packet.sections.map((s) => s.id),
      droppedSectionIds: packet.droppedSectionIds,
      seedVersion: identity.seedVersion,
      seedHash: identity.snapshotHash,
      seedSlug: identity.definition.slug,
      estimatedTokens: packet.estimatedTokens,
      now: BASELINE_NOW,
    },
  }
}
