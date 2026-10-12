/**
 * M9.5 **启用计划 / WP6 前置冒烟** —— **真编码器**在这台机器上真的能出向量吗？
 *
 * ```text
 * 为什么需要它：WP2-B 的门用的是**夹具编码器**，所以"真模型编码"从来没跑过这条写侧路径。
 * WP6（生产副本预演）之前必须先回答这个**前置问题**，而且要在**不碰真实库**的前提下回答。
 * ⇒ 本脚本：加载冻结清单 → 起真 worker（`.pnpm` 路径解析）→ 编 3 段文本 →
 *   逐条过 `validateSemanticVector()` → 打印维度/耗时/指纹。
 * ```
 *
 * ⚠️ **不注册进 package.json / 任何 gate**（它会加载 134 MiB 模型、秒级~分钟级、且依赖 `.pnpm` 副本）——
 * 与 `scripts/m9.5-semantic-index-readback.ts` 同一条纪律。
 * ⚠️ **不打开任何数据库**：它只回答"编码器能不能用"。
 *
 * 用法：`pnpm exec tsx scripts/m9.5-encoder-smoke.ts`
 */

import 'dotenv/config'

import { join } from 'node:path'

import { createEncoderClient } from '../src/infrastructure/semantic/encoder-client.ts'
import { embeddingFingerprintOf, loadEmbeddingManifest } from '../src/infrastructure/semantic/embedding-manifest.ts'
import { validateSemanticVector } from '../src/infrastructure/persistence/memory-semantic-index.ts'
import { renderMemoryForIndex, renderQueryForIndex } from '../src/kernel/app/recall/index-render.ts'

const REPO_ROOT = process.cwd()
const manifest = loadEmbeddingManifest(join(REPO_ROOT, 'evals/m9.5/embedding-manifest.json'))
const fingerprint = embeddingFingerprintOf(manifest)

/* ⚠️ 走**生产渲染器**（WP1），而不是手拼串 —— 这样冒烟测的就是真链路的那段文本 */
const passageOf = (predicate: string, value: unknown): string => {
  const rendered = renderMemoryForIndex({
    status: 'active',
    content: { kind: 'claim', predicate, value },
  } as never)
  if (!rendered.ok) throw new Error(`渲染失败：${rendered.reason}`)
  return rendered.rendered.text
}

const texts = [
  passageOf('education.institution', '示例工程科技大学'),
  passageOf('preference.explanation_style', 'brief'),
  renderQueryForIndex('我在哪所大学'),
]

const client = createEncoderClient({
  manifest,
  repoRoot: REPO_ROOT,
  localModelPath: join(REPO_ROOT, 'artifacts', 'm9.5', 'local', 'embedding-lab', 'models'),
  deadlineMs: 120_000,
})

try {
  const warm = await client.warmup()
  process.stdout.write(`warmup: ok=${String(warm.ok)} coldLoadMs=${String(warm.coldLoadMs)} ${warm.detail}\n`)
  const started = Date.now()
  const result = await client.encode(texts)
  const elapsed = Date.now() - started
  if (!result.ok) {
    process.stdout.write(`❌ 编码失败：${result.reason} —— ${result.detail}\n`)
    process.exitCode = 3
  } else {
    const problems = result.vectors.map((vector) => validateSemanticVector(vector))
    process.stdout.write(
      [
        `指纹        ${fingerprint}`,
        `维度        ${String(result.dimension)}（清单声明 ${String(manifest.dimension)}）`,
        `条数        ${String(result.vectors.length)} · 耗时 ${String(elapsed)} ms（批 p50 参考 9 ms/8 条）`,
        `校验        ${problems.every((p) => p === null) ? '全部通过 validateSemanticVector()' : `❌ ${problems.filter((p) => p !== null).join(' / ')}`}`,
        ...texts.map((text, index) => `  [${String(index)}] ${text}`),
        '',
      ].join('\n')
    )
    if (result.dimension !== manifest.dimension || problems.some((p) => p !== null)) process.exitCode = 3
  }
} finally {
  await client.close()
}
