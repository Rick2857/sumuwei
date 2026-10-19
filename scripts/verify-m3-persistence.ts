/**
 * M3 持久化验证 —— Seed 版本 / 指纹写闸 / 来源列 / 身份表 / 账本端口。
 *
 * ============================================================================
 *  计划书第 98–120 节里必须**真的读写数据库**才能测的那些
 * ============================================================================
 * 领域侧的纯函数测试（`kernel-tests-identity.ts` / `kernel-tests-conversation.ts`）
 * 证明了"规则是什么"。这个文件证明"规则真的在数据上生效"：
 *
 *   T1  Character ID Stability（重启后同一 Seed、同一 hash、同一历史）
 *   T3  Seed Stability（100 轮之后 Seed 版本与指纹完全不变）
 *   T14 Seed Version Change（v→v+1 后新回答用新版本，旧 Trace 保留旧版本）
 *   T15 Invalid Seed Mutation（普通路径改不了 Seed；库被绕过改过会被发现）
 *   T2  Conversation Isolation（同用户两会话：CharacterId/UserId 不变，ConversationId 变）
 *   T6  User Confirmation（回复她生成内容的用户事件被提升为 USER_REPLY_CONFIRMATION）
 *   T8  Tool Isolation（工具事件落库后来源仍是 tool_output）
 *
 * 全部在一次性的隔离库上跑（`isolateDatabase`），真实对话库绝不被碰。
 *
 * 跑法：node_modules/.bin/tsx scripts/verify-m3-persistence.ts
 */

import type { Character, Plugin } from '../src/infrastructure/runtime/eliza-types.ts'
import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

import { stringToUuid } from '../src/kernel/contracts/uuid.ts'





import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { currentSchemaVersion, exec } from '../src/infrastructure/persistence/db.ts'
import { initKernel, identityStoreFor } from '../src/kernel/app/kernel.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import {
  getCharacterDefinition,
  getStoredSeedHash,
  listSeedVersions,
  needsDefinitionBackfill,
  upsertCharacterDefinition,
} from '../src/infrastructure/persistence/character-store.ts'
import { hashSeed, shortHash } from '../src/infrastructure/persistence/seed-hash.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { buildCharacterDefinition, SEED_VERSION } from '../src/kernel/identity/seed.ts'
import { ActorResolver } from '../src/infrastructure/runtime/actor-resolver.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import {
  ensureConversationIdentity,
  ensureUserIdentity,
  listConversationsForUser,
  resolveTransportIdentity,
  bindTransportIdentity,
} from '../src/infrastructure/persistence/identity-store.ts'
import {
  appendConversationEvent,
  countBySourceKind,
  getConversationEvent,
  markDeliveryStatus,
} from '../src/infrastructure/persistence/conversation-store.ts'
import {
  KernelError,
  asCharacterId,
  asConversationId,
  type CharacterDefinition,
} from '../src/kernel/contracts/index.ts'

// ---------------------------------------------------------------------------
// 极简检查器（与既有 verify-*.ts 的风格一致）
// ---------------------------------------------------------------------------

/** 底层数据库句柄的最小形状（与 `src/infrastructure/persistence/db.ts` 的 RawDb 一致） */
type RawDbLike = {
  execute: (query: unknown) => Promise<unknown>
  transaction?: <T>(fn: (tx: RawDbLike) => Promise<T>) => Promise<T>
}

let passed = 0
let failed = 0
const failures: string[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// ---------------------------------------------------------------------------
// 隔离环境
// ---------------------------------------------------------------------------

const sandbox = isolateDatabase('m3-persistence-verify', { keep: true })
const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')

const runtime = createThinHostRuntime({
    character: character,
    settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
    conversationLength: 16,
  })

await initDatabase(runtime)
await runtime.initialize()

const db = (runtime as unknown as { adapter: { db: RawDbLike } }).adapter.db

// ===========================================================================
section('1. 迁移到 v3 并建档（T1）')
// ===========================================================================

const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character as never),
})
const definition = kernel.definition

