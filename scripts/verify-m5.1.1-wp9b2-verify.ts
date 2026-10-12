/**
 * M5.1.1 / WP9-B2 —— **Production State Bootstrap Attestation** 专项门
 *
 * ============================================================================
 *  这道门回答什么（用户 B2-1 权威裁定的四条义务）
 * ============================================================================
 * WP9-B1 把**能力与边界**做好了（`recordStateEvent` 只收带 `TRUSTED_INGRESS_MARK`
 * 的信封），但 `src/state/init.ts` 没接线 ⇒ 生产里没有任何一条 `state_events`
 * 带信封（`E4-A = OPEN` / `WP9-GAP-1`）。B2 接上那条线，本门必须证明：
 *
 *   ① **Hard Gate（静态）**：只有**生产引导组件自己**能建立
 *      `KNOWN(SYSTEM/state-bootstrap)` 与 `KNOWN(SYSTEM_RULE/state-bootstrap-rule)`；
 *      **普通 `initCharacterState` 调用本身不构成鉴证**。
 *   ② **E4-A**：真实首启 + 受信 SYSTEM 证据 ⇒ `initiator = Known(SYSTEM/<component>)`
 *      （L1 与 L2 用**真实 `state_event` id** 关联）。
 *   ③ **E4-B**：**没有**受信因果证据 ⇒ 如实 `Unknown(RUNTIME_UNRESOLVED)`，
 *      绝不从 `trigger='init'` / 族名 / payload / `actor_type` / transport 猜一个 SYSTEM。
 *   ④ **三个核心负控**：
 *      (a) 删掉 SYSTEM attestation ⇒ `Known SYSTEM` 消失；
 *      (b) 只保留 `trigger='init'` ⇒ **不得**因此得到 `Known SYSTEM`；
 *      (c) 调用方自报 `SYSTEM/<id>`（手写同形对象 / `{...}` / JSON 往返 /
 *          直接给权威信封）⇒ **不得**进入权威槽位，且库里**一行都不多**。
 *
 * ============================================================================
 *  纪律（AGENTS §6/§7 + WP9B1-Handoff §"Next WP Preconditions" 第 6 条）
 * ============================================================================
 *  · 一个进程一个库：`isolateDatabase()` 在最前面；真实库**只被记录、从不被打开**
 *    （以 文件数 / 总字节 / mtime 三项比对证明它没被动 —— `data/**` 被 gitignore，
 *     用 git 证明它没变是**无效检查**）。
 *  · 计数型判据自检 `measured_count > 0`，否则 **MEASUREMENT INVALID**，不是 PASS。
 *  · 新判据走 **正控 / 负控 / 恢复** 三段式：本门的静态检测器用"临时 src 注入"
 *    做负控，运行期检测器用"同一读法在 E4-A 行 / E4-B 行 / 重新接线后的行"三点闭环。
 *  · 冻结面：本门**只写** `artifacts/m5.1.1/**`；`artifacts/m5.1/**` 与
 *    `artifacts/m4.5/**` 一字未动；`MIGRATION_0009` / `INITIAL_STATE` / manual reset
 *    语义都**只读不写**，且逐条对照。
 *
 * 跑法：pnpm m5.1.1:wp9b2:verify
 */

import 'dotenv/config'
import {
  PRODUCTION_DB_DIR,
  cleanupSandbox,
  isolateDatabase,
  isProductionDir,
  resetPluginSqlConnection,
} from '../src/dev/sandbox.ts'

const sandbox = isolateDatabase('m5.1.1-wp9b2')

import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import { sql } from 'drizzle-orm'
import * as ts from 'typescript'

import { M4_T0, createM4Harness } from './m4-harness.ts'
import { currentSchemaVersion, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { MIGRATIONS } from '../src/infrastructure/persistence/migrations.ts'
import { initCharacterState } from '../src/state/init.ts'
import {
  readStateEventAttribution,
  recordStateEvent,
  resetState,
} from '../src/state/repository.ts'
import { INITIAL_STATE, createInitialState } from '../src/state/types.ts'
import {
  STATE_BOOTSTRAP_AUTHORITY,
  STATE_BOOTSTRAP_COMPONENT,
  STATE_BOOTSTRAP_COMPONENT_ID,
  STATE_BOOTSTRAP_FAMILY,
  STATE_BOOTSTRAP_RULE_REF,
  attestStateBootstrapComponentIdentity,
  isTrustedStateBootstrapEvidence,
  stateTransitionAttributionOf,
  type StateBootstrapEvidence,
} from '../src/state/bootstrap-attestation.ts'
import {
  ATTRIBUTION_SLOT_COLUMNS,
  BACKFILL_CONTRACT_DEFERRED_FAMILIES,
  COGNITIVE_AXIS_B_FAMILIES,
  NECESSITY_MATRIX,
  STATE_TRANSITION_SYSTEM_ORIGIN_RULE,
  isCognitiveAxisBApplicable,
  isTrustedAttribution,
  validateAttributionNecessity,
  type AttributionEnvelope,
  type AuthorityRef,
  type TrustedAttribution,
} from '../src/kernel/contracts/attribution.ts'
import {
  attributionAbsent,
  attributionKnown,
  attributionUnknown,
  type PrincipalRef,
} from '../src/kernel/contracts/actor.ts'

// ---------------------------------------------------------------------------
// 检查器 / 量具
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, ok: boolean, detail: string): boolean {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}  [${detail}]`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}  [${detail}]`)
  }
  return ok
}

function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

/**
 * 计数型判据的自我交代。
 *
 * `valid` 的语义是**"我量到了我打算量的那个东西吗"**，不是"结果好不好"：
 * 量到 0 个对象的检测器与"一切正常"在输出上长得一样（AGENTS §6.8）。
 */
function measure(label: string, count: number, valid = count > 0): void {
  measurements.push({ label, count, valid })
  console.log(`  · 量：${label} = ${count}${valid ? '' : '   ← MEASUREMENT INVALID'}`)
}

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const ART = join(ROOT, 'artifacts', 'm5.1.1')

// ---------------------------------------------------------------------------
// 冻结期望（本门**自己写死** —— 不从实现里读回来，否则判据与实现在同一处漂移）
// ---------------------------------------------------------------------------

/** `MIGRATION_0009` 的指纹（WP9-B1 冻结；B2 **不得**改 v9） */
const FROZEN_MIGRATION_0009_SHA256 =
  '5a007003b773351fc870865e541e8d3e2a9e00ccf8e227f3c2b41eb1d5a8c27c'

/** `state_transition` 的冻结矩阵行（R-45；顺序 = initiator/actor/executor/authority/recordedBy/contentOriginator） */
const FROZEN_STATE_TRANSITION_ROW = {
  subject: 'DERIVED',
  initiator: 'REQUIRED',
  actor: 'REQUIRED',
  executor: 'ABSENT',
  authority: 'REQUIRED',
  recordedBy: 'REQUIRED',
  contentOriginator: 'ABSENT',
} as const

/** `INITIAL_STATE` 的内容（用户裁定：B2 **不得**改它）；键序与"排序后"的读法一致 */
const FROZEN_INITIAL_STATE = {
  arousal: 0,
  closeness: 0.6,
  trust: 0.85,
  valence: 0,
  version: 0,
} as const

/** 生产者与消费者的仓库相对路径（门的静态判据读它们） */
const PRODUCER_REL = 'state/bootstrap-attestation.ts'
const CONSUMER_REL = 'state/init.ts'
const ASSEMBLY_ROOT_REL = 'main.ts'
const FACTORY = 'attestStateBootstrapComponentIdentity'
const ENVELOPE_BUILDER = 'stateTransitionAttributionOf'

/** `src/state/init.ts` 的**代码**里不得出现的字面量 / 标识符（Hard Gate 的可测形式） */
const FORBIDDEN_IN_CONSUMER = {
  strings: ['SYSTEM', 'SYSTEM_RULE', 'state-bootstrap', 'state-bootstrap-rule'],
  identifiers: [
    'STATE_BOOTSTRAP_COMPONENT',
    'STATE_BOOTSTRAP_AUTHORITY',
    'STATE_BOOTSTRAP_COMPONENT_ID',
    'STATE_BOOTSTRAP_RULE_REF',
  ],
} as const

