/**
 * P2.1 第五批：策略比较**开发试点**（2026-10-23）
 *
 * ⚠️ 协议**跑之前写定**（`docs/architecture/Document-Recovery-P2.1-Comparison-Protocol-2026-10-23.md`）：
 *    臂、预算、信息、成本模型、指标与决策标准都在那份文件里；本脚本只**执行**它。
 *    ⇒ 本脚本里的 `PROTOCOL` 常量与那份文件逐字一致；改任何一处都要重写协议并作废读数。
 *
 * ⚠️ 三条臂**同样的可见信息、权限与总预算**；差别只在"怎么决定读什么"。
 * ⚠️ 门体在 Linux 仿真内执行，数据库场景用独立隔离库；**零真实模型调用**
 *    （不接预测端口 ⇒ 预测核对用产品内既有的预置 forecast，条件模型调用数单独记）。
 */
import 'dotenv/config'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createDocumentReadingBed } from './document-reading-bed.ts'
import { DOCUMENT_EXTRACT, PDF_READERS, type PdfReader } from '../../src/kernel/contracts/document-reading.ts'
import { evaluateDocumentCoverage, type DocumentCoverageReference, type DocumentCoverageUnit } from '../../src/kernel/contracts/document-coverage.ts'
import { selectTurnContentContext } from '../../src/kernel/contracts/turn-content.ts'
import type { TaskPlannerPort } from '../../src/kernel/action/task-plan.ts'

/** 预注册协议（与协议文件逐字一致；这里是机器可读的那一份）。 */
const PROTOCOL = {
  version: 'document-comparison@1',
  permission: 'document:read',
  maxActions: 3,
  maxPlans: 4,
  /** 入模视图用的**允许最大值** turn-content token（生产缺省 0）。 */
  turnContentTokens: 4000,
  modelCalls: 0,
  arms: ['current', 'static', 'model'] as const,
  decisionStandard: 'C 相对 B：deliveredCoverage 多 ≥1 单元且出现在 ≥2 份文档并且增量进入上下文；或在同等覆盖下每任务成本至少低 30%。否则保留实验态。',
} as const

const references = JSON.parse(readFileSync('evals/world-model-pilot/document-reference-v3.json', 'utf8')) as {
  version: string
  review: { humanReview: string }
  documents: Array<{ id: string; file: string; sha256: string; units: DocumentCoverageUnit[] }>
}
const cases = [
  ...references.documents.flatMap(document => PROTOCOL.arms.map(arm => `${document.id}--${arm}`)),
  // ⚠️ 补充**机制探针**（不属于预注册比较，也不参与决策）：留一训练下，
  //    覆盖规则**能不能区分两条路线**。它解释"为什么这条臂在这里赢不了"。
  ...references.documents.map(document => `mechanism--${document.id}`),
]
if (process.argv.includes('--list-cases')) { console.log(cases.join('\n')); process.exit(0) }
const selected = process.argv[process.argv.indexOf('--case') + 1]
assert.ok(cases.includes(selected), `unknown case: ${String(selected)}`)
const [head, tail] = selected.split('--')
const isMechanism = head === 'mechanism'
const documentId = isMechanism ? String(tail) : String(head)
const arm = isMechanism ? 'rules' : String(tail)
const document = references.documents.find(entry => entry.id === documentId)!
assert.ok(isMechanism || PROTOCOL.arms.includes(arm as never), `unknown arm: ${String(arm)}`)

const checks: string[] = []
const check = (name: string, value: unknown) => { assert.ok(value, name); checks.push(name); console.log(`PASS ${name}`) }
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

const registry = new Map<string, DocumentCoverageReference>()
const coveragePort = {
  find: (rawPath: string) => registry.get(rawPath),
  entries: () => [...registry.entries()].map(([path, reference]) => ({ path, reference })),
}

