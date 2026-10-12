/**
 * **选档器自证门**（`pnpm postlv2:gate-selection:verify`）—— 正控 / 负控 / 恢复三段式。
 *
 * ============================================================================
 *  它回答的问题（`AGENTS.md` §6 第 7 条 / `INV-M45-06`）
 * ============================================================================
 * ```text
 *     "这一道门的最新一份读数到底是哪一份" —— 我现在测到的，真的是我要判断的那个吗？
 * ```
 * 背景（`TD-23` / `AUD-20261005-02`）：**同一个缺陷在三个聚合门上各出现过一次** ——
 * `m10.1-gates` / `m10-gates` / `m11.1-gates` 都曾按**文件系统 mtime** 判"最新一份"。
 * 而 mtime 会因为复制 / 检出 / 恢复 / 同秒写盘而与**提交先后**不一致 ⇒
 * 同一批档案的判定会漂移（"读数看起来确定、其实不确定"那一族）。
 *
 * 实测到的后果（2026-10-05，`artifacts/m10/**`）：`long-verify` 的 73 份真档分成 **20 组同 head**，
 * 其中 **10 组**的判定**既有 PASS 也有 FAIL**；而 M10 清单里**一个时间戳都没有**
 * （`date` 只有天粒度）⇒ 旧实现选出来的"最新一份"是 `f4a2345ecdc5`（**不是最新的 head**），
 * 它只是"manifest.json 的 mtime 恰好最大"的那一份 ⇒ **判定跟着检出顺序走**。
 *
 * ============================================================================
 *  三段式（每一段都必须真的响 / 真的安静）
 * ============================================================================
 * ```text
 * ① 正控：自报结束时间更晚者胜（哪怕目录名字典序更小）
 * ② 负控：**mtime 反转**且两份都没有时间戳 ⇒ 仍然不按 mtime（`basis = none`，只按 runId）
 *         + **反证**：同一组夹具下，一个**故意按 mtime 排**的对照排序会选到**另一份**
 *           ⇒ 证明这组夹具**能**抓到"退回 mtime"的回归（负控不是空转的）
 * ③ 恢复：换个前缀 / 清掉夹具 ⇒ 又安静（无候选 ⇒ `undefined`，**不是**默认选一个）
 * ④ 诚实性：**并列且判定不同** ⇒ `conflictingVerdicts = true`（调用方失败关闭，不许按字典序偷偷定一个）
 * ⑤ 诚实性（m10.1 面）：干跑档**被滤掉**（正式档 FAIL 时照样报 FAIL）
 * ⑥ m11.1 聚合面：把夹具喂给**真的** `summarizeM111Evidence()` —— 并列且判定不同 ⇒ `INVALID`
 * ⑦ 结构锁：三个生产文件里**没有** `mtime` / `statSync(`（去注释后）；
 *          **负控** = 往源码副本里注入一处 `statSync(x).mtimeMs` ⇒ 判据**必须响**
 * ```
 *
 * ⚠️ 本门**零数据库 / 零模型 / 零出网 / 不改写工作树**：夹具全在 `%TEMP%`。
 *    它读 `artifacts/m10/**` 只为**报告**一个读数（真实档案里"并列且判定不同"的组数），
 *    那一条**不作断言**（断言只落在夹具与结构锁上，免得档案清理把门弄红）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { sealManifest } from './m6.1-evidence.ts'
import { headFromRunId, pickLatest, rankReadings, type RankInput, type RankedReading } from './gate-evidence-select.ts'
import { selectLatestReading } from './m10.1-gate-select.ts'
import { summarizeM111Evidence } from './m11.1-gates.ts'

interface Check {
  readonly name: string
  readonly pass: boolean
  readonly actual: unknown
}
const checks: Check[] = []
const check = (name: string, pass: boolean, actual: unknown): void => {
  checks.push({ name, pass, actual })
}

const REPO_ROOT = resolve(process.cwd())

/* =========================================================================
 * ① 共享选档器 · 三段式（`%TEMP%` 夹具）
 * ======================================================================= */
const selectionRoot = mkdtempSync(join(tmpdir(), 'gate-selection-'))

