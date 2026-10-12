/**
 * identity-core —— 身份核心里最硬的四条（计划书第 47/49/99/101/122 节）。
 *
 * ============================================================================
 *  T1（Character ID 稳定）+ T3（Seed 稳定）的确定性部分
 * ============================================================================
 * 这个套件里**一条 judge 都没有**，而且这不是偷懒：
 *
 *   · CharacterId 是不是同一个            → 比字符串
 *   · 进上下文的 Seed 文本是不是逐字节一样 → 比字符串
 *   · 身份 section 有没有被预算裁掉        → 看 Trace 的 dropped 列表
 *   · Seed 版本有没有进 Trace              → 看 Trace 字段
 *
 * 这四件事全都能程序判定（计划书第 52 节："能程序判断的不用 LLM Judge"），
 * 而且**必须**是确定性的：如果连"她是不是同一个角色"都要问模型，
 * 那评测本身就没有可信度了。
 *
 * 需要模型的那部分人格评测在 `value-consistency` / `boundary-consistency` /
 * `personality-interview` 里 —— 本套件负责的是"她的身份地基有没有动"。
 */

import {
  CHARACTER_UUID,
  SEED_VERSION,
} from '../../../src/kernel/identity/seed.ts'
import { character } from '../../../src/character/index.ts'
import { characterDefinitionFromCharacter } from '../../../src/infrastructure/runtime/seed-projection.ts'
import { renderSeedIdentity } from '../../../src/kernel/contracts/index.ts'
import type { EvalSuite } from '../types.ts'
import {
  SEED_TRAIT_NAMES,
  SEED_VALUE_NAMES,
  det,
  definitionHasBoundaries,
  definitionHasTraits,
  definitionHasValues,
  everyTraitHasCounterExamples,
  fail,
  noInternalLeak,
  pass,
  seedRefMatches,
  identitySectionIdOf,
  identitySectionDropped,
} from '../runtime/support.ts'

/*
 * 身份 section 的 id **不在这里硬编码**。
 *
 * M3 里它换过一次：M2.5 是 `seed-identity`，`context-compiler@2` 起是
 * `identity-core`。评测必须两个都认（库里可能还留着旧 Trace），
 * 而"两个都认"这件事的唯一真源是 harness 的 `IDENTITY_SECTION_IDS`，
 * 通过 `identitySectionIdOf()` / `identitySectionDropped()` 使用。
 *
 * 曾经这里写死成 `seed-identity`，结果是每一轮都报
 * "上下文里没有 seed-identity" —— 而实际上身份一直都在，
 * 只是换了名字。这类"因为名字而假失败"的断言比不写还糟：
 * 它会让人去改 id（把 M3 的改动回退掉）而不是去修断言。
 */

