/**
 * M6.1 —— **候选冻结件**（用户 2026-09-23 正式复验工作单第 1 项）。
 *
 * ============================================================================
 *  它固定什么
 * ============================================================================
 * 「正式复验里那个**做判断的东西**到底是哪一个」必须可复算、可核对：
 *
 * ```text
 *   代码提交         HEAD 全 sha + 工作树对这些文件是否干净
 *   契约 / 语料 / 量具 版本号
 *   提示             promptVersion + **探针口径的正文摘要**
 *   模型与端点       judge id / host / model
 *   预算             maxTokens
 *   推理档位         reasoningEffort
 *   解析与聚合规则    contract / instrument / judge 适配器 / 跨轮核心 **四个文件的逐字摘要**
 *   判定阈值         INSTRUMENT_VALIDITY_CRITERIA 的逐字段摘要
 * ```
 *
 * ⚠️ **纪律（写死在代码里）**：
 * ```text
 *   ① 上述任一文件有**未提交改动** ⇒ 判决 `UNFROZEN` 并退出非零：
 *      "固定代码提交"在脏树上无法成立（读到的字节不属于任何提交）。
 *   ② `candidateId` 由上面全部字段的规范串算出 ⇒ 改一个字就换 id。
 *      正式运行中任何影响判定的变更都**必须另立候选**，不能把变更前后两轮拼成验收。
 *   ③ 本脚本**不碰**验收语料、**不调用**模型 —— 它只描述判定器，不试判。
 *   ④ 运行配置（命令集 / 语料选择）**不在**这里冻结：按工作单第 3 项，
 *      先完成接线与离线自证，再单独冻结（见 `--phase run-config`）。
 * ```
 *
 * 用法：
 * ```bash
 * pnpm m6.1:freeze:candidate        # 冻结候选（工作树必须干净）
 * ```
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { MeasurementInvalidError } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  M6_1_CONTRACT_VERSION,
  M6_1_CORPUS_VERSION,
  M6_1_INSTRUMENT_VERSION,
} from './m6.1-contract.ts'
import {
  ACCEPTANCE_MANIFEST_PATH,
  CORPUS_FILES,
  M6_1_ACCEPTANCE_VERSION,
} from './m6.1-acceptance-corpus.ts'
import { sha256OfText } from './m6.1-evidence.ts'
import { M6_1_JUDGE_PROMPT_VERSION } from './m6.1-instrument.ts'
import { probePromptDigest } from './m6.1-cross-run-core.ts'
import {
  M6_1_INSTRUMENT_JUDGE_ID,
  M6_1_JUDGE_MAX_TOKENS,
  M6_1_JUDGE_REASONING_EFFORT,
  createOpenAiInstrumentJudge,
} from './m6.1-judge-openai.ts'
import { INSTRUMENT_VALIDITY_CRITERIA, itemsFromCorpus } from './m6.1-instrument.ts'

const ROOT = resolve(process.cwd())
const EVAL_DIR = join(ROOT, 'artifacts', 'm6.1')

/**
 * `--out <相对路径>`：写到哪里。
 *
 * ⚠️ 允许换输出路径是刻意的：**冻结件不是"最新一份覆盖旧的"**。
 * 接线（工作单第 3 项）会改 live 驱动 ⇒ 必须**再取一份**，并当面比对
 * "哪几个文件的字节变了、判定规则那四个有没有变" —— 两份都留在磁盘上。
 *
 * ⚠️ **缺省路径必须按相位分**。实测事故（2026-09-23）：缺省只有一个
 *    `candidate-freeze.json`，于是 `--phase run-config` 不加 `--out` 时，
 *    它把**候选冻结件覆盖成了运行配置冻结件** —— 与上面那句"不是最新一份覆盖旧的"
 *    正好相反；覆盖之后磁盘上再也读不到那份候选，只能去 git 里捞。
 *    两个相位各有各的文件名，缺省值不许再合流。
 */
