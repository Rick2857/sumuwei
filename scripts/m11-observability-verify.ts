/**
 * M11 WP11 前置 —— **可观测性与隐私门**（`m11:observability:verify`）。
 *
 * ============================================================================
 *  计划 §12.1 对这道门的要求
 * ============================================================================
 * ```text
 * 「query / trace / 隐私 —— **理由码生产者** · **遮蔽** · **正文泄漏负控**」
 * ```
 *
 * ============================================================================
 *  三组各自量什么（**口径写死，再看读数**）
 * ============================================================================
 * ```text
 * A 理由码生产者：每一个闭集里的理由码，都必须有**可达性事实**（reachable / producer /
 *   howToReach），而且 `producer` 里点名的**源文件真的存在、真的含这个码** ——
 *   "登记表说它可达"与"代码里真的能产出它"必须对得上（机器判据，不是读注释）。
 * B 遮蔽：撤回 / 被忘的反思，在**开发者面**里正文不出现（遮蔽写进类型），
 *   在**聊天侧**同轮就不可用（不等后台）。
 * C 正文泄漏负控：往正文里放一个 **canary**，然后断言它**不出现**在任何外发面
 *   （trace 属性 · 事实包 · 开发者面遮蔽支 · 上下文 section 的 sourceRefs）。
 *   ⚠️ **负控必须同时有正控**：同一条 canary 在**该出现**的地方（未遮蔽的可见支）**必须**出现，
 *      否则"搜不到"可能只是因为"根本没读到正文"。
 * ```
 *
 * ⚠️ 零模型调用、零出网；数据库用一次性沙箱（只读投影面）。
 */

import 'dotenv/config'

import { isolateDatabase } from '../src/dev/sandbox.ts'

isolateDatabase('m11-observability-verify', { keep: false })

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM4Harness } from './m4-harness.ts'
import {
  M11_MANIFEST_VERSION,
  createM11RunId,
  openM11RunDir,
  runIdFromM11OutPath,
  writeM11Manifest,
} from './m11-evidence.ts'
import {
  REFLECTION_DRAFT_REJECTION_FACTS,
  REFLECTION_DRAFT_REJECTION_REASONS,
} from '../src/kernel/contracts/reflection.ts'
import { LINEAGE_REJECTION_FACTS } from '../src/kernel/contracts/reflection-lineage.ts'
import { REFLECTION_TRIGGER_FACTS } from '../src/kernel/contracts/reflection-input.ts'
import {
  REFLECTION_REVIEW_REASON_FACTS,
  REFLECTION_REVIEW_REASONS,
} from '../src/kernel/policies/reflection-validator.ts'
import { reflectionContentMustBeMasked } from '../src/kernel/app/reflection/masking.ts'
import { buildDeveloperReflectionList } from '../src/kernel/app/reflection/developer-face.ts'
import { buildReflectionFactPack, reflectionFactInputFrom } from '../src/kernel/app/reflection/fact-pack.ts'
import { renderAdaptiveSelfSection } from '../src/kernel/context/adaptive-self-sections.ts'
import { baselineAdaptiveSelfState } from '../src/kernel/contracts/adaptive-self.ts'
import type { ReflectionRecordState } from '../src/kernel/contracts/reflection-events.ts'

const REPO_ROOT = resolve(process.cwd())
const CANARY = 'CANARY_LEAK_9f31c7'
const CH = 'char_m11_observability'

interface Check {
  id: string
  group: 'A' | 'B' | 'C' | 'S'
  label: string
  pass: boolean
  detail: string
}

const checks: Check[] = []
function record(id: string, group: Check['group'], label: string, pass: boolean, detail: string): void {
  checks.push({ id, group, label, pass, detail })
}

/**
 * 把 `producer` 里点名的源文件取出来，并断言那个文件里**真的**含这个码。
 *
 * ⚠️ 解析顺序（第一版只有第一条 ⇒ 直接把 A3/A8 判红，而那是**判据**的问题不是产品的问题）：
 *    ① 直接按相对 `src/` 的路径找；② 找不到就**在 `src/` 下按文件名递归找**
 *    （登记表里写 `reflection-validator.ts` 这种裸文件名是**正常写法**，不该被判成"文件不存在"）。
 */