/** 造一份档：目录名 `dirName`、自报时间写在读数里、`manifest` 可显式给 head/date。 */
const fixture = (input: {
  readonly dirName: string
  readonly reading?: Record<string, unknown>
  readonly manifest?: Record<string, unknown>
  /** 该档的**笼统判定**（并列冲突检测用）；不给 ⇒ 不参与 */
  readonly verdict?: string
  /** 让这份档看起来"文件系统时间"很新/很旧（负控用） */
  readonly mtimeSeconds?: number
}): { dir: string; dirName: string; ranked: RankInput<string> } => {
  const dir = join(selectionRoot, input.dirName)
  mkdirSync(dir, { recursive: true })
  const reading = input.reading ?? {}
  writeFileSync(join(dir, 'reading.json'), `${JSON.stringify(reading, null, 2)}\n`, 'utf8')
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(input.manifest ?? {}, null, 2)}\n`, 'utf8')
  if (input.mtimeSeconds !== undefined) {
    const target = join(dir, 'manifest.json')
    utimesSync(target, input.mtimeSeconds, input.mtimeSeconds)
  }
  return {
    dir,
    dirName: input.dirName,
    ranked: {
      item: input.dirName,
      dir,
      runId: input.dirName,
      manifest: input.manifest ?? {},
      reading,
      evidencePath: join(dir, 'reading.json'),
      ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
    },
  }
}

/* ---- 正控：自报结束时间更晚者胜（目录名字典序故意写反） ---- */
const positiveFixtures = [
  fixture({ dirName: 'p-zzz-older', reading: { verdict: 'FAIL', ended: '2026-10-01T00:00:00Z' }, verdict: 'FAIL' }),
  fixture({ dirName: 'p-aaa-newer', reading: { verdict: 'PASS', ended: '2026-10-02T00:00:00Z' }, verdict: 'PASS' }),
]
const positivePick = pickLatest(rankReadings(positiveFixtures.map((row) => row.ranked)))
check(
  'positive-reported-time-wins',
  positivePick?.picked.runId === 'p-aaa-newer' && positivePick?.picked.basis === 'reported-time',
  { picked: positivePick?.picked.runId, basis: positivePick?.picked.basis },
)

/* ---- 负控：mtime 反转 + 两份都没有时间戳 ⇒ 仍不按 mtime ---- */
/*
 * 夹具故意做成**判别性**的：
 * ```text
 * 身份判据（`basis = none` ⇒ 只按 runId 升序）：取 `q-zzz-fail-old-mtime`（字典序更大）= FAIL
 * 按 mtime 排（对照）：                       取 `q-aaa-pass-new-mtime`（mtime 更新）  = PASS
 * ⇒ 两种排法**结论相反**（FAIL vs PASS）。若哪天代码退回 mtime，这条负控会立刻响。
 * ```
 */
const invertedNewMtime = fixture({
  dirName: 'q-aaa-pass-new-mtime',
  reading: { verdict: 'PASS' },
  verdict: 'PASS',
  mtimeSeconds: 1_700_000_000,
})
const invertedOldMtime = fixture({
  dirName: 'q-zzz-fail-old-mtime',
  reading: { verdict: 'FAIL' },
  verdict: 'FAIL',
  mtimeSeconds: 1_600_000_000,
})
const negativePick = pickLatest(rankReadings([invertedNewMtime.ranked, invertedOldMtime.ranked]))

/**
 * **反证**：一个**故意按 mtime 排**的对照排序（只用 `statSync`，与生产路径无关）。
 * 它**必须**选到另一份 —— 否则这组夹具分不出"按身份"与"按 mtime"，负控就是空转的。
 */
const mtimeStrawMan = [invertedNewMtime, invertedOldMtime]
  .sort((a, b) => statSync(join(a.dir, 'manifest.json')).mtimeMs - statSync(join(b.dir, 'manifest.json')).mtimeMs)
  .at(-1)!

check(
  'negative-mtime-inverted-still-not-used',
  negativePick?.picked.basis === 'none' &&
    negativePick?.picked.runId === 'q-zzz-fail-old-mtime' &&
    mtimeStrawMan.dirName !== negativePick?.picked.runId,
  {
    basis: negativePick?.picked.basis,
    picked: negativePick?.picked.runId,
    pickedVerdict: negativePick?.picked.verdict,
    mtimeStrawMan: mtimeStrawMan.dirName,
    mtimeStrawManVerdict: mtimeStrawMan.ranked.verdict,
    /* 反证必须**指向相反结论**，否则这组夹具不具判别性 */
    discriminating: mtimeStrawMan.dirName !== negativePick?.picked.runId,
  },
)

/* ---- ③ 恢复：换个前缀 ⇒ 没有候选 ⇒ undefined（不是默认选一个） ---- */
const restored = pickLatest(rankReadings([] as RankInput<string>[]))
const restoredViaM101 = selectLatestReading(selectionRoot, 'zzz-none-', 'reading.json')
check('restore-no-candidate-is-undefined', restored === undefined && restoredViaM101 === undefined, {
  shared: restored === undefined ? 'undefined' : '有候选',
  m10_1: restoredViaM101 === undefined ? 'undefined' : '有候选',
})

/* ---- ④ 诚实性：并列且判定不同 ⇒ conflictingVerdicts = true ---- */
const tiePass = fixture({ dirName: 's-tie-pass', reading: { verdict: 'PASS', ended: '2026-10-06T00:00:00Z' }, verdict: 'PASS' })
const tieFail = fixture({ dirName: 's-tie-fail', reading: { verdict: 'FAIL', ended: '2026-10-06T00:00:00Z' }, verdict: 'FAIL' })
const tied = pickLatest(rankReadings([tiePass.ranked, tieFail.ranked]))
const tiedSame = pickLatest(
  rankReadings([
    fixture({ dirName: 't-tie-a', reading: { verdict: 'PASS', ended: '2026-10-06T00:00:00Z' }, verdict: 'PASS' }).ranked,
    fixture({ dirName: 't-tie-b', reading: { verdict: 'PASS', ended: '2026-10-06T00:00:00Z' }, verdict: 'PASS' }).ranked,
  ]),
)
check(
  'honesty-tie-with-conflicting-verdicts-fails-closed',
  tied?.conflictingVerdicts === true && tied.tiedWith.length === 1 && tiedSame?.conflictingVerdicts === false,
  { conflicting: tied?.conflictingVerdicts, tiedWith: tied?.tiedWith, sameVerdictTie: tiedSame?.conflictingVerdicts },
)

/* ---- ⑤ 诚实性（m10.1 面）：干跑档被滤掉 ---- */
fixture({ dirName: 'r-dry-pass', reading: { verdict: 'PASS', dryRun: true, ended: '2026-10-05T00:00:00Z' } })
fixture({ dirName: 'r-real-fail', reading: { verdict: 'FAIL', dryRun: false, ended: '2026-10-01T00:00:00Z' } })
const filtered = selectLatestReading(selectionRoot, 'r-', 'reading.json')
check(
  'honesty-non-authoritative-is-filtered',
  filtered?.runId === 'r-real-fail' && filtered?.skipped.length === 1 && filtered?.skipped[0] === 'r-dry-pass',
  { picked: filtered?.runId, skipped: filtered?.skipped ?? [] },
)

/* ---- head 形状：`m10-*` 与 `m11-*` 两种 runId 都取得到 head ---- */
check(
  'head-extraction-covers-both-run-id-shapes',
  headFromRunId('m10-wp11-gates-20261005-a5de36f8e879-21b0') === 'a5de36f8e879' &&
    headFromRunId('m11-m111-wiring-20261002-000000000000-0001') === '000000000000' &&
    headFromRunId('not-a-run-id') === undefined,
  {
    m10: headFromRunId('m10-wp11-gates-20261005-a5de36f8e879-21b0'),
    m11: headFromRunId('m11-m111-wiring-20261002-000000000000-0001'),
    bogus: headFromRunId('not-a-run-id') ?? 'undefined',
  },
)

/* =========================================================================
 * ⑥ m11.1 聚合面 —— 把夹具喂给**真的** `summarizeM111Evidence()`
 * ======================================================================= */
const m111Root = mkdtempSync(join(tmpdir(), 'gate-selection-m111-'))
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const m111Run = (suffix: string, endedValue: string, failed: number): Record<string, unknown> =>
  sealManifest({
    schemaVersion: 'm11-manifest@1',
    runId: `m11-m111-wiring-20261002-000000000000-${suffix}`,
    wp: 'M11.1-WP2',
    head: '0'.repeat(40),
    headShort: '0'.repeat(12),
    branch: 'offline-controls',
    date: '2026-10-02',
    toolVersions: { node: process.version },
    testType: 'wiring',
    counts: { total: 1, passed: 1 - failed, failed },
    phases: ['positive', 'negative', 'recovery'],
    supersedes: null,
    ended: endedValue,
    cleanClose: true,
    plannedRequests: 0,
    actualRequests: 0,
    sourceFingerprints: { 'fixture.ts': sha256('fixture') },
  })
const m111Store = (manifest: Record<string, unknown>): void => {
  const dir = join(m111Root, 'artifacts/m11.1', String(manifest.runId))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest))
}
writeFileSync(join(m111Root, 'fixture.ts'), 'fixture')

/* 正控：更晚的 FAIL 不被更早的 PASS 取代（两份都在库里） */
m111Store(m111Run('0001', '2026-10-02T00:00:00Z', 0))
m111Store(m111Run('0002', '2026-10-02T00:01:00Z', 1))
const m111NewerWins = summarizeM111Evidence(m111Root)
check(
  'm11.1-newer-fail-not-replaced-by-older-pass',
  m111NewerWins.readings.wiring.status === 'FAIL' &&
    m111NewerWins.readings.wiring.runId === 'm11-m111-wiring-20261002-000000000000-0002' &&
    m111NewerWins.readings.wiring.selectionBasis === 'reported-time',
  {
    status: m111NewerWins.readings.wiring.status,
    runId: m111NewerWins.readings.wiring.runId,
    basis: m111NewerWins.readings.wiring.selectionBasis,
  },
)

/* 负控：**同 head 同日同时刻**一份 FAIL + 一份 PASS ⇒ 必须失败关闭（`INVALID`） */
m111Store(m111Run('0003', '2026-10-02T00:01:00Z', 0))
const m111Tied = summarizeM111Evidence(m111Root)
check(
  'm11.1-tied-conflicting-verdicts-fail-closed',
  m111Tied.readings.wiring.status === 'INVALID' &&
    m111Tied.readings.wiring.selectionBasis === 'reported-time' &&
    m111Tied.readings.wiring.problems.some((problem) => problem.includes('归属不明')),
  {
    status: m111Tied.readings.wiring.status,
    tiedWith: m111Tied.readings.wiring.tiedWith,
    problems: m111Tied.readings.wiring.problems,
  },
)

/* 恢复：把并列的 PASS 一份移掉 ⇒ 又安静（回到"更晚者胜"= FAIL） */
rmSync(join(m111Root, 'artifacts/m11.1/m11-m111-wiring-20261002-000000000000-0003'), { recursive: true, force: true })
const m111Restored = summarizeM111Evidence(m111Root)
check(
  'm11.1-recovery-after-tie-removed',
  m111Restored.readings.wiring.status === 'FAIL' &&
    m111Restored.readings.wiring.runId === 'm11-m111-wiring-20261002-000000000000-0002' &&
    m111Restored.readings.wiring.tiedWith.length === 0,
  {
    status: m111Restored.readings.wiring.status,
    runId: m111Restored.readings.wiring.runId,
    tiedWith: m111Restored.readings.wiring.tiedWith,
  },
)

/* =========================================================================
 * ⑦ 结构锁：三个生产文件里**没有** mtime / statSync（去注释）
 * ======================================================================= */
/** 只剥**散文**（块注释 / 行注释 / 模板串），保留单引号字符串与代码。 */
const stripProse = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/`[\s\S]*?`/g, '``')
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')

const MTIME_DETECTOR = /mtimeMs|mtime|statSync\s*\(/g
const mtimeUses = (source: string): string[] => [...stripProse(source).matchAll(MTIME_DETECTOR)].map((m) => m[0])

const PRODUCTION_FILES = [
  'scripts/gate-evidence-select.ts',
  'scripts/m10-gates.ts',
  'scripts/m11.1-gates.ts',
  'scripts/m10.1-gate-select.ts',
] as const
const offenderList = PRODUCTION_FILES.map((file) => ({
  file,
  hits: mtimeUses(readFileSync(join(REPO_ROOT, file), 'utf8')),
}))

/* 负控：往**真实源码的副本**里注入一处 mtime 依据 ⇒ 判据必须响 */
const injectedSample = `${readFileSync(join(REPO_ROOT, 'scripts/m10-gates.ts'), 'utf8')}
const injectedMtime = statSync(someDir).mtimeMs
`
const injectedHits = mtimeUses(injectedSample)
/* 恢复：再算一次干净的源码 ⇒ 又安静 */
const restoredHits = mtimeUses(readFileSync(join(REPO_ROOT, 'scripts/m10-gates.ts'), 'utf8'))

check(
  'structural-lock-no-mtime-in-selection-path',
  offenderList.every((row) => row.hits.length === 0),
  { offenders: offenderList.filter((row) => row.hits.length > 0) },
)
check(
  'structural-lock-negative-control-fires',
  injectedHits.length > 0 && restoredHits.length === 0,
  { injected: injectedHits, restored: restoredHits },
)

rmSync(selectionRoot, { recursive: true, force: true })
rmSync(m111Root, { recursive: true, force: true })

/* =========================================================================
 * 报告读数（**不作断言**）：真实 M10 档案里"并列且判定不同"的组数
 * ======================================================================= */
/**
 * ⚠️ 这一条**只报告不判红**：档案以后可能被清理或补档，把门绑在它的精确计数上会
 *    让门因为**与本次改动无关**的原因变红。要断言的是**机制**（上面 ①–⑦）。
 */
const m10Reading = ((): { testTypes: number; conflictGroups: number; example: string | null } => {
  const root = join(REPO_ROOT, 'artifacts', 'm10')
  if (!existsSync(root)) return { testTypes: 0, conflictGroups: 0, example: null }
  const byType = new Map<string, RankInput<unknown>[]>()
  for (const dir of readdirSync(root)) {
    const dirFull = join(root, dir)
    const manifestPath = join(dirFull, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    let manifest: Record<string, unknown>
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof manifest.injection === 'string') continue
    const testType = typeof manifest.testType === 'string' ? manifest.testType : ''
    if (testType === '') continue
    let reading: Record<string, unknown> = {}
    let verdict = ''
    for (const name of readdirSync(dirFull)) {
      if (!name.endsWith('.json') || name === 'manifest.json') continue
      try {
        const parsed = JSON.parse(readFileSync(join(dirFull, name), 'utf8')) as { checks?: unknown[]; summary?: { verdict?: unknown } }
        if (Array.isArray(parsed.checks) && parsed.checks.length > 0) {
          reading = parsed as unknown as Record<string, unknown>
          verdict = String(parsed.summary?.verdict ?? '')
          break
        }
      } catch {
        /* 不是证据档 */
      }
    }
    const list = byType.get(testType) ?? []
    list.push({ item: dir, dir: dirFull, runId: dir, manifest, reading, evidencePath: manifestPath, verdict })
    byType.set(testType, list)
  }
  let conflictGroups = 0
  let example: string | null = null
  for (const [testType, list] of byType) {
    const ranked: RankedReading<unknown>[] = rankReadings(list)
    /*
     * ⚠️ 只看**每道门最新的那一组**（与 `m10-gates` 的判定面一致）：
     *    历史上的并列组已经过去了；会让当前读数"归属不明"的只有**当前这一组**。
     */
    const newest = ranked[ranked.length - 1]
    if (newest === undefined) continue
    const group = ranked.filter((row) => row.time === newest.time)
    if (group.length < 2) continue
    const verdicts = new Set(group.map((row) => String(row.verdict)))
    if (verdicts.size > 1) {
      conflictGroups += 1
      example ??= `${testType}（${String(group.length)} 份 · 依据 ${newest.basis} · ${[...verdicts].join('/')}）`
    }
  }
  return { testTypes: byType.size, conflictGroups, example }
})()

/* =========================================================================
 * 落盘 + 退出码
 * ======================================================================= */
const failed = checks.filter((item) => !item.pass)
const output = join('artifacts', 'post-lv2', `gate-selection-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(output, { recursive: true })
const payload = {
  kind: 'offline gate-evidence selection controls (identity-first, mtime never used)',
  runId: null,
  measured_count: checks.length,
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
  m10ArchiveReading: m10Reading,
  database: 'NOT_OPENED',
  network: 'MOCKED',
  modelCalls: 0,
  worktree: 'UNCHANGED',
  disclaimer:
    '本门判的是**选档器**（`TD-23` / `AUD-20261005-02`）：身份优先、mtime 永不参与、并列判定不同即失败关闭，' +
    '并驱动**真的** `summarizeM111Evidence()` 走一遍 m11.1 的并列路径。' +
    '`m10ArchiveReading` 是**报告读数**（真实档案里并列且判定不同的组数），**不作断言**。',
}
writeFileSync(join(output, 'reading.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
console.log(
  JSON.stringify(
    { ...payload, head: head.slice(0, 12), evidence: join(output, 'reading.json') },
    null,
    2,
  ),
)
process.exitCode = failed.length > 0 || checks.length === 0 ? 1 : 0