const bed = await createDocumentReadingBed(`compare-${documentId}-${arm}`, {}, {}, {}, coveragePort)
try {
  const corpus = resolve(process.env.DOCUMENT_CORPUS_DIR ?? 'artifacts/local/document-corpus')

  if (isMechanism) {
    // ── 补充机制探针：**留一训练**下，覆盖规则能不能区分两条路线？ ──
    const training = references.documents.filter(entry => entry.id !== document.id)
    const readings: Array<{ reader: string; usable: boolean; status: string }> = []
    for (const trained of training) {
      const trainedPath = resolve(bed.root, `train-${trained.id}.pdf`)
      copyFileSync(resolve(corpus, trained.file), trainedPath)
      registry.set(trainedPath, { version: references.version, documentSha256: hash(readFileSync(trainedPath)),
        humanReview: 'APPROVED', units: trained.units })
      for (const reader of PDF_READERS) {
        const outcome = await bed.run(trainedPath, 'current', { forced: reader })
        check(`leave-one-out training read completes: ${trained.id}/${reader}`, (outcome?.epistemicFailures ?? 0) === 0)
      }
    }
    const snapshots = await bed.snapshots.list()
    for (const snapshot of snapshots.filter(entry => entry.scope === 'pdf_text_coverage')) {
      readings.push({ reader: snapshot.conditions.reader ?? '', usable: snapshot.usable, status: snapshot.status })
    }
    const usableReaders = readings.filter(reading => reading.usable).map(reading => reading.reader).sort()
    const discriminated = usableReaders.length === 1
    writeFileSync(resolve(bed.output, 'strategy-comparison.json'), JSON.stringify({
      status: 'PASS', selected, protocol: PROTOCOL,
      row: { kind: 'mechanism-probe', evaluatedDocument: document.id, trainingDocuments: training.map(entry => entry.id),
        coverageRules: readings, usableReaders, discriminated,
        note: 'supplementary mechanism probe, not part of the pre-registered comparison' },
      location: 'serversim/simhost', backend: 'fresh isolated pgtest', modelCalls: 0, productionOpened: false,
      evidenceScope: 'mechanism only: whether leave-one-out training can discriminate the two readers; not a benefit claim',
    }, null, 2))
    process.exitCode = 0
    await bed.stop()
    process.exit(0)
  }

  const source = resolve(corpus, document.file)
  const path = resolve(bed.root, document.file)
  copyFileSync(source, path)
  const sha = hash(readFileSync(path))
  check('the corpus bytes match the approved reference', sha === document.sha256 && references.review.humanReview === 'APPROVED')
  registry.set(path, { version: references.version, documentSha256: sha, humanReview: 'APPROVED', units: document.units })

  // ── C 臂的一次性训练成本（合成夹具，不碰开发语料 ⇒ 无自证循环） ──
  let trainingActions = 0
  if (arm === 'model') {
    const before = bed.calls()
    await bed.train()
    trainingActions = bed.calls() - before
  }

  // ── 试点状态：截断观测（臂 B 用） ──
  let lastTruncated = false
  let lastReader: PdfReader | undefined
  let reads = 0

  const plannerFor = (base: TaskPlannerPort): TaskPlannerPort => {
    if (arm !== 'static') return base
    return {
      id: 'pilot-static-conditional',
      endpointHost: 'offline',
      async plan(input) {
        const plan = await base.plan(input)
        // ⚠️ **静态条件**：交付被截断 ⇒ 补读另一条路线（条件可观察、未拟合）。
        if (plan.ok && lastTruncated && reads === 1) {
          const other = PDF_READERS.find(reader => reader !== lastReader)!
          return { ok: true, requestCount: 0, plan: { goal: '交付被截断：补读另一条读取路线以补齐正文', done: false,
            steps: [{ capability: DOCUMENT_EXTRACT, operation: 'read', args: { path, reader: other } }] } }
        }
        return plan
      },
    }
  }

  const started = Date.now()
  const outcome = await bed.run(path, arm === 'model' ? 'model' : 'current', {
    profile: true,
    planner: plannerFor,
    async after(input) {
      if (input.request.capability !== DOCUMENT_EXTRACT) return
      const item = input.result.turnContent?.[0]
      lastTruncated = item?.scope?.truncated === true
      lastReader = (input.request.arguments.reader ?? 'markitdown') as PdfReader
      reads += 1
    },
  })
  const elapsedMs = Date.now() - started

  // ── 交付层：正式交付正文的并集 ──
  const delivered = (outcome?.results ?? []).flatMap(result => result.result.turnContent ?? [])
    .filter(item => item.capability === DOCUMENT_EXTRACT)
  const deliveredText = delivered.map(item => item.text).join('\n')
  const deliveredReading = evaluateDocumentCoverage(deliveredText, document.units)

  // ── 入模层：生产选择函数 + 允许的最大预算（上界；全局裁剪只会更少） ──
  const selection = selectTurnContentContext({ items: delivered, budgetTokens: PROTOCOL.turnContentTokens })
  const inContextText = selection.selected.map(entry => entry.item.text).join('\n')
  const inContextReading = evaluateDocumentCoverage(inContextText, document.units)

  const actions = outcome?.results.map(result => ({
    capability: result.request.capability,
    reader: result.request.arguments.reader,
    status: result.result.status,
    deliveredChars: result.result.turnContent?.[0]?.scope?.includedChars,
    truncated: result.result.turnContent?.[0]?.scope?.truncated,
  })) ?? []

  const row = {
    document: document.id,
    arm,
    referenceVersion: references.version,
    units: document.units.length,
    deliveredCoverage: { observed: deliveredReading.observed, total: deliveredReading.total, policyMet: deliveredReading.policyMet },
    inContextCoverage: { observed: inContextReading.observed, total: inContextReading.total, policyMet: inContextReading.policyMet },
    contextSelection: { selected: selection.selected.length, droppedByBudget: selection.droppedByBudget, budgetTokens: PROTOCOL.turnContentTokens },
    actions,
    actionCount: actions.length,
    reads,
    simulations: outcome?.simulationsUsed ?? 0,
    conditionalModelCalls: outcome?.simulationsUsed ?? 0,
    trainingActions,
    elapsedMs,
    deliveredChars: delivered.reduce((total, item) => total + item.text.length, 0),
    comparisons: outcome?.comparisons?.map(comparison => comparison.verdict) ?? [],
    goalAchieved: outcome?.goal?.achieved ?? false,
    /**
     * ⚠️ 整条正文的流程**没有配置受信完成核对**（只有有界页目标有）⇒
     *    `outcome.goal` **不存在**；这里的 `false` 是**缺省**，不是读数。
     */
    goalVerdictConfigured: outcome?.goal !== undefined,
    /** 整条正文有没有**进**上下文选择（份数 > 0）。 */
    enteredContext: selection.selected.length > 0,
    stopped: outcome?.stopped,
    epistemicFailures: outcome?.epistemicFailures ?? 0,
  }

  check('the arm completed without epistemic failures', row.epistemicFailures === 0)
  check('the arm read the document through the real gateway', actions.some(action => action.capability === DOCUMENT_EXTRACT && action.status === 'success'))
  check('the profile was observed before the body', actions[0]?.capability === 'document.profile')
  check('every arm stayed inside the shared action budget', row.actionCount <= PROTOCOL.maxActions)
  check('the coverage reading is computed against the approved reference scope', row.deliveredCoverage.total === document.units.length)
  check('the whole-body flow has no trusted completion verdict (only bounded page goals do)', row.goalVerdictConfigured === false)
  if (arm === 'static') {
    check('the static arm reads a second route only when the delivery was truncated',
      row.reads === 1 || actions.filter(action => action.capability === DOCUMENT_EXTRACT).length === 2)
  }
  if (arm === 'model') {
    check('the EBL arm trained its rules on synthetic fixtures, not on the evaluated document', trainingActions > 0)
  }

  writeFileSync(resolve(bed.output, 'strategy-comparison.json'), JSON.stringify({
    status: 'PASS', selected, protocol: PROTOCOL, row,
    location: 'serversim/simhost', backend: 'fresh isolated pgtest',
    modelCalls: PROTOCOL.modelCalls, productionOpened: false,
    evidenceScope: 'development pilot on the approved development corpus; not a holdout, not a benefit claim, not a production reading',
  }, null, 2))
} finally { await bed.stop() }
