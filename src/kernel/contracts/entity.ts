/**
 * Entity / EntityRef —— **"这里可以是任何东西"的位置**。
 *
 * ============================================================================
 *  M3.5 WP2（计划书第 6–9 / 47 / 48 节）
 * ============================================================================
 * 为什么要引入它：M3 的身份分层解决了"谁"的问题（`ActorRef`），
 * 但 `ActorRef` 的 `actorId` 是**无品牌的 string**，而它只覆盖四种 actor。
 * 一旦出现第二个角色、NPC、地点、组织，就会出现下面这类签名：
 *
 *     relationship(characterId: CharacterId, target: ???)   ← 只能填 CharacterId
 *     belief(characterId: CharacterId, about: ???)          ← 只能填 something
 *
 * 填 `CharacterId` 就把"目标只能是角色"写进了类型；填 `string` 则丢掉类型安全。
 * `EntityRef` 是这两者之间**唯一**正确的第三种答案：
 * 「一个 id + 一个 kind」，于是在类型上写得出来"苏沐薇 → 角色 B"，
 * 也写得出来"苏沐薇 → 地点"。
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 三条不许破的规矩
 * ---------------------------------------------------------------------------
 * 1. **不推翻 `CharacterId`**（计划书第 8 节）。
 *    `CharacterDefinition.id` 继续是 `CharacterId`
 *    ——「这是角色」这个语义比「这是个实体」强得多，用弱的类型描述强的语义
 *    是"为了通用而丢掉信息"。`EntityRef` 只出现在**跨实体关系**的位置。
 *
 * 2. **不把 `ActorRef` 改成 `EntityRef`**（计划书第 9 节允许 Adapter）。
 *    `ActorRef.actorId` 是无品牌 `string`，已经进了数据库列
 *    （`conversation_events.actor_id`）与几十处 SQL / 日志。品牌化它会触发
 *    全仓 cast，而 cast 是**看不到的契约变更**。
 *    因此这里提供 `fromActor` / `toActorRef` 两个方向明确的映射。
 *
 * 3. **M3.5 不创建任何新实体**（计划书第 7 节）。
 *    `npc` / `group` / `location` / `object` / `organization` 只是**登记在枚举里**，
 *    没有任何代码会产出它们。登记的理由见文件末尾的"为什么现在登记"。
 */

import { KernelError, asEntityId, type EntityId } from './ids.ts'
import type { ActorRef, ActorType } from './actor.ts'

// ---------------------------------------------------------------------------
// EntityKind
// ---------------------------------------------------------------------------

/**
 * 实体种类。
 *
 * M3.5 **真正启用**的是前四种 —— 它们与 `ActorType` 是**同一套字面量**，
 * 因此 `ActorRef ↔ EntityRef` 的映射是恒等映射，而不是一张手工对照表。
 *
 * > 审计决策 D1（见 `docs/m3.5/compatibility-audit.md`）：
 * > 计划书第 7 节用大写 `USER / CHARACTER / …` 举例，这里采用小写。
 * > 理由不是美观：`ActorType` 已经是小写且**已经写进数据库列**，
 * > 两套大小写会需要一张对照表，而任何手工对照表都会在某天被漏写一个分支
 * > —— 那正是 M3 反复强调的"字典是愿望"。
 */
export type EntityKind =
  // —— M3.5 启用 ——
  | 'user'
  | 'character'
  | 'system'
  | 'tool'
  // —— 仅登记，不产出（计划书第 7 节）——
  | 'npc'
  | 'group'
  | 'location'
  | 'object'
  | 'organization'

/** M3.5 真正启用的四种（= `ACTOR_TYPES`，此处显式重述以免两处漂移） */
export const M3_5_ACTIVE_ENTITY_KINDS: readonly EntityKind[] = [
  'user',
  'character',
  'system',
  'tool',
]

/** 已登记的全部种类（校验用；新增一种要改这里，且必须在本文件写下理由） */
export const ENTITY_KINDS: readonly EntityKind[] = [
  'user',
  'character',
  'system',
  'tool',
  'npc',
  'group',
  'location',
  'object',
  'organization',
]

/** M3.5 未启用的部分：**只登记**，方便测试断言"M3.5 没有产出它们" */
export const M3_5_RESERVED_ENTITY_KINDS: readonly EntityKind[] = [
  'npc',
  'group',
  'location',
  'object',
  'organization',
]

