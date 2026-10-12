/**
 * Lv2 WP5 —— **真实重启**的编排器（`pnpm lv2:restart:preflight`；计划 §`LV2-G5` 的"重启"那一段）。
 *
 * ============================================================================
 *  它做什么（这就是"真实进程边界"）
 * ============================================================================
 * ① 起**第一个进程**跑第 1…K 轮（它自己 `isolateDatabase()` 建沙箱，跑完 `close()` 并**退出**）
 * ② 起**第二个进程**（全新进程）用 `PROJECT_LG_SANDBOX=<同一个目录>` 接手，跑第 K+1…N 轮
 * ③ 对账**跨进程连续性**：第一段末的状态指纹 `STATE_SHA` 必须等于第二段接手时打印的
 *    `INITIAL_STATE_SHA` —— 不等就说明"重启后状态没接上"（那正是这一段要测的东西）
 *
 * ⚠️ 纪律：
 *   · 两个进程都是**独立进程**（不是同一进程里先 close 再 open —— 那不叫重启）
 *   · 只在**隔离库**上做；真实库从不打开（`PROJECT_LG_SANDBOX` 指向 %TEMP% 下的目录）
 *   · 本脚本与两段都跑**控制档**（0 次模型调用）
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'

const argv = process.argv.slice(2)
const live = argv.includes('--live')
if (live && process.env.DSH_TEST_MODEL_WRAPPER !== '1') {
  console.error('[lv2:restart] refused: live mode must run behind pnpm with-test-model')
  process.exit(2)
}
/** 段参数：控制档带 --preflight；真实档不带（并要求 wrapper 已在环境里） */
const modeArgs = live ? [] : ['--preflight']

const roundsIndex = argv.indexOf('--rounds')
const rounds = roundsIndex >= 0 ? Number(argv[roundsIndex + 1] ?? '50') : 50
const atIndex = argv.indexOf('--restart-at')
/** 重启点：缺省取整条轨迹的**中点**（50 轮 ⇒ 第 25 轮之后重启） */
const restartAt = atIndex >= 0 ? Number(argv[atIndex + 1] ?? '25') : Math.floor(rounds / 2)

interface SegmentResult {
  readonly process: 'first' | 'second'
  readonly exitCode: number
  readonly sandboxDir: string
  readonly stateSha: string
  readonly initialSha: string
}

function runSegment(args: readonly string[], env: NodeJS.ProcessEnv): { output: string; exitCode: number } {
  let output = ''
  let exitCode = 0
  try {
    output = execFileSync('pnpm', ['exec', 'tsx', 'scripts/lv2-trajectory.ts', ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: true,
      env,
    })
  } catch (error) {
    const withOutput = error as { status?: number; stdout?: string }
    exitCode = withOutput.status ?? 1
    output = withOutput.stdout ?? ''
  }
  return { output, exitCode }
}

const pick = (output: string, key: string): string =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.includes(`${key}=`))
    ?.split(`${key}=`)[1]
    ?.trim() ?? ''

