/**
 * CharacterDefinition v2 —— **结构化 Seed Identity**。
 *
 * ============================================================================
 *  M3 第 12–19 节：Seed 不是一个名字，也不是一篇小说
 * ============================================================================
 * M2.5 的 Seed 是四段自由文本（identity / personalityBaseline /
 * communicationStyle / seedExtras）。它能跑，但回答不了 M3 必须回答的问题：
 *
 *   · "她有多谨慎？"            → 一段散文里没有强度，只有形容词
 *   · "她的谨慎**不**意味着什么？" → 没有反例，模型就会把她演成漫画
 *   · "这次到底改了哪一条？"      → 改一个词与重写整篇在数据上无法区分
 *   · "这条 Seed 的指纹是什么？"   → 没有规范化表示，就没有可信的 hash
 *
 * 因此 M3 把 Seed 升级为**结构化**表示（计划书第 12 节），并保留两条铁律：
 *
 *   1. **Seed 不是 Memory**：它独立存储、有版本、有固定 Context 位置，
 *      且**没有任何自动流程能改写它**（普通聊天路径拿不到写入口，见 seed-authority）。
 *   2. **Seed 不是 Prompt**：它是数据。Prompt 里的那一段文本是
 *      `renderSeedIdentity()` 的**输出**，不是真源（计划书第 128 节）。
 *
 * ---------------------------------------------------------------------------
 *  为什么每条 trait / value 都必须带"它不意味着什么"
 * ---------------------------------------------------------------------------
 * 计划书第 15 节说得最清楚：只写"苏沐薇谨慎"，模型会夸张成
 * "永远怀疑所有人"。加入 `counterExamples`（what it does NOT mean）
 * 是**显著减轻角色漫画化**的最便宜手段，必须在 schema 层面强制存在，
 * 而不是靠写人设的人自觉。
 */

import type { CharacterId, SchemaVersion, Timestamp } from './ids.ts'

// ---------------------------------------------------------------------------
// 结构
// ---------------------------------------------------------------------------

/**
 * 一条人格倾向。
 *
 * `strength` 是 0..1 的**相对强度**，不是心理学量表：
 * 它只用来表达"这一条比另一条更主导"，以及给评测一个可比较的锚点。
 * 因此刻意不做几十个维度（计划书第 14 节）。
 */
export interface PersonalityTrait {
  /** 倾向名（如「谨慎」「心软」）。同一份 Seed 内不得重复。 */
  trait: string
  /** 0..1。0 = 几乎不表现，1 = 压倒性地主导她的行为 */
  strength: number
  /** 这个倾向具体是什么样子（一句人能读懂的话） */
  description: string
  /** 行为层面的**可观察**例子：她实际会怎么做 */
  behavioralExamples: string[]
  /**
   * **反例：这条倾向不意味着什么。**
   *
   * 不是可选装饰，而是防漫画化的机制（计划书第 15 节）。
   * 至少一条，且必须是"反面澄清"而不是"另一条倾向"。
   */
  counterExamples: string[]
}

/**
 * 一条稳定的行为倾向（比 trait 更接近"习惯性做法"）。
 *
 * M2.5 的 `adjectives` 落在 trait；`topics` / 说话习惯落在 tendency。
 */
export interface BehavioralTendency {
  tendency: string
  description: string
  examples?: string[]
}

/**
 * 一条价值。
 *
 * 计划书第 16 节：**价值不等于硬规则**。「诚实」priority 高，
 * 但不意味着"每个秘密都必须马上说出来"——所以 `tradeoffNotes` 必需。
 */
export interface ValueDefinition {
  value: string
  /** 0..1 的相对优先级（用于价值冲突时判断她更可能偏向哪边） */
  priority: number
  description: string
  /** 这条价值与别的价值冲突时，她通常怎么权衡（至少一条） */
  tradeoffNotes: string[]
}

/** 语言风格。tone / habits / avoidances 都是**具体的**短句，不是抽象评价。 */
export interface CommunicationStyle {
  /** 语气（如「平静」「略带调侃」） */
  tone: string[]
  /** 话多话少（如「短句为主，很少长篇」） */
  verbosity?: string
  /** 常用词 / 称呼方式 */
  vocabulary?: string[]
  /** 语言习惯（如「常先反问一句再回答」） */
  habits?: string[]
  /** 明确不做的表达（如「不用网络流行语」） */
  avoidances?: string[]
}

