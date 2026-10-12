/**
 * 门执行器入口（Tier 0/2/3）。
 *
 * ============================================================================
 *  用法
 * ============================================================================
 *   pnpm gates:run --lane offline                 # M4.5 离线链（**默认 8 路 = 实测最优**）
 *   pnpm gates:run --lane offline --profile       # 顺带打 top-N 慢门
 *   pnpm gates:run --lane summaries               # 只读汇总门（秒级）
 *   pnpm gates:run --lane affected --allow-partial # 按改动面推导
 *   pnpm gates:run --lane offline --parallel 24    # 要满（实测**更慢**，见文件头曲线）
 *   pnpm gates:run --lane offline --serial         # 串行（复现串行条件下的读数）
 *   pnpm gates:run --lane offline --mode release   # 发布档：串行、不缓存、保留证据
 *
 * ---------------------------------------------------------------------------
 *  三条不会变的规矩（写死在代码里）
 * ---------------------------------------------------------------------------
 *  ① **并发缺省 = 8 路（实测最优）**（用户 2026-09-27 裁定；同日先"最高并发"、后按
 *     实测曲线改为此值 —— 曲线与理由见 `MEASURED_OPTIMAL_PARALLEL` 的注释）。
 *     安全性来自资源冲突图（真实库 / data/ / 声明 serial / 证据或端口重叠的门会被
 *     排到独处时段），**不**来自"少开几路"。要串行请显式 `--serial`。
 *  ② `--mode release`（发布档）**强制串行**、**拒绝** `--cache`、**不做证据还原**。
 *     发布证据必须由冻结命令清单在干净树、串行条件下产出。
 *  ③ 快车道（默认档）跑完把**本次新弄脏**的 `artifacts/**` 还原，并复核；
 *     复核不通过 ⇒ 退出码非零。快车道的价值是"读数 + 耗时"，不是"留下证据"。
 */

import { cpus } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gateInputKey, cacheability, readCacheEntry, writeCacheEntry, configSalt } from './gates/cache.ts'
import { changedPaths, planAffected, resolveSpec, escalatedGateIds } from './gates/affected-map.ts'
import { ALL_GATES, LANES, REPO_ROOT, laneById, OFFLINE_SPECIALTY_IDS } from './gates/manifest.ts'
import { runGates, writeRunReport, type GateOutcome, type RunReport } from './gates/runner.ts'
import { readFileSync } from 'node:fs'
import type { GateSpec } from './gates/types.ts'

/**
 * 并发缺省的三个数（用户 2026-09-27 裁定 + 同一天的实测曲线）：
 *
 * ```text
 * 34 道离线门，全部 PASS / 无抖动，只改并发：
 *   串行 ≈749s · 6 路 87.2s · **8 路 88.8s** · 16 路 91.9s · 24 路（跑满）96.5s
 * ```
 * ⇒ 缺省取 **8**：比"跑满机器"快约 8s（~10%）。原因不是并发不安全（资源冲突图照样
 * 把真实库 / `data/` / 声明 serial 的门排到独处时段），而是**最重的那几道门互相抢 CPU**：
 * `eval:m3` 在 6 路下 80.4s、24 路下 93.1s，而墙钟由最长的那道门决定。
 *
 * 三个数的分工（**同源**：帮助文本 / 真实缺省 / 文档都引用它们，防止"文档写的与真跑的
 * 不是一个数"）：
 *   · `MEASURED_OPTIMAL_PARALLEL` = 实测最优，缺省用它；
 *   · `CPU_COUNT` = 上限，`--parallel` 可以显式要满（本机 24）；
 *   · 核数少于 8 的机器按核数走（不超卖）。
 *
 * ⚠️ 换机器 / 换门集之后，这个 8 不保证还是最优 —— 复测方法见 `scripts/gates/README.md`
 *    （对 `--parallel` 扫一遍，比墙钟；**不要靠感觉改**）。
 */
const CPU_COUNT = Math.max(1, cpus().length)
const MEASURED_OPTIMAL_PARALLEL = 8
const DEFAULT_PARALLEL = Math.max(1, Math.min(MEASURED_OPTIMAL_PARALLEL, CPU_COUNT))

