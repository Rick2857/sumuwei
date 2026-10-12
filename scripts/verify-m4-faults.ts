/**
 * M4 加固：**故障注入矩阵**（Phase 12）。
 *
 * ============================================================================
 *  它为什么存在
 * ============================================================================
 * M4 是第一个**自动写入长期状态**的里程碑。它的失败模式有一个共同特征：
 * **失败长得像成功**。
 *
 *   · 部分写入 → 记录存在但索引缺失 → 读到一条"有记忆但查不到证据"的东西
 *   · 数据库读失败 → 审计打印"0 条记忆" → 看起来像"她什么都不记得"
 *   · 折叠失败 → revision 不推进，但下次重试会算错
 *
 * 因此这里的判据全部是同一形状：**在故障下，两个不同的世界
 * 必须给出不同的结果**。只断言"没崩"是不够的 ——
 * 一个把错误吞掉、返回空数组的实现也能通过那种断言。
 *
 * ---------------------------------------------------------------------------
 *  与既有测试的分工（不重复测已经测过的东西）
 * ---------------------------------------------------------------------------
 * `m4:verify` 已经覆盖：
 *   §13  提交失败 → `ok: false` + **没有任何记忆被写入**（计划书第 55 节）
 *   §15  抽取失败 → 写进 job（不抛给调用方）+ 水位不越过失败区间
 *
 * 这份脚本只补**没被覆盖的那几条**：
 *   A. `applyMemoryEvent` 的**部分写入必须整体回滚**（四张表一起）
 *   B. 折叠失败之后 `rebuildMemory` 仍能判定 `A == B`（不留半成品）
 *   C. 数据库**读**失败时，审计**不能**报"0 条"（空与失败必须可分）
 *
 * 跑法：tsx scripts/verify-m4-faults.ts
 */

import 'dotenv/config'

import { AgentRuntime, stringToUuid, type Character, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import openaiPlugin from '@elizaos/plugin-openai'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'
import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'
import { exec, getRawDb, rowsOf, type RawDb } from '../src/infrastructure/persistence/db.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import {
  applyMemoryEvent,
  createNativeMemoryStore,
} from '../src/infrastructure/persistence/memory-store.ts'
import { findEventRefs } from '../src/infrastructure/persistence/conversation-store.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { createPersistentCharacterPlugin } from '../src/plugin/persistent-character.ts'
import { openAiCompatiblePlugin } from '../src/providers/openai-compatible.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import {
  asConversationId,
  createFullDomainEventRegistry,
  createMemoryCandidate,
  entityRef,
  type MemoryCandidate,
  type MemoryId,
  type NewMemoryCandidate,
} from '../src/kernel/contracts/index.ts'
import { createMemoryMutationValidator } from '../src/kernel/policies/memory-validator.ts'

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------

let checks = 0
const failures: string[] = []

function check(label: string, ok: boolean, detail = ''): void {
  checks += 1
  if (ok) console.log(`  ✅ ${label}${detail ? `  — ${detail}` : ''}`)
  else {
    console.log(`  ❌ ${label}${detail ? `  — ${detail}` : ''}`)
    failures.push(label)
  }
}

// ---------------------------------------------------------------------------
// 故障注入器
// ---------------------------------------------------------------------------

/**
 * 把 `db` 包成一个"会在特定语句上失败"的库。
 *
 * ⚠️ 用 `Proxy` 而不是对象展开（`{...real}`）：
 * `db` 很可能是**类实例**，展开只复制自有属性，会丢掉原型上的方法 ——
 * 于是"注入故障"顺带把库变成了一个不完整的东西，
 * 而那种失败会看起来像"故障注入生效了"。
 *
 * ⚠️ `transaction` 必须**递归包装**：`inTransaction()` 调
 * `db.transaction(work)` 并把 `tx` 传给 work。若只包外层，
 * 事务内部的语句会走未包装的 `tx`，故障**永远不会触发** ——
 * 而测试会"通过"，因为它注入的故障从未发生过。
 */
