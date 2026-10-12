/**
 * M9.5 A3 —— **候选模型加载冒烟测试**（`pnpm m9.5:a3:smoke`）。
 *
 * ============================================================================
 *  它回答什么问题
 * ============================================================================
 * ```text
 * "文件下来了" **不等于** "模型能用"：
 *   · 布局必须恰好是 `${localModelPath}/${modelId}/…`（worker 是这么解析的）
 *   · 量化档要能被 onnxruntime 真正加载（不是字节在就算数）
 *   · 输出维度必须是该模型**声称**的维度（BGE-zh 是 512/768，不是 384）
 *   · 归一化后模长要接近 1（否则余弦相似度的假设不成立）
 * ⇒ 三条都过，才允许拿它去做 A3 对照。
 * ```
 * ⚠️ **本脚本在进程内直接加载**（不走生产的受守卫子进程）—— A3 是**对照测量**，
 *    不是生产路径；`allowRemoteModels = false` 保持"不出站"这一条不变。这一取舍记在证书里。
 * 用法：`pnpm m9.5:a3:smoke`
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = resolve(import.meta.dirname, '..')
const LAB = join(REPO_ROOT, 'artifacts/m9.5/local/embedding-lab')
const MODEL_ROOT = join(LAB, 'models')

/** 三个候选 + 各自**声称**的维度与**前缀策略**（前缀是 E5 的约定；BGE 不用） */
const MODELS: { readonly modelId: string; readonly dimension: number; readonly queryPrefix: string; readonly passagePrefix: string }[] = [
  { modelId: 'Xenova/multilingual-e5-small', dimension: 384, queryPrefix: 'query: ', passagePrefix: 'passage: ' },
  { modelId: 'Xenova/bge-small-zh-v1.5', dimension: 512, queryPrefix: '', passagePrefix: '' },
  { modelId: 'Xenova/bge-base-zh-v1.5', dimension: 768, queryPrefix: '', passagePrefix: '' },
]

/** 从 `.pnpm` 里解析 `@huggingface/transformers` 的入口（与 `m9.5-embedding.ts` 同法） */
function resolveTransformers(): string {
  const pnpmDir = join(REPO_ROOT, 'node_modules/.pnpm')
  const candidates = readdirSync(pnpmDir).filter((name) => name.startsWith('@huggingface+transformers@'))
  for (const candidate of candidates) {
    const entry = join(pnpmDir, candidate, 'node_modules/@huggingface/transformers/package.json')
    if (!existsSync(entry)) continue
    const pkg = JSON.parse(readFileSync(entry, 'utf8')) as { main?: string; module?: string }
    const relative = pkg.module ?? pkg.main ?? 'dist/transformers.js'
    const target = join(pnpmDir, candidate, 'node_modules/@huggingface/transformers', relative)
    if (existsSync(target)) return target
  }
  throw new Error('解析不到 @huggingface/transformers 入口')
}

interface TensorLike {
  readonly dims: readonly number[]
  readonly data: Float32Array
}

async function main(): Promise<void> {
  const entry = resolveTransformers()
  const transformers = (await import(pathToFileURL(entry).href)) as {
    env: Record<string, unknown>
    pipeline: (task: string, model: string, options: Record<string, unknown>) => Promise<unknown>
  }
  /* ⚠️ **不出站**：只用本地目录（与生产守卫同一条性质） */
  transformers.env.allowRemoteModels = false
  transformers.env.allowLocalModels = true
  transformers.env.localModelPath = MODEL_ROOT

  const SENTENCE = '我学校是碧溪大学'
  const readings: Record<string, unknown>[] = []

  for (const model of MODELS) {
    const dir = join(MODEL_ROOT, model.modelId)
    const required = ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx']
    const missing = required.filter((name) => !existsSync(join(dir, name)))
    if (missing.length > 0) {
      readings.push({ modelId: model.modelId, verdict: 'MISSING_FILES', missing })
      process.stdout.write(`${model.modelId}: ❌ 缺文件 ${missing.join(', ')}\n`)
      continue
    }
    const loadStartedAt = Date.now()
    try {
      const extractor = (await transformers.pipeline('feature-extraction', model.modelId, {
        dtype: 'q8',
        local_files_only: true,
      })) as (text: string, options: Record<string, unknown>) => Promise<TensorLike>
      const loadMs = Date.now() - loadStartedAt
      const encodeStartedAt = Date.now()
      const output = await extractor(`${model.passagePrefix}${SENTENCE}`, { pooling: 'mean', normalize: true })
      const encodeMs = Date.now() - encodeStartedAt
      const dimension = output.dims[output.dims.length - 1] ?? 0
      const values = Array.from(output.data)
      const finite = values.every((value) => Number.isFinite(value))
      const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0))
      readings.push({
        modelId: model.modelId,
        dimension,
        declaredDimension: model.dimension,
        dimensionMatches: dimension === model.dimension,
        finite,
        norm: Number(norm.toFixed(6)),
        normalized: Math.abs(norm - 1) < 1e-3,
        loadMs,
        encodeMs,
        queryPrefix: model.queryPrefix,
        passagePrefix: model.passagePrefix,
        verdict:
          dimension === model.dimension && finite && Math.abs(norm - 1) < 1e-3 ? 'OK' : 'FAILED',
      })
      const last = readings.at(-1) as Record<string, unknown>
      process.stdout.write(
        `${model.modelId}: ${last.verdict === 'OK' ? '✅' : '❌'} dim=${String(dimension)}/${String(model.dimension)} · norm=${String(last.norm)} · 冷加载 ${String(loadMs)}ms · 单条编码 ${String(encodeMs)}ms\n`
      )
    } catch (error) {
      readings.push({ modelId: model.modelId, verdict: 'LOAD_FAILED', error: (error as Error).message.slice(0, 200) })
      process.stdout.write(`${model.modelId}: ❌ 加载失败 —— ${(error as Error).message.slice(0, 140)}\n`)
    }
  }

  mkdirSync(LAB, { recursive: true })
  const certificatePath = join(LAB, 'a3-smoke.json')
  const allOk = readings.every((reading) => reading.verdict === 'OK')
  writeFileSync(
    certificatePath,
    `${JSON.stringify(
      {
        schemaVersion: 'm9.5-a3-smoke@1',
        generatedAt: new Date().toISOString(),
        scope: {
          verifies: '三个候选**能不能真加载并编码**：布局 / 量化档可加载 / **输出维度等于声称维度** / 归一化后模长≈1',
          notProves:
            '**不**比较检索质量（那是 A3 对照本身）；**不**走生产受守卫子进程（本脚本进程内加载，`allowRemoteModels=false` 保持不出站）',
        },
        sentence: SENTENCE,
        modelRoot: MODEL_ROOT,
        readings,
        verdict: allOk ? 'OK' : 'FAILED',
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  process.stdout.write(`\n证书：${certificatePath}\n总判定：${allOk ? 'OK' : 'FAILED'}\n`)
  if (!allOk) process.exitCode = 3
}

await main()