function main(): void {
  const started = new Date().toISOString()
  const root = process.cwd()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

  const dumpDir = join(root, 'artifacts', 'lv2', 'local')
  const stamp = String(Date.now())
  /* 固定 runId：isolateDatabase 按它复用**同一个目录**（受控入口；见 R-38 的教训） */
  const sandboxRunId = `restart-${stamp}`
  const seg1Dump = join(dumpDir, `restart-${stamp}-seg1`)
  const seg2Dump = join(dumpDir, `restart-${stamp}-seg2`)

  /* ---- 第一段：独立进程 ---- */
  const first = runSegment(
    /* ⚠️ 第一段**不**传 --from：它要**新建**沙箱（传了就会要求沿用外部沙箱而抛错 —— 真踩到） */
    [...modeArgs, '--rounds', String(restartAt), '--segment-tag', 'seg1', '--dump-state', seg1Dump, '--sandbox-run-id', sandboxRunId],
    { ...process.env, LV2_DUMP_STATE: seg1Dump },
  )
  const sandboxDir = pick(first.output, 'SANDBOX')
  const firstStateSha = pick(first.output, 'STATE_SHA')

  /* ---- 第二段：**全新进程**，接手同一个沙箱目录 ---- */
  const second =
    sandboxDir === ''
      ? { output: '', exitCode: 1 }
      : runSegment(
          [
            ...modeArgs,
            '--rounds',
            String(rounds),
            '--from',
            String(restartAt + 1),
            '--segment-tag',
            'seg2',
            '--dump-state',
            seg2Dump,
            '--sandbox-run-id',
            sandboxRunId,
          ],
          { ...process.env, LV2_DUMP_STATE: seg2Dump },
        )
  const secondInitialSha = pick(second.output, 'INITIAL_STATE_SHA')
  const secondStateSha = pick(second.output, 'STATE_SHA')

  /*
   * **结构化 diff**：只比哈希分不出"投影没载入"与"真的丢了" —— 比内容才分得出。
   * 于是把两段的 dump 逐域对照：条数、只在第一段的、只在第二段的。
   */
  const structuralDiff = ((): {
    readonly domains: readonly { readonly domain: string; readonly seg1Count: number; readonly seg2Count: number; readonly onlyInSeg1: string[]; readonly onlyInSeg2: string[] }[]
    readonly dumpsRead: number
  } => {
    /*
     * ⚠️ **读不到必须响亮**：第一版解析失败时返回 `{}` ⇒ 两段都读不到时会打印
     *    "0 对 0、没有差异" —— 看起来像"没有差异"，其实是**根本没读**
     *    （真踩到：工作区路径含空格 + `shell: true` ⇒ `--dump-state` 参数被切开、dump 没写）。
     *    ⇒ 现在返回 `null` 并把 `dumpsRead` 记进账；`dumpsRead < 2` 时 diff **不得**当结论。
     */
    const read = (path: string): Record<string, { id?: string; statement?: string; status?: string }[]> | null => {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as Record<string, { id?: string; statement?: string; status?: string }[]>
      } catch {
        return null
      }
    }
    const left = read(`${seg1Dump}.final.json`)
    const right = read(`${seg2Dump}.initial.json`)
    const dumpsRead = (left === null ? 0 : 1) + (right === null ? 0 : 1)
    const keyOf = (row: { id?: string; statement?: string; status?: string }): string =>
      row.id !== undefined ? row.id : `${String(row.statement)}|${String(row.status)}`
    return {
      dumpsRead,
      domains: ['memories', 'goals', 'commitments'].map((domain) => {
        const a = (left?.[domain] ?? []).map(keyOf)
        const b = (right?.[domain] ?? []).map(keyOf)
        return {
          domain,
          seg1Count: a.length,
          seg2Count: b.length,
          onlyInSeg1: a.filter((key) => !b.includes(key)),
          onlyInSeg2: b.filter((key) => !a.includes(key)),
        }
      }),
    }
  })()

  const segments: SegmentResult[] = [
    { process: 'first', exitCode: first.exitCode, sandboxDir, stateSha: firstStateSha, initialSha: '' },
    { process: 'second', exitCode: second.exitCode, sandboxDir, stateSha: secondStateSha, initialSha: secondInitialSha },
  ]
  const continuity = firstStateSha !== '' && firstStateSha === secondInitialSha
  const measuredCount = (sandboxDir === '' ? 0 : 1) + (firstStateSha === '' ? 0 : 1) + (secondInitialSha === '' ? 0 : 1)
  const requestCounts = [first.output, second.output].map(output => pick(output, 'ACTUAL_MODEL_REQUESTS'))
  const requestCountsComplete = !live || requestCounts.every(value => /^\d+$/.test(value))
  const actualRequests = live ? requestCounts.reduce((sum, value) => sum + (/^\d+$/.test(value) ? Number(value) : 0), 0) : 0
  const verdict =
    first.exitCode === 0 && second.exitCode === 0 && continuity && measuredCount === 3 && structuralDiff.dumpsRead === 2 && requestCountsComplete
      ? 'PASS'
      : 'FAIL'

  const runId = createLv2RunId({ wpId: 'wp5-restart', headShort: head })
  const dir = openLv2RunDir(root, runId)
  writeFileSync(
    join(dir, 'readings.json'),
    `${JSON.stringify(
      {
        runId,
        rounds,
        restartAt,
        segments,
        continuity,
        structuralDiff,
        firstTail: first.output.split(/\r?\n/).slice(-6),
        secondHead: second.output.split(/\r?\n/).slice(0, 6),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  const manifestPath = writeLv2Manifest(dir, {
    runId,
    wp: 'wp5-restart',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version },
    testType: live ? 'mixed-trajectory-restart-live' : 'mixed-trajectory-restart-preflight',
    counts: { total: 3, passed: verdict === 'PASS' ? 3 : 0, failed: verdict === 'PASS' ? 0 : 3 },
    phases: ['seg1', 'seg2'],
    supersedes: null,
    started,
    ended: new Date().toISOString(),
    worktree: { clean: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '', note: '本脚本自己的 run 目录按白名单不计入' },
    sourceFingerprints: Object.fromEntries(
      (['scripts/lv2-trajectory-restart.ts', 'scripts/lv2-trajectory.ts', 'scripts/lv2-evidence.ts'] as const).map((path) => [
        path,
        createHash('sha256').update(readFileSync(join(root, path))).digest('hex'),
      ]),
    ),
    config: {
      mode: live ? '真实档（测试端点）· 两个**独立进程**' : '控制档（0 次模型调用）· 两个**独立进程**',
      rounds,
      restartAt,
      sandboxDir,
      continuityRule: '第一段 STATE_SHA 必须等于第二段 INITIAL_STATE_SHA',
    },
    model: live ? { providerKind: 'openai-compatible', note: '测试端点（ark）' } : { providerKind: 'none', note: '控制档' },
    requests: live ? { planned: rounds * 2, actual: actualRequests, note: requestCountsComplete ? '两个子进程逐轮实际调用计数相加' : '仅为已获得计数；缺段未知，不代表零费用，验收失败' } : { planned: 0, actual: 0, note: '零模型请求' },
    denominators: { segments: segments.length, measuredCount, dumpsRead: structuralDiff.dumpsRead, continuity: String(continuity), requestCountsComplete, fieldLevelRebuild: '未在重启编排内执行，另读整条轨迹 rebuild' },
    correlations: { cases: rounds, conversations: 1, requests: actualRequests, traces: 0 },
    faultInjection: null,
    cleanClose: first.exitCode === 0 && second.exitCode === 0,
    realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: '两个进程都只在 %TEMP% 的隔离库上跑' },
    verdict,
    limitation:
      '本 run 证明跨进程接管同一隔离库后状态连续；它单独不替代整条轨迹的逐字段 rebuild。' +
      (live ? '真实档调用数来自两段实际计数。' : '控制档零模型调用。'),
  })

  console.log(`[lv2:restart] runId = ${runId}（${String(rounds)} 轮 · 第 ${String(restartAt)} 轮后重启 · ${live ? '真实档' : '控制档'} · 实际调用 ${actualRequests}）`)
  console.log(`[lv2:restart] 第一段进程 exit=${String(first.exitCode)} · 沙箱 ${sandboxDir}`)
  console.log(`[lv2:restart] 第二段进程 exit=${String(second.exitCode)}（新进程，同一个固定 runId 复用同一沙箱）`)
  console.log(`[lv2:restart] 连续性：STATE_SHA(seg1)=${firstStateSha.slice(0, 16)} · INITIAL_STATE_SHA(seg2)=${secondInitialSha.slice(0, 16)} ⇒ ${continuity ? '一致 ✓' : '不一致 ✗'}`)
  console.log(`[lv2:restart] dump 读到 ${String(structuralDiff.dumpsRead)}/2（<2 时 diff 不得当结论）`)
  for (const row of structuralDiff.domains) console.log(`[lv2:restart] diff ${row.domain}: seg1=${String(row.seg1Count)} · seg2=${String(row.seg2Count)} · 只在seg1=${JSON.stringify(row.onlyInSeg1)} · 只在seg2=${JSON.stringify(row.onlyInSeg2)}`)
  console.log(`[lv2:restart] verdict = ${verdict} · measured_count = ${String(measuredCount)} · manifest = ${manifestPath.replace(`${root}\\`, '').replace(/\\/g, '/')}`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

main()