function faultyDb(real: RawDb, shouldFail: (described: string) => boolean): RawDb {
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return async (query: unknown) => {
          const described = describeQuery(query)
          if (shouldFail(described)) {
            /*
             * ⚠️ 消息不能写死"写入失败"。
             *
             * 本脚本的 C 段注入的是**读**故障，而第一版这里写的是
             * "数据库写入失败" —— 于是一次读故障的报错文本
             * 指着一个根本没发生的写操作。排查时那种文本
             * 会把人带到完全错误的方向（去查事务，而问题在读路径）。
             */
            throw new Error(`【注入故障】数据库操作失败：${described.slice(0, 120)}`)
          }
          return (target as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(query)
        }
      }
      if (prop === 'transaction') {
        return (work: (tx: RawDb) => Promise<unknown>) =>
          (target as unknown as { transaction: (w: unknown) => Promise<unknown> }).transaction(
            (tx: RawDb) => work(faultyDb(tx, shouldFail))
          )
      }
      const value = Reflect.get(target, prop, receiver) as unknown
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  }) as RawDb
}

/**
 * 把一条 drizzle `sql` 查询变成可比对的文本。
 *
 * drizzle 的 `sql` 对象把字面量放在 `queryChunks` 里，所以
 * `JSON.stringify` 能覆盖到表名。这里**只用于故障注入的匹配**，
 * 不用于任何业务判断 —— 那种用途需要真正的 SQL 解析。
 */
function describeQuery(query: unknown): string {
  try {
    const json = JSON.stringify(query)
    if (typeof json === 'string' && json.length > 0) return json
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    return String(query)
  } catch {
    return '(无法描述的查询)'
  }
}

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

await resetPluginSqlConnection()
const sandbox = isolateDatabase('m4-faults')

const characterId = character.id ?? character.name
const userId = stringToUuid('user-Alex')

const runtime = new AgentRuntime({
  character: character as Character,
  plugins: [
    openaiPlugin,
    bootstrapPlugin,
    openAiCompatiblePlugin,
    createPersistentCharacterPlugin({ characterId, userId }),
  ] as Plugin[],
  conversationLength: 16,
  settings: {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com',
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL ?? 'deepseek-flash',
    OPENAI_SMALL_MODEL: process.env.OPENAI_SMALL_MODEL ?? 'deepseek-flash',
  },
})

await initDatabase(runtime, sqlPlugin)
await runtime.initialize()

const kernel = await initKernel(runtime, {
  definition: characterDefinitionFromCharacter(character),
  registry: createFullDomainEventRegistry(),
})

const realDb = getRawDb(runtime)
const store = createNativeMemoryStore(realDb)
const owner = entityRef('character', String(kernel.characterId))
const USER = entityRef('user', userId)
const T0 = 1_800_000_000_000

const validator = createMemoryMutationValidator({
  registry: createFullDomainEventRegistry(),
  sources: { findEvents: (ids) => findEventRefs(realDb, ids as never) },
  processed: {
    hasProcessed: async (key) => {
      const r = await realDb.execute(
        sql`select 1 as one from processed_operations where idempotency_key = ${key} limit 1`
      )
      return rowsOf(r).length > 0
    },
  },
  lookup: {
    findActiveByFingerprint: async ({ owner: o, fingerprint }) => {
      const found = await store.getActiveByFingerprint(o, fingerprint)
      return found === null ? undefined : { memoryId: found.id }
    },
    findActiveByCanonicalKey: async ({ owner: o, canonicalKey }) => {
      const found = await store.getActiveByCanonicalKey(canonicalKey)
      return found
        .filter((r) => String(r.owner.id) === String(o.id) && r.owner.kind === o.kind)
        .map((r) => ({ memoryId: r.id }))
    },
  },
})

const recorder = new ConversationRecorder({
  db: realDb,
  characterId: kernel.characterId,
  conversationId: asConversationId(`dm-${String(kernel.characterId)}-m4faults`),
  dryRun: false,
  userName: 'Alex',
  characterName: character.name,
  transport: 'verify-m4-faults',
})

let sequence = 0
async function evidence(text: string): Promise<{ kind: 'conversation_event'; id: string }> {
  sequence += 1
  const { event } = await recorder.recordUserMessage(text, sequence)
  if (event === undefined) throw new Error('写入证据失败')
  return { kind: 'conversation_event', id: String(event.id) }
}

function candidate(
  predicate: string,
  value: unknown,
  refs: { kind: 'conversation_event'; id: string }[]
): MemoryCandidate {
  return createMemoryCandidate({
    owner,
    type: 'preference',
    content: {
      kind: 'claim',
      subject: USER,
      predicate,
      value,
    } as never,
    subjects: [USER],
    epistemicStatus: 'reported',
    authority: 'EXPLICIT_USER_STATEMENT',
    importance: 0.8,
    confidence: 0.9,
    processor: 'memory-extractor',
    processorVersion: 'memory-extractor@1',
    sourceRefs: refs,
    evidenceRootIds: refs.map((r) => r.id),
  } as NewMemoryCandidate)
}