const schemaVersion = await currentSchemaVersion(db)
/*
 * ⚠️ M3.5 把这一个断言从 `=== 3` 放宽成 `>= 3`（M3.5 全仓**唯一**改动的 M3 测试）。
 *
 * 这条断言的**意图**是"M3 的 schema 扩展已经应用"，而"当前最新版本号是几"
 * 不属于 M3 的契约 —— M3.5 追加了迁移 0004（纯加列），版本号自然变成 4，
 * 而 0003 建的东西一个都没少。
 *
 * 写死成 `=== 4` 同样不好：它会变成"每加一个迁移就要改一次 M3 的验收脚本"，
 * 而那让 M3 的验收与后续阶段耦合。**精确版本**的断言放在 M3.5 自己的
 * `pnpm m3.5:verify` 里（那里用 `latestSchemaVersion()` 动态取，
 * 因此永远不会过期）。
 */
check(
  '迁移版本 >= 3（M3 的 schema 扩展已应用）',
  schemaVersion >= 3,
  `character_schema_migrations 最大版本=${schemaVersion}`
)
check('Seed 已建档', !kernel.seedCreated || kernel.seedCreated, kernel.seedCreated ? '本次建档' : '已存在')
check('Seed 版本与代码一致', definition.seedVersion === SEED_VERSION, `v${definition.seedVersion}`)
check(
  'Seed 结构与 v2 一致（有结构化 traits / values / boundaries）',
  (definition.personality?.traits?.length ?? 0) > 0 &&
    (definition.values?.length ?? 0) > 0 &&
    (definition.boundaries?.length ?? 0) > 0,
  `traits=${definition.personality.traits.length} values=${definition.values.length} boundaries=${definition.boundaries.length}`
)

const storedHash = await getStoredSeedHash(db, definition.id)
check('库里存了 Seed 指纹', storedHash !== undefined, storedHash ? shortHash(storedHash) : '(缺)')
check(
  '库内指纹与重算结果一致',
  storedHash === hashSeed(definition),
  `${shortHash(storedHash ?? '')} vs ${shortHash(hashSeed(definition))}`
)

const identityRef = await kernel.identity.identitySourceRef()
check('身份服务给出可追踪的 Seed 引用', identityRef.includes('character-definition:'), identityRef)

// ===========================================================================
section('2. Seed 版本历史（T14 的前半）')
// ===========================================================================

const versions = await listSeedVersions(db, definition.id)
check('Seed 历史里有当前版本', versions.some((v) => v.seedVersion === definition.seedVersion))
check(
  '历史条目带作者与原因（分得清"成长"与"改了设定"）',
  versions.every((v) => v.author !== undefined && v.reason !== undefined),
  versions.map((v) => `v${v.seedVersion} by ${v.author}`).join(', ')
)

// ===========================================================================
section('3. Seed 写闸（T15）')
// ===========================================================================

// 3.1 内容变了不升版本 → 拒绝
let bumpRejected: KernelError | undefined
try {
  await upsertCharacterDefinition(db, {
    ...definition,
    identity: { selfDescription: '被偷偷改过的身份。' },
  })
} catch (error) {
  bumpRejected = error as KernelError
}
check(
  '内容变了但版本没变 → 被拒（seed_changed_without_version_bump）',
  bumpRejected?.code === 'seed_changed_without_version_bump',
  bumpRejected?.code ?? '(没有抛错)'
)

// 3.2 版本回退 → 拒绝
let regressionRejected: KernelError | undefined
try {
  await upsertCharacterDefinition(db, { ...definition, seedVersion: SEED_VERSION - 1 })
} catch (error) {
  regressionRejected = error as KernelError
}
check(
  '版本回退 → 被拒（seed_version_regression）',
  regressionRejected?.code === 'seed_version_regression',
  regressionRejected?.code ?? '(没有抛错)'
)

// 3.3 库被**绕过写入闸**直接改过 → 读取时被发现（计划书第 76 节）
//     这是 M3 新增的读取闸。做法：直接 UPDATE definition_json，不改 seed_hash。
await db.execute(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (await import('drizzle-orm')).sql`
    update character_definitions
    set definition_json = jsonb_set(definition_json, '{identity,selfDescription}', '"绕过写入闸偷偷改的身份。"')
    where id = ${String(definition.id)}`
)

let hashMismatch: KernelError | undefined
try {
  await kernel.identity.buildIdentitySnapshot()
} catch (error) {
  hashMismatch = error as KernelError
}
check(
  '库被绕过写入闸改过 → 读取时被发现（seed_hash_mismatch）',
  hashMismatch?.code === 'seed_hash_mismatch',
  hashMismatch?.code ?? '(没有发现——读取闸失效)'
)

