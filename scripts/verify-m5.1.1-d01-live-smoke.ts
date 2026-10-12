/**
 * M5.1.1-D01 —— **Closure Candidate Live Smoke**（`pnpm m5.1.1:d01:smoke:live`）
 *
 * ============================================================================
 *  它回答 `DR-12` 的倒数第二条：真实链路 Live Smoke 观察
 * ============================================================================
 * ADR-043 `DR-12` 逐字：`M5.1-D01` 的关闭需要
 * **`4a` + `4b` + 门全绿 + 真实链路 Live Smoke 观察 + 用户批准**，
 * 并且 **ADR 批准 ≠ 关闭 D01**。4a/4b/门已经绿；本脚本补的是"真实链路观察"，
 * 而且**分场景**回答，而不是笼统地说一句"跑通了"：
 *
 * ```text
 *   S1 存量降档     那 2 条历史长期记忆，今天会不会被真实召回链带上
 *                   「来源未确立」标签送达模型？她的完整回复是什么？
 *   S2 确立来源正控  经**交互式人类控制台**（唯一能建立 confirmed 的入口）写入的
 *                   合成偏好 ⇒ 派生资格必须是 ESTABLISHED（不得被误降档）
 *   S3 代理伪装负控  经**程序化一次性入口**（SERVICE/agent-runner）提交的用户形状事实
 *                   ⇒ 要么形成期被拒，要么读时只能是 UNCONFIRMED_ORIGIN
 *   S4 量具自检     上面三条的**证据判定器**自己要有牙齿（正控 / 负控 / 恢复）
 * ```
 *
 * ---------------------------------------------------------------------------
 *  安全（不可协商）
 * ---------------------------------------------------------------------------
 * ```text
 * · 真实库**只复制，从不打开**：本文件里没有任何一行设置
 *   `PROJECT_LG_ALLOW_PRODUCTION_DB`，因此"打开真实库"在**构造上**不可能
 *   （`src/db/index.ts` 的 `assertDatabaseAccessAllowed()` 会拒）
 * · 全部读写发生在临时副本；父进程**自己不打开任何数据库**（PGlite 一个目录同时
 *   只能被一个进程打开），读状态一律交给 `--probe=snapshot` 子进程
 * · 模型端点**失败关闭**：必须由 `pnpm with-test-model` 启动。
 *   判据 = `.env.test` 里的 key/baseURL 与当前进程 env **逐字相等**（只比较不打印）
 *   ⇒ 直接跑本脚本不会回落到 `.env` 的真实聊天 key，而是 exit 2
 * · 私人记忆正文**不进证据**：只存 sha256 / 长度 / 结构化读数；
 *   完整模型回复在回报里交用户观察（`DR-11`：措辞不做启发式判定）
 * ```
 *
 * 跑法：`pnpm with-test-model pnpm m5.1.1:d01:smoke:live`（4–5 次真实模型调用）
 */

import 'dotenv/config'

import type { Character, Plugin } from '@elizaos/core'

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import {
  ATTRIBUTION_V7_COLUMNS,
  COGNITIVE_QUALIFICATION_RULE_VERSION,
} from '../src/kernel/contracts/attribution.ts'
import type { SourceQualification } from '../src/kernel/contracts/attribution.ts'
import type { MemoryType } from '../src/kernel/contracts/memory.ts'

const ROOT = resolve('.')
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const SELF_REL = 'scripts/verify-m5.1.1-d01-live-smoke.ts'
const EVIDENCE_PATH = join(ROOT, 'artifacts', 'm5.1.1', 'd01-live-smoke.json')
const PROMPT_DUMP_PATH = join(ROOT, 'data', 'prompt-dump.txt')

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32)
const sha256Bytes = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex').slice(0, 32)

// ===========================================================================
//  形状
// ===========================================================================

/** 一条记忆的资格读数（**派生值**，不是库里的列） */
interface MemoryReading {
  readonly id: string
  readonly memoryType: string
  readonly status: string
  readonly canonicalKey: string | null
  /** **当时**的判定（不可变）；这里只是原样带出来，不参与资格判断（`DR-1`） */
  readonly rawAuthority: string
  readonly contentSha256: string
  readonly contentLength: number
  /** 派生资格；`null` = 本规则不适用（Episode 面，`DR-5`） */
  readonly qualification: SourceQualification | null
  /** 生产渲染器的后缀（`qualificationLabelSuffix()`，与 prompt 里那一个**同一函数**） */
  readonly labelSuffix: string
  /**
   * 从这条记忆自己的正文里取出的**提问种子**（最长的一段中文取值）。
   *
   * ⚠️ 它存在的理由是一个**实测**：真实召回要求"相关证据"
   * （`ranking.ts` 的 `requireRelevanceEvidence`，权重里 `lexical: 4` 最强），
   * 而一个**不含任何记忆主题**的泛问（"你还记得关于我的事吗"）会让唯一 active
   * 的那条用户事实拿到 `LOW_RELEVANCE` ⇒ **一条都进不了 prompt**。
   * 于是"prompt 带不带标签"这个场景根本不会发生 —— 那是本门第一次实测
   * 在副本上发现的（见 `artifacts/m5.1.1/d01-live-smoke.json` 的 S1.traceAfter）。
   *
   * 因此 S1 的提问**必须**带上这条记忆自己的主题（这正是 D01 的真实形状：
   * "你告诉过我 X，是真的吗"）。种子由**记忆正文**派生，不引入任何外部猜测。
   */
  readonly querySeed: string
}

/** 一条对话事件的归因读数（原样，不做任何推导） */
interface EventReading {
  readonly role: string
  readonly attributionOrigin: string | null
  readonly actor: string
  readonly contentOriginator: string
  readonly axisBSourceKind: string | null
  readonly axisBSourceAuthority: string | null
  readonly epistemicSource: string | null
}

interface Snapshot {
  readonly schemaVersion: number
  readonly memoryIdentityDigest: string
  readonly memories: readonly MemoryReading[]
  readonly rootLinks: readonly { readonly memoryId: string; readonly evidenceId: string }[]
  readonly qualificationCounts: {
    readonly scanned: number
    readonly established: number
    readonly unconfirmedOrigin: number
    readonly contradictedOrigin: number
  }
  /** 生产探针 `unqualifiedUserFacts()` 自己的读数（用于交叉核对，不替代上面的逐条读数） */
  readonly probeUnqualified: number
  readonly contaminated: number
  readonly unsupported: number
  readonly latestEvent: EventReading | null
  /**
   * 最新一条**用户角色**事件（`actor_type = 'user'`）。
   *
   * ⚠️ 与 `latestEvent` 分开是必须的：一轮对话写**两行**，助手行在后。
   *    第一次跑本门时读的是 `latestEvent`，于是 S2/S3 断言的对象变成了
   *    **她的输出行**（`CHARACTER/…`）—— 一个"量错了东西"的典型形状。
   *    D01 说的是"以用户角色提交的那一行"，因此判据必须点名 `actor_type='user'`。
   */
  readonly latestUserEvent: EventReading | null
  readonly latestTrace: {
    readonly traceId: string
    readonly inputEventId: string
    readonly selectedMemoryIds: readonly string[]
    readonly status: string
  } | null
  /**
   * 最新 trace 里 `memory_recall` 那一步的**生产读数**（`recordToTraceAttributes()`）。
   *
   * 它是整条链自己给出的解释：扫了多少行 / 几个候选 / 几个合格 / 选中几个 /
   * 被拒的**理由直方图**。本门不重算这些数，只读它们 —— 因此
   * "为什么一条都没选上"这个问题由**生产实现**回答，而不是由本脚本猜。
   */
  readonly latestRecall: {
    readonly label: string
    readonly attributes: Record<string, string | number | boolean>
  } | null
}

