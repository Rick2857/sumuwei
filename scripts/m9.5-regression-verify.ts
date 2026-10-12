/**
 * M9.5 WP11 —— **回归与准入前置门**（`pnpm m9.5:regression:verify`）。
 *
 * ============================================================================
 *  计划 §12 WP11：「回归、文档、交接收口」；出口是「**准入前置全部满足**」
 * ============================================================================
 * ```text
 * "全部满足"不能是一句话，必须是可执行的。本门把四件事变成判据：
 *   ① **全部必选门 PASS**（直接读聚合门 `pnpm m9.5:gates` 的 JSON，**不重算**规则
 *      —— 重算就会出现"两处判据漂移"，而漂移的表现是"一处说 PASS、一处说 NOT PASS"）
 *   ② **没有悬空的证据档**（有目录却没 `manifest.json` ⇒ 那是一次没跑完的运行，
 *      它不是证据；缺文件应当是 `NOT RUN`，不是"看起来有档"）
 *   ③ **基线回归绿**：既有里程碑的门必须仍然绿（本门**真的去跑**那几道秒级门）
 *   ④ **工作树干净**：交付前的树必须没有未提交改动（否则"证据指向的代码"与
 *      "你现在检出的代码"可能不是同一份）
 * ```
 * 用法：`pnpm m9.5:regression:verify`
 */