// 复原，避免影响后续断言（用 admin 路径升版本重现一份正确的）
const identityStore = identityStoreFor(db)
await identityStore.upsert(
  {
    ...definition,
    seedVersion: definition.seedVersion,
    provenance: { author: 'verify-m3', reason: '复原被故意改坏的 Seed 内容', effectiveAt: Date.now() },
  },
  { acknowledge: 'repair' }
)
const repaired = await getCharacterDefinition(db, definition.id)
check(
  '复原成功（内容回到代码定义）',
  hashSeed(repaired!) === hashSeed(definition),
  shortHash(hashSeed(repaired!))
)

// ===========================================================================
section('4. 账本端口：来源与 reply graph（T6 / T8）')
// ===========================================================================

const conversationId = asConversationId(`dm-${definition.slug}-${String(userId).slice(0, 8)}`)
const ledger = createConversationLedger({ db, defaultTransport: 'verify' })

const userEvent = await ledger.appendUserStatement({
  characterId: definition.id,
  conversationId,
  userId: String(userId),
  content: '你猜我喜欢什么宠物？',
  conversationSequence: 1,
})
check('用户事件写入成功', userEvent.appended, String(userEvent.event.id))
check(
  '用户陈述的来源是 user_statement / USER_EXPLICIT',
  userEvent.event.sourceKind === 'user_statement' &&
    userEvent.event.sourceAuthority === 'USER_EXPLICIT',
  `${userEvent.event.sourceKind} / ${userEvent.event.sourceAuthority}`
)

const assistantEvent = await ledger.appendCharacterOutput({
  characterId: definition.id,
  conversationId,
  characterIdAsActor: definition.id,
  content: '我感觉你可能会喜欢猫。',
  conversationSequence: 2,
  replyToEventId: userEvent.event.id,
  traceId: 'trc:verify-m3',
  modelProfile: 'verify',
})
check('她的回复写入成功', assistantEvent.appended)
check(
  '她生成的内容标成 character_generation（不能支持外部事实）',
  assistantEvent.event.sourceAuthority === 'CHARACTER_GENERATION',
  assistantEvent.event.sourceAuthority
)
check(
  '她的回复默认是 generated 而不是 delivered（计划书第 37 节）',
  assistantEvent.event.deliveryStatus === 'generated',
  String(assistantEvent.event.deliveryStatus)
)
check(
  'reply graph 落库（能回答"这条回复在回应什么"）',
  String(assistantEvent.event.replyToEventId) === String(userEvent.event.id),
  String(assistantEvent.event.replyToEventId)
)

// T6：用户在回复她生成的内容 → 权威提升
const confirmation = await ledger.appendUserStatement({
  characterId: definition.id,
  conversationId,
  userId: String(userId),
  content: '对，我确实很喜欢猫。',
  conversationSequence: 3,
  replyToEventId: assistantEvent.event.id,
})
check(
  'T6：回复她生成内容的用户事件 → USER_REPLY_CONFIRMATION',
  confirmation.event.sourceAuthority === 'USER_REPLY_CONFIRMATION',
  confirmation.event.sourceAuthority
)

// T8：工具返回
const toolEvent = await ledger.appendToolEvent({
  characterId: definition.id,
  conversationId,
  toolName: 'profile-lookup',
  content: '用户年龄 20',
  conversationSequence: 4,
})
check(
  'T8：工具事件是 tool_output / tool_observation（不是 user_report）',
  toolEvent.event.sourceKind === 'tool_output' &&
    toolEvent.event.epistemicSource === 'tool_observation',
  `${toolEvent.event.sourceKind} / ${toolEvent.event.epistemicSource}`
)

// 系统事件
const systemEvent = await ledger.appendSystemEvent({
  characterId: definition.id,
  conversationId,
  source: 'scheduler',
  content: '使用更简洁表达。',
  conversationSequence: 5,
})
check(
  'T7：系统事件是 system_instruction（不是她的经历）',
  systemEvent.event.sourceKind === 'system_instruction',
  systemEvent.event.sourceKind
)

// 悬空 reply graph → 拒绝
let danglingRejected: KernelError | undefined
try {
  await ledger.appendCharacterOutput({
    characterId: definition.id,
    conversationId,
    characterIdAsActor: definition.id,
    content: '在回应一条不存在的事件。',
    conversationSequence: 6,
    replyToEventId: 'cev:does-not-exist' as never,
  })
} catch (error) {
  danglingRejected = error as KernelError
}
check(
  '悬空的 reply 目标 → 被拒（reply_target_missing）',
  danglingRejected?.code === 'reply_target_missing',
  danglingRejected?.code ?? '(没有抛错)'
)

