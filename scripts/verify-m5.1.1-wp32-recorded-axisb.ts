/**
 * M5.1.1 WP3.2 —— **K-24 / R-21：RECORDED 的 Axis B 可表示性门**
 * （`pnpm m5.1.1:wp3.2:verify`）
 *
 * ============================================================================
 *  它回答的问题
 * ============================================================================
 * `attribution_origin = RECORDED` **只**意味着"归因是在事件发生当时被记录下来的"，
 * **不**意味着"认知来源已经确立"。于是 RECORDED 行有两个合法分支：
 *
 *     confirmed   source_authority ≠ UNCONFIRMED_ORIGIN
 *                 ⇒ epistemic_source === epistemicSourceForKind(source_kind)
 *     unconfirmed source_authority = epistemic_source = UNCONFIRMED_ORIGIN（**成对**）
 *
 * 本门必须**同时**证明三件事：
 *   ① 两个分支在**库里物理可表示**（v7 的约束只查词表，没有 epistemic 等式 CHECK）；
 *   ② 契约把两个分支都判对（正控 + 两条混合形态必拒）；
 *   ③ **没有**把事件族分类实现成 `PrincipalKind → SourceKind`。
 *
 * ============================================================================
 *  为什么不需要 STOP（任务书 §8 的条件）
 * ============================================================================
 * §8 说"若需要改 schema 约束就 STOP（v7 已冻结，物理变更要 v8）"。
 * 实测：v7 对 Axis B 只有 **5 条**约束 —— 四条**词表**（含 `UNCONFIRMED_ORIGIN`）
 * 加一条 `axis_b_complete`（声明了 origin 就必须三列齐）；**没有**任何
 * "epistemic_source 必须等于 epistemicSourceForKind(source_kind)" 的 CHECK。
 * ⇒ unconfirmed 分支本来就写得进去 ⇒ **不需要 schema 变更**。
 *
 * 跑法：pnpm m5.1.1:wp3.2:verify
 */

import { createThinHostRuntime } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '../src/infrastructure/persistence/db.ts'
import 'dotenv/config'

import { readFileSync } from 'node:fs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'



import { sql } from 'drizzle-orm'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'
import { PRINCIPAL_KINDS } from '../src/kernel/contracts/actor.ts'
import {
  EPISTEMIC_SOURCES,
  SOURCE_AUTHORITIES,
  SOURCE_KIND_BY_EVENT_FAMILY,
  SOURCE_KINDS,
  UNCONFIRMED_AXIS_B_VALUE,
  assertRecordedAxisB,
  classifyRecordedAxisB,
  defaultAuthorityForKind,
  epistemicSourceForKind,
  sourceKindForEventFamily,
  type EpistemicSource,
  type SourceAuthority,
  type SourceKind,
} from '../src/kernel/contracts/source-authority.ts'
import { currentSchemaVersion, getRawDb, rowsOf } from '../src/infrastructure/persistence/db.ts'
import { latestSchemaVersion } from '../src/infrastructure/persistence/migrations.ts'

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

const ROOT = process.cwd()
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.1.1')

console.log('='.repeat(74))
console.log('M5.1.1 WP3.2 —— K-24 / R-21 RECORDED Axis-B Representability')
console.log('='.repeat(74))

// ===========================================================================
section('0. 静态：两个分支在库里**物理可表示**（不需要 schema 变更 ⇒ 不 STOP）')
// ===========================================================================

const sourceAuthority = readFileSync(join(ROOT, 'src', 'kernel', 'contracts', 'source-authority.ts'), 'utf8')
const codeOnly = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1')
check(
  'R-21 §2：契约里**没有** `sourceKindForPrincipalKind` 这类 PrincipalKind→SourceKind 的函数',
  !/sourceKindForPrincipalKind/.test(codeOnly(sourceAuthority)),
  'AA'
)
check(
  'R-21 §2：事件族分类表存在，且键是**事件族**（不是 PrincipalKind）',
  Object.keys(SOURCE_KIND_BY_EVENT_FAMILY).every((key) =>
    ['user_message', 'assistant_message', 'system_event', 'tool_event'].includes(key)
  ),
  Object.keys(SOURCE_KIND_BY_EVENT_FAMILY).join(',')
)
check(
  'R-21 §4：两个受控词汇表都接受 `UNCONFIRMED_ORIGIN`（否则 unconfirmed 分支写不进去）',
  (SOURCE_AUTHORITIES as readonly string[]).includes(UNCONFIRMED_AXIS_B_VALUE) &&
    (EPISTEMIC_SOURCES as readonly string[]).includes(UNCONFIRMED_AXIS_B_VALUE),
  'AA'
)