/** 走真实放行口拿到**待落库的领域事件**（不落库） */
async function acceptOne(
  predicate: string,
  value: unknown,
  refs: { kind: 'conversation_event'; id: string }[]
) {
  const outcome = await validator.validate({
    characterId: kernel.characterId,
    owner,
    candidates: [candidate(predicate, value, refs)],
    mutation: 'explicit',
    operation: 'create',
  })
  if (outcome.rejected.length > 0) {
    throw new Error(`放行被拒（注入测试的前置失败）：${outcome.rejected.map((r) => r.code).join(',')}`)
  }
  return outcome.accepted
}

async function countOf(db: RawDb, table: string): Promise<number> {
  const rows = rowsOf(await exec(db, sql.raw(`select count(*)::int as n from ${table}`), `count ${table}`))
  return Number(rows[0]?.n ?? -1)
}

// ===========================================================================
console.log('='.repeat(72))
console.log('M4 加固：故障注入矩阵（Phase 12）')
console.log('='.repeat(72))

// ---------------------------------------------------------------------------
// A. 部分写入必须整体回滚
// ---------------------------------------------------------------------------

console.log('')
console.log('A. `applyMemoryEvent` 的部分写入必须整体回滚（四张表一起）')
console.log('   注入点：写 `memory_subject_links` / `memory_evidence_links` 时失败')
console.log('   （那一步在 `memory_events` 与 `memory_records` **之后**执行，')
console.log('     所以若没有事务，前两张表会留下半成品）')
console.log('')

const refsA = [await evidence('故障注入 A：我喜欢喝美式咖啡')]
const acceptedA = await acceptOne('beverage.preference.coffee', 'like', refsA)

// 先把事件真正写进领域事件表（那是 append-only 的账本，不属于本次要验证的原子性）
const appliedA = await applyAcceptedEvents(realDb, kernel.characterId, acceptedA, [], T0)
const eventA = appliedA.domainEvents[0]!
const memoryIdA = String(
  (eventA.payload as { record?: { id?: string }; memoryId?: string }).record?.id ??
    (eventA.payload as { memoryId?: string }).memoryId ??
    ''
)

const beforeA = {
  records: await countOf(realDb, 'memory_records'),
  events: await countOf(realDb, 'memory_events'),
  subject: await countOf(realDb, 'memory_subject_links'),
  evidence: await countOf(realDb, 'memory_evidence_links'),
}

const faulty = faultyDb(realDb, (described) => described.includes('memory_subject_links'))

let threw = false
let errorText = ''
try {
  await applyMemoryEvent(faulty, eventA, T0)
} catch (error) {
  threw = true
  errorText = error instanceof Error ? error.message : String(error)
}

const afterA = {
  records: await countOf(realDb, 'memory_records'),
  events: await countOf(realDb, 'memory_events'),
  subject: await countOf(realDb, 'memory_subject_links'),
  evidence: await countOf(realDb, 'memory_evidence_links'),
}

check('注入的故障真的触发了（不是"注入静默失效"）', threw, errorText.slice(0, 80))
check(
  '`memory_records` **没有**留下半成品（回滚生效）',
  afterA.records === beforeA.records,
  `${beforeA.records} → ${afterA.records}`
)
check(
  '`memory_events` **没有**留下半成品（事件链没有孤立条目）',
  afterA.events === beforeA.events,
  `${beforeA.events} → ${afterA.events}`
)
check('`memory_subject_links` 未变', afterA.subject === beforeA.subject, `${beforeA.subject} → ${afterA.subject}`)
check('`memory_evidence_links` 未变', afterA.evidence === beforeA.evidence, `${beforeA.evidence} → ${afterA.evidence}`)

/*
 * ⚠️ 这条是整组的**核心**：故障之后必须**还能正常折叠**。
 *
 * 只断言"没留下半成品"不够 —— 一个把事务搞坏成"整库不可写"的实现
 * 也能通过那些断言。真正要证明的是"故障是可恢复的"：
 * 去掉故障后，同一条事件应当能顺利折叠。
 */
let recovered = false
try {
  await applyMemoryEvent(realDb, eventA, T0)
  recovered = (await store.get(memoryIdA as MemoryId)) !== null
} catch (error) {
  recovered = false
  errorText = error instanceof Error ? error.message : String(error)
}
check('故障排除后同一条事件能正常折叠（故障是可恢复的，不是"库坏了"）', recovered, memoryIdA)