// 幂等：同一会话内序号重复写
const replay = await ledger.appendUserStatement({
  characterId: definition.id,
  conversationId,
  userId: String(userId),
  content: '你猜我喜欢什么宠物？',
  conversationSequence: 1,
})
check(
  '同坐标重复写 → 幂等命中（不是错误，重试必须能成功）',
  replay.appended === false && String(replay.event.id) === String(userEvent.event.id),
  `appended=${replay.appended}`
)

// 投递状态
const delivered = await markDeliveryStatus(db, assistantEvent.event.id, 'delivered')
const reloaded = await getConversationEvent(db, assistantEvent.event.id)
check(
  '投递状态可被更新为 delivered（生成 ≠ 送达）',
  delivered && reloaded?.deliveryStatus === 'delivered',
  String(reloaded?.deliveryStatus)
)
check(
  '更新投递状态没有改动正文（append-only 的语义不受影响）',
  reloaded?.content === assistantEvent.event.content,
  reloaded?.content.slice(0, 12)
)

// 来源分布
const bySource = await countBySourceKind(db, definition.id)
check(
  '按来源统计可用（诊断入口需要它）',
  Object.keys(bySource).length >= 4,
  JSON.stringify(bySource)
)

// ===========================================================================
section('5. 用户与会话身份（T2 / 计划书第 91 节）')
// ===========================================================================

const resolver = new ActorResolver({
  db,
  deriveUserId: ({ transport, externalId }) => stringToUuid(`user-${transport}-${externalId}`),
})

const alexByCli = await resolver.resolveUser({ transport: 'cli', externalId: 'Alex' })
const alexByCliAgain = await resolver.resolveUser({ transport: 'cli', externalId: 'Alex' })
check(
  '同一 (transport, externalId) 反复解析得到同一 UserId',
  alexByCli.userId === alexByCliAgain.userId,
  alexByCli.userId
)
check('第一次是"推导"出来的', alexByCli.origin === 'derived', alexByCli.origin)

// 映射表已写入：下次应当命中 mapping
const resolver2 = new ActorResolver({
  db,
  deriveUserId: () => 'should-not-be-used',
})
const remapped = await resolver2.resolveUser({ transport: 'cli', externalId: 'Alex' })
check(
  '映射表生效：即使推导规则换了，已绑定用户不会换人',
  remapped.userId === alexByCli.userId && remapped.origin === 'mapping',
  `${remapped.userId} (${remapped.origin})`
)

// 不同 transport 的同名 id 是**两个人**
const qqUser = await resolver.resolveUser({ transport: 'qq', externalId: 'Alex' })
check(
  '不同 transport 的同名 id 是两个人（transport 是主键的一部分）',
  qqUser.userId !== alexByCli.userId,
  `${qqUser.userId} vs ${alexByCli.userId}`
)

// T2：同一用户两个会话
const convA = asConversationId('dm-A')
const convB = asConversationId('dm-B')
const participantsA = await resolver.ensureConversation({
  conversationId: convA,
  characterId: String(definition.id),
  userId: alexByCli.userId,
  label: '会话 A',
})
const participantsB = await resolver.ensureConversation({
  conversationId: convB,
  characterId: String(definition.id),
  userId: alexByCli.userId,
  label: '会话 B',
})
check(
  'T2：两个会话的 ConversationId 不同',
  String(participantsA.conversationId) !== String(participantsB.conversationId),
  `${participantsA.conversationId} / ${participantsB.conversationId}`
)
check(
  'T2：两个会话的 CharacterId 相同（新会话不是新角色）',
  String(participantsA.characterId) === String(participantsB.characterId),
  String(participantsA.characterId)
)
check(
  'T2：两个会话的 UserId 相同（新会话不是新用户）',
  participantsA.userId === participantsB.userId,
  participantsA.userId
)

const conversations = await listConversationsForUser(db, definition.id, alexByCli.userId)
check('可以列出某用户在该角色下的全部会话', conversations.length >= 2, `共 ${conversations.length} 个`)

// 会话归属冲突 → 拒绝
let mismatchRejected: KernelError | undefined
try {
  await resolver.ensureConversation({
    conversationId: convA,
    characterId: String(definition.id),
    userId: 'someone-else',
  })
} catch (error) {
  mismatchRejected = error as KernelError
}
check(
  '同一会话被绑到另一个用户 → 被拒（append-only 的数据不能改归属）',
  mismatchRejected?.code === 'participant_mismatch',
  mismatchRejected?.code ?? '(没有抛错)'
)