const sandbox = isolateDatabase('m5.1.1-wp32')
check('沙箱不是真实库', isProductionDir(sandbox.dir) === false && sandbox.dir.startsWith(tmpdir()), sandbox.dir)
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
await runtime.registerPlugin(undefined as never)
await await __applyKernelMigrations(__getRawDb(runtime))
const db = getRawDb(runtime)
await initDatabase(runtime)
const schemaVersion = await currentSchemaVersion(db)
check(
  /*
   * ⚠️ **2026-10-03 修订（后 Lv2 · S1 / ADR-091 D04）**：本断言原来写死 `=== 9`。
   * 与 `verify-m5.1.1-migration.ts` 里那条"最新 schema"断言**同一原理**：
   * 迁移只许**往后追加**（`assertMigrationsWellFormed()` 保证 1..N 连续），
   * 所以"刷新到最新"才是正确的判据；写死一个历史版本会在**每一次**新增迁移时假红
   * （0010 踩过一次，0011 又踩了一次 —— 这次改成推导）。
   *
   * **判据没有被放宽**：它仍要求"沙箱库 = **代码里的最新版本**"，
   * 而"0001–0009 的历史 DDL 一字未动"由 `m5.1.1:migration:verify` 的冻结指纹表
   * **逐条**锁着（那条才是"改已发布迁移会红"的守卫）。
   * 本门真正关心的 v9 半径由下面的列/约束断言各自覆盖。
   */
  `沙箱库 schema = 代码最新（v${String(latestSchemaVersion())}；v8 只碰行动表、v9 只碰 state_events）`,
  schemaVersion === latestSchemaVersion(),
  `v${schemaVersion}`
)

const constraintRows = rowsOf(
  await db.execute(
    sql`select conname from pg_constraint where conrelid = 'conversation_events'::regclass and contype = 'c'`
  )
) as { conname: string }[]
const constraintNames = constraintRows.map((row) => row.conname)
const axisBConstraints = constraintNames.filter(
  (name) => /source_kind_vocab|source_authority_vocab|epistemic_source_vocab|attribution_origin_vocab|axis_b_complete/.test(name)
)
measure('v7 的 conversation_events CHECK 约束数', constraintNames.length)
measure('v7 的 Axis B 约束数', axisBConstraints.length)
check('v7 的 Axis B 约束 = 恰好 5 条（4 词表 + axis_b_complete）', axisBConstraints.length === 5, axisBConstraints.join(','))
check(
  '★ **没有**"epistemic_source 必须等于 epistemicSourceForKind(source_kind)"的 CHECK ⇒ unconfirmed 分支可表示 ⇒ 不需要 v8',
  !constraintNames.some((name) => /epistemic.*(equal|match|consisten)|source_kind_epistemic/.test(name)),
  `约束清单：${constraintNames.filter((name) => name.includes('epistemic')).join(',') || '（只有词表）'}`
)

// ===========================================================================
section('1. 契约语义：两个分支 + 两条混合形态必拒（纯函数）')
// ===========================================================================

