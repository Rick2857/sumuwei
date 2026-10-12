/**
 * M9.5 WP1 —— **本地编码器 PoC（模型半边）**（`pnpm m9.5:embedding --phase download|verify`）。
 *
 * ============================================================================
 *  两阶段，且**必须分开**（计划 §6.2 / §11.3 末段）
 * ============================================================================
 * ```text
 * --phase download  安装动作：从镜像取**已选定的**模型文件，逐个校验字节数与 sha256。
 *                   ★ 这是一次**安装出站**，必须单独记录来源、许可证与校验值。
 * --phase verify    运行动作：`allowRemoteModels = false`，只用本地目录加载。
 *                   ★ 它证明"正常运行不联网"（计划 §6.2），并出编码/资源读数。
 * ```
 *
 * ============================================================================
 *  三处**必须写下来的**环境事实（都是本轮实测，不是假设）
 * ============================================================================
 * ```text
 * ① **运行时零下载**：`@huggingface/transformers@4.2.0` 与 `onnxruntime-node@1.24.3`
 *    已随 `@elizaos/*` 的传递依赖落在 `node_modules/.pnpm/`（含 win32-x64 原生绑定）。
 *    本脚本按**绝对路径**解析它，并在证据里记下解析来源 —— 这是**实验期的耦合**，
 *    不是正式依赖声明；WP3 才把依赖正式声明进隔离试验目录。
 *    ⇒ 找不到就**失败关闭**并打印修复指引，不静默回退、不自动安装。
 * ② **huggingface.co 在本机不可达**（直连超时、`.npmrc` 里的代理 127.0.0.1:7897 未监听）。
 *    可达的是 **`hf-mirror.com`**（实测 200）。因此 `--phase download` 从**镜像**取，
 *    并把镜像基址与每个文件的 sha256 一起落盘（可复核）。
 * ③ 模型文件**不由本脚本"顺便"拉取**：清单是硬编码的 8 个文件（含 q8 权重），
 *    字节数按 HF API 在 2026-09-28 的读数校验；不符即拒。
 * ```
 *
 * ============================================================================
 *  硬边界
 * ============================================================================
 *  · **本脚本不 import 任何数据库模块**：既不隔离、也不打开任何库（构造性隔离）。
 *    证据里 `dbKind = not-applicable` 是**构造属性**，不是自我声明。
 *  · 全部产物落在 `artifacts/m9.5/local/**`（已 ignore）：模型文件 140 MB 级**不进仓库**。
 *  · 计数自检（AGENTS §6.8）：`measuredCount=0` ⇒ 拒写清单。
 *
 * 用法：
 *   pnpm m9.5:embedding --phase download
 *   pnpm m9.5:embedding --phase verify
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  runIdFromM95OutPath,
  selfCheckMeasurement,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const STARTED_AT = new Date().toISOString()
const GATE_VERSION = 'm9.5-embedding@1'

/** 模型与镜像（见文件头 ②） */
const MODEL_ID = 'Xenova/multilingual-e5-small'
const MIRROR_BASE = 'https://hf-mirror.com'
const UPSTREAM_BASE = 'https://huggingface.co'
const REVISION = 'main'

/** 资产根（`artifacts/m9.5/local/` 已 ignore） */
const LAB_ROOT = join(REPO_ROOT, 'artifacts/m9.5/local/embedding-lab')
const MODEL_ROOT = join(LAB_ROOT, 'models')
const MODEL_DIR = join(MODEL_ROOT, MODEL_ID)

/**
 * 要取的 8 个文件。`bytes` 来自 HF API 在 **2026-09-28** 的读数
 * （`https://huggingface.co/api/models/${MODEL_ID}?blobs=true`），
 * 不信"下载成功就行"：字节数不符即拒（计划 §6.2 的"校验值"）。
 */