function parseOut(argv: readonly string[], phase: Phase): string {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--out') continue
    const value = argv[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw new Error(`--out 后面必须是一个路径（收到 ${String(value)}）`)
    }
    return value
  }
  return join('artifacts', 'm6.1', PHASE_DEFAULT_FILE[phase])
}

type Phase = 'candidate' | 'run-config'

/** 两个相位各自的 schemaVersion 与缺省文件名 —— 一处声明，两处共用。 */
const PHASE_SCHEMA: Record<Phase, string> = {
  candidate: 'm6.1-candidate-freeze@1',
  'run-config': 'm6.1-run-config-freeze@1',
}
const PHASE_DEFAULT_FILE: Record<Phase, string> = {
  candidate: 'candidate-freeze.json',
  'run-config': 'run-config-freeze.json',
}

/**
 * 写盘前的**跨相位覆盖护栏**（失败关闭）。
 *
 * 光把缺省路径分开还不够：显式 `--out` 仍然可以把一个相位的件写到另一个相位的文件名上。
 * 目标文件里的 `schemaVersion` **自带相位**，所以这里直接读它 —— 相位不符就拒绝写。
 *
 * ⚠️ 这条护栏是**事故换来**的（2026-09-23）：运行配置冻结件写进候选件的路径，
 *    候选被覆盖，且当时没有任何提示。
 */
function assertPhaseMatchesTarget(outPath: string, phase: Phase): void {
  if (!existsSync(outPath)) return
  let existing: { schemaVersion?: string }
  try {
    existing = JSON.parse(readFileSync(outPath, 'utf8')) as { schemaVersion?: string }
  } catch {
    throw new MeasurementInvalidError(
      `目标 ${relative(ROOT, outPath)} 已存在但不是合法 JSON ⇒ 拒绝覆盖（那可能是一份被手工改坏的证据）`
    )
  }
  const known = Object.values(PHASE_SCHEMA)
  if (
    existing.schemaVersion !== undefined &&
    known.includes(existing.schemaVersion) &&
    existing.schemaVersion !== PHASE_SCHEMA[phase]
  ) {
    throw new MeasurementInvalidError(
      `目标 ${relative(ROOT, outPath)} 里已经装着**另一个相位**的冻结件（${existing.schemaVersion}）；` +
        `本次要写的是 ${PHASE_SCHEMA[phase]} ⇒ 拒绝覆盖。` +
        '两个相位各有各的缺省文件名（candidate-freeze.json / run-config-freeze.json）—— ' +
        '把运行配置写进候选件的路径会把那份候选**从磁盘上抹掉**（2026-09-23 真实发生过）。'
    )
  }
}

/**
 * **判定链路上**的文件 —— 它们的字节就是"解析与聚合规则"。
 *
 * ⚠️ 刻意**包含** live 驱动（`m6.1-instrument-live.ts`）：它决定"一条读数怎么形成"。
 * ⚠️ 刻意**不包含**诊断工具（breakdown / replay / budget-probe / 语料构装器）：
 *    它们不参与正式读数。将来若有人把判定逻辑搬进其中之一，这个清单要跟着改 ——
 *    所以它本身也进 `candidateId`。
 */
const JUDGING_FILES = [
  'scripts/m6.1-contract.ts',
  'scripts/m6.1-instrument.ts',
  'scripts/m6.1-judge-openai.ts',
  'scripts/m6.1-cross-run-core.ts',
  'scripts/m6.1-instrument-live.ts',
  /*
   * M6.1 WP5 / 用户裁定 A（2026-09-25）：判定器的 `actualContext`（"她当轮实际看到的"）
   * 由这个文件产出 ⇒ 它是**判定链路的一部分**，必须进"判定链路未提交就不能冻结"这张清单，
   * 也必须进 `candidateId`（换证据来源 = 换候选）。
   */
  'scripts/m6.1-turn-context.ts',
] as const

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd: ROOT, encoding: 'utf8' }).trim()
}