/** 生产者**代码**里不得出现的字面量（不得从 trigger / 表名推导身份） */
const FORBIDDEN_IN_PRODUCER_STRINGS = ['init', 'state_events', 'manual', 'actor_type'] as const

// ---------------------------------------------------------------------------
// 静态检测器（AST）—— 正控 / 负控 / 恢复三段式在 §5
// ---------------------------------------------------------------------------

interface FileFacts {
  rel: string
  strings: string[]
  identifiers: Set<string>
  calls: { name: string; line: number }[]
  paramCounts: Map<string, number>
  exportedNames: Set<string>
}

function listSourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '.git') continue
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (name.endsWith('.ts')) out.push(abs)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * ⚠️ 只读**语法树**：注释与文档里的 `'SYSTEM'` 字样**不算**违规。
 * 这条很关键 —— 文档必须能解释"为什么这里不许写 SYSTEM"，而解释本身会提到它。
 */
function factsOf(file: string, srcRoot: string): FileFacts {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const strings: string[] = []
  const identifiers = new Set<string>()
  const calls: { name: string; line: number }[] = []
  const paramCounts = new Map<string, number>()
  const exportedNames = new Set<string>()
  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      strings.push(node.text)
    } else if (ts.isIdentifier(node)) {
      identifiers.add(node.text)
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      calls.push({ name: node.expression.text, line: lineOf(node) })
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      paramCounts.set(node.name.text, node.parameters.length)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      const init = node.initializer
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        paramCounts.set(node.name.text, init.parameters.length)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  for (const statement of sf.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    const isExported = (modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    if (!isExported) continue
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) exportedNames.add(declaration.name.text)
      }
    } else if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement)) &&
      statement.name !== undefined
    ) {
      exportedNames.add(statement.name.text)
    }
  }

  return { rel: relative(srcRoot, file).split('\\').join('/'), strings, identifiers, calls, paramCounts, exportedNames }
}

interface StaticReport {
  files: number
  findings: string[]
  readings: Record<string, string | number>
}

/**
 * Hard Gate 的**静态**判据。
 *
 * 每一条都对应"只有生产引导组件自己能建立这个身份"的一个可测面；
 * 任何一条被破坏都必须让检测器**响**（§5 用注入式负控证明它真的会响）。
 */
function detectHardGateStatic(srcRoot: string): StaticReport {
  const files = listSourceFiles(srcRoot)
  const facts = files.map((file) => factsOf(file, srcRoot))
  const findings: string[] = []
  const byRel = new Map(facts.map((f) => [f.rel, f]))
  const rel = (path: string): string => path.replace(/\\/g, '/')

  // R1：组件身份的**唯一定义点** = 生产者模块
  const componentDefiners = facts.filter((f) => f.exportedNames.has('STATE_BOOTSTRAP_COMPONENT')).map((f) => f.rel)
  if (componentDefiners.length !== 1 || componentDefiners[0] !== PRODUCER_REL) {
    findings.push(`R1 STATE_BOOTSTRAP_COMPONENT 的定义点必须恰好是 ${PRODUCER_REL}，实际 [${componentDefiners.join(', ')}]`)
  }

  // R2：身份工厂的生产调用点**恰好一个**，且必须是装配根
  const allMintCalls = facts.flatMap((f) => f.calls.filter((c) => c.name === FACTORY).map((c) => `${f.rel}:${c.line}`))
  const productionMintCalls = allMintCalls.filter((c) => !c.startsWith(`${rel(PRODUCER_REL)}:`))
  if (productionMintCalls.length !== 1 || !productionMintCalls[0]!.startsWith(`${rel(ASSEMBLY_ROOT_REL)}:`)) {
    findings.push(`R2 ${FACTORY}() 的生产调用点必须恰好一个且位于 ${ASSEMBLY_ROOT_REL}，实际 [${productionMintCalls.join(', ')}]`)
  }

  // R3：消费者（init.ts）的**代码**里不出现身份 / 授权
  const consumer = byRel.get(rel(CONSUMER_REL))
  if (consumer === undefined) {
    findings.push(`R3 找不到消费者模块 ${CONSUMER_REL}`)
  } else {
    const badStrings = consumer.strings.filter((s) =>
      (FORBIDDEN_IN_CONSUMER.strings as readonly string[]).includes(s)
    )
    if (badStrings.length > 0) {
      findings.push(`R3 ${CONSUMER_REL} 的代码里出现身份/授权字面量 [${badStrings.join(', ')}]`)
    }
    const badIdentifiers = FORBIDDEN_IN_CONSUMER.identifiers.filter((name) => consumer.identifiers.has(name))
    if (badIdentifiers.length > 0) {
      findings.push(`R3 ${CONSUMER_REL} 引用了身份/授权常量 [${badIdentifiers.join(', ')}]`)
    }
  }

  // R4：身份工厂**无参数**（调用方无法指定 principal / authority / 组件名）
  const producer = byRel.get(rel(PRODUCER_REL))
  if (producer === undefined) {
    findings.push(`R4 找不到生产者模块 ${PRODUCER_REL}`)
  } else {
    const params = producer.paramCounts.get(FACTORY)
    if (params !== 0) {
      findings.push(`R4 ${FACTORY} 必须无参数（调用方不得自报身份），实际参数数 = ${String(params)}`)
    }
    // R5：生产者不得从 trigger / 表名 / 展示角色推导身份
    const derived = producer.strings.filter((s) =>
      (FORBIDDEN_IN_PRODUCER_STRINGS as readonly string[]).includes(s)
    )
    if (derived.length > 0) {
      findings.push(`R5 ${PRODUCER_REL} 的代码里出现"从事件长什么样推导身份"的字面量 [${derived.join(', ')}]`)
    }
    // R6：品牌不导出（外部造不出满足类型标注的证据 token）
    if (producer.exportedNames.has('BOOTSTRAP_EVIDENCE_BRAND')) {
      findings.push('R6 证据品牌 BOOTSTRAP_EVIDENCE_BRAND **被导出**了 —— 外部即可构造 token')
    }
    if (!producer.identifiers.has('REGISTERED_BOOTSTRAP_EVIDENCE') || !producer.identifiers.has('WeakSet')) {
      findings.push('R6 生产者缺少运行期 WeakSet 登记（结构克隆防线不见了）')
    }
  }

  // R7：信封的唯一生产调用点是消费者
  const envelopeCalls = facts.flatMap((f) =>
    f.calls.filter((c) => c.name === ENVELOPE_BUILDER).map((c) => `${f.rel}:${c.line}`)
  )
  const envelopeCallsOutsideProducer = envelopeCalls.filter((c) => !c.startsWith(`${rel(PRODUCER_REL)}:`))
  if (
    envelopeCallsOutsideProducer.length !== 1 ||
    !envelopeCallsOutsideProducer[0]!.startsWith(`${rel(CONSUMER_REL)}:`)
  ) {
    findings.push(
      `R7 ${ENVELOPE_BUILDER}() 的生产调用点必须恰好一个且位于 ${CONSUMER_REL}，实际 [${envelopeCallsOutsideProducer.join(', ')}]`
    )
  }

  return {
    files: files.length,
    findings,
    readings: {
      files: files.length,
      componentDefiners: componentDefiners.join(', ') || '(无)',
      productionMintCalls: productionMintCalls.join(', ') || '(无)',
      envelopeCalls: envelopeCallsOutsideProducer.join(', ') || '(无)',
      factoryParamCount: producer?.paramCounts.get(FACTORY) ?? -1,
      brandExported: String(producer?.exportedNames.has('BOOTSTRAP_EVIDENCE_BRAND') ?? true),
    },
  }
}

// ---------------------------------------------------------------------------
// 真实库"只被记录、从不被打开"的快照（文件数 / 总字节 / mtime 三项）
// ---------------------------------------------------------------------------

function dirFingerprint(dir: string): { files: number; bytes: number; mtime: string } | null {
  try {
    const entries = readdirSync(dir, { recursive: true }) as string[]
    let files = 0
    let bytes = 0
    for (const entry of entries) {
      const abs = join(dir, entry)
      const stat = statSync(abs)
      if (!stat.isFile()) continue
      files += 1
      bytes += stat.size
    }
    return { files, bytes, mtime: statSync(dir).mtime.toISOString() }
  } catch {
    return null
  }
}

