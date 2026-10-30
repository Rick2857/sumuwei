/**
 * **P3-5a 真实模型试点的薄运行器**（封存 / 状态 / 运行三模式）。
 *
 * ```text
 * pnpm exec tsx scripts/cognitive/p3-5-live-runner.ts --seal     # 零请求：产出**干封存**
 * pnpm exec tsx scripts/cognitive/p3-5-live-runner.ts --status   # 只读：封存 / 漂移 / 授权 / 账目
 * pnpm exec tsx scripts/cognitive/p3-5-live-runner.ts --run      # 真实请求（**本批未授权** ⇒ 必须被拒）
 * ```
 *
 * ============================================================================
 *  三条纪律（与 F2 执行器同一条）
 * ============================================================================
 * ```text
 * ① `--seal` / `--status` **零请求**、零出网、零数据库 ⇒ 它们只读文件、只写本地产物。
 * ② `--run` **必须**依次过七道闸（预算批准 **≠** 运行授权）：
 *      封存无漂移 → 预算已批准 → 另一次运行授权 → 端点可用 → 隔离库 → 预算闸 → 时限
 *    任一不过 ⇒ **具名拒绝** + 退出码非 0（**绝不**"悄悄跑起来"）。
 * ③ 判分**不是**运行器的职责：逐轮只产出**原始读数**，结论由 `p3-5-score.ts` 给。
 * ```
 *
 * ============================================================================
 *  装配（`--run` 真实路径）
 * ============================================================================
 * ```text
 * 真实任务环：`createActionTurnPort` + `runTask`（真 Gateway / 真账本 / 真策略）
 * 真实规划器：`createOpenAiTaskPlanner`（**显式** `reasoningEffort:'low'` ⇒ 请求体真的带 reasoning_effort）
 * 真实上下文：`TurnGateway.compileTurn`（ContextCompiler）⇒ 技能 section 真的入模
 * 两臂差别**只有**一处：技能 provider / 适配器（A=legacy 固定清单，B=P3 目录 + 发布状态）。
 * ```
 *
 * ⚠️ **两处必须让 Lead 知道的装配口径**（都不是改材料，是运行器的取舍）：
 * ```text
 * ① 任务入口：生产入口靠 `looksLikeTask` 词形判据签发任务授权；本批 6 个任务里
 *    只有 T5 命中词形 ⇒ 运行器**显式签发**任务授权，让 6 个任务走**同一条**任务环
 *    （两臂逐字一致；预注册 §8 本就排除"生产入口的表现"）。
 * ② 最终答复：任务环的规划器只产出**计划**，不产出答复正文；而 M2/M4 要判"答案"。
 *    ⇒ 运行器在任务环结束后**再做一次同端点、同模型、同 reasoning_effort 的答复调用**
 *    （正文 = 用户原话 + 真实编译出的上下文 + 本轮真读到的内容），它同样计量、同样入账本。
 *    这条调用**不在**冻结材料里 ⇒ 已在最终报告里点名，请判分器按此对齐。
 * ```
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { envValuesFromEnvText } from './f1-live-runner-guards.ts'
import {
  P3_5_ARMS,
  P3_5_DEFAULT_SCORE_GATE_ID,
  appendP35Accounting,
  appendP35AttemptLedger,
  appendF2TaskJournal,
  assertP35PlannerEndpoint,
  buildP35AccountingEntry,
  buildP35PlannerEnv,
  buildP35SealedManifest,
  buildP35Summary,
  collectP35SealBindings,
  computeP35SourceFingerprint,
  copyP35Corpus,
  decideP35TurnAnswer,
  ensureP35WriteSurfaces,
  fileDigestOrMissing,
  p35ArmTotals,
  p35GateReadingsDigest,
  p35GuardCodeOf,
  p35MissingBindings,
  p35SealDrift,
  readP35Accounting,
  readP35AttemptLedger,
  readP35BudgetProposal,
  readP35CorpusManifest,
  readP35RunAuthorization,
  readP35TaskJournal,
  readP35TaskSpec,
  sha256Text,
  unwrapP35GateReadings,
  verifyP35Corpus,
  verifyP35SpecDigest,
  type P35Arm,
  type P35GateReadings,
  type P35SealBinding,
  type P35SealedManifest,
  type P35TaskSpec,
  type P35TurnReport,
} from './p3-5-live-runner-guards.ts'
import { createF2Meter, type F2RequestMeter } from './f2-live-runner-guards.ts'

// ---------------------------------------------------------------------------
//  路径（**全部是仓库相对路径** ⇒ 宿主 / 容器两侧同一份读数）
// ---------------------------------------------------------------------------
const REPO = resolve('.')
const PREREG_DIR = 'docs/architecture/p3-5-preregistration-20261028'
const TASK_SPEC_PATH = join(PREREG_DIR, 'task-spec.json')
const PROTOCOL_PATH = join(PREREG_DIR, 'protocol.md')
const EVALUATION_PATH = join(PREREG_DIR, 'evaluation.json')
const BUDGET_PATH = join(PREREG_DIR, 'budget-proposal.json')
const CORPUS_MANIFEST_PATH = join(PREREG_DIR, 'corpus-manifest.json')
const CORPUS_SOURCE_DIR = join(PREREG_DIR, 'corpus')
const OUT_ROOT = resolve('artifacts/cognitive/local')
/** 累计账目（**跨封存不清零**：预注册 §4「不重封存清零账目」）。 */
const ACCOUNTING_PATH = join(OUT_ROOT, 'p3-5-accounting.jsonl')

const SEAL_FILE = 'p3-5-seal.json'
const GATE_READINGS_FILE = 'gate-readings.json'
const CORPUS_DIR = 'corpus'
const LEDGER_FILE = 'requests.jsonl'
const JOURNAL_FILE = 'tasks.jsonl'
const TURNS_DIR = 'turns'
const SUMMARY_FILE = 'summary.json'
const AUTHORIZATION_FILE = 'p3-5-run-authorization.json'

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------
function stampNow(): string {
  return new Date().toISOString().replace(/[-:.]/g, '')
}
function sealDirFor(stamp: string): string {
  return join(OUT_ROOT, `p3-5-${stamp}`)
}
/** 定位本轮封存目录：`P3_5_SEAL_DIR` 优先，否则取**最新**一个含封存文件的目录。 */
function resolveSealDir(): string | undefined {
  const explicit = (process.env.P3_5_SEAL_DIR ?? '').trim()
  if (explicit !== '') return resolve(explicit)
  if (!existsSync(OUT_ROOT)) return undefined
  const candidates = readdirSync(OUT_ROOT)
    .filter(name => name.startsWith('p3-5-'))
    .filter(name => existsSync(join(OUT_ROOT, name, SEAL_FILE)))
    .sort()
  if (candidates.length === 0) return undefined
  return join(OUT_ROOT, candidates[candidates.length - 1]!)
}
function scoreGateId(): string {
  return (process.env.P3_5_SCORE_GATE_ID ?? '').trim() || P3_5_DEFAULT_SCORE_GATE_ID
}
function loadSeal(dir: string): P35SealedManifest | undefined {
  const path = join(dir, SEAL_FILE)
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf8')) as P35SealedManifest } catch { return undefined }
}
/** 门读数：唯一来源是 `P3_5_GATE_READINGS_FILE`（优先）或 `P3_5_GATE_READINGS_JSON`。 */
function readGateReadings(): P35GateReadings {
  const file = (process.env.P3_5_GATE_READINGS_FILE ?? '').trim()
  if (file !== '' && existsSync(file)) {
    try { return unwrapP35GateReadings(JSON.parse(readFileSync(file, 'utf8'))) } catch { return {} }
  }
  const raw = (process.env.P3_5_GATE_READINGS_JSON ?? '').trim()
  if (raw === '') return {}
  try { return unwrapP35GateReadings(JSON.parse(raw)) } catch { return {} }
}
/**
 * 把绝对路径分类：**根内 / 就是根本身 / 根外**。
 *
 * ⚠️ 三态必须分开：`library.search` 的证据引用是**资料根目录**（不是文件），
 *    把它算成"读路径"或"越界读"都是错的。
 */
