/**
 * **G9 门：历史 L 额度对账 · 本批额度决定 · 可测性取舍 · 有效模型参数/费用口径**
 *
 * 执行位置：**宿主**（不碰数据库、不碰产品、不发请求）。
 *  · 台账与保留报告只存在于宿主 `artifacts/cognitive/local/**`（不进镜像）；
 *  · 有效参数只读 `.env.test` 的**非机密元数据**（主机 / 模型 / key 长度），不记 key 取值；
 *  · 容器侧的端点元数据摘要由宿主编排用 `f1-endpoint-metadata.ts` 在 simhost 内取回后传入
 *    （`F1_CONTAINER_ENDPOINT_METADATA_SHA256`），本门要求两侧摘要一致。
 *
 * 这四件事**分别是**：
 *  ① 历史对账：在保留报告范围内逐份核对 sha256 与小计；**全量原始请求完整性仍未确认** ⇒ 记 null，不发额度
 *  ② 本批额度：显式裁定“本批授权请求数 = 0”，且**不**从 864 上界推算剩余额度
 *  ③ 可测性取舍：机器可读裁定 = 当前八题只作资格/否决成本试点，原收益保持 MEASUREMENT_NOT_READY
 *  ④ 有效参数/费用：请求参数唯一事实源 + temperature 生效值（非 0）+ 不偷偷加推理参数
 *     + usage 缺失按上限保守计（绝不补 0）
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  F1_ABORT_POLICY, F1_ABORT_POLICY_TEXT, F1_REQUEST_PARAMETERS, F1_USAGE_POLICY, chargeForUsage,
  endpointMetadataDigest, endpointMetadataFromEnvText, fileDigestOrMissing, sha256Text,
} from './f1-live-runner-guards.ts'

const OUT_DIR = resolve('artifacts/local/f1-quota-params')
mkdirSync(OUT_DIR, { recursive: true })
const checks: string[] = []
const check = (label: string, pass: unknown, detail = ''): void => {
  assert.ok(pass, `${label}${detail === '' ? '' : ` — ${detail}`}`)
  checks.push(label)
  console.log(`PASS ${label}${detail === '' ? '' : ` — ${detail}`}`)
}
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(resolve(path), 'utf8')) as Record<string, unknown>

// ---------------------------------------------------------------------------
// ① 历史 L 台账（保留报告范围内）
// ---------------------------------------------------------------------------
const auditPath = 'artifacts/cognitive/local/f1-readiness-20261024/ledger-audit.json'
check('台账审计文件存在', existsSync(resolve(auditPath)), auditPath)
const audit = readJson(auditPath)
check('台账状态 = RECONCILED_RETAINED_F0_REPORTS_ONLY', audit.status === 'RECONCILED_RETAINED_F0_REPORTS_ONLY', String(audit.status))
const records = (audit.records ?? []) as Array<{ path: string, sha256: string, status: string, physicalRequests: number, attributedRequests: number, tokens: number, sealedAt: string, startMarker: string }>
check('保留报告恰好两份（v1 + v2）', records.length === 2, `实际 ${String(records.length)}`)

let physical = 0
let attributed = 0
let tokens = 0
const inventory: Array<{ path: string, sha256: string, status: string }> = []
for (const record of records) {
  const digest = fileDigestOrMissing(resolve(record.path))
  check(`保留报告存在且摘要一致：${record.path.split('\\').pop()}`, digest === record.sha256, `${record.sha256.slice(0, 12)} -> ${digest.slice(0, 12)}`)
  const report = readJson(record.path) as Record<string, unknown>
  check(`保留报告终态 = COMPLETE：${record.path.split('\\').pop()}`, report.status === 'COMPLETE', String(report.status))
  check(`封存/开始标记绑定：${record.path.split('\\').pop()}`,
    typeof report.sealedAt === 'string' && typeof report.startMarker === 'string')
  physical += Number(record.physicalRequests)
  attributed += Number(record.attributedRequests)
  tokens += Number(record.tokens)
  inventory.push({ path: record.path, sha256: digest, status: String(report.status) })
}
check('物理请求小计 = 24 + 72 = 96', physical === 96, String(physical))
check('归属请求小计 = 72 + 72 = 144', attributed === 144, String(attributed))
check('token 小计 = 38238 + 109436 = 147674', tokens === 147_674, String(tokens))
check('审计文件的小计与逐份求和一致',
  audit.knownPhysicalRequests === physical && audit.knownAttributedRequests === attributed && audit.knownTokens === tokens)
check('全局完整性**未**确认（不得写成已确认）', audit.globalCompletenessVerified === false)
check('剩余已批准额度 = null（不从 864 上界推算）', audit.remainingApprovedRequests === null)

// 更宽的台账扫描：`artifacts/` 下任何 JSON 里出现顶层 physicalRequests 的记录都必须落在这两份保留报告里。
// ⚠️ 这是"报告级清单"，不是 provider 账单，也不能证明不存在未写报告的调用。
const scanRoots = ['artifacts/cognitive/local', 'artifacts/local']
interface ScanEntry { path: string, sha256: string, requests: number | null, tokens: number | null }
const scanned: ScanEntry[] = []
const walk = (dir: string): void => {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let stats
    try { stats = statSync(full) } catch { continue }
    if (stats.isDirectory()) { walk(full); continue }
    if (!name.endsWith('.json') || stats.size > 5 * 1024 * 1024) continue
    let parsed: unknown
    try { parsed = JSON.parse(readFileSync(full, 'utf8')) } catch { continue }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    const isLTrack = typeof record.modelRequestAttempts === 'number'
      || (typeof record.generations === 'number' && typeof record.tokenCap === 'number')
    if (!isLTrack) continue
    const requests = typeof record.modelRequestAttempts === 'number'
      ? record.modelRequestAttempts
      : typeof record.generations === 'number' ? record.generations : null
    scanned.push({
      path: full.split('\\').join('/'),
      sha256: sha256Text(readFileSync(full, 'utf8')),
      requests,
      tokens: typeof record.totalTokens === 'number' ? record.totalTokens : null,
    })
  }
}
for (const root of scanRoots) walk(root)
const retainedPaths = new Set(records.map(record => record.path.split('\\').join('/')))
const classified = scanned.map(entry => {
  const classification = retainedPaths.has(entry.path)
    ? 'retained_f0_subtotal'
    : entry.path.includes('planning-20261022') || entry.path.includes('measurability-audit-20261023')
      ? 'pre_protocol_planning_outside_subtotal'
      : 'UNCLASSIFIED'
  return { ...entry, classification }
})
const unclassified = classified.filter(entry => entry.classification === 'UNCLASSIFIED')
check('报告级扫描：每一份 L 记账文件都被归类（没有未归属项）',
  unclassified.length === 0, unclassified.map(entry => entry.path).join(', '))
check('报告级扫描：两份保留报告确实在扫描结果里',
  classified.filter(entry => entry.classification === 'retained_f0_subtotal').length === 2,
  `扫到 ${String(classified.length)} 份 L 类文件`)
const outside = classified.filter(entry => entry.classification === 'pre_protocol_planning_outside_subtotal')
const outsideRequests = outside.reduce((sum, entry) => sum + (entry.requests ?? 0), 0)
const outsideTokens = outside.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0)
check('协议建立前的规划试点报告被**单独列出**（不混入保留小计）',
  outside.length === 4, `实际 ${String(outside.length)} 份`)
check('协议前规划试点：报告级合计 28 请求 / 44 676 token（**不**并入 96/144/147674）',
  outsideRequests === 28 && outsideTokens === 44_676, `${String(outsideRequests)} / ${String(outsideTokens)}`)
// 同一组 (requests, tokens) 出现两次 ⇒ 可能同一物理运行的副本，不得当两次独立运行相加
const signatureGroups = new Map<string, string[]>()
for (const entry of outside) {
  const signature = `${String(entry.requests)}:${String(entry.tokens)}`
  signatureGroups.set(signature, [...(signatureGroups.get(signature) ?? []), entry.path])
}
const possibleDuplicates = [...signatureGroups.entries()].filter(([, paths]) => paths.length > 1)
check('协议前规划：记录了可能的重复物理运行（相同 requests/tokens 签名），不重复相加',
  possibleDuplicates.length === 1, JSON.stringify(possibleDuplicates.map(([signature]) => signature)))
check('保留小计口径不变：只含两份保留报告（96 / 144 / 147674）',
  physical === 96 && attributed === 144 && tokens === 147_674)
check('扫描结论只声称"报告级清单"，不声称 provider 级完整性',
  String(audit.note ?? '').includes('not provider billing'), String(audit.note ?? '').slice(0, 80))

// ---------------------------------------------------------------------------
// ② 本批额度决定
// ---------------------------------------------------------------------------
const decisionPath = 'docs/architecture/f1-preregistration-20261024/feasibility-decision.json'
check('可测性/额度裁定（机器可读）存在', existsSync(resolve(decisionPath)))
const decision = readJson(decisionPath)
const allowance = decision.allowance as Record<string, unknown>
check('本批授权请求数 = 0（不是"上界减已用"）',
  allowance.thisBatchAuthorizedRequests === 0 && allowance.derivedFromGlobalCap === false)
check('剩余已批准额度仍为 null', allowance.remainingApprovedRequests === null)
check('全局 L 上界 864 只作上界记录', allowance.globalLCap === 864)
check('裁定里的已知小计与本门逐份核对一致',
  allowance.knownPhysicalRequests === physical && allowance.knownAttributedRequests === attributed && allowance.knownTokens === tokens)
const inventoryRecord = allowance.reconciliationInventory as Record<string, unknown>
check('裁定里的对账清单与本门扫描一致（保留 2 份 / 协议前 4 份 / 28 请求 / 44 676 token）',
  inventoryRecord.subtotalScope === 'retained_f0_reports_only' &&
  inventoryRecord.retainedF0Reports === 2 && inventoryRecord.preProtocolPlanningReports === outside.length &&
  inventoryRecord.preProtocolPlanningRequestsReportLevel === outsideRequests &&
  inventoryRecord.preProtocolPlanningTokensReportLevel === outsideTokens &&
  inventoryRecord.possibleDuplicateSignaturePairs === possibleDuplicates.length)
const draft = readJson('docs/architecture/f1-preregistration-20261024/execution-draft.json')
check('执行草案仍是 NOT_SEALABLE（不是执行清单）', draft.status === 'NOT_SEALABLE', String(draft.status))
check('执行草案不声称已批准执行序列', (draft.proposedSequenceBudget as Record<string, unknown>).approvedForExecution === false)
check('执行草案不含运行授权', (draft.authorization as Record<string, unknown>).modelCallsAuthorized === false)
check('执行草案规模 = 3 世界 × 8 题 × 3 臂 = 72 次臂执行',
  (draft.sizes as Record<string, unknown>).armExecutions === 72 && (draft.sizes as Record<string, unknown>).uniqueTasks === 24)
const draftTaskBudget = draft.taskBudget as Record<string, unknown>
const draftSequence = draft.proposedSequenceBudget as Record<string, unknown>
check('单题时限能容下最坏的 6 次模型调用（评测侧规划器 90 s；产品默认 45 s 不变）',
  Number(draftTaskBudget.deadlineMs) >= 6 * 90_000, `deadlineMs=${String(draftTaskBudget.deadlineMs)}`)
check('单题模型请求上限 = 6（候选+记忆+反思合计）', draftTaskBudget.maxModelRequests === 6)
check('序列预算：请求上限 432（与 9 单元 × 72 臂任务一致）',
  draftSequence.requests === 432 && (draft.sizes as Record<string, unknown>).maxModelRequests === 432)
check('序列 token 上限按实测重校准（≥ 432 × 实测 ≈3 918 token/次 ≈ 1.7 M）',
  Number(draftSequence.totalTokens) >= 1_690_000, `totalTokens=${String(draftSequence.totalTokens)}`)
check('序列时限能容下 9 个单元（单元 = 8 × 单题时限 + 余量）',
  Number(draftSequence.wallClockSeconds) >= 9 * (8 * Number(draftTaskBudget.deadlineMs) + 120_000) / 1000,
  `wallClockSeconds=${String(draftSequence.wallClockSeconds)}`)

// ---------------------------------------------------------------------------
// ③ §2 可测性取舍（必须具名、不得事后换主指标）
// ---------------------------------------------------------------------------
check('裁定状态 = DECIDED_PILOT_ONLY', decision.status === 'DECIDED_PILOT_ONLY', String(decision.status))
check('裁定 = 资格/否决成本试点', decision.choice === 'qualification_veto_and_cost_pilot_only', String(decision.choice))
check('原收益问题保持 MEASUREMENT_NOT_READY', decision.originalFirstSixBenefit === 'MEASUREMENT_NOT_READY')
check('没有新收益协议（不得偷偷换窗口）', decision.newBenefitProtocol === 'NOT_DESIGNED')
check('未替换原主指标', decision.notReplacedMainMetric === true)
check('当前八题范围 = qualification_veto_and_cost_only',
  decision.currentEightTasksScope === 'qualification_veto_and_cost_only')
check('裁定不授权模型调用/生产激活',
  (decision.authorization as Record<string, unknown>).modelCallsAuthorized === false &&
  (decision.authorization as Record<string, unknown>).productionActivationAuthorized === false)
const scope = draft.measurementScope as Record<string, unknown>
check('草案 measurementScope 与裁定一致',
  scope.currentEightTasks === decision.currentEightTasksScope && scope.originalBenefit === decision.originalFirstSixBenefit)
const decisionDoc = String(decision.decisionDocument)
check('裁定文档存在且与 JSON 互相引用', existsSync(resolve(decisionDoc)), decisionDoc)
const docText = readFileSync(resolve(decisionDoc), 'utf8')
check('裁定文档写明 playful 边界：MEASUREMENT_NOT_READY / 不得重命名', docText.includes('MEASUREMENT_NOT_READY') && docText.includes('不得'))
check('裁定文档写明 locked 没有替代完成路径', docText.includes('locked') && docText.includes('替代完成路径'))
check('裁定文档写明本批 0 请求', docText.includes('本批真实模型请求 = 0') || docText.includes('本批授权请求数 = 0'))
const prereg = readFileSync('docs/architecture/Cognitive-Capability-F1-Preregistration-2026-10-24.md', 'utf8')
check('预注册 §2 仍写着原主指标不得被替换', prereg.includes('不得偷偷替换原主指标') && prereg.includes('MEASUREMENT_NOT_READY'))

// ---------------------------------------------------------------------------
// ④ 有效模型参数（静态绑定；本批无法用请求再验）
// ---------------------------------------------------------------------------
const envFile = [process.env.F1_TEST_ENV_FILE, process.env.TEST_MODEL_ENV_FILE, '.env.test']
  .find((candidate): candidate is string => candidate !== undefined && candidate.trim() !== '' && existsSync(candidate))
check('宿主侧存在非生产测试配置（只读非机密元数据）', envFile !== undefined, String(envFile))
assert.ok(envFile !== undefined)
const hostMetadata = endpointMetadataFromEnvText(readFileSync(envFile, 'utf8'))
const hostDigest = endpointMetadataDigest(hostMetadata)
const containerDigest = (process.env.F1_CONTAINER_ENDPOINT_METADATA_SHA256 ?? '').trim()
check('容器侧端点元数据摘要已由编排传入', /^[a-f0-9]{64}$/.test(containerDigest), containerDigest.slice(0, 12))
check('宿主与容器的端点元数据摘要一致（同一提供方/模型/key 长度）', containerDigest === hostDigest,
  `${hostDigest.slice(0, 12)} vs ${containerDigest.slice(0, 12)}`)
check('端点主机不是回环地址（拒绝仿真桩端点）',
  hostMetadata.host !== '127.0.0.1' && hostMetadata.host !== 'localhost' && hostMetadata.host !== '::1', hostMetadata.host)
check('模型名非空且 key 存在（只记长度）', hostMetadata.model !== '' && hostMetadata.apiKeyPresent && hostMetadata.apiKeyLength > 0,
  `${hostMetadata.model} / len ${String(hostMetadata.apiKeyLength)}`)
const recordedParams = decision.effectiveParameters as Record<string, unknown>
check('请求参数唯一事实源与裁定一致',
  F1_REQUEST_PARAMETERS.candidateCount === recordedParams.candidateCount &&
  F1_REQUEST_PARAMETERS.responseFormat === recordedParams.responseFormat &&
  F1_REQUEST_PARAMETERS.maxCompletionTokens === recordedParams.maxCompletionTokens &&
  F1_REQUEST_PARAMETERS.temperatureRequested === recordedParams.temperatureRequested &&
  F1_REQUEST_PARAMETERS.reasoningEffort === recordedParams.reasoningEffort)
check('temperature 的**生效值**被如实记为"恒为 1"，不是 0（不得当确定性采样）',
  typeof recordedParams.temperatureEffective === 'string' &&
  String(recordedParams.temperatureEffective).startsWith('PROVIDER_IGNORES_REQUESTED_ZERO_ALWAYS_1') &&
  F1_REQUEST_PARAMETERS.temperatureEffective === recordedParams.temperatureEffective)
check('不偷偷补 reasoning_effort（参数为 null，且运行器源码不含该字段）',
  recordedParams.reasoningEffort === null &&
  !readFileSync('scripts/cognitive/f1-live-runner.ts', 'utf8').includes('reasoning_effort'))
check('所有角色调用统一 max_tokens 上限（测量控制）',
  recordedParams.uniformMaxCompletionTokens === true && F1_REQUEST_PARAMETERS.uniformMaxCompletionTokens === true &&
  readFileSync('scripts/cognitive/f1-live-runner.ts', 'utf8').includes('max_tokens'))
check('G8 守卫门读数存在且 PASS（费用口径的机械证据）',
  existsSync(resolve('artifacts/local/f1-runner-guards/verification.json')) &&
  readJson('artifacts/local/f1-runner-guards/verification.json').status === 'PASS')

// 费用口径：usage 缺失绝不补 0；**输出上限不是总 token 上限**（已知输入必须保留、总量标未知、成本未确认即停）
const missing = chargeForUsage(undefined, F1_REQUEST_PARAMETERS.maxCompletionTokens)
check('usage 缺失 ⇒ reportedTokens=null / usageMissing=true', missing.reportedTokens === null && missing.usageMissing === true)
check('usage 缺失 ⇒ 成本**未确认**（costVerifiable=false）', missing.costVerifiable === false)
check('usage 缺失 ⇒ 扣账只是已知下限（0 + 4096，不是"已确认成本"）', missing.chargedTokens === 4096)
const knownInput = chargeForUsage({ prompt_tokens: 10_000 }, 4096)
check('已知输入 10000、其余缺失 ⇒ 保留已知量（knownPromptTokens=10000）', knownInput.knownPromptTokens === 10_000)
check('已知输入 10000、其余缺失 ⇒ **总量标未知**（reportedTokens=null）', knownInput.reportedTokens === null)
check('已知输入 10000、其余缺失 ⇒ 扣账 ≥ 已知输入（14096，不是 4096）', knownInput.chargedTokens === 14_096)
check('已知输入 10000、其余缺失 ⇒ 成本未确认', knownInput.costVerifiable === false && knownInput.usageMissing === true)
const partial = chargeForUsage({ prompt_tokens: 5, completion_tokens: 7 }, 4096)
check('usage 分项齐全 ⇒ 求和（12）且成本已确认', partial.reportedTokens === 12 && partial.usageMissing === false && partial.costVerifiable === true)
const zero = chargeForUsage({ total_tokens: 0 }, 4096)
check('provider 明确报 0 ⇒ 尊重真读数（0 与"缺失"可区分）', zero.chargedTokens === 0 && zero.usageMissing === false && zero.costVerifiable === true)
check('费用口径写明"报告级、不是 provider 账单"',
  F1_USAGE_POLICY.billingClaim.includes('provider 账单') && F1_USAGE_POLICY.billingClaim.includes('报告级') &&
  F1_USAGE_POLICY.missingUsage.includes('NEVER_ZERO_FILLED'))
check('费用口径写明"成本未确认即停止后续请求"',
  F1_USAGE_POLICY.missingUsageRule.includes('停止后续请求') && F1_USAGE_POLICY.missingUsageRule.includes('总量标未知') &&
  F1_USAGE_POLICY.missingUsageRule.includes('已知下限'))
check('费用口径写明"在途崩溃"处置（发出前留痕 + 未完成尝试 ⇒ 停止序列）',
  F1_USAGE_POLICY.inFlightJournaling.includes('attempt_started') &&
  F1_USAGE_POLICY.inFlightJournaling.includes('在途崩溃') &&
  F1_USAGE_POLICY.inFlightJournaling.includes('INCOMPLETE'))
check('政策 A：客户端 abort 单列为"有界未确认成本"（已知下限扣账 + 事件上限 + 继续）',
  F1_ABORT_POLICY.maxUnverifiedCostEvents === 8 &&
  F1_ABORT_POLICY.scope === 'client_abort_only' &&
  F1_ABORT_POLICY_TEXT.includes('有界未确认成本') &&
  F1_ABORT_POLICY_TEXT.includes('继续') &&
  F1_ABORT_POLICY_TEXT.includes('立刻停止'))
check('政策 A 不覆盖提供方 usage 异常（HTTP 200 但 usage 不完整仍然立刻停止）',
  F1_ABORT_POLICY_TEXT.includes('HTTP 200 但 usage 不完整') &&
  F1_USAGE_POLICY.missingUsageRule.includes('停止后续请求'))
check('记账口径的"已知下限"公式写清楚（不是输出上限当总量）',
  F1_USAGE_POLICY.knownFloorCharge.includes('下限') && F1_USAGE_POLICY.knownFloorCharge.includes('maxCompletionTokens'))
const decisionCost = decision.costAccounting as Record<string, unknown>
check('裁定 JSON 的费用口径与本门一致（含停止规则、已知下限与在途崩溃口径）',
  String(decisionCost.missingUsage ?? '') === F1_USAGE_POLICY.missingUsage &&
  String(decisionCost.missingUsageRule ?? '').includes('停止后续请求') &&
  String(decisionCost.knownFloorCharge ?? '').includes('下限') &&
  String(decisionCost.inFlightJournaling ?? '') === F1_USAGE_POLICY.inFlightJournaling)
check('裁定 JSON 记录政策 A（客户端 abort 有界未确认 + 事件上限 8）',
  Number((decisionCost.clientAbortPolicy as Record<string, unknown> | undefined)?.maxUnverifiedCostEvents) === F1_ABORT_POLICY.maxUnverifiedCostEvents &&
  String((decisionCost.clientAbortPolicy as Record<string, unknown> | undefined)?.scope) === 'client_abort_only')

// ---------------------------------------------------------------------------
// ⑤ 本门进程零请求 + 运行目录的授权核对
// ---------------------------------------------------------------------------
check('本门进程没有运行授权标记', process.env.F1_MODEL_CALLS_AUTHORIZED === undefined)
/*
 * ⚠️ 口径演进（2026-10-25 真实试点之后）：本批**已经**按用户授权真实执行过，
 *    所以"没有 run 目录"不再是正确不变量。正确的不变量是：
 *    **每个存在的 run 目录都必须来自"已授权"的封印**（不许有未授权运行），
 *    并且门报告里**声明的**物理请求数仍然是 0（门本身零物理请求）。
 */
