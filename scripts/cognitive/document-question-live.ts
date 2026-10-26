/**
 * D 轨：**真实测试模型执行清单（封存）+ 有界运行器**（2026-10-23 · cognitive-evaluation@1 §4/§5）
 *
 * ============================================================================
 *  三种模式，顺序不可颠倒
 * ============================================================================
 *  · `--seal`：**只写封存清单，零请求**。清单固定：协议/题目/评分器/运行器/床位的摘要、
 *    端点与模型元数据、请求参数（温度/最大输出/response_format/封存的提示模板）、
 *    序列总预算（请求数/总输出 token/总时限/单任务时限）、源码与镜像身份、
 *    完整门结果、开始标记。
 *  · `--list-cases`：按封存清单顺序列出 **18 个任务**（6 题 × 3 控制）。
 *    ⇒ 场景清单的**唯一事实源是封存清单**，不是代码里的临时拼装。
 *  · `--case <taskId>`：执行**一个**任务（由 `gates:pg:scenario` 驱动 ⇒
 *    **每个任务一个独立隔离库**），发**恰好一次**真实请求，然后由独立评分器判定。
 *
 *  ---------------------------------------------------------------------------
 *  硬纪律（协议 §5）
 *  ---------------------------------------------------------------------------
 *  · **不自动重试**模型传输失败：失败就是该任务的结果，并计入实际调用与已耗资源。
 *  · 不把**占位端口**调用计为真实模型调用（本运行器只发真实请求，计数即传输数）。
 *  · 传输失败/超时不补跑到齐绿；采集丢失或重复 ⇒ 标数据完整性问题并停止批次。
 *  · **序列级预算在每个任务开始前按已落盘的读数核对**：超出封存上限 ⇒ 该任务
 *    记 NOT_RUN（不发请求），不再往下跑。
 *  · 决定数据只含摘要/引用：**不写私有正文、不写模型原文进决策记录**。
 *  · 只读 `.env.test` 的**测试端点**；不读、不切生产凭证。
 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config } from 'dotenv'
import { createDocumentReadingBed } from './document-reading-bed.ts'
import { runDocumentQuestion } from './document-question-bed.ts'
import { questionText, requireReviewedQuestions, scoreDocumentAnswer, type DocumentQuestions } from './document-answer.ts'

const MODE = process.argv.includes('--seal') ? 'seal'
  : process.argv.includes('--list-cases') ? 'list'
    : process.argv.includes('--case') ? 'case' : undefined
assert.ok(MODE, '用法：--seal（只封存，零请求）/ --list-cases / --case <taskId>')

const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const fileDigest = (path: string) => hash(readFileSync(path))
const root = resolve('.')

/** 封存清单与证据的本地落点（**不入库**）。 */
const evidenceRoot = resolve(process.env.DOCUMENT_QA_LIVE_DIR ?? 'artifacts/local/document-question-live')
const manifestPath = resolve(evidenceRoot, 'sealed-manifest.json')
const jsonlPath = resolve(evidenceRoot, 'live-readings.jsonl')

/** 封存参数：请求形状与预算。**改这里就等于换一次实验 ⇒ 必须重新封存。 */
const SEALED = {
  temperature: 0,
  responseFormat: { type: 'json_object' } as const,
  /** 端口只把编译包交给模型；系统提示是封存的一部分，不含任何评分真值。 */
  systemPrompt: '你是文档问答助手。只依据上面提供的资料回答；资料不足时把 answer 设为 null、basis 设为 insufficient。只输出 JSON。',
  /**
   * ⚠️ **输出上限**：D2 批次封存 2048 时，**零预算负控组 6 个里 5 个空回复**
   * （`outputTokens` 正好触顶、推理吃光预算）⇒ 该组读数被污染。
   * 本常量改为 4096 只用于**新封存**；旧清单仍按旧值执行（清单里的参数优先）。
   */
  maxTokens: 4096,
  budget: {
    /** 协议 §5：D 轨每题 ≤2 次模型请求；本运行器每题只发 1 次（角色选择是本地确定性装配）。 */
    maxRequestsPerTask: 1,
    perTaskTimeoutMs: 120_000,
  },
} as const

const protocolPath = resolve('docs/architecture/Cognitive-Capability-Experiment-Protocol-2026-10-23.md')
const questionsPath = resolve('evals/world-model-pilot/document-questions-v1.json')
const scorerPath = resolve('scripts/cognitive/document-answer.ts')
const bedPath = resolve('scripts/cognitive/document-question-bed.ts')
const runnerPath = resolve('scripts/cognitive/document-question-live.ts')
const questions = JSON.parse(readFileSync(questionsPath, 'utf8')) as DocumentQuestions
requireReviewedQuestions(questions)