function classifyAgainstRoot(root: string, absolute: string): 'root' | 'inside' | 'outside' {
  const rel = relative(root, absolute)
  if (rel === '') return 'root'
  if (rel.startsWith('..') || rel.startsWith(`..${sep}`) || resolve(root, rel) === resolve(root)) return 'outside'
  return 'inside'
}
function relativeToRoot(root: string, absolute: string): string | undefined {
  if (classifyAgainstRoot(root, absolute) !== 'inside') return undefined
  return relative(root, absolute).split('\\').join('/')
}


// ---------------------------------------------------------------------------
//  当前绑定（**不**读凭据、**不**产生请求）
// ---------------------------------------------------------------------------
interface CurrentMaterial {
  readonly spec: P35TaskSpec | undefined
  readonly budget: ReturnType<typeof readP35BudgetProposal>
  readonly corpusManifest: ReturnType<typeof readP35CorpusManifest>
  readonly modelParameters: Readonly<Record<string, unknown>>
  readonly budgetCaps: Readonly<Record<string, unknown>>
  readonly corpus: Readonly<Record<string, unknown>>
  readonly gateReadings: P35GateReadings
  readonly bindings: readonly P35SealBinding[]
  readonly missing: readonly string[]
}

function currentMaterial(): CurrentMaterial {
  const spec = readP35TaskSpec(TASK_SPEC_PATH)
  const budget = readP35BudgetProposal(BUDGET_PATH)
  const corpusManifest = readP35CorpusManifest(CORPUS_MANIFEST_PATH)
  const gateReadings = readGateReadings()
  const requiredGateIds = [
    'p3:skill-usage:verify',
    'p3:skill-revision:verify',
    'p3:skill-rule-dependency:verify',
    'learning:contracts:verify',
    scoreGateId(),
  ]
  const gateDigest = p35GateReadingsDigest(gateReadings, requiredGateIds)

  /*
   * 模型参数：**以冻结材料为准**（`task-spec.json#modelParameters`）。
   * ⚠️ 必须能看见 `reasoning_effort=low`（预注册 §2 的硬要求）⇒ 明文留一份在封存里。
   */
  const modelParameters: Record<string, unknown> = {
    provider: spec?.modelParameters.provider ?? null,
    model: spec?.modelParameters.model ?? null,
    baseUrlHost: spec?.modelParameters.baseUrlHost ?? null,
    reasoningEffort: spec?.modelParameters.reasoningEffort ?? null,
    reasoning_effort: spec?.modelParameters.reasoningEffort ?? null,
    reasoningEffortMustBeInRequest: spec?.modelParameters.reasoningEffortMustBeInRequest ?? null,
    maxCompletionTokens: spec?.modelParameters.maxCompletionTokensPerRequest ?? null,
    temperature: spec?.modelParameters.temperature ?? null,
  }
  const budgetCaps: Record<string, unknown> = budget === undefined
    ? {}
    : {
        requestsPerTurn: budget.caps.requestsPerTurn,
        requestsCap: budget.caps.requestsCap,
        tokensCap: budget.caps.tokensCap,
        maxCompletionTokensPerRequest: budget.caps.maxCompletionTokensPerRequest,
        perRequestTimeoutSeconds: budget.caps.perRequestTimeoutSeconds,
        sequenceTimeoutSeconds: budget.caps.sequenceTimeoutSeconds,
        maxUnconfirmedCostEvents: budget.caps.maxUnconfirmedCostEvents,
      }
  const corpus: Record<string, unknown> = corpusManifest === undefined
    ? {}
    : {
        corpusId: corpusManifest.corpusId,
        frozenAt: corpusManifest.frozenAt,
        fileCount: corpusManifest.fileCount,
        totalBytes: corpusManifest.totalBytes,
        files: corpusManifest.files.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 })),
      }

  const fingerprint = computeP35SourceFingerprint(REPO)
  const image = (process.env.P3_5_IMAGE_ID ?? '').trim()
  const specCheck = verifyP35SpecDigest(spec)
  const bindings = collectP35SealBindings({
    computed: {
      sourceFingerprint: fingerprint.fingerprint,
      image: image === '' ? 'MISSING' : image,
      taskSequence: specCheck.declared === '' ? 'MISSING' : specCheck.declared,
      gateReadings: gateDigest.digest,
      budgetCaps: budget === undefined ? 'MISSING' : sha256Text(JSON.stringify(budgetCaps)),
      modelParameters: sha256Text(JSON.stringify(modelParameters)),
      corpus: corpusManifest === undefined ? 'MISSING' : sha256Text(JSON.stringify(corpus)),
      protocol: fileDigestOrMissing(PROTOCOL_PATH),
      taskSpec: fileDigestOrMissing(TASK_SPEC_PATH),
      /*
       * ⚠️ 判分口径（evaluation.json）**必须**进封存：否则"跑完之后改判分规则再打分"不会被发现。
       *    （Lead 在复核运行器时补的绑定项；门 22 断言绑定项集合。）
       */
      evaluation: fileDigestOrMissing(EVALUATION_PATH),
    },
    sources: {
      sourceFingerprint: 'scripts/cognitive/source-fingerprint.ts 同算法',
      image: 'P3_5_IMAGE_ID',
      taskSequence: 'task-spec.json#specDigest',
      gateReadings: 'P3_5_GATE_READINGS_FILE',
      budgetCaps: 'budget-proposal.json#caps',
      modelParameters: 'task-spec.json#modelParameters',
      corpus: 'corpus-manifest.json',
      protocol: 'protocol.md',
      taskSpec: 'task-spec.json',
    },
  })
  return {
    spec, budget, corpusManifest, modelParameters, budgetCaps, corpus, gateReadings, bindings,
    missing: p35MissingBindings(bindings),
  }
}

// ---------------------------------------------------------------------------
//  端点（**只读 `.env.test`**；绝不回落生产 key；只打印 host 与 model）
// ---------------------------------------------------------------------------
interface EndpointConfig {
  readonly baseUrl: string
  readonly model: string
  readonly key: string
  readonly host: string
  readonly file: string
}
function loadEndpointConfig(): { ok: true, value: EndpointConfig } | { ok: false, detail: string } {
  const candidates = [
    process.env.P3_5_TEST_ENV_FILE,
    process.env.TEST_MODEL_ENV_FILE,
    '/opt/serversim/env/.env.test',
    '.env.test',
  ]
  const file = candidates.find((candidate): candidate is string =>
    candidate !== undefined && candidate.trim() !== '' && existsSync(candidate))
  if (file === undefined) {
    return { ok: false, detail: '找不到测试端点配置文件（P3_5_TEST_ENV_FILE / TEST_MODEL_ENV_FILE / .env.test）' }
  }
  const values = envValuesFromEnvText(readFileSync(file, 'utf8'))
  const baseUrl = (values.OPENAI_BASE_URL ?? '').trim().replace(/\/+$/, '')
  const model = (values.OPENAI_SMALL_MODEL ?? '').trim()
  const key = (values.OPENAI_API_KEY ?? '').trim()
  if (baseUrl === '' || model === '' || key === '') {
    return { ok: false, detail: 'OPENAI_BASE_URL / OPENAI_SMALL_MODEL / OPENAI_API_KEY 缺一（真实运行需要测试端点凭据）' }
  }
  let host: string
  try { host = new URL(baseUrl).hostname } catch { return { ok: false, detail: 'OPENAI_BASE_URL 不是合法 URL' } }
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') {
    return { ok: false, detail: `端点主机是回环地址（拒绝把仿真桩端点当成真实提供方）：${host}` }
  }
  return { ok: true, value: { baseUrl, model, key, host, file } }
}