const liveRoot = resolve('artifacts/local/f1-live')
const runDirs = existsSync(liveRoot)
  ? readdirSync(liveRoot).filter(name => name.startsWith('run-') && existsSync(resolve(liveRoot, name, 'report.json')))
  : []
const runReports = runDirs.map(name => readJson(resolve(liveRoot, name, 'report.json')) as {
  startMarker?: string
  status?: string
  sealAuthorized?: boolean
  resumedAfter?: string | null
  cost?: { requestsAttempted?: number, tokensCharged?: number, totalAgainstBudget?: { requests?: number, tokens?: number } }
})
/*
 * 授权核对：运行报告里的 `sealAuthorized`（新报告带）或**该 startMarker 对应的封印清单**里
 * `authorization.modelCallsAuthorized === true`（旧报告没有该字段时用封印清单回溯核对）。
 */
const segmentManifests = [
  'artifacts/cognitive/local/f1-g8g9-20261025/sealed-manifest-segment2-executed.json',
  'artifacts/cognitive/local/f1-g8g9-20261025/attempt-1-aborted/sealed-manifest.json',
  'artifacts/cognitive/local/f1-g8g9-20261025/attempt-3-partial/sealed-manifest.json',
]
const authorizedMarkers = new Set<string>()
for (const path of segmentManifests) {
  if (!existsSync(path)) continue
  const manifest = readJson(path) as { startMarker?: string, authorization?: { modelCallsAuthorized?: boolean } }
  if (typeof manifest.startMarker === 'string' && manifest.authorization?.modelCallsAuthorized === true) {
    authorizedMarkers.add(manifest.startMarker)
  }
}
check('存在真实运行目录时，每个都必须**有授权记录**（报告字段或该 startMarker 的授权封印）',
  runReports.every(report =>
    typeof report.startMarker === 'string' && report.startMarker.length >= 32 &&
    typeof report.status === 'string' &&
    (report.sealAuthorized === true || authorizedMarkers.has(report.startMarker)) &&
    typeof report.cost?.requestsAttempted === 'number' && typeof report.cost?.tokensCharged === 'number'))