// ===========================================================================
section('§0 沙箱 / 边界 / 冻结面只读快照')
// ===========================================================================

const prodBefore = dirFingerprint(PRODUCTION_DB_DIR)
console.log(`  [sandbox] ${sandbox.dir.replace(tmpdir(), '<tmp>')}`)
console.log(`  [real-db] ${PRODUCTION_DB_DIR} → ${JSON.stringify(prodBefore)}`)
check(
  '沙箱不是真实库（`isProductionDir === false` 且目录在 tmp 下）',
  isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()),
  sandbox.dir.replace(tmpdir(), '<tmp>')
)
check(
  '真实库路径只被记录、从未被打开（`PGLITE_DATA_DIR` 指向沙箱）',
  PRODUCTION_DB_DIR.endsWith(join('data', 'pglite')) && process.env.PGLITE_DATA_DIR !== PRODUCTION_DB_DIR,
  PRODUCTION_DB_DIR
)

await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm511-wp9b2' })
const db = h.db
const runtime = h.runtime
const characterId = String(h.kernel.characterId)
const schemaVersion = await currentSchemaVersion(db)
measure('沙箱 schema 版本', schemaVersion)
check('沙箱 = 代码最新 schema v9（v9 = B1 的 `state_events` 归因承载）', schemaVersion === 9, `v${schemaVersion}`)

// ---------------------------------------------------------------------------
// 沙箱读法（独立于实现：列名来自 canonical 映射，判定在本门自己写）
// ---------------------------------------------------------------------------

const ATTRIBUTION_COLUMN_NAMES = [
  'attribution_origin',
  ...Object.values(ATTRIBUTION_SLOT_COLUMNS).flatMap((names) => [
    names.kind,
    names.id,
    names.unknownReason,
  ]),
]

async function physicalRow(id: string): Promise<Record<string, unknown> | undefined> {
  const rows = rowsOf(
    await db.execute(
      sql`select id, character_id, user_id, trigger, reason, attribution_origin,
                 ${sql.raw(ATTRIBUTION_COLUMN_NAMES.slice(1).join(', '))}
          from state_events where id = ${id} limit 1`
    )
  ) as Record<string, unknown>[]
  return rows[0]
}

/** 物理三格 → 可读三态（`KNOWN|kind|id|-` / `UNKNOWN|-|-|reason` / `ABSENT|-|-|-`） */
function slotTriple(row: Readonly<Record<string, unknown>> | undefined, slot: string): string {
  if (row === undefined) return 'ROW-MISSING'
  const columns = (ATTRIBUTION_SLOT_COLUMNS as Record<string, { kind: string; id: string; unknownReason: string }>)[slot]
  if (columns === undefined) return 'SLOT-UNKNOWN'
  const kind = row[columns.kind]
  const id = row[columns.id]
  const reason = row[columns.unknownReason]
  if (kind === null || kind === undefined) {
    return reason === null || reason === undefined ? 'ABSENT|-|-|-' : `UNKNOWN|-|-|${String(reason)}`
  }
  return `KNOWN|${String(kind)}|${String(id)}|-`
}

/**
 * 运行期检测器：库里"哪几行在 initiator/actor/authority 上自称 SYSTEM/state-bootstrap"。
 *
 * 这是负控 (a)"删掉 attestation ⇒ Known SYSTEM 消失"的**量具本尊** ——
 * §5 会证明它在该响的时候真的响。
 */
async function stateBootstrapClaimRows(): Promise<{ id: string; slots: string }[]> {
  const rows = rowsOf(
    await db.execute(
      sql`select id,
                 ${sql.raw(
                   [
                     ATTRIBUTION_SLOT_COLUMNS.initiator.kind,
                     ATTRIBUTION_SLOT_COLUMNS.initiator.id,
                     ATTRIBUTION_SLOT_COLUMNS.actor.kind,
                     ATTRIBUTION_SLOT_COLUMNS.actor.id,
                     ATTRIBUTION_SLOT_COLUMNS.authority.kind,
                     ATTRIBUTION_SLOT_COLUMNS.authority.id,
                   ].join(', ')
                 )}
          from state_events`
    )
  ) as Record<string, unknown>[]
  return rows
    .filter(
      (row) =>
        row[ATTRIBUTION_SLOT_COLUMNS.initiator.id] === STATE_BOOTSTRAP_COMPONENT_ID ||
        row[ATTRIBUTION_SLOT_COLUMNS.actor.id] === STATE_BOOTSTRAP_COMPONENT_ID ||
        row[ATTRIBUTION_SLOT_COLUMNS.authority.id] === STATE_BOOTSTRAP_RULE_REF
    )
    .map((row) => ({
      id: String(row.id),
      slots:
        `initiator=${String(row[ATTRIBUTION_SLOT_COLUMNS.initiator.kind])}/${String(row[ATTRIBUTION_SLOT_COLUMNS.initiator.id])}` +
        ` actor=${String(row[ATTRIBUTION_SLOT_COLUMNS.actor.kind])}/${String(row[ATTRIBUTION_SLOT_COLUMNS.actor.id])}` +
        ` authority=${String(row[ATTRIBUTION_SLOT_COLUMNS.authority.kind])}/${String(row[ATTRIBUTION_SLOT_COLUMNS.authority.id])}`,
    }))
}

async function stateEventCount(): Promise<number> {
  const rows = rowsOf(await db.execute(sql`select count(*)::int as c from state_events`)) as { c: number }[]
  return Number(rows[0]?.c ?? 0)
}

// ===========================================================================
section('§1 契约前提：B2 **没有**改判据（矩阵行 / 非 Axis B / 回填分类 / 溯源规则）')
// ===========================================================================

const stateRow = NECESSITY_MATRIX[STATE_BOOTSTRAP_FAMILY]
const stateRowCells = {
  subject: stateRow.subject,
  initiator: stateRow.initiator,
  actor: stateRow.actor,
  executor: stateRow.executor,
  authority: stateRow.authority,
  recordedBy: stateRow.recordedBy,
  contentOriginator: stateRow.contentOriginator,
}
measure('state_transition 矩阵行的单元格数', Object.keys(stateRowCells).length)
check(
  '★ B2 **没有**改矩阵：state_transition 行逐格 == R-45 冻结值',
  JSON.stringify(stateRowCells) === JSON.stringify(FROZEN_STATE_TRANSITION_ROW),
  JSON.stringify(stateRowCells)
)
check(
  '★ B2 **没有**改判据归属：state_transition 仍**不在** COGNITIVE_AXIS_B_FAMILIES（且 isApplicable=false）',
  !COGNITIVE_AXIS_B_FAMILIES.includes(STATE_BOOTSTRAP_FAMILY) &&
    isCognitiveAxisBApplicable(STATE_BOOTSTRAP_FAMILY) === false,
  `axisB 族 = ${COGNITIVE_AXIS_B_FAMILIES.join(',')}`
)
check(
  '★ B2 **没有**改回填分类：state_transition 仍在 BACKFILL_CONTRACT_DEFERRED_FAMILIES 里',
  BACKFILL_CONTRACT_DEFERRED_FAMILIES.includes(STATE_BOOTSTRAP_FAMILY),
  `${BACKFILL_CONTRACT_DEFERRED_FAMILIES.length} 个族`
)
measure('溯源规则文本的长度', STATE_TRANSITION_SYSTEM_ORIGIN_RULE.length)
check(
  '★ 溯源规则仍在位：SYSTEM 只能来自组件自己的受信身份，且逐条点名禁止的推导来源',
  STATE_TRANSITION_SYSTEM_ORIGIN_RULE.includes('受信身份') &&
    ['trigger', 'payload', 'actor_type', 'requestedBy', 'transport'].every((needle) =>
      STATE_TRANSITION_SYSTEM_ORIGIN_RULE.includes(needle)
    ),
  STATE_TRANSITION_SYSTEM_ORIGIN_RULE.slice(0, 48) + '…'
)
check(
  '冻结身份常量本身 = 用户裁定的 `SYSTEM/state-bootstrap` + `SYSTEM_RULE/state-bootstrap-rule`',
  STATE_BOOTSTRAP_COMPONENT.kind === 'SYSTEM' &&
    STATE_BOOTSTRAP_COMPONENT.id === 'state-bootstrap' &&
    STATE_BOOTSTRAP_AUTHORITY.kind === 'SYSTEM_RULE' &&
    STATE_BOOTSTRAP_AUTHORITY.ref === 'state-bootstrap-rule',
  `${STATE_BOOTSTRAP_COMPONENT.kind}/${STATE_BOOTSTRAP_COMPONENT.id} · ${STATE_BOOTSTRAP_AUTHORITY.kind}/${STATE_BOOTSTRAP_AUTHORITY.ref}`
)

