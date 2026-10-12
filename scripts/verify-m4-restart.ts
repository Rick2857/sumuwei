/**
 * M4-014 Restart Persistence —— **跨进程**验证"重启后记忆还在"。
 *
 * ============================================================================
 *  它补的是 MI-11 唯一缺的那半边证据
 * ============================================================================
 * `m4:verify` §8 证明的是 `A（从零重放）== B（增量折叠）`，
 * 而 `M4-013 Cross-session Persistence` 是**同进程内的两次查询**。
 *
 * 两者都**不能**回答"进程重启后记忆还在不在" ——
 * 因为它们的两个观察点在同一个进程里，共享同一份内存状态。
 * 一个只在内存里正确的实现能通过那两条，而重启后什么都不剩。
 *
 * `docs/architecture/memory-invariants.md` §16.1 把这件事如实标为缺口。
 * 这份脚本把它做掉：**两个真正的子进程**，共享同一个磁盘目录，
 * 第二个进程里没有任何来自第一个进程的内存状态。
 *
 * ---------------------------------------------------------------------------
 *  它验证的**范围**（如实界定）
 * ---------------------------------------------------------------------------
 * ✅ 干净退出（`runtime.stop()` 正常返回）之后，下一个进程能看到全部记忆
 * ✅ 跨进程的 supersede 双向指针仍然成立
 * ✅ 跨进程的 `rebuildMemory` 重放仍然 `A == B`
 * ✅ 证据链（`memory_evidence_links`）跨进程可读
 *
 * ❌ **不**验证"进程被 kill -9 之后数据还在" ——
 *    那是 PGlite / WAL 的持久化语义，不是 M4 的语义。
 *    混进来会让这条用例的失败原因不可判定
 *    （是 M4 丢了记忆，还是嵌入库没 flush？），
 *    而"不可判定的失败"在排查时和"没有测试"差不多。
 *
 * 跑法：
 *   tsx scripts/verify-m4-restart.ts              # 编排两个子进程并断言
 *   tsx scripts/verify-m4-restart.ts --keep       # 保留实验库（排查用）
 *   tsx scripts/verify-m4-restart.ts --phase write --run-id <id>   # 由父进程调用
 *   tsx scripts/verify-m4-restart.ts --phase read  --run-id <id>
 */

