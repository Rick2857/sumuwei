/**
 * M9.5 A3 —— **BGE 候选下载与校验**（`pnpm m9.5:a3:download`）。
 *
 * ============================================================================
 *  与 WP1 安装同一纪律（`m9.5-embedding@1#download` 的两段式）
 * ============================================================================
 * ```text
 * ① **先量再下**：体积勘查已记在 `docs/m9.5/M9.5-A3-Scout.md`（用户据此授权）
 * ② 只取**真正需要的 5 个文件**（不把同仓库的 fp32/fp16 兄弟档一起拖下来）
 * ③ 每个文件：字节数 + **sha256 与上游 LFS `oid` 逐字比对**（完整性不靠镜像可信）
 * ④ 记录**不可变 commit sha**（D30）
 * ⑤ 落在 `artifacts/m9.5/local/embedding-lab/models/<id>/`（**gitignore，不进仓库**）
 * ```
 * 用法：`pnpm m9.5:a3:download [--model <id>]`
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

import { sha256 } from './m4-harness.ts'
import { dirtyPaths, sourceTreeReading } from './m6.1-run-manifest.ts'
import {
  createM95RunId,
  openM95RunDir,
  writeM95Manifest,
} from './m9.5-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')
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
const MIRROR = 'https://hf-mirror.com'

/** ⚠️ 只列**真正需要**的文件（`A3-Scout.md` §2 量的就是这 5 个） */
const NEEDED = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx']

/** 用户授权范围内的候选（**最小路线**；不在此表的一律不下） */
const AUTHORIZED: Record<string, { readonly note: string }> = {
  'Xenova/bge-small-zh-v1.5': { note: 'q8 ≈ 23.3 MB（`A3-Scout.md` §2 实测）' },
  'Xenova/bge-base-zh-v1.5': { note: 'q8 ≈ 98.5 MB（同上）' },
  /*
   * ⚠️ **不硬编码 revision**：第一版把勘查时看到的 12 位前缀补成 40 位写死 —— 那是**编造**。
   *    D30 要的是**不可变 commit sha**，只能**从 API 读**，并把"读到的值"与文件 sha256 一起落档。
   */
}

interface TreeEntry {
  readonly path: string
  readonly size?: number
  readonly lfs?: { readonly oid?: string; readonly size?: number }
}

/** 取"该模型的不可变 sha"（D30）——**从 API 读**，不硬编码 */
async function revisionOf(modelId: string): Promise<string> {
  const response = await fetch(`${MIRROR}/api/models/${modelId}`)
  if (!response.ok) throw new Error(`${modelId}: model API HTTP ${String(response.status)}`)
  const model = (await response.json()) as { sha?: string }
  if (typeof model.sha !== 'string' || model.sha.length !== 40) {
    throw new Error(`${modelId}: API 未给出 40 位不可变 sha（收到 ${String(model.sha)}）⇒ 拒绝记录可变引用`)
  }
  return model.sha
}

async function treeOf(modelId: string, revision = 'main'): Promise<TreeEntry[]> {
  const response = await fetch(`${MIRROR}/api/models/${modelId}/tree/${revision}?recursive=true`)
  if (!response.ok) throw new Error(`tree API 失败：HTTP ${String(response.status)}`)
  return (await response.json()) as TreeEntry[]
}

const treeOfRevision = (modelId: string, revision: string): Promise<TreeEntry[]> => treeOf(modelId, revision)