// ===========================================================================
section('§2 Hard Gate（静态）：只有生产引导组件自己能建立这个身份')
// ===========================================================================

const staticReport = detectHardGateStatic(SRC)
measure('静态检测器扫描的 src 文件数', staticReport.files)
console.log(`  · 读数：${JSON.stringify(staticReport.readings)}`)
check(
  '★★ Hard Gate：静态判据 R1–R7 全部成立（身份唯一定义在生产者 / 工厂无参数 / 品牌不导出 / ' +
    '生产调用点恰好一个且在 main.ts / init.ts 代码里没有身份与授权 / 信封只由 init.ts 生产）',
  staticReport.findings.length === 0,
  staticReport.findings.join(' ; ') || '0 条违规'
)

// ===========================================================================
section('§3 E4-A：真实首启 + 受信 SYSTEM 证据 ⇒ Known(SYSTEM/state-bootstrap)')
// ===========================================================================

const e4aUser = 'user-wp9b2-e4a'
const e4aEvidence = attestStateBootstrapComponentIdentity()
measure('受信证据 token 通过运行期守卫（正控）', isTrustedStateBootstrapEvidence(e4aEvidence) ? 1 : 0)
check(
  '正控：工厂产出的 token 是受信证据（`isTrustedStateBootstrapEvidence === true`）',
  isTrustedStateBootstrapEvidence(e4aEvidence),
  `attestedBy=${e4aEvidence.attestedBy} component=${e4aEvidence.componentId}`
)

const e4a = await initCharacterState(runtime, characterId, e4aUser, { bootstrapEvidence: e4aEvidence })
measure('E4-A 返回的 state_event id 长度', e4a.stateEventId?.length ?? 0)
check(
  'E4-A L1：首次建档（created=true）且返回**真实** state_event id',
  e4a.created === true && typeof e4a.stateEventId === 'string' && e4a.stateEventId.length > 0,
  `created=${String(e4a.created)} id=${String(e4a.stateEventId)}`
)
const e4aRow = await physicalRow(String(e4a.stateEventId))
check(
  'E4-A L1↔L2 关联：返回值里的 id **就是**物理表里那一行（真实键，不是文本对应）',
  e4aRow !== undefined && String(e4aRow.id) === String(e4a.stateEventId),
  `l1=${String(e4a.stateEventId)} l2=${String(e4aRow?.id)}`
)
check(
  'E4-A L2 前提：这一行确实是首启行（trigger = init）且属于本次身份',
  e4aRow?.trigger === 'init' && e4aRow?.character_id === characterId && e4aRow?.user_id === e4aUser,
  `trigger=${String(e4aRow?.trigger)} char=${String(e4aRow?.character_id)} user=${String(e4aRow?.user_id)}`
)

const E4A_EXPECTED: Record<string, string> = {
  initiator: `KNOWN|SYSTEM|${STATE_BOOTSTRAP_COMPONENT_ID}|-`,
  actor: `KNOWN|SYSTEM|${STATE_BOOTSTRAP_COMPONENT_ID}|-`,
  executor: 'ABSENT|-|-|-',
  authority: `KNOWN|SYSTEM_RULE|${STATE_BOOTSTRAP_RULE_REF}|-`,
  recordedBy: 'KNOWN|SYSTEM|kernel|-',
  contentOriginator: 'ABSENT|-|-|-',
}
const e4aSlots = Object.fromEntries(
  Object.keys(E4A_EXPECTED).map((slot) => [slot, slotTriple(e4aRow, slot)])
) as Record<string, string>
measure('E4-A 物理槽位数', Object.keys(e4aSlots).length)
check(
  '★★ E4-A：物理 6 格逐格 == 冻结期望（initiator/actor = Known(SYSTEM/state-bootstrap)；' +
    'authority = Known(SYSTEM_RULE/state-bootstrap-rule)；recordedBy = Known(SYSTEM/kernel)；' +
    'executor/contentOriginator = Absent）',
  JSON.stringify(e4aSlots) === JSON.stringify(E4A_EXPECTED),
  Object.entries(e4aSlots).map(([k, v]) => `${k}=${v}`).join(' · ')
)
check('E4-A：`attribution_origin = RECORDED`（不是 MIGRATED_LEGACY）', e4aRow?.attribution_origin === 'RECORDED', String(e4aRow?.attribution_origin))

const e4aReadback = await readStateEventAttribution(runtime, String(e4a.stateEventId))
const e4aReadbackSlots = (e4aReadback.attribution?.slots ?? {}) as Record<string, { state: string }>
measure('E4-A 受信回读到的槽位数', Object.keys(e4aReadbackSlots).length)
check(
  'E4-A L2 回读（canonical 读取器）：origin=RECORDED，且 6 格三态与物理列**逐格一致**',
  e4aReadback.found &&
    e4aReadback.attribution?.attributionOrigin === 'RECORDED' &&
    Object.keys(E4A_EXPECTED).every((slot) => {
      const state = e4aReadbackSlots[slot]?.state
      const expected = E4A_EXPECTED[slot]!.split('|')[0]
      return state === expected
    }),
  Object.entries(e4aReadbackSlots)
    .map(([k, v]) => `${k}=${v.state}`)
    .join(' · ')
)

// subject 是**派生**语义，不落列（U-13）：核对派生规则本身 + 物理表里确实没有 subject 列
const derivedEnvelope = stateTransitionAttributionOf({ characterId, evidence: e4aEvidence })
check(
  '★ subject = DERIVED `CHARACTER/<character_id>`，且 `user_id` **不进信封**（关系维度留在行上）',
  derivedEnvelope.subject.kind === 'CHARACTER' &&
    derivedEnvelope.subject.id === characterId &&
    !('subject' in ATTRIBUTION_SLOT_COLUMNS) &&
    Object.values(ATTRIBUTION_SLOT_COLUMNS).every(
      (names) => !Object.values(names).some((column) => /user_id|subject/.test(column))
    ),
  `subject=${derivedEnvelope.subject.kind}/${derivedEnvelope.subject.id} · row.user_id=${String(e4aRow?.user_id)}`
)

// ===========================================================================
section('§4 E4-B：**没有**受信因果证据 ⇒ 如实 Unknown(RUNTIME_UNRESOLVED)')
// ===========================================================================