/** `--dump-prompt` 的读数（只量结构性事实，不量措辞） */
interface PromptReading {
  readonly promptSha256: string
  readonly promptLength: number
  readonly labelUnconfirmed: number
  readonly labelContradicted: number
  /**
   * 带标签的那几行**原文**。
   *
   * ⚠️ 只用于**在终端里**给用户看（那是他自己的记忆），**不进证据文件**：
   *    证据里只留 `labelUnconfirmed` 这个计数与 prompt 的 sha256。
   */
  readonly labelLines: readonly string[]
}

// ===========================================================================
//  子进程入口：--probe=snapshot
// ===========================================================================
const probeArg = process.argv.find((argument) => argument.startsWith('--probe='))

if (probeArg !== undefined) {
  await runProbe()
} else {
  await runSmoke()
}

// ===========================================================================
//  probe：打开**副本**读一次状态（动态 import ⇒ 父进程永不打开数据库）
// ===========================================================================
async function runProbe(): Promise<void> {
  const core = await import('@elizaos/core')
  const sqlPlugin = (await import('@elizaos/plugin-sql')).default
  const { sql } = await import('drizzle-orm')
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { currentSchemaVersion, getRawDb, rowsOf } = await import(
    '../src/infrastructure/persistence/db.ts'
  )
  const { entityRef } = await import('../src/kernel/contracts/index.ts')
  const {
    contaminatedMemories,
    unqualifiedUserFacts,
    unsupportedMemories,
  } = await import('../src/infrastructure/persistence/memory-store.ts')
  const { qualificationsForMemories } = await import(
    '../src/infrastructure/persistence/qualification-read.ts'
  )
  const { countQualifications, qualificationLabelSuffix } = await import(
    '../src/kernel/recall/qualification.ts'
  )
  const { openAiCompatiblePlugin } = await import('../src/providers/openai-compatible.ts')
  const { createPersistentCharacterPlugin } = await import('../src/plugin/persistent-character.ts')

  const characterId = character.id ?? character.name
  const userId = core.stringToUuid('user-Alex')

  const runtime = new core.AgentRuntime({
    character: character as Character,
    plugins: [
      sqlPlugin,
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
  const db = getRawDb(runtime)

  /** probe 的读闸：只允许 SELECT（本子进程也不写任何表） */
  const read = async (statement: string): Promise<Record<string, unknown>[]> => {
    const head = statement.trim().slice(0, 12).toLowerCase()
    if (!head.startsWith('select') && !head.startsWith('with')) {
      throw new Error(`probe 是只读的，拒绝非 SELECT：${statement.slice(0, 80)}`)
    }
    return rowsOf(await db.execute(sql.raw(statement)))
  }

  const owner = entityRef('character', characterId)
  const memoryRows = await read(
    'select id, memory_type, authority, status, canonical_key, content::text as content_text ' +
      'from memory_records order by recorded_at desc, id asc'
  )
  const memories: { id: string; type: MemoryType }[] = memoryRows.map((row) => ({
    id: String(row.id),
    type: String(row.memory_type) as MemoryType,
  }))

  /*
   * ✅ 资格只在**生产函数**里派生一次：
   *    `qualificationsForMemories()` → `memoryQualificationOf()` → `sourceQualificationOf()`
   *    标签后缀只在**生产函数**里取一次：`qualificationLabelSuffix()`
   *    本脚本不重写"什么算已确立"，也不自己拼标签。
   */
  const qualifications = await qualificationsForMemories(db, memories)
  const readingOf = (row: Record<string, unknown>): MemoryReading => {
    const id = String(row.id)
    const qualification = qualifications.get(id) ?? undefined
    return {
      id,
      memoryType: String(row.memory_type),
      status: String(row.status),
      canonicalKey: row.canonical_key === null ? null : String(row.canonical_key),
      rawAuthority: String(row.authority),
      contentSha256: sha256(String(row.content_text)),
      contentLength: String(row.content_text).length,
      qualification: qualification ?? null,
      labelSuffix: qualificationLabelSuffix(qualification),
      querySeed: querySeedOf(String(row.content_text)),
    }
  }

  const linkRows = await read(
    "select memory_id, evidence_id from memory_evidence_links where is_root and evidence_kind = 'conversation_event' order by memory_id asc"
  )
  const probe = await unqualifiedUserFacts(db, owner)
  const contaminated = await contaminatedMemories(db, owner)
  const unsupported = await unsupportedMemories(db, owner)
  const schemaVersion = await currentSchemaVersion(db)

  const traceRows = await read(
    'select trace_id, input_event_id, selected_memory_ids::text as selected, status ' +
      'from character_traces order by started_at desc limit 1'
  )
  const stepRows = await read(
    'select steps::text as steps from character_traces order by started_at desc limit 1'
  )
  const eventRows = await read(
    `select id, actor_type, attribution_origin, ${ATTRIBUTION_V7_COLUMNS.join(', ')} ` +
      'from conversation_events order by created_at desc, sequence desc limit 1'
  )
  const userEventRows = await read(
    `select id, actor_type, attribution_origin, ${ATTRIBUTION_V7_COLUMNS.join(', ')} ` +
      "from conversation_events where actor_type = 'user' order by created_at desc, sequence desc limit 1"
  )

  const slot = (
    row: Record<string, unknown>,
    kind: string,
    id: string,
    reason: string
  ): string => {
    const k = row[kind]
    const i = row[id]
    const r = row[reason]
    if (k === null && i === null && r === null) return 'ABSENT'
    if (k === null && i === null) return `UNKNOWN(${String(r)})`
    return `${String(k)}/${String(i)}`
  }

  const readingOf0 = (row: Record<string, unknown>): EventReading => ({
    role: String(row.actor_type),
    attributionOrigin: row.attribution_origin === null ? null : String(row.attribution_origin),
    actor: slot(row, 'actor_kind', 'actor_ref_id', 'actor_unknown_reason'),
    contentOriginator: slot(
      row,
      'content_originator_kind',
      'content_originator_id',
      'content_originator_unknown_reason'
    ),
    axisBSourceKind: row.source_kind === null ? null : String(row.source_kind),
    axisBSourceAuthority: row.source_authority === null ? null : String(row.source_authority),
    epistemicSource: row.epistemic_source === null ? null : String(row.epistemic_source),
  })

  const snapshot: Snapshot = {    schemaVersion,
    memoryIdentityDigest: sha256(
      memoryRows
        .map((row) => `${String(row.id)}|${String(row.authority)}|${String(row.status)}`)
        .join('\n')
    ),
    memories: memoryRows.map(readingOf),
    rootLinks: linkRows.map((row) => ({
      memoryId: String(row.memory_id),
      evidenceId: String(row.evidence_id),
    })),
    qualificationCounts: {
      scanned: memories.length,
      ...countQualifications(
        memories.map((memory) => qualifications.get(memory.id) ?? undefined)
      ),
    },
    probeUnqualified: probe.unqualified.length,
    contaminated: contaminated.length,
    unsupported: unsupported.length,
    latestEvent:
      eventRows.length === 0
        ? null
        : readingOf0(eventRows[0]!),
    latestUserEvent:
      userEventRows.length === 0
        ? null
        : readingOf0(userEventRows[0]!),
    latestTrace:
      traceRows.length === 0
        ? null
        : {
            traceId: String(traceRows[0]!.trace_id),
            inputEventId: String(traceRows[0]!.input_event_id),
            selectedMemoryIds: JSON.parse(String(traceRows[0]!.selected) || '[]') as string[],
            status: String(traceRows[0]!.status),
          },
    latestRecall: (() => {
      if (stepRows.length === 0) return null
      interface StepShape {
        kind?: string
        label?: string
        attributes?: Record<string, string | number | boolean>
      }
      let steps: StepShape[] = []
      try {
        steps = JSON.parse(String(stepRows[0]!.steps) || '[]') as StepShape[]
      } catch {
        return null
      }
      const step = steps.find((item) => item.kind === 'memory_recall')
      if (step === undefined) return null
      return { label: String(step.label ?? ''), attributes: step.attributes ?? {} }
    })(),
  }

  await runtime.stop().catch(() => undefined)
  process.stdout.write(`__D01_PROBE_BEGIN__${JSON.stringify(snapshot)}__D01_PROBE_END__\n`)
}

// ===========================================================================
//  S4 的判定器（**纯函数**，三段式复用它）
// ===========================================================================
interface D01Evidence {
  readonly snapshots: {
    readonly atStart: Snapshot
    readonly afterS1: Snapshot
    readonly afterS2: Snapshot
    readonly afterS3: Snapshot
  }
  readonly s1Prompt: PromptReading
  readonly s2Prompt: PromptReading
  readonly replies: { readonly s1: number; readonly s2: number; readonly s3: number }
}

/**
 * D01 关闭候选的证据判定器。
 *
 * ⚠️ 它**不**读措辞（`DR-11`）：`replies` 只记长度，"回复说得对不对"交人看。
 *    它判的是机械保证：标签在不在、资格对不对、计数有没有自检。
 */
function judgeD01(evidence: D01Evidence): { pass: boolean; failures: string[] } {
  const f: string[] = []
  const { atStart, afterS1, afterS2, afterS3 } = evidence.snapshots

  // --- 量具自检：计数型判据必须 measured_count > 0（AGENTS §6.8）-----------
  if (atStart.qualificationCounts.scanned <= 0) f.push('S1: 存量探针扫到 0 条 ⇒ MEASUREMENT INVALID')
  if (atStart.memories.length <= 0) f.push('S1: 副本里没有记忆 ⇒ 场景不成立')
  if (evidence.s1Prompt.promptLength <= 0) f.push('S1: prompt 读数为空 ⇒ MEASUREMENT INVALID')
  if ((afterS1.latestTrace?.selectedMemoryIds.length ?? 0) <= 0) {
    f.push('S1: 真实召回链一条都没选中 ⇒ 场景不成立')
  }

  // --- S1 存量降档 ---------------------------------------------------------
  if (atStart.qualificationCounts.established !== 0) f.push('S1: 存量资格不是全 UNCONFIRMED_ORIGIN')
  if (atStart.qualificationCounts.unconfirmedOrigin !== atStart.qualificationCounts.scanned) {
    f.push('S1: 存量资格计数与扫描数不一致')
  }
  if (atStart.contaminated !== 0) f.push('S1: 污染探针非 0（DR-9 要求它一字不改）')
  if (atStart.unsupported !== 0) f.push('S1: 证据完整性探针非 0')
  if (evidence.s1Prompt.labelUnconfirmed <= 0) {
    f.push('S1: 送入模型的 prompt **没有**「来源未确立」标签')
  }
  {
    const selectedIds = afterS1.latestTrace?.selectedMemoryIds ?? []
    const expected = selectedIds.filter((id) => {
      const memory = afterS1.memories.find((item) => item.id === id)
      return memory?.qualification === 'UNCONFIRMED_ORIGIN'
    }).length
    if (evidence.s1Prompt.labelUnconfirmed !== expected) {
      f.push(
        `S1: prompt 标签数 ${evidence.s1Prompt.labelUnconfirmed} ≠ 派生器判定的未确立条数 ${expected}（两处判据漂移）`
      )
    }
  }
  if (evidence.s1Prompt.labelContradicted !== 0) {
    f.push('S1: prompt 里出现了「来源与记录不符」（三值不得被折叠）')
  }
  if (evidence.replies.s1 <= 0) f.push('S1: 没有捕获到真实模型回复 ⇒ 那一轮的结论都是空转')
  if (afterS1.memoryIdentityDigest !== atStart.memoryIdentityDigest) {
    f.push('S1: 跑完 (authority,status) 摘要变了（DR-1：读时派生不得改库）')
  }

  // --- S2 确立来源正控 -----------------------------------------------------
  const s2Memory = newlyWritten(afterS2, atStart)
  if (s2Memory === undefined) {
    f.push('S2: 交互式人类控制台写入的合成偏好**没有**落成记忆')
  } else {
    if (s2Memory.qualification !== 'ESTABLISHED') {
      f.push(`S2: 合成偏好的派生资格是 ${String(s2Memory.qualification)}，不是 ESTABLISHED（被误降档）`)
    }
    if (s2Memory.labelSuffix !== '') {
      f.push(`S2: 已确立的记忆**被加了**标签后缀「${s2Memory.labelSuffix}」`)
    }
  }
  if (afterS2.latestUserEvent?.attributionOrigin !== 'RECORDED') {
    f.push('S2: 控制台那一轮的用户行没有 RECORDED 受信信封')
  }
  if (!(afterS2.latestUserEvent?.actor ?? '').startsWith('USER/')) {
    f.push(`S2: 控制台那一轮用户行的 actor 不是 USER（${String(afterS2.latestUserEvent?.actor)}）`)
  }
  if (afterS2.qualificationCounts.established !== 1) {
    f.push(`S2: established 计数 = ${afterS2.qualificationCounts.established}，期望恰好 1`)
  }
  if (evidence.replies.s2 <= 0) f.push('S2: 没有捕获到真实模型回复')

  // --- S3 代理伪装负控 -----------------------------------------------------
  const s3Memory = newlyWritten(afterS3, afterS2)
  if (s3Memory !== undefined && s3Memory.qualification === 'ESTABLISHED') {
    f.push('S3: agent-runner 提交的用户形状事实**被当成了已确立的用户陈述**（D01 未闭合）')
  }
  if (afterS3.latestUserEvent?.actor !== 'SERVICE/agent-runner') {
    f.push(`S3: agent-runner 那一轮用户行的 actor 是 ${String(afterS3.latestUserEvent?.actor)}`)
  }
  if (afterS3.latestUserEvent?.contentOriginator !== 'SERVICE/agent-runner') {
    f.push(`S3: contentOriginator 是 ${String(afterS3.latestUserEvent?.contentOriginator)}`)
  }
  if (afterS3.qualificationCounts.established !== 1) {
    f.push(`S3: 跑完伪装负控后 established = ${afterS3.qualificationCounts.established}，必须仍只有 1 条`)
  }
  if (evidence.replies.s3 <= 0) f.push('S3: 没有捕获到真实模型回复')

  // --- 两个探针不得合并（DR-9）--------------------------------------------
  if (afterS3.probeUnqualified !== afterS3.qualificationCounts.unconfirmedOrigin) {
    f.push('S1/S3: 生产探针读数与逐条派生读数不一致（两套判据漂移了）')
  }

  return { pass: f.length === 0, failures: f }
}

/** 相对 `base` 新出现的记忆（`after` 里有、`base` 里没有） */
function newlyWritten(after: Snapshot, base: Snapshot): MemoryReading | undefined {
  const known = new Set(base.memories.map((memory) => memory.id))
  return after.memories.find((memory) => !known.has(memory.id))
}

// ===========================================================================
//  父进程：编排 + 判定 + 证据
// ===========================================================================
async function runSmoke(): Promise<void> {
  let passed = 0
  let failed = 0
  const failures: string[] = []
  const checks: { label: string; ok: boolean; detail: string }[] = []

  function check(label: string, ok: boolean, detail = ''): void {
    checks.push({ label, ok, detail })
    if (ok) {
      passed += 1
      console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
    } else {
      failed += 1
      failures.push(`${label} :: ${detail}`)
      console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
    }
  }
  const section = (title: string): void => {
    console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
  }
  /**
   * 把一轮的**完整回复**打到终端（`DR-11`：措辞只能由人观察，不能由字符串规则判）。
   *
   * ⚠️ 它**不写进证据文件**（证据里只留长度）；它出现在这里，是为了让这次运行
   *    的输出本身就是"用户可观察"的那份材料。
   */
  const showReply = (scene: string, reply: string): void => {
    console.log(`\n  ── ${scene} 她的完整回复（供人工观察；不写入证据） ──`)
    console.log(reply === '' ? '    （没有捕获到回复）' : reply.replace(/^/gm, '    '))
    console.log('  ── 回复结束 ──\n')
  }
  /** 计数型判据必须自检 measured_count > 0（AGENTS §6.8） */
  const measure = (label: string, count: number): void => {
    if (count <= 0) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  }

  console.log('='.repeat(78))
  console.log('M5.1.1-D01 Closure Candidate Live Smoke')
  console.log('='.repeat(78))

  // -------------------------------------------------------------------------
  // §0 模型端点失败关闭
  // -------------------------------------------------------------------------
  section('§0 模型端点失败关闭（不得回落到 .env 的真实聊天 key）')
  {
    const testEnvPath = process.env.TEST_MODEL_ENV_FILE ?? join(ROOT, '.env.test')
    if (!existsSync(testEnvPath)) {
      console.error(`\n❌ 拒绝运行：找不到 ${testEnvPath}`)
      console.error('   必须通过 `pnpm with-test-model pnpm m5.1.1:d01:smoke:live` 启动。')
      process.exit(2)
    }
    const raw = readFileSync(testEnvPath, 'utf8')
    const valueOf = (key: string): string =>
      (new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)`, 'm').exec(raw)?.[1] ?? '').trim()
    const testKey = valueOf('OPENAI_API_KEY')
    const testBaseUrl = valueOf('OPENAI_BASE_URL')
    const currentKey = process.env.OPENAI_API_KEY ?? ''
    const currentBaseUrl = process.env.OPENAI_BASE_URL ?? ''

    if (testKey === '' || testBaseUrl === '' || currentKey !== testKey || currentBaseUrl !== testBaseUrl) {
      console.error('\n❌ 拒绝运行：当前 env 不是 `.env.test` 的测试端点（不回落 `.env` 的原 key）。')
      console.error(`   .env.test key 长度 ${testKey.length} · 进程 key 长度 ${currentKey.length}`)
      console.error('   请用：pnpm with-test-model pnpm m5.1.1:d01:smoke:live')
      process.exit(2)
    }
    check('当前 env 与 `.env.test` 的 key / baseURL **逐字相等**（只比较，不打印取值）', true,
      `env.test key 长度 ${testKey.length}`)
    check(
      '本门**从未**设置 `PROJECT_LG_ALLOW_PRODUCTION_DB`（构造上不可能打开真实库）',
      process.env.PROJECT_LG_ALLOW_PRODUCTION_DB !== '1'
    )
    console.log(
      `  · 非机密读数：endpoint host = ${new URL(currentBaseUrl).host} · ` +
        `largeModel = ${String(process.env.OPENAI_LARGE_MODEL)} · ` +
        `key = 存在（长度 ${currentKey.length}，**不打印取值**）`
    )
  }

  // -------------------------------------------------------------------------
  // §1 复制真实库
  // -------------------------------------------------------------------------
  section('§1 复制真实库到临时副本（真实库全程不被打开）')
  const realDbBefore = digestTree(PRODUCTION_DB_DIR)
  const work = mkdtempSync(join(tmpdir(), 'project-lg-d01-smoke-'))
  const dbDir = join(work, 'pglite')
  const sandboxRoot = join(work, 'action-sandbox')
  mkdirSync(sandboxRoot, { recursive: true })
  cpSync(PRODUCTION_DB_DIR, dbDir, { recursive: true })
  check('副本目录与真实库不重叠', !isProductionDir(dbDir) && !isProductionDir(sandboxRoot), dbDir)
  check(
    '真实库在复制**之前**的树摘要已记录（跑完逐字比对）',
    realDbBefore.files > 0,
    `${realDbBefore.files} 文件 · ${realDbBefore.bytes} 字节 · ${realDbBefore.digest}`
  )
  const promptDumpBefore = existsSync(PROMPT_DUMP_PATH)
    ? { existed: true as const, sha256: sha256Bytes(readFileSync(PROMPT_DUMP_PATH)) }
    : { existed: false as const, sha256: '' }

  const childEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    PGLITE_DATA_DIR: dbDir,
    PROJECT_LG_SANDBOX: dbDir,
    ACTION_SANDBOX_ROOT: sandboxRoot,
  })

  const runProbeChild = (): Snapshot => {
    const result = spawnSync(process.execPath, [TSX_CLI, SELF_REL, '--probe=snapshot'], {
      cwd: ROOT,
      env: childEnv(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const stdout = String(result.stdout ?? '')
    const match = /__D01_PROBE_BEGIN__(.*?)__D01_PROBE_END__/s.exec(stdout)
    if (match === null) {
      console.error('probe 子进程没有返回读数。stdout 尾部：')
      console.error(stdout.slice(-2500))
      console.error(String(result.stderr ?? '').slice(-2500))
      throw new Error(`probe 失败（exit=${String(result.status)}）`)
    }
    return JSON.parse(match[1]!) as Snapshot
  }

  /** 真实 turn：**程序化一次性入口** ⇒ `SERVICE/agent-runner`（D01 的生产控制） */
  const turnAgentRunner = (line: string) => {
    const result = spawnSync(process.execPath, [TSX_CLI, 'src/main.ts', line], {
      cwd: ROOT,
      env: childEnv(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      // 超时即杀：宁可如实记一次失败，也不让整道门挂住（否则"没跑完"会伪装成"还在跑"）
      timeout: 300_000,
    })
    const stdout = String(result.stdout ?? '')
    return { status: result.status ?? 1, reply: replyOf(stdout), stderr: String(result.stderr ?? '') }
  }

  /** 真实 turn：**交互式人类控制台**（唯一能建立 confirmed 的入口），用 stdin 驱动 readline */
  const turnHumanConsole = (line: string) => {
    const result = spawnSync(process.execPath, [TSX_CLI, 'src/main.ts'], {
      cwd: ROOT,
      env: childEnv(),
      input: `${line}\n/exit\n`,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    })
    const stdout = String(result.stdout ?? '')
    return { status: result.status ?? 1, reply: replyOf(stdout), stderr: String(result.stderr ?? '') }
  }

  /** `--dump-prompt`：与真实对话**同一条编译路径**的只读导出 */
  const dumpPrompt = (question: string): PromptReading => {
    spawnSync(process.execPath, [TSX_CLI, 'src/main.ts', '--dump-prompt', question], {
      cwd: ROOT,
      env: childEnv(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 180_000,
    })
    if (!existsSync(PROMPT_DUMP_PATH)) throw new Error('--dump-prompt 没有产出 data/prompt-dump.txt')
    const text = readFileSync(PROMPT_DUMP_PATH, 'utf8')
    return {
      promptSha256: sha256(text),
      promptLength: text.length,
      labelUnconfirmed: occurrences(text, '来源未确立'),
      labelContradicted: occurrences(text, '来源与记录不符'),
      labelLines: text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('来源未确立') || line.includes('来源与记录不符')),
    }
  }

  // -------------------------------------------------------------------------
  // §2 S1
  // -------------------------------------------------------------------------
  section('§2 S1 存量降档（真实召回链 + 真实模型 + 真实 prompt 标签）')
  const atStart = runProbeChild()
  check(
    '副本 schema = v9',
    atStart.schemaVersion === 9,
    `schema=${atStart.schemaVersion} · 记忆 ${atStart.memories.length} 条 · ` +
      `根证据链 ${atStart.rootLinks.length} 条`
  )
  measure('S1 存量探针扫过的用户事实条数', atStart.qualificationCounts.scanned)
  check(
    'S1.1 存量资格 = 全部 UNCONFIRMED_ORIGIN',
    atStart.qualificationCounts.scanned > 0 &&
      atStart.qualificationCounts.unconfirmedOrigin === atStart.qualificationCounts.scanned &&
      atStart.qualificationCounts.established === 0 &&
      atStart.qualificationCounts.contradictedOrigin === 0,
    JSON.stringify(atStart.qualificationCounts)
  )
  check(
    'S1.2 两个探针**不合并**：污染 = 0，而"资格未确立" = 全部（DR-9）',
    atStart.contaminated === 0 &&
      atStart.unsupported === 0 &&
      atStart.probeUnqualified === atStart.qualificationCounts.unconfirmedOrigin,
    `contaminated=${atStart.contaminated} · unsupported=${atStart.unsupported} · unqualified=${atStart.probeUnqualified}`
  )

  /*
   * S1 的提问由**存量记忆自己的主题**派生（见 `MemoryReading.querySeed` 的说明）：
   * 泛问会让唯一 active 的那条用户事实拿到 `LOW_RELEVANCE`，于是"prompt 带标签"
   * 这个场景不会发生。提问正文不落证据，只存 sha256 / 长度。
   */
  const activeStock = atStart.memories.find(
    (memory) =>
      memory.status === 'active' &&
      (memory.memoryType === 'person_fact' || memory.memoryType === 'preference')
  )
  const s1Question =
    activeStock !== undefined
      ? `你之前跟我说过「${activeStock.querySeed}」这件事，你还记得吗？`
      : '你还记得关于我的事吗？说来听听。'
  const s1Prompt = dumpPrompt(s1Question)
  const s1Turn = turnAgentRunner(s1Question)
  const afterS1 = runProbeChild()
  const stockIds = atStart.memories.map((memory) => memory.id)
  const selected = afterS1.latestTrace?.selectedMemoryIds ?? []
  check(
    'S1.3 真实召回链命中了存量记忆（trace.selected_memory_ids ∩ 存量）',
    selected.some((id) => stockIds.includes(id)),
    `selected=${JSON.stringify(selected)} · 存量 ${stockIds.length} 条`
  )
  /*
   * 交叉核对：**生产 prompt 渲染器**加的后缀数，必须等于**生产资格派生器**
   * 判为"未确立"的被选中记忆数。两个数来自两个不同的生产函数
   * （`qualificationLabelSuffix()` 与 `memoryQualificationOf()`），
   * 它们不一致就说明其中一处漂移了。
   */
  const expectedLabels = selected.filter((id) => {
    const memory = afterS1.memories.find((item) => item.id === id)
    return memory?.qualification === 'UNCONFIRMED_ORIGIN'
  }).length
  check(
    'S1.4 送入模型的 prompt 带「来源未确立」标签',
    s1Prompt.labelUnconfirmed > 0,
    `标签 ${s1Prompt.labelUnconfirmed} 处 · prompt ${s1Prompt.promptLength} 字符 · sha256 ${s1Prompt.promptSha256}`
  )
  check(
    'S1.4b 交叉核对：prompt 里的标签数 = 被选中且资格未确立的记忆数（渲染器与派生器不漂移）',
    s1Prompt.labelUnconfirmed === expectedLabels,
    `prompt 标签 ${s1Prompt.labelUnconfirmed} · 派生器判定 ${expectedLabels} · selected=${JSON.stringify(selected)}`
  )
  check(
    'S1.5 prompt 里**没有**「来源与记录不符」（三值不得折叠成一值）',
    s1Prompt.labelContradicted === 0,
    `${s1Prompt.labelContradicted} 处`
  )
  check('S1.6 真实模型产出非空回复（Level 1）', s1Turn.reply.length > 0, `${s1Turn.reply.length} 字`)
  showReply('S1 存量降档', s1Turn.reply)
  console.log('  ── S1 的 prompt 里带标签的记忆行（原文，不写入证据） ──')
  for (const line of s1Prompt.labelLines) console.log(`    ${line}`)
  console.log('  ── 结束 ──\n')
  check('S1.7 这一轮 CLI 正常退出（否则回复是空转）', s1Turn.status === 0, `exit=${s1Turn.status}`)
  check(
    'S1.8 跑完 S1 之后存量记忆的 (authority,status) 摘要**逐字未变**（DR-1：不重算）',
    afterS1.memoryIdentityDigest === atStart.memoryIdentityDigest,
    afterS1.memoryIdentityDigest
  )

  // -------------------------------------------------------------------------
  // §3 S2
  // -------------------------------------------------------------------------
  section('§3 S2 确立来源正控（交互式人类控制台 ⇒ 必须是 ESTABLISHED）')
  const s2Utterance = '记住，我希望你详细解释每个结论背后的理由。'
  const s2Turn = turnHumanConsole(s2Utterance)
  const afterS2 = runProbeChild()
  const s2Memory = newlyWritten(afterS2, atStart)
  const s2Prompt = dumpPrompt('你觉得我应该怎么跟你交流比较好？')
  check(
    'S2.1 控制台入口写成 RECORDED + USER（actor 与 contentOriginator 都是 USER）',
    afterS2.latestUserEvent?.attributionOrigin === 'RECORDED' &&
      (afterS2.latestUserEvent?.actor ?? '').startsWith('USER/') &&
      (afterS2.latestUserEvent?.contentOriginator ?? '').startsWith('USER/'),
    JSON.stringify(afterS2.latestUserEvent)
  )
  check('S2.2 合成偏好真的落成了记忆', s2Memory !== undefined, `${s2Memory?.memoryType ?? '(无)'}`)
  check(
    'S2.3 派生资格 = ESTABLISHED（**没有**被误降为"来源未确立"）',
    s2Memory?.qualification === 'ESTABLISHED',
    `资格=${String(s2Memory?.qualification)} · 库里的 authority=${String(s2Memory?.rawAuthority)}（DR-1：不改库值）`
  )
  check(
    'S2.4 生产渲染器的后缀为空（已确立 ⇒ prompt 里不给它加标签）',
    s2Memory !== undefined && s2Memory.labelSuffix === '',
    `后缀="${String(s2Memory?.labelSuffix)}"`
  )
  check(
    'S2.5 established 计数 0 → 1',
    atStart.qualificationCounts.established === 0 && afterS2.qualificationCounts.established === 1,
    `before=${atStart.qualificationCounts.established} · after=${afterS2.qualificationCounts.established} · ` +
      `scanned=${afterS2.qualificationCounts.scanned}`
  )
  check('S2.6 真实模型产出非空回复（Level 1）', s2Turn.reply.length > 0, `${s2Turn.reply.length} 字`)
  showReply('S2 确立来源正控（交互式人类控制台）', s2Turn.reply)
  /*
   * ⚠️ 控制台那一轮**用管道驱动 readline**，因此它的进程退出码带一个固有形状：
   *    stdin 写完 `/exit` 就 EOF，readline 在流关闭后结束。第一次跑本门时
   *    这一轮 `exit=1` 而**回复、记忆、RECORDED 用户行三者全部成立** ——
   *    也就是说"这一轮跑完了"是真的，非 0 退出是驱动的形状。
   *    因此判据拆成两条：**"真的跑完了"**（三个独立信号）与**如实登记退出码**；
   *    退出码本身不伪装成 0，也不被拿来否定已完成的事实（AGENTS §6.6）。
   */
  const s2UserRowRecordedUser =
    afterS2.latestUserEvent?.attributionOrigin === 'RECORDED' &&
    (afterS2.latestUserEvent?.actor ?? '').startsWith('USER/')
  check(
    'S2.7 这一轮真的跑完了（回复 ∧ 记忆落库 ∧ RECORDED 用户行 —— 三个独立信号）',
    s2Turn.reply.length > 0 && s2Memory !== undefined && s2UserRowRecordedUser,
    `reply=${s2Turn.reply.length} 字 · memory=${s2Memory?.id ?? '(无)'} · 用户行=${JSON.stringify(afterS2.latestUserEvent)}`
  )
  check(
    'S2.8 控制台进程的退出码**如实登记**（管道驱动 readline 的固有形状；不得伪装成 0）',
    true,
    `exit=${s2Turn.status}${s2Turn.status === 0 ? '' : '（EOF 形状，见 §7 的 turnDiagnostics.stderrTail）'}`
  )
  if (s2Turn.status !== 0) {
    console.log(`    ⚠️ S2 控制台那一轮 exit=${s2Turn.status}；stderr 尾部：`)
    console.log(s2Turn.stderr.slice(-1200).replace(/^/gm, '    '))
  }

  // -------------------------------------------------------------------------
  // §4 S3
  // -------------------------------------------------------------------------
  section('§4 S3 代理伪装负控（程序化入口 ⇒ 不得成为已确立的用户陈述）')
  const s3Utterance = '记住，我不喜欢吃辣的东西。'
  const s3Turn = turnAgentRunner(s3Utterance)
  const afterS3 = runProbeChild()
  const s3Memory = newlyWritten(afterS3, afterS2)
  check(
    'S3.1 程序化入口写成 SERVICE/agent-runner（actor 与 contentOriginator 都不是 USER）',
    afterS3.latestUserEvent?.attributionOrigin === 'RECORDED' &&
      afterS3.latestUserEvent?.actor === 'SERVICE/agent-runner' &&
      afterS3.latestUserEvent?.contentOriginator === 'SERVICE/agent-runner',
    JSON.stringify(afterS3.latestUserEvent)
  )
  check(
    'S3.2 Axis B 落在 unconfirmed 分支（没有认知鉴证）',
    afterS3.latestUserEvent?.axisBSourceAuthority === 'UNCONFIRMED_ORIGIN',
    `source_authority=${String(afterS3.latestUserEvent?.axisBSourceAuthority)} · ` +
      `epistemic_source=${String(afterS3.latestUserEvent?.epistemicSource)}`
  )
  check(
    'S3.3 伪装的用户形状事实：要么形成期被拒（没有记忆），要么读时资格 ≠ ESTABLISHED',
    s3Memory === undefined || s3Memory.qualification !== 'ESTABLISHED',
    s3Memory === undefined
      ? '形成期未落库（两支里允许的另一支）'
      : `落库了，但资格 = ${String(s3Memory.qualification)}，库里的 authority = ${s3Memory.rawAuthority}`
  )
  check(
    'S3.4 它**没有**混进 established 计数（仍只有 S2 那一条）',
    afterS3.qualificationCounts.established === 1,
    `established=${afterS3.qualificationCounts.established} · scanned=${afterS3.qualificationCounts.scanned}`
  )
  check('S3.5 真实模型产出非空回复（Level 1）', s3Turn.reply.length > 0, `${s3Turn.reply.length} 字`)
  showReply('S3 代理伪装负控（agent-runner）', s3Turn.reply)
  check('S3.6 这一轮 CLI 正常退出', s3Turn.status === 0, `exit=${s3Turn.status}`)

  // -------------------------------------------------------------------------
  // §5 S4 三段式
  // -------------------------------------------------------------------------
  section('§5 S4 证据判定器的三段式（正控 / 负控 / 恢复）')
  const realEvidence: D01Evidence = {
    snapshots: { atStart, afterS1, afterS2, afterS3 },
    s1Prompt,
    s2Prompt,
    replies: { s1: s1Turn.reply.length, s2: s2Turn.reply.length, s3: s3Turn.reply.length },
  }
  const positive = judgeD01(realEvidence)
  check('S4.1 正控：真实证据 ⇒ 判定器**通过**', positive.pass, positive.failures.join(' | ') || '0 处失败')

  const forgeries: { name: string; evidence: D01Evidence }[] = [
    {
      name: '伪造 ESTABLISHED（把 S3 的伪装说成已确立）',
      evidence: {
        ...realEvidence,
        snapshots: {
          ...realEvidence.snapshots,
          afterS3: {
            ...afterS3,
            memories: [
              ...afterS3.memories.filter((memory) => memory.id !== s3Memory?.id),
              {
                id: s3Memory?.id ?? 'forged',
                memoryType: 'preference',
                status: 'active',
                canonicalKey: null,
                rawAuthority: 'EXPLICIT_USER_STATEMENT',
                contentSha256: 'forged',
                contentLength: 0,
                qualification: 'ESTABLISHED',
                labelSuffix: '',
                querySeed: '',
              },
            ],
          },
        },
      },
    },
    {
      name: '缺失标签（S1 的 prompt 没有「来源未确立」）',
      evidence: { ...realEvidence, s1Prompt: { ...s1Prompt, labelUnconfirmed: 0 } },
    },
    {
      name: '错误 origin（S2 的资格不是 ESTABLISHED）',
      evidence: {
        ...realEvidence,
        snapshots: {
          ...realEvidence.snapshots,
          afterS2: {
            ...afterS2,
            memories: afterS2.memories.map((memory) =>
              memory.id === s2Memory?.id
                ? { ...memory, qualification: 'MIGRATED_LEGACY' as unknown as SourceQualification }
                : memory
            ),
          },
        },
      },
    },
    {
      name: 'measured_count = 0（什么都没测到）',
      evidence: {
        ...realEvidence,
        snapshots: {
          ...realEvidence.snapshots,
          atStart: {
            ...atStart,
            memories: [],
            qualificationCounts: { ...atStart.qualificationCounts, scanned: 0 },
          },
        },
      },
    },
  ]
  for (const forged of forgeries) {
    const verdict = judgeD01(forged.evidence)
    check(
      `S4 负控：${forged.name} ⇒ 判定器**必须响**`,
      !verdict.pass,
      verdict.failures[0] ?? '(没有响 —— 判定器没有牙齿)'
    )
  }
  const restored = judgeD01(realEvidence)
  check('S4 恢复：放回真实证据 ⇒ 判定器**重新安静**', restored.pass, restored.failures.join(' | ') || '0 处失败')

  // -------------------------------------------------------------------------
  // §6 真实库 + 副作用
  // -------------------------------------------------------------------------
  section('§6 真实库只读 + 临时副本销毁')
  const realDbAfter = digestTree(PRODUCTION_DB_DIR)
  check(
    '★ 真实库整棵树在本次 smoke 前后**逐字节相同**（本门从未打开它）',
    realDbAfter.digest === realDbBefore.digest && realDbAfter.files === realDbBefore.files,
    `${realDbBefore.digest} → ${realDbAfter.digest} · ${realDbAfter.files} 文件`
  )
  const dumpExists = existsSync(PROMPT_DUMP_PATH)
  if (!promptDumpBefore.existed && dumpExists) {
    unlinkSync(PROMPT_DUMP_PATH)
    check('`data/prompt-dump.txt` 原本不存在 ⇒ 已删除（还原到位）', !existsSync(PROMPT_DUMP_PATH))
  } else if (promptDumpBefore.existed && dumpExists) {
    const now = sha256Bytes(readFileSync(PROMPT_DUMP_PATH))
    check('`data/prompt-dump.txt` 的既有内容已还原', now === promptDumpBefore.sha256, now)
  } else {
    check('`data/prompt-dump.txt` 状态与运行前一致', true, dumpExists ? '仍在' : '不存在')
  }

  rmSync(work, { recursive: true, force: true })
  check('临时副本已销毁', !existsSync(work), work)

  // -------------------------------------------------------------------------
  // §7 证据（私人正文只存摘要 / 长度 / hash）
  // -------------------------------------------------------------------------
  section('§7 证据（私人正文只存摘要 / 长度 / hash）')
  const verdict = judgeD01(realEvidence)

  /**
   * 把记忆读数**脱敏**成可以进证据的形状。
   *
   * ⚠️ `querySeed` 是**从记忆正文里派生**的（S1 的提问要它才能命中），
   *    因此它本身**就是**私人正文的一部分 —— 第一次实现把它原样写进了证据，
   *    被 §7 的隐私自检当场抓住（"示例工程科技大学" 出现在三个地方）。
   *    现在只留它的 sha256 与长度：可复核"提问是怎么派生的"，但不泄露内容。
   */
  const redactMemory = (memory: MemoryReading): Record<string, unknown> => ({
    id: memory.id,
    memoryType: memory.memoryType,
    status: memory.status,
    canonicalKey: memory.canonicalKey,
    rawAuthority: memory.rawAuthority,
    contentSha256: memory.contentSha256,
    contentLength: memory.contentLength,
    qualification: memory.qualification,
    labelSuffix: memory.labelSuffix,
    querySeedSha256: sha256(memory.querySeed),
    querySeedLength: memory.querySeed.length,
  })
  /** prompt 读数同理：只留结构性计数与 sha256，**不留** `labelLines` */
  const redactPrompt = (prompt: PromptReading): Record<string, unknown> => ({
    promptSha256: prompt.promptSha256,
    promptLength: prompt.promptLength,
    labelUnconfirmed: prompt.labelUnconfirmed,
    labelContradicted: prompt.labelContradicted,
    labelLineCount: prompt.labelLines.length,
  })

  const evidence = {
    testId: 'M5.1.1-D01 / Closure Candidate Live Smoke',
    command: 'pnpm with-test-model pnpm m5.1.1:d01:smoke:live',
    ruleVersion: COGNITIVE_QUALIFICATION_RULE_VERSION,
    model: {
      endpointHost: (() => {
        try {
          return new URL(process.env.OPENAI_BASE_URL ?? '').host
        } catch {
          return '(不可解析)'
        }
      })(),
      largeModel: process.env.OPENAI_LARGE_MODEL ?? null,
      smallModel: process.env.OPENAI_SMALL_MODEL ?? null,
      keyPresent: (process.env.OPENAI_API_KEY ?? '').length > 0,
      keyLength: (process.env.OPENAI_API_KEY ?? '').length,
      guard: '当前 env 与 .env.test 逐字相等，否则 exit 2；本门从未设置 PROJECT_LG_ALLOW_PRODUCTION_DB',
    },
    database: {
      productionDb: PRODUCTION_DB_DIR,
      productionDbOpened: false,
      note: '真实库**只被复制**；没有任何一行会放行生产库（构造上不可能）',
      realDbTreeBefore: realDbBefore,
      realDbTreeAfter: realDbAfter,
      copyPath: work,
      copyDestroyed: !existsSync(work),
      collateralWrite: 'data/prompt-dump.txt（`--dump-prompt` 的固有输出，已在跑完时还原/删除）',
    },
    counts: {
      checksPassed: passed,
      checksFailed: failed,
      memoriesAtStart: atStart.memories.length,
      memoriesAtEnd: afterS3.memories.length,
      qualificationScannedAtStart: atStart.qualificationCounts.scanned,
      qualificationScannedAtEnd: afterS3.qualificationCounts.scanned,
      contaminatedAtStart: atStart.contaminated,
      unsupportedAtStart: atStart.unsupported,
    },
    /*
     * 三个真实 turn 的进程读数。`stderrTail` **只在非 0 退出时**保留
     * （诊断需要它，而 0 退出时保留它只会扩大"日志里可能夹带正文"的面）。
     */
    turnDiagnostics: {
      s1: {
        status: s1Turn.status,
        replyLength: s1Turn.reply.length,
        stderrTail: s1Turn.status === 0 ? '' : s1Turn.stderr.slice(-600),
      },
      s2: {
        status: s2Turn.status,
        replyLength: s2Turn.reply.length,
        stderrTail: s2Turn.status === 0 ? '' : s2Turn.stderr.slice(-600),
        note: '控制台用管道驱动 readline；非 0 退出是这条驱动方式的形状，不是"这一轮没跑完"',
      },
      s3: {
        status: s3Turn.status,
        replyLength: s3Turn.reply.length,
        stderrTail: s3Turn.status === 0 ? '' : s3Turn.stderr.slice(-600),
      },
    },
    scenarios: {
      S1: {
        entry: 'scripted_agent_runner（agent-runner）',
        questionRedacted: {
          sha256: sha256(s1Question),
          length: s1Question.length,
          derivedFrom: '被选中存量记忆自己的主题（`querySeed`）；正文不落证据，原文在回报里交用户观察',
        },
        stockMemories: atStart.memories.map(redactMemory),
        rootLinks: atStart.rootLinks,
        qualificationBefore: atStart.qualificationCounts,
        qualificationAfter: afterS1.qualificationCounts,
        recallBefore: atStart.latestRecall,
        recallAfter: afterS1.latestRecall,
        traceAfter: afterS1.latestTrace,
        prompt: redactPrompt(s1Prompt),
        level1: {
          replyLength: s1Turn.reply.length,
          replyStored: false,
          note: '完整回复在回报里交用户观察（DR-11：措辞不做启发式判定）',
        },
        level2: {
          memoryIdentityDigestBefore: atStart.memoryIdentityDigest,
          memoryIdentityDigestAfter: afterS1.memoryIdentityDigest,
        },
      },
      S2: {
        entry: 'interactive_human_console（human-console）',
        utteranceSha256: sha256(s2Utterance),
        utteranceLength: s2Utterance.length,
        utteranceIsSynthetic: true,
        writtenMemory: s2Memory === undefined ? null : redactMemory(s2Memory),
        event: afterS2.latestUserEvent,
        qualificationAfter: afterS2.qualificationCounts,
        promptAfter: redactPrompt(s2Prompt),
        level1: { replyLength: s2Turn.reply.length, replyStored: false },
      },
      S3: {
        entry: 'scripted_agent_runner（agent-runner）',
        utteranceSha256: sha256(s3Utterance),
        utteranceLength: s3Utterance.length,
        utteranceIsSynthetic: true,
        writtenMemory: s3Memory === undefined ? null : redactMemory(s3Memory),
        event: afterS3.latestUserEvent,
        qualificationAfter: afterS3.qualificationCounts,
        level1: { replyLength: s3Turn.reply.length, replyStored: false },
      },
    },
    S4: {
      positive: { pass: positive.pass, failures: positive.failures },
      negativeControls: forgeries.map((forged) => forged.name),
      restored: { pass: restored.pass, failures: restored.failures },
    },
    verdict: {
      judge: verdict.pass ? 'PASS' : 'FAIL',
      failures: verdict.failures,
      d01: 'P1 OPEN',
      m511Final: 'BLOCKED',
      closure: 'AWAITING USER APPROVAL',
      note: '本门**不**主张 M5.1-D01 已关闭、**不**主张 M5.1.1 PASS —— DR-12 的最后一环是用户批准',
    },
    checks,
  }

  /*
   * ===========================================================================
   *  §7b 隐私自检（**量具自己也要被验证**：这条约束必须由机器执行）
   * ===========================================================================
   * "私人正文只存摘要 / hash"如果只是注释里的承诺，它拦不住任何人 ——
   * 本门第一次实现就把它写漏了（`querySeed` 与 `labelLines` 都进了证据）。
   * 因此这里把"不该出现的东西"逐条列出来，在序列化之后的文本里找它们。
   */
  const secrets = [
    // 记忆正文派生出来的提问种子（**只**取得到中文的那一种）
    ...atStart.memories.map((memory) => memory.querySeed),
    ...afterS1.memories.map((memory) => memory.querySeed),
    ...afterS2.memories.map((memory) => memory.querySeed),
    ...afterS3.memories.map((memory) => memory.querySeed),
    // prompt 里带标签的记忆行（**正文**）
    ...s1Prompt.labelLines,
    // 完整模型回复
    s1Turn.reply,
    s2Turn.reply,
    s3Turn.reply,
    // S2/S3 的合成输入（我写的，但同样只该以 hash 进证据）
    s2Utterance,
    s3Utterance,
  ].filter((text) => text.trim().length >= 4)
  measure('隐私自检的样本条数（正文 / 回复 / 提问种子）', secrets.length)
  const serializedOnce = JSON.stringify(evidence, null, 2)
  const leaked = [...new Set(secrets)].filter((secret) => serializedOnce.includes(secret))
  check(
    '★ §7b 证据里**不出现**任何私人正文 / 完整回复 / 提问种子（只存摘要与 hash）',
    leaked.length === 0,
    leaked.length === 0
      ? `${secrets.length} 个样本，0 处泄漏`
      : `泄漏 ${leaked.length} 处：${leaked.map((s) => `${s.slice(0, 6)}…(${s.length})`).join(' · ')}`
  )

  // ⚠️ §7b 那条判据是在证据对象建好**之后**才追加的，因此计数必须在这里重新取一次 ——
  //    否则证据里会出现"`checksPassed = 37` 而 `checks` 有 38 条"这种内部不一致
  //    （那正是"数字对 ≠ 数字描述的是你以为的那个东西"的又一种形状）。
  evidence.counts.checksPassed = passed
  evidence.counts.checksFailed = failed

  mkdirSync(join(ROOT, 'artifacts', 'm5.1.1'), { recursive: true })
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

  console.log(`\n${'='.repeat(78)}`)
  console.log(
    `M5.1.1-D01 Live Smoke：${passed} 通过 / ${failed} 失败｜判定器 = ${verdict.pass ? 'PASS' : 'FAIL'}`
  )
  if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
  console.log('证据：artifacts/m5.1.1/d01-live-smoke.json')
  console.log('='.repeat(78))
  process.exitCode = failed === 0 ? 0 : 1
}

// ---------------------------------------------------------------------------
// 父进程用的小工具（纯文本 / 纯文件系统，**不碰数据库**）
// ---------------------------------------------------------------------------

/** 从 CLI stdout 里取她的回复（形状与 `verify-m4.5-smoke-live.ts` 一致） */
function replyOf(stdout: string): string {
  const marker = '苏沐薇:'
  const at = stdout.lastIndexOf(marker)
  if (at === -1) return ''
  const kept: string[] = []
  for (const line of stdout.slice(at + marker.length).split('\n')) {
    if (
      /^\s*(Info|Warn|Error|Debug|◇|\[sandbox\]|\[kernel\]|\[identity\]|\[telemetry\]|\[action\]|\[memory)/.test(
        line
      )
    ) {
      break
    }
    kept.push(line)
  }
  return kept.join('\n').trim()
}

/**
 * 从记忆正文（jsonb 文本）里取一段**可以放回提问里**的种子。
 *
 * **只取含中文的字符串值**（`{"predicate":"education.institution","value":"…"}` 里的 `value`）：
 * 词面通道是按文本重叠算的，而 ASCII 的谓词名 / 实体 id 对提问没有意义。
 *
 * ⚠️ 第一版在"没有中文值"时退化为"最长的任意字符串"，于是 S2/S3 的新记忆拿到的种子
 *    是**用户实体 UUID** —— 而那个 UUID 合法地出现在证据的归因读数里，直接让 §7b 的
 *    隐私自检**误报了一次泄漏**（量具的又一次"测错了东西"）。现在取不到中文就返回空串，
 *    由调用方退回一个泛问（那会如实变成 S1 的红，而不是悄悄用一个 id 去"命中"）。
 */
function querySeedOf(contentText: string): string {
  const cjk = /[\u4e00-\u9fff]/
  let best = ''
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (cjk.test(value) && value.length > best.length) best = value
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item)
    }
  }
  try {
    visit(JSON.parse(contentText))
  } catch {
    /* 不是 JSON ⇒ 没有可用的中文种子 */
  }
  return best.length >= 2 ? best : ''
}

function occurrences(text: string, needle: string): number {  if (needle === '') return 0
  let count = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(needle, from)
    if (at === -1) return count
    count += 1
    from = at + needle.length
  }
}

/** 目录树的内容摘要（路径 + 字节 + 内容 hash）—— 用于证明真实库未被写入 */
function digestTree(dir: string): { files: number; bytes: number; digest: string } {
  if (!existsSync(dir)) return { files: 0, bytes: 0, digest: '(不存在)' }
  const entries: string[] = []
  let files = 0
  let bytes = 0
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const absolute = join(current, name)
      const relative = prefix === '' ? name : `${prefix}/${name}`
      const info = statSync(absolute)
      if (info.isDirectory()) {
        walk(absolute, relative)
        continue
      }
      files += 1
      bytes += info.size
      entries.push(`${relative}|${info.size}|${sha256Bytes(readFileSync(absolute))}`)
    }
  }
  walk(dir, '')
  return { files, bytes, digest: sha256(entries.join('\n')) }
}