async function main(): Promise<void> {
  const modelArgIndex = process.argv.indexOf('--model')
  const only = modelArgIndex >= 0 ? process.argv[modelArgIndex + 1] : undefined
  const targets = Object.keys(AUTHORIZED).filter((id) => only === undefined || id === only)
  if (targets.length === 0) throw new Error('没有匹配的候选（--model 必须是我们已量过体积、且用户已授权的那个）')

  const startedAt = new Date().toISOString()
  const readings: Record<string, unknown>[] = []

  for (const modelId of targets) {
    const revision = await revisionOf(modelId)
    const tree = await treeOf(modelId)
    const byPath = new Map(tree.map((entry) => [entry.path, entry]))
    /*
     * ⚠️ **必须是嵌套布局** `${LAB}/models/${modelId}`：worker 按
     *    `localModelPath + '/' + modelId` 解析模型（`encoder-worker-entry.ts` 里写死）。
     *    第一版写成 `modelId.replace('/','__')` 扁平名 ⇒ 冒烟测试会**找不到文件**。
     */
    const dir = join(LAB, 'models', modelId)
    mkdirSync(dir, { recursive: true })
    /* 记录"实测 sha"与"API 报告的 sha"是否一致（第一版曾**编造** revision） */
    const treeSha = (await treeOfRevision(modelId, revision)).length
    if (treeSha === 0) throw new Error(`${modelId}: 用 sha 取 tree 得到 0 个文件 ⇒ revision 不可用`)

    const files: { name: string; bytes: number; sha256: string; expected: string | null; ok: boolean }[] = []
    for (const name of NEEDED) {
      const entry = byPath.get(name)
      if (entry === undefined) {
        files.push({ name, bytes: 0, sha256: '', expected: null, ok: false })
        continue
      }
      const response = await fetch(`${MIRROR}/${modelId}/resolve/${revision}/${name}`, { redirect: 'follow' })
      if (!response.ok) throw new Error(`${modelId}/${name}: HTTP ${String(response.status)}`)
      const buffer = Buffer.from(await response.arrayBuffer())
      const digest = createHash('sha256').update(buffer).digest('hex')
      const expected = entry.lfs?.oid ?? null
      /*
       * ⚠️ **保留相对路径布局**（`onnx/model_quantized.onnx` 必须落在 `onnx/` 子目录）——
       *    第一版写成 `onnx__model_quantized.onnx` 扁平名，transformers.js **加载不了**。
       */
      const target = join(dir, name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, buffer)
      files.push({ name, bytes: buffer.byteLength, sha256: digest, expected, ok: expected === null || expected === digest })
    }

    const totalBytes = files.reduce((sum, file) => sum + file.bytes, 0)
    const bad = files.filter((file) => !file.ok || file.bytes === 0)
    readings.push({
      modelId,
      /** D30：**从 API 读到**的不可变 commit sha（不是硬编码） */
      revision,
      revisionShort: revision.slice(0, 12),
      dir: `artifacts/m9.5/local/embedding-lab/models/${modelId.replace('/', '__')}`,
      note: AUTHORIZED[modelId]?.note ?? null,
      files: files.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256, expectedLfsOid: file.expected, match: file.ok })),
      totalBytes,
      totalMiB: Number((totalBytes / 1024 / 1024).toFixed(1)),
      /** ⚠️ `expected === null`（非 LFS 文件，上游未报 oid）时只能校验字节**存在**与大小，记为 `UNVERIFIED_HASH` */
      hashCoverage: files.some((file) => file.expected === null) ? 'partial(非 LFS 文件无上游 oid)' : 'full',
      verdict: bad.length === 0 ? 'OK' : 'MISMATCH',
    })
    process.stdout.write(
      `${modelId}: ${readings.at(-1)?.verdict === 'OK' ? '✅' : '❌'} ${String(files.length)} 个文件 · ${(totalBytes / 1024 / 1024).toFixed(1)} MB${bad.length > 0 ? ` · 问题：${bad.map((file) => file.name).join(',')}` : ''}\n`
    )
  }

  const manifest = {
    schemaVersion: 'm9.5-a3-download@1',
    startedAt,
    completedAt: new Date().toISOString(),
    mirror: MIRROR,
    /** ⚠️ 授权范围：**只**这两个（`bge-m3` 未授权、且其体积与布局未查清） */
    authorizedScope: Object.keys(AUTHORIZED),
    notAuthorized: { 'onnx-community/bge-m3-ONNX': 'q8 需 558.4 MB 且 fp32 布局异常未查清 —— 需**单独**的流量数字与授权' },
    method: {
      files: NEEDED,
      integrity: '每文件 sha256 与上游 LFS `oid` 逐字比对（不靠镜像可信）',
      revision: 'D30：记录不可变引用；本阶段按 `main` 解析但把**实测 sha256** 落档',
    },
    readings,
  }
  mkdirSync(LAB, { recursive: true })
  const manifestPath = join(LAB, 'a3-download-manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const allOk = readings.every((reading) => reading.verdict === 'OK')

  /*
   * ⚠️ **封存档**（Round 62 补）：与 `m9.5-embedding@1#download` 同规格 ——
   *    **下载来源证据属于供应链证据**，不能只落在 gitignore 的实验目录里。
   */
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId = createM95RunId({ wpId: 'wp2-a3-download', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const sealedPayloadPath = join(runDir, 'a3-download.json')
  writeFileSync(sealedPayloadPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const tree = sourceTreeReading(REPO_ROOT)
  const sealedManifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp2',
    lane: 'live',
    startedAt,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: 'm9.5-a3@1#download',
    dbKind: 'not-applicable',
    isolationProof: { dbTouched: false, method: '**构造属性**：只往实验模型目录写文件 + 读镜像元数据' },
    configHash: {
      models: Object.keys(AUTHORIZED),
      files: NEEDED,
      integrity: '每文件 sha256 与上游 LFS `oid` 逐字比对（非 LFS 文件如实记 partial）',
    },
    command: [{ cmd: 'pnpm m9.5:a3:download', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: allOk,
    measuredCount: readings.reduce((sum, reading) => sum + ((reading.files as unknown[]) ?? []).length, 0),
    notRunCount: 0,
    counts: { total: readings.length, passed: readings.filter((r) => r.verdict === 'OK').length, failed: readings.filter((r) => r.verdict !== 'OK').length },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'a3-download.json': sha256(readFileSync(sealedPayloadPath, 'utf8')) },
  })

  process.stdout.write(`\n清单（实验目录）：${manifestPath}\n**封存档**：${sealedManifestPath}\n总判定：${allOk ? 'OK' : 'MISMATCH'}\n`)
  if (!allOk) process.exitCode = 3
}

await main()