/*
 * ⚠️ **必须先把测试端点叠上来再算 host/model**（实测踩到的坑）。
 *
 * 正式读数是经 `pnpm with-test-model pnpm m6.1:instrument:live` 跑的，而本脚本**不调模型**，
 * 所以它默认看到的是 `.env` 里的**生产端点** —— 第一版就把 `host=api.deepseek.com`
 * 记进了冻结件，而正式运行实际走的是测试端点 `r.dis.115.zone`。
 * **冻结件记错了端点 = "固定模型与端点"这一条根本没固定。**
 *
 * 这里复刻包装器的叠加规则（`.env` 打底 → `.env.test` 覆盖），
 * 并且**缺失 `.env.test` 就失败关闭** —— 否则冻结件描述的是另一套端点。
 * 仍然**不打印 key**，只用适配器暴露的 host/model。
 */
function loadTestEndpointEnv(options: { readonly routeFromProcessEnv: boolean }): Record<string, string | undefined> {
  const base = join(ROOT, '.env')
  const test = join(ROOT, '.env.test')
  const env: Record<string, string | undefined> = { ...process.env }
  /*
   * 显式注入的端点（见调用点注释）：这些键**不被 .env.test 覆盖**，因为实际读数就是用它们跑的。
   * 失败关闭：开关打开却缺键 ⇒ 拒绝（不许"以为在记注入的端点，其实记的是 .env.test 的"）。
   */
  const ROUTE_KEYS = ['OPENAI_BASE_URL', 'OPENAI_SMALL_MODEL', 'OPENAI_MODEL'] as const
  const injectedRoute: Record<string, string | undefined> = {}
  if (options.routeFromProcessEnv) {
    const missing = ROUTE_KEYS.filter((key) => (process.env[key] ?? '').trim() === '')
    if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') {
      throw new MeasurementInvalidError(
        'UNFROZEN：--route-from-process-env 只允许在 `DSH_TEST_MODEL_WRAPPER=1` 下使用' +
          '（那是"经包装器/显式注入"的标记；否则无法证明这套端点是实际用的那一套）'
      )
    }
    const hasEndpoint = (process.env.OPENAI_BASE_URL ?? '').trim() !== ''
    const hasModel = (process.env.OPENAI_SMALL_MODEL ?? process.env.OPENAI_MODEL ?? '').trim() !== ''
    if (!hasEndpoint || !hasModel) {
      throw new MeasurementInvalidError(
        `UNFROZEN：--route-from-process-env 要求进程环境里同时有端点与模型` +
          `（缺：${missing.join('、') || '(无)'}）⇒ 不许记一个"猜的"端点`
      )
    }
    for (const key of ROUTE_KEYS) {
      const value = process.env[key]
      if (value !== undefined && value.trim() !== '') injectedRoute[key] = value
    }
  }
  for (const [path, override] of [
    [base, false],
    [test, true],
  ] as const) {
    if (!existsSync(path)) {
      if (path === test) {
        throw new MeasurementInvalidError(
          'UNFROZEN：缺 .env.test ⇒ 无法确定正式运行会用哪个端点；' +
            '冻结件不许记一个"猜的"端点（工作单第 1 项要求固定模型与端点）'
        )
      }
      continue
    }
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '' || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      const key = trimmed.slice(0, eq).trim()
      let value = trimmed.slice(eq + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      /* 显式注入的路由键：**任何** .env 层都不许覆盖它 */
      if (key in injectedRoute) continue
      if (override || env[key] === undefined) env[key] = value
    }
  }
  return env
}

/**
 * **运行配置冻结**（工作单第 3 项末尾：接线与离线自证之后再冻结运行配置）。
 *
 * 它把"正式复验到底跑哪条命令、读哪套语料"钉死，并**绑定**到候选冻结件上。
 * ```text
 *   命令集        两条同配置验收 + 只读汇总门
 *   语料选择      --corpus acceptance（分母就是它，不许截取）
 *   语料摘要      验收语料正文的 sha256（必须与它自己 manifest 记的一致）
 *   候选 id       从 candidate-freeze.json 读，且必须与**当前树**算出的 id 相同
 * ```
 * ⚠️ 最后那一条是关键：如果树在"冻结候选"之后又变了，运行配置就绑在一个**不存在的**
 * 候选上 ⇒ 失败关闭。这正是"变更前后两轮不能拼成验收"的机器版本。
 */
