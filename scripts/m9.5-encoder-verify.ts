/**
 * M9.5 WP3 —— **编码器的可终止性、清单与资产门**（`pnpm m9.5:encoder:verify`）。
 *
 * ============================================================================
 *  它验的是什么（**D27 / D29 / D30**，与 `m9.5:embedding:verify` 不重复）
 * ============================================================================
 * ```text
 * `m9.5:embedding:verify`（WP1）：**进程内**的编码质量/离线边界（加载、维度、确定性、前缀…）。
 * 本门（WP3）：把它**搬进可终止的执行单元**之后必须成立的四件事 ——
 *   ① D27 **取消真的回收工作**：两面都要有读数
 *        负控（不取消）：任务确实在烧 CPU（子进程自报 cpuUserMs 很大 + 机器级利用率抬起）
 *        正控（取消）  ：SIGKILL 后**观察到进程退出**、**此后零输出**、机器级利用率落回
 *   ② D27 **硬截止**：超时 ⇒ 杀进程，而不是"等 Promise 超时、底层继续算"
 *   ③ D30 **清单与资产**：revision 必须是**不可变 sha**（拒绝 `main`）；资产字节数+sha256 逐个核对；
 *        计数型自检（核对了 0 个文件 ⇒ 不算通过）
 *   ④ **无孤儿**：子进程不派生任何子进程；关闭后 pid 消失
 * ```
 * ⚠️ 机器级 CPU 利用率在本机（24 核）偏粗，只作**独立佐证**；
 *    硬判据是"进程退出事件 + 杀之后零输出"（被杀掉的进程在结构上不可能继续计算）。
 *
 * 用法：`pnpm m9.5:encoder:verify`
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import {
  DEFAULT_EMBEDDING_MANIFEST_PATH,
  embeddingFingerprintOf,
  loadEmbeddingManifest,
  validateEmbeddingManifest,
  verifyEmbeddingAssets,
  type EmbeddingManifest,
} from '../src/infrastructure/semantic/embedding-manifest.ts'
import {
  cpuSnapshot,
  cpuUtilisationBetween,
  createEncoderClient,
} from '../src/infrastructure/semantic/encoder-client.ts'

import { sha256 } from './m4-harness.ts'
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
const GATE_VERSION = 'm9.5-encoder@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const LAB_MODEL_ROOT = join(REPO_ROOT, 'artifacts/m9.5/local/embedding-lab/models')

interface Probe {
  readonly id: string
  readonly question: string
  readonly verdict: 'ok' | 'unexpected'
  readonly reading: Record<string, unknown>
  readonly error: string | null
}

async function probe(input: {
  readonly id: string
  readonly question: string
  readonly run: () => Promise<Record<string, unknown>>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Promise<Probe> {
  try {
    const reading = await input.run()
    const problems = input.judge?.(reading) ?? []
    return {
      id: input.id,
      question: input.question,
      verdict: problems.length > 0 ? 'unexpected' : 'ok',
      reading,
      error: problems.length > 0 ? problems.join('; ') : null,
    }
  } catch (error) {
    return {
      id: input.id,
      question: input.question,
      verdict: 'unexpected',
      reading: {},
      error: (error as Error).message.replace(/\s+/g, ' ').slice(0, 240),
    }
  }
}

function gitOrNull(args: readonly string[]): string | null {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

function safeTreeDigest(): Record<string, unknown> | null {
  try {
    const digest = digestTree(REAL_DB_DIR)
    return { dir: 'data/pglite', measuredCount: digest.measuredCount, treeSha256: digest.treeSha256 }
  } catch (error) {
    return { dir: 'data/pglite', error: (error as Error).message }
  }
}

const sleep = async (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms))

/** 重活：足够大，好让"不取消会继续烧 CPU"这条负控真的有内容。 */
function heavyTexts(): string[] {
  return Array.from(
    { length: 192 },
    (_, i) =>
      `passage: 第 ${String(i)} 条重活样本。` + '这是一段用来把编码器压住的中文文本，长度足够触发多线程推理。'.repeat(4)
  )
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp3-encoder', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()

  const manifestPath = join(REPO_ROOT, DEFAULT_EMBEDDING_MANIFEST_PATH)
  const probes: Probe[] = []

  /* ---- ① 清单结构 + D30 的可变引用拒绝 ---- */
  probes.push(
    await probe({
      id: 'manifest-valid',
      question: '仓库清单结构合法，且能算出贯穿用的模型指纹',
      run: async () => {
        const manifest = loadEmbeddingManifest(manifestPath)
        return {
          problems: validateEmbeddingManifest(manifest),
          fingerprint: embeddingFingerprintOf(manifest),
          revision: manifest.revision,
          dimension: manifest.dimension,
          assetCount: manifest.assets.length,
          runtime: manifest.runtime,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if ((reading.problems as string[]).length > 0) problems.push(`清单不合法：${(reading.problems as string[]).join(' | ')}`)
        if (!/^[0-9a-f]{7,64}$/i.test(String(reading.revision))) problems.push('revision 不是 commit sha')
        if ((reading.fingerprint as string).length !== 32) problems.push('指纹长度异常')
        if (Number(reading.assetCount) !== 7) problems.push(`资产应为 7 个，实际 ${String(reading.assetCount)}`)
        return problems
      },
    })
  )

  probes.push(
    await probe({
      id: 'manifest-rejects-mutable-revision',
      question: 'D30 的正控：`revision: "main"` 必须被拒（可变引用不能充当冻结指纹）',
      run: async () => {
        const base = loadEmbeddingManifest(manifestPath)
        const mutated = { ...base, revision: 'main' } as EmbeddingManifest
        return { problems: validateEmbeddingManifest(mutated) }
      },
      judge: (reading) => {
        const problems = reading.problems as string[]
        return problems.some((text) => text.includes('可变引用'))
          ? []
          : [`没有报出"可变引用"问题：${JSON.stringify(problems)}`]
      },
    })
  )

  probes.push(
    await probe({
      id: 'manifest-rejects-missing-weights',
      question: '没有 *.onnx 的清单必须被拒（否则"校验通过"什么都没定位到）',
      run: async () => {
        const base = loadEmbeddingManifest(manifestPath)
        const mutated = {
          ...base,
          assets: base.assets.filter((asset) => !asset.path.endsWith('.onnx')),
        } as EmbeddingManifest
        return { problems: validateEmbeddingManifest(mutated) }
      },
      judge: (reading) => {
        const problems = reading.problems as string[]
        return problems.some((text) => text.includes('权重文件')) ? [] : [`没有报出缺权重：${JSON.stringify(problems)}`]
      },
    })
  )

  /* ---- ② 资产核对（含计数型自检） ---- */
  probes.push(
    await probe({
      id: 'assets-verify-ok',
      question: '本机资产逐个核对（字节数 + sha256 + 上游 LFS 哈希）全部通过',
      run: async () => {
        const manifest = loadEmbeddingManifest(manifestPath)
        const reading = verifyEmbeddingAssets(join(LAB_MODEL_ROOT, manifest.modelId), manifest)
        return { ...reading }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.verified) <= 0) problems.push('核对了 0 个文件 ⇒ MEASUREMENT INVALID')
        if (reading.ok !== true) problems.push(`核对未全过：${JSON.stringify(reading)}`)
        return problems
      },
    })
  )

  probes.push(
    await probe({
      id: 'assets-verify-detects-missing',
      question: '负控：资产目录不存在 ⇒ 必须报"全部缺失"且 ok=false（不是安静地通过）',
      run: async () => {
        const manifest = loadEmbeddingManifest(manifestPath)
        const reading = verifyEmbeddingAssets(join(LAB_MODEL_ROOT, 'does-not-exist'), manifest)
        return { ...reading }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.ok !== false) problems.push('目录不存在却报 ok=true')
        if ((reading.verified as number) !== 0) problems.push('目录不存在却有核对的项')
        if ((reading.missing as string[]).length !== (reading.total as number)) {
          problems.push('缺失清单不完整')
        }
        return problems
      },
    })
  )

  /* ---- ③ 真编码（经子进程） ---- */
  const manifest = loadEmbeddingManifest(manifestPath)
  const client = createEncoderClient({
    manifest,
    repoRoot: REPO_ROOT,
    localModelPath: LAB_MODEL_ROOT,
    deadlineMs: 120_000,
    readyTimeoutMs: 180_000,
  })

  probes.push(
    await probe({
      id: 'worker-ready-and-encode',
      question: '子进程就位并能编码：维度/有限性/归一化',
      run: async () => {
        const fingerprint = await client.fingerprintPromise
        const result = await client.encode(['passage: 我在写毕业论文。', 'query: 最近那个学业项目怎么样了？'])
        if (!result.ok) throw new Error(`编码失败：${result.reason} ${result.detail}`)
        const norms = result.vectors.map((vector) =>
          Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
        )
        return {
          pid: client.pid(),
          fingerprint,
          dimension: result.dimension,
          vectorCount: result.vectors.length,
          allFinite: result.vectors.every((vector) => vector.every((value) => Number.isFinite(value))),
          norms: norms.map((norm) => Number(norm.toFixed(6))),
          cpuUserMs: result.cpuUserMs,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (Number(reading.dimension) !== 384) problems.push(`维度 ${String(reading.dimension)} ≠ 384`)
        if (Number(reading.vectorCount) !== 2) problems.push('向量条数不对')
        if (reading.allFinite !== true) problems.push('出现非有限数')
        const norms = reading.norms as number[]
        if (!norms.every((norm) => Math.abs(norm - 1) < 1e-4)) problems.push(`范数未归一化：${JSON.stringify(norms)}`)
        if (String(reading.fingerprint).length !== 32) problems.push('指纹未从子进程透出')
        return problems
      },
    })
  )

  /* ---- ④ D27 负控：不取消 ⇒ 底层确实在烧 CPU ---- */
  let cpuUtilDuring = Number.NaN
  let negativeCpuUserMs = 0
  let negativeElapsedMs = 0
  probes.push(
    await probe({
      id: 'd27-negative-uncancelled-burns-cpu',
      question: 'D27 负控（不取消）：重活确实在烧 CPU —— 子进程自报 cpuUserMs 与机器级利用率都抬起',
      run: async () => {
        const before = cpuSnapshot()
        const started = Date.now()
        const work = client.encode(heavyTexts())
        await sleep(900)
        const during = cpuSnapshot()
        cpuUtilDuring = cpuUtilisationBetween(before, during)
        const result = await work
        negativeElapsedMs = Date.now() - started
        if (!result.ok) throw new Error(`重活未完成：${result.reason} ${result.detail}`)
        negativeCpuUserMs = result.cpuUserMs
        return {
          machineCpuUtilisationDuring: cpuUtilDuring,
          cpuUserMs: result.cpuUserMs,
          cpuSystemMs: undefined,
          elapsedMs: negativeElapsedMs,
          vectorCount: result.vectors.length,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (!(Number(reading.cpuUserMs) > 500)) {
          problems.push(`重活的 cpuUserMs=${String(reading.cpuUserMs)} 太小 ⇒ 负控没有内容（不取消时"继续烧 CPU"没有被证明）`)
        }
        if (!(Number(reading.machineCpuUtilisationDuring) > 0)) {
          problems.push(`机器级利用率读数无效：${String(reading.machineCpuUtilisationDuring)}`)
        }
        return problems
      },
    })
  )

  /* ---- ⑤ D27 正控：取消 ⇒ 硬截止杀进程 + 观察到退出 + 杀之后零输出 + 利用率落回 ---- */
  probes.push(
    await probe({
      id: 'd27-positive-kill-reclaims',
      question:
        'D27 正控（取消）：硬截止 ⇒ SIGKILL；观察到进程退出；**杀之后零输出**；机器级利用率明显落回',
      run: async () => {
        const killsBefore = client.reclaimLog.kills.length
        const exitsBefore = client.reclaimLog.exits.length
        const shortDeadlineClient = createEncoderClient({
          manifest,
          repoRoot: REPO_ROOT,
          localModelPath: LAB_MODEL_ROOT,
          deadlineMs: 400,
          readyTimeoutMs: 180_000,
        })
        await shortDeadlineClient.fingerprintPromise
        const result = await shortDeadlineClient.encode(heavyTexts())
        /*
         * ⚠️ 量具时序：子进程的 `exit` 事件是**异步**送达的 —— 第一版在 `encode()` 返回后
         * **立刻**读观察记录，于是读到"没有退出"，被误判成"工作没被回收"。
         * ⇒ 必须先给它落地的时间，再读读数（否则量具测的是自己的竞态，不是被测性质）。
         */
        await sleep(500)
        const killAt = shortDeadlineClient.reclaimLog.kills[0]?.at ?? -1
        const exitAfterKill = shortDeadlineClient.reclaimLog.exits.filter((item) => item.at >= killAt)
        /* 杀之后静置，再看机器级利用率是否落回 */
        await sleep(200)
        const afterKillSnapshot = cpuSnapshot()
        await sleep(1000)
        const settledSnapshot = cpuSnapshot()
        const utilAfterKill = cpuUtilisationBetween(afterKillSnapshot, settledSnapshot)
        const outputsAfterKill = shortDeadlineClient.reclaimLog.outputsAfterKill
        const pid = shortDeadlineClient.pid()
        await shortDeadlineClient.close()
        await sleep(150)
        return {
          result: { ok: result.ok, reason: result.ok ? null : result.reason, detail: result.ok ? null : result.detail },
          killsBefore,
          exitsBefore,
          killCount: shortDeadlineClient.reclaimLog.kills.length,
          exitAfterKillCount: exitAfterKill.length,
          exitSignal: exitAfterKill[0]?.signal ?? null,
          outputsAfterKill,
          machineCpuUtilisationAfterKill: utilAfterKill,
          machineCpuUtilisationDuringHeavyJob: cpuUtilDuring,
          pidBeforeClose: pid,
          pidAfterClose: shortDeadlineClient.pid(),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        const result = reading.result as { ok?: boolean; reason?: string | null }
        if (result.ok !== false) problems.push('短截止下编码竟然成功了（硬截止未生效）')
        if (result.reason !== 'encode_timeout') problems.push(`失败原因应为 encode_timeout，实际 ${String(result.reason)}`)
        if (Number(reading.killCount) < 1) problems.push('没有观察到 kill 动作')
        if (Number(reading.exitAfterKillCount) < 1) {
          problems.push('★ 杀之后**没有观察到进程退出** ⇒ 无法证明工作被回收')
        }
        if (reading.outputsAfterKill !== 0) {
          problems.push(`★ 杀之后仍有 ${String(reading.outputsAfterKill)} 行输出 ⇒ 底层还在跑`)
        }
        if (Number(reading.pidAfterClose) !== null && reading.pidAfterClose !== null) {
          problems.push('关闭后子进程 pid 仍在 ⇒ 有孤儿')
        }
        if (!(Number(reading.machineCpuUtilisationAfterKill) < Number(reading.machineCpuUtilisationDuringHeavyJob))) {
          problems.push(
            `独立佐证未成立：杀之后利用率 ${String(reading.machineCpuUtilisationAfterKill)} 未低于进行中 ${String(reading.machineCpuUtilisationDuringHeavyJob)}`
          )
        }
        return problems
      },
    })
  )

  /* ---- ⑥ 回收之后机器不卡：新 worker 的延迟回到基线下 ---- */
  probes.push(
    await probe({
      id: 'latency-after-reclaim',
      question: '取消回收之后，新起的 worker 编码延迟回到正常量级（机器没有被继续占满）',
      run: async () => {
        const fresh = createEncoderClient({
          manifest,
          repoRoot: REPO_ROOT,
          localModelPath: LAB_MODEL_ROOT,
          deadlineMs: 120_000,
          readyTimeoutMs: 180_000,
        })
        await fresh.fingerprintPromise
        const samples = await fresh.sampleLatency(5)
        await fresh.close()
        const sorted = [...samples].sort((a, b) => a - b)
        return {
          samples,
          median: sorted[Math.floor(sorted.length / 2)] ?? null,
          max: sorted[sorted.length - 1] ?? null,
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        const samples = reading.samples as number[]
        if (samples.length < 5) problems.push(`采样不足：${String(samples.length)}`)
        if (!(Number(reading.median) <= 1500)) {
          problems.push(`中位延迟 ${String(reading.median)} ms 过高 ⇒ 机器可能仍被占满`)
        }
        return problems
      },
    })
  )

  probes.push(
    await probe({
      id: 'no-orphans-after-close',
      question: '关闭后父进程不再持有任何子进程（结构性无孤儿）',
      run: async () => {
        await client.close()
        await sleep(200)
        return { pidAfterClose: client.pid(), kills: client.reclaimLog.kills.length, exits: client.reclaimLog.exits.length }
      },
      judge: (reading) => {
        const problems: string[] = []
        if (reading.pidAfterClose !== null) problems.push('关闭后仍有子进程 pid')
        if (Number(reading.exits) < 1) problems.push('没有观察到任何退出事件')
        return problems
      },
    })
  )

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })
  const realDbAfter = safeTreeDigest()
  const realDbUnchanged = JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter)

  const payload = {
    schemaVersion: 'm9.5-encoder@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      d27: '可终止执行单元 + 硬截止 + 两端（负控/正控）回收证据',
      d29: '运行时按路径解析（失败关闭），生产 package.json 保持 NONE',
      d30: '清单 revision 为不可变 sha；资产逐字节+sha256 核对',
      notProves: '**不**证明语义质量（那属 WP6/WP10）；也**不**证明并发多 worker 下的行为',
    },
    manifestFingerprint: embeddingFingerprintOf(manifest),
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'encoder-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPathOut = writeM95Manifest(runDir, {
    runId,
    stage: 'wp3',
    lane: 'live',
    startedAt: STARTED_AT,
    completedAt: new Date().toISOString(),
    head: gitOrNull(['rev-parse', 'HEAD']),
    headShort,
    branch: gitOrNull(['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyPaths: dirtyPaths(REPO_ROOT),
    sourceTreeHash: tree.treeSha256,
    sourceTreeHashDefinition: tree.definition,
    gateVersion: GATE_VERSION,
    dbKind: 'not-applicable',
    isolationProof: {
      dbTouched: false,
      method: '**构造属性**：本门不 import 任何数据库模块；真实库只做只读树摘要',
    },
    configHash: { deadlineMs: 120_000, manifest: DEFAULT_EMBEDDING_MANIFEST_PATH, dtype: manifest.dtype },
    command: [{ cmd: 'pnpm m9.5:encoder:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    modelFingerprint: embeddingFingerprintOf(manifest),
    artifactHashes: { 'encoder-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP3 编码器门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  真实库前后摘要相同：${String(realDbUnchanged)}`,
      `  清单：${manifestPathOut}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