/**
 * 初始偏好。
 *
 * ⚠️ 这是 **Seed 的一部分**（她出生就带着的偏好），不是从对话里学到的记忆。
 * M3 只负责把它渲染进身份上下文；M4 起才区分"Seed 里的偏好"与
 * "从真实互动中确证的用户偏好"。
 */
export interface PreferenceSeed {
  topic: string
  stance: string
  /** 这条偏好有多确定（同样只用于相对比较） */
  strength?: number
}

/**
 * Seed 修改的元信息。
 *
 * 计划书第 18/77 节：**任何** Seed 改动都必须同时改变 version / updatedAt / hash，
 * 否则拒绝启动或报警。这里把"谁改的、为什么"固化成字段，而不是留在 commit message 里。
 */
export interface SeedProvenance {
  /** 修改者（人名 / 角色名 / `system`），用于回答"谁改了她" */
  author: string
  /** 修改原因（人类可读，一句话） */
  reason: string
  /** 该版本的生效时间 */
  effectiveAt: Timestamp
}

/**
 * CharacterDefinition v2。
 *
 * 字段划分的唯一依据是："**这句话回答的是哪个问题**"：
 *   identity            —— 她是谁、和用户是什么关系、这份关系怎么来的
 *   personality         —— 她稳定的性情倾向（强度 + 行为 + 反例）
 *   values              —— 她在价值冲突时偏向什么
 *   communicationStyle  —— 她怎么说话
 *   boundaries          —— 不因普通聊天改变的约束
 *   initialPreferences  —— 她出生就带的偏好
 */
export interface CharacterDefinition {
  /** 稳定角色 id，不依赖 Session / 模型 / 用户 / Runtime / 行号 */
  id: CharacterId

  /** 人类可读短名，用于 ID 前缀与日志（如 `sumuwei`） */
  slug: string

  /** 显示名（如 `苏沐薇`） */
  name: string

  /**
   * Seed 版本号。任何对 Seed 内容的修改都必须 +1，
   * 否则"她什么时候变的、为什么变"就丢了（seed-authority 会直接拒写）。
   */
  seedVersion: number

  /** 身份：她是谁（背景、关系来由、对世界的默认姿态） */
  identity: {
    /** 她的自我描述（第一人称或第三人称均可，原样进上下文） */
    selfDescription: string
    /** 她在关系里的位置（可选；如「和你从小一起长大」） */
    roleDescription?: string
  }

  /** 人格：倾向 + 习惯性做法 */
  personality: {
    traits: PersonalityTrait[]
    tendencies: BehavioralTendency[]
  }

  values: ValueDefinition[]

  communicationStyle: CommunicationStyle

  /**
   * 边界：**真正不应该因为普通聊天改变的约束**。
   *
   * 计划书第 17 节：它同时服务两件事——人格稳定与事实完整性。
   * 例如「不能凭空声称经历过没有发生的现实事件」既防漂移，也防自我虚构。
   */
  boundaries: string[]

  initialPreferences?: PreferenceSeed[]

  /** 该 Seed 定义的 schema 版本（结构变化时 +1，与 seedVersion 独立） */
  schemaVersion: SchemaVersion

  /** 本版本的修改者与原因（计划书第 124/125 节：Seed 也要有历史） */
  provenance?: SeedProvenance

  createdAt: Timestamp
  updatedAt: Timestamp
}

/** 结构化 Seed 的结构版本。结构变了（加字段/改语义）就 +1。 */
export const CHARACTER_DEFINITION_SCHEMA_VERSION = 2

// ---------------------------------------------------------------------------
// 规范化（canonical form）—— hash 与比较的唯一基础
// ---------------------------------------------------------------------------

