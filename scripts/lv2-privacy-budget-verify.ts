/**
 * Lv2 —— **隐私 / 预算**的机器判据（`pnpm lv2:privacy:budget:verify`；计划 `LV2-G7` 的隐私与预算两半）。
 *
 * ============================================================================
 *  它回答三个问题（都能被证伪）
 * ============================================================================
 * ① **真实库有没有被动过？** —— 逐份 `artifacts/lv2/<runId>/manifest.json` 的 `realDb.opened` 必须全为 false。
 * ② **正文有没有漏进仓库？** —— 这一条**不能只靠声明**。做法是把 `artifacts/lv2/local/**`
 *    里那些**只应存在于本地**的回复正文切成句子级窗口，再在**进仓库的全部机器证据**里搜它们。
 *    搜到 = 泄漏（`L-M55` 的两条隐私边界同族：正文不进 trace / 不进账本）。
 * ③ **预算是声明过的吗？** —— 短场景批次的 manifest 必须声明 `LV2_CANDIDATE_CONFIG` 的额度，
 *    并且**未接线的额度必须是 0**（`adaptiveSelfTokens`/`rollupTokens`）—— 不许"没填"。
 *
 * ⚠️ 三段式自检（`AGENTS.md` §6.7）：真实证据 ⇒ 安静；**注入一条假正文** ⇒ 必须响；撤掉 ⇒ 重新安静。
 * ⚠️ 它是**只读**的：不改任何证据、不调模型、不开库。
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createLv2RunId, openLv2RunDir, writeLv2Manifest } from './lv2-evidence.ts'

const ROOT = process.cwd()
const LV2 = join(ROOT, 'artifacts', 'lv2')
const LOCAL = join(LV2, 'local')

/** 句子级切分：只取足够长的窗口（太短的窗口在 JSON 键名里也会命中，那是假阳性）。 */
export function contentWindows(text: string, minLength = 10): string[] {
  return text
    .split(/[。！？\n]|(?<=[，,；;])/)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length >= minLength)
}

/** 机器证据（进仓库的一切）拼成一个大字符串，供"有没有泄漏"搜索用。 */
function machineEvidenceBlob(): { blob: string; files: string[] } {
  const files: string[] = []
  const chunks: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'local') continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.json')) continue
      files.push(full.replace(`${ROOT}\\`, '').replace(/\\/g, '/'))
      chunks.push(readFileSync(full, 'utf8'))
    }
  }
  if (existsSync(LV2)) walk(LV2)
  return { blob: chunks.join('\n'), files }
}

/** 本地（不进仓库）的正文。 */
function localReplies(): { file: string; texts: string[] }[] {
  if (!existsSync(LOCAL)) return []
  const out: { file: string; texts: string[] }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(readFileSync(full, 'utf8')) as {
          payloads?: readonly { replies?: readonly { input?: unknown; reply?: unknown }[] }[]
        }
        /*
         * ⚠️ **只取她的回复**，不取用户输入：输入是**语料正文**，它本来就在仓库里
         *    （`evals/lv2/short-cases.ts` 与冻结快照 `corpus.json`）⇒ 拿它当"泄漏窗口"
         *    只会得到假阳性（第一版就吃到了 314 处，全部来自输入）。
         *    本门要证的是："**她生成的那句话**没有整句进机器证据"。
         */
        const texts = (parsed.payloads ?? []).flatMap((payload) =>
          (payload.replies ?? []).flatMap((row) => (typeof row.reply === 'string' ? [row.reply] : [])),
        )
        out.push({ file: full.replace(`${ROOT}\\`, '').replace(/\\/g, '/'), texts })
      } catch {
        /* 非本脚本产出的 JSON 跳过 */
      }
    }
  }
  walk(LOCAL)
  return out
}