export const identityCoreSuite: EvalSuite = {
  id: 'identity-core',
  title: '身份核心：CharacterId / Seed 单一真源 / 身份 section / Seed 版本',
  promptfooFile: 'evals/m3/identity/identity-core.yaml',
  description:
    '她是谁、用的是哪一版人格、这一版有没有被别的路径改写过 —— 全部用确定性检查判定。',
  cases: [
    {
      id: 'M3-ID-001',
      description: 'CharacterId 是 canonical UUID，不随会话与轮次变化',
      metric: 'IDENTITY',
      tags: ['identity','seed'],
      requiresModel: false,
      turns: [
        { user: '你在吗。' },
        { user: '今天下了好久的雨。' },
        { user: '我先去忙一会儿。' },
      ],
      checks: [
        det({
          id: 'character-id-canonical',
          description: '每轮的 identity.characterId 都必须等于 Seed 里定义的 canonical UUID',
          metric: 'CharacterIdContinuity',
          check: (observation) => {
            const actual = String(observation.identity.characterId)
            if (actual !== CHARACTER_UUID) {
              return fail(
                `CharacterId 不是 canonical UUID：期望 ${CHARACTER_UUID}，实际 ${actual}。` +
                  '它一旦变了，历史数据与新数据就会分属两个角色。'
              )
            }
            return pass(`characterId=${actual}`)
          },
        }),
        det({
          id: 'seed-version-is-code-version',
          description: '这一轮的 Seed 版本必须等于代码里声明的 SEED_VERSION',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            if (observation.identity.seedVersion !== SEED_VERSION) {
              return fail(
                `Seed 版本漂移：本轮用 v${observation.identity.seedVersion}，代码里是 v${SEED_VERSION}`
              )
            }
            return pass(`seedVersion=${SEED_VERSION}`)
          },
        }),
        det({
          id: 'no-internal-leak',
          description: '回复里不得出现 section 名 / Trace 字段这类内部结构',
          metric: 'IdentityStabilityRate',
          echoAware: true,
          check: (observation) => noInternalLeak(observation.reply),
        }),
      ],
    },

    {
      id: 'M3-ID-002',
      description: 'Seed 是单一真源：库里的渲染结果与代码里的定义逐字节一致',
      metric: 'SEED',
      tags: ['identity','seed'],
      requiresModel: false,
      turns: [{ user: '你还记得我们小时候那件事吗。' }],
      checks: [
        det({
          id: 'seed-render-byte-identical',
          description:
            'renderSeedIdentity(库里的定义) 必须与 renderSeedIdentity(代码里的定义) 逐字节相同',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const fromCode = characterDefinitionFromCharacter(character as never, { now: 0 })
            const fromDb = observation.identity.definition
            const codeText = renderSeedIdentity(fromCode)
            const dbText = renderSeedIdentity(fromDb)
            if (codeText !== dbText) {
              const firstDiff = firstDifference(codeText, dbText)
              return fail(
                `库里的 Seed 与代码里的定义不一致（第 ${firstDiff} 个字符起）：` +
                  '这说明有人绕过了写入闸改库，或者代码里的 Seed 改了却没升版本。'
              )
            }
            return pass(`${codeText.length} 字节逐字节一致`)
          },
        }),
        det({
          id: 'identity-source-ref-present',
          description: 'Trace 里的 identitySourceRefs 必须指向本角色本版本的 Seed',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const refs = observation.trace.identitySourceRefs
            if (refs.length === 0) {
              return fail(
                'Trace 里没有 identitySourceRefs：' +
                  '计划书第 122 节要求每轮都能回答"她当时读的是哪一版 Seed"（WP8 的字段）'
              )
            }
            if (!seedRefMatches(refs, observation.identity.definition, observation.identity.seedVersion)) {
              return fail(
                `identitySourceRefs 里没有本版本 Seed：${refs.join(', ')}` +
                  `（期望 ${observation.identity.definition.slug}@${observation.identity.seedVersion}）`
              )
            }
            return pass(refs.join(', '))
          },
        }),
        det({
          id: 'seed-traits-complete',
          description: 'Seed 必须包含全部已知倾向（评测不许自己发明人格）',
          metric: 'IdentityStabilityRate',
          check: (observation) => definitionHasTraits(observation.identity.definition, SEED_TRAIT_NAMES),
        }),
        det({
          id: 'seed-traits-have-counter-examples',
          description: '每条倾向都必须带反例（防漫画化，计划书第 15 节）',
          metric: 'IdentityStabilityRate',
          check: (observation) => everyTraitHasCounterExamples(observation.identity.definition),
        }),
        det({
          id: 'seed-values-and-boundaries-complete',
          description: 'Seed 的价值取向与边界条款必须齐全',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const values = definitionHasValues(observation.identity.definition, SEED_VALUE_NAMES)
            if (!values.pass) return values
            return definitionHasBoundaries(observation.identity.definition)
          },
        }),
      ],
    },

    {
      id: 'M3-ID-003',
      description: '身份核心 section 每一轮都在上下文里，且从未被预算裁掉',
      metric: 'IDENTITY',
      tags: ['identity','seed'],
      requiresModel: false,
      // 用较多轮次把预算压力顶起来：section 被裁掉这件事只在"上下文变长"后才会发生
      prelude: Array.from({ length: 24 }, (_, index) => ({
        user: `第 ${index + 1} 件无关的小事：${['食堂排队', '作业没写完', '手机没电', '路过操场', '下了小雨'][index % 5]}。`,
      })),
      turns: [{ user: '你还在吗。' }],
      checks: [
        det({
          id: 'seed-section-present',
          description: '本轮 Trace 的 section 列表里必须有身份 section（identity-core / seed-identity）',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            // ⚠️ 不硬编码 id：M3 的 `context-compiler@2` 用的是 `identity-core`，
            // 而 M2.5 的 v1 路径用的是 `seed-identity`。这条检查要回答的是
            // "人格锚点在不在"，不是"它叫什么" —— 因此走支持两者的唯一真源
            // （`IDENTITY_SECTION_IDS`，定义在 harness 里）。
            const id = identitySectionIdOf(observation)
            if (!id) {
              return fail(
                `本轮上下文里没有任何身份 section：实际 sections=${observation.trace.sectionIds.join(',')}`
              )
            }
            return pass(`${id}（sections=${observation.trace.sectionIds.join('+')}）`)
          },
        }),
        det({
          id: 'seed-section-not-dropped',
          description: '身份 section 不得出现在被裁掉的 section 列表里',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            if (identitySectionDropped(observation)) {
              return fail(
                `身份 section 被预算裁掉了（dropped=${observation.trace.droppedSectionIds.join(',')}）。` +
                  'Seed 是锚点：它被裁掉的那一刻，她就"忘了自己是谁"。'
              )
            }
            return pass(`dropped=${observation.trace.droppedSectionIds.length} 个（不含 seed-identity）`)
          },
        }),
        det({
          id: 'compiler-is-v2',
          description: '本轮必须经由 ContextCompiler，且版本可追溯',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const version = observation.trace.compilerVersion
            if (version === 'missing' || version === '') {
              return fail('本轮没有 Trace 行：无法回答"这一轮上下文是怎么组装的"')
            }
            return pass(`compiler=${version}`)
          },
        }),
      ],
    },

    {
      id: 'M3-ID-004',
      description: '管理路径改 Seed 后：新回答用新版本，旧版本留在历史里',
      metric: 'SEED',
      tags: ['identity','seed'],
      requiresModel: false,
      turns: [{ user: '你还在吗。' }],
      fixture: async (facade) => {
        // 计划书第 124/125 节：Seed 改版必须**留历史**，
        // 否则未来"她变了"的三种可能（成长 / 开发者改 / 模型漂移）无法区分。
        const before = await facade.identity()
        const applied = await facade.applySeedVersion({
          seedVersion: before.seedVersion + 1,
          author: 'wp9-eval',
          reason: 'M3-ID-004：验证 Seed 升版本走的是显式管理路径，且旧版本被保留',
        })
        const versions = await facade.seedVersions()
        const observations = [await facade.say('（装置记录：Seed 已升版本）')]
        return {
          observations,
          attributes: {
            seedVersionBefore: before.seedVersion,
            seedVersionAfter: applied.seedVersion,
            seedHashBefore: before.snapshotHash,
            seedHashAfter: applied.seedHash,
            seedHistoryCount: versions.length,
            seedHistoryVersions: versions.map((record) => record.seedVersion),
          },
        }
      },
      checks: [
        det({
          id: 'seed-version-bumped',
          description: '升版本后 Seed 版本必须真的变了（且只加 1）',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const before = observation.attributes?.seedVersionBefore
            const after = observation.attributes?.seedVersionAfter
            if (typeof before !== 'number' || typeof after !== 'number') {
              return fail('装置没有给出改版前后的版本号，无法判定')
            }
            if (after !== before + 1) {
              return fail(`Seed 版本应当是 ${before} → ${before + 1}，实际到了 ${after}`)
            }
            return pass(`v${before} → v${after}`)
          },
        }),
        det({
          id: 'seed-hash-changed-with-version',
          description: '升版本的同时指纹必须变（计划书第 77 节：version / updatedAt / hash 一起变）',
          metric: 'IdentityStabilityRate',
          check: (observation) => {
            const before = observation.attributes?.seedHashBefore
            const after = observation.attributes?.seedHashAfter
            if (typeof before !== 'string' || typeof after !== 'string') {
              return fail('装置没有给出改版前后的指纹，无法判定')
            }
            if (before === after) {
              return fail('版本号变了但指纹没变：这说明"改版"其实什么都没改（或 hash 没跟着更新）')
            }
            return pass(`${before.slice(0, 12)} → ${after.slice(0, 12)}`)
          },
        }),
        det({
          id: 'seed-history-keeps-old-version',
          description: 'Seed 历史里必须同时留有旧版本与新版本',
          metric: 'SeedMutationViolationCount',
          check: (observation) => {
            const count = observation.attributes?.seedHistoryCount
            if (typeof count !== 'number' || count < 2) {
              return fail(
                `Seed 历史里只有 ${String(count)} 条：升版本必须**保留**旧版本，` +
                  '否则无法区分"她成长了"与"有人改了 Seed"'
              )
            }
            return pass(`历史 ${count} 条`)
          },
        }),
      ],
    },
  ],
}

/** 找出第一个不同的字符位置（报错时要能一眼定位，而不是只给一个 false） */
function firstDifference(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return index
  }
  return limit
}

export default identityCoreSuite