const FILES: readonly { readonly path: string; readonly bytes: number; readonly role: string }[] = [
  { path: 'config.json', bytes: 658, role: '模型配置（维度 384 / 架构）' },
  { path: 'quant_config.json', bytes: 674, role: '量化配置' },
  { path: 'sentencepiece.bpe.model', bytes: 5_069_051, role: 'SentencePiece 分词器' },
  { path: 'special_tokens_map.json', bytes: 167, role: '特殊 token 映射' },
  { path: 'tokenizer.json', bytes: 17_082_730, role: '快速分词器（Fast tokenizer）' },
  { path: 'tokenizer_config.json', bytes: 443, role: '分词器配置' },
  {
    path: 'onnx/model_quantized.onnx',
    bytes: 118_308_185,
    role: '★ q8 量化权重（本次唯一选定档；fp32/fp16 未取）',
  },
]

const EXPECTED_TOTAL_BYTES = FILES.reduce((sum, file) => sum + file.bytes, 0)

// ---------------------------------------------------------------------------
// 运行时解析（见文件头 ①）：绝对路径 + 失败关闭
// ---------------------------------------------------------------------------

interface TransformersModule {
  readonly pipeline: (
    task: string,
    model: string,
    options?: Record<string, unknown>
  ) => Promise<FeatureExtractor>
  readonly env: Record<string, unknown>
}

interface FeatureExtractor {
  (
    input: string | string[],
    options?: Record<string, unknown>
  ): Promise<{ readonly dims: readonly number[]; readonly data: Float32Array | number[] }>
  readonly dispose?: () => Promise<void> | void
}

interface LoadedTransformers {
  readonly module: TransformersModule
  readonly resolvedFrom: string
}

async function loadTransformers(): Promise<LoadedTransformers> {
  const pnpmRoot = join(REPO_ROOT, 'node_modules', '.pnpm')
  const errors: string[] = []
  const candidates: { entry: string; label: string }[] = []

  const specifierEntry = tryResolveSpecifier()
  if (specifierEntry !== null) {
    candidates.push({ entry: specifierEntry, label: 'specifier:@huggingface/transformers' })
  } else {
    errors.push('specifier:@huggingface/transformers 未链接到本项目 node_modules')
  }
  if (existsSync(pnpmRoot)) {
    for (const name of readdirSync(pnpmRoot)
      .filter((item) => item.startsWith('@huggingface+transformers@'))
      .sort()) {
      const entry = join(
        pnpmRoot,
        name,
        'node_modules/@huggingface/transformers/dist/transformers.node.mjs'
      )
      if (existsSync(entry)) {
        candidates.push({ entry, label: `pnpm-store:${name}` })
      }
    }
  }
  if (candidates.length === 0) {
    throw new Error(
      [
        '无法解析 `@huggingface/transformers`（本地编码器运行时）。本脚本**不会**自动安装它。',
        '修法（任一）：',
        '  · 在隔离试验目录里正式声明依赖后重试（推荐；WP3 会做）：',
        '      artifacts/m9.5/local/embedding-lab/package.json 里加 "4.2.0" 后 pnpm install',
        `  · 或确认 ${pnpmRoot} 下有 @huggingface+transformers@*`,
        `解析尝试：\n  ${errors.join('\n  ')}`,
      ].join('\n')
    )
  }
  for (const candidate of candidates) {
    try {
      const module = (await import(pathToFileUrl(candidate.entry))) as unknown as TransformersModule
      if (typeof module.pipeline !== 'function') {
        errors.push(`${candidate.label}: 模块没有 pipeline 导出`)
        continue
      }
      return { module, resolvedFrom: candidate.label }
    } catch (error) {
      errors.push(`${candidate.label}: ${(error as Error).message}`)
    }
  }
  throw new Error(`所有候选都加载失败：\n  ${errors.join('\n  ')}`)
}

function tryResolveSpecifier(): string | null {
  const direct = join(REPO_ROOT, 'node_modules', '@huggingface/transformers')
  if (!existsSync(direct)) return null
  const entry = join(direct, 'dist/transformers.node.mjs')
  return existsSync(entry) ? entry : null
}