// ---------------------------------------------------------------------------
//  静态闸（**不碰数据库、不发请求**）：`--status` 与 `--run` 共用
// ---------------------------------------------------------------------------
interface Blocker { readonly code: string, readonly detail: string }
function collectStaticBlockers(input: {
  readonly manifest: P35SealedManifest | undefined
  readonly material: CurrentMaterial
  readonly drift: readonly string[]
  readonly authorization: { ok: boolean, reason?: string }
  readonly checkEndpoint: boolean
}): Blocker[] {
  const blockers: Blocker[] = []
  const { manifest, material, drift } = input
  if (manifest === undefined) {
    blockers.push({ code: 'missing_seal', detail: '没有封存（先跑 --seal）' })
    return blockers
  }
  if (drift.length > 0) blockers.push({ code: 'seal_drift', detail: `漂移：${drift.join(',')}` })
  const specCheck = verifyP35SpecDigest(material.spec)
  if (!specCheck.ok) {
    blockers.push({
      code: 'spec_digest_mismatch',
      detail: `task-spec 的 specDigest=${specCheck.declared || '(读不到)'}，冻结值=${specCheck.expected}`,
    })
  }
  if (material.missing.length > 0) {
    blockers.push({ code: 'seal_incomplete', detail: `封存绑定缺项：${material.missing.join(',')}` })
  }
  const budget = material.budget
  if (budget === undefined) {
    blockers.push({ code: 'budget_not_approved', detail: '读不到 budget-proposal.json' })
  } else if (budget.approved !== true) {
    blockers.push({ code: 'budget_not_approved', detail: 'budget-proposal.json 的 approved 不是 true（预算待用户裁定）' })
  } else if (budget.approval.runAuthorizationRequired === true && !input.authorization.ok) {
    blockers.push({
      code: 'run_not_authorized',
      detail: `预算已批准，但**另一次**运行授权文件不可用：${input.authorization.reason ?? '未知原因'}`,
    })
  }
  if (input.checkEndpoint) {
    const endpoint = loadEndpointConfig()
    if (!endpoint.ok) {
      blockers.push({ code: 'endpoint_invalid', detail: endpoint.detail })
    } else {
      const sealedModel = String(manifest.modelParameters.model ?? '')
      const sealedHost = String(manifest.modelParameters.baseUrlHost ?? '')
      if (sealedModel !== '' && endpoint.value.model !== sealedModel) {
        blockers.push({ code: 'endpoint_invalid', detail: `端点模型 ${endpoint.value.model} ≠ 预注册模型 ${sealedModel}` })
      }
      if (sealedHost !== '' && endpoint.value.host !== sealedHost) {
        blockers.push({ code: 'endpoint_invalid', detail: `端点主机 ${endpoint.value.host} ≠ 预注册主机 ${sealedHost}` })
      }
    }
  }
  return blockers
}

// ---------------------------------------------------------------------------
//  模式分派
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2)
const mode = argv.find(arg => arg.startsWith('--')) ?? '--status'

/** 具名拒绝的唯一出口（**退出码非 0**）。 */
function reject(code: string, detail: string): never {
  console.error(`拒绝运行：${code}（${detail}）`)
  process.exit(3)
}

