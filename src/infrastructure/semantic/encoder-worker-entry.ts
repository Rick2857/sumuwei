/**
 * M9.5 WP3 —— **编码 worker 的子进程入口**（D27 的可终止执行单元）。
 *
 * ============================================================================
 *  为什么是**子进程**而不是 `AbortSignal`
 * ============================================================================
 * ```text
 * 实测（WP1 的 `cancellation-and-recovery` 探针）：`AbortSignal` 被接受，但**不取消**底层工作
 * —— Promise 结算之后 500 ms 内仍烧掉 8625 ms CPU。ONNX 的原生推理一旦进了 C++ 线程池，
 * JS 侧的 signal 拦不住它。
 * ⇒ 唯一可靠的办法：把推理放进**可被 OS 杀掉的进程**。进程被 SIGKILL 之后，
 *   它**在结构上不可能**继续计算。
 * ```
 *
 * ============================================================================
 *  协议（stdin/stdout，JSON Lines）
 * ============================================================================
 * ```text
 * 父 → 子：{"kind":"load"}                       预加载模型（可选；用于把冷启动与编码分开计时）
 *          {"kind":"ping"}
 *          {"kind":"encode","id":n,"texts":[...]}   编码并回一行结果
 *          {"kind":"exit"}
 * 子 → 父：{"type":"ready","modelId":...,"revision":...,"coldLoadMs":...}
 *          {"type":"pong"}
 *          {"type":"result","id":n,"ok":true,"dims":[...],"data":[..],"cpuUserMs":n,"elapsedMs":n}
 *          {"type":"result","id":n,"ok":false,"error":"..."}
 *          {"type":"error","error":"..."}            初始化失败（**不**退出，等父进程决定）
 * ```
 * ⚠️ 子进程**不**再派生任何子进程 ⇒ 杀它就等于回收全部工作（"退出无孤儿任务"的结构性保证）。
 *
 * ⚠️ 本入口**只在被父进程 spawn 时运行**；它不打开数据库、不联网
 *    （`allowRemoteModels = false`，模型只从本地目录加载）。
 */

import { createInterface } from 'node:readline'

/*
 * ⚠️ **必须在加载推理库之前**安装不出站守卫（计划 §12 WP8「无私人文本出站」）：
 *    库在 import 时可能自带初始化，而守卫要保证"任何 fetch 都抛错"这件事
 *    在**第一行下游代码之前**就已成立。守卫本身只依赖 `node:` 与标准类型。
 */
import { installNoEgressGuard } from './no-egress-guard.ts'

installNoEgressGuard()

import {
  DEFAULT_EMBEDDING_MANIFEST_PATH,
  type EmbeddingManifest,
  embeddingFingerprintOf,
  loadEmbeddingManifest,
  validateEmbeddingManifest,
  verifyEmbeddingAssets,
} from './embedding-manifest.ts'

/** 只用到的一点点 Transformers.js 表面（避免把整个类型图拉进来）。 */
interface Pipeline {
  (
    input: string | string[],
    options?: Record<string, unknown>
  ): Promise<{ readonly dims: readonly number[]; readonly data: Float32Array | number[] }>
}

interface TransformersModule {
  readonly pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<Pipeline>
  readonly env: Record<string, unknown>
}