const e4bUser = 'user-wp9b2-e4b'
/** **普通调用**（不带任何受信证据）—— 这就是"没有受信因果证据"的生产形状 */
const e4b = await initCharacterState(runtime, characterId, e4bUser)
measure('E4-B 返回的 state_event id 长度', e4b.stateEventId?.length ?? 0)
check(
  'E4-B L1：普通 `initCharacterState(runtime, characterId, userId)` 仍然正常工作（首次建档）',
  e4b.created === true && typeof e4b.stateEventId === 'string' && e4b.stateEventId.length > 0,
  `created=${String(e4b.created)} id=${String(e4b.stateEventId)}`
)
const e4bRow = await physicalRow(String(e4b.stateEventId))
const E4B_EXPECTED: Record<string, string> = {
  initiator: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  actor: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  executor: 'ABSENT|-|-|-',
  authority: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  recordedBy: 'KNOWN|SYSTEM|kernel|-',
  contentOriginator: 'ABSENT|-|-|-',
}
const e4bSlots = Object.fromEntries(
  Object.keys(E4B_EXPECTED).map((slot) => [slot, slotTriple(e4bRow, slot)])
) as Record<string, string>
measure('E4-B 物理槽位数', Object.keys(e4bSlots).length)
check(
  '★★ E4-B：没有受信证据 ⇒ initiator / actor / authority 如实 `Unknown(RUNTIME_UNRESOLVED)`；' +
    'recordedBy 仍是 `Known(SYSTEM/kernel)`；executor/contentOriginator = Absent',
  JSON.stringify(e4bSlots) === JSON.stringify(E4B_EXPECTED),
  Object.entries(e4bSlots).map(([k, v]) => `${k}=${v}`).join(' · ')
)
check(
  '★ E4-B：`REQUIRED` 槽位被写成 `Unknown` **而不是** `Absent`（U-04：两者不可折叠）',
  e4bRow?.[ATTRIBUTION_SLOT_COLUMNS.initiator.unknownReason] === 'RUNTIME_UNRESOLVED' &&
    e4bRow?.[ATTRIBUTION_SLOT_COLUMNS.initiator.kind] === null &&
    e4bRow?.[ATTRIBUTION_SLOT_COLUMNS.authority.unknownReason] === 'RUNTIME_UNRESOLVED',
  `initiator.kind=${String(e4bRow?.[ATTRIBUTION_SLOT_COLUMNS.initiator.kind])} reason=${String(e4bRow?.[ATTRIBUTION_SLOT_COLUMNS.initiator.unknownReason])}`
)

/**
 * canonical 判据侧的非空转自证：E4-B 这种形状是**合法**的（0 违规），
 * 而把同一个槽位写成 `Absent` **必须被拒** —— 否则"0 违规"是判据哑了。
 */
const e4bEnvelope: AttributionEnvelope = {
  subject: { kind: 'CHARACTER', id: characterId } as PrincipalRef,
  initiator: attributionUnknown<PrincipalRef>('RUNTIME_UNRESOLVED'),
  actor: attributionUnknown<PrincipalRef>('RUNTIME_UNRESOLVED'),
  executor: attributionAbsent<PrincipalRef>(),
  authority: attributionUnknown<AuthorityRef>('RUNTIME_UNRESOLVED'),
  recordedBy: attributionKnown<PrincipalRef>({ kind: 'SYSTEM', id: 'kernel' }),
  contentOriginator: attributionAbsent<PrincipalRef>(),
  attributionOrigin: 'RECORDED',
}
const e4bViolations = validateAttributionNecessity({ family: STATE_BOOTSTRAP_FAMILY, envelope: e4bEnvelope })
const e4bAbsentViolations = validateAttributionNecessity({
  family: STATE_BOOTSTRAP_FAMILY,
  envelope: { ...e4bEnvelope, initiator: attributionAbsent<PrincipalRef>() },
})
measure('E4-B 形状在 canonical 判据下的违规数（期望 0）', Math.max(e4bViolations.length, 0), true)
check(
  '★ E4-B 形状在**冻结矩阵**下是合法的（0 违规）—— 不是"碰巧能插进去"',
  e4bViolations.length === 0,
  e4bViolations.map((v) => `${v.slot}/${v.code}`).join(' · ') || '0 违规'
)
const e4bAbsentCodes = e4bAbsentViolations.map((v) => `${v.slot}/${v.code}`)
measure('同一判据对"initiator 写成 Absent"报出的违规数（期望 > 0）', e4bAbsentViolations.length)
check(
  '★ 判据非空转（负控）：同一 validator 对 `initiator = Absent` 必报 `required_slot_absent`',
  e4bAbsentViolations.some((v) => v.slot === 'initiator' && v.code === 'required_slot_absent'),
  e4bAbsentCodes.join(' · ') || '(判据哑了)'
)

// ===========================================================================
section('§5 三个核心负控（正控 / 负控 / 恢复三段式）')
// ===========================================================================

// --- 负控 (a)：删掉 SYSTEM attestation ⇒ Known SYSTEM 消失 -----------------
const e4aClaims = await stateBootstrapClaimRows()
measure('负控(a) 正控：库里自称 SYSTEM/state-bootstrap 的行数（期望 1）', e4aClaims.length)
check(
  '负控(a) 正控：E4-A 那一行**确实**被检测器抓到（检测器不是哑的）',
  e4aClaims.length === 1 && e4aClaims[0]!.id === String(e4a.stateEventId),
  e4aClaims.map((c) => `${c.id.slice(0, 8)}[${c.slots}]`).join(' · ') || '(一行都没有)'
)
check(
  '★ 负控(a)：**删掉** SYSTEM attestation（E4-B 那次普通调用）⇒ `Known SYSTEM` 从那一行**消失**' +
    '（该行 initiator/actor/authority 都不是 SYSTEM/state-bootstrap）',
  !e4aClaims.some((c) => c.id === String(e4b.stateEventId)) &&
    slotTriple(e4bRow, 'initiator') === 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  `claims 里没有 ${String(e4b.stateEventId)?.slice(0, 8)}`
)

// --- 负控 (b)：只保留 trigger='init' ⇒ 不得因此得到 Known SYSTEM ------------
const legacyInitId = 'wp9b2-legacy-init-without-envelope'
const legacySnapshot = {
  valence: 0,
  arousal: 0,
  trust: 0.85,
  closeness: 0.6,
  version: 0,
}
await db.execute(
  sql`insert into state_events
        (id, character_id, user_id, before_state, delta, after_state,
         reason, trigger, state_version, message_id, created_at)
      values (${legacyInitId}, ${characterId}, ${'user-wp9b2-legacy-init'},
              ${JSON.stringify(legacySnapshot)}::jsonb,
              ${JSON.stringify(legacySnapshot)}::jsonb,
              ${JSON.stringify(legacySnapshot)}::jsonb,
              ${'只保留 trigger=init 的历史形状'}, ${'init'}, 0, ${null}, ${M4_T0})`
)
const legacyRow = await physicalRow(legacyInitId)
const legacyReadback = await readStateEventAttribution(runtime, legacyInitId)
const legacyNonNullColumns = ATTRIBUTION_COLUMN_NAMES.filter(
  (column) => legacyRow?.[column] !== null && legacyRow?.[column] !== undefined
)
measure('负控(b) 检查的归因列数', ATTRIBUTION_COLUMN_NAMES.length)
check(
  '★ 负控(b)：`trigger = "init"` 但**没有**受信信封 ⇒ 该行 `attribution = undefined`（"从未记录过"），' +
    '19 个归因列全 NULL —— **不得**从 trigger 推断 SYSTEM',
  legacyReadback.found === true &&
    legacyReadback.attribution === undefined &&
    legacyNonNullColumns.length === 0 &&
    slotTriple(legacyRow, 'initiator') === 'ABSENT|-|-|-',
  `found=${String(legacyReadback.found)} attribution=${String(legacyReadback.attribution)} 非空列=[${legacyNonNullColumns.join(',')}]`
)
const claimsAfterLegacy = await stateBootstrapClaimRows()
measure('负控(b)：插入 legacy init 行之后，自称 SYSTEM 的行数（期望仍为 1）', claimsAfterLegacy.length)
check(
  '★ 负控(b)：插入那条"只有 trigger=init"的行之后，库里自称 SYSTEM 的行**没有增加**',
  claimsAfterLegacy.length === 1 && !claimsAfterLegacy.some((c) => c.id === legacyInitId),
  `claims=${claimsAfterLegacy.length}`
)
// 静态侧：生产者**从不读** trigger / 表名（R5 已在 §2 覆盖；这里再把读数点出来）
check(
  '★ 负控(b) 静态侧：生产者代码里不出现 `init` / `state_events` / `manual` / `actor_type` 字面量（R5）',
  staticReport.findings.every((finding) => !finding.startsWith('R5')),
  staticReport.findings.filter((f) => f.startsWith('R5')).join(' ; ') || 'R5 通过'
)

