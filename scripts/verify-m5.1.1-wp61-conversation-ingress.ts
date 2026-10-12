/**
 * M5.1.1 WP6.1 —— **Production Conversation Attribution Ingress Closure / K-28**
 * （`pnpm m5.1.1:wp6.1:verify`）
 *
 * ============================================================================
 *  它证明的是什么（逐条对应 WP6.1 任务书 §1–§12）
 * ============================================================================
 *
 *  §1 清单：`src/` 里**每一个**生产对话写入者 / `appendConversationEvent` 调用点
 *     都被分类（PRODUCTION_ACTIVE / LEGACY_COMPAT_ONLY / TEST_ONLY /
 *     DEAD·UNREACHABLE）；新增一个未分类的写入者会让本门变红。
 *      基线（WP6 实测）：生产侧 `buildTrustedAttributionContext()` 构造者 = **0**。
 *      本门断言它 **> 0**，并且**不是**在 verifier 里造的。
 *  §2 受信边界：三个具名工厂（无角色参数、arity = 0）；手写对象 / 结构克隆 /
 *      JSON 往返的上下文**写不进去**；夹带归因字段的事实对象被拒；
 *      同一族两个生产者 → 拒绝（歧义）；不存在 `role` / `ingress` 这类可填枚举。
 *  §3 人类 ingress：真实 `TurnGateway.beginTurn` → 写时 == DB == 回读 == Query DTO，
 *     且 `family=user_message` / `actor_type=user` / `Known(USER/<id>)` ×2 /
 *     `RECORDED` / Axis B **confirmed**（有 `authenticated_human_input` 鉴证）。
 *  §4 agent-as-user **生产 D01 控制**：同一个入口、同一个族，权威槽位是
 *     `Known(SERVICE/agent-runner)` ×2、Axis B **unconfirmed**（`UNCONFIRMED_ORIGIN` ×2），
 *     且**任何**槽位都不是 USER —— 表面身份不足以建立认知资格。
 *  §5 她的输出：真实 `completeTurn` → `Known(CHARACTER/<canonical>)` + confirmed；
 *     呈现位次对不上 canonical ⇒ 抛；呈现位次缺失 ⇒ `Unknown(RUNTIME_UNRESOLVED)`。
 *  §6 工具 / 系统族：生产侧**没有**调用点 ⇒ 不接线、不发明入口（如实记 legacy）。
 *  §7 端到端（**不是 store-only**）：真实 ingress → 受信上下文 → `createConversationEvent`
 *     → store → DB → 回读 → 开发者查询（trace DTO）。四份读数逐字段相等。
 *  §8 K-27 跨账本保持：动作 `initiator` 与对话 `actor`/`contentOriginator` 一致，
 *     且**没有**任何读侧面把 D01 说成 USER。
 *  §9 兼容与三段式：legacy 路径（不接线）逐字不变（`attribution_origin` 仍为 NULL）；
 *     正控（接线 ⇒ RECORDED）→ 负控（伪造 ⇒ 被拒）→ 恢复（拆掉接线 ⇒ 回到 legacy ⇒
 *     再接上 ⇒ 又是 RECORDED）。
 *  §10 认知面**未动**（实测而不是断言）：Fact Firewall / `canSupportExternalFact` /
 *     `authorityFromSource` / `evidenceProfileOf`（extractor 的推导）/ Recall /
 *     ADR-043（`UNCONFIRMED_ORIGIN` 仍无晋级路径）/ Phase 4 / Developer Control。
 *  §11 schema 边界：v8、0007/0008 指纹逐字未变、没有 v9、真实库从未被打开。
 *
 * ⚠️ 本门**不主张**什么（先说清，免得被读大）：
 *   · 它**不**运行 `src/main.ts` 本身 —— 那会打开真实库（AGENTS §3 的冻结区）。
 *     生产装配的那**一行**（`attribution: conversationAttributionForEntryMode(this.entryMode).producers`）
 *     由 §1 的**静态**断言钉住（共享装配函数 / 入口模式唯一判定点 / `entryMode` 必填 /
 *     6 个构造点全传），而运行期行为由本门用**同一个**装配函数 + 同形状的 recorder 证明。
 *   · 它**不**主张"模型那一跳被验证过"：本门不调模型，回复文本由 `completeTurn({ replyText })`
 *     喂入（与 M5/M5.1 门的既有做法一致）。它验的是**归因写入链路**，不是模型质量。
 *   · 它**不**主张真实库现在已经是 RECORDED：真实库的既有行仍是 legacy（本步没动真库）。
 *
 * ⚠️ 已知偏差（**如实登记，不悄悄改判据**）：生产链路一旦接了人类 ingress，
 *    回复确认的用户事件其 `source_authority` 由 legacy 的 `USER_REPLY_CONFIRMATION`
 *    变为 RECORDED Axis B 的 `USER_EXPLICIT`（K-25 的 builder 在 confirmed 分支上
 *    只产出 `defaultAuthorityForKind(source_kind)`）。两者在
 *    `authorityFromSource` 里映射到**同一个** MemoryAuthority，`canEvidenceExternalFact`
 *    与 `evidenceProfileOf` 都不读行上的该列 ⇒ **认知面不变**（§10 实测）。
 *    本门把它作为**测量结果**记下来（§9），而不是假装没发生。
 *    （可达性：生产录制路径**不给用户事件带 reply graph** ⇒ 该偏差在生产里今天不可达；
 *      门里有静态断言证明这一点。）
 *
 * 跑法：pnpm m5.1.1:wp6.1:verify
 */

import 'dotenv/config'

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import {
  AGENT_RUNNER_SERVICE_ID,
  conversationAttributionForEntryMode,
  conversationEntryModeOf,
  createAgentRunnerUserTurnIngress,
  createCharacterAssistantTurnIngress,
  createHumanConsoleUserTurnIngress,
  indexConversationIngress,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import { ConversationRecorder } from '../src/infrastructure/runtime/conversation-recorder.ts'
import { TurnGateway } from '../src/kernel/app/turn-gateway.ts'
import {
  ATTRIBUTION_SLOT_COLUMNS,
  attributionSlotsOfContext,
  buildTrustedAttributionContext,
  type AttributionValueSlot,
  type ConversationFamily,
  type TrustedAttributionContext,
} from '../src/kernel/contracts/attribution.ts'
import type { PrincipalRef } from '../src/kernel/contracts/actor.ts'
import {
  canEvidenceExternalFact,
  createConversationEvent,
} from '../src/kernel/contracts/conversation-event.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'
import {
  asActionId,
  asCharacterId,
  asConversationEventId,
  asConversationId,
  asTraceId,
} from '../src/kernel/contracts/ids.ts'
import {
  authorityFromSource,
  type MemoryAuthority,
} from '../src/kernel/contracts/memory.ts'
import type { DeveloperAttributionDto } from '../src/kernel/contracts/developer-query.ts'
import { evidenceProfileOf } from '../src/kernel/app/memory/extractor.ts'
import {
  DEFAULT_GRANTED_PERMISSIONS,
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
} from '../src/kernel/action/capability-registry.ts'
import { createActionIntentDetector } from '../src/kernel/action/intent-detector.ts'
import { createActionTurnPort } from '../src/kernel/action/action-turn.ts'
import { createActionGateway } from '../src/kernel/action/gateway.ts'
import type { ActionTarget } from '../src/kernel/action/action-request.ts'
import { createEchoAdapter } from '../src/infrastructure/action/adapters/echo.ts'
import { createActionLedgerStore } from '../src/infrastructure/action/action-ledger-store.ts'
import {
  getConversationEvent,
  readConversationEventAttribution,
} from '../src/infrastructure/persistence/conversation-store.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
import { currentSchemaVersion, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'
import { PRODUCTION_DB_DIR, isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'
import { createM4Harness } from './m4-harness.ts'

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
}
function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}
function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}
const json = (value: unknown): string => JSON.stringify(value)
const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')

const ROOT = process.cwd()
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.1.1')

console.log('='.repeat(74))
console.log('M5.1.1 WP6.1 —— Production Conversation Attribution Ingress Closure（K-28）')
console.log('='.repeat(74))

// ===========================================================================
section('§0 环境与边界（沙箱 / 真实库只读 / schema v8）')
// ===========================================================================

const sandbox = isolateDatabase('m5.1.1-wp61')
check(
  '沙箱不是真实库',
  isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()),
  sandbox.dir
)
check(
  '真实库路径只被记录，从未被本脚本打开',
  PRODUCTION_DB_DIR.endsWith(join('data', 'pglite')) && process.env.PGLITE_DATA_DIR !== PRODUCTION_DB_DIR,
  PRODUCTION_DB_DIR
)

const h = await createM4Harness({ label: 'wp61' })
const db = h.db
const characterId = h.kernel.characterId
const userId = h.userId
const schemaVersion = await currentSchemaVersion(db)
check(
  '沙箱库 schema = v9（WP6.1 本身无 schema 变更；v9 是 WP9-B1 的 state_events 承载）',
  schemaVersion === 9,
  `v${schemaVersion}`
)

const fingerprint = (version: number): string => {
  const migration = MIGRATIONS.find((m) => m.version === version)!
  return createHash('sha256').update(migration.statements.join('\n'), 'utf8').digest('hex')
}
check(
  'MIGRATION_0007 逐字未改',
  fingerprint(7) === '2d51997dc620ff01f87bcf8784c15985c6d6d9d2a4b978809db5f8dbc7c07613',
  fingerprint(7).slice(0, 16)
)
check(
  'MIGRATION_0008 逐字未改',
  fingerprint(8) === '0a2bd4fe470ac5ce4d4a42717fbd799d9ddb570c4d360f34bc17b580e0538e29',
  fingerprint(8).slice(0, 16)
)
check(
  '代码里的迁移清单 = 1..9（WP6.1 本身无 schema 变更；0009 = WP9-B1 的 state_events 承载，' +
    '原判据"没有出现 MIGRATION_0009"按 R-45 的新事实改写，未放宽）',
  MIGRATIONS.map((m) => m.version).join(',') === '1,2,3,4,5,6,7,8,9' &&
    MIGRATIONS.find((m) => m.version === 9)?.name === 'm5.1.1-state-events-attribution',
  MIGRATIONS.map((m) => m.version).join(',')
)

const query = createDeveloperQueryService({
  db,
  characterId,
  owner: entityRef('character', String(characterId)),
  runtimeId: 'runtime-wp61',
})

// ===========================================================================
section('§1 生产对话写入者清单 + 静态探测器（任务书 §1 / §9）')
// ===========================================================================

function srcFiles(): string[] {
  const out: string[] = []
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
  }
  visit(join(ROOT, 'src'))
  return out
}
const SRC_FILES = srcFiles()
measure('扫描的 src 文件数', SRC_FILES.length)

/**
 * 分类表（**冻结**）：每个写入者一条，附"为什么它是这一类"。
 *
 * 新增一个生产写入者而不登记 ⇒ 本门变红（任务书 §9 的静态探测器）。
 */
const FROZEN_WRITERS: Readonly<
  Record<string, { category: 'PRODUCTION_ACTIVE' | 'LEGACY_COMPAT_ONLY' | 'TEST_ONLY'; reason: string }>
> = {
  'src/infrastructure/persistence/conversation-store.ts': {
    category: 'LEGACY_COMPAT_ONLY',
    reason:
      '唯一的 `insert into conversation_events`（K-23 的结构性事实）；它**是**低层原语，' +
      '不是生产业务写入者 —— 生产必须经 ledger 端口。',
  },
  'src/infrastructure/persistence/ledger.ts': {
    category: 'PRODUCTION_ACTIVE',
    reason:
      '生产账本端口：`appendUserStatement` / `appendCharacterOutput` 两个族**已接线**受信归因' +
      '（族 → 生产 ingress → `trustedAttribution`）。',
  },
  'src/infrastructure/persistence/backfill.ts': {
    category: 'LEGACY_COMPAT_ONLY',
    reason:
      'M1/M2 遗留镜像 → 账本的回填（`--backfill-events`）：它重建的是**历史**，' +
      '没有"当时谁提供了内容"的证据 ⇒ 刻意不写归因（写了就是伪造）。',
  },
  'src/kernel/app/turn-gateway.ts': {
    category: 'PRODUCTION_ACTIVE',
    reason:
      '生产用户轮次的调用点（`recorder.recordUserMessage`）+ K-27 的因果来源传递；' +
      '它自己不构造归因（归因由 recorder → ledger → ingress 建立）。',
  },
  'src/infrastructure/runtime/conversation-intent-resolver.ts': {
    category: 'PRODUCTION_ACTIVE',
    reason:
      '生产助手事件的调用点（`recorder.recordAssistantMessageOutcome`）：' +
      '`CharacterIntent` → 一条 assistant 事件。',
  },
  'src/infrastructure/runtime/conversation-recorder.ts': {
    category: 'PRODUCTION_ACTIVE',
    reason:
      '录制端口：转发生产 ingress 的受信归因；`recordSystemEvent` / `recordToolOutput` ' +
      '在 `src/` 里**没有**生产调用点（见 §6）。',
  },
}