const branchCases: {
  label: string
  input: { sourceKind: SourceKind; sourceAuthority: SourceAuthority; epistemicSource: EpistemicSource }
  expected: 'confirmed' | 'unconfirmed' | 'reject'
}[] = [
  {
    label: 'confirmed：user_statement + USER_EXPLICIT + user_report',
    input: { sourceKind: 'user_statement', sourceAuthority: 'USER_EXPLICIT', epistemicSource: 'user_report' },
    expected: 'confirmed',
  },
  {
    label: 'unconfirmed：user_statement + UNCONFIRMED_ORIGIN + UNCONFIRMED_ORIGIN',
    input: {
      sourceKind: 'user_statement',
      sourceAuthority: UNCONFIRMED_AXIS_B_VALUE,
      epistemicSource: UNCONFIRMED_AXIS_B_VALUE,
    },
    expected: 'unconfirmed',
  },
  {
    label: '**拒**：UNCONFIRMED authority + 非 UNCONFIRMED epistemic',
    input: { sourceKind: 'user_statement', sourceAuthority: UNCONFIRMED_AXIS_B_VALUE, epistemicSource: 'user_report' },
    expected: 'reject',
  },
  {
    label: '**拒**：已确立 authority + UNCONFIRMED epistemic',
    input: { sourceKind: 'user_statement', sourceAuthority: 'USER_EXPLICIT', epistemicSource: UNCONFIRMED_AXIS_B_VALUE },
    expected: 'reject',
  },
  {
    label: '**拒**：confirmed 分支但 epistemic 与该 kind 不匹配',
    input: { sourceKind: 'user_statement', sourceAuthority: 'USER_EXPLICIT', epistemicSource: 'tool_observation' },
    expected: 'reject',
  },
]
measure('§1 纯函数用例数', branchCases.length)
const branchReadings: { label: string; observed: string; match: boolean }[] = []
for (const probe of branchCases) {
  const verdict = classifyRecordedAxisB(probe.input)
  const observed = verdict.ok ? verdict.branch : 'reject'
  const match = observed === probe.expected
  branchReadings.push({ label: probe.label, observed, match })
  check(`§1 ${probe.label} ⇒ ${probe.expected}`, match, observed)
}
check(
  '§1 失败关闭版本在非法输入上**真的抛**',
  (() => {
    try {
      assertRecordedAxisB({ sourceKind: 'user_statement', sourceAuthority: 'USER_EXPLICIT', epistemicSource: UNCONFIRMED_AXIS_B_VALUE })
      return false
    } catch {
      return true
    }
  })(),
  'AA'
)

// ===========================================================================
section('2. 事件族分类（**不是** PrincipalKind → SourceKind）')
// ===========================================================================

const familyExpectation: [keyof typeof SOURCE_KIND_BY_EVENT_FAMILY, SourceKind][] = [
  ['user_message', 'user_statement'],
  ['assistant_message', 'character_output'],
  ['system_event', 'system_instruction'],
  ['tool_event', 'tool_output'],
]
measure('§2 事件族数', familyExpectation.length)
for (const [family, expected] of familyExpectation) {
  check(`§2 ${family} → ${expected}（由**族**决定）`, sourceKindForEventFamily(family) === expected, sourceKindForEventFamily(family))
}

// 三条"不得自动推导"的负控：函数**不接受** principal，且不随 principal 变化
const negativeDerivations = [
  {
    label: 'SERVICE principal 不得自动意味着 system_instruction',
    holds: sourceKindForEventFamily('user_message') !== 'system_instruction' &&
      sourceKindForEventFamily('system_event') === 'system_instruction',
  },
  {
    label: 'EXTERNAL_ACTOR 不得推出任何 SourceKind（族函数不看 principal）',
    holds: (PRINCIPAL_KINDS as readonly string[]).includes('EXTERNAL_ACTOR') &&
      !/EXTERNAL_ACTOR[\s\S]{0,40}(system_instruction|user_statement|character_output|tool_output)/.test(codeOnly(sourceAuthority)),
  },
  {
    label: 'actor_type=user 不得自动意味着 USER_EXPLICIT（unconfirmed 分支对 user_message 合法）',
    holds: classifyRecordedAxisB({
      sourceKind: 'user_statement',
      sourceAuthority: UNCONFIRMED_AXIS_B_VALUE,
      epistemicSource: UNCONFIRMED_AXIS_B_VALUE,
    }).ok,
  },
]
measure('§2 "不得自动推导"的负控数', negativeDerivations.length)
for (const negative of negativeDerivations) check(`§2 ${negative.label}`, negative.holds, 'AA')

// ===========================================================================
section('3. 库级：RECORDED 的合法用例必须**可插入并通过**（两个分支）')
// ===========================================================================