/**
 * 规范化 Seed：**只保留契约内字段**，并按固定顺序输出。
 *
 * 这一步存在的唯一理由是让 `seedHash` 有意义：
 * 如果 hash 依赖字段顺序、依赖 "undefined" 与 "缺失" 的区别、
 * 依赖数组里空格的数量，那么"配置文件被偷偷改了但版本没更新"
 * 这件事既检测不出来，也会产生大量假警报。
 *
 * 因此规范化的规则是**写死的、可读的**：
 *   · 字符串 trim；数组逐项 trim 后丢弃空项；空数组 → 缺失
 *   · strength / priority 夹到 0..1 并保留 6 位小数（消灭浮点尾差）
 *   · 对象键顺序固定（不依赖 JSON.stringify 的插入顺序）
 *   · 时间戳与 provenance **不进 hash**（改一个时间不该让人格指纹变化）
 */
export interface CanonicalSeed {
  id: string
  slug: string
  name: string
  seedVersion: number
  schemaVersion: number
  identity: { selfDescription: string; roleDescription?: string }
  personality: {
    traits: {
      trait: string
      strength: number
      description: string
      behavioralExamples: string[]
      counterExamples: string[]
    }[]
    tendencies: { tendency: string; description: string; examples?: string[] }[]
  }
  values: { value: string; priority: number; description: string; tradeoffNotes: string[] }[]
  communicationStyle: {
    tone: string[]
    verbosity?: string
    vocabulary?: string[]
    habits?: string[]
    avoidances?: string[]
  }
  boundaries: string[]
  initialPreferences?: { topic: string; stance: string; strength?: number }[]
}

const cleanString = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

const cleanList = (values: readonly string[] | undefined): string[] | undefined => {
  if (!values || values.length === 0) return undefined
  const cleaned = values.map((v) => v.trim()).filter((v) => v !== '')
  return cleaned.length === 0 ? undefined : cleaned
}

/** 夹到 0..1 并收敛浮点尾差，避免 `0.1+0.2` 这类噪声进 hash */
const cleanUnit = (value: number | undefined, fallback = 0): number => {
  if (value === undefined || !Number.isFinite(value)) return fallback
  const clamped = Math.min(1, Math.max(0, value))
  return Number(clamped.toFixed(6))
}

/** 缺省值：把 undefined 的必需字符串收敛成空串（而不是让 hash 依赖 undefined） */
const required = (value: string | undefined): string => cleanString(value) ?? ''

export function canonicalizeSeed(def: CharacterDefinition): CanonicalSeed {
  const canonical: CanonicalSeed = {
    id: String(def.id),
    slug: required(def.slug),
    name: required(def.name),
    seedVersion: def.seedVersion,
    schemaVersion: def.schemaVersion,
    identity: {
      selfDescription: required(def.identity?.selfDescription),
      ...(cleanString(def.identity?.roleDescription)
        ? { roleDescription: cleanString(def.identity?.roleDescription)! }
        : {}),
    },
    personality: {
      traits: [...(def.personality?.traits ?? [])]
        .map((t) => ({
          trait: required(t.trait),
          strength: cleanUnit(t.strength),
          description: required(t.description),
          behavioralExamples: cleanList(t.behavioralExamples) ?? [],
          counterExamples: cleanList(t.counterExamples) ?? [],
        }))
        // 顺序不该影响指纹：先按 trait 名排序，再比较
        .sort((a, b) => (a.trait < b.trait ? -1 : a.trait > b.trait ? 1 : 0)),
      tendencies: [...(def.personality?.tendencies ?? [])]
        .map((t) => ({
          tendency: required(t.tendency),
          description: required(t.description),
          ...(cleanList(t.examples) ? { examples: cleanList(t.examples)! } : {}),
        }))
        .sort((a, b) => (a.tendency < b.tendency ? -1 : a.tendency > b.tendency ? 1 : 0)),
    },
    values: [...(def.values ?? [])]
      .map((v) => ({
        value: required(v.value),
        priority: cleanUnit(v.priority),
        description: required(v.description),
        tradeoffNotes: cleanList(v.tradeoffNotes) ?? [],
      }))
      .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0)),
    communicationStyle: {
      tone: cleanList(def.communicationStyle?.tone) ?? [],
      ...(cleanString(def.communicationStyle?.verbosity)
        ? { verbosity: cleanString(def.communicationStyle?.verbosity)! }
        : {}),
      ...(cleanList(def.communicationStyle?.vocabulary)
        ? { vocabulary: cleanList(def.communicationStyle?.vocabulary)! }
        : {}),
      ...(cleanList(def.communicationStyle?.habits)
        ? { habits: cleanList(def.communicationStyle?.habits)! }
        : {}),
      ...(cleanList(def.communicationStyle?.avoidances)
        ? { avoidances: cleanList(def.communicationStyle?.avoidances)! }
        : {}),
    },
    boundaries: cleanList(def.boundaries) ?? [],
  }

  const preferences = (def.initialPreferences ?? [])
    .map((p) => ({
      topic: required(p.topic),
      stance: required(p.stance),
      ...(p.strength === undefined ? {} : { strength: cleanUnit(p.strength) }),
    }))
    .sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0))
  if (preferences.length > 0) canonical.initialPreferences = preferences

  return canonical
}