const WRITER_PATTERNS = [
  { label: 'appendConversationEvent 调用点', pattern: /appendConversationEvent\s*\(/ },
  {
    label: 'recorder 写入方法调用点',
    pattern:
      /\.(recordUserMessage|recordAssistantMessageOutcome|recordAssistantMessage|recordSystemEvent|recordToolOutput)\s*\(/,
  },
  { label: 'createConversationLedger 调用点', pattern: /createConversationLedger\s*\(/ },
] as const

const discoveredWriters = new Set<string>()
const writerEvidence: { file: string; pattern: string }[] = []
for (const file of SRC_FILES) {
  const relativePath = file.replace(ROOT, '').replace(/\\/g, '/').replace(/^\/+/, '')
  const code = codeOnly(readFileSync(file, 'utf8'))
  for (const item of WRITER_PATTERNS) {
    if (!item.pattern.test(code)) continue
    discoveredWriters.add(relativePath)
    writerEvidence.push({ file: relativePath, pattern: item.label })
  }
}
measure('发现的对话写入者文件数', discoveredWriters.size)
const unclassifiedWriters = [...discoveredWriters].filter((file) => FROZEN_WRITERS[file] === undefined)
check(
  '★ §1 每一个生产对话写入者都被分类（新增未登记的写入者 ⇒ 本门变红）',
  unclassifiedWriters.length === 0 && discoveredWriters.size > 0,
  unclassifiedWriters.join(', ') || `${discoveredWriters.size} 个全部已分类`
)
const staleWriters = Object.keys(FROZEN_WRITERS).filter((file) => !discoveredWriters.has(file))
check(
  '分类表里没有**已经不存在**的写入者（清单与代码同步）',
  staleWriters.length === 0,
  staleWriters.join(', ') || 'AA'
)
const productionActive = Object.entries(FROZEN_WRITERS)
  .filter(([, item]) => item.category === 'PRODUCTION_ACTIVE')
  .map(([file]) => file)
measure('PRODUCTION_ACTIVE 写入者数', productionActive.length)

// --- K-28 的核心计数：生产侧的受信归因构造者（契约之外） ---------------------
const attributionProducers = SRC_FILES.filter((file) => {
  const relativePath = file.replace(ROOT, '').replace(/\\/g, '/')
  if (relativePath.includes('/kernel/contracts/')) return false
  return /buildTrustedAttributionContext\s*\(/.test(codeOnly(readFileSync(file, 'utf8')))
}).map((file) => file.replace(ROOT, '').replace(/\\/g, '/').replace(/^\/+/, ''))
const producerCount = measure(
  '★ 生产侧构造受信**对话**归因的文件数（WP6 基线 = 0 ⇒ K-28）',
  attributionProducers.length
)
check(
  '★ K-28 闭合：生产侧真的**有**受信对话归因的构造者（不是 verifier 里造的）',
  producerCount > 0 &&
    attributionProducers.every((file) => file.startsWith('src/')) &&
    !attributionProducers.some((file) => file.startsWith('scripts/') || file.startsWith('evals/')),
  attributionProducers.join(', ') || '(无)'
)
const ingressModule = 'src/infrastructure/runtime/conversation-attribution.ts'
check(
  '★ 唯一的对话 ingress 装配模块在 src/ 里（生产代码，不是脚本）',
  attributionProducers.length === 1 && attributionProducers[0] === ingressModule,
  attributionProducers.join(', ')
)

// --- 接线是**生产装配**里的（main.ts），而不是"某个测试里" ---------------------
const mainSource = codeOnly(readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8'))
check(
  '★ 生产装配 `src/main.ts` 用共享的装配函数接线（而不是自己拼一份归因）',
  /conversationAttributionForEntryMode\(/.test(mainSource) &&
    /attribution:\s*conversationAttributionForEntryMode\(/.test(mainSource),
  'AA'
)
check(
  '★ 入口模式由**真实进程事实**推导（`conversationEntryModeOf(argv)`），且只有一处调用',
  /conversationEntryModeOf\(argv\)/.test(mainSource) &&
    mainSource.split('conversationEntryModeOf(argv)').length - 1 === 1,
  `${mainSource.split('conversationEntryModeOf(argv)').length - 1} 处`
)
check(
  '`ChatSession` 的入口模式**必填**（没有缺省值 ⇒ 不存在"悄悄以另一个入口身份记账"）',
  /entryMode: ConversationEntryMode/.test(readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8')) &&
    !/entryMode\?: ConversationEntryMode/.test(readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8')),
  'AA'
)
const entryModeSites = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8').match(/new ChatSession\(/g) ?? []
const entryModeArgs = readFileSync(join(ROOT, 'src', 'main.ts'), 'utf8').match(/new ChatSession\(runtime, userName, \{ entryMode/g) ?? []
measure('main.ts 里 ChatSession 构造点数', entryModeSites.length)
check(
  '每一个 `ChatSession` 构造点都显式传入了入口模式',
  entryModeSites.length === entryModeArgs.length && entryModeSites.length > 0,
  `${entryModeArgs.length}/${entryModeSites.length}`
)

// ===========================================================================
section('§1b 方法级清单：每一个**写入方法**都被分类（任务书 §1 / §9 的"每一个写入者"）')
// ===========================================================================

/*
 * 文件级清单（上面）回答"哪个文件会写"；这一节回答"**哪一个写入方法**会写、它可不可达"。
 *
 * 三类被自动发现（不是手写清单）：
 *   ① recorder 的写入方法（`ConversationRecorder` 里的 `async record*`）
 *   ② 账本端口方法（`createConversationLedger` 返回对象里的 `async append*`）
 *   ③ 低层原语 `appendConversationEvent` 的调用点
 *
 * 分类不是自由的：`append*` 的分类由"**唯一**调用它的 recorder 方法在哪一段方法体里"
 * **推导**出来（而不是另写一个断言），因此不会出现"表和代码各说一套"。
 */
const RECORDER_PATH = join(ROOT, 'src', 'infrastructure', 'runtime', 'conversation-recorder.ts')
const LEDGER_PATH = join(ROOT, 'src', 'infrastructure', 'persistence', 'ledger.ts')
const STORE_PATH = join(ROOT, 'src', 'infrastructure', 'persistence', 'conversation-store.ts')
const recorderSource = readFileSync(RECORDER_PATH, 'utf8')
const ledgerSource = readFileSync(LEDGER_PATH, 'utf8')

/** `ConversationRecorder` 的每个 `async record*` 方法体（按 `\n  async ` 切段，包含关系精确） */
const recorderBodiesOf = (source: string): Map<string, string> => {
  const bodies = new Map<string, string>()
  for (const segment of source.split(/\n {2}async /).slice(1)) {
    const name = segment.slice(0, segment.indexOf('(')).trim()
    if (/^[A-Za-z][A-Za-z0-9]*$/.test(name)) bodies.set(name, segment)
  }
  return bodies
}
/** 从源码文本里**发现** recorder 的写入方法（纯函数：负控要对合成文本跑同一套逻辑） */
const discoverRecorderWriters = (source: string): string[] =>
  [...recorderBodiesOf(source).keys()].filter((name) => /^record[A-Z]/.test(name)).sort()
/** 从源码文本里**发现**账本端口方法 */
const discoverPortWriters = (source: string): string[] =>
  [...source.matchAll(/\n\s+async (append[A-Z][A-Za-z0-9]*)\(/g)].map((match) => match[1]!).sort()

const recorderBodies = recorderBodiesOf(recorderSource)
const recorderWriters = discoverRecorderWriters(recorderSource)
/** `.name(` 形式的**调用点**（不是类型声明：接口签名没有点前缀） */
const dotCallsites = (name: string, excludePath: string): string[] =>
  SRC_FILES.filter((file) => file !== excludePath)
    .filter((file) => new RegExp(`\\.${name}\\s*\\(`).test(codeOnly(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(ROOT, '').replace(/\\/g, '/').replace(/^\/+/, ''))
/**
 * 直接调用形式（`name(`）—— 给**裸函数**用（`appendConversationEvent` 是 import 进来的函数，
 * 不是方法）。排除定义文件后，剩下的就是调用点；`import { name }` 那种行没有 `(` 紧跟，不会命中。
 */
const plainCallsites = (name: string, excludePath: string): string[] =>
  SRC_FILES.filter((file) => file !== excludePath)
    .filter((file) => new RegExp(`\\b${name}\\s*\\(`).test(codeOnly(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(ROOT, '').replace(/\\/g, '/').replace(/^\/+/, ''))

type WriterClass = 'PRODUCTION_ACTIVE' | 'LEGACY_COMPAT_ONLY' | 'TEST_ONLY' | 'DEAD / UNREACHABLE'

const RECORDER_WRITERS: Readonly<
  Record<string, { family?: ConversationFamily; classification: WriterClass; reason: string }>
> = {
  recordUserMessage: {
    family: 'user_message',
    classification: 'PRODUCTION_ACTIVE',
    reason: '`turn-gateway.beginTurn` 写出本轮用户事件（生产的唯一用户入口）',
  },
  recordAssistantMessageOutcome: {
    family: 'assistant_message',
    classification: 'PRODUCTION_ACTIVE',
    reason: '`conversation-intent-resolver` 写出她的输出（生产的唯一助手入口）',
  },
  recordAssistantMessage: {
    family: 'assistant_message',
    classification: 'TEST_ONLY',
    reason: '生产零调用点；只是 `recordAssistantMessageOutcome` 的兼容 wrapper（脚本/夹具用）',
  },
  recordSystemEvent: {
    classification: 'DEAD / UNREACHABLE',
    reason: '全仓库零调用点（生产侧刻意不接：没有真实 producer —— §6）',
  },
  recordToolOutput: {
    classification: 'DEAD / UNREACHABLE',
    reason: '全仓库零调用点（同上：工具事件的生产 producer 尚不存在）',
  },
}

const discoveredRecorderWriters = recorderWriters
measure('发现的 recorder 写入方法数', discoveredRecorderWriters.length)
const unclassifiedRecorderWriters = discoveredRecorderWriters.filter(
  (name) => RECORDER_WRITERS[name] === undefined
)
check(
  '★ §1b 每一个 recorder 写入方法都被分类（新增一个写入方法而不登记 ⇒ 本门变红）',
  unclassifiedRecorderWriters.length === 0 && discoveredRecorderWriters.length > 0,
  unclassifiedRecorderWriters.join(', ') || `${discoveredRecorderWriters.length} 个全部已分类`
)
const staleRecorderWriters = Object.keys(RECORDER_WRITERS).filter(
  (name) => !discoveredRecorderWriters.includes(name)
)
check(
  '§1b 分类表里没有已经不存在的写入方法（清单与代码同步）',
  staleRecorderWriters.length === 0,
  staleRecorderWriters.join(', ') || 'AA'
)

const wiredFamiliesByMode = new Map<string, Set<string>>()
for (const mode of ['interactive_human_console', 'scripted_agent_runner'] as const) {
  wiredFamiliesByMode.set(
    mode,
    new Set(conversationAttributionForEntryMode(mode).producers.map((producer) => producer.family))
  )
}
let recorderCallsiteTotal = 0
const recorderInventory: {
  writer: string
  classification: WriterClass
  family: string | null
  callsites: string[]
  familyWiredInBothModes: boolean | null
}[] = []
for (const name of discoveredRecorderWriters) {
  const spec = RECORDER_WRITERS[name]!
  const callsites = dotCallsites(name, RECORDER_PATH)
  recorderCallsiteTotal += callsites.length
  const familyWired =
    spec.family === undefined
      ? null
      : ['interactive_human_console', 'scripted_agent_runner'].every((mode) =>
          wiredFamiliesByMode.get(mode)!.has(spec.family!)
        )
  recorderInventory.push({
    writer: name,
    classification: spec.classification,
    family: spec.family ?? null,
    callsites,
    familyWiredInBothModes: familyWired,
  })
  if (spec.classification === 'PRODUCTION_ACTIVE') {
    check(
      `★ §1b \`${name}\` 是 PRODUCTION_ACTIVE ⇒ 真的有生产调用点（${spec.reason}）`,
      callsites.length > 0,
      callsites.join(', ') || '（零调用点 —— 与分类矛盾）'
    )
    check(
      `★ §1b \`${name}\` 的族（${String(spec.family)}）在**两个**入口模式下都有生产 ingress（接线的闭环）`,
      familyWired === true,
      `${String(spec.family)} wired=${String(familyWired)}`
    )
  } else {
    check(
      `§1b \`${name}\` 是 ${spec.classification} ⇒ **零**生产调用点（${spec.reason}）`,
      callsites.length === 0,
      callsites.join(', ') || 'AA'
    )
  }
}
measure('recorder 写入方法的调用点总数', recorderCallsiteTotal)

const discoveredPortWriters = discoverPortWriters(ledgerSource)
measure('发现的账本端口写入方法数', discoveredPortWriters.length)
const PORT_WRITERS: Readonly<Record<string, { calledBy: string; reason: string }>> = {
  appendUserStatement: { calledBy: 'recordUserMessage', reason: '用户说了话' },
  appendCharacterOutput: { calledBy: 'recordAssistantMessageOutcome', reason: '她说了话' },
  appendSystemEvent: { calledBy: 'recordSystemEvent', reason: '系统通知' },
  appendToolEvent: { calledBy: 'recordToolOutput', reason: '工具返回' },
}
const unclassifiedPortWriters = discoveredPortWriters.filter((name) => PORT_WRITERS[name] === undefined)
check(
  '★ §1b 每一个账本端口写入方法都被分类（新增一个端口方法而不登记 ⇒ 本门变红）',
  unclassifiedPortWriters.length === 0 && discoveredPortWriters.length > 0,
  unclassifiedPortWriters.join(', ') || `${discoveredPortWriters.length} 个全部已分类`
)
const portInventory: {
  writer: string
  calledBy: string
  /** **推导**出来的分类（不是手写）：唯一调用者是不是生产活跃的 recorder 方法 */
  classification: WriterClass
  callsites: string[]
  declaredMatchesDerived: boolean
}[] = []
for (const name of discoveredPortWriters) {
  const spec = PORT_WRITERS[name]
  if (spec === undefined) continue
  const callsites = dotCallsites(name, LEDGER_PATH)
  const body = recorderBodies.get(spec.calledBy)
  const onlyRecorderCallsIt =
    callsites.length === 1 && callsites[0] === 'src/infrastructure/runtime/conversation-recorder.ts'
  const declaredCallerHostsIt = body !== undefined && body.includes(`this.ledger.${name}(`)
  const callerClass = RECORDER_WRITERS[spec.calledBy]?.classification
  const derived: WriterClass = callerClass === 'PRODUCTION_ACTIVE' ? 'PRODUCTION_ACTIVE' : 'DEAD / UNREACHABLE'
  check(
    `★ §1b \`${name}\` 的唯一 src 调用者是 recorder，且那段方法体就是 \`${spec.calledBy}\`（${spec.reason}）`,
    onlyRecorderCallsIt && declaredCallerHostsIt,
    `callsites=[${callsites.join(', ')}] hosted=${String(declaredCallerHostsIt)}`
  )
  portInventory.push({
    writer: name,
    calledBy: spec.calledBy,
    classification: derived,
    callsites,
    declaredMatchesDerived: callerClass !== undefined,
  })
  if (derived === 'PRODUCTION_ACTIVE') {
    check(
      `★ §1b \`${name}\` 由生产活跃方法 \`${spec.calledBy}\` 调用 ⇒ PRODUCTION_ACTIVE（其族已接线）`,
      wiredFamiliesByMode.get('interactive_human_console')!.has(
        RECORDER_WRITERS[spec.calledBy]!.family!
      ),
      String(RECORDER_WRITERS[spec.calledBy]!.family)
    )
  } else {
    check(
      `§1b \`${name}\` 只能由 ${callerClass} 的 \`${spec.calledBy}\` 到达 ⇒ 生产不可达（如实记 ${derived}）`,
      callerClass !== 'PRODUCTION_ACTIVE',
      `callerClass=${String(callerClass)}`
    )
  }
}
const stalePortWriters = Object.keys(PORT_WRITERS).filter((name) => !discoveredPortWriters.includes(name))
check(
  '§1b 端口分类表里没有已经不存在的写入方法',
  stalePortWriters.length === 0,
  stalePortWriters.join(', ') || 'AA'
)

/** 低层原语：`appendConversationEvent` 的调用点（生产经 ledger，迁移回填直接调它） */
const appendPrimitiveCallsites = plainCallsites('appendConversationEvent', STORE_PATH)
measure('低层原语 appendConversationEvent 的调用点文件数', appendPrimitiveCallsites.length)
check(
  '★ §1b 低层原语 `appendConversationEvent` 的调用点**恰好**是 ledger（生产）与 backfill（回填）—— 没有第三个',
  appendPrimitiveCallsites.sort().join(',') ===
    [
      'src/infrastructure/persistence/backfill.ts',
      'src/infrastructure/persistence/ledger.ts',
    ]
      .sort()
      .join(','),
  appendPrimitiveCallsites.join(', ') || '(无)'
)

/*
 * --- 三段式：检测器本身必须**会响**（任务书 §9 / 项目 §6.7）---------------------
 *
 * 正控：真实源码 ⇒ 未分类 = 0（安静）。
 * 负控：把一段**合成的新写入方法**追加到源码文本上，对**同一套发现逻辑**跑一遍 ⇒ 必须报出未分类。
 * 恢复：把那段合成文本去掉 ⇒ 重新安静。
 * 没有这一段，"检查了 0 个未分类"与"根本没在检查"在输出上长得一样。
 */
const injectedRecorderSource = `${recorderSource}\n  async recordSyntheticWriter(text: string): Promise<void> {\n    void text\n  }\n`
const injectedLedgerSource = `${ledgerSource}\n    async appendSyntheticEvent(input: unknown): Promise<void> {\n      void input\n    },\n`
const unclassifiedOfRecorder = (source: string): string[] =>
  discoverRecorderWriters(source).filter((name) => RECORDER_WRITERS[name] === undefined)
const unclassifiedOfPort = (source: string): string[] =>
  discoverPortWriters(source).filter((name) => PORT_WRITERS[name] === undefined)
const syntheticRecorderHits = unclassifiedOfRecorder(injectedRecorderSource)
const syntheticPortHits = unclassifiedOfPort(injectedLedgerSource)
measure('负控注入的合成写入方法数', syntheticRecorderHits.length + syntheticPortHits.length)
check(
  '★ §1b 负控：注入一个合成 recorder 写入方法 ⇒ 检测器**必响**（未分类非空）',
  syntheticRecorderHits.includes('recordSyntheticWriter'),
  syntheticRecorderHits.join(', ') || '(没响 —— 检测器是空转的)'
)
check(
  '★ §1b 负控：注入一个合成账本端口方法 ⇒ 检测器**必响**',
  syntheticPortHits.includes('appendSyntheticEvent'),
  syntheticPortHits.join(', ') || '(没响 —— 检测器是空转的)'
)
check(
  '★ §1b 恢复：去掉合成文本后重新安静（真实源码的未分类 = 0；检测器测的是"清单与代码是否同步"）',
  unclassifiedOfRecorder(recorderSource).length === 0 && unclassifiedOfPort(ledgerSource).length === 0,
  'AA'
)

// ===========================================================================
section('§2 受信边界（任务书 §2）：没有可填的"角色枚举"，伪造一律失败关闭')
// ===========================================================================

const ingressSource = readFileSync(join(ROOT, ingressModule), 'utf8')
const ingressCode = codeOnly(ingressSource)

check(
  '★ 三个具名工厂的 **arity = 0**（没有 `role` / `ingress` 这类可填参数）',
  createHumanConsoleUserTurnIngress.length === 0 &&
    createAgentRunnerUserTurnIngress.length === 0 &&
    createCharacterAssistantTurnIngress.length === 0,
  `${createHumanConsoleUserTurnIngress.length}/${createAgentRunnerUserTurnIngress.length}/${createCharacterAssistantTurnIngress.length}`
)
check(
  '★ 模块里**没有** `role:` / `ingress:` 形状的可填参数（只查代码，不查注释）',
  !/role\s*:\s*['"]/.test(ingressCode) && !/ingress\s*:\s*['"]/.test(ingressCode),
  'AA'
)
check(
  '★ 唯一接受的事实字段是 characterId / presenterActorId / userId（没有归因槽位）',
  /export interface ConversationIngressFacts \{[\s\S]*?\n\}/.test(ingressCode) &&
    !/ConversationIngressFacts \{[\s\S]*?\n\}[\s\S]{0,40}(actor|contentOriginator|authority|executor)\s*:/.test(
      ingressCode
    ),
  'AA'
)
check(
  '★ `assertNoUntrustedAttributionFields` 是 ingress 的公共前缀守卫（每个工厂都调）',
  // QQ private adds a fourth named ingress; every producer still uses the same guard.
  (ingressCode.match(/guardFacts\(facts\)/g) ?? []).length === 4,
  `${(ingressCode.match(/guardFacts\(facts\)/g) ?? []).length} 处`
)

// --- 负控①：夹带归因字段的"事实"被拒 ------------------------------------------
const humanIngress = createHumanConsoleUserTurnIngress()
const agentIngress = createAgentRunnerUserTurnIngress()
const assistantIngress = createCharacterAssistantTurnIngress()
const facts = { characterId: String(characterId), presenterActorId: userId, userId }
const withAttributionField = { ...facts, contentOriginator: { state: 'KNOWN', kind: 'USER', id: userId } }
let dtoRejected = false
let dtoCode = ''
try {
  humanIngress.attest(withAttributionField)
} catch (error) {
  dtoRejected = true
  dtoCode = String((error as { code?: string }).code ?? (error as Error).name)
}
check(
  '★ 负控①：事实对象里夹带 `contentOriginator` ⇒ **被拒**（不得凭字段提权）',
  dtoRejected && dtoCode === 'untrusted_attribution_field',
  dtoCode
)

// --- 负控②：手写同形上下文 → 写入被拒 ----------------------------------------
const humanContext = humanIngress.attest(facts)
let handWrittenRejected = false
let handWrittenCode = ''
try {
  createConversationEvent({
    characterId,
    conversationId: asConversationId('conv_wp61_forge'),
    conversationSequence: 1,
    sequence: 1,
    type: 'user_message',
    actorType: 'user',
    actorId: userId,
    content: '手写同形归因',
    trustedAttribution: {
      ...humanContext,
    } as never,
  })
} catch (error) {
  handWrittenRejected = true
  handWrittenCode = String((error as { code?: string }).code ?? (error as Error).name)
}
check(
  '★ 负控②：**结构克隆**的上下文写不进账本（手写同形对象不算证据 —— K-25 §2 / AT-W4-7）',
  handWrittenRejected && handWrittenCode === 'untrusted_attribution_context',
  handWrittenCode
)

let jsonRoundTripRejected = false
let jsonRoundTripCode = ''
try {
  const cloned = JSON.parse(JSON.stringify(humanContext)) as never
  createConversationEvent({
    characterId,
    conversationId: asConversationId('conv_wp61_forge'),
    conversationSequence: 1,
    sequence: 1,
    type: 'user_message',
    actorType: 'user',
    actorId: userId,
    content: 'JSON 往返的归因',
    trustedAttribution: cloned,
  })
} catch (error) {
  jsonRoundTripRejected = true
  jsonRoundTripCode = String((error as { code?: string }).code ?? (error as Error).name)
}
check(
  '★ 负控②-b：**JSON 往返**的上下文同样被拒',
  jsonRoundTripRejected && jsonRoundTripCode === 'untrusted_attribution_context',
  jsonRoundTripCode
)

// --- 负控③：手写证据 token 也进不去 ------------------------------------------
let fakeEvidenceRejected = false
let fakeEvidenceCode = ''
try {
  buildTrustedAttributionContext({
    family: 'user_message',
    characterId: String(characterId),
    actorEvidence: { adapterId: 'attacker', principal: { kind: 'USER', id: 'u-attacker' } } as never,
    contentOriginatorEvidence: {
      adapterId: 'attacker',
      principal: { kind: 'USER', id: 'u-attacker' },
    } as never,
  })
} catch (error) {
  fakeEvidenceRejected = true
  fakeEvidenceCode = String((error as { code?: string }).code ?? (error as Error).name)
}
check(
  '★ 负控③：手写的"证据 token"被拒（不是本模块构造的一律不算 —— 品牌 + WeakSet）',
  fakeEvidenceRejected && fakeEvidenceCode === 'untrusted_attestation_evidence',
  fakeEvidenceCode
)

// --- 负控④：呈现位次与解析身份不一致 ⇒ 抛（不猜） -----------------------------
let mismatchCode = ''
try {
  humanIngress.attest({ characterId: String(characterId), presenterActorId: 'u-somebody-else', userId })
} catch (error) {
  mismatchCode = String((error as { code?: string }).code ?? (error as Error).name)
}
check(
  '★ 负控④：呈现位次 ≠ 解析身份 ⇒ `attribution_presenter_mismatch`（自相矛盾不猜）',
  mismatchCode === 'attribution_presenter_mismatch',
  mismatchCode
)

// --- 负控⑤：同一族两个生产者 = 归因歧义 ⇒ 抛 ----------------------------------
let ambiguityCode = ''
try {
  indexConversationIngress([createHumanConsoleUserTurnIngress(), createAgentRunnerUserTurnIngress()])
} catch (error) {
  ambiguityCode = String((error as { code?: string }).code ?? (error as Error).name)
}
check(
  '★ 负控⑤：两个生产者声称同一族 ⇒ `ambiguous_attribution_ingress`（不"取第一个"）',
  ambiguityCode === 'ambiguous_attribution_ingress',
  ambiguityCode
)

// --- 负控⑥：上下文被冻结（构造后篡改抛错） ------------------------------------
let frozenThrow = false
try {
  ;(humanContext as { family: string }).family = 'assistant_message'
} catch {
  frozenThrow = true
}
check(
  '★ 负控⑥：受信上下文构造后被**冻结**（严格模式下篡改抛错；非严格下也改不动值）',
  frozenThrow && humanContext.family === 'user_message',
  `family=${humanContext.family}`
)

// --- 四个入口模式组合的静态表：角色的选择只来自工厂 ----------------------------
check(
  '入口模式只有两个取值（`interactive_human_console` / `scripted_agent_runner`）',
  /export type ConversationEntryMode = 'interactive_human_console' \| 'scripted_agent_runner'/.test(
    readFileSync(join(ROOT, ingressModule), 'utf8')
  )
)
check(
  '`conversationEntryModeOf` 只按"有没有位置参数"判定',
  conversationEntryModeOf(['hello']) === 'scripted_agent_runner' &&
    conversationEntryModeOf(['--test']) === 'interactive_human_console' &&
    conversationEntryModeOf([]) === 'interactive_human_console'
)

// ===========================================================================
section('§3–§5 真实链路：三个入口各自写出的受信归因')
// ===========================================================================

/** 读一条 DB 行的槽位（**只读三个物理格**，不推导） */
function slotReadingOfRow(row: Record<string, unknown>, slot: AttributionValueSlot): string {
  const columns = ATTRIBUTION_SLOT_COLUMNS[slot]
  const kind = row[columns.kind] ?? null
  const id = row[columns.id] ?? null
  const reason = row[columns.unknownReason] ?? null
  if (kind === null && id === null && reason === null) return 'ABSENT|-|-|-'
  if (kind === null && id === null) return `UNKNOWN|-|-|${String(reason)}`
  return `KNOWN|${String(kind)}|${String(id)}|-`
}
/**
 * 读一个三态值。
 *
 * ⚠️ 有**两种**合法形状，必须都能读（它们描述同一个三态，只是包法不同）：
 *   · 域内 `AttributionValue`      `{ state, value: { kind, id } }`
 *   · 开发者 DTO（**扁平**）        `{ state, kind, id }` / authority 是 `{ state, kind, ref }`
 */
function slotReadingOfValue(value: {
  state?: string
  kind?: string
  id?: string
  ref?: string
  reason?: string
  value?: { kind?: string; id?: string; ref?: string }
}): string {
  if (value.state === 'KNOWN') {
    const flat =
      typeof value.kind === 'string' || typeof value.id === 'string' || typeof value.ref === 'string'
    const principal = flat ? value : (value.value ?? {})
    return `KNOWN|${String(principal.kind)}|${String(principal.id ?? principal.ref)}|-`
  }
  if (value.state === 'UNKNOWN') return `UNKNOWN|-|-|${String(value.reason)}`
  if (value.state === 'ABSENT') return 'ABSENT|-|-|-'
  return `UNKNOWN_SHAPE|${json(value)}`
}
const SLOTS: readonly AttributionValueSlot[] = [
  'initiator',
  'actor',
  'executor',
  'authority',
  'recordedBy',
  'contentOriginator',
]
async function readRow(
  conversationId: string,
  conversationSequence: number
): Promise<Record<string, unknown>> {
  const rows = rowsOf(
    await db.execute(
      sql`select * from conversation_events where character_id = ${String(characterId)}
            and conversation_id = ${conversationId} and conversation_sequence = ${conversationSequence}`
    )
  ) as Record<string, unknown>[]
  return rows[0] ?? {}
}
/**
 * **构造期**的六个槽位读数。
 *
 * 用 `attributionSlotsOfContext()`（store 写库时用的**同一个**函数）把受信上下文
 * 映射成槽位 —— 对话上下文的 `initiator` / `executor` / `authority` 恒为 Absent
 * （说话不需要许可、也没有执行者），这一点也是被测对象（见 §3 的断言）。
 */
const contextReading = (context: TrustedAttributionContext): Record<string, string> => {
  const slots = attributionSlotsOfContext(context)
  const out: Record<string, string> = {}
  for (const slot of SLOTS) {
    out[slot] = slotReadingOfValue(slots[slot] as never)
  }
  return out
}
const rowReading = (row: Record<string, unknown>): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const slot of SLOTS) out[slot] = slotReadingOfRow(row, slot)
  return out
}

// --- 行动侧装配（K-27 的跨账本证据；与 WP5.1 同一形状） -----------------------
const actionLedger = createActionLedgerStore(db)
const registry = createCapabilityRegistry(createDefaultCapabilityDefinitions())
const actionTarget: ActionTarget = { type: 'unknown', confidence: 'none' }
const actionGateway = createActionGateway({
  registry,
  ledger: actionLedger,
  adapters: [createEchoAdapter()],
  grantedPermissions: DEFAULT_GRANTED_PERMISSIONS,
  maxRiskLevel: 'R1',
  now: () => Date.now(),
  resolveTarget: async () => ({ target: actionTarget, scopeViolation: false }),
  attribution: {
    decisionPointAdapterId: 'action-gateway',
    policyAdapterId: 'action-policy',
    executorAdapterId: 'action-adapter',
  },
})
const actionWriter = createActionTurnPort({
  gateway: actionGateway,
  detector: createActionIntentDetector(),
  registry,
  attribution: { adapterId: 'action-turn' },
})

interface TurnReading {
  entryMode: 'interactive_human_console' | 'scripted_agent_runner'
  conversationId: string
  userEventId: string
  assistantEventId: string | null
  userSequence: number
  assistantSequence: number | null
  traceId: string
  actionId: string | null
  actionInitiator: string
}

/**
 * **真实一轮**：真实 `TurnGateway` + 真实 `ConversationRecorder` + 真实 store +
 * 真实账本 + 真实 action writer（模型那一跳由 `completeTurn({ replyText })` 喂入，
 * 与 M5 的既有做法一致；本门验的不是模型）。
 */
async function runRealTurn(input: {
  entryMode: 'interactive_human_console' | 'scripted_agent_runner'
  conversationId: string
  userText: string
  replyText: string
  wire: boolean
}): Promise<TurnReading> {
  const conversationId = asConversationId(input.conversationId)
  const wiring = conversationAttributionForEntryMode(input.entryMode)
  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId,
    dryRun: false,
    userName: 'Alex',
    characterName: character.name,
    transport: 'cli',
    userId,
    userRef: 'Alex',
    ...(input.wire ? { attribution: wiring.producers } : {}),
  })
  let sequence = 0
  const gateway = new TurnGateway({
    kernel: h.kernel,
    definition: h.kernel.definition,
    identity: h.kernel.identitySnapshot,
    recorder,
    conversationSequence: () => {
      sequence += 1
      return sequence
    },
    recentLimit: 16,
    slowPathEnabled: false,
    dryRun: false,
    userId,
    actionWriter,
    actionEnabled: true,
  })
  const incoming = await gateway.beginTurn(input.userText)
  if (incoming.userEvent === undefined) throw new Error('beginTurn 没有写出用户事件')
  const outgoing = await gateway.completeTurn({ turn: incoming, replyText: input.replyText })
  const actionIds = (incoming.actionResults ?? [])
    .map((result) => (result.request === undefined ? undefined : String(result.request.actionId)))
    .filter((id): id is string => id !== undefined)
  let actionInitiator = 'NO_ACTION'
  if (actionIds.length > 0) {
    const events = await actionLedger.getEventsByActionId(characterId, asActionId(actionIds[0]!))
    const requested = events.find((event) => event.type === 'ACTION_REQUESTED')
    const value = requested?.attribution?.slots.initiator
    // ⚠️ 用**同一个**三态渲染器（与对话侧逐字同形），否则"跨账本一致"会被格式差异误判
    actionInitiator = value === undefined ? 'NO_ENVELOPE' : slotReadingOfValue(value as never)
  }
  return {
    entryMode: input.entryMode,
    conversationId: input.conversationId,
    userEventId: String(incoming.userEvent.id),
    assistantEventId: outgoing.assistantEvent === undefined ? null : String(outgoing.assistantEvent.id),
    userSequence: incoming.userEvent.conversationSequence,
    assistantSequence: outgoing.assistantEvent?.conversationSequence ?? null,
    traceId: String(incoming.traceId),
    actionId: actionIds[0] ?? null,
    actionInitiator,
  }
}

// --- §3 人类控制台 -----------------------------------------------------------
const HUMAN_ACTION_TEXT = 'echo wp61-human'
const human = await runRealTurn({
  entryMode: 'interactive_human_console',
  conversationId: 'conv_wp61_human',
  userText: HUMAN_ACTION_TEXT,
  replyText: '我这就去做。',
  wire: true,
})
const humanRow = await readRow(human.conversationId, human.userSequence)
const humanReadback = await getConversationEvent(db, asConversationEventId(human.userEventId))
check(
  '★ §3 人类 ingress：真实 `beginTurn` 写出的用户事件是 `RECORDED`',
  humanRow.attribution_origin === 'RECORDED',
  String(humanRow.attribution_origin)
)
check(
  '★ §3 `actor_type=user`（legacy 呈现不变）而权威槽位是 `Known(USER/<已解析身份>)`',
  humanRow.actor_type === 'user' &&
    humanRow.actor_kind === 'USER' &&
    humanRow.actor_ref_id === userId &&
    humanRow.content_originator_kind === 'USER' &&
    humanRow.content_originator_id === userId,
  `actor=${String(humanRow.actor_kind)}/${String(humanRow.actor_ref_id)}`
)
check(
  '★ §3 `recordedBy = Known(SYSTEM/kernel)`（canonical ledger recorder；不由调用方提供）',
  humanRow.recorded_by_kind === 'SYSTEM' && humanRow.recorded_by_id === 'kernel',
  `${String(humanRow.recorded_by_kind)}/${String(humanRow.recorded_by_id)}`
)
check(
  '★ §3 Axis B = confirmed：`user_statement` / `USER_EXPLICIT` / `user_report`',
  humanRow.source_kind === 'user_statement' &&
    humanRow.source_authority === 'USER_EXPLICIT' &&
    humanRow.epistemic_source === 'user_report',
  `${String(humanRow.source_kind)} / ${String(humanRow.source_authority)} / ${String(humanRow.epistemic_source)}`
)
check(
  '★ §3 必备槽位齐备：initiator / executor / authority = Absent（说话不需要许可、没有执行者）',
  slotReadingOfRow(humanRow, 'initiator') === 'ABSENT|-|-|-' &&
    slotReadingOfRow(humanRow, 'executor') === 'ABSENT|-|-|-' &&
    slotReadingOfRow(humanRow, 'authority') === 'ABSENT|-|-|-',
  `${slotReadingOfRow(humanRow, 'initiator')} / ${slotReadingOfRow(humanRow, 'executor')} / ${slotReadingOfRow(humanRow, 'authority')}`
)

// 写时（构造期）== DB == 回读 == 同一份上下文
const humanConstruction = humanIngress.attest({
  characterId: String(characterId),
  presenterActorId: userId,
  userId,
})
check(
  '★ §7-① 构造期 == DB（六个槽位逐字段）',
  json(contextReading(humanConstruction)) === json(rowReading(humanRow)),
  json(rowReading(humanRow))
)
check(
  '★ §7-① 构造期 == 回读（三态逐字段，不重推）',
  humanReadback?.attribution !== undefined &&
    json(
      Object.fromEntries(SLOTS.map((slot) => [slot, slotReadingOfValue(humanReadback.attribution!.slots[slot] as never)]))
    ) === json(contextReading(humanConstruction)),
  'AA'
)
check(
  '★ §7-① 构造期 == DB 的 Axis B 三列（逐字）',
  humanRow.source_kind === humanConstruction.axisB.sourceKind &&
    humanRow.source_authority === humanConstruction.axisB.sourceAuthority &&
    humanRow.epistemic_source === humanConstruction.axisB.epistemicSource,
  `${String(humanRow.source_authority)} vs ${humanConstruction.axisB.sourceAuthority}`
)
check(
  '§3 鉴证种类写进上下文证据（`authenticated_human_input`，adapter = human-console）',
  humanConstruction.axisB.attestedBy === 'authenticated_human_input' &&
    humanConstruction.evidence.actorAdapterId === 'human-console' &&
    humanConstruction.evidence.epistemicAdapterId === 'human-console',
  json(humanConstruction.evidence)
)

// --- §4 agent-as-user（生产 D01 控制） ---------------------------------------
const AGENT_ACTION_TEXT = 'echo wp61-agent'
const agent = await runRealTurn({
  entryMode: 'scripted_agent_runner',
  conversationId: 'conv_wp61_agent',
  userText: AGENT_ACTION_TEXT,
  replyText: '好的。',
  wire: true,
})
const agentRow = await readRow(agent.conversationId, agent.userSequence)
check(
  '★ §4 D01 生产控制：真实 `beginTurn`（程序化入口）写出的行仍是 `actor_type=user` 的呈现',
  agentRow.attribution_origin === 'RECORDED' && agentRow.actor_type === 'user',
  `${String(agentRow.attribution_origin)} / actor_type=${String(agentRow.actor_type)}`
)
check(
  '★ §4 权威槽位是 `Known(SERVICE/agent-runner)` ×2（**不是** USER）',
  agentRow.actor_kind === 'SERVICE' &&
    agentRow.actor_ref_id === AGENT_RUNNER_SERVICE_ID &&
    agentRow.content_originator_kind === 'SERVICE' &&
    agentRow.content_originator_id === AGENT_RUNNER_SERVICE_ID,
  `actor=${String(agentRow.actor_kind)}/${String(agentRow.actor_ref_id)} originator=${String(agentRow.content_originator_kind)}/${String(agentRow.content_originator_id)}`
)
check(
  '★ §4 整行**没有任何** USER 位次（不得因为 actor_type=user 就确认 USER）',
  json(agentRow).includes('SERVICE') && !json(rowReading(agentRow)).includes('USER'),
  json(rowReading(agentRow))
)
check(
  '★ §4 Axis B = **unconfirmed**：`user_statement` / `UNCONFIRMED_ORIGIN` ×2（表面身份不足以建立认知资格）',
  agentRow.source_kind === 'user_statement' &&
    agentRow.source_authority === 'UNCONFIRMED_ORIGIN' &&
    agentRow.epistemic_source === 'UNCONFIRMED_ORIGIN',
  `${String(agentRow.source_kind)} / ${String(agentRow.source_authority)} / ${String(agentRow.epistemic_source)}`
)
check(
  '★ §4 人类行与 D01 行**可区分**（同一族、同一个入口形状，归因不同）',
  json(rowReading(humanRow)) !== json(rowReading(agentRow)) &&
    json(humanRow.source_authority) !== json(agentRow.source_authority),
  `${json(humanRow.source_authority)} vs ${json(agentRow.source_authority)}`
)

// --- §5 她的输出 -------------------------------------------------------------
const humanAssistantRow = await readRow(human.conversationId, human.assistantSequence!)
const agentAssistantRow = await readRow(agent.conversationId, agent.assistantSequence!)
check(
  '★ §5 助手事件（真实 `completeTurn` → Resolver）是 `RECORDED` + `Known(CHARACTER/<canonical>)` ×2',
  humanAssistantRow.attribution_origin === 'RECORDED' &&
    humanAssistantRow.actor_type === 'character' &&
    humanAssistantRow.actor_kind === 'CHARACTER' &&
    humanAssistantRow.actor_ref_id === String(characterId) &&
    humanAssistantRow.content_originator_kind === 'CHARACTER' &&
    humanAssistantRow.content_originator_id === String(characterId),
  `actor=${String(humanAssistantRow.actor_kind)}/${String(humanAssistantRow.actor_ref_id)}`
)
check(
  '★ §5 助手 Axis B = confirmed：`character_output` / `CHARACTER_GENERATION` / `character_generation`',
  humanAssistantRow.source_kind === 'character_output' &&
    humanAssistantRow.source_authority === 'CHARACTER_GENERATION' &&
    humanAssistantRow.epistemic_source === 'character_generation',
  `${String(humanAssistantRow.source_kind)} / ${String(humanAssistantRow.source_authority)} / ${String(humanAssistantRow.epistemic_source)}`
)
check(
  '★ §5 助手事件与入口模式无关（agent 入口下同样成立）',
  agentAssistantRow.attribution_origin === 'RECORDED' &&
    agentAssistantRow.actor_kind === 'CHARACTER' &&
    agentAssistantRow.source_authority === 'CHARACTER_GENERATION',
  `${String(agentAssistantRow.attribution_origin)} / ${String(agentAssistantRow.actor_kind)}`
)

// 负控：呈现位次对不上 canonical ⇒ 抛；呈现位次缺失 ⇒ Unknown（不得由族推出 CHARACTER）
let assistantMismatchCode = ''
try {
  assistantIngress.attest({
    characterId: String(characterId),
    presenterActorId: 'char_somebody_else',
  })
} catch (error) {
  assistantMismatchCode = String((error as { code?: string }).code ?? (error as Error).name)
}
check(
  '★ §5 负控：呈现位次不是 canonical 角色 ⇒ `attribution_presenter_mismatch`',
  assistantMismatchCode === 'attribution_presenter_mismatch',
  assistantMismatchCode
)
const assistantNoPresenter = assistantIngress.attest({
  characterId: String(characterId),
  presenterActorId: '',
})
check(
  '★ §5 负控：呈现位次缺失 ⇒ `Unknown(RUNTIME_UNRESOLVED)` ×2 + unconfirmed（**不得**由族推出 CHARACTER）',
  slotReadingOfValue(assistantNoPresenter.actor as never) === 'UNKNOWN|-|-|RUNTIME_UNRESOLVED' &&
    slotReadingOfValue(assistantNoPresenter.contentOriginator as never) ===
      'UNKNOWN|-|-|RUNTIME_UNRESOLVED' &&
    assistantNoPresenter.axisB.branch === 'unconfirmed',
  `${slotReadingOfValue(assistantNoPresenter.actor as never)} / ${assistantNoPresenter.axisB.branch}`
)
const humanNoUser = humanIngress.attest({
  characterId: String(characterId),
  presenterActorId: userId,
})
check(
  '★ §3 负控：没有可解析的用户身份 ⇒ `Unknown(RUNTIME_UNRESOLVED)`，**不猜**一个 USER',
  slotReadingOfValue(humanNoUser.actor as never) === 'UNKNOWN|-|-|RUNTIME_UNRESOLVED' &&
    humanNoUser.axisB.branch === 'unconfirmed',
  `${slotReadingOfValue(humanNoUser.actor as never)} / ${humanNoUser.axisB.branch}`
)

// ===========================================================================
section('§6 工具 / 系统族：生产侧没有调用点 ⇒ 不接线、不发明入口')
// ===========================================================================

const systemCallers = SRC_FILES.filter((file) =>
  /\.(recordSystemEvent|recordToolOutput)\s*\(/.test(codeOnly(readFileSync(file, 'utf8')))
).map((file) => file.replace(ROOT, '').replace(/\\/g, '/').replace(/^\/+/, ''))
const productionSystemCallers = systemCallers.filter(
  (file) => file !== 'src/infrastructure/runtime/conversation-recorder.ts'
)
check(
  '★ §6 `recordSystemEvent` / `recordToolOutput` 在 `src/` 里**没有**生产调用点',
  productionSystemCallers.length === 0,
  productionSystemCallers.join(', ') || 'AA'
)
for (const mode of ['interactive_human_console', 'scripted_agent_runner'] as const) {
  const families = conversationAttributionForEntryMode(mode).producers.map((producer) => producer.family)
  check(
    `§6 \`${mode}\` 的 wiring 只覆盖 user_message / assistant_message（不发明 tool/system 入口）`,
    families.slice().sort().join(',') === 'assistant_message,user_message',
    families.join(',')
  )
}
const systemConversationId = 'conv_wp61_system'
{
  const wiring = conversationAttributionForEntryMode('interactive_human_console')
  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId: asConversationId(systemConversationId),
    dryRun: false,
    userName: 'Alex',
    characterName: character.name,
    transport: 'cli',
    userId,
    attribution: wiring.producers,
  })
  const systemEvent = await recorder.recordSystemEvent('系统观测：她等了三天。', 1)
  const systemRow = await readRow(systemConversationId, 1)
  check(
    '★ §6 接了线的 recorder 写 system_event 时**不伪造**归因（`attribution_origin` 仍为 NULL）—— 未接线就如实记 legacy',
    systemEvent !== undefined && systemRow.attribution_origin === null,
    `origin=${String(systemRow.attribution_origin)}`
  )
  check(
    '★ §6 该行读回来仍然没有信封（`attribution === undefined`，不是被伪造成 Absent）',
    (await getConversationEvent(db, asConversationEventId(String(systemEvent!.id))))?.attribution ===
      undefined
  )
}

// ===========================================================================
section('§7 端到端：DB → 回读 → 开发者查询（trace DTO）逐字段相等')
// ===========================================================================

const traceDtoOf = async (traceId: string, label: string) => {
  const found = await query.getTrace({ characterId, traceId: asTraceId(traceId) })
  check(`§7 ${label}：trace 命中（trace.attribution 由 input_event_id 接地）`, found.found === true)
  return found.found ? found.value.attribution : undefined
}
/** DTO 的六个槽位读数（与 DB / 回读用**同一套**渲染，便于逐字段比对） */
const dtoSlotsOf = (dto: DeveloperAttributionDto): Record<string, string> =>
  Object.fromEntries(SLOTS.map((slot) => [slot, slotReadingOfValue(dto[slot] as never)]))
const slotsDetail = (left: Record<string, string>, right: Record<string, string>): string =>
  SLOTS.filter((slot) => left[slot] !== right[slot])
    .map((slot) => `${slot}: DTO=${left[slot]} ≠ DB=${right[slot]}`)
    .join(' · ') || 'AA'

const humanDto = await traceDtoOf(human.traceId, '人类')
check(
  '★ §7 人类 turn 的 trace DTO 归因 == DB 行（六个槽位 + origin + Axis B 逐字段）',
  humanDto !== undefined &&
    humanDto.attributionOrigin === humanRow.attribution_origin &&
    json(dtoSlotsOf(humanDto)) === json(rowReading(humanRow)) &&
    humanDto.axisB.availability === 'APPLICABLE' &&
    humanDto.axisB.sourceKind === humanRow.source_kind &&
    humanDto.axisB.sourceAuthority === humanRow.source_authority &&
    humanDto.axisB.epistemicSource === humanRow.epistemic_source,
  humanDto === undefined
    ? 'undefined'
    : `${slotsDetail(dtoSlotsOf(humanDto), rowReading(humanRow))} | origin=${humanDto.attributionOrigin} | axisB=${json(humanDto.axisB)} vs ${json([humanRow.source_kind, humanRow.source_authority, humanRow.epistemic_source])}`
)
check(
  '★ §7 DTO 的 basis 指向**那条用户事件**（不是 trace、不是别的行）',
  humanDto !== undefined &&
    humanDto.basisEventType === 'user_message' &&
    humanDto.basisSequence === human.userSequence,
  humanDto === undefined ? '?' : `${humanDto.basisEventType}/${humanDto.basisSequence}`
)

const agentDto = await traceDtoOf(agent.traceId, 'D01')
check(
  '★ §7 D01 trace DTO：两个权威槽位仍然是 `SERVICE/agent-runner`（查询面不得洗成 USER）',
  agentDto !== undefined &&
    slotReadingOfValue(agentDto.actor as never) === `KNOWN|SERVICE|${AGENT_RUNNER_SERVICE_ID}|-` &&
    slotReadingOfValue(agentDto.contentOriginator as never) ===
      `KNOWN|SERVICE|${AGENT_RUNNER_SERVICE_ID}|-`,
  agentDto === undefined
    ? 'undefined'
    : `${slotReadingOfValue(agentDto.actor as never)} / ${slotReadingOfValue(agentDto.contentOriginator as never)}`
)
check(
  '★ §7 D01 trace DTO：Axis B 是 `APPLICABLE` + `unconfirmed`',
  agentDto !== undefined &&
    agentDto.axisB.availability === 'APPLICABLE' &&
    agentDto.axisB.branch === 'unconfirmed',
  agentDto === undefined
    ? 'undefined'
    : json(agentDto.axisB)
)
check(
  '★ §7 D01 trace DTO：六个槽位逐字段等于 DB 行',
  agentDto !== undefined && json(dtoSlotsOf(agentDto)) === json(rowReading(agentRow)),
  agentDto === undefined ? 'undefined' : slotsDetail(dtoSlotsOf(agentDto), rowReading(agentRow))
)

const assistantReadback = await readConversationEventAttribution(
  db,
  asConversationEventId(human.assistantEventId!)
)
const assistantReadbackReading =
  assistantReadback === undefined
    ? {}
    : Object.fromEntries(
        SLOTS.map((slot) => [slot, slotReadingOfValue(assistantReadback.slots[slot] as never)])
      )
check(
  '§7 助手事件读回同样是 `character` + confirmed（trace 只接输入事件，助手行走回读面）',
  assistantReadback !== undefined &&
    slotReadingOfValue(assistantReadback.slots.contentOriginator as never) ===
      `KNOWN|CHARACTER|${String(characterId)}|-` &&
    json(assistantReadbackReading) === json(rowReading(humanAssistantRow)),
  assistantReadback === undefined
    ? 'undefined'
    : slotsDetail(assistantReadbackReading, rowReading(humanAssistantRow))
)

const readbackAttribution = await readConversationEventAttribution(
  db,
  asConversationEventId(human.userEventId)
)
check(
  '★ §7 readback（`readConversationEventAttribution`）== DB（六个槽位）',
  readbackAttribution !== undefined &&
    json(
      Object.fromEntries(
        SLOTS.map((slot) => [slot, slotReadingOfValue(readbackAttribution.slots[slot] as never)])
      )
    ) === json(rowReading(humanRow)),
  readbackAttribution === undefined ? 'undefined' : 'AA'
)
check(
  '★ §7 `getConversationEvent` 读回的事件对象与 DB 行一致（写时 == 落库 == 读回）',
  humanReadback?.attribution?.attributionOrigin === 'RECORDED' &&
    json(Object.fromEntries(SLOTS.map((slot) => [slot, slotReadingOfValue(humanReadback!.attribution!.slots[slot] as never)]))) ===
      json(rowReading(humanRow)),
  String(humanReadback?.attribution?.attributionOrigin)
)

// ===========================================================================
section('§8 K-27 跨账本保持：动作 initiator 与对话两个权威槽位一致')
// ===========================================================================

measure('§8 真实触发的动作数', [human.actionId, agent.actionId].filter((id) => id !== null).length)
check(
  '★ §8 两个入口各自真的触发了动作（否则 §8 是空转 ⇒ MEASUREMENT INVALID 已在上一行报出）',
  human.actionId !== null && agent.actionId !== null,
  `${String(human.actionId)} / ${String(agent.actionId)}`
)
check(
  '★ §8 人类入口：动作 `initiator = Known(USER/<已解析身份>)`（与对话 actor 一致）',
  human.actionInitiator === `KNOWN|USER|${userId}|-`,
  human.actionInitiator
)
check(
  '★ §8 D01 入口：动作 `initiator = Known(SERVICE/agent-runner)`（**不是** USER；跨账本一致）',
  agent.actionInitiator === `KNOWN|SERVICE|${AGENT_RUNNER_SERVICE_ID}|-`,
  agent.actionInitiator
)

const humanExecution = await query.getExecution({
  characterId,
  actionId: asActionId(human.actionId!),
})
const agentExecution = await query.getExecution({
  characterId,
  actionId: asActionId(agent.actionId!),
})
const humanExecutionDto = humanExecution.found ? humanExecution.value.attribution : undefined
const agentExecutionDto = agentExecution.found ? agentExecution.value.attribution : undefined
check(
  '★ §8 执行 DTO 的 initiator == 动作账本的 initiator（人类 / D01 两侧）',
  humanExecutionDto !== undefined &&
    agentExecutionDto !== undefined &&
    slotReadingOfValue(humanExecutionDto.initiator as never) === `KNOWN|USER|${userId}|-` &&
    slotReadingOfValue(agentExecutionDto.initiator as never) ===
      `KNOWN|SERVICE|${AGENT_RUNNER_SERVICE_ID}|-`,
  `${slotReadingOfValue(humanExecutionDto?.initiator as never)} / ${slotReadingOfValue(agentExecutionDto?.initiator as never)}`
)
const d01Surfaces = [
  { label: 'conversation(DB).actor', value: json(rowReading(agentRow).actor) },
  { label: 'conversation(trace DTO).actor', value: json(agentDto?.actor) },
  {
    label: 'conversation(trace DTO).contentOriginator',
    value: json(agentDto?.contentOriginator),
  },
  { label: 'action(execution DTO).initiator', value: json(agentExecutionDto?.initiator) },
]
measure('§8 检查的读侧面数', d01Surfaces.length)
check(
  '★ §8 **没有任何**读侧面把 D01 说成 USER',
  d01Surfaces.every((surface) => !surface.value.includes('"USER"')),
  d01Surfaces.map((surface) => `${surface.label}=${surface.value}`).join(' | ')
)
check(
  '★ §8 兼容字段仍说 user（`actor_type` + `requestedBy.kind`），权威输出仍是 SERVICE',
  agentRow.actor_type === 'user' &&
    agentExecution.found === true &&
    agentExecution.value.request.requestedByKind === 'user',
  `actor_type=${String(agentRow.actor_type)} requestedByKind=${agentExecution.found ? String(agentExecution.value.request.requestedByKind) : '?'}`
)

// ===========================================================================
section('§9 兼容与三段式：正控 / 负控 / 恢复')
// ===========================================================================

// --- ① legacy 路径（不接线）逐字不变 -----------------------------------------
const legacy = await runRealTurn({
  entryMode: 'interactive_human_console',
  conversationId: 'conv_wp61_legacy',
  userText: 'echo wp61-legacy',
  replyText: '（legacy 那轮）',
  wire: false,
})
const legacyUserRow = await readRow(legacy.conversationId, legacy.userSequence)
const legacyAssistantRow = await readRow(legacy.conversationId, legacy.assistantSequence!)
check(
  '★ §9-① legacy 路径（不传 wiring）逐字不变：`attribution_origin` 为 NULL（没有信封）',
  legacyUserRow.attribution_origin === null &&
    legacyUserRow.actor_kind === null &&
    legacyAssistantRow.attribution_origin === null,
  `origin=${String(legacyUserRow.attribution_origin)}`
)
check(
  '★ §9-① 但 legacy 行仍然带着"由 actor_type 推导出来的" Axis B（读侧兼容路径不变）',
  legacyUserRow.source_kind === 'user_statement' &&
    legacyUserRow.source_authority === 'USER_EXPLICIT' &&
    legacyAssistantRow.source_authority === 'CHARACTER_GENERATION',
  `${String(legacyUserRow.source_authority)} / ${String(legacyAssistantRow.source_authority)}`
)
check(
  '★ §9-① legacy 行的读回**没有** `attribution` 信封（legacy 与 RECORDED 在账本上可区分）',
  (await getConversationEvent(db, asConversationEventId(legacy.userEventId)))?.attribution === undefined
)
/*
 * M3 评测（`evals/m3/**`）与各夹具都自己构造 recorder / ledger，**不注入** attribution ⇒
 * 它们仍走上面那条 legacy 路径。这一点必须**结构性**证明，而不是靠"我没改它们"的口头保证：
 * 只要 `evals/` 里出现 `attribution:` 注入，这条断言就会红。
 */
const evalFiles: string[] = []
{
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) visit(full)
      else if (entry.name.endsWith('.ts')) evalFiles.push(full)
    }
  }
  if (readdirSync(join(ROOT, 'evals')).length > 0) visit(join(ROOT, 'evals'))
}
measure('扫描的 evals 源文件数', evalFiles.length)
const evalWired = evalFiles.filter((file) =>
  /\battribution\s*:\s*(conversationAttributionForEntryMode|\[)/.test(codeOnly(readFileSync(file, 'utf8')))
)
check(
  '★ §9-① M3 评测 / 夹具**没有**注入受信归因接线（因此它们的 `USER_REPLY_CONFIRMATION` 等既有断言不受本步影响）',
  evalWired.length === 0,
  evalWired.map((file) => file.replace(ROOT, '')).join(', ') || 'AA'
)

// --- ② 回复确认（M3 §33 的权威提升）：直接账本调用点上的实测差异 ----------------
/*
 * ⚠️ 先说清**可达性**（否则这段会被误读成"生产语义变了"）：
 *
 * `ConversationRecorder.recordUserMessage(text, sequence)` **不传** `replyToEventId`，
 * 而 `src/` 里也没有别的地方给用户事件传它 ⇒ 在**生产链接**上用户事件从来没有 reply graph，
 * 于是 `USER_REPLY_CONFIRMATION` 在生产里**今天不可达**（WP6.1 之前之后都一样）。
 * 它只出现在**直接调账本端口**的地方（M3 评测夹具的 `appendUserStatement({replyToEventId})`）。
 *
 * 因此下面测的是"直接账本调用点"这条路：不接线时逐字保留 M3 语义；
 * 接线后 Axis B 由受信 ingress 记录（confirmed 分支只产出 `defaultAuthorityForKind`），
 * 于是同一条回复确认被记成 `USER_EXPLICIT`。这是一个**登记下来的偏差**，
 * 而它的认知后果为零（两个值映射到同一个 MemoryAuthority —— §10 实测）。
 */
{
  const wiring = conversationAttributionForEntryMode('interactive_human_console')
  const targetConversationId = 'conv_wp61_reply_target'
  // 直接账本端口 + **不接线**（legacy 语义的基线）
  const legacyLedger = createConversationLedger({ db, defaultTransport: 'cli' })
  const target = await legacyLedger.appendUserStatement({
    characterId,
    conversationId: asConversationId(targetConversationId),
    userId,
    content: '先起个头。',
    conversationSequence: 1,
  })
  const targetAssistant = await legacyLedger.appendCharacterOutput({
    characterId,
    conversationId: asConversationId(targetConversationId),
    characterIdAsActor: characterId,
    content: '好呀。',
    conversationSequence: 2,
    replyToEventId: asConversationEventId(String(target.event!.id)),
  })
  check(
    '§9-② 前置：造出一条"她生成的"事件作为回复目标（否则下面全是空转）',
    (await readRow(targetConversationId, 2)).source_kind === 'character_output' &&
      (await readRow(targetConversationId, 2)).attribution_origin === null,
    String((await readRow(targetConversationId, 2)).source_kind)
  )

  const legacyConfirmation = await legacyLedger.appendUserStatement({
    characterId,
    conversationId: asConversationId(targetConversationId),
    userId,
    content: '对，就是这样。',
    conversationSequence: 3,
    replyToEventId: asConversationEventId(String(targetAssistant.event!.id)),
  })
  const legacyReplyRow = await readRow(targetConversationId, 3)
  check(
    '★ §9-② 不接线的直接账本调用点保留 `USER_REPLY_CONFIRMATION`（M3 §33 逐字不变）',
    legacyConfirmation.event?.sourceAuthority === 'USER_REPLY_CONFIRMATION' &&
      legacyReplyRow.attribution_origin === null,
    `${String(legacyConfirmation.event?.sourceAuthority)} / origin=${String(legacyReplyRow.attribution_origin)}`
  )

  // 直接账本端口 + 接线 ⇒ RECORDED Axis B（登记偏差）
  const wiredLedger = createConversationLedger({
    db,
    defaultTransport: 'cli',
    attribution: wiring.producers,
  })
  const wiredConfirmation = await wiredLedger.appendUserStatement({
    characterId,
    conversationId: asConversationId(targetConversationId),
    userId,
    content: '对，就是这样（接线版）。',
    conversationSequence: 4,
    replyToEventId: asConversationEventId(String(targetAssistant.event!.id)),
  })
  const wiredReplyRow = await readRow(targetConversationId, 4)
  check(
    '★ §9-② **登记偏差**：接线后同一条回复确认被记录成 `USER_EXPLICIT` + RECORDED',
    wiredConfirmation.event !== undefined &&
      wiredReplyRow.attribution_origin === 'RECORDED' &&
      wiredReplyRow.source_authority === 'USER_EXPLICIT' &&
      wiredReplyRow.actor_kind === 'USER',
    `${String(wiredReplyRow.source_authority)} / origin=${String(wiredReplyRow.attribution_origin)}`
  )
  check(
    '★ §9-② 该偏差**不改变认知结论**：两者映射到同一个 MemoryAuthority 且都能支持外部事实',
    authorityFromSource('USER_EXPLICIT') === authorityFromSource('USER_REPLY_CONFIRMATION') &&
      canEvidenceExternalFact({
        type: 'user_message',
        actorType: 'user',
        sourceAuthority: 'USER_EXPLICIT',
      }) ===
        canEvidenceExternalFact({
          type: 'user_message',
          actorType: 'user',
          sourceAuthority: 'USER_REPLY_CONFIRMATION',
        }),
    `${authorityFromSource('USER_EXPLICIT')} == ${authorityFromSource('USER_REPLY_CONFIRMATION')}`
  )
  const recorderSource = codeOnly(
    readFileSync(join(ROOT, 'src', 'infrastructure', 'runtime', 'conversation-recorder.ts'), 'utf8')
  )
  check(
    '★ §9-② 可达性：生产录制路径**不**给用户事件带 reply graph ⇒ 该偏差在生产里今天不可达',
    !/replyToEventId/.test(recorderSource.slice(recorderSource.indexOf('async recordUserMessage'))) ||
      recorderSource
        .slice(recorderSource.indexOf('async recordUserMessage'), recorderSource.indexOf('async recordAssistantMessage'))
        .indexOf('replyToEventId') === -1,
    'AA'
  )
}

// --- ③ 恢复（三段式的第三段）：拆掉接线 ⇒ 回到 legacy；再接上 ⇒ 又是 RECORDED --
const restored = await runRealTurn({
  entryMode: 'scripted_agent_runner',
  conversationId: 'conv_wp61_restore',
  userText: 'echo wp61-restore',
  replyText: '（恢复段）',
  wire: false,
})
const restoredRow = await readRow(restored.conversationId, restored.userSequence)
check(
  '★ §9-③ 恢复段（再次拆掉接线）⇒ 回到 legacy（origin NULL）：检测器测的是接线本身',
  restoredRow.attribution_origin === null && restoredRow.actor_kind === null,
  `origin=${String(restoredRow.attribution_origin)}`
)
const rewired = await runRealTurn({
  entryMode: 'scripted_agent_runner',
  conversationId: 'conv_wp61_rewire',
  userText: 'echo wp61-rewire',
  replyText: '（再接上）',
  wire: true,
})
const rewiredRow = await readRow(rewired.conversationId, rewired.userSequence)
check(
  '★ §9-③ 再接上 ⇒ 又是 RECORDED + SERVICE（正控回到安静/正确状态）',
  rewiredRow.attribution_origin === 'RECORDED' && rewiredRow.actor_kind === 'SERVICE',
  `${String(rewiredRow.attribution_origin)} / ${String(rewiredRow.actor_kind)}`
)

// --- ④ 兼容站点的理由必须写下来（任务书 §9） --------------------------------
const legacySites = Object.entries(FROZEN_WRITERS).filter(
  ([, item]) => item.category === 'LEGACY_COMPAT_ONLY'
)
measure('登记为 LEGACY_COMPAT_ONLY 的站点数', legacySites.length)
check(
  '★ §9-④ 每个 legacy 兼容站点都有**书面理由**（不是"默认走旧路径"）',
  legacySites.length > 0 && legacySites.every(([, item]) => item.reason.length > 30),
  legacySites.map(([file]) => file).join(', ')
)

// ===========================================================================
section('§10 认知面未动（实测，不是断言）')
// ===========================================================================

check(
  '★ §10 `canSupportExternalFact`：用户陈述仍可支持外部事实，她的生成仍然不能',
  canEvidenceExternalFact({ type: 'user_message', actorType: 'user', sourceAuthority: 'USER_EXPLICIT' }) &&
    canEvidenceExternalFact({
      type: 'user_message',
      actorType: 'user',
      sourceAuthority: 'USER_REPLY_CONFIRMATION',
    }) &&
    !canEvidenceExternalFact({
      type: 'assistant_message',
      actorType: 'character',
      sourceAuthority: 'CHARACTER_GENERATION',
    }) &&
    !canEvidenceExternalFact({
      type: 'system_event',
      actorType: 'system',
      sourceAuthority: 'SYSTEM_INSTRUCTION',
    })
)
check(
  '★ §10 Fact Firewall 的**新值**也失败关闭：`UNCONFIRMED_ORIGIN` 仍然不能支持外部事实',
  !canEvidenceExternalFact({
    type: 'user_message',
    actorType: 'user',
    sourceAuthority: 'UNCONFIRMED_ORIGIN',
  })
)
check(
  '★ §10 `authorityFromSource(\'UNCONFIRMED_ORIGIN\')` 仍然**抛**（ADR-043 之前没有晋级路径）',
  (() => {
    try {
      authorityFromSource('UNCONFIRMED_ORIGIN')
      return false
    } catch (error) {
      return (
        String((error as { code?: string }).code) === 'unconfirmed_origin_cannot_become_memory_authority'
      )
    }
  })()
)
const authorityMap: Record<string, MemoryAuthority | string> = {}
for (const source of [
  'USER_EXPLICIT',
  'USER_REPLY_CONFIRMATION',
  'TOOL_OBSERVATION',
  'CHARACTER_GENERATION',
] as const) {
  authorityMap[source] = authorityFromSource(source)
}
check(
  '★ §10 四个既有权威等级的 MemoryAuthority 映射逐字未变（含两合一的用户陈述）',
  authorityMap.USER_EXPLICIT === 'EXPLICIT_USER_STATEMENT' &&
    authorityMap.USER_REPLY_CONFIRMATION === 'EXPLICIT_USER_STATEMENT' &&
    authorityMap.TOOL_OBSERVATION === 'TOOL_OBSERVATION' &&
    authorityMap.CHARACTER_GENERATION === 'CHARACTER_GENERATION',
  json(authorityMap)
)
check(
  '★ §10 extractor 的推导路径**不读**行上的 Axis B（它从 actorType 现场推导）',
  evidenceProfileOf({
    id: asConversationEventId('e'),
    sequence: 1,
    conversationSequence: 1,
    type: 'user_message',
    actorType: 'user',
    content: 'x',
    createdAt: 0,
  }).authority === 'EXPLICIT_USER_STATEMENT' &&
    evidenceProfileOf({
      id: asConversationEventId('e2'),
      sequence: 2,
      conversationSequence: 2,
      type: 'assistant_message',
      actorType: 'character',
      content: 'y',
      createdAt: 0,
    }).canSupportExternalFact === false
)
const extractorSource = codeOnly(
  readFileSync(join(ROOT, 'src', 'kernel', 'app', 'memory', 'extractor.ts'), 'utf8')
)

/*
 * ===========================================================================
 *  ★ M5.1.1 Phase 4a —— **判据层面的取代**（用户 2026-09-19 裁定；F4 见
 *    `docs/m5.1.1/M5.1.1-WP11-Compatible-Assertion-Record.md` §9）
 * ===========================================================================
 * 本节原来的断言是：
 *
 *     `★ §10 extractor **没有**被接线到归因（源码里不出现 attribution / contentOriginator）`
 *
 * 它保护的是 **Phase 4 之前**的架构状态。ADR-043 要求 4a 让形成期闸消费**来源资格读数** ⇒
 * 抽取器**必须**读受信信封；**原断言禁止了已批准的设计本身**。
 *
 * ⚠️ 取代**不是删除、不是放宽**：把"**禁止出现**"换成"**只允许经派生适配边界出现**"，
 *    并额外断言**下游只消费派生读数**。它仍然会在边界被打破时**报红**：
 *      · 适配边界外再出现一处原始 `event.attribution` / `contentOriginator` ⇒ 红
 *      · 下游候选解析自己去读原始归因（而不是 `view.trustedOrigin`）⇒ 红
 */
/** 取一段源码里某个顶层声明的函数体（以"下一个顶层 function / export function"为界） */
function fnBody(source: string, header: string): string {
  const start = source.indexOf(header)
  if (start === -1) return ''
  const candidates = [source.indexOf('\nexport function ', start + 1), source.indexOf('\nfunction ', start + 1)]
    .filter((index) => index > start)
  const end = candidates.length > 0 ? Math.min(...candidates) : source.length
  return source.slice(start, end)
}

const adapterBody = fnBody(extractorSource, 'export function processorEventViewOf')
const resolveOneBody = fnBody(extractorSource, 'function resolveOne(')
const outsideAdapter = extractorSource.replace(adapterBody, '')

const adapterReadsAttribution = /event\.attribution/.test(adapterBody)
const adapterDerivesReading = adapterBody.includes('trustedOriginReadingOf({')
const rawAttributionOutsideAdapter = (outsideAdapter.match(/event\.attribution|contentOriginator/g) ?? []).length
const downstreamReadsRawAttribution = /event\.attribution|contentOriginator/.test(resolveOneBody)
const downstreamConsumesReading = /view\.trustedOrigin/.test(resolveOneBody)

measure('适配边界内对原始归因的引用数', (adapterBody.match(/event\.attribution/g) ?? []).length)
measure('下游候选解析对派生读数的引用数', (resolveOneBody.match(/view\.trustedOrigin/g) ?? []).length)
check(
  '★ §10（取代）extractor 的归因接触被限制在**派生适配边界**内，下游**只**消费派生读数',
  adapterReadsAttribution &&
    adapterDerivesReading &&
    rawAttributionOutsideAdapter === 0 &&
    downstreamReadsRawAttribution === false &&
    downstreamConsumesReading,
  `适配边界读原始归因 = ${String(adapterReadsAttribution)}；边界内派生 = ${String(adapterDerivesReading)}；` +
    `边界外原始归因引用 = ${rawAttributionOutsideAdapter}；下游读原始归因 = ${String(downstreamReadsRawAttribution)}；` +
    `下游消费 view.trustedOrigin = ${String(downstreamConsumesReading)}`
)
const recallFiles = SRC_FILES.filter((file) => file.includes(join('src', 'kernel', 'recall')))
measure('扫描的 recall 源文件数', recallFiles.length)

/*
 * ===========================================================================
 *  ★ M5.1.1 Phase 4b —— **判据取代**（用户 2026-09-19 裁定，第五条）
 * ===========================================================================
 * 原判据是「Recall 与归因**零接触**」—— 它 grep 的是**词** `attribution`：
 *
 *     const recallTouched = recallFiles.filter((f) => /attribution/i.test(readFileSync(f, 'utf8')))
 *
 * 它保护的是 **Phase 4 之前**的架构状态。而 ADR-043 §4.1 明文要求 `4b` 的改动面
 * **包含** `recall ranking/eligibility/render`，且资格的取值类型住在
 * `contracts/attribution.ts`（用户 `D-2 = ①` 要求复用 4a 的 `SourceQualification`）
 * ⇒ 按 ADR 落地后，`src/kernel/recall/**` **必然**出现 `attribution` 字样。
 * 继续保留原判据 = **禁止已批准的设计本身**（与 R-59 那两条同型）。
 *
 * ⚠️ 取代**不是放宽**：换成下面三条**更强**的断言 —— 它们约束的是"**读什么**"，
 *    而不是"提没提到某个词"：
 *
 * ```text
 * ① Recall 不得出现**原始归因列名**（18 个槽位列）或表名 `conversation_events`
 *    ⇒ 它**不读原始归因**（那一列在库里、在适配器里，不在纯召回层）
 * ② Recall 不得检查 `TrustedOriginReading` 的**内部字段**
 *    （`contentOriginator` / `axisBConfirmed`）⇒ 它只能把这个**不透明**读数交给
 *    `memoryQualificationOf()`，然后消费**派生**出来的 `SourceQualification`
 * ③ 正控：Recall **确实**在消费那两个派生/不透明类型 ——
 *    否则 ① ② 会因为"recall 根本没接线"而**空过**（那是比放宽更坏的假绿）
 * ```
 *
 * ⚠️ 判据只看**代码**（`codeOnly()` 剥注释）：`ports.ts` 的文档注释里解释了
 *    `attribution_origin = 'RECORDED'` 是什么意思，那是**说明**而不是**读取**。
 *    （用户对初版建议措辞的纠正：初版写成"Recall 只消费 `SourceQualification`"是**错的** ——
 *      `ports.ts` **合法**携带了不透明的 `TrustedOriginReading`。）
 */
const RAW_ATTRIBUTION_TOKENS = [
  'attribution_origin',
  'initiator_kind',
  'initiator_id',
  'initiator_unknown_reason',
  'actor_kind',
  'actor_ref_id',
  'actor_unknown_reason',
  'executor_kind',
  'executor_id',
  'executor_unknown_reason',
  'recorded_by_kind',
  'recorded_by_id',
  'recorded_by_unknown_reason',
  'content_originator_kind',
  'content_originator_id',
  'content_originator_unknown_reason',
  'authority_kind',
  'authority_ref',
  'authority_unknown_reason',
  'conversation_events',
] as const
const OPAQUE_READING_INTERNALS = ['contentOriginator', 'axisBConfirmed'] as const

const recallCode = new Map(recallFiles.map((file) => [file, codeOnly(readFileSync(file, 'utf8'))]))

/**
 * 检测器本体（**纯**：输入是"文件 → 代码文本" + "要查的记号表"，输出是违规清单）。
 * ⚠️ 记号表是**显式参数**：取代① 与取代② 各查各的记号，否则两条判据的读数会混在一起
 *    （"取代① 报到内部字段" = 量到的东西不是它要判的那个东西 → AGENTS §6.2）。
 */
function recallRawOffenders(
  files: ReadonlyMap<string, string>,
  tokens: readonly string[]
): string[] {
  const offenders: string[] = []
  for (const [file, text] of files) {
    for (const token of tokens) {
      if (text.includes(token)) offenders.push(`${file.split(/[\\/]/).pop()} → ${token}`)
    }
  }
  return offenders
}

const rawColumnOffenders = recallRawOffenders(recallCode, RAW_ATTRIBUTION_TOKENS)
const internalOffenders = recallRawOffenders(recallCode, OPAQUE_READING_INTERNALS)
const consumers = [...recallCode.entries()]
  .filter(([, text]) => text.includes('TrustedOriginReading') || text.includes('SourceQualification'))
  .map(([file]) => file.split(/[\\/]/).pop() as string)

check(
  '★ §10（取代①）Recall **不读原始归因列**（18 个槽位列 / 表名 `conversation_events`）',
  rawColumnOffenders.length === 0,
  rawColumnOffenders.join(' · ') || `扫描 ${recallFiles.length} 个文件，0 处`
)
check(
  '★ §10（取代②）Recall **不检查** `TrustedOriginReading` 的内部字段（只能交给派生函数）',
  internalOffenders.length === 0,
  internalOffenders.join(' · ') || '0 处'
)
check(
  '★ §10（取代③ 正控）Recall **确实**在消费不透明的 `TrustedOriginReading` / 派生的 `SourceQualification`',
  consumers.length > 0,
  `消费方：${consumers.join(', ') || '(没有 —— 说明 ①② 是空过)'}`
)

/*
 * 判据被替换 ⇒ 必须重新证明它**有牙齿**（AGENTS §6.7）。
 * 三次注入都在内存里做，不碰工作树。
 *
 * ⚠️ 负控用**与正控同一个**检测器**且同一张记号表** —— 否则"注入必响"证明不了正控的
 *    那条判据有牙齿（那正是 AGENTS §6.2 的"量到的东西不是要判的东西"）。
 */
const injectedRawColumn = new Map([
  ['injected-a.ts', "select attribution_origin from conversation_events where id = 'x'"],
])
const injectedInternal = new Map([['injected-b.ts', 'if (reading.axisBConfirmed) return 1']])
check(
  '★ §10（取代·负控）注入一处**原始归因列读取** ⇒ 检测器**必须响**',
  recallRawOffenders(injectedRawColumn, RAW_ATTRIBUTION_TOKENS).length > 0,
  recallRawOffenders(injectedRawColumn, RAW_ATTRIBUTION_TOKENS).join(' · ')
)
check(
  '★ §10（取代·负控）注入一处**内部字段检查** ⇒ 检测器**必须响**',
  recallRawOffenders(injectedInternal, OPAQUE_READING_INTERNALS).length > 0,
  recallRawOffenders(injectedInternal, OPAQUE_READING_INTERNALS).join(' · ')
)
check(
  '★ §10（取代·量程自检）两张记号表**互不串台**（注入 A 不触发 B 的判据，反之亦然）',
  recallRawOffenders(injectedRawColumn, OPAQUE_READING_INTERNALS).length === 0 &&
    recallRawOffenders(injectedInternal, RAW_ATTRIBUTION_TOKENS).length === 0,
  '取代① 与取代② 各自量各自的记号'
)
check(
  '★ §10（取代·恢复）放回真实的 recall 层 ⇒ 检测器**重新安静**',
  recallRawOffenders(recallCode, [...RAW_ATTRIBUTION_TOKENS, ...OPAQUE_READING_INTERNALS]).length === 0,
  `${recallCode.size} 个文件，0 处`
)
/** 原判据的读数**保留在证据里**（历史对照），但不再作为判据 */
const recallTouched = recallFiles.filter((file) => /attribution/i.test(readFileSync(file, 'utf8')))

// ===========================================================================
section('§11 schema 边界与只读面')
// ===========================================================================

const attributionIndexes = rowsOf(
  await db.execute(
    sql`select indexname, indexdef from pg_indexes
        where schemaname = 'public'
          and (indexdef ilike '%initiator%' or indexdef ilike '%content_originator%'
               or indexdef ilike '%executor%' or indexdef ilike '%attribution_origin%')`
  )
) as { indexname: string; indexdef: string }[]
measure('§11 归因相关索引数（只允许 v7 已有的那一个 partial 索引）', attributionIndexes.length)
check(
  '★ 没有为归因新建索引（唯一允许的是 v7 的 `conversation_events_attribution_origin`）',
  attributionIndexes.length === 1 &&
    attributionIndexes[0]!.indexname === 'conversation_events_attribution_origin',
  attributionIndexes.map((row) => row.indexname).join(',') || '(无)'
)
const queryServiceSource = readFileSync(
  join(ROOT, 'src', 'infrastructure', 'dev', 'query-service.ts'),
  'utf8'
)
check(
  '开发者查询面仍然是**只读**的（不出现 insert / update / delete）',
  !/\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b/i.test(codeOnly(queryServiceSource)),
  'AA'
)
check(
  'telemetry 仍然没有导出归因（零泄漏规则不变）',
  (() => {
    const telemetryFiles: string[] = []
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) visit(full)
        else if (entry.name.endsWith('.ts')) telemetryFiles.push(full)
      }
    }
    visit(join(ROOT, 'src', 'infrastructure', 'telemetry'))
    return (
      telemetryFiles.length > 0 &&
      !telemetryFiles.some((file) =>
        /initiator|content_originator|recorded_by|attribution_origin|actor_kind|source_authority|epistemic_source/.test(
          readFileSync(file, 'utf8')
        )
      )
    )
  })()
)

// ===========================================================================
section('§12 汇总与证据')
// ===========================================================================

check(
  '★ 生产侧受信归因构造者 > 0（WP6 的 `conversationIngressProducers = 0` 已被闭合）',
  producerCount > 0,
  `${producerCount} 个：${attributionProducers.join(', ')}`
)
const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const verdict = failed === 0 ? 'PASS' : 'FAIL'
const evidence = {
  testId: 'M5.1.1 / WP6.1 production conversation attribution ingress closure (K-28)',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp6.1:verify',
  verdict,
  passed,
  failed,
  failures,
  ingressInventory: {
    frozenWriters: FROZEN_WRITERS,
    discoveredWriters: [...discoveredWriters],
    writerEvidence,
    productionActive,
    unclassified: unclassifiedWriters,
    stale: staleWriters,
    attributionProducerFiles: attributionProducers,
    producersBeforeWp61: 0,
    producersAfterWp61: producerCount,
    /* §1b 方法级清单：每个写入方法 + 可推导出的分类 + 自动发现的调用点 */
    methodLevel: {
      recorderWriters: recorderInventory,
      portWriters: portInventory,
      appendPrimitiveCallsites,
      wiredFamiliesByMode: Object.fromEntries(
        [...wiredFamiliesByMode].map(([mode, families]) => [mode, [...families].sort()])
      ),
      unclassifiedRecorderWriters,
      unclassifiedPortWriters,
      negativeControl: {
        syntheticRecorderHits,
        syntheticPortHits,
        realSourceUnclassified: unclassifiedOfRecorder(recorderSource).length + unclassifiedOfPort(ledgerSource).length,
      },
    },
  },
  trustedBoundary: {
    factoryArity: {
      human: createHumanConsoleUserTurnIngress.length,
      agent: createAgentRunnerUserTurnIngress.length,
      assistant: createCharacterAssistantTurnIngress.length,
    },
    negatives: {
      dtoWithAttributionField: dtoCode,
      handWrittenContext: handWrittenCode,
      jsonRoundTripContext: jsonRoundTripCode,
      handWrittenEvidenceToken: fakeEvidenceCode,
      presenterMismatch: mismatchCode,
      ambiguousIngress: ambiguityCode,
      frozenContext: frozenThrow,
    },
  },
  humanIngress: {
    row: {
      attribution_origin: humanRow.attribution_origin,
      actorType: humanRow.actor_type,
      actor: slotReadingOfRow(humanRow, 'actor'),
      contentOriginator: slotReadingOfRow(humanRow, 'contentOriginator'),
      recordedBy: slotReadingOfRow(humanRow, 'recordedBy'),
      axisB: [humanRow.source_kind, humanRow.source_authority, humanRow.epistemic_source],
    },
    constructionMatchesDb: json(contextReading(humanConstruction)) === json(rowReading(humanRow)),
    queryDto: humanDto ?? null,
  },
  agentAsUserD01: {
    row: {
      attribution_origin: agentRow.attribution_origin,
      actorType: agentRow.actor_type,
      actor: slotReadingOfRow(agentRow, 'actor'),
      contentOriginator: slotReadingOfRow(agentRow, 'contentOriginator'),
      axisB: [agentRow.source_kind, agentRow.source_authority, agentRow.epistemic_source],
      containsUserPrincipal: json(rowReading(agentRow)).includes('USER'),
    },
    constructionMatchesDb: json(rowReading(agentRow)).includes('SERVICE'),
    queryDto: agentDto ?? null,
  },
  assistantIngress: {
    human: {
      actor: slotReadingOfRow(humanAssistantRow, 'actor'),
      contentOriginator: slotReadingOfRow(humanAssistantRow, 'contentOriginator'),
      axisB: [
        humanAssistantRow.source_kind,
        humanAssistantRow.source_authority,
        humanAssistantRow.epistemic_source,
      ],
    },
    agent: {
      actor: slotReadingOfRow(agentAssistantRow, 'actor'),
      axisB: [agentAssistantRow.source_kind, agentAssistantRow.source_authority],
    },
    presenterMismatch: assistantMismatchCode,
    missingPresenter: slotReadingOfValue(assistantNoPresenter.actor as never),
  },
  systemToolFamilies: {
    productionCallers: productionSystemCallers,
    wiredFamilies: ['user_message', 'assistant_message'],
    unwiredRowOrigin: 'NULL（如实记 legacy，不伪造）',
  },
  endToEnd: {
    traceIds: { human: human.traceId, agent: agent.traceId },
    readbackMatchesDb: true,
    queryMatchesDb: true,
  },
  crossLedgerK27: {
    humanAction: { actionId: human.actionId, initiator: human.actionInitiator },
    agentAction: { actionId: agent.actionId, initiator: agent.actionInitiator },
    surfaces: d01Surfaces,
    noUserSubstitution: d01Surfaces.every((surface) => !surface.value.includes('"USER"')),
  },
  compatibility: {
    legacyOriginNull: legacyUserRow.attribution_origin === null,
    legacyUserAuthority: legacyUserRow.source_authority,
    wiredReplyConfirmationAuthority: 'USER_EXPLICIT',
    legacyReplyConfirmationAuthority: 'USER_REPLY_CONFIRMATION',
    sameMemoryAuthority: true,
    evalFixturesInjectedWiring: evalWired.length,
    legacySites: legacySites.map(([file, item]) => ({ file, reason: item.reason })),    restore: {
      legacyAgain: restoredRow.attribution_origin === null,
      rewiredAgain: rewiredRow.attribution_origin === 'RECORDED',
    },
  },
  cognitivePlane: {
    authorityMap,
    unconfirmedOriginStillThrows: true,
    /*
     * ⚠️ M5.1.1 Phase 4a 判据取代（用户 2026-09-19 裁定）：
     *
     * 原来这里是**一个 `extractorReadsRowAxisB: false`**，含义是"抽取器完全不读行上的
     * Axis B"。4a 之后这句话**不再成立**（形成期闸必须消费**受信**来源资格读数）。
     *
     * 但它**不能**被简单改成 `true` —— 那会把两条不同的读数压成一个（正是本项目反复
     * 踩过的那类缺陷）。拆成各自为真的几条：
     *   · **权威推导**（`evidenceProfileOf`）仍然**不读**行上的 Axis B（从 actorType 现场推导）
     *   · **来源资格**读它，但**只**经唯一派生适配边界（`processorEventViewOf`）
     *   · 适配边界**之外**对原始归因的引用数 = 0；下游候选解析读原始归因 = false
     */
    authorityDerivationReadsRowAxisB: false,
    qualificationReadsRowAxisB: 'through-trusted-adapter-only',
    rawAttributionRefsOutsideAdapter: rawAttributionOutsideAdapter,
    downstreamReadsRawAttribution,
    downstreamConsumesDerivedReading: downstreamConsumesReading,
    recallTouched: recallTouched.length,
  },
  schemaBoundary: {
    latestSchemaVersion: schemaVersion,
    migration0007Sha256: fingerprint(7),
    migration0008Sha256: fingerprint(8),
    schemaChangeRequired: false,
  },
  sandbox: { dir: sandbox.dir, isProductionDir: isProductionDir(sandbox.dir) },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    liveDb: false,
    wp7Started: false,
    schemaChanged: false,
    developerControlTouched: false,
    adr043Touched: false,
    /*
     * ⚠️ 这句话说的是**本 verifier 自己**：它不执行任何 Phase 4 工作。
     *    它**不**否认 4a 的存在 —— 这一次它的一条 §10 判据是被**授权取代**的。
     */
    phase4Touched: false,
    phase4aCriterionSupersession: {
      authorizedBy: '用户 2026-09-19 裁定：授权两条判据层面的取代，仅限「改门 + F4 登记 + 重新出证据」',
      replacedAssertion:
        '★ §10 extractor **没有**被接线到归因（源码里不出现 attribution / contentOriginator）',
      replacementBoundary:
        '归因接触被限制在唯一派生适配边界（processorEventViewOf）内；下游候选解析只消费 view.trustedOrigin',
      record: 'docs/m5.1.1/M5.1.1-WP11-Compatible-Assertion-Record.md §9',
    },
  },
}

mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(
  join(EVIDENCE_DIR, 'wp6.1-conversation-ingress.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  'utf8'
)
console.log(`\n证据已写入：artifacts/m5.1.1/wp6.1-conversation-ingress.json`)

await h.stop()

console.log(`\n${'='.repeat(74)}`)
console.log(`M5.1.1 WP6.1 conversation ingress closure：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
console.log('='.repeat(74))
process.exit(failed === 0 ? 0 : 1)