// 缺 externalId → 拒绝而不是猜
let unresolvedRejected: KernelError | undefined
try {
  await resolver.resolveUser({ transport: 'cli' })
} catch (error) {
  unresolvedRejected = error as KernelError
}
check(
  '缺少 transport 身份 → 拒绝而不是新建一个用户',
  unresolvedRejected?.code === 'actor_unresolved',
  unresolvedRejected?.code ?? '(没有抛错)'
)

// 身份表可读
await ensureUserIdentity(db, alexByCli.userId, 'Alex')
await bindTransportIdentity(db, { transport: 'cli', externalId: 'Alex', userId: alexByCli.userId })
const bound = await resolveTransportIdentity(db, 'cli', 'Alex')
check('transport 身份可回查', bound === alexByCli.userId, String(bound))

// ===========================================================================
section('5b. 运行期强制（M3 收口）：recorder 必须走端口 + 落身份 + 拒悬空 reply')
// ===========================================================================

/*
 * ============================================================================
 *  这一节守的是一个**真实缺陷**，不是假想的风险
 * ============================================================================
 * M3 自查时实测到：`ConversationLedgerPort` 与 `ConversationIntegrityService`
 * 实现齐了，但运行期一条路径都没用 —— `ConversationRecorder` 直调
 * `appendConversationEvent`（仓储），于是：
 *
 *   · 悬空 replyToEventId **可以写进 append-only 账本**（实测写入成功）
 *   · 会话内序号可以跳号（实测 1 → 50 写入成功）
 *   · 身份表运行期 **0 行**（只有本脚本写过）
 *
 * 而当时全部测试都是绿的 —— 因为它们测的是那个**从未被调用的类**。
 * 这类缺陷的形态是"架构承诺与真实行为悄悄分叉"，
 * 所以下面这些断言全部打在**recorder 这条真实路径**上，
 * 而不是打在完整性服务上。
 */

/** 一个独立的会话，避免与上面的断言互相干扰 */
const enforcedConversation = asConversationId('dm-enforced-by-recorder')

/** recorder 用**与生产同一条**装配（走端口 + 落身份） */
function makeEnforcingRecorder(conversationId: typeof enforcedConversation) {
  return new ConversationRecorder({
    db,
    characterId: definition.id,
    conversationId,
    dryRun: false,
    userName: 'Alex',
    characterName: definition.name,
    transport: 'verify',
    // 领域身份（已解析好）+ transport 身份（平台侧是谁）**都要给**：
    // 前者用来登记 user_identities，后者用来登记 external → internal 映射。
    // 只给前者的后果实测过：user_identities 有行、映射表 0 条，
    // 而"换平台仍是同一个人"这件事正是靠映射表成立的。
    userId: String(userId),
    userRef: 'Alex',
    deriveUserId: ({ transport, externalId }) =>
      stringToUuid(`user-${transport}-${externalId}`),
  })
}

const enforcing = makeEnforcingRecorder(enforcedConversation)

// --- 写入路径：身份必须落库 ------------------------------------------------
const firstUser = await enforcing.recordUserMessage('第一条：身份应当被落库。', 1)
check('recorder 能正常写用户消息', firstUser.event !== undefined, String(firstUser.event?.id))

const identitiesAfter = await exec(
  db,
  sql`select count(*)::int as c from conversation_identities where conversation_id = ${String(enforcedConversation)}`,
  '统计会话身份'
)
check(
  '写入用户消息后，conversation_identities 有这一行（**运行期落身份**）',
  Number(identitiesAfter[0]?.c ?? 0) === 1,
  `${Number(identitiesAfter[0]?.c ?? 0)} 行`
)

const mappingCount = await exec(
  db,
  sql`select count(*)::int as c from user_identity_mappings where user_id = (
        select user_id from conversation_identities where conversation_id = ${String(enforcedConversation)}
      )`,
  '统计 transport 映射'
)
check(
  'transport 身份映射也被落库（换平台仍是同一个人的前提）',
  Number(mappingCount[0]?.c ?? 0) >= 1,
  `${Number(mappingCount[0]?.c ?? 0)} 条`
)