function writeRunConfigFreeze(startedAt: string, outPath: string): void {
  const candidatePath = join(EVAL_DIR, 'candidate-freeze.json')
  if (!existsSync(candidatePath)) {
    throw new MeasurementInvalidError(
      `UNFROZEN：缺候选冻结件 ${relative(ROOT, candidatePath)} ⇒ 运行配置无从绑定`
    )
  }
  const candidate = JSON.parse(readFileSync(candidatePath, 'utf8')) as {
    candidateId?: string
    parsingAndAggregation?: { files?: { path: string; sha256: string }[] }
  }
  const recorded = candidate.candidateId
  if (recorded === undefined) {
    throw new MeasurementInvalidError('UNFROZEN：候选冻结件里没有 candidateId')
  }

  /*
   * 用**当前树**重算候选 id 的输入部分，逐项比对 —— 树若在冻结之后变过，
   * 这里就会不一致，运行配置拒绝写盘。
   */
  const currentFiles = (candidate.parsingAndAggregation?.files ?? []).map((entry) => {
    const abs = join(ROOT, entry.path)
    if (!existsSync(abs)) {
      throw new MeasurementInvalidError(`MEASUREMENT INVALID：判定链路文件缺失 ${entry.path}`)
    }
    return { path: entry.path, sha256: sha256OfText(readFileSync(abs, 'utf8')) }
  })
  const changed = currentFiles.filter((entry) => {
    const stored = candidate.parsingAndAggregation?.files?.find((f) => f.path === entry.path)
    return stored === undefined || stored.sha256 !== entry.sha256
  })
  if (changed.length > 0) {
    throw new MeasurementInvalidError(
      `UNFROZEN：候选冻结之后判定链路有 ${String(changed.length)} 个文件变了` +
        `（${changed.map((c) => c.path).join('、')}）⇒ 运行配置绑在一个不存在的候选上，拒绝写盘；` +
        '请先重取候选冻结件。'
    )
  }

  const acceptanceManifestPath = join(ROOT, ACCEPTANCE_MANIFEST_PATH)
  if (!existsSync(acceptanceManifestPath)) {
    throw new MeasurementInvalidError('UNFROZEN：缺验收语料清单 ⇒ 运行配置无从绑定语料')
  }
  const acceptanceManifest = JSON.parse(readFileSync(acceptanceManifestPath, 'utf8')) as {
    digests?: { jsonl?: string }
    reviewStatus?: string
    counts?: { items?: number }
  }
  const acceptanceFile = join(ROOT, CORPUS_FILES.acceptance[0] as string)
  const acceptanceDigest = sha256OfText(readFileSync(acceptanceFile, 'utf8'))
  if (acceptanceDigest !== acceptanceManifest.digests?.jsonl) {
    throw new MeasurementInvalidError(
      'UNFROZEN：验收语料正文与清单摘要不一致 ⇒ 运行配置不许绑到一个被改过的语料上'
    )
  }

  const commands = [
    'pnpm with-test-model pnpm m6.1:instrument:live -- --corpus acceptance   # 第 1 轮',
    'pnpm with-test-model pnpm m6.1:instrument:live -- --corpus acceptance   # 第 2 轮（同配置）',
    'pnpm m6.1:cross-run:verify',
    'pnpm m6.1:gates',
    'pnpm m6.1:failures',
    'pnpm m6.1:wp0:baseline',
  ]
  const evidence = {
    schemaVersion: 'm6.1-run-config-freeze@1',
    testId: 'M6.1 正式复验的运行配置冻结件（工作单第 3 项）',
    phase: 'run-config',
    startedAt,
    candidateId: recorded,
    candidateRefresh: {
      checkedFiles: currentFiles.length,
      changedFiles: changed.map((entry) => entry.path),
      note: '与 candidate-freeze.json 的逐文件摘要比对通过（否则本件不写盘）。',
    },
    corpus: {
      name: 'acceptance',
      version: M6_1_ACCEPTANCE_VERSION,
      file: CORPUS_FILES.acceptance[0],
      sha256: acceptanceDigest,
      items: acceptanceManifest.counts?.items ?? null,
      reviewStatus: acceptanceManifest.reviewStatus ?? null,
    },
    commands,
    roundPlan: {
      rounds: 2,
      sameConfig: true,
      note:
        '两轮之间**不得**改任何影响判定的东西（提示 / 模型 / 端点 / 预算 / 推理档 / 契约 / 语料 /' +
        '判定规则）。若第 1 轮触发预先定义的硬失败，可以停跑第 2 轮并登记原因 ——' +
        '但**不许**改参数之后仍称"第二轮同配置验收"。',
    },
    reporting: {
      schema:
        '两轮各自列出覆盖率 / 召回 / 误报 / 失败原因 / CD-8；CD-9 独立报告；**不取平均掩盖某轮失败**。',
      attribution: '新 heldout 单独出分母；旧语料只作回归另报；两者不得混合后靠总分通过。',
    },
    gates: {
      note: '已冻结的三项 0.90 覆盖率门、错误率门与类别控制要求**保持不动**。',
      criteria: INSTRUMENT_VALIDITY_CRITERIA,
    },
    preconditions: {
      humanReviewRequired: '验收语料的人工审核必须先完成（当前 manifest 状态见 corpus.reviewStatus）。',
      noTuningAfterReview:
        '用于后续调参的留出样本应登记为**已暴露**；后续确认仍需未参与调整的样本。',
    },
    finishedAt: new Date().toISOString(),
  }
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  console.log('='.repeat(78))
  console.log('M6.1 运行配置冻结件')
  console.log('='.repeat(78))
  console.log(`  绑定候选      ${recorded.slice(0, 12)}…（逐文件复核 ${String(currentFiles.length)} 个，变动 0）`)
  console.log(`  语料          ${String(CORPUS_FILES.acceptance[0])} · ${String(evidence.corpus.items)} 条`)
  console.log(`  语料摘要      ${acceptanceDigest.slice(0, 12)}…`)
  console.log(`  审核状态      ${String(evidence.corpus.reviewStatus)}`)
  console.log(`  命令集        ${String(commands.length)} 条（两条同配置验收 + 汇总/回归）`)
  console.log(`\n证据：${relative(ROOT, outPath).split(/[\\/]/).join('/')}`)
  console.log('\n⚠️ 审核未完成时**不得**执行这两轮。')
}

