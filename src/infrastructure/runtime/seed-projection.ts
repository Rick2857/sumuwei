/**
 * Seed 投影适配器 —— ElizaOS `Character` → 领域 `SeedProjectionInput`。
 *
 * ============================================================================
 *  依赖方向的跨越点（第二个，第一个是 adapters.ts）
 * ============================================================================
 * 为什么需要这个文件：
 *   角色定义在 M1/M2 里是 ElizaOS 的 `Character` 对象，
 *   而 Character Domain **不许** import `@elizaos/core`
 *   （有 `kernel-tests.ts` 的边界测试盯着）。
 *
 * 所以把"形状翻译"放在这里：领域定义 `SeedProjectionInput`（几个字符串），
 * 适配器负责从框架对象里**原样取出**内容。
 *
 * 重要：这里**不改写人设**。bio 的每一条都原样保留——
 * 那些句子是用户口述、逐条确认过的，翻译层没有权力润色它们。
 *
 * ---------------------------------------------------------------------------
 *  M3：忠于原话的具体落点
 * ---------------------------------------------------------------------------
 * `messageExamples`（少样本示例）在 M3 **不再进入 Seed**。
 *
 * 理由记在这里，避免以后有人"顺手加回来"：
 *   · 它们不是 `CharacterDefinition` 的字段，而 M3 的规矩是
 *     "Seed 是结构化数据，Prompt 里的文本是它的渲染物"；
 *     把示例塞进 Seed 就等于在 Seed 里藏一份 Prompt。
 *   · 而且 `苏沐薇.ts` 的注释已经写明：那两组示例是
 *     "**依据设定推导**出来的，不是用户提供的原话"。
 *     计划书第 13 节要的恰恰是"结构化保存，不写成小说式 Prompt"。
 *
 * 它们仍然留在 `character` 对象里（ElizaOS 的 `CHARACTER` provider 会用，
 * 旧链路 `--dump-prompt --legacy` 也看得到），只是**不属于 Seed**。
 */

import type { Character } from '@elizaos/core'

import {
  buildCharacterDefinition,
  CHARACTER_SLUG,
  CHARACTER_UUID,
  SEED_VERSION,
  type SeedProjectionInput,
} from '../../kernel/identity/seed.ts'
import type { CharacterDefinition } from '../../kernel/contracts/index.ts'

/**
 * 把 ElizaOS Character 投影成领域输入（纯函数，便于测试）。
 *
 * 刻意**不传递** `messageExamples`：见文件头。
 * `bio` 里的"对陌生人警惕"等句子原样进 `identityLines`，
 * 而结构化的倾向条目由 `buildCharacterDefinition` 的已知人格表补齐。
 */
export function seedInputFromCharacter(
  character: Character,
  options: { userName?: string } = {}
): SeedProjectionInput {
  // Character.bio 既允许 string 也允许 string[]：统一成数组，避免下游分叉
  const bio: string[] = typeof character.bio === 'string' ? [character.bio] : (character.bio ?? [])

  // 关系的来由：从 bio 里挑出"关系是怎么来的"那一类句子。
  // 判据是具体的词，不是语义猜测 —— 猜错只会让身份上下文里多一行，
  // 而漏掉会让"她凭什么信任用户"缺一个来由。
  const roleLines = bio.filter(
    (line) => line.includes('一起长大') || line.includes('大学同学') || line.includes('认识的时间')
  )
  const selfLines = bio.filter((line) => !roleLines.includes(line))

  return {
    id: character.id ?? CHARACTER_UUID,
    name: character.name,
    identityLines: selfLines,
    ...(roleLines.length > 0 ? { roleDescription: roleLines.join('\n') } : {}),
    traits: character.adjectives ?? [],
    styleLines: character.style?.all ?? [],
    chatStyleLines: character.style?.chat ?? [],
    topics: character.topics ?? [],
    userAddress: options.userName,
  }
}

/**
 * 一步到位：ElizaOS Character → CharacterDefinition。
 *
 * `now` 与 `seedVersion` 可注入，让"Seed 渲染是否稳定"可以脱离时间测试。
 */
export function characterDefinitionFromCharacter(
  character: Character,
  options: { userName?: string; seedVersion?: number; now?: number } = {}
): CharacterDefinition {
  return buildCharacterDefinition(seedInputFromCharacter(character, options), {
    slug: CHARACTER_SLUG,
    seedVersion: options.seedVersion ?? SEED_VERSION,
    now: options.now ?? Date.now(),
    provenance: {
      author: 'project-lg/kernel',
      reason:
        options.seedVersion === undefined || options.seedVersion === SEED_VERSION
          ? 'M3 WP2：Seed 结构升级为 v2（内容未改写，只是从自由文本变为结构化条目）；' +
            'v3 修正 v2 遗漏的三条核心身份倾向（对陌生人警惕 / 对用户毫无防备 / 受不了长时间分开）'
          : '测试注入的 Seed 版本',
    },
  })
}