interface Cli {
  lane: string
  mode: 'fast' | 'release'
  parallel: number
  only: string[]
  skip: string[]
  prefix: string[]
  cache: boolean
  keepEvidence: boolean
  failFast: boolean
  dryRun: boolean
  json: boolean
  profile: boolean
  allowPartial: boolean
  list: boolean
  top: number
}

function die(message: string, code = 2): never {
  console.error(`❌ ${message}`)
  process.exit(code)
}

function parseArgs(argv: readonly string[]): Cli {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (name: string): boolean => argv.includes(name)
  const list = (name: string): string[] => {
    const raw = get(name)
    return raw === undefined ? [] : raw.split(',').map((s) => s.trim()).filter((s) => s !== '')
  }

  const mode = (get('--mode') ?? 'fast') as 'fast' | 'release'
  if (mode !== 'fast' && mode !== 'release') die(`--mode 只能是 fast 或 release（收到 ${mode}）`)

  /*
   * ============================================================================
   *  并发缺省值 = **8 路（实测最优）** —— 用户 2026-09-27 裁定（先"最高并发"、同日按实测改为此值）
   * ============================================================================
   * 缺省值本身就带着那条曲线（见文件头 `MEASURED_OPTIMAL_PARALLEL` 的注释）：
   *   · 缺省 **8** —— 34 道离线门 88.8s；
   *   · `--parallel 24` 可以要满 —— 96.5s（**更慢**，重门互抢 CPU）；
   *   · `--serial`（= `--parallel 1`）—— 复现串行读数（≈749s）。
   *
   * 安全性**不**来自"少开几路"，而来自调度器的资源冲突图：
   * `conflictBetween()` 会把声明了 `serial` / 真实库（INV-DB-01 单持有）/ `data/` /
   * 证据路径重叠 / 端口重叠 / 会改写 git 工作树的门**排到独处时段**，
   * 不参与并发（实测：34 道离线门里只有 2 道被这样串行化）。
   * 换句话说，"并发多少"与"读数不失真"是两件正交的事：前者是性能调参，后者靠冲突图。
   *
   * 两条仍然**不变**的边界：
   *   ① `--mode release`（发布档）依旧强制串行 —— 发布证据按 §9.1 的铁律产出；
   *   ② 要复现串行条件下的读数，用 `--serial`，别去改缺省。
   */
  const defaultParallel = mode === 'release' ? 1 : DEFAULT_PARALLEL
  return {
    lane: get('--lane') ?? 'offline',
    mode,
    parallel: mode === 'release' ? 1 : has('--serial') ? 1 : Number(get('--parallel') ?? defaultParallel),
    only: list('--only'),
    skip: list('--skip'),
    prefix: list('--prefix'),
    cache: has('--cache'),
    keepEvidence: has('--keep-evidence') || mode === 'release',
    failFast: has('--fail-fast'),
    dryRun: has('--dry-run'),
    json: has('--json'),
    profile: has('--profile'),
    allowPartial: has('--allow-partial'),
    list: has('--list'),
    top: Number(get('--top') ?? 15),
  }
}