/*
 * ⚠️ 这一段是上面那四条断言的**非空转证明**。
 *
 * 上面说"四张表都没变"，而那只有在"成功时这四张表**真的会被写**"
 * 的前提下才说明问题。如果 `applyMemoryEvent` 根本不写
 * `memory_subject_links`，那么"它没变"是恒真的 ——
 * 一组恒真的断言看起来与"回滚生效了"一模一样。
 *
 * 所以这里把同一条事件正常折叠一遍，然后断言**四张表都多了行**。
 */
const afterRecovery = {
  records: await countOf(realDb, 'memory_records'),
  events: await countOf(realDb, 'memory_events'),
  subject: await countOf(realDb, 'memory_subject_links'),
  evidence: await countOf(realDb, 'memory_evidence_links'),
}
check(
  '成功路径确实写了 `memory_records`（证明上一条不是恒真）',
  afterRecovery.records > beforeA.records,
  `${beforeA.records} → ${afterRecovery.records}`
)
check(
  '成功路径确实写了 `memory_events`（否则"未变"是恒真的）',
  afterRecovery.events > beforeA.events,
  `${beforeA.events} → ${afterRecovery.events}`
)
check(
  '成功路径确实写了 `memory_subject_links`（否则"未变"是恒真的）',
  afterRecovery.subject > beforeA.subject,
  `${beforeA.subject} → ${afterRecovery.subject}`
)
check(
  '成功路径确实写了 `memory_evidence_links`（否则"未变"是恒真的）',
  afterRecovery.evidence > beforeA.evidence,
  `${beforeA.evidence} → ${afterRecovery.evidence}`
)

// ---------------------------------------------------------------------------
// B. 折叠失败后 rebuildMemory 仍能判定 A == B
// ---------------------------------------------------------------------------

console.log('')
console.log('B. 折叠失败之后，重放判定不能被污染')

const rebuiltB = await store.rebuildMemory(memoryIdA as MemoryId)
check('`rebuildMemory` 能对这条记忆给出结论（不抛错）', rebuiltB !== undefined)
check(
  '重放判定为一致（A == B）—— 故障没有留下"折叠到一半"的版本',
  rebuiltB.equal === true,
  rebuiltB.equal ? `${rebuiltB.appliedEvents} 条事件` : rebuiltB.differences.join(' | ')
)

// ---------------------------------------------------------------------------
// C. 数据库**读**失败时，审计不能报"0 条"
// ---------------------------------------------------------------------------

console.log('')
console.log('C. 数据库读失败时，"0 条记忆"与"读不出来"必须可分')

const readFaulty = faultyDb(realDb, (described) => described.includes('from memory_records'))

let statsThrew = false
let statsValue: unknown = undefined
try {
  statsValue = await countOf(readFaulty, 'memory_records')
} catch (error) {
  statsThrew = true
  errorText = error instanceof Error ? error.message : String(error)
}

/*
 * ⚠️ 判据的形状很重要。
 *
 * 这里**不能**断言"抛错了"就完事 —— 要断言的是
 * **它没有返回 0**。因为"读失败"最危险的伪装就是"0"：
 * 一个把异常吞掉、返回空集合的实现会打印
 * 「共抽取 0 条」+「✅ 未登记 0 / 污染 0」，
 * 而那看起来是一次**完全健康的审计**。
 */
check('注入的读故障真的触发了', statsThrew, errorText.slice(0, 80))
check(
  '读失败时**没有**返回 0（"读不出来"没有被伪装成"没有记忆"）',
  statsValue !== 0,
  statsThrew ? '抛错（正确：失败可见）' : `返回了 ${String(statsValue)}`
)

// 对照：没有故障时它确实返回 0 或正数（证明上面的故障是"读"而不是"表不存在"）
const healthy = await countOf(realDb, 'memory_records')
check('对照：无故障时同一查询正常返回', healthy >= 1, `count=${healthy}`)

// ---------------------------------------------------------------------------

await runtime.stop().catch(() => undefined)
cleanupSandbox(sandbox.dir)

console.log('')
console.log('='.repeat(72))
if (failures.length > 0) {
  console.log(`M4 故障注入矩阵：**${checks - failures.length} / ${checks} 通过**`)
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  console.log('='.repeat(72))
  process.exit(1)
}
console.log(`M4 故障注入矩阵：${checks} 项全部通过`)
console.log(`实验库：${sandbox.dir}（已清理，真实库未被触碰）`)
console.log('='.repeat(72))