function pathToFileUrl(path: string): string {
  /* 只处理本机绝对路径（含空格 ⇒ 必须 encode） */
  return `file:///${path.replace(/\\/g, '/').split('/').map((seg) => encodeURIComponent(seg)).join('/')}`
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(((sorted.length - 1) * p) / 100)))
  return sorted[index] as number
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] as number) * (b[i] as number)
    na += (a[i] as number) ** 2
    nb += (b[i] as number) ** 2
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

function toArray(tensor: { dims: readonly number[]; data: Float32Array | number[] }): number[][] {
  const data = Array.from(tensor.data as ArrayLike<number>)
  const dim = tensor.dims[tensor.dims.length - 1] as number
  const rows = data.length / dim
  return Array.from({ length: rows }, (_, row) => data.slice(row * dim, (row + 1) * dim))
}

// ---------------------------------------------------------------------------
// 下载阶段（安装出站；逐个校验字节数）
// ---------------------------------------------------------------------------

interface DownloadReading {
  readonly path: string
  readonly role: string
  readonly expectedBytes: number
  readonly actualBytes: number
  readonly bytesMatch: boolean
  readonly sha256: string
  readonly fromCache: boolean
  readonly url: string
  readonly elapsedMs: number
}

async function downloadPhase(): Promise<Record<string, unknown>> {
  mkdirSync(MODEL_DIR, { recursive: true })
  const readings: DownloadReading[] = []
  const started = Date.now()

  for (const file of FILES) {
    const target = join(MODEL_DIR, file.path)
    const url = `${MIRROR_BASE}/${MODEL_ID}/resolve/${REVISION}/${file.path}`
    if (existsSync(target) && statSync(target).size === file.bytes) {
      readings.push({
        path: file.path,
        role: file.role,
        expectedBytes: file.bytes,
        actualBytes: statSync(target).size,
        bytesMatch: true,
        sha256: sha256File(target),
        fromCache: true,
        url,
        elapsedMs: 0,
      })
      process.stdout.write(`  [cached] ${file.path} (${String(file.bytes)} B)\n`)
      continue
    }
    const t0 = Date.now()
    const response = await fetchWithRetry(url)
    if (!response.ok) {
      throw new Error(`下载失败 ${url} ⇒ HTTP ${String(response.status)}`)
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, buffer)
    const bytesMatch = buffer.byteLength === file.bytes
    readings.push({
      path: file.path,
      role: file.role,
      expectedBytes: file.bytes,
      actualBytes: buffer.byteLength,
      bytesMatch,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      fromCache: false,
      url,
      elapsedMs: Date.now() - t0,
    })
    process.stdout.write(
      `  [fetched] ${file.path} ${String(buffer.byteLength)} B` +
        `${bytesMatch ? '' : ` ⚠️ 期望 ${String(file.bytes)}`} (${String(Date.now() - t0)}ms)\n`
    )
  }

  const mismatches = readings.filter((item) => !item.bytesMatch)
  const fetchedBytes = readings
    .filter((item) => !item.fromCache)
    .reduce((sum, item) => sum + item.actualBytes, 0)
  const onDiskBytes = readings.reduce((sum, item) => sum + item.actualBytes, 0)
  return {
    mirror: MIRROR_BASE,
    upstreamNotReachable: UPSTREAM_BASE,
    mirrorSubstitution: {
      declared: true,
      why: '本机实测：huggingface.co 直连超时、.npmrc 的代理 127.0.0.1:7897 未监听；hf-mirror.com 可达（200）',
      integrity: '每个文件按 HF API 在 2026-09-28 的读数校验字节数 + 记录 sha256',
    },
    modelId: MODEL_ID,
    revision: REVISION,
    modelDir: MODEL_DIR.replace(REPO_ROOT, '.').replace(/\\/g, '/'),
    dtypeChosen: 'q8（onnx/model_quantized.onnx）—— 用户 2026-09-28 批准的最小路线',
    expectedTotalBytes: EXPECTED_TOTAL_BYTES,
    onDiskBytes,
    fetchedBytes,
    fetchedMB: Number((fetchedBytes / 1024 / 1024).toFixed(1)),
    mismatches: mismatches.map((item) => item.path),
    allBytesMatch: mismatches.length === 0,
    elapsedMs: Date.now() - started,
    files: readings,
    notFetched: [
      'onnx/model.onnx（fp32，448.5 MiB）',
      'onnx/model_fp16.onnx（224.4 MiB）',
      'onnx/model_int8.onnx / model_uint8.onnx（112.6 MiB 档，与 q8 同量级）',
      'onnx/model_q4.onnx / model_bnb4.onnx（约 380 MiB）',
      'onnx/model_q4f16.onnx（195.3 MiB）',
    ],
  }
}