check('真实运行的累计花费**不超过**封印上限（403 ≤ 432 请求 / 1 612 564 ≤ 2 000 000 token）',
  runReports.every(report =>
    (report.cost?.totalAgainstBudget?.requests ?? 0) <= 432 &&
    (report.cost?.totalAgainstBudget?.tokens ?? 0) <= 2_000_000),
  runReports.map(report => `${String(report.status)}:${String(report.cost?.totalAgainstBudget?.requests)}/${String(report.cost?.totalAgainstBudget?.tokens)}`).join(' '))
const g8Report = readJson('artifacts/local/f1-runner-guards/verification.json')
check('G8 门声明零物理模型请求', g8Report.physicalModelRequests === 0, String(g8Report.physicalModelRequests))

const output = resolve(OUT_DIR, 'verification.json')
writeFileSync(output, `${JSON.stringify({
  schema: 'f1-g9-verification@1',
  status: 'PASS',
  kind: 'quota_ledger_reconciliation_and_static_effective_parameters',
  executionLocation: 'host（台账/报告只存在于宿主；不碰数据库/产品，不发请求）',
  checks,
  ledger: {
    inventory: classified,
    outsideSubtotal: {
      entries: outside, requestsReportLevel: outsideRequests, tokensReportLevel: outsideTokens,
      possibleDuplicateGroups: possibleDuplicates.map(([signature, paths]) => ({ signature, paths })),
      note: '协议建立前的规划试点按既有口径不并入保留小计；相同签名不得当两次独立运行相加',
    },
    knownPhysicalRequests: physical,
    knownAttributedRequests: attributed,
    knownTokens: tokens,
    globalCompletenessVerified: false,
    remainingApprovedRequests: null,
    scanRoots,
    retainedReportCount: records.length,
    note: '报告级清单：不能证明不存在未写报告的调用，也不是 provider 账单',
  },
  allowance: allowance,
  feasibility: {
    status: decision.status, choice: decision.choice,
    originalFirstSixBenefit: decision.originalFirstSixBenefit,
    newBenefitProtocol: decision.newBenefitProtocol,
    decisionDocument: { path: decisionDoc, sha256: sha256Text(docText) },
  },
  effectiveParameters: {
    endpoint: { host: hostMetadata.host, model: hostMetadata.model, apiKeyLength: hostMetadata.apiKeyLength },
    hostMetadataSha256: hostDigest,
    containerMetadataSha256: containerDigest,
    metadataMatch: containerDigest === hostDigest,
    parameters: F1_REQUEST_PARAMETERS,
    temperatureEffective: recordedParams.temperatureEffective,
    verification: 'STATIC_ONLY_NOT_RECHECKED_BY_REQUEST_THIS_TURN',
  },
  costAccounting: F1_USAGE_POLICY,
  thisBatch: {
    modelRequests: 0,
    evidence: '无封存运行授权；G8 门为离线确定性 transport；未执行 --run',
    doesNotProve: '报告外不存在调用（需要 provider 账单/审计才可能证明）',
  },
  residuals: [
    '全局 L 请求完整性未确认：保留报告小计已核对，报告外调用不可排除',
    'provider 账单不可得：token 记账只作报告级读数',
    'temperature 生效值来自 2026-10-24 文档核对，本批未用请求复验',
    '有效参数/usage 口径在真实提供方下的行为要等授权运行才有机读证据',
  ],
}, null, 2)}\n`, 'utf8')
console.log(`G9 额度/参数门：${checks.length} 项检查全部通过; ${output}`)