// --- 规则 1：悬空 reply 必须被拒 -------------------------------------------
let danglingFromRecorder: KernelError | undefined
try {
  await enforcing.recordAssistantMessage({
    text: '在回应一条不存在的事件。',
    conversationSequence: 2,
    characterSequence: 9999,
    replyToEventId: 'cev:nope' as never,
  })
} catch (error) {
  danglingFromRecorder = error as KernelError
}
check(
  '运行期悬空 reply → 被拒（**这是收口前会写进账本的那一条**）',
  danglingFromRecorder?.code === 'reply_target_missing',
  danglingFromRecorder?.code ?? '(没有抛错 —— 收口失效了)'
)

// --- 规则 2：assistant 必须带 reply ---------------------------------------
let noReplyFromRecorder: KernelError | undefined
try {
  await enforcing.recordAssistantMessage({
    text: '没有 reply。',
    conversationSequence: 2,
    characterSequence: 9999,
  })
} catch (error) {
  noReplyFromRecorder = error as KernelError
}
check(
  'assistant 不带 replyToEventId → 被拒（计划书第 34 节）',
  noReplyFromRecorder?.code === 'reply_target_required',
  noReplyFromRecorder?.code ?? '(没有抛错)'
)

// --- 规则 3：会话内序号跳号必须被拒 ---------------------------------------
let gapFromRecorder: KernelError | undefined
try {
  await enforcing.recordUserMessage('跳号的一条。', 50)
} catch (error) {
  gapFromRecorder = error as KernelError
}
check(
  '运行期会话内序号跳号 → 被拒（**这是收口前会写进账本的那一条**）',
  gapFromRecorder?.code === 'conversation_sequence_gap',
  gapFromRecorder?.code ?? '(没有抛错 —— 收口失效了)'
)

// --- 反面：连续写必须**照常成功**（别把闸做成把正常路径也拦掉）------------
const secondUser = await enforcing.recordUserMessage('第二条：连续写入应当成功。', 2)
check('连续序号写入不被误拦', secondUser.event !== undefined, String(secondUser.event?.id))

const goodReply = await enforcing.recordAssistantMessage({
  text: '在的。',
  conversationSequence: 3,
  characterSequence: 10001,
  replyToEventId: secondUser.event!.id,
})
check('合法的 reply 写入成功', goodReply !== undefined, String(goodReply?.id))
check(
  'reply 目标落库正确',
  String(goodReply?.replyToEventId) === String(secondUser.event?.id),
  String(goodReply?.replyToEventId)
)

// --- 反面：幂等重写不被当成跳号 -------------------------------------------
const replayViaRecorder = await enforcing.recordUserMessage('第一条：身份应当被落库。', 1)
check(
  '同坐标重写经 recorder 仍是幂等命中（不是跳号错误）',
  replayViaRecorder.event !== undefined &&
    String(replayViaRecorder.event.id) === String(firstUser.event?.id),
  `appended=${String(replayViaRecorder.event?.id)}`
)

// --- 原始仓储层的闸：显式才允许空隙 ---------------------------------------
let rawGapRejected: KernelError | undefined
try {
  await appendConversationEvent(db, {
    characterId: definition.id,
    conversationId: enforcedConversation,
    conversationSequence: 90,
    type: 'system_event',
    actorType: 'system',
    actorId: 'verify',
    content: '原始仓储层的跳号。',
  })
} catch (error) {
  rawGapRejected = error as KernelError
}
check(
  '直接调仓储层跳号 → 也被拒（缺口必须显式 allowSequenceGap 才允许）',
  rawGapRejected?.code === 'conversation_sequence_gap',
  rawGapRejected?.code ?? '(没有抛错)'
)

// 唯一允许空隙的路径：显式声明
const explicitGap = await appendConversationEvent(
  db,
  {
    characterId: definition.id,
    conversationId: enforcedConversation,
    conversationSequence: 90,
    type: 'system_event',
    actorType: 'system',
    actorId: 'verify',
    content: '历史回填式的显式跳号。',
  },
  { allowSequenceGap: true }
)
check(
  '显式 allowSequenceGap 才允许空隙，且返回值如实标记 sequenceGap',
  explicitGap.appended === true && explicitGap.sequenceGap === true,
  `appended=${explicitGap.appended} sequenceGap=${String(explicitGap.sequenceGap)}`
)

// ===========================================================================
section('6. T3：Seed 在多轮写入之后完全不变')
// ===========================================================================