function main(): void {
  const startedAt = new Date().toISOString()
  const argv = process.argv.slice(2)
  /*
   * ⚠️ **先解析 phase，再解析 `--out`** —— 因为缺省文件名由相位决定。
   * 顺序反了就会退回"两个相位共用一个缺省路径"的老毛病。
   */
  const phase: Phase = argv.includes('--phase')
    ? ((argv[argv.indexOf('--phase') + 1] ?? 'candidate') as Phase)
    : 'candidate'
  if (phase !== 'candidate' && phase !== 'run-config') {
    throw new Error(`--phase 只能是 candidate / run-config（收到 ${String(phase)}）`)
  }
  const routeFromProcessEnv = argv.includes('--route-from-process-env')
  const outPath = resolve(ROOT, parseOut(argv, phase))
  assertPhaseMatchesTarget(outPath, phase)
  if (phase === 'run-config') {
    writeRunConfigFreeze(startedAt, outPath)
    return
  }
  const head = git(['rev-parse', 'HEAD'])
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])

  /*
   * ---- ① 脏树检查（失败关闭）----
   * 只看**判定链路**上的文件：其它文件（文档、诊断工具、别的里程碑的产物）脏了不影响
   * "这次读数用的是哪一版判定器"，但必须**如实报出来**，不能假装树是干净的。
   */
  const dirtyOutput = git(['status', '--porcelain', '--', ...JUDGING_FILES])
  const dirtyJudgingFiles = dirtyOutput
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => line.replace(/^\S+\s+/, ''))
  if (dirtyJudgingFiles.length > 0) {
    throw new MeasurementInvalidError(
      `UNFROZEN：判定链路上有 ${String(dirtyJudgingFiles.length)} 个文件**未提交**` +
        `（${dirtyJudgingFiles.join('、')}）⇒ "固定代码提交"在脏树上不能成立，拒绝冻结`
    )
  }
  const dirtyOthers = git(['status', '--porcelain'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

  /*
   * ---- ② 逐字摘要（measured_count 必须 > 0）----
   */
  const fileHashes = JUDGING_FILES.map((rel) => {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) {
      throw new MeasurementInvalidError(`MEASUREMENT INVALID：判定链路上的文件缺失 ${rel}`)
    }
    return { path: rel, sha256: sha256OfText(readFileSync(abs, 'utf8')) }
  })
  if (fileHashes.length === 0) {
    throw new MeasurementInvalidError(
      'MEASUREMENT INVALID：一个文件都没哈希（"检查了 0 个"与"全都一致"长得一样）'
    )
  }

  /*
   * ---- ③ 提示正文摘要（探针口径）----
   * 正式读数比的是探针项，所以指纹也只折探针集（见 probePromptDigest 的注释）。
   */
  const probeRows: unknown[] = []
  const probePath = join(ROOT, 'evals', 'm6.1', 'probes', 'stability-probe.jsonl')
  if (!existsSync(probePath)) {
    throw new MeasurementInvalidError(`MEASUREMENT INVALID：缺探针集 ${probePath}`)
  }
  for (const line of readFileSync(probePath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    probeRows.push(JSON.parse(line))
  }
  const probeItems = itemsFromCorpus(probeRows)
  const promptDigest = probePromptDigest(probeItems)

  /*
   * ---- ④ 模型与端点 ----
   * ⚠️ 用**叠加过测试端点**的 env（见 loadTestEndpointEnv 的注释）：正式读数走包装器，
   *    冻结件必须记包装器之下的那套端点，否则"固定模型与端点"是假的。
   *
   * ⚠️ 2026-09-25 追加（用户裁定 A/C 落地时暴露的缺口）：
   *    有一类正式读数**不经 `.env.test`**，而是把端点**显式注入进程环境**
   *    （`DSH_TEST_MODEL_WRAPPER=1` + `OPENAI_BASE_URL/OPENAI_SMALL_MODEL`，
   *     见 M6.1 WP5 的四轮与 `judge-prompt@5` 的有效性复验）。
   *    那时 `.env.test` 的端点**不是**实际端点 ⇒ 旧行为会把**没跑过的端点**记进冻结件。
   *    `--route-from-process-env` 让这种情况**如实记实际端点**，并把依据记在 `routeSource` 里；
   *    不传该开关时行为与从前**逐字相同**（记 `.env.test` 叠加后的端点）。
   */
  const runEnv = loadTestEndpointEnv({ routeFromProcessEnv })
  const judgeProbe = createOpenAiInstrumentJudge({
    model: runEnv.OPENAI_SMALL_MODEL ?? runEnv.OPENAI_MODEL,
    env: runEnv,
  })

  const criteria = INSTRUMENT_VALIDITY_CRITERIA

  const descriptor = {
    schemaVersion: 'm6.1-candidate-freeze@1',
    testId: 'M6.1 正式复验前的候选冻结件（只描述判定器；不碰验收语料、不调用模型）',
    phase: 'candidate',
    startedAt,
    code: { head, branch },
    versions: {
      contract: M6_1_CONTRACT_VERSION,
      corpus: M6_1_CORPUS_VERSION,
      instrument: M6_1_INSTRUMENT_VERSION,
      prompt: M6_1_JUDGE_PROMPT_VERSION,
    },
    prompt: {
      digest: promptDigest,
      scope: 'probes-only（正式读数比的是探针项；语料条目换不换不影响该指纹）',
      probeItems: probeItems.length,
    },
    judge: {
      id: M6_1_INSTRUMENT_JUDGE_ID,
      host: judgeProbe.baseUrlHost,
      model: judgeProbe.model,
      reasoningEffort: M6_1_JUDGE_REASONING_EFFORT,
      maxTokens: M6_1_JUDGE_MAX_TOKENS,
      /*
       * ⚠️ **端点是从哪来的**必须记（2026-09-25 缺口）：两条来源记出来的端点可能完全不同，
       *    不记来源就没法判断"冻结件固定的是不是正式读数用的那一套"。
       */
      routeSource: routeFromProcessEnv
        ? 'process-env-explicit（`DSH_TEST_MODEL_WRAPPER=1` + 进程环境注入；`.env.test` 不覆盖路由键）'
        : 'dotenv-test-layering（`.env` 打底 + `.env.test` 覆盖）',
    },
    parsingAndAggregation: {
      note:
        '解析与聚合规则就是下列文件的字节：解析（parseJudgeOutput）· 三态（alertStateOf）·'
        + '读数形成（judgmentFromSamples）· 探针读数（probeReadingOf）· 度量（computeMetrics）·'
        + '轮内/跨轮稳定性（computeStability / computeCrossRunStability）· 配置键（crossRunConfigKey）·'
        + '判决（evaluateValidity）。**任一文件改动即另立候选。**',
      files: fileHashes,
      fileSetDigest: sha256OfText(fileHashes.map((f) => `${f.path}\u0000${f.sha256}`).join('\u0001')),
    },
    criteria: {
      digest: sha256OfText(JSON.stringify(criteria)),
      values: criteria,
    },
    dirty: {
      judgingFiles: dirtyJudgingFiles,
      otherFiles: dirtyOthers,
      note: '判定链路已确认干净；其余脏文件如实列出，它们**不进** candidateId，但进证据。',
    },
  }

  /*
   * ---- ⑤ candidateId：把上面全部字段折成一个短标识 ----
   *
   * ⚠️ `startedAt` / `dirty.otherFiles` **不进** id：
   *    前者每次运行都不同（那不是"判定器变了"），后者不影响判定。
   *    只有"会改变判断结果的东西"才进 —— 否则 id 会天天变，失去意义。
   */
  const idInput = JSON.stringify({
    code: descriptor.code,
    versions: descriptor.versions,
    prompt: descriptor.prompt,
    judge: descriptor.judge,
    fileSetDigest: descriptor.parsingAndAggregation.fileSetDigest,
    criteriaDigest: descriptor.criteria.digest,
  })
  const candidateId = sha256OfText(idInput)

  /*
   * ---- ⑥ 自证（三段式：确定性 / 负控会响 / 恢复）----
   */
  const again = sha256OfText(idInput)
  const perturbed = sha256OfText(
    JSON.stringify({
      code: descriptor.code,
      versions: descriptor.versions,
      prompt: descriptor.prompt,
      judge: { ...descriptor.judge, maxTokens: descriptor.judge.maxTokens + 1 },
      fileSetDigest: descriptor.parsingAndAggregation.fileSetDigest,
      criteriaDigest: descriptor.criteria.digest,
    })
  )
  const perturbedCriteria = sha256OfText(
    JSON.stringify({
      code: descriptor.code,
      versions: descriptor.versions,
      prompt: descriptor.prompt,
      judge: descriptor.judge,
      fileSetDigest: descriptor.parsingAndAggregation.fileSetDigest,
      criteriaDigest: sha256OfText(JSON.stringify({ ...criteria, minItems: criteria.minItems + 1 })),
    })
  )
  const selfCheck = {
    deterministic: again === candidateId,
    budgetChangeYieldsNewId: perturbed !== candidateId,
    thresholdChangeYieldsNewId: perturbedCriteria !== candidateId,
    measuredFiles: fileHashes.length,
    measuredProbeItems: probeItems.length,
  }
  if (
    !selfCheck.deterministic ||
    !selfCheck.budgetChangeYieldsNewId ||
    !selfCheck.thresholdChangeYieldsNewId ||
    selfCheck.measuredFiles === 0 ||
    selfCheck.measuredProbeItems === 0
  ) {
    throw new MeasurementInvalidError(
      `MEASUREMENT INVALID：冻结件自证未通过 ${JSON.stringify(selfCheck)}`
    )
  }

  const evidence = {
    ...descriptor,
    candidateId,
    candidateIdShort: candidateId.slice(0, 12),
    candidateIdInputs: {
      included: ['code', 'versions', 'prompt', 'judge', 'fileSetDigest', 'criteriaDigest'],
      excluded: ['startedAt', 'dirty.otherFiles'],
      reason: '只有会改变判断结果的东西才进 id；否则 id 会随每次运行变化，失去意义。',
    },
    selfCheck,
    finishedAt: new Date().toISOString(),
    notClaimed: [
      '本件只描述**判定器**；运行配置（命令集 / 语料选择）按工作单第 3 项另行冻结。',
      '本件**不**碰验收语料、**不**调用模型 —— 冻结不是试判。',
      '本件**不**主张候选有效；有效性要等正式两轮读数。',
    ],
  }

  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

  console.log('='.repeat(78))
  console.log('M6.1 候选冻结件')
  console.log('='.repeat(78))
  console.log(`  candidateId   ${candidateId}`)
  console.log(`  代码提交      ${head.slice(0, 12)}（分支 ${branch}）`)
  console.log(
    `  版本          契约 ${M6_1_CONTRACT_VERSION} · 语料 ${M6_1_CORPUS_VERSION} · 量具 ${M6_1_INSTRUMENT_VERSION}`
  )
  console.log(`  提示          ${M6_1_JUDGE_PROMPT_VERSION} · 摘要 ${promptDigest.slice(0, 12)}…（探针 ${String(probeItems.length)} 项）`)
  console.log(
    `  判定器        ${M6_1_INSTRUMENT_JUDGE_ID} · host=${judgeProbe.baseUrlHost} · model=${judgeProbe.model}`
  )
  console.log(
    `  预算/推理档   maxTokens=${String(M6_1_JUDGE_MAX_TOKENS)} · reasoning_effort=${M6_1_JUDGE_REASONING_EFFORT}`
  )
  console.log(`  判定链路文件  ${String(fileHashes.length)} 个 · 合集摘要 ${descriptor.parsingAndAggregation.fileSetDigest.slice(0, 12)}…`)
  console.log(`  阈值摘要      ${descriptor.criteria.digest.slice(0, 12)}…`)
  console.log(`  其它脏文件    ${String(dirtyOthers.length)} 个（不进 id，已如实记录）`)
  console.log(
    `  自证          确定=${String(selfCheck.deterministic)} · 改预算换 id=${String(selfCheck.budgetChangeYieldsNewId)} · 改阈值换 id=${String(selfCheck.thresholdChangeYieldsNewId)}`
  )
  console.log(`\n证据：${relative(ROOT, outPath).split(/[\\/]/).join('/')}`)
  console.log('\n⚠️ 运行配置**不在此件内**：按工作单第 3 项，接线与离线自证之后再单独冻结。')
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[m6.1-freeze] 失败关闭：${message}`)
  if (error instanceof MeasurementInvalidError) {
    console.error('[m6.1-freeze] 这是 MEASUREMENT INVALID / UNFROZEN，不是"可以继续"')
  }
  process.exit(2)
}
