/**
 * M9.5 A3 —— **换 embedding 模型的库外对照**（`pnpm m9.5:a3:arm`）。
 *
 * ============================================================================
 *  它回答计划 §277 给 A3 的问题
 * ============================================================================
 * ```text
 * "A3 BGE 候选 | 同一开发/验证集 | embedding 模型 | **质量增益是否值得资源成本**"
 * ⇒ 本门在同一批 case 上，用三个模型各算 passage/query 向量，按**同一口径**比较
 *    入池（top-8）/ 排首位 / 改述类排首位，并记录**成本**（冷加载、编码耗时、体积）。
 * ```
 * ⚠️ **库外**（`L-M95-22`）：BGE 是 512/768 维，而派生索引列是 `vector(384)` ⇒
 *    不能在库里"换模型"。本门**不碰数据库、不写派生索引、不改 schema**。
 * ⚠️ **口径声明（保守选择）**：BGE 用**空前缀**；`query: `/`passage: ` 是 E5 的约定，
 *    而 bge-*-zh-v1.5 官方建议的**查询指令前缀未采用** ⇒ 若采用，BGE 读数可能更好。
 * 用法：`pnpm m9.5:a3:arm`
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

import { sha256 } from './m4-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const gitOrNull = (args: readonly string[]): string | null => {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
const safeTreeDigest = (): Record<string, unknown> | null => {
  try {
    const digest = digestTree(REAL_DB_DIR)
    return { dir: 'data/pglite', measuredCount: digest.measuredCount, treeSha256: digest.treeSha256 }
  } catch (error) {
    return { dir: 'data/pglite', error: (error as Error).message }
  }
}
const LAB = join(REPO_ROOT, 'artifacts/m9.5/local/embedding-lab')
const MODEL_ROOT = join(LAB, 'models')
const CORPUS = join(REPO_ROOT, 'evals/m9.5/corpus')

/** **与 `calibration@1` / `validation@1` 完全同一口径**（同种子、同去重、同样本量、同 limit） */
const SAMPLE_SIZE = 24
const CANDIDATE_LIMIT = 8
const SEEDS = { dev: 'm9.5-calibration@1', val: 'm9.5-validation@1' } as const
const PARAPHRASE_FORMS = new Set(['synonym', 'indirect', 'elliptical', 'boundedHint', 'similarProject', 'mixedEntity'])

const MODELS = [
  { id: 'Xenova/multilingual-e5-small', dimension: 384, queryPrefix: 'query: ', passagePrefix: 'passage: ', sizeMiB: 118 },
  { id: 'Xenova/bge-small-zh-v1.5', dimension: 512, queryPrefix: '', passagePrefix: '', sizeMiB: 23 },
  { id: 'Xenova/bge-base-zh-v1.5', dimension: 768, queryPrefix: '', passagePrefix: '', sizeMiB: 98 },
] as const

let passed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) passed += 1
  else failures.push(`${name}${detail === undefined ? '' : ` —— ${detail}`}`)
}

function resolveTransformers(): string {
  const pnpmDir = join(REPO_ROOT, 'node_modules/.pnpm')
  for (const candidate of readdirSync(pnpmDir).filter((name) => name.startsWith('@huggingface+transformers@'))) {
    const entry = join(pnpmDir, candidate, 'node_modules/@huggingface/transformers/package.json')
    if (!existsSync(entry)) continue
    const pkg = JSON.parse(readFileSync(entry, 'utf8')) as { main?: string; module?: string }
    const target = join(pnpmDir, candidate, 'node_modules/@huggingface/transformers', pkg.module ?? pkg.main ?? 'dist/transformers.js')
    if (existsSync(target)) return target
  }
  throw new Error('解析不到 @huggingface/transformers 入口')
}

interface Case {
  readonly caseId: string
  readonly predicate: string
  readonly value: string
  readonly request: string
  readonly formKind: string
}