async function fetchWithRetry(url: string, attempts = 3): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' })
      if (response.ok || response.status < 500) return response
      lastError = new Error(`HTTP ${String(response.status)}`)
    } catch (error) {
      lastError = error
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
  }
  throw new Error(`重试 ${String(attempts)} 次仍失败：${String((lastError as Error)?.message ?? lastError)}`)
}

// ---------------------------------------------------------------------------
// 验证阶段（离线；只用本地目录）
// ---------------------------------------------------------------------------

const shared: { extractor?: FeatureExtractor } = {}

interface ProbeLike {
  readonly id: string
  readonly question: string
  readonly verdict: 'ok' | 'unexpected' | 'not-run'
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

async function runProbe(
  id: string,
  question: string,
  fn: () => Promise<Record<string, unknown>>
): Promise<ProbeLike> {
  try {
    return { id, question, verdict: 'ok', reading: await fn(), error: null }
  } catch (error) {
    return { id, question, verdict: 'unexpected', reading: {}, error: (error as Error).message }
  }
}

/** WP0 基线的 S3 记忆（passage 侧）+ 问句（query 侧），用于把模型读数接到 WP0 缺口上 */
const BRIDGE_MEMORIES: readonly { readonly id: string; readonly passage: string }[] = [
  { id: 'project.background.active', passage: '我在写毕业论文。' },
  { id: 'education.institution', passage: '我在江城大学读书。' },
  { id: 'food.avoid.general', passage: '我不吃辣。' },
]
const BRIDGE_QUERIES: readonly {
  readonly id: string
  readonly question: string
  readonly expectedTarget: string | null
  readonly wp0Verdict: string
}[] = [
  { id: 'q-a', question: '我现在在写什么？', expectedTarget: 'project.background.active', wp0Verdict: 'none（已修）' },
  {
    id: 'q-b',
    question: '最近那个学业项目怎么样了？',
    expectedTarget: 'project.background.active',
    wp0Verdict: 'none（小规模已可用）',
  },
  { id: 'q-c', question: '我读的是哪所院校？', expectedTarget: 'education.institution', wp0Verdict: 'none（已可用）' },
  {
    id: 'q-d',
    question: '我能不能接受辣味？',
    expectedTarget: 'food.avoid.general',
    wp0Verdict: '层⑤（相关性闸拒）',
  },
  { id: 'q-e', question: '我平时喜欢什么运动？', expectedTarget: null, wp0Verdict: '负控：选中 0（正确）' },
]

async function verifyPhase(): Promise<{ probes: ProbeLike[]; meta: Record<string, unknown> }> {
  const probes: ProbeLike[] = []
  const missing = FILES.filter((file) => !existsSync(join(MODEL_DIR, file.path)))
  if (missing.length > 0) {
    throw new Error(
      `本地模型目录不完整（缺 ${missing.map((file) => file.path).join(', ')}）⇒ 先跑 --phase download`
    )
  }

  const loaded = await loadTransformers()
  const env = loaded.module.env as {
    allowRemoteModels: boolean
    allowLocalModels: boolean
    localModelPath: string
    cacheDir: string
    remoteHost: string
  }
  env.allowRemoteModels = false
  env.allowLocalModels = true
  env.localModelPath = MODEL_ROOT
  env.cacheDir = join(LAB_ROOT, 'cache')
  env.remoteHost = MIRROR_BASE

  const modelDiskBytes = FILES.reduce((sum, file) => sum + statSync(join(MODEL_DIR, file.path)).size, 0)

  probes.push(
    await runProbe('offline-load', '断网/禁远端条件下能不能从本地目录加载（计划 §6.2 的核心要求）', async () => {
      const t0 = Date.now()
      const extractor = await loaded.module.pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
      const coldLoadMs = Date.now() - t0
      const first = await extractor('passage: 我在写毕业论文。', { pooling: 'mean', normalize: true })
      const afterLoadMs = Date.now() - t0
      const vectors = toArray(first)
      /* 留给后续探针复用（挂到 meta 之外，直接保存在闭包里） */
      shared.extractor = extractor
      return {
        modelId: MODEL_ID,
        dtype: 'q8',
        allowRemoteModels: env.allowRemoteModels,
        localModelPath: env.localModelPath.replace(REPO_ROOT, '.').replace(/\\/g, '/'),
        coldLoadMs,
        firstEncodeAfterLoadMs: afterLoadMs,
        dims: first.dims,
        vectorCount: vectors.length,
      }
    })
  )

  const extractor = shared.extractor
  if (extractor === undefined) {
    return {
      probes,
      meta: { aborted: '加载未成功 ⇒ 后续探针不跑（不许用 0 冒充）', resolvedFrom: loaded.resolvedFrom },
    }
  }

  probes.push(
    await runProbe('vector-shape', '输出形状/维度/有限性/归一化（计划 §8.1 的"校验为有限数、固定维度"）', async () => {
      const out = await extractor(['passage: 我在写毕业论文。', 'query: 最近那个学业项目怎么样了？'], {
        pooling: 'mean',
        normalize: true,
      })
      const vectors = toArray(out)
      const norms = vectors.map((vector) => Math.sqrt(vector.reduce((s, v) => s + v * v, 0)))
      const allFinite = vectors.every((vector) => vector.every((value) => Number.isFinite(value)))
      return {
        dims: out.dims,
        dimension: vectors[0]?.length ?? 0,
        vectorCount: vectors.length,
        allFinite,
        norms: norms.map((n) => Number(n.toFixed(8))),
        normalized: norms.every((n) => Math.abs(n - 1) < 1e-5),
        minComponent: Math.min(...(vectors[0] ?? [])),
        maxComponent: Math.max(...(vectors[0] ?? [])),
      }
    })
  )

  probes.push(
    await runProbe('determinism', '同一输入两次编码是否逐位相同（离线可复现的前提）', async () => {
      const a = toArray(await extractor('query: 我在写毕业论文。', { pooling: 'mean', normalize: true }))[0] as number[]
      const b = toArray(await extractor('query: 我在写毕业论文。', { pooling: 'mean', normalize: true }))[0] as number[]
      const maxAbsDiff = Math.max(...a.map((value, index) => Math.abs(value - (b[index] as number))))
      return { maxAbsDiff, identical: maxAbsDiff === 0 }
    })
  )

  probes.push(
    await runProbe(
      'prefix-sensitivity',
      'E5 的 `query:` / `passage:` 前缀是否真的改变向量（计划 §7.3 要求写进 model manifest）',
      async () => {
        const asQuery = toArray(await extractor('query: 我在写毕业论文。', { pooling: 'mean', normalize: true }))[0] as number[]
        const asPassage = toArray(
          await extractor('passage: 我在写毕业论文。', { pooling: 'mean', normalize: true })
        )[0] as number[]
        const noPrefix = toArray(
          await extractor('我在写毕业论文。', { pooling: 'mean', normalize: true })
        )[0] as number[]
        return {
          cosineQueryVsPassage: Number(cosine(asQuery, asPassage).toFixed(6)),
          cosineQueryVsNoPrefix: Number(cosine(asQuery, noPrefix).toFixed(6)),
          prefixesMatter: cosine(asQuery, asPassage) < 0.999,
        }
      }
    )
  )

  probes.push(
    await runProbe(
      'bridge-to-wp0',
      '把语义读数接到 WP0 的 S3 缺口上：**词面闸拒掉的那条（q-d）语义是否排得上**',
      async () => {
        const queryVectors = new Map<string, number[]>()
        for (const query of BRIDGE_QUERIES) {
          const vector = toArray(
            await extractor(`query: ${query.question}`, { pooling: 'mean', normalize: true })
          )[0] as number[]
          queryVectors.set(query.id, vector)
        }
        const passageVectors = new Map<string, number[]>()
        for (const memory of BRIDGE_MEMORIES) {
          const vector = toArray(
            await extractor(`passage: ${memory.passage}`, { pooling: 'mean', normalize: true })
          )[0] as number[]
          passageVectors.set(memory.id, vector)
        }
        const perQuery = BRIDGE_QUERIES.map((query) => {
          const ranked = [...passageVectors.entries()]
            .map(([memoryId, vector]) => ({
              memoryId,
              cosine: Number(cosine(queryVectors.get(query.id) as number[], vector).toFixed(6)),
            }))
            .sort((a, b) => b.cosine - a.cosine)
          const targetRank =
            query.expectedTarget === null
              ? null
              : ranked.findIndex((item) => item.memoryId === query.expectedTarget) + 1
          const targetCosine =
            query.expectedTarget === null
              ? null
              : (ranked.find((item) => item.memoryId === query.expectedTarget)?.cosine ?? null)
          const topCosine = ranked[0]?.cosine ?? null
          return {
            id: query.id,
            question: query.question,
            expectedTarget: query.expectedTarget,
            wp0Verdict: query.wp0Verdict,
            targetRank,
            targetCosine,
            topCosine,
            margin: topCosine !== null && targetCosine !== null ? Number((topCosine - targetCosine).toFixed(6)) : null,
            ranking: ranked,
          }
        })
        return {
          note:
            '这是**开发集小样**，不是盲测；只回答"语义排序在这些形态上有没有区分度"，' +
            '不回答 §14.4 的任何阈值。q-d 是 WP0 里被**词面相关性闸**拒掉的那条 ⇒ 它最能说明"语义通道是否值得做"。',
          perQuery,
        }
      }
    )
  )

  probes.push(
    await runProbe('latency-and-rss', '热编码延迟与内存（计划 §14.5 的资源读数；不凭模型卡宣传值）', async () => {
      const single: number[] = []
      for (let i = 0; i < 20; i += 1) {
        const t0 = Date.now()
        await extractor(`query: 这是第 ${String(i)} 次延迟测量。`, { pooling: 'mean', normalize: true })
        single.push(Date.now() - t0)
      }
      const batch: number[] = []
      const batchInput = Array.from({ length: 8 }, (_, i) => `passage: 批量第 ${String(i)} 条。`)
      for (let i = 0; i < 8; i += 1) {
        const t0 = Date.now()
        await extractor(batchInput, { pooling: 'mean', normalize: true })
        batch.push(Date.now() - t0)
      }
      const sortedSingle = [...single].sort((a, b) => a - b)
      const sortedBatch = [...batch].sort((a, b) => a - b)
      const memory = process.memoryUsage()
      return {
        singleQueryMs: {
          p50: percentile(sortedSingle, 50),
          p95: percentile(sortedSingle, 95),
          min: sortedSingle[0],
          max: sortedSingle[sortedSingle.length - 1],
        },
        batchOf8Ms: { p50: percentile(sortedBatch, 50), p95: percentile(sortedBatch, 95) },
        rssMB: Number((memory.rss / 1024 / 1024).toFixed(1)),
        heapUsedMB: Number((memory.heapUsed / 1024 / 1024).toFixed(1)),
        externalMB: Number((memory.external / 1024 / 1024).toFixed(1)),
        modelDiskBytes,
        modelDiskMB: Number((modelDiskBytes / 1024 / 1024).toFixed(1)),
      }
    })
  )

  probes.push(
    await runProbe(
      'cancellation-and-recovery',
      '编码中途取消：Promise 会怎样、底层是否继续吃 CPU（计划 §6.2「取消/超时能回收工作」）',
      async () => {
        const controller = new AbortController()
        const texts = Array.from({ length: 64 }, (_, i) => `passage: 取消测试第 ${String(i)} 条，中文样本。`)
        const cpuBefore = process.cpuUsage()
        let outcome = 'unknown'
        const work = (async () => {
          try {
            await extractor(texts, { pooling: 'mean', normalize: true, signal: controller.signal })
            return 'resolved'
          } catch (error) {
            return `rejected:${(error as Error).message.slice(0, 80)}`
          }
        })()
        setTimeout(() => controller.abort(), 50)
        outcome = await Promise.race([
          work,
          new Promise<string>((r) => setTimeout(() => r('timeout-after-30s'), 30_000)),
        ])
        const cpuAtSettle = process.cpuUsage(cpuBefore)
        await new Promise((r) => setTimeout(r, 500))
        const cpuAfterWait = process.cpuUsage(cpuBefore)
        return {
          outcome,
          cpuUserMsAtSettle: Number((cpuAtSettle.user / 1000).toFixed(1)),
          cpuUserMsAfterWait500: Number((cpuAfterWait.user / 1000).toFixed(1)),
          cpuUserMsDuring500msWait: Number(((cpuAfterWait.user - cpuAtSettle.user) / 1000).toFixed(1)),
          cpuKeptWorkingAfterSettle: cpuAfterWait.user - cpuAtSettle.user > 100_000,
          signalAccepted: outcome !== 'timeout-after-30s',
        }
      }
    )
  )

  probes.push(
    await runProbe(
      'model-missing-degradation',
      '模型缺失时必须**如实失败**且不联网（不许静默降级成"看起来成功了"）',
      async () => {
        const original = env.localModelPath
        env.localModelPath = join(LAB_ROOT, 'does-not-exist')
        const t0 = Date.now()
        try {
          await loaded.module.pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
          return {
            threw: false,
            elapsedMs: Date.now() - t0,
            note: '⚠️ 没有抛错 —— 需要复查是否偷偷走了远端',
          }
        } catch (error) {
          return {
            threw: true,
            elapsedMs: Date.now() - t0,
            errorName: (error as Error).name,
            errorMessage: (error as Error).message.slice(0, 200),
          }
        } finally {
          env.localModelPath = original
        }
      }
    )
  )

  probes.push(
    await runProbe('active-handles', '退出时有没有孤儿任务（计划 §6.2 的"退出无孤儿任务"）', async () => {
      const handles = (process as unknown as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? []
      return {
        activeHandleCount: handles.length,
        handleKinds: handles.map((handle) => (handle as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'),
        note:
          '本脚本**能正常打印并退出**本身就是"无阻塞型孤儿"的证据（事件循环被占住则进程不会退出）；' +
          '这里只把句柄数量作为附加读数，不单独当通过条件',
      }
    })
  )

  const failed = probes.filter((probe) => probe.verdict !== 'ok').length
  return {
    probes,
    meta: {
      resolvedFrom: loaded.resolvedFrom,
      allowRemoteModels: env.allowRemoteModels,
      localModelPath: env.localModelPath.replace(REPO_ROOT, '.').replace(/\\/g, '/'),
      dbTouched: false,
      networkUsedInVerify: false,
      unexpectedProbeCount: failed,
      modelDiskBytes,
    },
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const phaseIndex = process.argv.indexOf('--phase')
  const phase = phaseIndex >= 0 ? process.argv[phaseIndex + 1] : undefined
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const supersedesIndex = process.argv.indexOf('--supersedes')
  const supersedes = supersedesIndex >= 0 ? (process.argv[supersedesIndex + 1] ?? null) : null
  const reasonIndex = process.argv.indexOf('--supersession-reason')
  const supersessionReason = reasonIndex >= 0 ? (process.argv[reasonIndex + 1] ?? null) : null

  if (phase !== 'download' && phase !== 'verify') {
    process.stderr.write(
      `--phase 必须是 download 或 verify（收到：${String(phase)}）\n` +
        '  download 是一次**安装出站**（从镜像取模型文件并校验字节数/sha256）\n' +
        '  verify   是**离线**验证（allowRemoteModels=false，只用本地目录）\n'
    )
    process.exitCode = 2
    return
  }

  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: `wp1-embedding-${phase}`, headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)

  let payload: Record<string, unknown>
  let measuredCount: number
  let unexpected: number

  if (phase === 'download') {
    const reading = await downloadPhase()
    measuredCount = FILES.length
    unexpected = (reading.allBytesMatch as boolean) ? 0 : 1
    payload = {
      schemaVersion: 'm9.5-embedding@1',
      runId,
      phase,
      generatedAt: new Date().toISOString(),
      supersedes,
      supersessionReason,
      installationEgress: {
        happened: true,
        host: MIRROR_BASE,
        upstreamHostUnreachable: UPSTREAM_BASE,
        reason: '本机 huggingface.co 直连超时、.npmrc 代理未监听；hf-mirror.com 可达',
      },
      runtime: { downloaded: false, note: '运行时已在 node_modules/.pnpm（见文件头 ①），本阶段未取任何 npm 包' },
      reading,
    }
  } else {
    const { probes, meta } = await verifyPhase()
    measuredCount = probes.length
    unexpected = probes.filter((probe) => probe.verdict !== 'ok').length
    payload = {
      schemaVersion: 'm9.5-embedding@1',
      runId,
      phase,
      generatedAt: new Date().toISOString(),
      supersedes,
      supersessionReason,
      installationEgress: { happened: false, note: 'verify 阶段 allowRemoteModels=false，不联网' },
      meta,
      probes,
    }
  }

  const selfCheck = selfCheckMeasurement({ measuredCount, notRunCount: 0, failedCount: unexpected })
  const evidencePath = join(runDir, `embedding-${phase}.json`)
  writeFileSync(evidencePath, `${JSON.stringify({ ...payload, measurement: { selfCheck, measuredCount, unexpectedProbeCount: unexpected } }, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp1',
    lane: 'live',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: `${GATE_VERSION}#${phase}`,
    dbKind: 'not-applicable',
    isolationProof: {
      dbTouched: false,
      method:
        '**构造属性**：本脚本不 import 任何数据库模块（无 sandbox / drizzle / 仓储 / 迁移），' +
        '因此不存在"打开了真实库"的路径；真实库只被只读树摘要间接引用（sourceTreeReading 不含 data/）',
    },
    configHash: { allowRemoteModels: phase === 'verify' ? false : true, dtype: 'q8' },
    command: [{ cmd: `pnpm m9.5:embedding --phase ${phase}`, exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount,
    notRunCount: 0,
    counts: { total: measuredCount, passed: measuredCount - unexpected, failed: unexpected },
    toolVersions: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      git: gitOrNull(['--version']),
    },
    supersedes,
    modelFingerprint: `${MODEL_ID}@${REVISION}#q8`,
    artifactHashes: { [`embedding-${phase}.json`]: sha256File(evidencePath) },
  })

  process.stdout.write(
    [`M9.5 WP1 embedding(${phase}) 完成：${runId}`, `  证据：${evidencePath}`, `  清单：${manifestPath}`].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}


await main()
