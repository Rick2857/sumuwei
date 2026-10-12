/**
 * 身份完整性测试 —— M3 的 Identity 部分（WP2 + WP3 的守门人）。
 *
 * ============================================================================
 *  计划书第 98–120 节：T1 / T3 / T9 / T14 / T15
 * ============================================================================
 * 这些测试**不碰数据库、不碰 ElizaOS、不调模型**，全部 deterministic、毫秒级。
 * 它们保护的是"她是谁"这件事里最容易悄悄退化、又最难在运行期发现的部分：
 *
 *   · CharacterDefinition v2 的结构约束（反例必须存在、强度必须合法）
 *   · 指纹只由**内容**决定（时间戳、provenance 不进指纹）
 *   · 渲染是确定性的，且**从规范化结果出发**（曾经在这里踩过坑）
 *   · Seed 的修改必须留下 author/reason（否则分不清成长与改设定）
 *   · IdentitySnapshot 自洽（版本、角色、指纹三者不能互相矛盾）
 *
 * 跑法：
 *   node_modules/.bin/tsx scripts/kernel-tests.ts 身份
 */

import {
  CHARACTER_DEFINITION_SCHEMA_VERSION,
  KernelError,
  assertSnapshotCoherent,
  canonicalSeedJson,
  canonicalizeSeed,
  parseSeedSourceRef,
  renderSeedIdentity,
  seedFingerprint,
  seedSourceRef,
  type CharacterDefinition,
  type IdentitySnapshot,
  asCharacterId,
} from '../src/kernel/contracts/index.ts'
import {
  CHARACTER_SLUG,
  CHARACTER_UUID,
  SEED_VERSION,
  SEED_CHANGE_PROTOCOL,
  buildCharacterDefinition,
  type SeedProjectionInput,
} from '../src/kernel/identity/seed.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { hashSeed, shortHash } from '../src/infrastructure/persistence/seed-hash.ts'
import { character } from '../src/character/index.ts'

import { expect, group, printSummary, runAll, test } from './kernel-test-kit.ts'

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

/** 一份最小的合法 Seed 输入（不依赖真实角色，便于逐字段验证） */
const minimalInput: SeedProjectionInput = {
  id: 'char_test',
  name: '测试角色',
  identityLines: ['第一行身份。', '第二行身份。'],
  traits: [
    // 刻意用**未登记**的倾向名：这样测试断言的是"结构化条目原样保留"，
    // 而不是"KNOWN_TRAITS 表里有谨慎这一条"（后者是内容，不是契约）
    {
      trait: '谨慎',
      strength: 0.75,
      description: '对没有证据的信息不会轻易完全相信。',
      behavioralExamples: ['会询问更多背景'],
      counterExamples: ['不意味着冷漠'],
    },
  ],
  styleLines: ['说话平，短句为主。'],
  values: [
    {
      value: '诚实',
      priority: 0.8,
      description: '不说假话。',
      tradeoffNotes: ['不意味着每个念头都要马上说出来'],
    },
  ],
  boundaries: ['不凭空声称经历过没有发生的现实事件。'],
  preferences: [{ topic: '旧事', stance: '愿意聊', strength: 0.7 }],
}

const buildMinimal = (overrides: Partial<SeedProjectionInput> = {}, now = 0) =>
  buildCharacterDefinition({ ...minimalInput, ...overrides }, { now })

// ===========================================================================
group('身份完整性 :: Seed Schema')
// ===========================================================================

test('结构化 Seed 的字段划分正确（identity / personality / values / style / boundaries）', () => {
  const def = buildMinimal()

  expect.equal(def.schemaVersion, CHARACTER_DEFINITION_SCHEMA_VERSION)
  expect.equal(def.seedVersion, SEED_VERSION)
  expect.includes(def.identity.selfDescription, '第一行身份')
  expect.equal(def.personality.traits[0].trait, '谨慎', '输入里的倾向必须被保留（顺序在前）')
  expect.equal(def.values.length, 1, '显式提供的价值必须原样使用（不叠加内置表）')
  expect.atLeast(def.boundaries.length, 1)
  expect.ok(def.initialPreferences !== undefined, '初始偏好应当被保留')
})