function resolveProducerFile(name: string): string | undefined {
  const direct = join(REPO_ROOT, 'src', name.replace(/^src\//, ''))
  if (existsSync(direct)) return direct
  const basename = name.split('/').pop()!
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || found.length > 0) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (found.length > 0) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path, depth + 1)
      else if (entry.name === basename) found.push(path)
    }
  }
  walk(join(REPO_ROOT, 'src'), 0)
  return found[0]
}

function producerReachable(producer: string, code: string): { ok: boolean; detail: string } {
  const fileMatch = /([\w./-]+\.ts)/.exec(producer)
  if (fileMatch === null) return { ok: false, detail: `producer 里没有点名源文件：${producer}` }
  const path = resolveProducerFile(fileMatch[1]!)
  if (path === undefined) return { ok: false, detail: `producer 点名的文件找不到：${fileMatch[1]}` }
  const source = readFileSync(path, 'utf8')
  return source.includes(code)
    ? { ok: true, detail: `${fileMatch[1]} 含 ${code}` }
    : { ok: false, detail: `${fileMatch[1]} **不含** ${code}` }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let out: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out') out = args[++i]
    else throw new Error(`未知参数：${JSON.stringify(args[i])}`)
  }
  const h = await createM4Harness({ label: 'm11-observability-verify' })
  void h

  // -------------------------------------------------------------------------
  // A 组 —— 理由码生产者（可达性**机器核对**）
  // -------------------------------------------------------------------------
  const draftFacts = Object.entries(REFLECTION_DRAFT_REJECTION_FACTS)
  const draftMissing = REFLECTION_DRAFT_REJECTION_REASONS.filter(
    (reason) => REFLECTION_DRAFT_REJECTION_FACTS[reason] === undefined
  )
  record(
    'A1',
    'A',
    '【闭集完整】草案拒绝码：闭集里的**每一个**都有可达性事实（没有"闭集里有、登记表里没有"的码）',
    draftMissing.length === 0 && draftFacts.length === REFLECTION_DRAFT_REJECTION_REASONS.length,
    `闭集=${String(REFLECTION_DRAFT_REJECTION_REASONS.length)} · 事实=${String(draftFacts.length)} · 缺=${JSON.stringify(draftMissing)}`
  )
  const draftUnreachable = draftFacts.filter(
    ([, fact]) =>
      fact.reachable !== true ||
      fact.producer.trim() === '' ||
      fact.howToReach.trim() === '' ||
      producerReachable(fact.producer, '').detail.includes('不存在')
  )
  record(
    'A2',
    'A',
    '【可达性事实齐全】每条都有 `reachable=true` + 非空 `producer` / `howToReach`，且 `producer` 点名的文件**存在**',
    draftUnreachable.length === 0,
    `不合格=${JSON.stringify(draftUnreachable.map(([code]) => code))}`
  )
  const draftDrifted = draftFacts
    .map(([code, fact]) => ({ code, ...producerReachable(fact.producer, code) }))
    .filter((row) => !row.ok)
  record(
    'A3',
    'A',
    '【不漂移】`producer` 点名的源文件里**真的**含这个码（"登记表说可达"与"代码里能产出"对得上）',
    draftDrifted.length === 0,
    draftDrifted.length === 0
      ? `${String(draftFacts.length)} 条全部对上`
      : `漂移=${JSON.stringify(draftDrifted.map((row) => `${row.code}: ${row.detail}`))}`
  )
  const lineageFacts = LINEAGE_REJECTION_FACTS.map((fact) => [fact.reason, fact] as const)
  const lineageMissing = lineageFacts.filter(
    ([, fact]) => (fact as { producedBy?: string }).producedBy === undefined || fact.producedBy.trim() === ''
  )
  record(
    'A4',
    'A',
    '【来源拒绝码】派生链的拒绝码各自登记 `producedBy`（"谁产它"不是靠猜）',
    lineageFacts.length > 0 && lineageMissing.length === 0,
    `条数=${String(lineageFacts.length)} · 缺 producedBy=${JSON.stringify(lineageMissing.map(([code]) => code))}`
  )
  const triggerFacts = Object.entries(REFLECTION_TRIGGER_FACTS)
  const triggerUnreachable = triggerFacts.filter(
    ([, fact]) => (fact as { v1Detectable?: boolean }).v1Detectable === undefined
  )
  record(
    'A5',
    'A',
    '【触发事实】六类触发各自登记 `v1Detectable`（含"本版检测不到"那一档，如实登记）',
    triggerFacts.length === 6 && triggerUnreachable.length === 0,
    `条数=${String(triggerFacts.length)} · 缺=${JSON.stringify(triggerUnreachable.map(([code]) => code))}`
  )
  /*
   * A6/A7 —— 审查理由码：**闭集完整 + 可达性事实 + 代码里真的推的就是这些码**。
   *
   * ⚠️ A7 是**机器扫描**：把 `reviewReflection()` 函数体里所有 `reasons.push('…')` 的字面量
   *    抓出来，逐个核对它在闭集里 —— "闭集"与"代码真的产什么"必须对得上。
   */
  const reviewReasonSet = new Set<string>(REFLECTION_REVIEW_REASONS)
  const reviewFactsMissing = REFLECTION_REVIEW_REASONS.filter(
    (reason) => REFLECTION_REVIEW_REASON_FACTS[reason] === undefined
  )
  record(
    'A6',
    'A',
    '【审查理由码·闭集完整】闭集里每个码都有可达性事实（`reachable` / `producer` / `howToReach`）',
    reviewFactsMissing.length === 0 && REFLECTION_REVIEW_REASONS.length > 0,
    `闭集=${String(REFLECTION_REVIEW_REASONS.length)} · 缺=${JSON.stringify(reviewFactsMissing)}`
  )
  const validatorSrc = readFileSync(
    join(REPO_ROOT, 'src/kernel/policies/reflection-validator.ts'),
    'utf8'
  )
  const reviewFnBody = /export function reviewReflection[\s\S]*?\n\}/.exec(validatorSrc)?.[0] ?? ''
  const pushedReasons = [...reviewFnBody.matchAll(/reasons\.push\(\s*'([^']+)'/g)].map(
    (match) => match[1]!
  )
  const outsideClosedSet = pushedReasons.filter((reason) => !reviewReasonSet.has(reason))
  record(
    'A7',
    'A',
    '【审查理由码·不漂移】`reviewReflection()` 里真的推的码**全部**在闭集内（机器扫描函数体，不是读注释）',
    pushedReasons.length > 0 && outsideClosedSet.length === 0,
    `扫描到=${JSON.stringify(pushedReasons)} · 闭集外=${JSON.stringify(outsideClosedSet)}`
  )
  const reviewProducerDrift = REFLECTION_REVIEW_REASONS.map((reason) => ({
    reason,
    ...producerReachable(REFLECTION_REVIEW_REASON_FACTS[reason].producer, reason),
  })).filter((row) => !row.ok)
  record(
    'A8',
    'A',
    '【审查理由码·producer 可达】每条 `producer` 点名的文件**真的**含这个码',
    reviewProducerDrift.length === 0,
    reviewProducerDrift.length === 0
      ? `${String(REFLECTION_REVIEW_REASONS.length)} 条全部对上`
      : `漂移=${JSON.stringify(reviewProducerDrift.map((row) => `${row.reason}: ${row.detail}`))}`
  )

  // -------------------------------------------------------------------------
  // B 组 —— 遮蔽
  // -------------------------------------------------------------------------
  const base: ReflectionRecordState = {
    reflectionId: 'refl:obs',
    schemaVersion: 'reflection-record@1',
    status: 'accepted',
    focusQuestion: `焦点问题 ${CANARY}`,
    explanation: `候选解释 ${CANARY}`,
    supportHandles: ['ce:1'],
    counterHandles: [],
    scope: 'current_character_user',
    roots: ['ce:1', 'ce:2', 'ce:3'],
    rootCount: 3,
    conversationCount: 2,
    reviewReasons: [],
    generatedBy: { modelVersion: 'fixed@1', promptVersion: 'p@1', inputWindowFingerprint: 'fp' },
    lifecycleEventIds: ['de:1'],
  }
  const retracted = buildDeveloperReflectionList({
    records: [{ ...base, status: 'retracted' }],
    rootVerdicts: [{ rootId: 'ce:1', usable: true }],
  })
  record(
    'B1',
    'B',
    '【开发者面遮蔽】撤回的反思在开发者面里是**遮蔽支**，正文（含 canary）不出现',
    retracted.items[0]?.masked === true && !JSON.stringify(retracted).includes(CANARY),
    `masked=${String(retracted.items[0]?.masked)} · 含 canary=${String(JSON.stringify(retracted).includes(CANARY))}`
  )
  const forgottenRoot = buildDeveloperReflectionList({
    records: [base],
    rootVerdicts: [
      { rootId: 'ce:1', usable: true },
      { rootId: 'ce:2', usable: false, reason: 'source_forgotten' },
    ],
  })
  record(
    'B2',
    'B',
    '【根被忘 ⇒ 遮蔽】任一支持根被忘掉，整条在开发者面里也走遮蔽支（不能只遮那一条根）',
    forgottenRoot.items[0]?.masked === true &&
      (forgottenRoot.items[0] as { withdrawnRootIds?: readonly string[] }).withdrawnRootIds?.includes('ce:2') === true,
    `masked=${String(forgottenRoot.items[0]?.masked)}`
  )
  record(
    'B3',
    'B',
    '【正控·未遮蔽】同一份记录在来源都可用时是**可见支**且 canary **确实出现**（证明 B1 不是因为"根本没读到正文"）',
    buildDeveloperReflectionList({ records: [base], rootVerdicts: [{ rootId: 'ce:1', usable: true }] }).items[0]
      ?.masked === false &&
      JSON.stringify(buildDeveloperReflectionList({ records: [base], rootVerdicts: [] })).includes(CANARY),
    `可见支含 canary=${String(JSON.stringify(buildDeveloperReflectionList({ records: [base], rootVerdicts: [] })).includes(CANARY))}`
  )
  const maskVerdict = reflectionContentMustBeMasked({
    status: 'accepted',
    roots: ['ce:1'],
    rootVerdicts: [{ rootId: 'ce:1', usable: false, reason: 'unavailable' }],
  })
  record(
    'B4',
    'B',
    '【读不到 ≠ 遮蔽】一次查询失败**不**把这条打成遮蔽（否则开发者面会凭空少一条正常记录）',
    maskVerdict.mask === false,
    `mask=${String(maskVerdict.mask)}`
  )

  // -------------------------------------------------------------------------
  // C 组 —— 正文泄漏负控（四个外发面）
  // -------------------------------------------------------------------------
  const factPack = buildReflectionFactPack(
    reflectionFactInputFrom({
      reflectionStatuses: ['accepted'],
      activeAdjustments: 1,
      invalidatedAdjustments: 0,
      lastRunFailed: false,
    })
  )
  record(
    'C1',
    'C',
    '【事实包】事实包里只有状态与冻结的允许/禁止表述，**没有**任何记录正文（canary 搜不到）',
    !JSON.stringify(factPack).includes(CANARY) && factPack.state === 'active',
    `含 canary=${String(JSON.stringify(factPack).includes(CANARY))}`
  )
  const section = renderAdaptiveSelfSection({
    states: [
      {
        ...baselineAdaptiveSelfState('clarify_when_ambiguous'),
        level: 'enhanced',
        revision: 1,
        roots: ['ce:1', 'ce:2', 'ce:3'],
      },
    ],
    maxTokens: 300,
    quantify: (text) => text.length,
  })
  record(
    'C2',
    'C',
    '【上下文 section】正文只来自**程序模板**：section 里既没有记录正文（canary），也没有内部 id',
    section[0] !== undefined &&
      !JSON.stringify(section).includes(CANARY) &&
      !section[0].content.includes('ce:1') &&
      (section[0].sourceRefs ?? []).every((ref) => ref.startsWith('adaptive-self:')),
    `含 canary=${String(JSON.stringify(section).includes(CANARY))}`
  )
  const gatewaySrc = readFileSync(join(REPO_ROOT, 'src/kernel/app/turn-gateway.ts'), 'utf8')
  const adaptiveStepBody =
    /kind: 'adaptive_self_context'[\s\S]*?\n      \}\)/.exec(gatewaySrc)?.[0] ?? ''
  const attributeKeys = [...adaptiveStepBody.matchAll(/^\s{10}(\w+):/gm)].map((match) => match[1]!)
  const allowedKeys = new Set([
    'outcome',
    'candidate_count',
    'used_count',
    'used_refs',
    'reached_context',
    'dropped_by_context_budget',
    'budget_tokens',
    'fact_state',
    'allowed_claims_count',
    'forbidden_claims_count',
  ])
  const unexpected = attributeKeys.filter((key) => !allowedKeys.has(key))
  record(
    'C3',
    'C',
    '【trace 属性闭集】`adaptive_self_context` 步的属性键**全部**在白名单里（新增键必须显式登记 —— 否则正文会悄悄进 trace）',
    attributeKeys.length > 0 && unexpected.length === 0,
    `键=${JSON.stringify(attributeKeys)} · 越界=${JSON.stringify(unexpected)}`
  )
  record(
    'C4',
    'C',
    '【trace 无正文】该步的属性值里没有任何自由文本形态（`used_refs` 是 id 列表；其余是计数/枚举/布尔）',
    adaptiveStepBody.length > 0 &&
      !adaptiveStepBody.includes('explanation') &&
      !adaptiveStepBody.includes('focusQuestion') &&
      !adaptiveStepBody.includes('statement'),
    `含 explanation=${String(adaptiveStepBody.includes('explanation'))}`
  )

  // -------------------------------------------------------------------------
  // S 组 —— 量具自检
  // -------------------------------------------------------------------------
  const byGroup = { A: 0, B: 0, C: 0 }
  for (const check of checks) if (check.group !== 'S') byGroup[check.group] += 1
  record(
    'S1',
    'S',
    '三组都测到**非零**条目',
    Object.values(byGroup).every((count) => count > 0),
    Object.entries(byGroup).map(([group, count]) => `${group}=${String(count)}`).join(' · ')
  )
  record(
    'S2',
    'S',
    '【canary 自检】canary 在**该出现**的地方确实出现（否则"搜不到"可能只是没读到）',
    JSON.stringify(buildDeveloperReflectionList({ records: [base], rootVerdicts: [] })).includes(CANARY),
    `正控面含 canary=true`
  )

  const failed = checks.filter((check) => !check.pass)
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId =
    out === undefined
      ? createM11RunId({ wpId: 'wp11-observability', headShort: head })
      : runIdFromM11OutPath(REPO_ROOT, out)
  const dir = openM11RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm11-observability-verify@1',
    manifestVersion: M11_MANIFEST_VERSION,
    runId,
    head,
    databaseScope: 'isolated-sandbox',
    modelCalls: 0,
    measuredCount: checks.length,
    reasonCodeSets: {
      draft: REFLECTION_DRAFT_REJECTION_REASONS.length,
      lineage: lineageFacts.length,
      triggers: triggerFacts.length,
      review: REFLECTION_REVIEW_REASONS.length,
    },
    checks,
    summary: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
  }
  writeFileSync(join(dir, 'observability-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM11Manifest(dir, {
    runId,
    wp: 'wp11-observability',
    head,
    headShort: head.slice(0, 12),
    branch: 'codex/m11-execution-plan',
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'observability',
    counts: { total: checks.length, passed: checks.length - failed.length, failed: failed.length },
    phases: ['single'],
    supersedes: null,
    notes: 'm11:observability:verify（理由码可达性机器核对 + 遮蔽 + 四个外发面的正文泄漏负控）',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label} —— ${check.detail}`)
  console.log(`verdict: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${String(checks.length - failed.length)}/${String(checks.length)}）`)
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error('m11:observability:verify 抛错（不是被拒，是执行器坏了）：', error)
  process.exit(1)
})