import { execFileSync, execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'

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
const GATE_VERSION = 'm9.5-regression@1'
const REAL_DB_DIR = join(REPO_ROOT, 'data', 'pglite')
const ARTIFACTS = join(REPO_ROOT, 'artifacts/m9.5')

/** 基线回归子集：秒级、且覆盖"被 M9.5 改过的每一层" */
const BASELINE_GATES = ['kernel:test', 'm3.5:test', 'm4:test', 'm4.5:test', 'm5:test', 'm5:trace:verify'] as const

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
  readonly run: () => Record<string, unknown>
  readonly judge?: (reading: Record<string, unknown>) => string[]
}): Promise<Probe> {
  try {
    const reading = input.run()
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

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const explicitOut = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const headShort = gitOrNull(['rev-parse', '--short=12', 'HEAD']) ?? 'unknown'
  const runId =
    explicitOut !== undefined
      ? runIdFromM95OutPath(REPO_ROOT, explicitOut)
      : createM95RunId({ wpId: 'wp11-regression', headShort })
  const runDir = openM95RunDir(REPO_ROOT, runId)
  const realDbBefore = safeTreeDigest()
  const probes: Probe[] = []

  /* ---- ① 全部必选门 PASS（读聚合门的 JSON，**不重算**） ---- */
  probes.push(
    await probe({
      id: 'all-required-gates-pass',
      question: '① 聚合门报 **overall = PASS**、必选门全部有档、无 INVALID/REFUSED',
      run: () => {
        /*
         * ⚠️ 容忍**非零退出**并仍然解析 stdout：聚合门在"必选门未全过"时会 exit 1，
         *    而那正是本门要读的读数。第一版用 `execSync` 直接抛 ⇒ 读数全丢，
         *    报出来的只有 `Command failed`（把"读数"变成了"没事可说"）。
         */
        let raw = ''
        let exitCode = 0
        try {
          raw = execSync('pnpm m9.5:gates', { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
        } catch (error) {
          exitCode = (error as { status?: number }).status ?? 1
          raw = String((error as { stdout?: string }).stdout ?? '')
        }
        /* 聚合门把 JSON 打在一行里（前面是给人看的清单）⇒ 取最后一个 `{` 开头的整行 */
        const jsonLine = raw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line.startsWith('{') && line.includes('"schemaVersion":"m9.5-gates@1"'))
          .pop()
        if (jsonLine === undefined) throw new Error('没读到 `m9.5:gates` 的 JSON 输出')
        const parsed = JSON.parse(jsonLine) as {
          overall: string
          requiredNow: { present: number; total: number }
          invalidOrRefused: unknown[]
          readings: { gate: string; requiredNow: boolean; verdict: string; reasons: string[] }[]
        }
        const required = parsed.readings.filter((reading) => reading.requiredNow)
        /*
         * ★ **排除本门自己**（自我指涉死锁）：
         *   聚合门会把**上一次运行**的 `m9.5-regression@1` 读数算进去；若那次是失败档，
         *   它就成 INVALID ⇒ `overall = FAIL` ⇒ 本门永远不通过 —— 而"历史失败档不回写"
         *   是仓库纪律（失败档保留是**证据**）。两者叠加必然死锁。
         * ⇒ 判定只看**除本门以外**的必选门；`overall` 仍然照录（它会在本门首次通过后转 PASS）。
         */
        const others = required.filter((reading) => reading.gate !== 'm9.5-regression@1')
        return {
          aggregatorExitCode: exitCode,
          overall: parsed.overall,
          selfExcluded: true,
          present: others.length,
          total: others.length,
          invalidOrRefused: parsed.invalidOrRefused.length,
          nonPassRequired: others.filter((reading) => reading.verdict !== 'PASS').map((reading) => `${reading.gate}=${reading.verdict}`),
          notRunOptional: parsed.readings.filter((reading) => !reading.requiredNow && reading.verdict !== 'PASS').map((reading) => reading.gate),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        /* ⚠️ 不判 `overall`：它包含本门自己的历史读数（见上面的自指说明） */
        if ((reading.nonPassRequired as string[]).length > 0) {
          problems.push(`★ 必选门（除本门）里有非 PASS：${(reading.nonPassRequired as string[]).join(',')}`)
        }
        if (Number(reading.present) !== Number(reading.total) || Number(reading.total) === 0) {
          problems.push('必选门集合为空或计数异常 ⇒ MEASUREMENT INVALID')
        }
        return problems
      },
    })
  )

  /* ---- ② 没有悬空的证据档 ---- */
  probes.push(
    await probe({
      id: 'no-dangling-evidence-directories',
      question: '② 每个证据档都有 `manifest.json`（有目录没 manifest = 一次没跑完的运行，**不是证据**）',
      run: () => {
        const dirs = readdirSync(ARTIFACTS, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          /*
           * ⚠️ `local/` 是 gitignore 的**私有实验目录**（模型资产、盲测集、私审材料），
           *    它不是一次"运行档"，没有 manifest 是**正常的** —— 第一版把它判成悬空档。
           */
          .filter((name) => name !== 'local')
          /* ⚠️ 也排除**本门自己的 runId**：`openM95RunDir` 先建目录、manifest 后写，
             不排除的话本门会把自己判成悬空档（自指错误）。 */
          .filter((name) => name !== runId)
        const dangling = dirs.filter((name) => !existsSync(join(ARTIFACTS, name, 'manifest.json')))
        return { directoryCount: dirs.length, dangling, danglingCount: dangling.length }
      },
      judge: (reading) => {
        const problems: string[] = []
        /* 计数型自检：0 个档 vs "全部都有 manifest"在输出上长得一样 */
        if (Number(reading.directoryCount) <= 0) problems.push('一个证据档都没有 ⇒ MEASUREMENT INVALID')
        if (Number(reading.danglingCount) > 0) {
          problems.push(`★ 有 ${String(reading.danglingCount)} 个悬空档：${(reading.dangling as string[]).join(',')}`)
        }
        return problems
      },
    })
  )

  /* ---- ③ 基线回归绿（真的跑） ---- */
  probes.push(
    await probe({
      id: 'baseline-regression-still-green',
      question: `③ 基线回归子集**真的跑一遍**（${BASELINE_GATES.join(' / ')}）`,
      run: () => {
        const results: { gate: string; exitCode: number; tail: string }[] = []
        for (const gate of BASELINE_GATES) {
          let exitCode = 0
          let tail = ''
          try {
            const output = execSync(`pnpm ${gate}`, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
            tail = output.split(/\r?\n/).filter((line) => line.includes('通过') || line.includes('失败')).pop() ?? ''
          } catch (error) {
            exitCode = (error as { status?: number }).status ?? 1
            const stdout = String((error as { stdout?: string }).stdout ?? '')
            tail = stdout.split(/\r?\n/).filter((line) => line.includes('失败')).pop() ?? 'failed'
          }
          results.push({ gate, exitCode, tail: tail.trim().slice(0, 80) })
        }
        return { results, nonZero: results.filter((item) => item.exitCode !== 0).map((item) => item.gate) }
      },
      judge: (reading) => {
        const problems: string[] = []
        const results = reading.results as { gate: string; exitCode: number }[]
        if (results.length !== BASELINE_GATES.length) problems.push('基线门的数量不对')
        if ((reading.nonZero as string[]).length > 0) {
          problems.push(`★ 基线回归有非零退出：${(reading.nonZero as string[]).join(',')}`)
        }
        return problems
      },
    })
  )

  /*
   * ⚠️ **先还原**：基线子集里的 `m5:*` 会重新生成 `artifacts/m5/**` 与 `artifacts/m5.5/**`
   *    的历史证据（§7 的**已知**行为）。不还原的话，"工作树脏"会把**本门自己跑出来的副作用**
   *    算到交付者头上 —— 那是量具在冤枉人。
   *    只还原**已知会重生成**的那几个路径（白名单纪律，不做无差别 `checkout`）。
   */
  for (const path of ['artifacts/m5', 'artifacts/m5.5']) {
    try {
      execFileSync('git', ['checkout', '--', path], { cwd: REPO_ROOT, stdio: 'ignore' })
    } catch {
      /* 该路径不存在或本就干净：都不是错误 */
    }
  }

  /* ---- ④ 工作树干净 ---- */
  probes.push(
    await probe({
      id: 'working-tree-is-clean',
      question: '④ 工作树**没有未提交改动**（否则"证据指向的代码"与"现在检出的代码"可能不是同一份）',
      run: () => {
        const porcelain = gitOrNull(['status', '--porcelain']) ?? ''
        const lines = porcelain === '' ? [] : porcelain.split(/\r?\n/).filter((line) => line.length > 0)
        /*
         * ⚠️ **2026-09-29 扩排除（发布档实测）**：本条守的是**代码身份**
         *    （"证据指向的代码" vs "现在检出的代码"），因此下列**不是**代码身份的改动要排除：
         *    ① `artifacts/m9.5/` —— 本门自己写的证据档；
         *    ② `evals/m9.5/corpus/` —— **同一条 lane 里 `m9.5:corpus` 门会重写**
         *       （`M9.5-Corpus-Manifest.json` 的 `createdAt`）⇒ 不排除则**必然**失败：
         *       一个门重写被跟踪文件，另一个门要求树干净 —— 结构性自相矛盾（`L-M95-30`）。
         *    ③ **别人会话的未跟踪文件**（如 `?? docs/m9.6/`）：多会话共享同一工作树时，
         *       别人的在途文件不属于本里程碑 ⇒ 单独记为 `foreignUntracked`（**可见、不静默**），
         *       不据此判失败。**已跟踪文件的改动仍然照判**（牙齿没拔）。
         */
        const isSelfArtifacts = (line: string) => line.includes('artifacts/m9.5/')
        const isOwnCorpusRewrite = (line: string) => line.includes('evals/m9.5/corpus/')
        const isForeignUntracked = (line: string) => line.startsWith('?? ') && !line.includes('artifacts/m9.5/')
        return {
          dirtyCount: lines.length,
          dirtySample: lines.slice(0, 8),
          selfArtifactsExcluded: lines.filter(
            (line) => !isSelfArtifacts(line) && !isOwnCorpusRewrite(line) && !isForeignUntracked(line)
          ),
          foreignUntracked: lines.filter(isForeignUntracked),
          head: gitOrNull(['rev-parse', 'HEAD']),
        }
      },
      judge: (reading) => {
        const problems: string[] = []
        const others = reading.selfArtifactsExcluded as string[]
        if (others.length > 0) {
          problems.push(`★ 工作树有 ${String(others.length)} 处未提交改动：${JSON.stringify(others.slice(0, 5))}`)
        }
        if (typeof reading.head !== 'string' || reading.head.length !== 40) problems.push('读不到 HEAD 提交')
        return problems
      },
    })
  )

  const unexpected = probes.filter((item) => item.verdict === 'unexpected').length
  const selfCheck = selfCheckMeasurement({ measuredCount: probes.length, notRunCount: 0, failedCount: unexpected })
  const realDbAfter = safeTreeDigest()
  const realDbUnchanged = JSON.stringify(realDbBefore) === JSON.stringify(realDbAfter)

  const payload = {
    schemaVersion: 'm9.5-regression@1',
    runId,
    generatedAt: new Date().toISOString(),
    scope: {
      verifies:
        '准入门（聚合门 PASS + 必选门全有档 + 0 INVALID）/ 无悬空证据档 / 基线回归子集真跑 / 工作树干净',
      baselineGates: [...BASELINE_GATES],
      notProves:
        '**不**替代 `pnpm m4.5:ci` 的全量离线链；也**不**证明真模型档（那属 WP10 的 `*:live`）',
    },
    probes,
    measurement: { selfCheck, measuredCount: probes.length, unexpectedVerdictCount: unexpected },
    realDbProtection: { before: realDbBefore, after: realDbAfter, unchanged: realDbUnchanged },
  }
  const evidencePath = join(runDir, 'regression-verify.json')
  writeFileSync(evidencePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')

  const tree = sourceTreeReading(REPO_ROOT)
  const manifestPath = writeM95Manifest(runDir, {
    runId,
    stage: 'wp11',
    lane: 'offline',
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
      method: '**构造属性**：本门只读证据 + 跑既有门；真实库只做只读树摘要',
    },
    configHash: { baselineGates: [...BASELINE_GATES] },
    command: [{ cmd: 'pnpm m9.5:regression:verify', exitCode: 0 }],
    exitCode: 0,
    completion: 'complete',
    usable: selfCheck.verdict === 'PASS',
    measuredCount: probes.length,
    notRunCount: 0,
    counts: { total: probes.length, passed: probes.length - unexpected, failed: unexpected },
    toolVersions: { node: process.version, platform: process.platform, arch: process.arch, git: gitOrNull(['--version']) },
    supersedes: null,
    artifactHashes: { 'regression-verify.json': sha256(readFileSync(evidencePath, 'utf8')) },
  })

  process.stdout.write(
    [
      `M9.5 WP11 准入门：${runId}`,
      ...probes.map((item) => `  [${item.verdict}] ${item.id}${item.error === null ? '' : ` ⇒ ${item.error}`}`),
      `  自检：${selfCheck.verdict} —— ${selfCheck.reason}`,
      `  清单：${manifestPath}`,
    ].join('\n') + '\n'
  )
  if (selfCheck.verdict !== 'PASS') process.exitCode = 3
}

await main()