let probeSequence = 900
async function insertRecordedRow(input: {
  id: string
  type: string
  actorType: string
  actorId: string
  sourceKind: SourceKind
  sourceAuthority: SourceAuthority
  epistemicSource: EpistemicSource
  originator?: { kind: string; id: string } | null
  originatorUnknownReason?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  probeSequence += 1
  const originator = input.originator ?? null
  try {
    await db.execute(
      sql`insert into conversation_events
            (id, character_id, conversation_id, sequence, conversation_sequence, type, actor_type,
             actor_id, content, schema_version, created_at,
             attribution_origin, source_kind, source_authority, epistemic_source,
             content_originator_kind, content_originator_id, content_originator_unknown_reason)
          values (${input.id}, 'char_test', 'conv_test', ${probeSequence}, ${probeSequence}, ${input.type},
                  ${input.actorType}, ${input.actorId}, 'probe', 1, ${Date.now()},
                  'RECORDED', ${input.sourceKind}, ${input.sourceAuthority}, ${input.epistemicSource},
                  ${originator === null ? null : originator.kind},
                  ${originator === null ? null : originator.id},
                  ${originator === null ? (input.originatorUnknownReason ?? null) : null})`
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message.slice(0, 160) }
  }
}

const legalCases: {
  label: string
  family: keyof typeof SOURCE_KIND_BY_EVENT_FAMILY
  type: string
  actorType: string
  actorId: string
  branch: 'confirmed' | 'unconfirmed'
  originator: { kind: string; id: string } | null
  originatorUnknownReason?: string | null
}[] = [
  {
    label: 'A. user_message + contentOriginator=Known(USER/u) + Axis B **confirmed**',
    family: 'user_message',
    type: 'user_message',
    actorType: 'user',
    actorId: 'u-1',
    branch: 'confirmed',
    originator: { kind: 'USER', id: 'u-1' },
  },
  {
    label: 'B. user_message + contentOriginator=Known(SERVICE/agent) + Axis B **unconfirmed**',
    family: 'user_message',
    type: 'user_message',
    actorType: 'user',
    actorId: 'u-1',
    branch: 'unconfirmed',
    originator: { kind: 'SERVICE', id: 'agent-runner' },
  },
  {
    label: 'C. user_message + contentOriginator=Known(EXTERNAL_ACTOR/x) + Axis B **unconfirmed**',
    family: 'user_message',
    type: 'user_message',
    actorType: 'user',
    actorId: 'u-1',
    branch: 'unconfirmed',
    originator: { kind: 'EXTERNAL_ACTOR', id: 'x' },
  },
  {
    label: 'D. user_message + contentOriginator=Unknown(RUNTIME_UNRESOLVED) + Axis B **unconfirmed**',
    family: 'user_message',
    type: 'user_message',
    actorType: 'user',
    actorId: 'u-1',
    branch: 'unconfirmed',
    originator: null,
    originatorUnknownReason: 'RUNTIME_UNRESOLVED',
  },
  {
    label: 'E1. assistant_message（confirmed）',
    family: 'assistant_message',
    type: 'assistant_message',
    actorType: 'character',
    actorId: 'char_sumuwei',
    branch: 'confirmed',
    originator: { kind: 'CHARACTER', id: 'char_sumuwei' },
  },
  {
    label: 'E2. assistant_message（unconfirmed）',
    family: 'assistant_message',
    type: 'assistant_message',
    actorType: 'character',
    actorId: 'char_sumuwei',
    branch: 'unconfirmed',
    originator: { kind: 'SERVICE', id: 'agent-writer' },
  },
  {
    label: 'E3. system_event（confirmed）',
    family: 'system_event',
    type: 'system_event',
    actorType: 'system',
    actorId: 'event-ledger',
    branch: 'confirmed',
    originator: { kind: 'SYSTEM', id: 'event-ledger' },
  },
  {
    label: 'E4. tool_event（unconfirmed）',
    family: 'tool_event',
    type: 'tool_event',
    actorType: 'tool',
    actorId: 'weather',
    branch: 'unconfirmed',
    originator: { kind: 'TOOL', id: 'weather' },
  },
]
measure('§3 库级合法用例数', legalCases.length)

const legalReadings: { label: string; branch: string; expected: string; inserted: boolean; classified: boolean }[] = []
for (const legal of legalCases) {
  const sourceKind = sourceKindForEventFamily(legal.family)
  const sourceAuthorityValue: SourceAuthority =
    legal.branch === 'confirmed' ? defaultAuthorityForKind(sourceKind) : UNCONFIRMED_AXIS_B_VALUE
  const epistemicSourceValue: EpistemicSource =
    legal.branch === 'confirmed' ? epistemicSourceForKind(sourceKind) : UNCONFIRMED_AXIS_B_VALUE
  const inserted = await insertRecordedRow({
    id: `wp32-${legal.label.slice(0, 2)}`,
    type: legal.type,
    actorType: legal.actorType,
    actorId: legal.actorId,
    sourceKind,
    sourceAuthority: sourceAuthorityValue,
    epistemicSource: epistemicSourceValue,
    originator: legal.originator,
    originatorUnknownReason: legal.originatorUnknownReason ?? null,
  })
  const verdict = classifyRecordedAxisB({
    sourceKind,
    sourceAuthority: sourceAuthorityValue,
    epistemicSource: epistemicSourceValue,
  })
  const branch = verdict.ok ? verdict.branch : 'reject'
  legalReadings.push({ label: legal.label, branch, expected: legal.branch, inserted: inserted.ok, classified: branch === legal.branch })
  check(
    `§3 ${legal.label}`,
    inserted.ok && branch === legal.branch,
    inserted.ok ? `branch=${branch}` : `插入被拒：${inserted.error ?? ''}`
  )
}

// ===========================================================================
section('4. 负控：库**接受**但检测器**必响**（证明它相对库不是橡皮图章）')
// ===========================================================================

const negativeCases = [
  {
    label: 'UNCONFIRMED authority + 非 UNCONFIRMED epistemic（库只查词表，会接受）',
    input: { sourceKind: 'user_statement' as SourceKind, sourceAuthority: UNCONFIRMED_AXIS_B_VALUE as SourceAuthority, epistemicSource: 'user_report' as EpistemicSource },
  },
  {
    label: '已确立 authority + UNCONFIRMED epistemic',
    input: { sourceKind: 'user_statement' as SourceKind, sourceAuthority: 'USER_EXPLICIT' as SourceAuthority, epistemicSource: UNCONFIRMED_AXIS_B_VALUE as EpistemicSource },
  },
  {
    label: 'confirmed 分支但 epistemic 与该 kind 不匹配（character_output + user_report）',
    input: { sourceKind: 'character_output' as SourceKind, sourceAuthority: 'CHARACTER_GENERATION' as SourceAuthority, epistemicSource: 'user_report' as EpistemicSource },
  },
]
measure('§4 负控数', negativeCases.length)
const negativeReadings: { label: string; dbAccepted: boolean; detectorFired: boolean }[] = []
for (const [index, negative] of negativeCases.entries()) {
  const inserted = await insertRecordedRow({
    id: `wp32-neg-${index}`,
    type: 'user_message',
    actorType: 'user',
    actorId: 'u-1',
    sourceKind: negative.input.sourceKind,
    sourceAuthority: negative.input.sourceAuthority,
    epistemicSource: negative.input.epistemicSource,
    originator: null,
    originatorUnknownReason: 'RUNTIME_UNRESOLVED',
  })
  const detectorFired = !classifyRecordedAxisB(negative.input).ok
  negativeReadings.push({ label: negative.label, dbAccepted: inserted.ok, detectorFired })
  check(
    `§4 ${negative.label} ⇒ 检测器**必响**`,
    detectorFired,
    inserted.ok ? '库接受、检测器响了（正确）' : `库也拒绝了：${inserted.error ?? ''}`
  )
}

// 用完即删：这 3 行是**故意造出来的非法探针**，不能让它们污染 §5 的 M7 扫描。
// （第一版没删，于是 M7 报出 3 条"违规"——那 3 条正是我自己造的负控。）
const deletedNegatives = rowsOf(
  await db.execute(sql`delete from conversation_events where id like 'wp32-neg-%' returning id`)
) as { id: string }[]
measure('§4 负控探针行已清理数', deletedNegatives.length)
console.log(`  · 已清理 ${deletedNegatives.length} 行故意非法的探针（M7 扫描因此**无豁免**）`)

// ===========================================================================
section('5. M7 / RECORDED 门：**两个分支都要有非零测量**')
// ===========================================================================

const recordedRows = rowsOf(
  await db.execute(
    sql`select type, source_kind, source_authority, epistemic_source
        from conversation_events where attribution_origin = 'RECORDED'`
  )
) as { type: string; source_kind: string; source_authority: string; epistemic_source: string }[]
measure('M7 RECORDED 行数', recordedRows.length)
let confirmedCount = 0
let unconfirmedCount = 0
const m7Bad: string[] = []
for (const row of recordedRows) {
  const verdict = classifyRecordedAxisB({
    sourceKind: row.source_kind as SourceKind,
    sourceAuthority: row.source_authority as SourceAuthority,
    epistemicSource: row.epistemic_source as EpistemicSource,
  })
  if (!verdict.ok) m7Bad.push(`${row.type}:${verdict.code}`)
  else if (verdict.branch === 'confirmed') confirmedCount += 1
  else unconfirmedCount += 1
}
measure('M7 RECORDED **confirmed** 分支行数', confirmedCount)
measure('M7 RECORDED **unconfirmed** 分支行数', unconfirmedCount)
check('M7 RECORDED 行全部落在两个合法分支之一（0 违规）', m7Bad.length === 0, m7Bad.slice(0, 3).join(',') || 'AA')
check('★ M7 RECORDED confirmed 分支 = PASS（有非零测量）', confirmedCount > 0, String(confirmedCount))
check('★ M7 RECORDED unconfirmed 分支 = PASS（有非零测量）', unconfirmedCount > 0, String(unconfirmedCount))

// ===========================================================================
section('汇总与证据')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型检测器都有非零测量（否则 MEASUREMENT INVALID）',
  measurementInvalid.length === 0,
  `${measurements.length} 个检测器，无效 ${measurementInvalid.length}`
)