/**
 * 规范化 JSON 序列化。
 *
 * 手写而不是直接 `JSON.stringify(canonicalizeSeed(def))`：
 * 后者依赖**对象字面量的书写顺序**，任何一次无害的字段重排都会改变 hash。
 * 这里显式声明顺序，于是"改 hash 的唯一方式是改内容"。
 */
export function canonicalSeedJson(def: CharacterDefinition): string {
  const c = canonicalizeSeed(def)
  const parts: string[] = []

  const field = (key: string, value: unknown): void => {
    parts.push(`${JSON.stringify(key)}:${stableJson(value)}`)
  }

  field('id', c.id)
  field('slug', c.slug)
  field('name', c.name)
  field('seedVersion', c.seedVersion)
  field('schemaVersion', c.schemaVersion)
  field('identity', c.identity)
  field('personality', c.personality)
  field('values', c.values)
  field('communicationStyle', c.communicationStyle)
  field('boundaries', c.boundaries)
  field('initialPreferences', c.initialPreferences ?? null)

  return `{${parts.join(',')}}`
}

/**
 * 稳定 JSON：对象键按字典序输出，数组保持原序。
 *
 * 之所以不直接用 `JSON.stringify`：它对对象键顺序敏感，
 * 而上面所有结构都已经是"键顺序固定"的对象字面量 —— 为了不依赖这个隐性约定，
 * 这里再兜一层显式排序。
 */
export function stableJson(value: unknown): string {
  if (value === null) return 'null'
  if (value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(record[k])}`).join(',')}}`
}

/**
 * Seed 指纹（`seedHash` 的原始材料）。
 *
 * 这是 M3 的 `snapshotHash` / `seed_hash` 的唯一来源：
 * Trace 里记它，于是"两个月前和现在性格不同"可以被判定成
 * **成长 / 开发者改了 Seed / 模型漂移**三种情况之一（计划书第 125 节）。
 *
 * ⚠️ 这是纯字符串，不是密码学 hash —— 真正的 sha256 在基础设施层算
 * （领域层不 import `node:crypto`）。这样领域层保持零依赖，
 * 而"指纹的定义"仍然只有一处。
 */
export function seedFingerprint(def: CharacterDefinition): string {
  return canonicalSeedJson(def)
}

// ---------------------------------------------------------------------------
// 渲染：Seed → 模型可用文本
// ---------------------------------------------------------------------------

/**
 * 把 Seed 渲染成身份上下文。
 *
 * 三条硬约束（它们决定 SC-001 / SC-M3-001 能不能判定）：
 *   1. **确定性**：同一个 Seed 永远渲染出逐字节相同的文本。
 *   2. **不发明**：只重排与标注已有内容，绝不补写人设。
 *   3. **带版本**：末尾一定有 `Seed 版本 vN`，这样上下文本身也能被追溯。
 *
 * 渲染包含反例（`不意味着`），因为那正是计划书第 15 节要的防漫画化机制。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 为什么这里**必须**先规范化
 * ---------------------------------------------------------------------------
 * 曾经实测到的一个真实缺陷（M3 实施中）：`canonicalizeSeed` 会把 traits
 * 按名字排序（为了指纹稳定），而渲染直接用 `def.personality.traits` 的原始顺序。
 * 于是**从库读回来的那一份**（按 canonical 顺序存的）与**代码里那份**
 * （按书写顺序）渲染出不同的文本 —— 指纹相同、内容相同、显示却不同。
 * 症状是 SC-001 报"有人偷偷改了人设？"，而实际上没有人改。
 *
 * 修法不是把渲染也排一遍（那会留下两份排序规则），而是**让渲染从规范化
 * 结果出发**：指纹与文本从此共用同一个顺序定义，不可能再分叉。
 */