const controls = ['normal', 'zero', 'replacement'] as const
type Control = typeof controls[number]
/**
 * 请求变体：**只**改请求里的思考深度设置。
 *
 * ⚠️ 官方文档（2026-10-23 核）：`reasoning_effort` **只对 `MiniMax-M3.1-Flash` 有效**，
 *    取值 `low…max`，**省略时默认 `max`**；我们用的模型 id 是 **`MiniMax-M3.1-Flash-Preview`** ⇒
 *    **是否接受该参数必须实测**，不能假定兼容。
 * ⚠️ 同一文档还写明：`max_tokens` **把思考 token 也算进去**，太小就 `finish_reason: "length"` 且正文为空；
 *    `temperature` 在该端点**被忽略、恒为 1** ⇒ 封存里写 `temperature 0` 是**空操作**（读数要按温度 1 理解）。
 */
const variants = {
  /** 不发 `reasoning_effort` ⇒ 端点按自己的默认（文档：max）。 */
  default: { reasoningEffort: null as string | null },
  /** 显式请求低思考深度（若 Preview id 不支持，端点会报错或忽略 ⇒ 诊断读数自己会说）。 */
  low: { reasoningEffort: 'low' as string | null },
} as const
type Variant = keyof typeof variants
interface TaskSpec { id: string; questionId: string; control: Control; variant: Variant; questionSha256: string }
interface SealedRequest { temperature: number; maxTokens: number; responseFormat: { type: 'json_object' }; systemPrompt: string; variants: Record<string, { reasoningEffort: string | null }> }
interface SealedBudget {
  maxRequests: number
  maxOutputTokensPerRequest: number
  maxTotalOutputTokens: number
  maxWallClockMs: number
  perTaskTimeoutMs: number
}
interface Manifest {
  manifestVersion: string
  sealedAt: string
  startMarker: string
  scope: string
  protocol: { id: string; sha256: string }
  questions: { id: string; sha256: string; reviewStatus: string }
  scorer: { id: string; sha256: string }
  bed: { sha256: string }
  runner: { sha256: string }
  endpoint: { baseUrlHost: string; model: string; apiKeyPresent: boolean; apiKeyLength: number }
  request: SealedRequest
  budget: SealedBudget
  tasks: TaskSpec[]
  identity: { sourceFingerprint: string; imageDigest: string }
  gateReadings: Record<string, string>
  note: string
}

function endpointMetadata(): { baseUrlHost: string; model: string; apiKeyPresent: boolean; apiKeyLength: number } {
  const testEnv = process.env.TEST_MODEL_ENV_FILE ?? resolve(root, '.env.test')
  assert.ok(existsSync(testEnv), `找不到测试端点配置 ${testEnv}（绝不回落 .env 的生产 key）`)
  config({ path: resolve(root, '.env'), override: false })
  config({ path: testEnv, override: true })
  const baseUrl = (process.env.OPENAI_BASE_URL ?? '').trim()
  const model = (process.env.OPENAI_LARGE_MODEL ?? '').trim()
  const apiKey = (process.env.OPENAI_API_KEY ?? '').trim()
  assert.ok(baseUrl !== '' && model !== '' && apiKey !== '', '测试端点配置缺 OPENAI_BASE_URL / OPENAI_LARGE_MODEL / OPENAI_API_KEY')
  return { baseUrlHost: new URL(baseUrl).host, model, apiKeyPresent: true, apiKeyLength: apiKey.length }
}

function loadManifest(): Manifest {
  assert.ok(existsSync(manifestPath), `找不到封存清单 ${manifestPath}（先跑 --seal）`)
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest
}

/** 封存后任何一份关键文件变了 ⇒ 拒绝执行。 */
function verifySeal(manifest: Manifest): void {
  const drift: string[] = []
  const compare = (name: string, sealedValue: string, currentValue: string) => { if (sealedValue !== currentValue) drift.push(`${name}: ${sealedValue} -> ${currentValue}`) }
  compare('protocol', manifest.protocol.sha256, fileDigest(protocolPath))
  compare('questions', manifest.questions.sha256, fileDigest(questionsPath))
  compare('scorer', manifest.scorer.sha256, fileDigest(scorerPath))
  compare('bed', manifest.bed.sha256, fileDigest(bedPath))
  compare('runner', manifest.runner.sha256, fileDigest(runnerPath))
  assert.equal(drift.length, 0, `封存后有文件变动，拒绝运行：${drift.join('; ')}`)
  const endpoint = endpointMetadata()
  assert.equal(endpoint.baseUrlHost, manifest.endpoint.baseUrlHost, '端点主机与封存不一致')
  assert.equal(endpoint.model, manifest.endpoint.model, '模型与封存不一致')
}