const REPO_ROOT = process.cwd()
const LAB_MODEL_ROOT = `${REPO_ROOT}/artifacts/m9.5/local/embedding-lab/models`

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/** 解析运行时（与 `m9.5:embedding` 同一条纪律：找不到就失败关闭，不自动安装）。 */
async function loadTransformers(): Promise<{ module: TransformersModule; resolvedFrom: string }> {
  const { existsSync, readdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const candidates: { entry: string; label: string }[] = []
  const linked = join(REPO_ROOT, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')
  if (existsSync(linked)) candidates.push({ entry: linked, label: 'specifier:@huggingface/transformers' })
  const pnpmRoot = join(REPO_ROOT, 'node_modules/.pnpm')
  if (existsSync(pnpmRoot)) {
    for (const name of readdirSync(pnpmRoot)
      .filter((item) => item.startsWith('@huggingface+transformers@'))
      .sort()) {
      const entry = join(pnpmRoot, name, 'node_modules/@huggingface/transformers/dist/transformers.node.mjs')
      if (existsSync(entry)) candidates.push({ entry, label: `pnpm-store:${name}` })
    }
  }
  const errors: string[] = []
  for (const candidate of candidates) {
    try {
      const module = (await import(pathToFileUrl(candidate.entry))) as unknown as TransformersModule
      if (typeof module.pipeline !== 'function') {
        errors.push(`${candidate.label}: 没有 pipeline 导出`)
        continue
      }
      return { module, resolvedFrom: candidate.label }
    } catch (error) {
      errors.push(`${candidate.label}: ${(error as Error).message}`)
    }
  }
  throw new Error(`无法解析 @huggingface/transformers（本入口不自动安装）：\n  ${errors.join('\n  ')}`)
}

function pathToFileUrl(path: string): string {
  return `file:///${path.replace(/\\/g, '/').split('/').map((seg) => encodeURIComponent(seg)).join('/')}`
}

async function main(): Promise<void> {
  const manifestPath = process.env.M95_EMBEDDING_MANIFEST ?? `${REPO_ROOT}/${DEFAULT_EMBEDDING_MANIFEST_PATH}`
  const manifest: EmbeddingManifest = loadEmbeddingManifest(manifestPath)
  const manifestProblems = validateEmbeddingManifest(manifest)
  if (manifestProblems.length > 0) {
    send({ type: 'error', error: `清单不合法：\n  ${manifestProblems.join('\n  ')}` })
    return
  }
  const assets = verifyEmbeddingAssets(`${LAB_MODEL_ROOT}/${manifest.modelId}`, manifest)
  if (!assets.ok) {
    send({
      type: 'error',
      error:
        `本机模型资产与清单不符（失败关闭，不下载）：verified=${String(assets.verified)}/${String(assets.total)}` +
        ` missing=${assets.missing.join(',')} size=${assets.sizeMismatch.join(',')} hash=${assets.hashMismatch.join(',')}`,
    })
    return
  }

  let pipelinePromise: Promise<Pipeline> | null = null
  let coldLoadMs = 0

  const ensurePipeline = async (): Promise<Pipeline> => {
    if (pipelinePromise !== null) return pipelinePromise
    const loaded = await loadTransformers()
    const env = loaded.module.env as {
      allowRemoteModels: boolean
      allowLocalModels: boolean
      localModelPath: string
      cacheDir: string
    }
    /* D29/§6.2：只用本地；**绝不**在运行时自动下载或转云 */
    env.allowRemoteModels = false
    env.allowLocalModels = true
    env.localModelPath = LAB_MODEL_ROOT
    env.cacheDir = `${REPO_ROOT}/artifacts/m9.5/local/embedding-lab/cache`
    const started = Date.now()
    pipelinePromise = loaded.module
      .pipeline('feature-extraction', manifest.modelId, { dtype: manifest.dtype })
      .then((pipe) => {
        coldLoadMs = Date.now() - started
        return pipe
      })
    return pipelinePromise
  }

  send({
    type: 'ready',
    modelId: manifest.modelId,
    revision: manifest.revision,
    fingerprint: embeddingFingerprintOf(manifest),
    dimension: manifest.dimension,
    assetsVerified: assets.verified,
  })

  const rl = createInterface({ input: process.stdin })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let message: {
      kind?: string
      id?: number
      texts?: string[]
      pooling?: string
      normalize?: boolean
    }
    try {
      message = JSON.parse(trimmed) as typeof message
    } catch (error) {
      send({ type: 'error', error: `请求不是合法 JSON：${(error as Error).message}` })
      continue
    }

    if (message.kind === 'exit') {
      send({ type: 'bye' })
      process.exit(0)
    }
    if (message.kind === 'ping') {
      send({ type: 'pong' })
      continue
    }
    if (message.kind === 'load') {
      try {
        await ensurePipeline()
        send({ type: 'loaded', coldLoadMs })
      } catch (error) {
        send({ type: 'error', error: `加载失败：${(error as Error).message}` })
      }
      continue
    }
    if (message.kind !== 'encode') {
      send({ type: 'error', error: `未知 kind：${String(message.kind)}` })
      continue
    }

    const id = message.id ?? -1
    const cpuBefore = process.cpuUsage()
    const started = Date.now()
    try {
      const pipe = await ensurePipeline()
      const out = await pipe(message.texts ?? [], {
        pooling: message.pooling ?? manifest.pooling,
        normalize: message.normalize ?? manifest.normalize,
      })
      const cpu = process.cpuUsage(cpuBefore)
      send({
        type: 'result',
        id,
        ok: true,
        dims: [...out.dims],
        data: Array.from(out.data as ArrayLike<number>),
        cpuUserMs: Number((cpu.user / 1000).toFixed(1)),
        cpuSystemMs: Number((cpu.system / 1000).toFixed(1)),
        elapsedMs: Date.now() - started,
      })
    } catch (error) {
      send({ type: 'result', id, ok: false, error: (error as Error).message.slice(0, 300) })
    }
  }
}

await main()