import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { AgentRuntime, stringToUuid, type Character, type Plugin } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import openaiPlugin from '@elizaos/plugin-openai'
import bootstrapPlugin from '@elizaos/plugin-bootstrap'
import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import {
  cleanupSandbox,
  isolateDatabase,
  resetPluginSqlConnection,
  sandboxPath,
} from '../src/dev/sandbox.ts'
import { getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { applyAcceptedEvents } from '../src/infrastructure/persistence/event-store.ts'
import { applyMemoryEvent, createNativeMemoryStore } from '../src/infrastructure/persistence/memory-store.ts'
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
// 参数
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const phase = flag('--phase') as 'write' | 'read' | undefined
const keep = argv.includes('--keep')

/**
 * 固定的 runId：两个子进程必须算出**同一个**目录。
 *
 * `isolateDatabase` 缺省用 `Date.now()` 生成 runId，那在两个进程里
 * 必然不同 —— 于是"跨进程"会变成"两个进程各自看一个空库"，
 * 而那种失败看起来像"记忆丢了"。所以父进程把 id 算好传下去。
 */
const runId = flag('--run-id') ?? `m4-restart-${Date.now()}-${process.pid}`

const T0 = 1_800_000_000_000
const USER = entityRef('user', stringToUuid('user-Alex'))

// ---------------------------------------------------------------------------
// 装配（两个阶段共用同一条路径）
// ---------------------------------------------------------------------------

interface Harness {
  db: ReturnType<typeof getRawDb>
  store: ReturnType<typeof createNativeMemoryStore>
  characterId: string
  runtime: AgentRuntime
  /** 本次实验库目录（父进程清理时要用） */
  dir: string
}

async function assemble(): Promise<Harness> {
  // 先清掉上一个库留在 globalThis 上的单例，再隔离 —— 顺序不能反
  await resetPluginSqlConnection()
  const sandbox = isolateDatabase('m4-restart', { runId, keep: true })

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

  const db = getRawDb(runtime)
  return {
    db,
    store: createNativeMemoryStore(db),
    characterId: String(kernel.characterId),
    runtime,
    dir: sandbox.dir,
  }
}

/** 建放行口（与 `m4:verify` 同一装配，不复刻第二套语义） */
function makeValidator(
  db: ReturnType<typeof getRawDb>,
  store: ReturnType<typeof createNativeMemoryStore>
) {
  return createMemoryMutationValidator({
    registry: createFullDomainEventRegistry(),
    sources: { findEvents: (ids) => findEventRefs(db, ids as never) },
    processed: {
      hasProcessed: async (key) => {
        const r = await db.execute(
          sql`select 1 as one from processed_operations where idempotency_key = ${key} limit 1`
        )
        return rowsOf(r).length > 0
      },
    },
    lookup: {
      findActiveByFingerprint: async ({ owner, fingerprint }) => {
        const found = await store.getActiveByFingerprint(owner, fingerprint)
        return found === null ? undefined : { memoryId: found.id }
      },
      findActiveByCanonicalKey: async ({ owner, canonicalKey }) => {
        const found = await store.getActiveByCanonicalKey(canonicalKey)
        return found
          .filter(
            (r) => String(r.owner.id) === String(owner.id) && r.owner.kind === owner.kind
          )
          .map((r) => ({ memoryId: r.id }))
      },
    },
  })
}

const expectationFile = (): string => sandboxPath('m4-restart-expectation.json')

interface Expectation {
  runId: string
  /** 被取代的那条（应为 superseded） */
  supersededId: string
  /** 取代它的那条（应为 active） */
  replacementId: string
  /** 身份事实那条（应为 active） */
  institutionId: string
  institutionCanonicalKey: string
  institutionContent: unknown
  institutionEvidenceIds: string[]
  /** 写阶段所在进程 */
  writtenByPid: number
}

// ---------------------------------------------------------------------------
// Phase: write
// ---------------------------------------------------------------------------

async function runWritePhase(): Promise<void> {
  const { db, store, characterId, runtime, dir } = await assemble()
  const validator = makeValidator(db, store)

  const recorder = new ConversationRecorder({
    db,
    characterId: characterId as never,
    conversationId: asConversationId(`dm-${characterId}-m4restart`),
    dryRun: false,
    userName: 'Alex',
    characterName: character.name,
    transport: 'verify-m4-restart',
  })

  let sequence = 0
  async function evidence(text: string): Promise<{ kind: 'conversation_event'; id: string }> {
    sequence += 1
    const { event } = await recorder.recordUserMessage(text, sequence)
    if (event === undefined) throw new Error('写入证据失败：recorder 返回 undefined')
    return { kind: 'conversation_event', id: String(event.id) }
  }

  function candidate(
    type: NewMemoryCandidate['type'],
    content: NewMemoryCandidate['content'],
    refs: { kind: 'conversation_event'; id: string }[]
  ): MemoryCandidate {
    return createMemoryCandidate({
      owner: entityRef('character', characterId),
      type,
      content,
      subjects: content.kind === 'claim' ? [content.subject] : content.participants,
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

  /**
   * 走**真实的放行口 + 真实的事件写入**，不绕过任何一层。
   *
   * ⚠️ 刻意不用 `store.apply()` 直接造事件：那会绕过
   * `MemoryMutationValidator`，于是这份脚本就测不到"放行口算出的幂等键"
   * 与"已存在记忆的变更必须带 `triggeredByEventId`"这两条。
   */
  async function commit(
    request: Parameters<typeof validator.validate>[0],
    now: number
  ): Promise<string> {
    const outcome = await validator.validate(request)
    if (outcome.rejected.length > 0) {
      throw new Error(`写入被拒：${outcome.rejected.map((r) => `${r.code}`).join(',')}`)
    }
    const applied = await applyAcceptedEvents(
      db,
      characterId as never,
      outcome.accepted,
      [],
      now
    )
    let last: string | null = null
    for (const event of applied.domainEvents) {
      const folded = await applyMemoryEvent(db, event, event.createdAt)
      if (folded.record !== null) last = String(folded.record.id)
    }
    if (last === null) throw new Error('写入后没有折叠出任何记录 —— 写入阶段自己就不自洽')
    return last
  }

  // 1) 一条偏好
  const dislikeEvidence = await evidence('我不吃香菜，从小就受不了那个味道')
  const dislikeId = await commit(
    {
      characterId: characterId as never,
      owner: entityRef('character', characterId),
      candidates: [
        candidate(
          'preference',
          {
            kind: 'claim',
            subject: USER,
            predicate: 'food.preference.cilantro',
            value: 'dislike',
          } as never,
          [dislikeEvidence]
        ),
      ],
      mutation: 'explicit',
      operation: 'create',
    },
    T0
  )

  // 2) **同槽位取代它** —— 跨进程验证双向指针
  //
  // ⚠️ 分**两次**提交：先建新条，再用新条的 id 发 supersede。
  //
  // 这不是为了省事，而是 `MEMORY_SUPERSEDED` 的 payload 要求
  // `supersededBy` = 新条的 memoryId，而那个 id 由新条的
  // `MEMORY_CREATED` 事件确定。反过来就只能**编**一个 id，
  // 而未必要被建立，于是库里会留下悬空引用。
  //
  // 生产流水线（`pipeline.ts`）与显式路径（`explicit-service.ts`）
  // 都是这个顺序，注释里写明了理由。
  const likeEvidence = await evidence('我现在能吃香菜了，口味变了')
  const replacementId = await commit(
    {
      characterId: characterId as never,
      owner: entityRef('character', characterId),
      candidates: [
        candidate(
          'preference',
          {
            kind: 'claim',
            subject: USER,
            predicate: 'food.preference.cilantro',
            value: 'like',
          } as never,
          [likeEvidence]
        ),
      ],
      mutation: 'explicit',
      operation: 'create',
    },
    T0 + 1000
  )

  await commit(
    {
      characterId: characterId as never,
      owner: entityRef('character', characterId),
      /*
       * 对已存在记忆的操作**不带候选**：它由 `target` 表达。
       * 计划书第 84 节：SUPERSEDED 表示"有更适合描述当前情况的新记忆"，
       * 没有新条就只是 retract —— 因此 `supersededBy` 必填。
       */
      candidates: [],
      target: { memoryId: dislikeId as MemoryId, supersededBy: replacementId as MemoryId },
      /*
       * ⚠️ 同样必填：`character_domain_events.primary_source_event_id`
       * 是 NOT NULL，而"没有来源的变化不允许落库"。
       * 触发这次变更的那句话就是它的来源。
       */
      triggeredByEventId: likeEvidence.id,
      mutation: 'explicit',
      operation: 'supersede',
    },
    T0 + 1100
  )

  // 3) 一条身份事实（不同槽位）
  const institutionEvidence = await evidence('我现在上的大学是示例工程科技大学')
  const institutionId = await commit(
    {
      characterId: characterId as never,
      owner: entityRef('character', characterId),
      candidates: [
        candidate(
          'person_fact',
          {
            kind: 'claim',
            subject: USER,
            predicate: 'education.institution',
            value: '示例工程科技大学',
          } as never,
          [institutionEvidence]
        ),
      ],
      mutation: 'explicit',
      operation: 'create',
    },
    T0 + 2000
  )

  const institution = await store.get(institutionId as MemoryId)
  if (institution === null) throw new Error('写入后立刻读回失败')

  const expectation: Expectation = {
    runId,
    supersededId: dislikeId,
    replacementId,
    institutionId,
    institutionCanonicalKey: String(institution.canonicalKey),
    institutionContent: institution.content,
    institutionEvidenceIds: institution.sourceRefs.map((r) => String(r.id)),
    writtenByPid: process.pid,
  }

  const file = expectationFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(expectation, null, 2), 'utf8')

  await runtime.stop().catch(() => undefined)
  report({ phase: 'write', ok: true, pid: process.pid, dir, ...expectation })
}

// ---------------------------------------------------------------------------
// Phase: read（全新进程，没有任何来自写进程的内存状态）
// ---------------------------------------------------------------------------

interface CheckResult {
  label: string
  ok: boolean
  detail: string
}

async function runReadPhase(): Promise<void> {
  /*
   * ⚠️ 顺序：**先装配，再读期望文件**。
   *
   * 第一版把 `expectationFile()` 写在 `assemble()` 之前，于是
   * `sandboxPath()` 在没有活动沙箱时会**静默退回一个随机临时目录**
   * （见 `src/dev/sandbox.ts` 的实现），期望文件当然找不到 ——
   * 而报错看起来像"两个阶段的 run-id 不一致"。
   *
   * 一个"没有沙箱时返回随机路径"的兜底，把一个顺序错误
   * 伪装成了一个配置错误。所以这里用装配返回的**真实目录**。
   */
  const { db, store, runtime, dir } = await assemble()
  const file = join(dir, 'm4-restart-expectation.json')

  if (!existsSync(file)) {
    throw new Error(
      `读阶段找不到期望文件（${file}）。\n` +
        '两个阶段必须用**同一个** --run-id，否则它们会指向两个不同的库目录，' +
        '而那种失败看起来像"记忆丢了"'
    )
  }
  const expected = JSON.parse(readFileSync(file, 'utf8')) as Expectation

  const checks: CheckResult[] = []
  const add = (label: string, ok: boolean, detail = ''): void => {
    checks.push({ label, ok, detail })
  }

  const sameProcess = expected.writtenByPid === process.pid
  add(
    '读阶段是**另一个进程**（这是本脚本的全部意义）',
    !sameProcess,
    `写=${expected.writtenByPid} 读=${process.pid}`
  )

  // --- 1) 身份事实跨进程可读，且内容/槽位一致 ---
  const institution = await store.get(expected.institutionId as MemoryId)
  add('重启后仍能读到那条身份事实', institution !== null)
  if (institution !== null) {
    add(
      '内容逐字节一致（不是"读到了别的什么"）',
      JSON.stringify(institution.content) === JSON.stringify(expected.institutionContent),
      JSON.stringify(institution.content)
    )
    add(
      'canonicalKey 一致',
      String(institution.canonicalKey) === expected.institutionCanonicalKey,
      String(institution.canonicalKey)
    )
    add('状态仍为 active', institution.status === 'active', institution.status)
    const evidenceIds = institution.sourceRefs.map((r) => String(r.id))
    add(
      '证据链跨进程可读，且指向同一批事件',
      JSON.stringify(evidenceIds.sort()) === JSON.stringify([...expected.institutionEvidenceIds].sort()),
      evidenceIds.join(',')
    )
  }

  // --- 2) supersede 的双向指针跨进程仍成立 ---
  const old = await store.get(expected.supersededId as MemoryId)
  const replacement = await store.get(expected.replacementId as MemoryId)
  add('被取代的那条仍在（MI-06：不是物理删除）', old !== null)
  add('取代它的那条也在', replacement !== null)
  if (old !== null) {
    add('旧条状态为 superseded', old.status === 'superseded', old.status)
    add(
      '旧条的 supersededBy 指向新条（MI-07 正向）',
      String(old.supersededBy) === expected.replacementId,
      `${String(old.supersededBy)}`
    )
  }
  if (replacement !== null) {
    const supersedes = (replacement.supersedes ?? []).map((id) => String(id))
    add(
      '新条的 supersedes 指回旧条（MI-07 反向）',
      supersedes.includes(expected.supersededId),
      supersedes.join(',') || '(空)'
    )
  }

  // --- 3) 历史事件跨进程可读 ---
  const history = await store.history(expected.institutionId as MemoryId)
  add('这条记忆的事件历史跨进程可读', history.length > 0, `${history.length} 条`)

  // --- 4) 在**新进程里**从事件重放，必须与读到的状态一致（A == B）---
  /*
   * ⚠️ 用 store 自己的 `equal` 判定，而不是在这里重写一遍比较。
   *
   * `rebuildMemory()` 返回 `{ before, after, appliedEvents, equal, differences }`,
   * 而 `equal` 就是计划书第 74 节那条 `A == B` 的**唯一实现**。
   * 在测试里再比一遍等于把那套判据复制成第二份 ——
   * 两份判据漂移时，测试会给出与产品不同的结论。
   */
  const rebuilt = await store.rebuildMemory(expected.institutionId as MemoryId)
  add('在新进程里从事件重建成功', rebuilt.after !== null, `appliedEvents=${rebuilt.appliedEvents}`)
  add(
    '重放结果与读到的状态一致（store 自己的 A == B 判定，跨进程）',
    rebuilt.equal === true,
    rebuilt.equal ? `${rebuilt.appliedEvents} 条事件` : rebuilt.differences.join(' | ')
  )

  // --- 5) 直接查表：证明数据真的在**磁盘上的表**里 ---
  const rowCounts = rowsOf(
    await db.execute(sql`select count(*)::int as n from memory_records`)
  )
  add(
    '`memory_records` 表里确实有行（不是内存里的假象）',
    Number(rowCounts[0]?.n ?? 0) >= 3,
    `count=${rowCounts[0]?.n}`
  )
  const linkCounts = rowsOf(
    await db.execute(sql`select count(*)::int as n from memory_evidence_links`)
  )
  add(
    '`memory_evidence_links` 表里确实有行',
    Number(linkCounts[0]?.n ?? 0) > 0,
    `count=${linkCounts[0]?.n}`
  )

  await runtime.stop().catch(() => undefined)

  const failed = checks.filter((c) => !c.ok)
  report({ phase: 'read', ok: failed.length === 0, pid: process.pid, checks })
}

function report(payload: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

// ---------------------------------------------------------------------------
// 父进程：编排两个真子进程
// ---------------------------------------------------------------------------

function parseReport(stdout: string): Record<string, unknown> | undefined {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop()
  if (line === undefined) return undefined
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return undefined
  }
}

async function runParent(): Promise<void> {
  console.log('='.repeat(72))
  console.log('M4-014 Restart Persistence —— 跨进程验证')
  console.log('='.repeat(72))
  console.log(`  runId：${runId}`)
  console.log('  两个阶段各起一个**独立子进程**，共享同一个磁盘目录。')
  console.log('')

  /*
   * 用与项目其余部分**同一条**启动方式（`node_modules/.bin/tsx` +
   * `shell: true`）。Windows 上 npm 的 bin 垫片是 `.cmd`，
   * 而 `shell: true` 下两种写法都能跑。
   *
   * 刻意不用 `process.execPath --import tsx`：那依赖 Node 的
   * `--import` 与 tsx 的 loader 交互方式，是另一条**没被这个项目
   * 验证过**的路径。父进程要在两个子进程之间传递状态，
   * 这里最不该引入一个新的未验证变量。
   */
  const tsx = process.platform === 'win32' ? 'node_modules\\.bin\\tsx.cmd' : 'node_modules/.bin/tsx'
  const self = 'scripts/verify-m4-restart.ts'

  function spawnPhase(name: 'write' | 'read'): {
    status: number
    report?: Record<string, unknown>
    stderr: string
  } {
    const result = spawnSync(
      tsx,
      [self, '--phase', name, '--run-id', runId],
      {
        encoding: 'utf8',
        shell: true,
        env: { ...process.env },
        maxBuffer: 64 * 1024 * 1024,
      }
    )
    return {
      status: result.status ?? 1,
      report: parseReport(String(result.stdout ?? '')),
      stderr: String(result.stderr ?? ''),
    }
  }

  const write = spawnPhase('write')
  if (write.status !== 0 || write.report === undefined) {
    console.error('❌ 写入阶段失败')
    console.error(write.stderr.slice(-2000))
    process.exit(1)
  }
  console.log(`  ✅ 写入阶段（pid ${String(write.report.writtenByPid)}）完成`)

  const read = spawnPhase('read')
  if (read.report === undefined) {
    console.error('❌ 读取阶段没有产出报告')
    console.error(read.stderr.slice(-2000))
    process.exit(1)
  }

  const checks = (read.report.checks ?? []) as { label: string; ok: boolean; detail: string }[]
  console.log('')
  for (const c of checks) {
    console.log(`  ${c.ok ? '✅' : '❌'} ${c.label}${c.detail ? `  — ${c.detail}` : ''}`)
  }

  const failed = checks.filter((c) => !c.ok)
  // 实验库目录由**写入阶段**报告，而不是父进程按命名规则拼一个 ——
  // 拼接会把 `isolateDatabase` 的目录命名规则复制成第二份真相，
  // 而它一改，父进程就会清理错东西（或者不清理）。
  const dir = String(write.report.dir ?? '')

  console.log('')
  console.log('='.repeat(72))
  if (failed.length > 0) {
    console.log(`M4-014 跨进程重启持久化：**${checks.length - failed.length} / ${checks.length} 通过**`)
    for (const f of failed) console.log(`  - ${f.label}`)
    console.log('='.repeat(72))
    if (!keep && dir !== '') cleanupSandbox(dir)
    process.exit(1)
  }

  console.log(`M4-014 跨进程重启持久化：${checks.length} 项全部通过`)
  console.log(
    `  写进程 pid=${String(write.report.writtenByPid)}｜读进程 pid=${String(read.report.pid)}`
  )
  console.log('  范围：干净退出后的重启。**不**覆盖 kill -9（那是嵌入库的 WAL 语义）')
  console.log('='.repeat(72))

  if (!keep && dir !== '') cleanupSandbox(dir)
}

// ---------------------------------------------------------------------------

if (phase === 'write') {
  await runWritePhase()
} else if (phase === 'read') {
  await runReadPhase()
} else {
  await runParent()
}