// --- 负控 (c)：调用方自报 SYSTEM/<id> ⇒ 不得进入权威槽位 -------------------
const realToken = attestStateBootstrapComponentIdentity()
const ATTACKER_ID = 'attacker-bootstrap'
const ATTACKER_RULE = 'attacker-rule'
const forgedEvidenceVariants: { label: string; value: unknown }[] = [
  { label: '手写同形对象（principal 指向 attacker）', value: {
    componentId: STATE_BOOTSTRAP_COMPONENT_ID,
    principal: { kind: 'SYSTEM', id: ATTACKER_ID },
    authority: { kind: 'SYSTEM_RULE', ref: ATTACKER_RULE },
    attestedBy: 'state-bootstrap-component',
  } },
  { label: '结构克隆 `{...real}`', value: { ...realToken } },
  { label: 'JSON 往返 `JSON.parse(JSON.stringify(real))`', value: JSON.parse(JSON.stringify(realToken)) },
  { label: '`Object.assign({}, real)`', value: Object.assign({}, realToken) },
]
measure('负控(c) 伪造证据变体数', forgedEvidenceVariants.length)

const rowsBeforeForgeries = await stateEventCount()
interface ForgeryOutcome {
  label: string
  initThrew: boolean
  initCode: string
  builderThrew: boolean
  builderCode: string
  guardPassed: boolean
}
const forgeryOutcomes: ForgeryOutcome[] = []
for (const [index, variant] of forgedEvidenceVariants.entries()) {
  let initThrew = false
  let initCode = '(未抛)'
  try {
    await initCharacterState(runtime, characterId, `user-wp9b2-forge-${index}`, {
      bootstrapEvidence: variant.value as StateBootstrapEvidence,
    })
  } catch (error) {
    initThrew = true
    initCode = String((error as { code?: string }).code ?? '(无 code)')
  }
  let builderThrew = false
  let builderCode = '(未抛)'
  try {
    stateTransitionAttributionOf({ characterId, evidence: variant.value as StateBootstrapEvidence })
  } catch (error) {
    builderThrew = true
    builderCode = String((error as { code?: string }).code ?? '(无 code)')
  }
  forgeryOutcomes.push({
    label: variant.label,
    initThrew,
    initCode,
    builderThrew,
    builderCode,
    guardPassed: isTrustedStateBootstrapEvidence(variant.value),
  })
}
const acceptedForgeries = forgeryOutcomes.filter(
  (outcome) => !(outcome.initThrew && outcome.builderThrew) || outcome.guardPassed
)
check(
  '★★ 负控(c1)：四种"调用方自报 SYSTEM/<id>"的伪造证据**全部**被 `initCharacterState` 与信封构造器' +
    '失败关闭拒绝（`untrusted_state_bootstrap_evidence`）',
  acceptedForgeries.length === 0 &&
    forgeryOutcomes.every(
      (outcome) => outcome.initCode === 'untrusted_state_bootstrap_evidence' &&
        outcome.builderCode === 'untrusted_state_bootstrap_evidence'
    ),
  forgeryOutcomes.map((o) => `${o.label}=${o.initCode}`).join(' · ')
)
check(
  '★★ 负控(c1)：同一批变体**没有一个**通过运行期守卫（`isTrustedStateBootstrapEvidence === false`）',
  forgedEvidenceVariants.every((variant) => !isTrustedStateBootstrapEvidence(variant.value)),
  forgedEvidenceVariants
    .map((variant, index) => `${index}:${String(isTrustedStateBootstrapEvidence(variant.value))}`)
    .join(' · ')
)
const rowsAfterForgeries = await stateEventCount()
measure('负控(c1) 伪造尝试前后 state_events 行数差（期望 0）', rowsBeforeForgeries === rowsAfterForgeries ? 1 : 0)
check(
  '★★ 负控(c1)：伪造尝试**一行都没写进账本**（state_events 行数不变）',
  rowsBeforeForgeries === rowsAfterForgeries,
  `${rowsBeforeForgeries} → ${rowsAfterForgeries}`
)

// c2：直接把"手写的权威信封"塞给写入路径（B1 的边界在 B2 的消费面上仍然有效）
const forgedEnvelope = {
  subject: { kind: 'CHARACTER', id: characterId },
  initiator: attributionKnown<PrincipalRef>({ kind: 'SYSTEM', id: ATTACKER_ID }),
  actor: attributionKnown<PrincipalRef>({ kind: 'SYSTEM', id: ATTACKER_ID }),
  executor: attributionAbsent<PrincipalRef>(),
  authority: attributionKnown<AuthorityRef>({ kind: 'SYSTEM_RULE', ref: ATTACKER_RULE }),
  recordedBy: attributionKnown<PrincipalRef>({ kind: 'SYSTEM', id: 'kernel' }),
  contentOriginator: attributionAbsent<PrincipalRef>(),
  attributionOrigin: 'RECORDED',
}
const forgedConstructed = stateTransitionAttributionOf({ characterId, evidence: realToken })
/**
 * (c2) 手写的"权威信封" —— 与 B1 的负控 (c) 同一形状：**没有** `TRUSTED_INGRESS_MARK`。
 */
const handWritten = { ...forgedEnvelope } as unknown as TrustedAttribution
let forgedEnvelopeThrew = false
let forgedEnvelopeCode = '(未抛)'
try {
  await recordStateEvent(runtime, {
    before: createInitialState(characterId, 'user-wp9b2-forged-envelope'),
    delta: { trust: 0 },
    after: createInitialState(characterId, 'user-wp9b2-forged-envelope'),
    reason: '负控(c2)：调用方自报权威信封',
    trigger: 'init',
    attribution: handWritten,
  })
} catch (error) {
  forgedEnvelopeThrew = true
  forgedEnvelopeCode = String((error as { code?: string }).code ?? '(无 code)')
}
check(
  '★★ 负控(c2)：手写的"权威信封"（攻击者的 initiator/authority，**没有**受信类型标记）' +
    '被写入路径拒绝（`untrusted_state_event_attribution`）—— B1 的边界在 B2 的消费面上仍然有效',
  forgedEnvelopeThrew && forgedEnvelopeCode === 'untrusted_state_event_attribution',
  `threw=${String(forgedEnvelopeThrew)} code=${forgedEnvelopeCode}`
)
/**
 * (c2-boundary) **如实登记本 WP 实测到的一条类型层边界**（AGENTS §6.6：判据错了要写进报告，
 * 不要悄悄改判据）：
 *
 * `TRUSTED_INGRESS_MARK` 是**类型层**标记（`attribution.ts:2381` 原文：
 * "外部 DTO 不可能顺手长成这个形状"），`isTrustedAttribution` 是对那个字符串的运行期
 * **结构**检查 —— 因此把一个**真实的**受信信封做浅拷贝（`{...trusted, ...override}`）会
 * **保留**标记。这条边界是 **B1 就存在的**，不是 B2 引入的；B2 也**没有**扩大它。
 *
 * ⚠️ 它在生产上**不可达**：调用方没有任何路径把自报信封交给 `recordStateEvent` ——
 *    `attribution` 的值只能来自 `stateTransitionAttributionOf`（静态 R7），
 *    而它的唯一受信输入是 WeakSet 登记的**证据 token**（负控 c1 已证明四种伪造全部被拒）。
 *    硬化这条运行期检查（例如给受信信封加 WeakSet 登记）属于**独立 WP**，
 *    不在用户裁定的 B2 范围内（"Implement the minimal trusted state-bootstrap producer"）。
 */
const spreadKeepsTypeMark = isTrustedAttribution({ ...forgedConstructed, ...forgedEnvelope })
measure(
  '负控(c2) 边界读数：真实受信信封的浅拷贝是否保留类型层标记（1 = 保留，0 = 不保留）',
  spreadKeepsTypeMark ? 1 : 0,
  true
)
check(
  '★ 负控(c2) 生产不可达性：调用方**没有**任何路径把自报信封交给 `recordStateEvent`' +
    '（静态 R7：信封只由 state/init.ts 从受信证据构造；R3：consumers 里没有身份/授权）',
  staticReport.findings.every((finding) => !finding.startsWith('R3') && !finding.startsWith('R7')),
  staticReport.findings.filter((f) => f.startsWith('R3') || f.startsWith('R7')).join(' ; ') || 'R3/R7 通过'
)