const confirmedGate = confirmedCount > 0 && m7Bad.length === 0
const unconfirmedGate = unconfirmedCount > 0 && m7Bad.length === 0
const verdict = failed === 0 ? 'PASS' : 'FAIL'

const evidence = {
  testId: 'M5.1.1 / WP3.2 K-24 RECORDED Axis-B representability',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp3.2:verify',
  verdict,
  passed,
  failed,
  failures,
  semantics: {
    recordedMeaning: 'attribution was recorded at event time（**不**意味着 epistemic source 已确立）',
    branches: {
      confirmed: 'source_authority ≠ UNCONFIRMED_ORIGIN ⇒ epistemic_source === epistemicSourceForKind(source_kind)',
      unconfirmed: 'source_authority = epistemic_source = UNCONFIRMED_ORIGIN（成对；无外部事实资格）',
    },
    eventFamilyClassification: SOURCE_KIND_BY_EVENT_FAMILY,
    mustNotImplementAs: 'PrincipalKind → SourceKind',
  },
  schemaFeasibility: {
    axisBConstraints,
    axisBConstraintCount: axisBConstraints.length,
    hasEpistemicEqualityCheck: false,
    requiresSchemaChange: false,
    stopCondition: '任务书 §8：若需要改 schema 约束则 STOP；实测**不需要**（v7 只查词表）',
  },
  branchReadings,
  legalCases: legalReadings,
  negativeControls: negativeReadings,
  gates: {
    recordedConfirmed: confirmedGate,
    recordedUnconfirmed: unconfirmedGate,
    m7Violations: m7Bad,
    confirmedCount,
    unconfirmedCount,
  },
  sandbox: { dir: sandbox.dir, isProductionDir: isProductionDir(sandbox.dir), schemaVersion },
  measurements,
  measurementInvalid: measurementInvalid.length,
  scope: {
    productionCopyOnly: false,
    liveDbMutated: false,
    migration0007Edited: false,
    factFirewallChanged: false,
    memoryAuthorityChanged: false,
    extractorChanged: false,
    recallChanged: false,
    phase4: false,
    adr043: 'NOT APPROVED — untouched',
    startedWp4: false,
  },
}

mkdirSync(EVIDENCE_DIR, { recursive: true })
writeFileSync(join(EVIDENCE_DIR, 'wp3.2-recorded-axisb.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\n${'='.repeat(74)}`)
console.log(`WP3.2 K-24 RECORDED Axis-B 门：${passed} 通过 / ${failed} 失败｜verdict = ${verdict}`)
console.log(
  `RECORDED confirmed = ${confirmedGate ? 'PASS' : 'FAIL'}（${confirmedCount} 行）｜` +
    `RECORDED unconfirmed = ${unconfirmedGate ? 'PASS' : 'FAIL'}（${unconfirmedCount} 行）`
)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp3.2-recorded-axisb.json')

try {
  await runtime.stop()
} catch {
  /* 关不干净不影响结论 */
}

process.exit(failed === 0 ? 0 : 1)