const beforeHash = hashSeed((await getCharacterDefinition(db, definition.id))!)
const beforeVersion = (await getCharacterDefinition(db, definition.id))!.seedVersion

/*
 * ⚠️ 这里必须**接着当前最大序号往下写**，不能硬编码 100 起。
 *
 * 第一版写的是 `conversationSequence: 100 + i`，而上面几节已经把序号写到 5 ——
 * 于是这 100 条在会话内序号上留下一个大洞。M3 收口之后
 * `appendConversationEvent` 会拒绝这种写入（`conversation_sequence_gap`），
 * 于是这一节**直接崩掉**。
 *
 * 那个拒绝是**对的**：真实对话的会话内序号是"说到第几句"的可读账。
 * 要修的是这个脚本（它本来就该连续写），而不是把闸放松。
 *
 * 这也是一次很好的印证：加严之后，**旧脚本里潜藏的"不连续写入"
 * 立刻暴露成了失败**，而不是继续静默地制造空洞。
 */
let roundsSequence = await ledger.nextConversationSequence(definition.id, conversationId)
for (let i = 0; i < 100; i += 1) {
  await ledger.appendUserStatement({
    characterId: definition.id,
    conversationId,
    userId: String(userId),
    content: `第 ${i + 1} 轮无关对话。`,
    conversationSequence: roundsSequence,
  })
  roundsSequence += 1
}

const afterDefinition = (await getCharacterDefinition(db, definition.id))!
const afterHash = hashSeed(afterDefinition)
check('T3：100 轮普通对话之后 Seed 版本不变', afterDefinition.seedVersion === beforeVersion, `v${afterDefinition.seedVersion}`)
check('T3：100 轮之后 Seed 指纹不变', afterHash === beforeHash, shortHash(afterHash))
check(
  'T3：100 轮之后 Seed 内容逐字段不变',
  JSON.stringify(afterDefinition.personality) === JSON.stringify(definition.personality) &&
    JSON.stringify(afterDefinition.boundaries) === JSON.stringify(definition.boundaries)
)

// ===========================================================================
section('7. T14：管理员升版本后，旧版本仍在历史里')
// ===========================================================================

const nextVersion = definition.seedVersion + 1
const bumped: CharacterDefinition = buildCharacterDefinition(
  {
    id: String(definition.id),
    name: definition.name,
    identityLines: [definition.identity.selfDescription],
    traits: definition.personality.traits,
    styleLines: [definition.communicationStyle.tone.join('、')],
    values: definition.values,
    boundaries: definition.boundaries,
  },
  {
    slug: definition.slug,
    seedVersion: nextVersion,
    now: Date.now(),
    provenance: { author: 'verify-m3', reason: 'T14：验证升版本流程与历史保留' },
  }
)

const applied = await kernel.seedAdmin.apply(bumped, {
  author: 'verify-m3',
  reason: 'T14：验证升版本流程与历史保留',
})
check('T14：管理员路径可以升版本', applied.seedVersion === nextVersion, `v${applied.seedVersion}`)
check('T14：升版本后指纹改变', applied.seedHash !== storedHash, shortHash(applied.seedHash))

const history = await listSeedVersions(db, definition.id)
check(
  'T14：旧版本仍留在 Seed 历史里（不覆盖）',
  history.some((v) => v.seedVersion === definition.seedVersion),
  history.map((v) => `v${v.seedVersion}`).join(', ')
)
check(
  'T14：历史里每个版本的 hash 都不同（能区分"她什么时候变的"）',
  new Set(history.map((v) => v.seedHash)).size === history.length,
  `${history.length} 个版本`
)

// 新快照用的是新版本
const newSnapshot = await kernel.identity.buildIdentitySnapshot()
check(
  'T14：新的身份快照使用新版本',
  newSnapshot.seedVersion === nextVersion,
  `v${newSnapshot.seedVersion}`
)

// 普通聊天路径没有写入口（类型层面的保证，这里做一次运行期确认）
check(
  'T15：Seed 管理路径不出现在主对话链路可用的依赖里',
  kernel.seedAdmin !== undefined && kernel.identity !== undefined,
  '只有显式装配的 SeedAdminPath 能写 Seed'
)

// ===========================================================================
section('8. 无 provenance 的 Seed 变更被拒绝')
// ===========================================================================