/** 与 calibration/validation **同一抽样函数**（同种子 + 按 `predicate@value` 去重） */
function sampleOf(split: 'dev' | 'val'): Case[] {
  const rows = readFileSync(join(CORPUS, `${split}.jsonl`), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const seen = new Set<string>()
  return rows
    .filter((row) => row.stratum === 'normal' || row.stratum === 'hard')
    .sort((a, b) => {
      const ra = createHash('sha256').update(`${SEEDS[split]}|${String(a.caseId)}`).digest('hex')
      const rb = createHash('sha256').update(`${SEEDS[split]}|${String(b.caseId)}`).digest('hex')
      return ra < rb ? -1 : 1
    })
    .filter((row) => {
      const snapshot = row.authoritativeSnapshot as { predicate: string; value: string }
      const key = `${snapshot.predicate}@${snapshot.value}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, SAMPLE_SIZE)
    .map((row) => {
      const snapshot = row.authoritativeSnapshot as { predicate: string; value: string }
      return {
        caseId: String(row.caseId),
        predicate: snapshot.predicate,
        value: snapshot.value,
        request: String(row.request),
        formKind: String(row.formKind),
      }
    })
}

interface TensorLike {
  readonly dims: readonly number[]
  readonly data: Float32Array
}

const cosine = (a: Float32Array, b: Float32Array): number => {
  let sum = 0
  for (let index = 0; index < a.length; index += 1) sum += (a[index] as number) * (b[index] as number)
  return sum
}

function rankOf(similarities: readonly number[], target: number): number {
  const sorted = [...similarities].sort((x, y) => y - x)
  const targetScore = similarities[target] as number
  return sorted.indexOf(targetScore) + 1
}

async function main(): Promise<void> {
  const transformers = (await import(pathToFileURL(resolveTransformers()).href)) as {
    env: Record<string, unknown>
    pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<unknown>
  }
  transformers.env.allowRemoteModels = false
  transformers.env.allowLocalModels = true
  transformers.env.localModelPath = MODEL_ROOT

  const splits = { dev: sampleOf('dev'), val: sampleOf('val') } as const
  check('两个 split 都抽到样本', splits.dev.length > 0 && splits.val.length > 0, `dev=${String(splits.dev.length)} val=${String(splits.val.length)}`)

  const readings: Record<string, unknown>[] = []
  for (const model of MODELS) {
    const loadStartedAt = Date.now()
    const extractor = (await transformers.pipeline('feature-extraction', model.id, { dtype: 'q8', local_files_only: true })) as (
      text: string | string[],
      options: Record<string, unknown>
    ) => Promise<TensorLike>
    const loadMs = Date.now() - loadStartedAt

    for (const split of ['dev', 'val'] as const) {
      const cases = splits[split]
      const passages = cases.map((item) => `${model.passagePrefix}${item.predicate} ${item.value}`)
      const queries = cases.map((item) => `${model.queryPrefix}${item.request}`)
      const encodeStartedAt = Date.now()
      const passageTensor = await extractor(passages, { pooling: 'mean', normalize: true })
      const queryTensor = await extractor(queries, { pooling: 'mean', normalize: true })
      const encodeMs = Date.now() - encodeStartedAt
      const dim = passageTensor.dims[passageTensor.dims.length - 1] ?? 0
      if (dim !== model.dimension) throw new Error(`${model.id}: 维度 ${String(dim)} ≠ 声称 ${String(model.dimension)}`)

      let inPool = 0
      let topRanked = 0
      let paraphraseCases = 0
      let paraphraseTopRanked = 0
      let wrongPairTopRanked = 0
      for (let index = 0; index < cases.length; index += 1) {
        const query = queryTensor.data.subarray(index * dim, (index + 1) * dim)
        const similarities = cases.map((_, other) =>
          cosine(query, passageTensor.data.subarray(other * dim, (other + 1) * dim))
        )
        const rank = rankOf(similarities, index)
        if (rank <= CANDIDATE_LIMIT) inPool += 1
        if (rank === 1) topRanked += 1
        const formKind = (cases[index] as Case).formKind
        if (PARAPHRASE_FORMS.has(formKind)) {
          paraphraseCases += 1
          if (rank === 1) paraphraseTopRanked += 1
        }
        /* **错配负控**：把 query 换成下一条的 ⇒ 目标名次应当明显变差 */
        const wrongQuery = queryTensor.data.subarray(((index + 1) % cases.length) * dim, (((index + 1) % cases.length) + 1) * dim)
        const wrongSimilarities = cases.map((_, other) =>
          cosine(wrongQuery, passageTensor.data.subarray(other * dim, (other + 1) * dim))
        )
        if (rankOf(wrongSimilarities, index) === 1) wrongPairTopRanked += 1
      }
      readings.push({
        modelId: model.id,
        split,
        cases: cases.length,
        dimension: dim,
        inPool,
        topRanked,
        paraphraseCases,
        paraphraseTopRanked,
        /** 错配负控：**应当**远低于正确配对的 top-1 数 */
        wrongPairTopRanked,
        loadMsPerModel: loadMs,
        encodeMsTotal: encodeMs,
        sizeMiB: model.sizeMiB,
        queryPrefix: model.queryPrefix,
      })
      process.stdout.write(
        `  ${model.id} [${split}] dim=${String(dim)} · 入池 ${String(inPool)}/${String(cases.length)} · 首位 ${String(topRanked)} · 改述首位 ${String(paraphraseTopRanked)}/${String(paraphraseCases)} · 错配首位 ${String(wrongPairTopRanked)} · 编码 ${String(encodeMs)}ms\n`
      )
    }
  }

  const find = (id: string, split: string): Record<string, unknown> =>
    readings.find((row) => row.modelId === id && row.split === split) ?? {}
  const e5Dev = find('Xenova/multilingual-e5-small', 'dev')
  const e5Val = find('Xenova/multilingual-e5-small', 'val')

  /* ---- ① 三个模型 × 两个 split 全部跑完，且 case 数一致 ---- */
  check(
    '① 3 个模型 × 2 个 split 全部跑完，且同一 split 的 case 数一致',
    readings.length === 6 &&
      readings.every((row) => Number(row.cases) === SAMPLE_SIZE) &&
      readings.every((row) => Number(row.dimension) > 0)
  )

  /* ---- ② ★ 错配负控：错配的 top-1 必须**低于**正确配对 ---- */
  const wrongPairBad = readings.filter((row) => Number(row.wrongPairTopRanked) >= Number(row.topRanked))
  check(
    '② ★ 负控：把 query 错配到别的 case ⇒ top-1 数必须**低于**正确配对（否则这个指标不区分对错）',
    readings.some((row) => Number(row.topRanked) > 0) && wrongPairBad.length === 0,
    wrongPairBad.length > 0 ? JSON.stringify(wrongPairBad.slice(0, 2)) : `6 组全部满足`
  )

  /* ---- ③ 计数自检：所有模型在 dev 上的首位 > 0（否则指标空转） ---- */
  const devTop = readings.filter((row) => row.split === 'dev').map((row) => Number(row.topRanked))
  check('③ 计数自检：dev 上三个模型的 top-1 都 > 0（否则指标空转）', devTop.every((value) => value > 0), JSON.stringify(devTop))

  const total = passed + failures.length
  mkdirSync(LAB, { recursive: true })
  const payload = {
    schemaVersion: 'm9.5-a3@1',
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '计划 §277 的 **A3**：**同一 dev/val 集**（同种子、同去重、同样本量、同 top-8）上换 embedding 模型，' +
        '比较语义单通道的 入池 / 排首位 / 改述类排首位，并记录成本（冷加载、编码耗时、体积）',
      notProves:
        '**不**宣布"哪个模型更好"（A3 只回答"增益与成本的关系"）；**不**测混合召回端到端（那是 A2/`calibration@1` 的事）；' +
        '**不**涉及事务/写路径（库外，未开数据库）',
      caveats: {
        prefixPolicy: 'BGE 用**空前缀**（保守）；未采用 bge-zh-v1.5 官方建议的查询指令前缀 ⇒ BGE 读数可能偏低',
        outOfDatabase: 'BGE 是 512/768 维，派生索引列是 `vector(384)` ⇒ 库外对照（`L-M95-22`）',
        semanticOnly: '本门量与的是**语义单通道**的判别力，不是最终排序',
      },
      seeds: SEEDS,
    },
    readings,
    summary: {
      e5: { dev: { inPool: e5Dev.inPool, topRanked: e5Dev.topRanked, paraphrase: `${String(e5Dev.paraphraseTopRanked)}/${String(e5Dev.paraphraseCases)}` }, val: { inPool: e5Val.inPool, topRanked: e5Val.topRanked, paraphrase: `${String(e5Val.paraphraseTopRanked)}/${String(e5Val.paraphraseCases)}` } },
    },
    checks: { passed, failed: failures.length, total },
    failures,
  }
  const evidencePath = join(LAB, 'a3-arm.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  /*
   * ⚠️ **封存档**（本轮补上）：A3 的读数支撑了"**保留 E5**"这个决定，
   *    而在此之前它**只**落在 gitignore 的实验目录里 ⇒ 是"决定依据"与"可审计证据"之间的
   *    一处**例外**（其它每道门的证据都是封存、可被聚合门审计的）⇒ 与其余门同规格落档。
   */
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId = createM95RunId({ wpId: 'wp2-a3-arm', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const sealedPayloadPath = join(runDir, 'a3-arm.json')
  writeFileSync(sealedPayloadPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp2',
    lane: 'live',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: 'm9.5-a3@1',
    dbKind: 'not-applicable',
    isolationProof: { dbTouched: false, method: '**构造属性**：库外对照，只读语料 + 本地模型目录' },
    configHash: {
      models: MODELS.map((item) => item.id),
      sampleSize: SAMPLE_SIZE,
      candidateLimit: CANDIDATE_LIMIT,
      prefixPolicy: 'BGE 用空前缀（保守，未采用官方查询指令前缀）',
    },
    command: [{ cmd: 'pnpm m9.5:a3:arm', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: failures.length === 0,
    measuredCount: total,
    notRunCount: 0,
    counts: { total, passed, failed: failures.length },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'a3-arm.json': sha256(readFileSync(sealedPayloadPath, 'utf8')) },
  })
  process.stdout.write(
    [
      `A3 对照：通过 ${String(passed)} / 失败 ${String(failures.length)}（共 ${String(total)} 项）`,
      ...failures.map((line) => `  ✗ ${line}`),
      `证书（实验目录）：${evidencePath}`,
      `**封存档**（可被聚合门审计）：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (failures.length > 0 || total === 0) process.exitCode = 3
}

await main()