test('核心身份倾向无条件进 Seed（v3 修正的缺陷必须有测试守着）', () => {
  // v2 的缺陷：`bio` 里那两句最定义性的设定不在 `adjectives` 里，
  // 于是它们从来没有被放进 CharacterDefinition，渲染出来的身份文本里也就没有它们。
  // 这条断言保证它不会**再次**静默消失。
  const def = buildCharacterDefinition(
    {
      ...minimalInput,
      // 刻意**不**在输入里提这三条，模拟"它们只出现在 bio 里"的真实情形
      traits: ['外冷内热'],
    },
    { now: 0 }
  )
  const names = def.personality.traits.map((t) => t.trait)
  for (const core of ['对陌生人警惕', '对用户毫无防备', '受不了长时间分开']) {
    expect.ok(names.includes(core), `核心倾向「${core}」必须无条件出现在 Seed 里`)
  }

  // 而且它们必须真的进**渲染文本** —— 这才是模型看到的东西
  const text = renderSeedIdentity(def)
  expect.includes(text, '对陌生人警惕')
  expect.includes(text, '毫无防备')
})

test('核心倾向的补充是确定性的（渲染不会因补齐而波动）', () => {
  const a = buildCharacterDefinition({ ...minimalInput, traits: ['外冷内热'] }, { now: 0 })
  const b = buildCharacterDefinition({ ...minimalInput, traits: ['外冷内热'] }, { now: 99 })
  expect.equal(renderSeedIdentity(a), renderSeedIdentity(b))
  expect.equal(hashSeed(a), hashSeed(b))
})

test('每条人格倾向都带反例（防角色漫画化的机制要求）', () => {
  const def = buildMinimal()
  for (const trait of def.personality.traits) {
    expect.atLeast(
      trait.counterExamples.length,
      1,
      `倾向「${trait.trait}」没有反例：只有"她很谨慎"会让模型夸张成"永远怀疑所有人"`
    )
  }
})

test('未展开的倾向被保留原词，而不是套一段通用模板', () => {
  // 未登记的形容词（既不在 KNOWN_TRAITS 里）必须原样保留 ——
  // 编造一段描述比留空更危险：模型会把它当成真的人设来演。
  const def = buildMinimal({ traits: ['某种没登记过的倾向'] })
  expect.equal(def.personality.traits[0].trait, '某种没登记过的倾向')
  expect.includes(def.personality.traits[0].description, '未被展开')
})

test('Agent 名下的 Seed 含全部已知价值与边界（且边界去重）', () => {
  const def = buildMinimal({ boundaries: ['不凭空声称经历过没有发生的现实事件。'] })
  // 传入的边界与内置边界重复时必须去重，而不是出现两次
  const occurrences = def.boundaries.filter((b) => b === '不凭空声称经历过没有发生的现实事件。')
  expect.equal(occurrences.length, 1, '重复的边界条款必须被去重')
  expect.atLeast(def.boundaries.length, 2, '内置边界（身份/事实/推测）必须存在')
})

// ===========================================================================
group('身份完整性 :: 指纹与渲染')
// ===========================================================================

test('指纹只由内容决定：时间戳变化不改变指纹', () => {
  const early = buildMinimal({}, 0)
  const late = buildMinimal({}, 1_700_000_000_000)
  expect.equal(
    seedFingerprint(early),
    seedFingerprint(late),
    '改一个时间戳不该让人格指纹变化（否则每次启动都会误报"人设被改了"）'
  )
  expect.equal(hashSeed(early), hashSeed(late))
})

test('provenance（谁改的、为什么）不进指纹', () => {
  const withoutProvenance = buildCharacterDefinition(minimalInput, { now: 0 })
  const withProvenance = buildCharacterDefinition(minimalInput, {
    now: 0,
    provenance: { author: '张三', reason: '调了一下语气', effectiveAt: 123 },
  })
  expect.equal(
    seedFingerprint(withoutProvenance),
    seedFingerprint(withProvenance),
    'provenance 是修改的元信息，不是人格内容 —— 它进指纹会让"谁改的"变成一次人格变化'
  )
})

test('内容变化一定改变指纹（这是"检测偷改"能成立的前提）', () => {
  const base = buildMinimal()
  const changed = buildMinimal({ identityLines: ['第一行身份。', '第二行身份被改了。'] })
  expect.notOk(
    seedFingerprint(base) === seedFingerprint(changed),
    '内容变了指纹必须变，否则"库被绕过写入闸改过"检测不出来'
  )
  expect.notOk(hashSeed(base) === hashSeed(changed))
})