function laneIdFromCli(cli: Cli): string {
  return cli.lane
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2)
  const cli = parseArgs(argv)

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'pnpm gates:run [--lane offline|summaries|all|affected] [选项]',
        '',
        '  --mode fast|release     发布档 = 串行 + 不缓存 + 保留证据（默认 fast）',
        `  --parallel N            并发上限；**缺省 = ${DEFAULT_PARALLEL} 路（实测最优）**，上限 = 本机核数 ${CPU_COUNT}`,
        '  --serial                等价于 --parallel 1（复现串行条件下的读数）',
        '  --only a,b / --skip a,b 只跑 / 跳过某些门',
        '  --prefix m4,m9          只跑门 id 以 `<前缀>:` 开头的门（**筛空即拒绝运行**，不退回全量）',
        '  --cache                 启用内容键缓存（仅 fast 档；发布档拒绝）',
        '  --keep-evidence         不还原本次新弄脏的 artifacts',
        '  --fail-fast             有门失败 ⇒ 不再启动新门（其余记 SKIPPED）',
        '  --dry-run               只打印将执行的计划（含冲突串行段）',
        '  --json                  把 run.json 打到 stdout',
        '  --profile               打 top-N 慢门',
        '  --list                  列出 lane 与门',
        '  --allow-partial         affected lane：未匹配路径不升级为整条离线链',
      ].join('\n')
    )
    return 0
  }

  // ---- 发布档的硬规矩（在解析阶段就拒绝，不给"我以为是发布档"留余地）----
  if (cli.mode === 'release' && cli.cache) {
    die('发布档拒绝 --cache：缓存读数**永远**不能充当发布证据（AGENTS.md §6）')
  }

  const lane = laneById(cli.lane)
  if (lane === undefined) {
    die(`未知 lane：${cli.lane}（可选：${LANES.map((l) => l.id).join(' / ')}）`)
  }

  // ---- 解析这次要跑哪些门 ----
  let specs: GateSpec[] = []
  let unmatchedPaths: string[] | undefined
  const notes: string[] = []

  if (lane.fromChangedPaths === true) {
    const changed = changedPaths(REPO_ROOT)
    if (changed.error !== undefined) die(changed.error)
    const plan = planAffected(changed.paths)
    console.log(`影响面推导：${changed.paths.length} 条改动路径 ⇒ 命中 ${plan.gateIds.length} 道门`)
    for (const hit of plan.hits) {
      console.log(`  · ${hit.path}  →  ${hit.gates.length > 0 ? hit.gates.join(', ') : '（无门，仅影响面升级）'}   〔${hit.what}〕`)
    }
    for (const p of plan.ignoredPaths) console.log(`  · ${p}  →  （按约定不需要跑门）`)
    for (const e of plan.escalations) console.log(`  ⚠️ ${e.path}：${e.why}`)
    for (const p of plan.unmatchedPaths) console.log(`  ⚠️ 未匹配任何规则：${p}`)

    if (plan.escalateToOffline && !cli.allowPartial) {
      console.log(
        '\n影响面无法切分（或存在未匹配路径）⇒ 升级为整条离线链。' +
          '\n这是**失败关闭**：不知道改了它的什么影响，就不假装知道。' +
          '\n（要"只跑推导出来的那几道门"，显式加 --allow-partial。）'
      )
      // 升级 = 整条离线链（不是"那几道猜的"），并且把未匹配路径记进 run.json。
      const offline = laneById('offline')
      const ids = escalatedGateIds(plan, offline?.gateIds ?? [], OFFLINE_SPECIALTY_IDS)
      specs = ids.map(id => {
        const resolved = resolveSpec(REPO_ROOT, id, ALL_GATES)
        if ('error' in resolved) die(resolved.error)
        return resolved.spec
      })
      const deferred = plan.gateIds.filter(id => !ids.includes(id))
      if (deferred.length > 0) notes.push(`升级档未执行的专项/资产门（仍需独立验收）：${deferred.join(', ')}`)
      unmatchedPaths = plan.unmatchedPaths
      notes.push(
        `lane 从 affected 升级为 offline（未匹配路径 ${plan.unmatchedPaths.length} 条 / 无法切分 ${plan.escalations.length} 处）`
      )
    } else {
      const errors: string[] = []
      for (const id of plan.gateIds) {
        const resolved = resolveSpec(REPO_ROOT, id, ALL_GATES)
        if ('error' in resolved) errors.push(resolved.error)
        else specs.push(resolved.spec)
      }
      if (errors.length > 0) {
        console.error('❌ 影响面映射里有门无法安全执行（失败关闭，不跳过）：')
        for (const e of errors) console.error(`   · ${e}`)
        return 2
      }
      unmatchedPaths = plan.unmatchedPaths.length > 0 ? plan.unmatchedPaths : undefined
      if (plan.unmatchedPaths.length > 0) {
        notes.push(
          `--allow-partial：${plan.unmatchedPaths.length} 条未匹配路径被跳过 ⇒ 本次运行**不构成**任何交付证据`
        )
      }
    }
  } else {
    const ids = lane.gateIds ?? []
    specs = ids.map((id) => ALL_GATES.find((g) => g.id === id)).filter((g): g is GateSpec => g !== undefined)
    for (const id of ids) {
      if (ALL_GATES.every((g) => g.id !== id)) {
        const resolved = resolveSpec(REPO_ROOT, id, ALL_GATES)
        if ('error' in resolved) die(resolved.error)
        specs.push(resolved.spec)
      }
    }
  }

  if (cli.only.length > 0) specs = specs.filter((s) => cli.only.includes(s.id))
  if (cli.skip.length > 0) specs = specs.filter((s) => !cli.skip.includes(s.id))

  /*
   * `--prefix m4` —— 按**门 id 的里程碑前缀**筛（`m4:test` 命中，`m4.5:test` **不**命中：
   * 判据是逐字的 `m4:`，所以 `m4` 吃不掉 `m4.5`）。
   *
   * ⚠️ 失败关闭：筛完为空 ⇒ **exit 2 拒绝运行**，绝不退回整条 lane ——
   *    否则一个拼错的里程碑（或已改名的门）会静默跑成"全量通过"，而读数看起来完全合理。
   *    这道过滤**不新增任何门**：它只是既有 lane 的子集（AGENTS.md §9 的"哪条 lane 说什么"不变）。
   */
  if (cli.prefix.length > 0) {
    const before = specs.length
    specs = specs.filter((s) => cli.prefix.some((p) => s.id.startsWith(`${p}:`)))
    if (specs.length === 0) {
      die(
        `--prefix ${cli.prefix.join(',')} 在 lane ${lane.id} 里没有匹配到任何门（该 lane 原有 ${String(before)} 道）⇒ 拒绝运行`
      )
    }
    notes.push(`--prefix ${cli.prefix.join(',')}：从 ${String(before)} 道筛到 ${String(specs.length)} 道（既有 lane 的子集）`)
  }

  if (cli.list) {
    console.log(`lane=${lane.id}（${lane.title}）—— ${specs.length} 道门`)
    console.log(lane.note)
    for (const s of specs) {
      console.log(`  ${s.resources.parallel === 'safe' ? '∥' : '·'} ${s.id.padEnd(28)} ${s.title}`)
    }
    return 0
  }

  if (specs.length === 0) {
    console.log('没有需要跑的门（工作树里没有影响任何门的改动）。')
    return 0
  }

  if (cli.dryRun) {
    console.log(`将执行 ${specs.length} 道门（并发上限 ${cli.parallel}，档位 ${cli.mode}）：`)
    for (const s of specs) {
      console.log(
        `  ${s.resources.parallel === 'safe' ? '∥ 可并行' : '· 串行  '} ${s.id.padEnd(28)} ${s.argv.join(' ')}`
      )
    }
    return 0
  }

  const runId = `${cli.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const evidenceRoot = join(REPO_ROOT, 'artifacts', '.fast', runId)
  const cacheDir = join(REPO_ROOT, 'artifacts', '.fast', 'cache')
  mkdirSync(evidenceRoot, { recursive: true })

  const salt = configSalt(REPO_ROOT)
  const cacheable = new Map<string, { key: string; filesHashed: number; scope: string } | undefined>()
  const cacheDisabledReason = new Map<string, string>()

  if (cli.cache && cli.mode === 'fast') {
    for (const spec of specs) {
      const text = spec.entry !== undefined && existsSync(join(REPO_ROOT, spec.entry))
        ? readFileSync(join(REPO_ROOT, spec.entry), 'utf8')
        : ''
      const verdict = cacheability(spec, text)
      if (!verdict.ok) {
        cacheDisabledReason.set(spec.id, verdict.why)
        cacheable.set(spec.id, undefined)
        continue
      }
      const key = gateInputKey(REPO_ROOT, spec, salt)
      cacheable.set(spec.id, key)
    }
  }

  console.log('='.repeat(78))
  console.log(`门执行器：lane=${lane.id} · 档位=${cli.mode} · 并发上限=${cli.parallel} · ${specs.length} 道门`)
  console.log(`运行 id：${runId}`)
  console.log(`证据/日志：artifacts/.fast/${runId}/（快车道不留发布证据）`)
  if (cli.cache && cli.mode === 'fast') {
    console.log(`缓存：开（${[...cacheable.values()].filter((v) => v !== undefined).length} 道门可缓存）`)
    for (const [id, why] of cacheDisabledReason) console.log(`  · ${id}：不可缓存（${why}）`)
  } else {
    console.log('缓存：关')
  }
  console.log('='.repeat(78))

  const report = await runGates(specs, {
    root: REPO_ROOT,
    lane: laneIdFromCli(cli),
    mode: cli.mode,
    concurrency: cli.parallel,
    runId,
    evidenceRoot,
    keepEvidence: cli.keepEvidence,
    failFast: cli.failFast,
    ...(cli.cache && cli.mode === 'fast'
      ? {
          cache: {
            dir: cacheDir,
            salt,
            keyFor: (spec: GateSpec) => cacheable.get(spec.id),
            lookup: (spec: GateSpec, key: string) => {
              const entry = readCacheEntry(cacheDir, spec.id)
              if (entry === undefined || entry.key !== key || entry.exitCode !== 0) return undefined
              return { key: entry.key, recordedAt: entry.recordedAt, seconds: entry.seconds }
            },
            store: (spec: GateSpec, key: string, outcome: GateOutcome) => {
              writeCacheEntry(cacheDir, {
                gateId: spec.id,
                key,
                exitCode: 0,
                seconds: outcome.seconds,
                recordedAt: new Date().toISOString(),
                recordedMode: 'fast',
                scope: (cacheable.get(spec.id)?.scope ?? 'closure') as 'closure' | 'repo',
                filesHashed: cacheable.get(spec.id)?.filesHashed ?? 0,
              })
            },
          },
        }
      : {}),
    onEvent: (event) => {
      if (event.type === 'start') {
        const par = event.overlappedWith.length > 0 ? `  ∥ 与 ${event.overlappedWith.join(', ')} 并行` : ''
        console.log(`▶ ${event.id}${par}`)
      } else if (event.type === 'finish') {
        const o = event.outcome
        const mark = o.status === 'PASS' ? '✅' : o.status === 'CACHED' ? '⚡' : '❌'
        const extra =
          o.status === 'CACHED'
            ? `（复用 ${o.cachedFrom?.recordedAt ?? '?'} 的读数）`
            : ` ${o.seconds}s`
        console.log(`${mark} ${o.id}  ${o.status}${extra}${o.exitCode !== null && o.exitCode !== 0 ? ` exit=${o.exitCode}` : ''}`)
      } else if (event.type === 'skip') {
        console.log(`⏭️ ${event.id}  SKIPPED（依赖 ${event.blockedBy} 未成功）`)
      }
    },
  })

  writeRunReport(join(evidenceRoot, 'run.json'), report)

  // ---- 报表 ----
  console.log(`\n${'='.repeat(78)}\n汇总（按耗时降序）\n${'='.repeat(78)}`)
  const rows = [...report.results].sort((a, b) => b.ms - a.ms)
  for (const r of rows.slice(0, cli.profile ? Math.max(cli.top, rows.length) : rows.length)) {
    const par = r.overlappedWith.length > 0 ? ` ∥ ${r.overlappedWith.length}` : ''
    console.log(
      `  ${r.status.padEnd(11)} ${(r.seconds + 's').padStart(8)}  ${r.id.padEnd(28)}${par}` +
        (r.status === 'CACHED' ? '  ⚡缓存' : '') +
        (r.serializedAgainst.length > 0 ? `  ·串行于:${r.serializedAgainst.join('|')}` : '')
    )
  }
  console.log(
    `\n总计：${report.counts.TOTAL} 道 · PASS ${report.counts.PASS} · CACHED ${report.counts.CACHED} · ` +
      `FAIL ${report.counts.FAIL} · SKIPPED ${report.counts.SKIPPED} · TIMEOUT ${report.counts.TIMEOUT}` +
      `  （墙钟 ${report.seconds}s，串行基线见 run.json）`
  )
  for (const r of report.results.filter((x) => x.status !== 'PASS' && x.status !== 'CACHED')) {
    console.log(`  ❌ ${r.id}: ${r.status}${r.note !== undefined ? ` — ${r.note}` : ''}`)
  }
  console.log(`证据：artifacts/.fast/${runId}/run.json`)
  if (report.restoredEvidence.length > 0 || report.deletedEvidence.length > 0) {
    console.log(
      `快车道还原：git 还原 ${report.restoredEvidence.length} 条 · 删除新增未跟踪 ${report.deletedEvidence.length} 条` +
        `（运行前已脏而保留 ${report.preservedPreExistingDirty.length} 条）`
    )
  }
  for (const n of [...notes, ...report.notes]) console.log(`  ℹ️ ${n}`)
  if (cli.json) console.log(JSON.stringify(report, null, 2))

  return report.verdict === 'PASS' ? 0 : 1
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exit(1)
  })