// c3：facts 夹带 untrusted 归因字段
const untrustedFieldOutcomes: string[] = []
for (const field of ['authority', 'executor', 'contentOriginator']) {
  try {
    stateTransitionAttributionOf({
      characterId,
      ...(field === 'authority'
        ? { authority: { kind: 'SYSTEM_RULE', ref: ATTACKER_RULE } }
        : field === 'executor'
          ? { executor: { kind: 'TOOL', id: ATTACKER_ID } }
          : { contentOriginator: { kind: 'USER', id: ATTACKER_ID } }),
    } as never)
    untrustedFieldOutcomes.push(`${field}=ACCEPTED`)
  } catch (error) {
    untrustedFieldOutcomes.push(`${field}=${String((error as { code?: string }).code ?? '(无 code)')}`)
  }
}
measure('负控(c3) 注入的 untrusted 字段数', untrustedFieldOutcomes.length)
check(
  '★ 负控(c3)：facts 夹带 `authority` / `executor` / `contentOriginator` ⇒ **全部**被拒' +
    '（`untrusted_attribution_field`，与对话 ingress 同一守卫）',
  untrustedFieldOutcomes.every((outcome) => outcome.endsWith('=untrusted_attribution_field')),
  untrustedFieldOutcomes.join(' · ')
)

// 攻击者位次**从未**进入任何权威列
const attackerRows = rowsOf(
  await db.execute(
    sql`select count(*)::int as c from state_events
        where ${sql.raw(ATTRIBUTION_SLOT_COLUMNS.initiator.id)} = ${ATTACKER_ID}
           or ${sql.raw(ATTRIBUTION_SLOT_COLUMNS.actor.id)} = ${ATTACKER_ID}
           or ${sql.raw(ATTRIBUTION_SLOT_COLUMNS.authority.id)} = ${ATTACKER_ID}
           or ${sql.raw(ATTRIBUTION_SLOT_COLUMNS.recordedBy.id)} = ${ATTACKER_ID}
           or ${sql.raw(ATTRIBUTION_SLOT_COLUMNS.authority.id)} = ${ATTACKER_RULE}`
  )
) as { c: number }[]
measure('负控(c) 全表里攻击者位次的出现次数（期望 0）', Number(attackerRows[0]?.c ?? 0), true)
check(
  '★★ 负控(c)：全表**没有**任何一行把攻击者写进 initiator/actor/authority/recordedBy（出现次数 = 0，不是空转）',
  Number(attackerRows[0]?.c ?? 0) === 0,
  `attacker='${ATTACKER_ID}' rule='${ATTACKER_RULE}'`
)

// --- 恢复：受信证据重新接线 ⇒ Known SYSTEM 重新出现（三段式的第三段） -------
const reattach = await initCharacterState(runtime, characterId, 'user-wp9b2-reattach', {
  bootstrapEvidence: attestStateBootstrapComponentIdentity(),
})
const claimsAfterReattach = await stateBootstrapClaimRows()
measure('恢复段：重新接线后自称 SYSTEM 的行数（期望 2）', claimsAfterReattach.length)
check(
  '★ 恢复（三段式第三段）：把受信证据**接回去** ⇒ `Known SYSTEM` 重新出现（检测器重新抓到 2 行）',
  reattach.created === true &&
    claimsAfterReattach.length === 2 &&
    claimsAfterReattach.some((c) => c.id === String(reattach.stateEventId)),
  claimsAfterReattach.map((c) => c.id.slice(0, 8)).join(' , ')
)

// ===========================================================================
section('§6 三段式（静态检测器）：合法输入安静 / 注入假象必响 / 放回真实实现重新安静')
// ===========================================================================

const injectedSrcRoot = join(mkdtempSync(join(tmpdir(), 'wp9b2-src-')), 'src')
let injectedFindings: string[] = []
let injectedReadings: Record<string, string | number> = {}
let injectedSandboxError = ''
try {
  cpSync(SRC, injectedSrcRoot, { recursive: true })
  // 注入①：第二个身份工厂调用点（装配根之外）
  writeFileSync(
    join(injectedSrcRoot, 'state', 'zz-synthetic-bootstrap-mint.ts'),
    [
      "import { attestStateBootstrapComponentIdentity } from './bootstrap-attestation.ts'",
      'export function synthesise(): unknown {',
      '  return attestStateBootstrapComponentIdentity()',
      '}',
      '',
    ].join('\n'),
    'utf8'
  )
  // 注入②：消费者代码里出现身份字面量
  const consumerPath = join(injectedSrcRoot, 'state', 'init.ts')
  writeFileSync(
    consumerPath,
    `${readFileSync(consumerPath, 'utf8')}\nexport const SYNTHETIC_HARD_GATE_PROBE = 'SYSTEM'\n`,
    'utf8'
  )
  const injected = detectHardGateStatic(injectedSrcRoot)
  injectedFindings = injected.findings
  injectedReadings = injected.readings
} catch (error) {
  injectedSandboxError = String((error as { message?: string }).message ?? error)
}

measure('注入负控下静态检测器报出的违规数（期望 ≥ 2）', injectedFindings.length)
check(
  '★ 负控（检测器必须响）：注入"第二个身份工厂调用点"+"消费者代码里的 SYSTEM 字面量" ⇒ ' +
    '检测器**必须**报出 R2 与 R3',
  injectedSandboxError === '' &&
    injectedFindings.some((f) => f.startsWith('R2')) &&
    injectedFindings.some((f) => f.startsWith('R3')),
  injectedSandboxError !== ''
    ? `注入环境异常：${injectedSandboxError}`
    : injectedFindings.join(' ; ')
)
const restoredAfterInjection = detectHardGateStatic(SRC)
measure('恢复后静态检测器报出的违规数（期望 0）', Math.max(restoredAfterInjection.findings.length, 0), true)
check(
  '★ 恢复（放回真实实现）⇒ 检测器**重新安静**（0 条违规）',
  restoredAfterInjection.findings.length === 0,
  restoredAfterInjection.findings.join(' ; ') || '0 条违规'
)
rmSync(injectedSrcRoot, { recursive: true, force: true })

// ===========================================================================
section('§7 冻结面：B2 不得改 v9 / INITIAL_STATE / manual reset 语义')
// ===========================================================================

const v9 = MIGRATIONS.find((migration) => migration.version === 9)
const v9Fingerprint =
  v9 === undefined ? '(缺)' : createHash('sha256').update(v9.statements.join('\n'), 'utf8').digest('hex')
measure('MIGRATION_0009 的语句数', v9?.statements.length ?? 0)
check(
  '★ `MIGRATION_0009` 指纹仍然 FROZEN（B2 一字未改 v9）',
  v9Fingerprint === FROZEN_MIGRATION_0009_SHA256,
  `${v9Fingerprint.slice(0, 16)}…`
)

const initialKeys = Object.keys(INITIAL_STATE)
measure('INITIAL_STATE 的字段数', initialKeys.length)
const initialSorted = Object.fromEntries(
  Object.entries(INITIAL_STATE as unknown as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
)
check(
  '★ `INITIAL_STATE` 内容未变（用户裁定：B2 不得改初始状态内容）',
  JSON.stringify(initialSorted) === JSON.stringify(FROZEN_INITIAL_STATE),
  JSON.stringify(initialSorted)
)

/** manual reset 语义：B2 **不得**给它加归因 */
const resetUser = 'user-wp9b2-manual-reset'
await initCharacterState(runtime, characterId, resetUser)
await resetState(runtime, characterId, resetUser, 'WP9-B2 门的 manual reset 对照')
const manualRows = rowsOf(
  await db.execute(
    sql`select id, trigger, attribution_origin, ${sql.raw(ATTRIBUTION_COLUMN_NAMES.slice(1).join(', '))}
        from state_events where character_id = ${characterId} and user_id = ${resetUser} and trigger = 'manual'
        order by created_at desc limit 1`
  )
) as Record<string, unknown>[]
const manualRow = manualRows[0]
const manualNonNull = ATTRIBUTION_COLUMN_NAMES.filter(
  (column) => manualRow?.[column] !== null && manualRow?.[column] !== undefined
)
measure('manual reset 行上被检查的归因列数', ATTRIBUTION_COLUMN_NAMES.length)
check(
  '★ manual reset 语义未变：`trigger = "manual"` 的行**仍然不带归因**（`attribution_origin` NULL、19 列全 NULL）',
  manualRow !== undefined && manualNonNull.length === 0,
  `rows=${manualRows.length} 非空列=[${manualNonNull.join(',')}]`
)

// 真实库：只记录，不打开
const prodAfter = dirFingerprint(PRODUCTION_DB_DIR)
measure('真实库指纹采样次数', prodBefore === null ? 1 : 2)
check(
  '★ 真实库 `data/pglite` **三项全等**（文件数 / 总字节 / mtime）—— 本门从未打开它',
  prodBefore !== null &&
    prodAfter !== null &&
    prodBefore.files === prodAfter.files &&
    prodBefore.bytes === prodAfter.bytes &&
    prodBefore.mtime === prodAfter.mtime,
  `${JSON.stringify(prodBefore)} → ${JSON.stringify(prodAfter)}`
)

// ===========================================================================
section('§8 量具健康 / 判定 / 证据')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型判据都自检过 `measured_count > 0`（测到 0 个对象的一律 MEASUREMENT INVALID，不报 PASS）',
  measurementInvalid.length === 0,
  `${measurements.length} 个量具，无效 ${measurementInvalid.length} 个${
    measurementInvalid.length > 0 ? `：${measurementInvalid.map((m) => m.label).join(' , ')}` : ''
  }`
)