// ===========================================================================
//  `--seal`（**零请求**）
// ===========================================================================
if (mode === '--seal') {
  const stamp = stampNow()
  const dir = sealDirFor(stamp)
  mkdirSync(dir, { recursive: true })
  const material = currentMaterial()

  /* ---- 资料快照：复制到本轮只读根 + **逐文件核对 sha256** ---- */
  let corpusFiles: readonly { path: string, bytes: number, sha256: string }[] = []
  if (material.corpusManifest === undefined) {
    reject('corpus_mismatch', `读不到资料清单：${CORPUS_MANIFEST_PATH}`)
  }
  const copied = copyP35Corpus({
    manifest: material.corpusManifest,
    sourceRoot: resolve(CORPUS_SOURCE_DIR),
    targetRoot: join(dir, CORPUS_DIR),
  })
  if (!copied.ok) {
    reject('corpus_mismatch', `资料快照与清单不符：${[...copied.mismatches, ...copied.missing].join('；')}`)
  }
  corpusFiles = copied.files

  /* ---- 门读数（拿不到的写 null + 原因） ---- */
  const requiredGateIds = [
    'p3:skill-usage:verify',
    'p3:skill-revision:verify',
    'p3:skill-rule-dependency:verify',
    'learning:contracts:verify',
    scoreGateId(),
  ]
  const gateDigest = p35GateReadingsDigest(material.gateReadings, requiredGateIds)
  const gateReadingsDoc = {
    schema: 'p3-5-gate-readings@1',
    generatedAt: new Date().toISOString(),
    source: (process.env.P3_5_GATE_READINGS_FILE ?? process.env.P3_5_GATE_READINGS_JSON ?? '(无环境变量 ⇒ 全部 MISSING)'),
    requiredGateIds,
    readings: requiredGateIds.map(id => ({
      gateId: id,
      /* ⚠️ 拿不到的写 **null** + 原因（不写 "PASS"、也不猜）。 */
      status: material.gateReadings[id] === undefined ? null : String(material.gateReadings[id]),
      reason: material.gateReadings[id] === undefined
        ? '本机没有读到这道门的读数（不猜、不把"没读到"当"通过"）'
        : '',
    })),
    missing: gateDigest.missing,
    failed: gateDigest.failed,
    digest: gateDigest.digest,
  }
  writeFileSync(join(dir, GATE_READINGS_FILE), `${JSON.stringify(gateReadingsDoc, null, 2)}\n`, 'utf8')

  /* ---- 封存清单 ---- */
  const manifest = buildP35SealedManifest({
    bindings: material.bindings,
    sealedAt: new Date().toISOString(),
    authorized: false,
    modelParameters: material.modelParameters,
    budgetCaps: material.budgetCaps,
    corpus: { ...material.corpus, copiedFiles: corpusFiles },
    evaluation: { path: EVALUATION_PATH, sha256: fileDigestOrMissing(EVALUATION_PATH) },
    arms: material.spec?.arms.map(arm => arm.arm) ?? [...P3_5_ARMS],
    tasks: material.spec?.tasks.map(task => ({ taskId: task.taskId, kind: task.kind })) ?? [],
    repeats: material.spec?.repeats ?? 0,
  })
  writeFileSync(join(dir, SEAL_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  /* ---- 打印摘要 ---- */
  console.log(`P3-5a 干封存已生成：${join(dir, SEAL_FILE)}`)
  console.log(`  status      = ${manifest.status}`)
  console.log(`  startMarker = ${manifest.startMarker}`)
  console.log(`  digest      = ${manifest.digest.slice(0, 16)}…`)
  console.log('  绑定项：')
  for (const binding of material.bindings) {
    const flag = binding.value === 'MISSING' ? '（MISSING）' : ''
    console.log(`    ${binding.id.padEnd(18)} = ${binding.value.slice(0, 24)}…${flag}`)
  }
  console.log(`  模型参数    = ${String(material.modelParameters.model)} @ ${String(material.modelParameters.baseUrlHost)} · reasoning_effort=${String(material.modelParameters.reasoning_effort)} · max_tokens=${String(material.modelParameters.maxCompletionTokens)}`)
  console.log(`  预算上限    = ${material.budget === undefined ? 'MISSING' : `${String(material.budget.caps.requestsCap)} 请求 / ${String(material.budget.caps.tokensCap)} token`}（approved=${String(material.budget?.approved)}）`)
  console.log(`  资料快照    = ${String(material.corpus.corpusId)} · ${corpusFiles.length} 个文件已复制并逐文件核对 sha256`)
  console.log(`  门读数      = ${gateDigest.passed.length} PASS / ${gateDigest.failed.length} FAIL / ${gateDigest.missing.length} MISSING${gateDigest.missing.length > 0 ? `（${gateDigest.missing.join(',')}）` : ''}`)
  console.log(`  missing     = ${material.missing.length === 0 ? '无' : material.missing.join(',')}`)
  console.log('  可运行      = 否（干封存没有运行授权；`--run` 必被具名拒绝）')
  process.exit(0)
}

// ===========================================================================
//  `--status`（**只读**）
// ===========================================================================
if (mode === '--status') {
  const dir = resolveSealDir()
  if (dir === undefined) {
    console.log(`没有封存（${OUT_ROOT}\\p3-5-*\\${SEAL_FILE}）`)
    console.log('  可运行=否（missing_seal）')
    process.exit(0)
  }
  const manifest = loadSeal(dir)
  const material = currentMaterial()
  const drift = manifest === undefined ? [] : p35SealDrift(manifest, material.bindings)
  const budget = material.budget
  const authorizationPath = join(dir, AUTHORIZATION_FILE)
  const authorization = readP35RunAuthorization(authorizationPath)
  const ledger = readP35AttemptLedger(join(dir, LEDGER_FILE))
  const journal = readP35TaskJournal(join(dir, JOURNAL_FILE))
  const accounting = readP35Accounting(ACCOUNTING_PATH)

  console.log(`封存目录：${dir}`)
  if (manifest === undefined) {
    console.log('  封存文件不可读 ⇒ 可运行=否（missing_seal）')
    process.exit(0)
  }
  console.log(`  status=${manifest.status} sealedAt=${manifest.sealedAt} startMarker=${manifest.startMarker}`)
  console.log(`  digest=${manifest.digest.slice(0, 16)}…`)
  console.log('  绑定项（封存值 vs 当前值）：')
  for (const binding of material.bindings) {
    const sealed = manifest.bindings.find(item => item.id === binding.id)
    const sealedValue = sealed?.value ?? '(不在封存里)'
    const same = sealedValue === binding.value
    console.log(`    ${binding.id.padEnd(18)} ${same ? '同' : '**漂**'}  封存=${sealedValue.slice(0, 20)}${sealedValue === 'MISSING' ? '(MISSING)' : ''}  当前=${binding.value.slice(0, 20)}${binding.value === 'MISSING' ? '(MISSING)' : ''}`)
  }
  console.log(`  漂移        = ${drift.length === 0 ? '无' : drift.join(',')}`)
  console.log(`  missing     = ${material.missing.length === 0 ? '无' : material.missing.join(',')}`)
  console.log(`  预算批准    = ${budget === undefined ? 'MISSING（读不到 budget-proposal.json）' : String(budget.approved)}（status=${budget?.status ?? '-'} · runAuthorizationRequired=${String(budget?.approval.runAuthorizationRequired ?? '-')}）`)
  console.log(`  运行授权    = ${authorization.ok ? `在场（${authorization.value.authorizedBy} @ ${authorization.value.authorizedAt}）` : `不在场（${authorization.ok ? '' : authorization.reason}）`}`)
  console.log(`  本轮账目    = 请求 ${String(ledger.requests)} · token ${String(ledger.tokens)} · 在途 ${String(ledger.inFlight)} · 未确认 ${String(ledger.unconfirmed)} · 被拒 ${String(ledger.refused)}（账本可读=${String(ledger.readable)}）`)
  console.log(`  本轮任务账本= started ${String(journal.started.length)} · finished ${String(journal.finished.length)} · 在途 ${String(journal.inFlightTaskIds.length)}（可读=${String(journal.readable)}）`)
  console.log(`  累计账目    = 请求 ${String(accounting.requests)} · token ${String(accounting.tokens)} · 未确认 ${String(accounting.unconfirmed)} · 中止轮 ${String(accounting.abortedTurns)}（**跨封存不清零**）`)
  const blockers = collectStaticBlockers({
    manifest, material, drift, authorization, checkEndpoint: true,
  })
  console.log(`  可运行      = ${blockers.length === 0 ? '是' : '否'}`)
  if (blockers.length > 0) {
    console.log('               阻塞项（按闸门顺序）：')
    for (const blocker of blockers) console.log(`                 · ${blocker.code}：${blocker.detail}`)
  }
  process.exit(0)
}

// ===========================================================================
//  `--run`（真实请求）
// ===========================================================================
if (mode === '--run') {
  /*
   * ---------------------------------------------------------------------------
   *  父进程：只做**静态闸**（封存 / 漂移 / 预算 / 授权 / 端点）—— 都在起 PG 之前
   * ---------------------------------------------------------------------------
   */
  const dir = resolveSealDir()
  const manifest = dir === undefined ? undefined : loadSeal(dir)
  const material = currentMaterial()
  const drift = manifest === undefined ? [] : p35SealDrift(manifest, material.bindings)
  const authorizationPath = dir === undefined ? '' : join(dir, AUTHORIZATION_FILE)
  const authorization = dir === undefined ? { ok: false as const, reason: '没有封存目录' } : readP35RunAuthorization(authorizationPath)

  const staticBlockers = collectStaticBlockers({
    manifest, material, drift, authorization, checkEndpoint: true,
  })
  if (staticBlockers.length > 0) {
    for (const blocker of staticBlockers) console.error(`阻塞：${blocker.code}（${blocker.detail}）`)
    reject(staticBlockers[0]!.code, staticBlockers[0]!.detail)
  }

  /* ---- 端点（**只打印 host 与 model，绝不打印 key**） ---- */
  const endpoint = loadEndpointConfig()
  if (!endpoint.ok) reject('endpoint_invalid', endpoint.detail)
  console.log(`端点：host=${endpoint.value.host} model=${endpoint.value.model}（key 不打印、不落盘）`)


  /* ---- 资料快照：运行前再核一次（封存之后被动过 ⇒ 拒绝） ---- */
  if (material.corpusManifest === undefined) reject('corpus_mismatch', '读不到资料清单')
  const corpusRoot = join(dir!, CORPUS_DIR)
  const corpusCheck = verifyP35Corpus({ manifest: material.corpusManifest, root: corpusRoot })
  if (!corpusCheck.ok) {
    reject('corpus_mismatch', `本轮资料副本与清单不符：${[...corpusCheck.mismatches, ...corpusCheck.missing].join('；')}`)
  }

  /*
   * ---- 写面预检（**首次请求之前**，零请求） ----
   *
   * 故障原型（2026-10-28 实测）：累计账目被 `docker cp` 写成 `root:root`，容器内运行用户只能读 ⇒
   * 第 1 轮 **发完 4 次真实请求之后** 才在 `appendP35Accounting` 抛 `EACCES`：钱花了、账记不上。
   * ⇒ 现在先以**实际运行用户**探一次三处写面（账目 / 本轮请求账本 / 任务账本），不可写就失败关闭。
   */
  const writeSurfaces = ensureP35WriteSurfaces({
    accountingPath: ACCOUNTING_PATH,
    ledgerPath: join(dir!, LEDGER_FILE),
    journalPath: join(dir!, JOURNAL_FILE),
  })
  if (!writeSurfaces.ok) reject(writeSurfaces.code, writeSurfaces.detail)
  console.log('  写面预检：账目 / 请求账本 / 任务账本均可追加（零请求）')

  /* ---- 隔离 PG：薄宿主自举（照 p3-skill-rule-dependency-verify.ts 的形状） ---- */
  if (process.env.LG_P3_5_LIVE_PG_CHILD !== '1') {
    process.env.LG_P3_5_LIVE_PG_CHILD = '1'
    process.env.LG_PG_GATE_TIMEOUT_MS ??= '900000'
    const { runPreparedPgGate, runPreparedPgGateInInstance } = await import('../postgresql/test-harness.ts')
    const admin = (process.env.LG_SIM_PGTEST_ADMIN_URL ?? '').trim()
    if (admin !== '') await runPreparedPgGateInInstance(admin, 'p3-5-live', 'scripts/cognitive/p3-5-live-runner.ts')
    else await runPreparedPgGate('p3-5-live', 'scripts/cognitive/p3-5-live-runner.ts')
    process.exit(0)
  }

  // =========================================================================
  //  子进程：真实运行
  // =========================================================================
  const { isolateDatabase } = await import('../../src/dev/sandbox.ts')
  const sandbox = isolateDatabase('p3-5-live', { postgres: { url: process.env.LG_TEST_PG_URL ?? '' } })
  if (sandbox.backend !== 'postgres') reject('db_not_isolated', `隔离后端不是 postgres（${sandbox.backend}）`)

  const { createM4Harness } = await import('../m4-harness.ts')
  const { exec } = await import('../../src/infrastructure/persistence/db.ts')
  const { sql } = await import('drizzle-orm')
  const { createActionGateway } = await import('../../src/kernel/action/gateway.ts')
  const { createCapabilityRegistry } = await import('../../src/kernel/action/capability-registry.ts')
  const { createActionLedgerStore } = await import('../../src/infrastructure/action/action-ledger-store.ts')
  const { createInMemoryPayloadStaging } = await import('../../src/kernel/action/payload-staging.ts')
  const { createTaskAuthorizationRegistry } = await import('../../src/kernel/action/task-authorization.ts')
  const { createActionTurnPort } = await import('../../src/kernel/action/action-turn.ts')
  const { createActionIntentDetector } = await import('../../src/kernel/action/intent-detector.ts')
  const { TurnGateway } = await import('../../src/kernel/app/turn-gateway.ts')
  const { DEFAULT_CONTEXT_BUDGET } = await import('../../src/kernel/recall/selector.ts')
  const {
    PERSONAL_LIBRARY_PERMISSION,
    PERSONAL_LIBRARY_SEARCH,
    WORKFLOW_SKILL,
    WORKFLOW_SKILL_PERMISSION,
    createLearningCapabilityDefinitions,
  } = await import('../../src/kernel/action/learning-capabilities.ts')
  const { LOCAL_FILE_READ_PERMISSION, createLocalFileCapabilityDefinitions } = await import('../../src/kernel/action/local-file-capabilities.ts')
  const { createUtilityCapabilityDefinitions, DOCUMENT_READ_PERMISSION } = await import('../../src/kernel/action/utility-capabilities.ts')
  const { createPersonalLibraryAdapter } = await import('../../src/infrastructure/action/adapters/personal-library.ts')
  const { createLocalReadAdapter } = await import('../../src/infrastructure/action/adapters/local-filesystem.ts')
  const { createDocumentReadAdapter } = await import('../../src/infrastructure/action/adapters/document-read.ts')
  const {
    createManagedWorkflowSkillAdapter,
    createWorkflowSkillAdapter,
    loadWorkflowSkills,
  } = await import('../../src/infrastructure/action/adapters/workflow-skill.ts')
  const {
    createManagedWorkflowSkillProvider,
    createWorkflowSkillProvider,
  } = await import('../../src/kernel/context/workflow-skill-section.ts')
  const { loadWorkflowSkillCatalog, loadedReleaseOf } = await import('../../src/infrastructure/action/workflow-skill-catalog.ts')
  const { createWorkflowSkillReleaseStore } = await import('../../src/infrastructure/persistence/workflow-skill-release-store.ts')
  const { createOpenAiTaskPlanner } = await import('../../src/infrastructure/model/openai-task-planner.ts')

  const harness = await createM4Harness({ label: 'p3-5-live', userId: 'Alex' })
  const identityRows = await exec(harness.db, sql`select current_database() as name`, 'p3-5 identity')
  const databaseName = String((identityRows[0] as { name?: unknown } | undefined)?.name ?? '')
  if (!databaseName.startsWith('lg_test_')) reject('db_not_isolated', `当前库不是隔离库：${databaseName}`)

  const spec = material.spec
  const caps = spec?.budgetCaps
  if (spec === undefined || caps === undefined) reject('seal_incomplete', 'task-spec 或预算上限不可读')
  /** 单请求 completion 上限：预算提案的 `caps` 优先（冻结材料的 `budgetCaps` 里没有这一项）。 */
  const maxCompletionTokens = material.budget?.caps.maxCompletionTokensPerRequest
    ?? spec.modelParameters.maxCompletionTokensPerRequest

  /* ---- 目录登记（B 臂要用发布状态；A 臂不受影响） ---- */
  const catalogLoad = loadWorkflowSkillCatalog()
  if (!catalogLoad.ok) reject('seal_incomplete', `技能目录资产不可读：${catalogLoad.code}`)
  const loadedCatalog = catalogLoad.loaded
  const releaseStore = createWorkflowSkillReleaseStore(harness.db)
  const registered = await releaseStore.registerCatalog(loadedCatalog.catalog, {
    catalogDigest: loadedCatalog.catalogDigest,
    now: Date.now(),
  })
  if (!registered.ok) reject('seal_incomplete', `技能目录登记失败：${registered.code}`)

  const legacySkills = loadWorkflowSkills()
  const managedSkillIds = loadedCatalog.catalog.skills.map(skill => skill.skillId)

  /* ---- 计量器（F2 的）：**发出前**预留、usage 缺失 ⇒ cost_unverifiable ---- */
  const accountingBefore = readP35Accounting(ACCOUNTING_PATH)
  const ledgerPath = join(dir!, LEDGER_FILE)
  const journalPath = join(dir!, JOURNAL_FILE)
  const meter = createF2Meter({
    requestsCap: Math.max(0, caps.requestsCap - accountingBefore.requests),
    tokensCap: Math.max(0, caps.tokensCap - accountingBefore.tokens),
    perTaskRequests: caps.requestsPerTurn,
    maxCompletionTokens,
    reservationTokens: 4_000,
    now: () => Date.now(),
    onAttempt: entry => appendP35AttemptLedger(ledgerPath, entry),
  })

  const sequenceDeadlineAt = Date.now() + caps.sequenceTimeoutSeconds * 1_000
  const turns: P35TurnReport[] = []
  let stopped: string | undefined

  const runTurn = async (arm: P35Arm, task: P35TaskSpec['tasks'][number], repeat: number): Promise<P35TurnReport> => {
    const turnId = `${arm}-${task.taskId}-r${String(repeat)}`
    const startedAt = Date.now()
    const turnTaskId = `${arm}:${task.taskId}:r${String(repeat)}`
    /** 本轮开始前的账本读数（**逐轮**读数必须是差值，不是累计值）。 */
    const ledgerBefore = readP35AttemptLedger(ledgerPath)

    /* ---- 臂的环境开关（**逐字取自冻结材料**） ---- */
    const armSpec = spec.arms.find(item => item.arm === arm)
    for (const [key, value] of Object.entries(armSpec?.env ?? {})) process.env[key] = value

    const capabilities = [WORKFLOW_SKILL, PERSONAL_LIBRARY_SEARCH, 'local.file.read', 'document.read']
    const grantedPermissions = [
      WORKFLOW_SKILL_PERMISSION,
      PERSONAL_LIBRARY_PERMISSION,
      LOCAL_FILE_READ_PERMISSION,
      DOCUMENT_READ_PERMISSION,
    ]
    const registry = createCapabilityRegistry([
      ...createLearningCapabilityDefinitions(),
      ...createLocalFileCapabilityDefinitions(),
      ...createUtilityCapabilityDefinitions(),
    ])
    const actionLedger = createActionLedgerStore(harness.db)
    const staging = createInMemoryPayloadStaging()
    const authorizations = createTaskAuthorizationRegistry()

    /* ---- 技能适配器：**A 用 legacy、B 用 managed**（唯一差别） ---- */
    const skillAdapter = arm === 'B'
      ? createManagedWorkflowSkillAdapter({
          loaded: loadedCatalog,
          legacySkills,
          readStates: async (skillId: string) => releaseStore.readStates(skillId),
          grantedCapabilities: () => capabilities,
          registeredCapabilities: () => capabilities,
        })
      : createWorkflowSkillAdapter(legacySkills)

    const resolveTarget = async (input: { request: { capability: string, arguments: Record<string, unknown> } }) => {
      const path = typeof input.request.arguments.path === 'string' ? input.request.arguments.path : ''
      return {
        target: {
          type: 'local_executor',
          canonicalId: path !== '' ? path : input.request.capability,
          confidence: 'exact' as const,
          display: `p3-5 ${arm}`,
        },
        scopeViolation: false,
      }
    }
    const actionGateway = createActionGateway({
      registry,
      ledger: actionLedger,
      adapters: [
        skillAdapter,
        createPersonalLibraryAdapter(corpusRoot),
        createLocalReadAdapter(),
        /* ⚠️ `document.read` 也**限定在资料根内**（它的适配器是根内沙箱语义）。 */
        createDocumentReadAdapter({ root: corpusRoot, staging, exposeReadContent: true }),
      ],
      grantedPermissions,
      maxRiskLevel: 'R1',
      resolveTarget: resolveTarget as never,
    })

    /* ---- 计量 transport（**唯一**的物理请求计量点） ---- */
    let refusal: string | undefined
    const meteredFetch: typeof fetch = async (input, init) => {
      const admission = meter.beforeRequest(turnTaskId)
      if (!admission.ok) {
        refusal = p35GuardCodeOf(admission.code)
        appendP35AttemptLedger(ledgerPath, {
          kind: 'attempt_refused', taskId: turnTaskId, at: Date.now(),
          code: refusal, reason: 'meter_refused',
        })
        throw new Error(`p3_5_meter_refused:${refusal}`)
      }
      let response: Response
      try {
        response = await fetch(input, init)
      } catch (error) {
        /* 网络抛错 ⇒ 按"成本不可确认"结算并停（不补 0、不猜 token）。 */
        const aborted = error instanceof Error && error.name === 'AbortError'
        if (aborted) meter.chargeBoundedUnconfirmed(turnTaskId, 'request', 'client_abort')
        else meter.charge(turnTaskId, 'request', undefined)
        throw error
      }
      const rawText = await response.clone().text().catch(() => '')
      let usage: unknown
      try { usage = (JSON.parse(rawText) as { usage?: unknown }).usage } catch { usage = undefined }
      meter.charge(turnTaskId, 'request', usage)
      return response
    }

    /* ---- 真实模型规划器（**显式** reasoningEffort:'low'） ---- */
    /*
     * ⚠️ 端点**必须显式注入**（2026-10-28 首轮试点暴露的真缺陷）：
     *    仿真镜像里带着仓库根的 `.env`（`OPENAI_BASE_URL=http://127.0.0.1:18080/v1` = 仿真桩端点），
     *    而 `src/db/index.ts` 启动时用 dotenv 把**缺失**的变量从它补进 `process.env`
     *    ⇒ 规划器只读 `process.env` 就会**打到仿真桩**：首轮实测 96 次规划请求（96×2 token）
     *    全进了 `lg-serversim-model`，只有最终答复那 24 次走了 `endpoint`。
     *    ⇒ 注入/断言/打印三件都走 `p3-5-live-runner-guards.ts` 的纯函数（**零请求门可测**）。
     */
    const planner = createOpenAiTaskPlanner({
      registry,
      env: buildP35PlannerEnv({ endpoint: endpoint.value }),
      fetchImpl: meteredFetch,
      maxTokens: maxCompletionTokens,
      timeoutMs: caps.perRequestTimeoutSeconds * 1_000,
      reasoningEffort: 'low',
    })
    /* ---- 硬断言：规划器的**实际**端点必须就是冻结端点（否则拒绝继续烧预算） ---- */
    const endpointCheck = assertP35PlannerEndpoint({
      plannerEndpointHost: planner.endpointHost,
      expectedHost: endpoint.value.host,
    })
    if (!endpointCheck.ok) reject(endpointCheck.code, endpointCheck.detail)
    console.log(`  规划器端点：host=${planner.endpointHost} model=${endpoint.value.model}`)

    /*
     * ---- 规划诊断（**只读旁路**：不改规划器行为） ----
     * ⚠️ 为什么要它：首两轮实测出现"每轮 5–6 次规划请求、零动作、零技能加载"，而运行器
     *    当时**没有留下任何规划失败码** ⇒ 事后无法区分"模型答不出可解析计划"与"接线坏了"。
     *    ⇒ 这里逐个记 `ok/failure/parseFailureCode/steps`，进逐轮报告，供事后复核。
     */
    const planDiagnostics: { call: number, ok: boolean, failure?: string, parseFailureCode?: string, steps?: number }[] = []
    const plannerForTurn = {
      id: planner.id,
      endpointHost: planner.endpointHost,
      async plan(input: Parameters<typeof planner.plan>[0]) {
        const call = planDiagnostics.length + 1
        const outcome = await planner.plan(input)
        planDiagnostics.push(outcome.ok
          ? { call, ok: true, steps: outcome.plan.steps.length }
          : {
              call,
              ok: false,
              failure: outcome.failure,
              ...(outcome.parseFailureCode === undefined ? {} : { parseFailureCode: outcome.parseFailureCode }),
            })
        return outcome
      },
    }

    const innerPort = createActionTurnPort({
      gateway: actionGateway,
      detector: createActionIntentDetector(),
      registry,
      attribution: { adapterId: 'p3-5-live' },
      task: {
        authorizations,
        planner: plannerForTurn,
        staging,
        capabilitiesFor: () => capabilities,
        riskLevelFor: () => 'R1',
        resolveTarget: resolveTarget as never,
        replanContext: {
          knownDirectories: () => [corpusRoot],
          contentTokens: 3_000,
        },
      },
    })
    /* ---- 任务入口：显式签发授权（6 个任务走**同一条**任务环） ---- */
    const actionWriter = {
      async handleTurn(input: Parameters<typeof innerPort.handleTurn>[0]) {
        authorizations.issue({
          conversationKey: String(input.conversationKey ?? ''),
          originalText: input.text,
          triggeringEventId: input.eventId,
          allowedCapabilities: capabilities,
          maxRiskLevel: 'R1',
          budget: {
            maxActions: caps.requestsPerTurn * 2,
            /*
             * ⚠️ **预留 1 次给最终答复**：`requestsPerTurn` 是"每轮物理请求硬上限"，
             *    而一轮里既有规划、又有末尾一次答复调用。若把 maxPlans 直接给满 6，
             *    规划用满 6 次就会把答复挤出预算（实测：第 2 轮答复被计量器拒绝
             *    `p3_5_meter_refused:turn_request_cap` ⇒ 本轮**没有答复可判**）。
             *    ⇒ 规划最多 5 次，答复固定留第 6 次（口径不变：本轮总请求仍 ≤ 6）。
             */
            maxPlans: Math.max(1, caps.requestsPerTurn - 1),
            deadlineMs: Math.max(1_000, Math.min(sequenceDeadlineAt - Date.now(), caps.perRequestTimeoutSeconds * 1_000 * caps.requestsPerTurn)),
          },
        })
        return innerPort.handleTurn(input)
      },
    }

    const withheld: { skillId: string, version: number, reason: string }[] = []
    /**
     * 受管 provider：**每次编译按本轮真实动作 outcomes 造一个**（与 P3 门同一形状）。
     * ⚠️ 旧 provider 由 `TurnGateway` 自己按 `workflowSkills` 造（同一份判据）。
     */
    const managedProviderFor = (outcomes: readonly unknown[]) => createManagedWorkflowSkillProvider({
      outcomes: outcomes as never,
      legacySkills,
      managedSkillIds,
      managed: {
        instructionsFor: (skillId: string, version: number, contentFingerprint: string) => {
          const found = loadedReleaseOf(loadedCatalog, skillId, version)
          if (found === undefined || found.release.contentFingerprint !== contentFingerprint) return undefined
          return { instructions: found.instructions, releaseDigest: found.release.releaseDigest }
        },
        readCurrent: async (skillId: string) => releaseStore.readCurrent(skillId),
        onWithheld: entry => { withheld.push({ skillId: entry.skillId, version: entry.version, reason: entry.reason }) },
      },
    })

    const turnGateway = new TurnGateway({
      kernel: harness.kernel,
      definition: harness.kernel.definition,
      identity: harness.kernel.identitySnapshot,
      recorder: harness.recorder,
      conversationSequence: harness.nextTurnSequence,
      slowPathEnabled: false,
      userId: harness.userId,
      actionEnabled: true,
      /* ---- 两臂的**唯一**差别：provider（旧清单 vs P3 目录） ---- */
      ...(arm === 'B'
        ? { workflowSkillProvider: (outcomes: readonly unknown[]) => managedProviderFor(outcomes) }
        : { workflowSkills: legacySkills }),
      recallBudget: { ...DEFAULT_CONTEXT_BUDGET, turnContentTokens: 3_000 },
      actionWriter: actionWriter as never,
    })

    appendF2TaskJournal(journalPath, { kind: 'task_started', unit: arm, taskId: turnTaskId, at: Date.now() })
    const turn = await turnGateway.beginTurn(task.text)
    const packet = await turnGateway.compileTurn({ turn, currentInput: task.text, recentLines: [] })

    /* ---- 读数（动作事实） ---- */
    const actionResults: { request?: { capability?: string, operation?: string, arguments?: Record<string, unknown> }, result?: { status?: string, executed?: boolean, accepted?: boolean, effect?: { kind?: string }, evidence?: readonly { ref?: string }[], turnContent?: readonly { text?: string }[] } }[] = []
    const visit = (item: unknown): void => {
      const record = item as { request?: unknown, result?: unknown, followUps?: readonly unknown[] }
      actionResults.push(record as never)
      for (const child of record.followUps ?? []) visit(child)
    }
    for (const item of turn.actionResults ?? []) visit(item)
    const flat = actionResults
    const readPaths: string[] = []
    let outOfBoundaryReadCount = 0
    let deniedActionCount = 0
    let skillLoadSucceeded = false
    for (const item of flat) {
      const capability = item.request?.capability
      const operation = item.request?.operation
      const result = item.result
      if (result?.accepted === false) deniedActionCount += 1
      if (capability === WORKFLOW_SKILL && operation === 'load'
        && result?.executed === true && result.status === 'success') skillLoadSucceeded = true
      if (capability === WORKFLOW_SKILL) continue
      if (result?.executed !== true || result.status !== 'success') continue
      if (result.effect?.kind !== 'content_read') continue
      if (capability === PERSONAL_LIBRARY_SEARCH) {
        /*
         * ⚠️ `library.search` 的证据引用是**资料根目录**（不是文件）⇒ 不能当"读路径"，
         *    也不能当"越界读"。它**真的读**到的是命中文件 ⇒ 从当轮内容里取那些相对路径
         *    （适配器的命中行形状：`文件：<相对路径>`）。
         */
        for (const content of result.turnContent ?? []) {
          for (const line of (content.text ?? '').split(/\r?\n/)) {
            const match = /^文件：(.+)$/.exec(line.trim())
            if (match === null) continue
            readPaths.push(match[1]!.trim().split('\\').join('/'))
          }
        }
        continue
      }
      for (const evidence of result.evidence ?? []) {
        const ref = evidence.ref
        if (typeof ref !== 'string' || ref === '') continue
        const kind = classifyAgainstRoot(corpusRoot, ref)
        if (kind === 'root') continue
        if (kind === 'outside') { outOfBoundaryReadCount += 1; continue }
        readPaths.push(relativeToRoot(corpusRoot, ref)!)
      }
    }

    /* ---- 注入上下文的技能 section（指纹 = 发布引用） ---- */
    const injectedSkillFingerprints = packet.sections
      .filter(section => section.id.startsWith('workflow-skill:'))
      .flatMap(section => section.sourceRefs ?? [])

    /* ---- 最终答复（同端点 / 同模型 / 同 reasoning_effort 的一次调用） ---- */
    const answerText = await composeFinalAnswer({
      endpoint: endpoint.value, task, packetText: packet.text, readPaths: [...new Set(readPaths)], meteredFetch,
    }).catch((error: unknown) => {
      /* 计量拒收 / 网络失败 ⇒ 本轮如实记"没有答复"，**不**假装答过。 */
      console.error(`  轮 ${turnId} 的答复调用失败：${error instanceof Error ? error.message : String(error)}`)
      return ''
    })
    /*
     * ⚠️ 空答复/被拒答复**不能**交给 `completeTurn`：契约层会抛 `empty_speech_intent`
     *    （她"什么都不说"不是一条 intent）⇒ 上一版因此把整轮序列崩掉（实测第二次尝试）。
     *    判定抽成纯函数 `decideP35TurnAnswer`（零请求门直接测它），这里只执行判定结果：
     *    ⇒ 不收口本轮，逐轮报告如实记 `answerMissing` + `aborted`，成本照记，序列继续。
     */
    const answerDecision = decideP35TurnAnswer({
      answerText,
      ...(refusal === undefined ? {} : { refusal }),
      ...(meter.state().stopCode === undefined ? {} : { meterStopCode: String(meter.state().stopCode) }),
    })
    const answerMissing = answerDecision.answerMissing
    if (answerDecision.submitReply) await turnGateway.completeTurn({ turn, replyText: answerText })

    /* ---- 引用（答复里出现的资料文件） ---- */
    const citedPaths = (material.corpusManifest?.files ?? [])
      .map(file => file.path)
      .filter(path => answerText.includes(path) || answerText.includes(path.split('/').pop() ?? path))

    const meterState = meter.state()
    const turnLedger = readP35AttemptLedger(ledgerPath)
    /* ⚠️ **逐轮读数是差值**（账本是累计文件）：否则第 12 轮会显示累计请求数。 */
    const turnRequests = turnLedger.requests - ledgerBefore.requests
    const turnTokens = turnLedger.tokens - ledgerBefore.tokens
    const usageMissing = (turnLedger.unconfirmed - ledgerBefore.unconfirmed) > 0

    const report: P35TurnReport = {
      turnId,
      arm,
      taskId: task.taskId,
      repeat,
      finalText: answerText,
      readPaths: [...new Set(readPaths)].sort(),
      citedPaths,
      skillLoadSucceeded,
      deniedActionCount,
      outOfBoundaryReadCount,
      snapshotPaths: (material.corpusManifest?.files ?? []).map(file => file.path),
      ...(usageMissing ? { usageMissing: true } : {}),
      ...(refusal !== undefined || meterState.stopCode !== undefined || answerMissing ? { aborted: true } : {}),
      ...(answerMissing ? { answerMissing: true } : {}),
      planDiagnostics: [...planDiagnostics],
      injectedSkillFingerprints,
      requests: turnRequests,
      tokens: turnTokens,
      elapsedMs: Date.now() - startedAt,
    }
    appendF2TaskJournal(journalPath, { kind: 'task_finished', unit: arm, taskId: turnTaskId, at: Date.now(), row: report as unknown as Record<string, unknown> })
    /* ⚠️ 成本**无条件**入账（含答复缺失/被拒/中止的轮次）：失败轮不许变成"没花过钱"的假账。 */
    appendP35Accounting(ACCOUNTING_PATH, buildP35AccountingEntry({
      at: Date.now(),
      startMarker: manifest?.startMarker ?? '',
      turnId,
      requests: turnRequests,
      tokens: turnTokens,
      unconfirmed: Math.max(0, turnLedger.unconfirmed - ledgerBefore.unconfirmed),
      aborted: answerDecision.aborted,
    }))
    return report
  }

  /* ---- 序列：A 臂 6×2 轮 → B 臂 6×2 轮 ---- */
  outer:
  for (const arm of P3_5_ARMS) {
    for (const task of spec.tasks) {
      for (let repeat = 1; repeat <= spec.repeats; repeat += 1) {
        if (Date.now() >= sequenceDeadlineAt) { stopped = 'sequence_timeout'; break outer }
        const report = await runTurn(arm, task, repeat)
        turns.push(report)
        mkdirSync(join(dir!, TURNS_DIR), { recursive: true })
        writeFileSync(join(dir!, TURNS_DIR, `${report.turnId}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
        const state = meter.state()
        console.log(`  轮 ${report.turnId}：加载技能=${String(report.skillLoadSucceeded)} 读=${String(report.readPaths.length)} 拒=${String(report.deniedActionCount)} 请求=${String(state.requests)} token=${String(state.tokens)}${report.answerMissing === true ? ' 答复=缺失' : ''}`)
        /* ⚠️ 规划诊断逐轮打到日志：否则"零动作"事后无法区分"模型答不出可解析计划"与"接线坏了"。 */
        console.log(`    规划=${(report.planDiagnostics ?? []).map(item => item.ok ? `ok(steps=${String(item.steps)})` : `${String(item.failure)}${item.parseFailureCode === undefined ? '' : `/${item.parseFailureCode}`}`).join(' → ') || '(无规划调用)'}`)
        if (state.stopCode !== undefined) { stopped = p35GuardCodeOf(state.stopCode); break outer }
        if (state.costVerifiable === false) { stopped = 'cost_unverifiable'; break outer }
      }
    }
  }

  const summary = buildP35Summary({
    generatedAt: new Date().toISOString(),
    seal: {
      digest: manifest?.digest ?? '',
      startMarker: manifest?.startMarker ?? '',
      sealedAt: manifest?.sealedAt ?? '',
    },
    turns,
  })
  writeFileSync(join(dir!, SUMMARY_FILE), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  const totals = P3_5_ARMS.map(arm => p35ArmTotals(turns, arm))
  console.log(`序列结束：轮次 ${String(turns.length)} · ${stopped === undefined ? '完成' : `停止（${stopped}）`}`)
  for (const total of totals) {
    console.log(`  臂 ${total.arm}：轮 ${String(total.turns)} · 加载技能 ${String(total.skillLoadSucceededTurns)} 轮 · 请求 ${String(total.requests)} · token ${String(total.tokens)} · 拒 ${String(total.deniedActions)} · 越界读 ${String(total.outOfBoundaryReads)}`)
  }
  console.log(`  逐轮报告：${join(dir!, TURNS_DIR)} · 汇总：${join(dir!, SUMMARY_FILE)}`)
  await harness.stop()
  process.exit(stopped === undefined ? 0 : 3)
}

/**
 * 最终答复的一次模型调用（**与规划器同端点 / 同模型 / 同 reasoning_effort**）。
 *
 * ⚠️ 为什么需要它：任务环的规划器只产出**计划**（`goal/steps/done`），
 *    而 M2/M4 要判的是**答案**（关键词命中、引用了哪份文件）。
 *    ⇒ 任务环结束后，用**本轮真读到的内容 + 真实编译出的上下文**再问一次模型，
 *    拿它的正文当答复。这条调用**同样计量、同样入账本**。
 */
async function composeFinalAnswer(input: {
  readonly endpoint: { baseUrl: string, model: string, key: string }
  readonly task: P35TaskSpec['tasks'][number]
  readonly packetText: string
  readonly readPaths: readonly string[]
  readonly meteredFetch: typeof fetch
}): Promise<string> {
  const body = {
    model: input.endpoint.model,
    messages: [
      {
        role: 'system',
        content: [
          '你是一个只读资料助手。用户给了一个问题；下面给出**程序事实**：',
          '① 本轮真实编译出的上下文（含可能加载到的流程技能说明）；',
          '② 本轮**真的读过**的资料文件（相对路径）。',
          '请**只**依据这些事实回答：能回答就回答，不能回答就如实说找不到。',
          '回答里要**点名**你依据的文件名（相对路径即可）。',
          '不要编造没有读过的文件；不要输出 JSON；不要解释你的工作流程。',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `用户问题：${input.task.text}`,
          '',
          '本轮真实读到的文件：',
          ...(input.readPaths.length === 0 ? ['（本轮没有读到任何文件）'] : input.readPaths.map(path => `- ${path}`)),
          '',
          '本轮编译出的上下文：',
          input.packetText.slice(0, 8_000),
        ].join('\n'),
      },
    ],
    reasoning_effort: 'low',
    temperature: 0,
    max_tokens: 4_000,
    stream: false,
  }
  const response = await input.meteredFetch(`${input.endpoint.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${input.endpoint.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const raw = await response.text()
  try {
    const parsed = JSON.parse(raw) as { choices?: { message?: { content?: unknown } }[] }
    const content = parsed.choices?.[0]?.message?.content
    return typeof content === 'string' ? content : ''
  } catch {
    return ''
  }
}

console.error(`未知模式 ${mode}（支持 --seal / --status / --run）`)
process.exit(2)