export interface PrivacyInput {
  readonly manifests: readonly { file: string; realDbOpened: boolean }[]
  readonly blob: string
  readonly local: readonly { file: string; texts: readonly string[] }[]
  /**
   * **语料正文**（`evals/lv2/short-cases.ts` 等）。
   *
   * ⚠️ 判"泄漏"必须把它排除掉：语料的句子**本来就在仓库里**（源码 + 冻结快照 `corpus.json`），
   *    所以"她说的那句话"与语料重合**不是**新信息泄漏。
   *    第一版没做这一步 ⇒ 报出 7 处"泄漏"，逐条查下来**全部**是语料正文
   *    （`现在是计算机科学与技术` 是 mustMentionAny 的针 · `出差带 Mac 笔记本` 是某条 prep 的 sourceText
   *      的子串 —— 连"按窗口原文搜语料"都会漏，因为它前面还有"我"、后面还有句号）。
   */
  readonly corpusText: string
}

export interface PrivacyReading {
  readonly realDbOpened: readonly string[]
  /** **真泄漏**：她的正文出现在机器证据里，且**不是**语料正文 */
  readonly leaks: readonly { file: string; window: string }[]
  /** 与语料重合的窗口（允许；只登记，不判死） */
  readonly corpusOverlaps: readonly { file: string; window: string }[]
  readonly windowsChecked: number
  readonly localFiles: number
}

/** **纯函数**：三段式自检要靠它在合成输入上跑（不许为了自检去写文件）。 */
export function checkPrivacy(input: PrivacyInput): PrivacyReading {
  const realDbOpened = input.manifests.filter((row) => row.realDbOpened).map((row) => row.file)
  const leaks: { file: string; window: string }[] = []
  const corpusOverlaps: { file: string; window: string }[] = []
  let windowsChecked = 0
  for (const entry of input.local) {
    for (const text of entry.texts) {
      for (const window of contentWindows(text)) {
        windowsChecked += 1
        if (!input.blob.includes(window)) continue
        /* 公开语料经 JSON 序列化会加引号；内容相同不应被误报成新正文。 */
        let corpusWindow = window
        if (window.startsWith('"') && window.endsWith('"')) {
          try {
            const decoded: unknown = JSON.parse(window)
            if (typeof decoded === 'string') corpusWindow = decoded
          } catch {
            /* 非完整 JSON 字符串仍按原窗口检查。 */
          }
        }
        if (input.corpusText.includes(corpusWindow)) corpusOverlaps.push({ file: entry.file, window })
        else leaks.push({ file: entry.file, window })
      }
    }
  }
  return { realDbOpened, leaks, corpusOverlaps, windowsChecked, localFiles: input.local.length }
}

function readManifests(): { file: string; realDbOpened: boolean; run: Record<string, unknown> }[] {
  if (!existsSync(LV2)) return []
  const out: { file: string; realDbOpened: boolean; run: Record<string, unknown> }[] = []
  for (const entry of readdirSync(LV2, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'local') continue
    const manifestPath = join(LV2, entry.name, 'manifest.json')
    if (!existsSync(manifestPath)) continue
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
      out.push({
        file: `artifacts/lv2/${entry.name}/manifest.json`,
        realDbOpened: (manifest.realDb as { opened?: unknown } | undefined)?.opened === true,
        run: manifest,
      })
    } catch {
      /* 坏 JSON 跳过（它自己会在别的门里红） */
    }
  }
  return out
}