if (MODE === 'seal') {
  const endpoint = endpointMetadata()
  // ⚠️ **范围**：默认全部 18 个任务；`--scope zero` 只封存**零预算负控组**；
  //    `--scope diagnostic` 是**思考深度诊断**（预选题 × 两种请求变体）。
  const scopeIndex = process.argv.indexOf('--scope')
  const scope = scopeIndex >= 0 ? String(process.argv[scopeIndex + 1]) : 'all'
  assert.ok(scope === 'all' || scope === 'zero' || scope === 'normal' || scope === 'diagnostic', `未知范围 ${scope}`)
  // ⚠️ 诊断批次用**预选题目**（`--questions`）；题目清单本身不动。
  const questionsIndex = process.argv.indexOf('--questions')
  const questionFilter = questionsIndex >= 0
    ? String(process.argv[questionsIndex + 1]).split(',').map(id => id.trim()).filter(id => id !== '')
    : undefined
  if (questionFilter) {
    for (const id of questionFilter) assert.ok(questions.questions.some(question => question.id === id), `未知题目 ${id}`)
  }
  const selectedQuestions = questionFilter ? questions.questions.filter(question => questionFilter.includes(question.id)) : questions.questions
  const selectedControls: Control[] = scope === 'all' ? [...controls] : scope === 'normal' ? ['normal'] : ['zero']
  // ⚠️ `--variants` 让清单**固定**用哪个请求变体（`low` = 把思考深度固定为低）。
  //    不给就按范围取默认：诊断批次取 {default, low}，其它取 {default}。
  const variantsIndex = process.argv.indexOf('--variants')
  const variantFilter = variantsIndex >= 0
    ? String(process.argv[variantsIndex + 1]).split(',').map(item => item.trim()).filter(item => item !== '')
    : undefined
  if (variantFilter) {
    for (const item of variantFilter) assert.ok(item in variants, `未知变体 ${item}`)
  }
  const selectedVariants: Variant[] = variantFilter
    ? (variantFilter as Variant[])
    : scope === 'diagnostic' ? ['default', 'low'] : ['default']
  const tasks: TaskSpec[] = selectedQuestions.flatMap(question =>
    selectedControls.flatMap(control => selectedVariants.map(variant =>
      ({ id: `${question.id}:${control}:${variant}`, questionId: question.id, control, variant, questionSha256: question.sha256 }))))
  const evidenceDir = resolve('artifacts/cognitive/local/e2-page-question-20261023')
  const readDigest = (name: string) => {
    const path = resolve(evidenceDir, name)
    return existsSync(path) ? hash(readFileSync(path)) : 'MISSING'
  }
  const manifest: Manifest = {
    manifestVersion: 'document-qa-live@3',
    sealedAt: new Date().toISOString(),
    startMarker: hash(`${Date.now()}:${process.pid}:${questions.version}`),
    scope,
    protocol: { id: 'cognitive-evaluation@1', sha256: fileDigest(protocolPath) },
    questions: { id: questions.version, sha256: fileDigest(questionsPath), reviewStatus: questions.review.status },
    scorer: { id: 'document-answer@1', sha256: fileDigest(scorerPath) },
    bed: { sha256: fileDigest(bedPath) },
    runner: { sha256: fileDigest(runnerPath) },
    endpoint,
    request: {
      temperature: SEALED.temperature,
      maxTokens: SEALED.maxTokens,
      responseFormat: SEALED.responseFormat,
      systemPrompt: SEALED.systemPrompt,
      // ⚠️ 变体 → 请求参数（**只有**思考深度不同）。
      variants: Object.fromEntries(selectedVariants.map(variant => [variant, { reasoningEffort: variants[variant].reasoningEffort }])),
    },
    budget: {
      maxRequests: tasks.length * SEALED.budget.maxRequestsPerTask,
      maxOutputTokensPerRequest: SEALED.maxTokens,
      maxTotalOutputTokens: tasks.length * SEALED.maxTokens,
      maxWallClockMs: tasks.length * SEALED.budget.perTaskTimeoutMs,
      perTaskTimeoutMs: SEALED.budget.perTaskTimeoutMs,
    },
    tasks,
    identity: {
      sourceFingerprint: process.env.DOCUMENT_QA_SOURCE_FINGERPRINT ?? 'UNBOUND',
      imageDigest: process.env.DOCUMENT_QA_IMAGE_DIGEST ?? 'UNBOUND',
    },
    gateReadings: {
      documentQuestionGate: readDigest('document-question-gate.json'),
      fullCi: readDigest('ci-run.json'),
      preflight: readDigest('preflight.log'),
      postflight: readDigest('postflight.log'),
    },
    note: '本清单在**任何请求之前**写定；--case 模式会先核对以上摘要，变了就拒绝运行。请求参数一律取**清单里的值**，不取代码当前常量。',
  }
  mkdirSync(evidenceRoot, { recursive: true })
  /**
   * ⚠️ **fail-closed**：D5b 的清单里 `gateReadings` 四份全是 `MISSING`
   *    （暂存的门结果在镜像重建时随容器清空），清单因此**没有绑定门结果**。
   *    从此以后：**读了 MISSING 就拒绝封存** —— 宁可封存失败，也不留一份"看起来封好了"的空绑定。
   *    正确做法：封存前把门结果放进**当前这个容器**的同一路径。
   */
  const missing = Object.entries(manifest.gateReadings).filter(([, value]) => value === 'MISSING').map(([name]) => name)
  assert.equal(missing.length, 0, `gate_readings_missing:${missing.join(',')}（先把门结果放进当前容器的 artifacts/cognitive/local/e2-page-question-20261023）`)
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`sealed -> ${manifestPath}`)
  console.log(`scope=${scope} tasks=${String(tasks.length)} requests<=${String(manifest.budget.maxRequests)} maxTokens=${String(manifest.request.maxTokens)} model=${endpoint.model} host=${endpoint.baseUrlHost} key=present(length ${String(endpoint.apiKeyLength)})`)
  process.exit(0)
}