test('数组顺序不影响指纹（人对同一条人格的书写顺序不该改变她的指纹）', () => {
  const a = buildMinimal({ traits: ['外冷内热', '话多'] })
  const b = buildMinimal({ traits: ['话多', '外冷内热'] })
  expect.equal(
    seedFingerprint(a),
    seedFingerprint(b),
    '结构化条目在规范化时按名字排序，因此书写顺序不该影响指纹'
  )
})

test('渲染是确定性的，且**与指纹用同一个顺序定义**', () => {
  // 这是 M3 实施中抓到的真实缺陷：
  //   canonicalizeSeed 会按名字排序 traits，而渲染曾经直接用原始顺序，
  //   于是"从库读回来的那一份"与"代码里那份"渲染出不同文本 ——
  //   指纹相同、内容相同、显示却不同，SC-001 会误报"有人偷偷改了人设"。
  const a = buildMinimal({ traits: ['外冷内热', '话多'] })
  const b = buildMinimal({ traits: ['话多', '外冷内热'] })
  expect.equal(
    renderSeedIdentity(a),
    renderSeedIdentity(b),
    '渲染必须从 canonicalizeSeed 出发：否则指纹与文本会分叉'
  )
  expect.equal(renderSeedIdentity(a), renderSeedIdentity(a), '渲染必须是纯函数')
})

test('渲染包含反例与版本号（模型与排查都依赖这两样）', () => {
  const def = buildMinimal()
  const text = renderSeedIdentity(def)
  expect.includes(text, '不意味着', '反例必须进上下文，否则防漫画化的机制等于没有')
  expect.includes(text, `Seed 版本 v${def.seedVersion}`, '版本号必须出现在渲染物里')
  expect.includes(text, '边界', '边界条款必须进上下文')
})

test('规范化的强度被夹到 0..1 且收敛浮点尾差', () => {
  const def = buildMinimal({
    traits: [
      {
        trait: '过强的倾向',
        strength: 3.7,
        description: 'x',
        behavioralExamples: [],
        counterExamples: ['y'],
      },
      {
        trait: '过弱的倾向',
        strength: -2,
        description: 'x',
        behavioralExamples: [],
        counterExamples: ['y'],
      },
    ],
  })
  const canonical = canonicalizeSeed(def)
  for (const trait of canonical.personality.traits) {
    expect.ok(trait.strength >= 0 && trait.strength <= 1, `${trait.trait} 的强度必须落在 0..1`)
  }
})

test('规范化输出是稳定 JSON（键顺序固定，不受书写顺序影响）', () => {
  const def = buildMinimal()
  const once = canonicalSeedJson(def)
  const twice = canonicalSeedJson({ ...def })
  expect.equal(once, twice)
  // 规范化后字段顺序固定：id 一定在 slug 之前
  expect.ok(once.indexOf('"id"') < once.indexOf('"slug"'), '字段顺序必须固定')
})

// ===========================================================================
group('身份完整性 :: Seed 引用与来源')
// ===========================================================================

test('Seed 引用形如 character-definition:<id>@<version>，且可解析回来', () => {
  const ref = seedSourceRef('sumuwei', 3)
  expect.equal(ref, 'character-definition:sumuwei@3')
  const parsed = parseSeedSourceRef(ref)
  expect.ok(parsed !== undefined, '引用必须可解析（Trace 里的字符串要能读回结构）')
  expect.equal(parsed!.seedVersion, 3)
  expect.equal(parsed!.characterId, 'sumuwei')
})

test('无法解析的引用返回 undefined（而不是猜一个版本）', () => {
  expect.equal(parseSeedSourceRef('随便一个字符串'), undefined)
  expect.equal(parseSeedSourceRef('character-definition:sumuwei'), undefined)
})

// ===========================================================================
group('身份完整性 :: IdentitySnapshot')
// ===========================================================================

const snapshotFor = (def: CharacterDefinition): IdentitySnapshot => ({
  characterId: def.id,
  seedVersion: def.seedVersion,
  definition: def,
  snapshotHash: hashSeed(def),
  capturedAt: 0,
})

test('自洽的快照通过校验', () => {
  const snapshot = snapshotFor(buildMinimal())
  assertSnapshotCoherent(snapshot)
  expect.equal(snapshot.snapshotHash, hashSeed(snapshot.definition))
})