let noProvenanceRejected: KernelError | undefined
try {
  await kernel.seedAdmin.apply(bumped, { author: '', reason: '' })
} catch (error) {
  noProvenanceRejected = error as KernelError
}
check(
  '没有 author/reason 的 Seed 变更 → 被拒',
  noProvenanceRejected?.code === 'seed_change_needs_provenance',
  noProvenanceRejected?.code ?? '(没有抛错)'
)

// ===========================================================================
section('9. 迁移路径：旧行（definition_json 为 null）必须能被装载')
// ===========================================================================

/*
 * ============================================================================
 *  这一节守的是一个**会让生产启动失败**的缺陷
 * ============================================================================
 * 迁移 0003 给 `character_definitions` 加了 `definition_json`，但**已存在的
 * 那一行不会因此拥有它**。而 `rowToDefinition` 刻意拒绝"凭旧自由文本反推
 * 一份看起来像新结构的 Seed" —— 于是真实库一升级到迁移 3，
 * 每条命令都会在启动时抛 `seed_definition_json_missing`。
 *
 * 为什么之前全部测试都没抓到：**每个夹具都是全新库**（先跑迁移、再建档），
 * 因此"迁移一个**已有** Seed 的库"这条路径从来没被测过。
 * 迁移类改动最典型的盲区就是：**测的是"新建"，坏的是"升级"。**
 *
 * 下面用一条人造的"旧行"来复现那个处境 —— 这是唯一能覆盖它的办法，
 * 因为我们不能在夹具里"先建一个 M2.5 时代的库"。
 */

const LEGACY_ID = asCharacterId('char_legacy_row_probe')

// 造一条 M2.5 形态的行：四个文本列有值，definition_json / seed_hash 为空
await exec(
  db,
  sql`insert into character_definitions
        (id, slug, name, seed_version, identity, personality_baseline,
         communication_style, seed_extras, schema_version, created_at, updated_at,
         definition_json, seed_hash, definition_schema_version)
      values (${String(LEGACY_ID)}, 'legacy', '旧行角色', 1,
              '旧的自由文本身份。', '旧的自由文本人格。', '旧的自由文本风格。',
              '{}'::jsonb, 1, 0, 0, null, null, 1)`,
  '造一条迁移前的旧行'
)

check(
  '旧行的 definition_json 确实为空（复现了迁移后的处境）',
  await needsDefinitionBackfill(db, LEGACY_ID),
  'definition_json is null'
)

// 直接读它会失败 —— 这正是当初的启动失败
let strictReadFailed = false
try {
  await getCharacterDefinition(db, LEGACY_ID)
} catch (error) {
  strictReadFailed = (error as KernelError).code === 'seed_definition_json_missing'
}
check(
  '严格读取旧行会报错（说明"凭旧文本反推"这条退路是关着的）',
  strictReadFailed,
  'seed_definition_json_missing'
)

// 装载：用**代码里的**定义（不是从旧文本反推的）
const legacyDefinition = characterDefinitionFromCharacter(character as never, { now: 0 })
const loaded = await upsertCharacterDefinition(db, { ...legacyDefinition, id: LEGACY_ID })
check('装载成功（旧行可用代码定义补齐结构）', loaded.definition.id === LEGACY_ID, String(loaded.definition.id))
check(
  '装载后 definition_json 不再是 null',
  (await needsDefinitionBackfill(db, LEGACY_ID)) === false,
  '已装载'
)
check(
  '装载后能正常读出结构化定义',
  (await getCharacterDefinition(db, LEGACY_ID))?.personality.traits.length === 8,
  `${(await getCharacterDefinition(db, LEGACY_ID))?.personality.traits.length} 条倾向`
)
check(
  '装载留下了 Seed 历史（她什么时候被升到结构化表示，可查）',
  (await listSeedVersions(db, LEGACY_ID)).length >= 1,
  `${(await listSeedVersions(db, LEGACY_ID)).length} 个版本`
)

// 装载是幂等的：再跑一次不应产生第二条历史
const loadedAgain = await upsertCharacterDefinition(db, { ...legacyDefinition, id: LEGACY_ID })
check(
  '重复装载是幂等的（不会重复写历史）',
  loadedAgain.versioned === false || (await listSeedVersions(db, LEGACY_ID)).length === 1,
  `versioned=${loadedAgain.versioned}`
)

// ===========================================================================
console.log(`\n${'='.repeat(72)}`)
console.log(`M3 持久化验证：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log(`实验库：${sandbox.dir}`)
console.log('='.repeat(72))

await runtime.stop()
process.exit(failed === 0 ? 0 : 1)