if (MODE === 'list') {
  // 场景清单的**唯一事实源 = 封存清单**。
  for (const task of loadManifest().tasks) console.log(task.id)
  process.exit(0)
}

/** case 模式：一个任务一次真实请求。 */
const manifest = loadManifest()
verifySeal(manifest)
const selected = process.argv[process.argv.indexOf('--case') + 1]
const task = manifest.tasks.find(entry => entry.id === selected)
assert.ok(task, `未知任务 ${String(selected)}`)
mkdirSync(evidenceRoot, { recursive: true })
if (!existsSync(jsonlPath)) writeFileSync(jsonlPath, '', 'utf8')

/** 已落盘的读数 ⇒ 序列级用量的真实累计（跨进程追加，不会互相覆盖）。 */
const spent = { requests: 0, outputTokens: 0, promptTokens: 0 }
for (const line of readFileSync(jsonlPath, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  const row = JSON.parse(line) as { status?: string; outputTokens?: number; promptTokens?: number }
  if (row.status === 'RUN' || row.status === 'FAILED') {
    spent.requests += 1
    spent.outputTokens += Number(row.outputTokens ?? 0)
    spent.promptTokens += Number(row.promptTokens ?? 0)
  }
}
const appendRow = (row: Record<string, unknown>) => {
  appendFileSync(jsonlPath, `${JSON.stringify(row)}\n`, 'utf8')
  const caseFile = resolve(evidenceRoot, `live-${task.id.replace(/[:.]/g, '-')}.json`)
  writeFileSync(caseFile, `${JSON.stringify(row, null, 2)}\n`, 'utf8')
}

const budgetReason = spent.requests >= manifest.budget.maxRequests ? '请求数上限'
  : spent.outputTokens + manifest.budget.maxOutputTokensPerRequest > manifest.budget.maxTotalOutputTokens ? '总输出 token 上限'
    : undefined
if (budgetReason !== undefined) {
  appendRow({ id: task.id, questionId: task.questionId, control: task.control, status: 'NOT_RUN', reason: budgetReason })
  console.log(`NOT_RUN ${task.id} (${budgetReason})`)
  process.exit(0)
}

const question = questions.questions.find(entry => entry.id === task.questionId)!
const bed = await createDocumentReadingBed(`live-${task.id.replace(':', '-')}`)
const taskStarted = Date.now()
let outputTokens = 0
let promptTokens = 0
let transmissions = 0
/** 诊断量：推理链长度（**只记长度，不记原文**）⇒ 空回复时能证明是不是推理吃光了预算。 */
let reasoningChars = 0
/** 诊断量：端点给的结束原因（官方文档：思考 token 吃满预算时是 `length`）。 */
let finishReason = 'none'
/** 诊断量：最终答案长度（字符数；**不能**据此换算 token）。 */
let answerChars = 0
try {
  const path = resolve(bed.root, question.file)
  const source = resolve(process.env.DOCUMENT_CORPUS_DIR ?? 'artifacts/local/document-corpus', question.file)
  assert.equal(hash(readFileSync(source)), question.sha256, '语料字节与题目清单不符')
  writeFileSync(path, readFileSync(source))
  const text = questionText(question, path)
  const result = await runDocumentQuestion(bed, {
    runId: `live-${task.id}-${Date.now()}`,
    text,
    control: task.control,
    async answer(packet) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), manifest.budget.perTaskTimeoutMs)
      const variant = manifest.request.variants[task.variant] ?? { reasoningEffort: null }
      try {
        // ⚠️ **发送尝试数在 fetch 之前计**（网络失败也算一次尝试）。
        transmissions += 1
        const response = await fetch(`${(process.env.OPENAI_BASE_URL ?? '').replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}` },
          body: JSON.stringify({
            model: manifest.endpoint.model,
            // ⚠️ 参数一律取**清单里的封存值**，不取代码当前常量。
            temperature: manifest.request.temperature,
            max_tokens: manifest.request.maxTokens,
            response_format: manifest.request.responseFormat,
            ...(variant.reasoningEffort === null ? {} : { reasoning_effort: variant.reasoningEffort }),
            messages: [{ role: 'system', content: manifest.request.systemPrompt }, { role: 'user', content: packet.text }],
          }),
          signal: controller.signal,
        })
        const body = await response.json() as {
          choices?: { finish_reason?: string; message?: { content?: string; reasoning_content?: string } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
          error?: { message?: string }
        }
        promptTokens = Number(body.usage?.prompt_tokens ?? 0)
        outputTokens = Number(body.usage?.completion_tokens ?? 0)
        reasoningChars = (body.choices?.[0]?.message?.reasoning_content ?? '').length
        finishReason = String(body.choices?.[0]?.finish_reason ?? 'none')
        const content = body.choices?.[0]?.message?.content ?? ''
        answerChars = content.length
        if (!response.ok) throw new Error(`http_${response.status}:${body.error?.message ?? 'unknown'}`)
        if (content.trim() === '') throw new Error(`empty_completion(finish_reason=${finishReason})`)
        return content
      } finally { clearTimeout(timer) }
    },
  })
  const scored = scoreDocumentAnswer(result.raw, question, result.visible)
  appendRow({
    id: task.id, questionId: task.questionId, control: task.control, variant: task.variant, status: 'RUN',
    latencyMs: Date.now() - taskStarted, transmissions, promptTokens, outputTokens, reasoningChars, finishReason, answerChars,
    schemaValid: scored.schemaValid, answerCorrect: scored.answerCorrect,
    contractConsistent: scored.contractConsistent ?? null, basis: scored.basis ?? null,
    sourceClaim: scored.sourceClaim, correctWithoutVisibleEvidence: scored.correctWithoutVisibleEvidence,
    fields: scored.fields ?? null,
    retrieved: result.report.retrieved, originalDelivered: result.report.originalDelivered,
    visibleBodyCount: result.report.visibleBodyCount, actionsUsed: result.report.actionsUsed,
    observerFailures: result.report.observerFailures, packetFingerprint: result.report.packetFingerprint,
  })
  console.log(`RUN ${task.id} correct=${String(scored.answerCorrect)} source=${scored.sourceClaim} withoutEvidence=${String(scored.correctWithoutVisibleEvidence)}`)
} catch (error) {
  // ⚠️ 协议 §5：**不自动重试**。失败即该任务结果，并计入实际调用。
  appendRow({ id: task.id, questionId: task.questionId, control: task.control, variant: task.variant, status: 'FAILED',
    error: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - taskStarted,
    transmissions, promptTokens, outputTokens, reasoningChars, finishReason, answerChars })
  console.log(`FAILED ${task.id}: ${error instanceof Error ? error.message : String(error)}`)
} finally { await bed.stop() }