test('版本与定义矛盾 → 拒绝（说明有人在不升版本的前提下改了 Seed）', () => {
  const def = buildMinimal()
  const snapshot = { ...snapshotFor(def), seedVersion: def.seedVersion + 5 }
  let error: KernelError | undefined
  try {
    assertSnapshotCoherent(snapshot)
  } catch (e) {
    error = e as KernelError
  }
  expect.ok(error, '自相矛盾的快照必须被拒绝，而不是"取其中一个为准"')
  expect.equal(error!.code, 'identity_snapshot_version_mismatch')
})

test('角色 id 不一致 → 拒绝', () => {
  const def = buildMinimal()
  const snapshot = { ...snapshotFor(def), characterId: asCharacterId('char_other') }
  let error: KernelError | undefined
  try {
    assertSnapshotCoherent(snapshot)
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(error?.code, 'identity_snapshot_character_mismatch')
})

test('缺少指纹 → 拒绝（没有指纹就无法回答"她用哪版人格"）', () => {
  const snapshot = { ...snapshotFor(buildMinimal()), snapshotHash: '  ' }
  let error: KernelError | undefined
  try {
    assertSnapshotCoherent(snapshot)
  } catch (e) {
    error = e as KernelError
  }
  expect.equal(error?.code, 'identity_snapshot_missing_hash')
})

test('短指纹是 12 位前缀（命令行与日志里人类可读）', () => {
  const hash = hashSeed(buildMinimal())
  expect.equal(shortHash(hash).length, 12)
  expect.ok(hash.startsWith(shortHash(hash)), '短指纹必须是完整指纹的前缀')
})

// ===========================================================================
group('身份完整性 :: Seed 修改规程')
// ===========================================================================

test('Seed 修改规程把升版本与写 ADR 写死（半年后没人能靠记忆做对）', () => {
  expect.includes(SEED_CHANGE_PROTOCOL, 'SEED_VERSION')
  expect.includes(SEED_CHANGE_PROTOCOL, 'ADR')
  expect.includes(SEED_CHANGE_PROTOCOL, 'provenance')
})

test('真实角色的 Seed 由代码定义投影而来，且内容是用户口述的那些句子', () => {
  const def = characterDefinitionFromCharacter(character as never, { now: 0 })
  expect.equal(String(def.id), CHARACTER_UUID)
  expect.equal(def.slug, CHARACTER_SLUG)
  expect.equal(def.name, '苏沐薇')

  // bio 的句子必须**原样**出现在身份里（翻译层没有权力润色人设）
  expect.includes(def.identity.selfDescription, '对陌生人警惕、慢热，不会主动搭话，被冒犯时会直接冷下来。')
  expect.includes(def.identity.selfDescription, '唯独对用户毫无防备')

  // 关系的来由被单独放进 roleDescription（"她凭什么信任用户"需要一个来由）
  expect.ok(def.identity.roleDescription !== undefined, '关系的来由必须存在')
  expect.includes(def.identity.roleDescription!, '一起长大')
})

test('少样本示例（messageExamples）**不进入** Seed（Seed 是数据，不是 Prompt）', () => {
  // ⚠️ 这里不能用"示例原话"来断言：`KNOWN_TRAITS` 里的行为例子
  // 本身就是**从设定推导**的（"你怎么才回""那就别说"），
  // 它们属于结构化 Seed，是合法的。要证明的是另一件事：
  // ElizaOS `Character` 的 `messageExamples` 这一段**没有**被投影进 Seed。
  //
  // 因此断言的是"结构上不存在这个字段"，而不是"文本里没有某句话"。
  const def = characterDefinitionFromCharacter(character as never, { now: 0 })
  const keys = Object.keys(def as unknown as Record<string, unknown>)
  expect.notIncludes(keys.join(','), 'messageExamples')
  expect.notIncludes(keys.join(','), 'messageExample')
  expect.notIncludes(JSON.stringify(def), '{{name1}}', '示例里的模板变量不该出现在 Seed 里')
})

test('真实角色的 Seed 每次都得到同一个指纹（重启不改变她是谁）', () => {
  const a = characterDefinitionFromCharacter(character as never, { now: 0 })
  const b = characterDefinitionFromCharacter(character as never, { now: 999_999 })
  expect.equal(hashSeed(a), hashSeed(b))
})

// ---------------------------------------------------------------------------
const summary = await runAll({ filter: process.argv[2] })
printSummary(summary, '身份完整性测试（M3 WP2/WP3）')
process.exit(summary.failed === 0 ? 0 : 1)