export function renderSeedIdentity(def: CharacterDefinition): string {
  const canonical = canonicalizeSeed(def)
  const parts: string[] = []
  parts.push('# 你是谁（Seed Identity，不随对话改变）')
  parts.push('')
  parts.push(`姓名：${canonical.name}`)
  parts.push('')

  parts.push('## 身份与来由')
  parts.push(canonical.identity.selfDescription)
  if (canonical.identity.roleDescription) {
    parts.push('')
    parts.push(canonical.identity.roleDescription)
  }

  const traits = canonical.personality.traits
  if (traits.length > 0) {
    parts.push('')
    parts.push('## 人格倾向')
    for (const trait of traits) {
      parts.push(`- ${trait.trait}（强度 ${formatStrength(trait.strength)}）：${trait.description}`)
      for (const example of trait.behavioralExamples) {
        parts.push(`  · 会这样：${example}`)
      }
      for (const counter of trait.counterExamples) {
        parts.push(`  · 不意味着：${counter}`)
      }
    }
  }

  const tendencies = canonical.personality.tendencies
  if (tendencies.length > 0) {
    parts.push('')
    parts.push('## 稳定习惯')
    for (const tendency of tendencies) {
      parts.push(`- ${tendency.tendency}：${tendency.description}`)
    }
  }

  if (canonical.values.length > 0) {
    parts.push('')
    parts.push('## 价值取向')
    for (const value of canonical.values) {
      parts.push(`- ${value.value}（优先级 ${formatStrength(value.priority)}）：${value.description}`)
      for (const note of value.tradeoffNotes) {
        parts.push(`  · 权衡：${note}`)
      }
    }
  }

  const style = canonical.communicationStyle
  const styleLines: string[] = []
  if (style.tone.length) styleLines.push(`- 语气：${style.tone.join('、')}`)
  if (style.verbosity) styleLines.push(`- 详略：${style.verbosity}`)
  if (style.vocabulary?.length) styleLines.push(`- 用词：${style.vocabulary.join('、')}`)
  for (const habit of style.habits ?? []) styleLines.push(`- 习惯：${habit}`)
  for (const avoidance of style.avoidances ?? []) styleLines.push(`- 不用：${avoidance}`)
  if (styleLines.length > 0) {
    parts.push('')
    parts.push('## 说话方式')
    parts.push(...styleLines)
  }

  if (canonical.boundaries.length > 0) {
    parts.push('')
    parts.push('## 边界（不因对话改变的约束）')
    for (const boundary of canonical.boundaries) parts.push(`- ${boundary}`)
  }

  if (canonical.initialPreferences?.length) {
    parts.push('')
    parts.push('## 初始偏好')
    for (const preference of canonical.initialPreferences) {
      parts.push(`- ${preference.topic}：${preference.stance}`)
    }
  }

  parts.push('')
  parts.push(`（Seed 版本 v${canonical.seedVersion}）`)
  return parts.join('\n')
}

/** 强度渲染成两位小数，保证文本确定性（不出现 0.7500000000000001） */
function formatStrength(value: number): string {
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
  return clamped.toFixed(2)
}

/**
 * Seed 的保护级别。
 *
 * 不是为了"神圣不可侵犯"（那会让她永远无法成长），而是为了明确
 * **哪一层由谁负责**：绝大多数成长走 Adaptive Self（M11），
 * Seed 只在长期、大量、一致的经历下以 `baseline + modifier` 的形式被修饰。
 */
export const SEED_INVARIANTS = [
  'Seed 只能由显式的 admin/configuration 路径改写；普通聊天、Proposal、模型输出都不能改写它。',
  'Seed 的改写必须产生新的 seedVersion，并保留旧版本（character_definition_versions）。',
  'Seed 的改写必须同时改变 version / updatedAt / hash，否则拒绝写入。',
  'Seed 进入 Context 时永远位于固定 section（identity-core），不参与预算裁剪淘汰。',
  'Seed 是人格的唯一真源：Prompt 里的那段人格文本永远是它的渲染物，而不是另一份手写副本。',
] as const