export function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === 'string' && (ENTITY_KINDS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// EntityRef
// ---------------------------------------------------------------------------

/**
 * 指向**任意实体**的引用（计划书第 6 节）。
 *
 * ⚠️ `id` 与 `kind` 一起才构成"谁"：
 *   · `{ kind:'character', id:'char_sumuwei' }`
 *   · `{ kind:'location',  id:'loc_kitchen' }`
 *
 * 同一个 id 配不同 kind **不相等**（见 `entityRefEquals`）——
 * 这不是吹毛求疵：未来"名字叫 kitchen 的角色"和"厨房这个地点"必须能区分，
 * 而它们的 id 完全可能撞车。
 */
export interface EntityRef {
  id: EntityId
  kind: EntityKind
}

/** 构造（校验 kind 已登记；空 id 由 `asEntityId` 拦下） */
export function entityRef(kind: EntityKind, id: string): EntityRef {
  if (!isEntityKind(kind)) {
    throw new KernelError(
      'validation_error',
      'unknown_entity_kind',
      `未登记的 EntityKind：${String(kind)}。` +
        '新增一种实体时必须在 entity.ts 登记（否则"有哪些实体"就没有唯一答案）'
    )
  }
  return { id: asEntityId(id), kind }
}

/** 相等：**id 与 kind 都必须相等** */
export function entityRefEquals(a: EntityRef, b: EntityRef): boolean {
  return a.kind === b.kind && a.id === b.id
}

/** 人类可读标签（进日志与诊断；**领域层不知道实体叫什么**） */
export function entityLabel(entity: EntityRef): string {
  return `${entity.kind}:${String(entity.id)}`
}

// ---------------------------------------------------------------------------
// ActorRef ↔ EntityRef（计划书第 9 节：Adapter 而不是推翻）
// ---------------------------------------------------------------------------

/**
 * M3 的 `ActorRef` → M3.5 的 `EntityRef`。
 *
 * 恒等映射（`actorType` 的词面值就是 `EntityKind` 的词面值），
 * 因此它不可能出错 —— 这正是选择小写的收益。
 */
export function fromActor(actor: ActorRef): EntityRef {
  return entityRef(actor.actorType as EntityKind, actor.actorId)
}

/**
 * 反向映射：**只有四种 actor kind 能回到 `ActorRef`**。
 *
 * 未来 `{ kind:'location' }` 没有对应的 actor（地点不会"说话"），
 * 因此这里**失败关闭**而不是硬塞一个 'system' ——
 * 把地点冒充成系统组件，是"来源伪造"的另一种形式。
 */
export function toActorRef(entity: EntityRef): ActorRef {
  if (!(M3_5_ACTIVE_ENTITY_KINDS as readonly string[]).includes(entity.kind)) {
    throw new KernelError(
      'validation_error',
      'entity_kind_not_an_actor',
      `${entity.kind} 不是 actor（只有 user / character / system / tool 能充当发言者）`,
      { kind: entity.kind, id: String(entity.id) }
    )
  }
  return { actorId: String(entity.id), actorType: entity.kind as ActorType }
}

// ---------------------------------------------------------------------------
// Perspective Owner（计划书第 25 / 27 / 51 / 105 节）
// ---------------------------------------------------------------------------

/**
 * 视角拥有者。
 *
 * M9 才建 Belief，但**契约约定现在就定**：未来所有
 * `Belief` / `Knowledge` / `Perspective` / `Relationship` / `Memory`
 * 都必须带 `perspectiveOwnerId`，否则"苏沐薇认为 X"与"角色 B 认为 Y"
 * 在数据上无法共存 —— 而那时改 schema 的代价远高于现在写下这一行类型。
 *
 * M3.5 **不实现任何 store**：这里只有类型别名与这条注释。
 */
export type PerspectiveOwnerId = EntityId

/**
 * 未来 Relationship / Belief 的键形状（**M3.5 不实现，只写下来**）。
 *
 * 计划书第 27 节的原话是：M7 不允许
 * `RelationshipState { userTrust: number }` 这种把 user 写死的形状，
 * 必须是 `owner → target`。这里把那个形状固定成类型，
 * 这样 M7 的第一版就只能照着它写。
 */
export interface EntityRelationKey {
  owner: EntityId
  target: EntityId
}

/**
 * ---------------------------------------------------------------------------
 *  为什么现在就要登记 `npc` / `location` / …（它们一行代码都不会被用到）
 * ---------------------------------------------------------------------------
 * M3 的 `actor.ts` 已经有过一次同样的判断，并留下了理由：
 *
 *   > 等到真接 Tool 时再补这个枚举，就会有一批历史数据已经错了，
 *   > 而且无法回溯修正（append-only）。
 *
 * 实体枚举面临同一个形状的问题，但**更强**：`kind` 会进
 * `EntityRef`，而 `EntityRef` 会进事件、记忆、关系与 belief。
 * 那些数据是 append-only 的 —— 今天用 `'character'` 冒充一个城市场景，
 * 明天就再也分不清"这真的是一条角色数据，还是一条被压扁的场景数据"。
 *
 * 登记一个**不会被产出**的枚举值，成本是零（它不进任何表、不产生任何行为），
 * 收益是让"到底允许哪些实体"永远只有一个答案。
 * M3.5 用 `M3_5_RESERVED_ENTITY_KINDS` + FC-T01 明确守住：
 * **登记了，但没有产出。**
 */