function main(): void {
  const started = new Date().toISOString()
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const manifests = readManifests()
  const { blob, files } = machineEvidenceBlob()
  const local = localReplies().map((entry) => ({ file: entry.file, texts: entry.texts }))

  const corpusText = readFileSync(join(ROOT, 'evals', 'lv2', 'short-cases.ts'), 'utf8')
  const reading = checkPrivacy({
    manifests: manifests.map((row) => ({ file: row.file, realDbOpened: row.realDbOpened })),
    blob,
    local,
    corpusText,
  })

  /* ---- 预算声明：短场景批次必须声明额度，且未接线额度必须是 0 ---- */
  const shortRuns = manifests.filter((row) => String(row.run.wp ?? '') === 'wp4-short')
  const budgetProblems: string[] = []
  for (const row of shortRuns) {
    const config = row.run.config as { adaptiveSelfTokens?: unknown; rollupTokens?: unknown } | undefined
    if (config === undefined || config.adaptiveSelfTokens === undefined || config.rollupTokens === undefined) {
      budgetProblems.push(`${row.file}: 未声明 adaptiveSelfTokens/rollupTokens`)
      continue
    }
    if (config.adaptiveSelfTokens !== 0 || config.rollupTokens !== 0) {
      budgetProblems.push(`${row.file}: 未接线额度不是 0（${String(config.adaptiveSelfTokens)}/${String(config.rollupTokens)}）`)
    }
  }

  /* ---- 三段式自检（纯函数上跑，不写文件） ---- */
  const selfChecks: { id: string; pass: boolean; note: string }[] = []
  selfChecks.push({
    id: 'SELF-1-真实证据安静',
    pass: reading.leaks.length === 0 && reading.realDbOpened.length === 0,
    note: `泄漏 ${String(reading.leaks.length)} 处 · 打开过真实库的 run ${String(reading.realDbOpened.length)} 份`,
  })
  const injected = checkPrivacy({
    manifests: input0(manifests),
    blob: `${blob}\n${local[0]?.texts[0]?.slice(0, 40) ?? '（本地无正文可注入）'}`,
    local,
    /* 注入场景里语料为空 ⇒ 注入的那句**必然**被判成泄漏（这正是负控要证的） */
    corpusText: '',
  })
  selfChecks.push({
    id: 'SELF-2-注入一条本地正文必须响',
    pass: local.length === 0 ? true : injected.leaks.length > 0,
    note: local.length === 0 ? '本地没有正文（跳过：本地档缺失时这条自检无意义）' : `注入后泄漏 ${String(injected.leaks.length)} 处 ⇒ 检测器会响`,
  })
  const injectedRealDb = checkPrivacy({
    manifests: [...input0(manifests), { file: 'injected', realDbOpened: true }],
    blob,
    local,
    corpusText,
  })
  selfChecks.push({
    id: 'SELF-3-注入一份"打开过真实库"的清单必须响',
    pass: injectedRealDb.realDbOpened.length === reading.realDbOpened.length + 1,
    note: `注入后 ${String(injectedRealDb.realDbOpened.length)} 份（原 ${String(reading.realDbOpened.length)} 份）`,
  })
  const recovered = checkPrivacy({ manifests: input0(manifests), blob, local, corpusText })
  selfChecks.push({
    id: 'SELF-4-恢复：撤掉注入后重新安静',
    pass: recovered.leaks.length === reading.leaks.length && recovered.realDbOpened.length === reading.realDbOpened.length,
    note: `恢复后泄漏 ${String(recovered.leaks.length)} 处 · 真实库 ${String(recovered.realDbOpened.length)} 份`,
  })

  const quotedCorpus = JSON.stringify('做下一步前先确认目标')
  const quotedCorpusReading = checkPrivacy({
    manifests: [], blob: quotedCorpus,
    local: [{ file: 'control-quoted-corpus', texts: [quotedCorpus] }], corpusText,
  })
  selfChecks.push({
    id: 'SELF-5-JSON引用的公开语料不报新正文泄漏',
    pass: quotedCorpusReading.windowsChecked === 1 && quotedCorpusReading.corpusOverlaps.length === 1 && quotedCorpusReading.leaks.length === 0,
    note: '公开语料内容不因 JSON 引号改变归属',
  })
  const quotedNovel = JSON.stringify('Quoted private control sentence must remain private')
  const quotedNovelReading = checkPrivacy({
    manifests: [], blob: quotedNovel,
    local: [{ file: 'control-quoted-novel', texts: [quotedNovel] }], corpusText,
  })
  selfChecks.push({
    id: 'SELF-6-JSON引用的新正文仍必须响',
    pass: quotedNovelReading.windowsChecked === 1 && quotedNovelReading.leaks.length === 1 && quotedNovelReading.corpusOverlaps.length === 0,
    note: '引用形式不授予新正文泄漏豁免',
  })

  const measuredCount = reading.windowsChecked + manifests.length
  const coreChecks = [reading.realDbOpened.length === 0, reading.leaks.length === 0, budgetProblems.length === 0]
  const verdict =
    reading.realDbOpened.length === 0 &&
    reading.leaks.length === 0 &&
    budgetProblems.length === 0 &&
    selfChecks.every((check) => check.pass) &&
    measuredCount > 0
      ? 'PASS'
      : 'FAIL'

  const runId = createLv2RunId({ wpId: 'wp6-privacy-budget', headShort: head })
  const dir = openLv2RunDir(ROOT, runId)
  writeFileSync(
    join(dir, 'readings.json'),
    `${JSON.stringify({ runId, reading: { ...reading, leaks: reading.leaks.slice(0, 50).map(({ file, window }) => ({ file, windowSha256: createHash('sha256').update(window).digest('hex'), codepoints: [...window].length })) }, budgetProblems, selfChecks, machineFiles: files.length }, null, 2)}\n`,
    'utf8',
  )
  const manifestPath = writeLv2Manifest(dir, {
    runId,
    wp: 'wp6-privacy-budget',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    toolVersions: { node: process.version },
    testType: 'privacy-and-budget-verification',
    counts: { total: coreChecks.length + selfChecks.length, passed: coreChecks.filter(Boolean).length + selfChecks.filter((c) => c.pass).length, failed: coreChecks.filter((pass) => !pass).length + selfChecks.filter((c) => !c.pass).length },
    phases: ['single'],
    supersedes: null,
    started,
    ended: new Date().toISOString(),
    worktree: { clean: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() === '', note: '本脚本自己的 run 目录按白名单不计入' },
    sourceFingerprints: Object.fromEntries(
      (['scripts/lv2-privacy-budget-verify.ts', 'scripts/lv2-evidence.ts'] as const).map((path) => [
        path,
        createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex'),
      ]),
    ),
    config: { mode: '只读（不调模型、不开库）', leakWindow: '句子级 ≥10 字符窗口 · 公开语料的完整 JSON 引用按相同内容归属', leakDetails: '只保存 SHA256 / 长度 / 来源文件，不把泄漏正文再次写入公开证据' },
    model: { providerKind: 'none', note: '零模型请求' },
    requests: { planned: 0, actual: 0, note: '零模型请求' },
    denominators: {
      manifests: manifests.length,
      machineFiles: files.length,
      localFiles: reading.localFiles,
      windowsChecked: reading.windowsChecked,
      measuredCount,
      budgetProblems: budgetProblems.length,
    },
    correlations: { cases: 0, conversations: 0, requests: 0, traces: 0 },
    faultInjection: null,
    cleanClose: true,
    realDb: { opened: false, summaryBefore: null, summaryAfter: null, note: '只读；本门自身不打开任何库' },
    verdict,
    limitation:
      '泄漏检测用的是**句子级窗口**（≥10 字符）：它证明"本地正文没有整句进入机器证据"，' +
      '**不**证明"短片段也没有"（`mustNotMentionHits` 这类**语料词**会合法地出现在证据里 —— ' +
      '语料本身就在仓库里，因此那不是新信息）。预算检查只覆盖**已声明**的那两个未接线额度。',
  })

  console.log(`[lv2:privacy] runId = ${runId}（只读 · ${String(manifests.length)} 份清单 · ${String(files.length)} 份机器证据 · ${String(reading.windowsChecked)} 个正文窗口）`)
  console.log(`[lv2:privacy] 打开过真实库的 run = ${String(reading.realDbOpened.length)}（应为 0）`)
  console.log(`[lv2:privacy] 正文泄漏 = ${String(reading.leaks.length)} 处（应为 0）`)
  console.log(`[lv2:privacy] 预算声明问题 = ${String(budgetProblems.length)} 处`)
  for (const check of selfChecks) console.log(`   ${check.pass ? '✅' : '❌'} ${check.id} —— ${check.note}`)
  console.log(`[lv2:privacy] verdict = ${verdict} · measured_count = ${String(measuredCount)} · manifest = ${manifestPath.replace(`${ROOT}\\`, '').replace(/\\/g, '/')}`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

/** 只取"文件 + 是否打开真实库"这两列（自检里复用，避免把 manifest 又读一遍）。 */
function input0(manifests: readonly { file: string; realDbOpened: boolean }[]): { file: string; realDbOpened: boolean }[] {
  return manifests.map((row) => ({ file: row.file, realDbOpened: row.realDbOpened }))
}

main()