const verdict = failed === 0 && measurementInvalid.length === 0 ? 'PASS' : 'FAIL'
const totalRows = await stateEventCount()
measure('沙箱 state_events 总行数', totalRows)

mkdirSync(ART, { recursive: true })

const evidence = {
  testId: 'M5.1.1 / WP9-B2 Production State Bootstrap Attestation (R-45 / 用户 B2-1 裁定)',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp9b2:verify',
  verdict,
  passed,
  failed,
  failures,
  frozenIdentity: {
    component: `${STATE_BOOTSTRAP_COMPONENT.kind}/${STATE_BOOTSTRAP_COMPONENT.id}`,
    authority: `${STATE_BOOTSTRAP_AUTHORITY.kind}/${STATE_BOOTSTRAP_AUTHORITY.ref}`,
    family: STATE_BOOTSTRAP_FAMILY,
    matrixRow: stateRowCells,
  },
  runtimeBoundary: {
    sandboxDir: sandbox.dir.replace(tmpdir(), '<tmp>'),
    schemaVersion,
    productionDbOpened: false,
    productionDbFingerprintBefore: prodBefore,
    productionDbFingerprintAfter: prodAfter,
    level1Entry: 'src/state/init.ts::initCharacterState（与 src/main.ts 同一函数、同一证据工厂）',
  },
  hardGateStatic: {
    scannerFiles: staticReport.files,
    findings: staticReport.findings,
    readings: staticReport.readings,
    injectedNegativeControl: { findings: injectedFindings, readings: injectedReadings, error: injectedSandboxError },
    restoredFindings: restoredAfterInjection.findings,
  },
  e4a: {
    stateEventId: String(e4a.stateEventId ?? ''),
    created: e4a.created,
    physicalSlots: e4aSlots,
    expectedSlots: E4A_EXPECTED,
    attributionOrigin: e4aRow?.attribution_origin ?? null,
    readback: {
      found: e4aReadback.found,
      attributionOrigin: e4aReadback.attribution?.attributionOrigin ?? null,
    },
    subjectDerivation: `${derivedEnvelope.subject.kind}/${derivedEnvelope.subject.id}`,
  },
  e4b: {
    stateEventId: String(e4b.stateEventId ?? ''),
    created: e4b.created,
    physicalSlots: e4bSlots,
    expectedSlots: E4B_EXPECTED,
    validatorViolations: e4bViolations.length,
    nonVacuityViolations: e4bAbsentViolations.length,
  },
  negativeControls: {
    deleteAttestation: { claimsBefore: e4aClaims, claimsHaveE4b: e4aClaims.some((c) => c.id === String(e4b.stateEventId)) },
    triggerInitOnly: {
      id: legacyInitId,
      nonNullAttributionColumns: legacyNonNullColumns,
      attribution: legacyReadback.attribution ?? null,
      claimsAfter: claimsAfterLegacy,
    },
    callerSelfReport: {
      forgedEvidenceVariants: forgeryOutcomes,
      rowsBefore: rowsBeforeForgeries,
      rowsAfter: rowsAfterForgeries,
      forgedEnvelope: { threw: forgedEnvelopeThrew, code: forgedEnvelopeCode },
      untrustedFields: untrustedFieldOutcomes,
      attackerOccurrencesInLedger: Number(attackerRows[0]?.c ?? 0),
    },
    reattach: { stateEventId: String(reattach.stateEventId ?? ''), claims: claimsAfterReattach },
  },
  frozenSurfaces: {
    migration0009Sha256: v9Fingerprint,
    migration0009FrozenExpected: FROZEN_MIGRATION_0009_SHA256,
    initialStates: initialSorted,
    manualResetRowNonNullAttributionColumns: manualNonNull,
    stateEventsTotalRows: totalRows,
  },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    srcChangedByThisGate: false,
    frozenDirsWritten: false,
    liveDbTouched: false,
    note: '本门只写 artifacts/m5.1.1/**；artifacts/m5.1/** 与 artifacts/m4.5/** 一字未动',
  },
  boundaryStatement: {
    closed:
      '`src/state/init.ts` 已接线：首启 `state_transition` 的权威槽位由状态引导组件自己的受信身份建立' +
      '（`SYSTEM/state-bootstrap` + `SYSTEM_RULE/state-bootstrap-rule`），E4-A 从"不可达"变为"已实测"。',
    notClaimed:
      'WP9-B2 **不**关闭 `WP9-GAP-1` 的其余形态、**不**宣布 `WP9 = PASS`（`WP9-C` 未做）、' +
      '**不**授权 `WP10`（production-copy migration）、**不**关闭 `M5.1-D01`。' +
      '本门只证明 `state_transition` 这一族的受信 SYSTEM 生产者存在且失败关闭。',
    supersedes:
      '`artifacts/m5.1.1/wp9b1-schema.json` 的 `boundaryStatement.deferredToB2` 曾写"今天生产里仍然没有' +
      '任何一条 state_events 带信封" —— 那是 **WP9-B1 当时的读数**，本 WP 之后不再成立（该历史证据按纪律' +
      '不重写；以本文件为当前读数）。',
  },
}
writeFileSync(join(ART, 'wp9b2-attestation.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

writeFileSync(
  join(ART, 'wp9b2-negatives.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP9-B2 negatives + three-stage detector discipline',
      generatedAt: new Date().toISOString(),
      command: 'pnpm m5.1.1:wp9b2:verify',
      verdict,
      e4aSlots,
      e4bSlots,
      negativeControls: evidence.negativeControls,
      threeStage: {
        detector: 'scripts/verify-m5.1.1-wp9b2-verify.ts::detectHardGateStatic',
        positive: { findings: staticReport.findings },
        injected: { findings: injectedFindings, error: injectedSandboxError },
        restored: { findings: restoredAfterInjection.findings },
      },
      runtimeDetectorThreeStage: {
        positive: e4aClaims,
        negative: e4bSlots,
        restored: claimsAfterReattach,
      },
      measurements,
      measurementInvalid: measurementInvalid.length,
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log('  ↳ 证据：artifacts/m5.1.1/wp9b2-attestation.json · wp9b2-negatives.json')
console.log(
  '     （`wp9b2-gate-exits.txt` 是**逐门串行再鉴定**读数，由执行代理在跑完全部门之后手写 —— ' +
    '理由与 WP9-B1 的 `wp9b1-gate-exits.txt` 相同：它记的是**本次执行跑过的每一道门**，不是本门自己的输出）'
)

await h.stop()
cleanupSandbox(sandbox.dir)

console.log(`\n${'='.repeat(78)}`)
console.log(
  `M5.1.1 WP9-B2（Production State Bootstrap Attestation）：${passed} 通过 / ${failed} 失败｜**WP9-B2 = ${verdict}**`
)
console.log('='.repeat(78))
if (failed > 0) console.log(`失败项：\n${failures.map((failure) => `    - ${failure}`).join('\n')}`)
process.exit(failed === 0 && measurements.every((m) => m.valid) ? 0 : 1)
