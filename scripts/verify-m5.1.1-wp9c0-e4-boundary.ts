/**
 * M5.1.1 / WP9-C0 —— **Canonical E4 Acceptance Boundary Review**（`pnpm m5.1.1:wp9c0:verify`）
 *
 * ============================================================================
 *  这道门回答什么（用户 R-47 §5 的唯一授权范围）
 * ============================================================================
 * R-47 裁定 `WP9-B2 = PASS` 被接受，但**其适用面被收紧**：
 * "它证明了 State Bootstrap 的受信 SYSTEM 归因，**并没有自动证明** canonical E4/S3 已经完成。"
 *
 * 于是 C0 只做一件事：用**可复现的机器证据**回答
 *
 * ```text
 *   冻结的 E4 / S3 究竟要求 哪个生产事件族 · 哪一类系统发起行为 · 哪些权威账本提供证据？
 * ```
 *
 * 它**不**裁定 E4 是否 PASS，**不**实现任何 SYSTEM 生产入口，**不**重跑 E1–E8，
 * **不**修改任何既有 verifier 的判据文本/常量/阈值。
 *
 * ============================================================================
 *  只读边界（可自证）
 * ============================================================================
 *  · 本文件**不 import 任何数据库模块**（不 `db/index.ts`、不 `dev/sandbox.ts`、
 *    不任何仓储）；运行期**不开任何库**、**不** `isolateDatabase`。
 *  · `data/pglite` 只被 `statSync` 采样（文件数 / 总字节 / mtime 三项前后一致）。
 *  · 对 `src/**` 只有**读文本**与**一次纯函数调用**
 *    （`conversationAttributionForEntryMode()` —— 它只读契约常量，不碰 IO/DB）。
 *  · 唯一的写面是 `artifacts/m5.1.1/wp9c0-e4-boundary.json`。
 *
 * ============================================================================
 *  退出码语义（与 B0 一样必须显式声明，否则"红/绿"没有含义）
 * ============================================================================
 * ```text
 *   0 = 复核完成（逐字引用未漂移 · 矩阵齐备 · 探针有读数 · 量具有效）
 *   1 = 复核未完成（引用漂移 / 矩阵缺行 / 关键来源缺失 / 探测出"已接线"）
 *   2 = 量具无效（某个计数型判据 measured_count = 0 ⇒ MEASUREMENT INVALID，不是 PASS）
 * ```
 *
 * ============================================================================
 *  本门**不做**的判定（R-47 §5：交回用户）
 * ============================================================================
 * 载体归属（`Q1`）与"后台任务"含义（`Q2`）**不在这里裁定**；本门只把问题、逐字出处
 * 与各自后果落盘。见 `docs/m5.1.1/M5.1.1-WP9C0-E4-Acceptance-Boundary-Review.md` §4。
 */

import { createHash } from 'node:crypto'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  conversationAttributionForEntryMode,
  type ConversationEntryMode,
} from '../src/infrastructure/runtime/conversation-attribution.ts'
import {
  STATE_BOOTSTRAP_COMPONENT,
  STATE_BOOTSTRAP_FAMILY,
} from '../src/state/bootstrap-attestation.ts'

// ---------------------------------------------------------------------------
// 检查器 / 量具
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, ok: boolean, detail: string): boolean {
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}  [${detail}]`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}  [${detail}]`)
  }
  return ok
}

function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

function measure(label: string, count: number, valid = count > 0): void {
  measurements.push({ label, count, valid })
  console.log(`  · 量：${label} = ${count}${valid ? '' : '   ← MEASUREMENT INVALID'}`)
}

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')
const DOCS = join(ROOT, 'docs')
const ART = join(ROOT, 'artifacts', 'm5.1.1')
const PROD_DB_DIR = join(ROOT, 'data', 'pglite')

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** 归一化：折叠空白、去首尾 —— 判据比的是**内容**，不是排版 */
const norm = (text: string): string => text.replace(/\s+/g, ' ').trim()

function listFiles(root: string, ext = '.ts'): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === 'node_modules' || name === '.git') continue
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else if (name.endsWith(ext)) out.push(abs)
    }
  }
  walk(root)
  return out.sort()
}

const readText = (file: string): string => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

const linesOf = (file: string): string[] => readText(file).split('\n')

/** 1-based 取行（越界返回空串 —— 由判据自己报"来源缺失"） */
const lineAt = (file: string, line: number): string => linesOf(file)[line - 1] ?? ''

/** 逐字锚点：该行的**归一化内容**必须等于冻结期望 */
function anchorText(id: string, file: string, line: number, expected: string, found: string[]): void {
  const actual = norm(lineAt(join(ROOT, file), line))
  const want = norm(expected)
  const ok = actual === want
  check(
    `逐字锚点 ${id}（${file.replace(/\\/g, '/')}:${line}）`,
    ok,
    ok ? `sha256=${sha256(actual).slice(0, 12)}…` : `期望「${want.slice(0, 60)}…」实际「${actual.slice(0, 60)}…」`
  )
  found.push(`${id}|${file.replace(/\\/g, '/')}:${line}|${sha256(actual).slice(0, 16)}|${ok ? 'MATCH' : 'DRIFT'}`)
}

/** 该行必须**包含**某段文字（用于长行/表格行的关键子串） */
function anchorContains(id: string, file: string, line: number, needle: string, found: string[]): void {
  const actual = norm(lineAt(join(ROOT, file), line))
  const ok = actual.includes(norm(needle))
  check(
    `逐字锚点 ${id}（${file.replace(/\\/g, '/')}:${line} 含关键子串）`,
    ok,
    ok ? `sha256=${sha256(actual).slice(0, 12)}…` : `实际「${actual.slice(0, 70)}…」不含「${needle.slice(0, 50)}…」`
  )
  found.push(`${id}|${file.replace(/\\/g, '/')}:${line}|${sha256(actual).slice(0, 16)}|${ok ? 'MATCH' : 'DRIFT'}`)
}

// ---------------------------------------------------------------------------
// 断言集合（**同一个函数**同时服务真实仓库与注入副本 —— 检测器只有一份）
// ---------------------------------------------------------------------------

interface Finding {
  rule: string
  detail: string
}

interface Detection {
  findings: Finding[]
  readings: Record<string, number | string>
}

/** 冻结的期望（本门**自己写死**，不从被测物读回来） */
const FROZEN = {
  execE4Label: 'E4 system initiated',
  execEList: [
    'E1 真实用户消息',
    'E2 agent 以 user role 替发',
    'E3 character initiated',
    'E4 system initiated',
    'E5 tool execution',
    'E6 failed execution',
    'E7 legacy unknown read/replay',
    'E8 developer control audit',
  ],
  execLedgerTruth: 'ledger attribution truth',
  execEvidenceLevel: 'Level 1 + Level 2。',
  s3Row:
    '| **S3** | **System initiated** | 是否正确标 `SYSTEM`，以及"不知道"如何表达 | ' +
    '`initiator=Known(SYSTEM/组件名)`；无法确认时 `initiator=Unknown(RUNTIME_UNRESOLVED)`（U-04） | ' +
    '无证据地填成 `USER`/`CHARACTER` → 必拒 |',
  s3Level1: 'S1–S6 至少 Level 2（账本/事件）',
  s3Level2: 'S4 / S5 需要 Level 1（真实执行结果 / 真实失败）',
  d01Row3: '| 系统后台任务 | 是否正确标 `SYSTEM` |',
  d01ScenarioNames: [
    '用户要求苏沐薇执行动作',
    '苏沐薇自主触发动作',
    '系统后台任务',
    'Tool 真正执行',
    '失败执行',
    'Replay / rebuild',
  ],
  sScenarioNames: [
    'S1 User initiated',
    'S2 Character initiated',
    'S3 System initiated',
    'S4 Tool executed',
    'S5 failed execution',
    'S6 legacy unknown',
  ],
  wp9Mapping: 'E4→S3',
  sandboxProdDir: "export const PRODUCTION_DB_DIR = resolve('data/pglite')",
  recorderEntry: 'async recordSystemEvent(',
} as const

/** 从 `| a | b | c |` 取第 index 个非空单元格 */
function tableCells(row: string): string[] {
  const cells = row.split('|').map((c) => norm(c))
  return cells.slice(1, cells.length - 1)
}

/** 去掉表格单元格里的 `**粗体**` 标记（只用于取"场景名"这类比较） */
const stripBold = (text: string): string => text.replace(/\*\*/g, '').trim()

/**
 * 全部判据。`root` = 仓库根（真实或注入副本）。
 *
 * ⚠️ 静态探针（对文本计数）在副本上**会变** ⇒ 负控能让它们响；
 *    运行期探针（`conversationAttributionForEntryMode`）只读契约常量，不随副本变 —— 它是承重的那一半。
 */
function detect(root: string): Detection {
  const findings: Finding[] = []
  const readings: Record<string, number | string> = {}
  const srcRoot = join(root, 'src')
  const srcFiles = listFiles(srcRoot)
  readings.srcFiles = srcFiles.length
  if (srcFiles.length === 0) findings.push({ rule: 'R0', detail: `扫描不到任何 src 文件（${srcRoot}）` })

  // ---- R1：canonical E1–E8 的唯一出处（计划 §WP9 Objective） ----
  const execPlan = join(root, 'docs/m5.1.1/M5.1.1-Execution-Plan.md')
  const execLines = linesOf(execPlan)
  // 计划 :1057 是围栏，:1058-1065 是八条 E，:1066 是收尾围栏
  const eBlock = execLines.slice(1057, 1065).map(norm)
  readings.execEList = eBlock.filter((l) => l.length > 0).length
  if (JSON.stringify(eBlock.filter((l) => l.length > 0)) !== JSON.stringify(FROZEN.execEList)) {
    findings.push({ rule: 'R1', detail: 'Execution-Plan:1058-1065 的 E1–E8 清单与冻结期望不一致' })
  }
  if (norm(execLines[1060] ?? '') !== FROZEN.execE4Label) {
    findings.push({ rule: 'R1', detail: `Execution-Plan:1061 不再是「${FROZEN.execE4Label}」` })
  }
  if (norm(execLines[1087] ?? '') !== FROZEN.execLedgerTruth) {
    findings.push({ rule: 'R1', detail: `Execution-Plan:1088 不再是「${FROZEN.execLedgerTruth}」` })
  }
  if (norm(execLines[1098] ?? '') !== FROZEN.execEvidenceLevel) {
    findings.push({ rule: 'R1', detail: `Execution-Plan:1099 不再是「${FROZEN.execEvidenceLevel}」` })
  }

  // ---- R2：S3 的冻结正控 / 证据等级（Test-and-Gate-Plan） ----
  const tgp = linesOf(join(root, 'docs/m5.1.1/M5.1.1-Test-and-Gate-Plan.md'))
  if (norm(tgp[96] ?? '') !== norm(FROZEN.s3Row)) {
    findings.push({ rule: 'R2', detail: 'Test-and-Gate-Plan:97 的 S3 行与冻结期望不一致' })
  }
  if (!norm(tgp[147] ?? '').includes(norm(FROZEN.s3Level1))) {
    findings.push({ rule: 'R2', detail: `Test-and-Gate-Plan:148 不再包含「${FROZEN.s3Level1}」` })
  }
  if (!norm(tgp[148] ?? '').includes(norm(FROZEN.s3Level2))) {
    findings.push({ rule: 'R2', detail: `Test-and-Gate-Plan:149 不再包含「${FROZEN.s3Level2}」` })
  }
  const sScenarioNames = tgp
    .slice(94, 100)
    .map((row) => {
      const cells = tableCells(row)
      return `${stripBold(cells[0] ?? '')} ${stripBold(cells[1] ?? '')}`.trim()
    })
  readings.sScenarioRows = sScenarioNames.length
  if (JSON.stringify(sScenarioNames) !== JSON.stringify(FROZEN.sScenarioNames)) {
    findings.push({ rule: 'R2', detail: `S1–S6 场景名与冻结期望不一致：${JSON.stringify(sScenarioNames)}` })
  }

  // ---- R3：D01 §7 验收场景表（"后台任务"的真实出处） ----
  const d01Text = readText(join(root, 'docs/m5.1/M5.1-D01-Ledger-Actor-Attribution-Gap.md'))
  const d01 = d01Text.split('\n')
  const d01Row3 = norm(d01[254] ?? '')
  if (d01Row3 !== norm(FROZEN.d01Row3)) {
    findings.push({ rule: 'R3', detail: 'M5.1-D01:255 的"系统后台任务"行与冻结期望不一致' })
  }
  const d01ScenarioNames = d01.slice(252, 258).map((row) => tableCells(row)[0] ?? '')
  readings.d01ScenarioRows = d01ScenarioNames.length
  if (JSON.stringify(d01ScenarioNames) !== JSON.stringify(FROZEN.d01ScenarioNames)) {
    findings.push({ rule: 'R3', detail: `D01 §7 场景名与冻结期望不一致：${JSON.stringify(d01ScenarioNames)}` })
  }

  // ---- R4：WP9-0 的 E→S 映射 + WP9-GAP-1 的测量原文 ----
  const wp9F4 = linesOf(join(root, 'docs/m5.1.1/M5.1.1-WP9-Compatible-Assertion-Record.md'))
  if (!norm(wp9F4[33] ?? '').includes(FROZEN.wp9Mapping)) {
    findings.push({ rule: 'R4', detail: `WP9 F4:34 不再包含「${FROZEN.wp9Mapping}」映射` })
  }
  const gapBlock = wp9F4.slice(86, 104).map(norm).join(' ')
  for (const needle of ['WP9-GAP-1', 'user_message / assistant_message', '行动侧的 initiator 由因果来源决定']) {
    if (!gapBlock.includes(norm(needle))) {
      findings.push({ rule: 'R4', detail: `WP9 F4:87-104 的 capability gap 段不再包含「${needle}」` })
    }
  }

  // ---- R5：canonical 出处的**唯一性**声明仍在（WP9-0 的"单一出处"纪律） ----
  const wp9F4Head = wp9F4.slice(18, 32).map(norm).join(' ')
  if (!wp9F4Head.includes('唯一') || !wp9F4Head.includes('Execution-Plan.md:1057-1066')) {
    findings.push({ rule: 'R5', detail: 'WP9 F4:19-32 的"唯一出处"声明不再成立' })
  }

  // ---- P1a：对话生产 ingress 的族集合（运行期，承重） ----
  const modes: ConversationEntryMode[] = ['interactive_human_console', 'scripted_agent_runner']
  const families: string[] = []
  for (const mode of modes) {
    for (const producer of conversationAttributionForEntryMode(mode).producers) families.push(String(producer.family))
  }
  const familySet = [...new Set(families)].sort()
  readings.conversationFamilies = familySet.join(',')
  readings.systemEventProducerInIngress = familySet.includes('system_event') ? 1 : 0
  readings.stateTransitionInConversationFamilies = familySet.includes(STATE_BOOTSTRAP_FAMILY) ? 1 : 0

  // ---- P1b/P2/P3/P4/P5：静态生产可达性探针 ----
  const allText = srcFiles.map((file) => readText(file))
  const countMatches = (re: RegExp): number =>
    allText.reduce((sum, text) => sum + (text.match(re) ?? []).length, 0)

  const systemEventFamilyLiterals = countMatches(/family:\s*'system_event'/g)
  const recordSystemCallSites = countMatches(/\.recordSystemEvent\s*\(/g)
  const recordSystemDefinitions = countMatches(/async\s+recordSystemEvent\s*\(/g)
  const actionInitiatorCausal = countMatches(/attestActionInitiatorFromCausalOrigin\s*\(/g)
  const actionInitiatorUnresolved = countMatches(/attestActionInitiatorUnresolved\s*\(/g)
  const causalFromConversation = countMatches(/correlationSourceFromConversationEvent\s*\(/g)
  const actionSideSystemPrincipals = allText.reduce(
    (sum, text) => sum + (text.match(/kind:\s*'SYSTEM'/g) ?? []).length,
    0
  )
  const actionDirs = listFiles(join(srcRoot, 'kernel/action'))
    .concat(listFiles(join(srcRoot, 'infrastructure/action')))
    .map((file) => readText(file))
  const actionDirsSystemPrincipals = actionDirs.reduce(
    (sum, text) => sum + (text.match(/kind:\s*'SYSTEM'/g) ?? []).length,
    0
  )
  const backgroundJobImports = countMatches(/from\s+['"][^'"]*app\/memory\/job\.ts['"]/g)
  const trustedEnvelopeConstructors = countMatches(/constructTrustedAttribution\(\s*\{/g)

  readings.systemEventFamilyLiterals = systemEventFamilyLiterals
  readings.recordSystemCallSites = recordSystemCallSites
  readings.recordSystemDefinitions = recordSystemDefinitions
  readings.actionInitiatorCausalOccurrences = actionInitiatorCausal
  readings.actionInitiatorUnresolvedOccurrences = actionInitiatorUnresolved
  readings.causalFromConversationOccurrences = causalFromConversation
  readings.systemPrincipalsInSrc = actionSideSystemPrincipals
  readings.actionDirsSystemPrincipals = actionDirsSystemPrincipals
  readings.backgroundJobImports = backgroundJobImports
  readings.trustedEnvelopeConstructors = trustedEnvelopeConstructors
  readings.stateBootstrapComponent = `${STATE_BOOTSTRAP_COMPONENT.kind}/${STATE_BOOTSTRAP_COMPONENT.id}`

  // ---- R6：canonical 生产引导组件的**规范路径**（不 import，只文本断言） ----
  const sandboxLine = norm(lineAt(join(srcRoot, 'dev/sandbox.ts'), 50))
  if (sandboxLine !== norm(FROZEN.sandboxProdDir)) {
    findings.push({ rule: 'R6', detail: 'src/dev/sandbox.ts:50 的 PRODUCTION_DB_DIR 定义与冻结期望不一致' })
  }
  const recorderEntry = countMatches(new RegExp(`async\\s+recordSystemEvent\\s*\\(`, 'g'))
  if (recorderEntry === 0) {
    findings.push({ rule: 'R6', detail: '录制端口 recordSystemEvent 的**定义**不见了（探针 P2 会变成空问题）' })
  }

  const out: Record<string, number | string> = { ...readings }
  return { findings, readings: out }
}

// ---------------------------------------------------------------------------
// §0 只读边界
// ---------------------------------------------------------------------------

section('§0 只读边界：本门不开任何库、不改任何源码')

function dirFingerprint(dir: string): { files: number; bytes: number; mtime: string } | null {
  try {
    const entries = readdirSync(dir, { recursive: true }) as string[]
    let files = 0
    let bytes = 0
    for (const entry of entries) {
      const abs = join(dir, entry)
      const stat = statSync(abs)
      if (!stat.isFile()) continue
      files += 1
      bytes += stat.size
    }
    return { files, bytes, mtime: statSync(dir).mtime.toISOString() }
  } catch {
    return null
  }
}

const prodBefore = dirFingerprint(PROD_DB_DIR)
console.log(`  [real-db] ${PROD_DB_DIR} → ${JSON.stringify(prodBefore)}`)
check(
  '本门**不开库**：脚本里没有 isolateDatabase / initDatabase / 任何 db 模块 import',
  !readText(join(ROOT, 'scripts/verify-m5.1.1-wp9c0-e4-boundary.ts')).match(
    /from\s+'[^']*(db\/index|dev\/sandbox|persistence\/db)[^']*'/
  ),
  '静态自证（读自己的源码）'
)
check(
  '真实库 `data/pglite` 存在且**只被 statSync 采样**（路径与冻结常量一致）',
  prodBefore !== null && prodBefore.files > 0,
  JSON.stringify(prodBefore)
)

// ---------------------------------------------------------------------------
// §1 四份材料逐字引用
// ---------------------------------------------------------------------------

section('§1 四份材料的逐字引用锁定（任何人不改冻结文件，就不可能改这里的引用）')

const anchorReadings: string[] = []

// 材料一：canonical E4 的唯一定义处
anchorText('材料一/E4 标签', 'docs/m5.1.1/M5.1.1-Execution-Plan.md', 1061, FROZEN.execE4Label, anchorReadings)
anchorText('材料一/ledger attribution truth', 'docs/m5.1.1/M5.1.1-Execution-Plan.md', 1088, FROZEN.execLedgerTruth, anchorReadings)
anchorText('材料一/证据等级', 'docs/m5.1.1/M5.1.1-Execution-Plan.md', 1099, FROZEN.execEvidenceLevel, anchorReadings)
for (const [index, expected] of FROZEN.execEList.entries()) {
  anchorText(`材料一/E${index + 1}`, 'docs/m5.1.1/M5.1.1-Execution-Plan.md', 1058 + index, expected, anchorReadings)
}

// 材料二：S3 的正控 / 负控 / 证据等级
anchorText('材料二/S3 行', 'docs/m5.1.1/M5.1.1-Test-and-Gate-Plan.md', 97, FROZEN.s3Row, anchorReadings)
anchorContains('材料二/S1–S6 等级下限', 'docs/m5.1.1/M5.1.1-Test-and-Gate-Plan.md', 148, FROZEN.s3Level1, anchorReadings)
anchorContains('材料二/S4·S5 需要 L1', 'docs/m5.1.1/M5.1.1-Test-and-Gate-Plan.md', 149, FROZEN.s3Level2, anchorReadings)

// 材料三：WP9-GAP-1 的阻塞入口 + E→S 映射
anchorContains('材料三/E4→S3 映射', 'docs/m5.1.1/M5.1.1-WP9-Compatible-Assertion-Record.md', 34, FROZEN.wp9Mapping, anchorReadings)
anchorContains(
  '材料三/GAP-1 主语',
  'docs/m5.1.1/M5.1.1-WP9-Compatible-Assertion-Record.md',
  88,
  'WP9-GAP-1  E4-A：S3 的 Known(SYSTEM/组件名) 分支',
  anchorReadings
)
anchorContains(
  '材料三/GAP-1 测量（生产 ingress 只覆盖两族）',
  'docs/m5.1.1/M5.1.1-WP9-Compatible-Assertion-Record.md',
  89,
  '生产 ingress 只覆盖 user_message / assistant_message',
  anchorReadings
)
anchorContains(
  '材料三/GAP-1 因果来源（只能是 RECORDED 对话行）',
  'docs/m5.1.1/M5.1.1-WP9-Compatible-Assertion-Record.md',
  92,
  '而因果来源只能是真实 RECORDED 对话行（USER/SERVICE/CHARACTER）',
  anchorReadings
)
anchorContains(
  '材料三/行动侧 initiator 的无因果分支（action-turn）',
  'src/kernel/action/action-turn.ts',
  146,
  '? attestActionInitiatorUnresolved({ adapterId: options.attribution.adapterId })',
  anchorReadings
)
anchorContains(
  '材料三/行动侧 initiator 的因果分支（action-turn）',
  'src/kernel/action/action-turn.ts',
  147,
  ': attestActionInitiatorFromCausalOrigin({',
  anchorReadings
)
anchorContains(
  '材料三/行动侧 initiator 唯一路径（action-turn）',
  'src/kernel/action/action-turn.ts',
  149,
  'causalSource: correlationSourceFromConversationEvent({',
  anchorReadings
)
anchorContains(
  '材料三/触发事件是行动因果的唯一输入（action-turn）',
  'src/kernel/action/action-turn.ts',
  151,
  'triggeringEvent: input.triggeringEvent,',
  anchorReadings
)
anchorContains(
  '材料三/后台抽取开关的 NOT-WIRED 告警',
  'src/main.ts',
  2115,
  '这个开关**没有接到任何东西**',
  anchorReadings
)

// 材料四：WP9-B2 的真实证据（文件存在性 + 关键读数在 §5 里比对）
const b2Path = join(ART, 'wp9b2-attestation.json')
const b2 = (() => {
  try {
    return JSON.parse(readText(b2Path)) as Record<string, unknown>
  } catch {
    return null
  }
})()
check('材料四/WP9-B2 证据文件可读（`wp9b2-attestation.json`）', b2 !== null, b2 === null ? '(读不到或不是 JSON)' : sha256(readText(b2Path)).slice(0, 16) + '…')

measure('逐字锚点数', anchorReadings.length)
check(
  '全部逐字锚点 = MATCH（没有引用漂移）',
  anchorReadings.every((row) => row.endsWith('|MATCH')),
  anchorReadings.filter((row) => !row.endsWith('|MATCH')).map((row) => row.split('|')[0]).join(', ') || `${anchorReadings.length} 个全部 MATCH`
)

// ---------------------------------------------------------------------------
// §2 主检测器（真实仓库）
// ---------------------------------------------------------------------------

section('§2 真实仓库：生产可达性探针（P1–P5）')

const real = detect(ROOT)
console.log(`  · 读数：${JSON.stringify(real.readings)}`)
check(
  '真实仓库上**没有**任何探测为"已接线"（对话族无 system_event · 录制端口 0 调用点 · 行动侧 0 个 SYSTEM 位次 · 后台任务 0 个 import）',
  real.readings.systemEventProducerInIngress === 0 &&
    real.readings.stateTransitionInConversationFamilies === 0 &&
    real.readings.recordSystemCallSites === 0 &&
    real.readings.actionDirsSystemPrincipals === 0 &&
    real.readings.backgroundJobImports === 0,
  JSON.stringify({
    systemEventProducerInIngress: real.readings.systemEventProducerInIngress,
    recordSystemCallSites: real.readings.recordSystemCallSites,
    actionDirsSystemPrincipals: real.readings.actionDirsSystemPrincipals,
    backgroundJobImports: real.readings.backgroundJobImports,
  })
)
check(
  '**正控**（否则探针是空问题）：两个"入口存在但没人调"的对象**确实存在** —— ' +
    '`recordSystemEvent` **定义** 1 处（否则 P2 量的是一个不存在的符号）· 唯一受信信封构造点 1 处；' +
    '行动侧的两种 initiator 形态由 §1 的 action-turn 锚点逐行钉住',
  real.readings.recordSystemDefinitions === 1 && real.readings.trustedEnvelopeConstructors === 1,
  JSON.stringify({
    recordSystemDefinitions: real.readings.recordSystemDefinitions,
    trustedEnvelopeConstructors: real.readings.trustedEnvelopeConstructors,
    actionInitiatorCausalOccurrences: real.readings.actionInitiatorCausalOccurrences,
    actionInitiatorUnresolvedOccurrences: real.readings.actionInitiatorUnresolvedOccurrences,
    causalFromConversationOccurrences: real.readings.causalFromConversationOccurrences,
  })
)
measure('真实仓库扫描的 src 文件数', Number(real.readings.srcFiles))
measure('对照的对话生产族数', String(real.readings.conversationFamilies).split(',').length)

// ---------------------------------------------------------------------------
// §3 溯源链
// ---------------------------------------------------------------------------

section('§3 溯源链：D01 §7 → S1–S6 → E4→S3 → canonical E4')

const d01Names = FROZEN.d01ScenarioNames
const sNames = FROZEN.sScenarioNames
measure('溯源链的对齐行数', d01Names.length)
check(
  '溯源链的两端**逐行 1:1 对齐**（D01 §7 六行 ↔ S1–S6 六行，顺序一致）',
  d01Names.length === sNames.length && d01Names.length === 6,
  `${d01Names.length} ↔ ${sNames.length}`
)
/**
 * ⚠️ 这里**只断言两条能被机器判定的措辞事实**，而不是用 token 重叠去"猜"哪些行改了措辞
 * （中英对照下 token 重叠恒为假 ⇒ 那个启发式会把自己算成"五行都变了"，本 WP 实测踩到过）。
 */
const row3 = { d01: d01Names[2] ?? '', s: sNames[2] ?? '' }
const row6 = { d01: d01Names[5] ?? '', s: sNames[5] ?? '' }
const alignment = d01Names.map((name, index) => ({ row: index + 1, d01: name, s: sNames[index] ?? '' }))
check(
  '★ 第 3 行的措辞在"上抬进冻结验收面"时被**一般化**：D01 侧含"后台任务"，S3 侧不含（改为 `System initiated`）',
  /后台任务/.test(row3.d01) && !/后台任务/.test(row3.s) && /System initiated/.test(row3.s),
  `D01=「${row3.d01}」→ S3=「${row3.s}」`
)
check(
  '★ 第 6 行的措辞同样被改写：D01 = `Replay / rebuild`，S6 = `legacy unknown`',
  /Replay/.test(row6.d01) && /legacy unknown/.test(row6.s),
  `D01=「${row6.d01}」→ S6=「${row6.s}」`
)
check(
  '★ 其余四行（1 / 2 / 4 / 5）在两端**逐行同序**（顺序对齐 = 溯源链成立的机械证据）',
  alignment.length === 6 &&
    alignment[0]!.d01 === '用户要求苏沐薇执行动作' &&
    alignment[1]!.d01 === '苏沐薇自主触发动作' &&
    alignment[3]!.d01 === 'Tool 真正执行' &&
    alignment[4]!.d01 === '失败执行',
  alignment.map((row) => `${row.row}:${row.d01}`).join(' · ')
)

// ---------------------------------------------------------------------------
// §4 PREMISE CHECK
// ---------------------------------------------------------------------------

section('§4 PREMISE CHECK：R-47 引用的"后台任务"在哪份文档里')

const tgpFull = readText(join(ROOT, 'docs/m5.1.1/M5.1.1-Test-and-Gate-Plan.md'))
const d01Full = readText(join(ROOT, 'docs/m5.1/M5.1-D01-Ledger-Actor-Attribution-Gap.md'))
const tagCount = (text: string): number => (text.match(/后台任务/g) ?? []).length
const tgpCount = tagCount(tgpFull)
const d01Count = tagCount(d01Full)
const d01Section7Rows = linesOf(join(ROOT, 'docs/m5.1/M5.1-D01-Ledger-Actor-Attribution-Gap.md')).slice(252, 258)
const d01Section7Count = tagCount(d01Section7Rows.join('\n'))
measure('Test-and-Gate-Plan 全文出现"后台任务"的次数（预期 0，作为分母仍是有效读数）', tgpCount, true)
measure('D01 全文出现"后台任务"的次数（预期 > 0）', d01Count)
measure('D01 §7 验收场景表内出现"后台任务"的次数（预期 1）', d01Section7Count)
check(
  '★ `PREMISE CHECK`：`Test-and-Gate-Plan.md` 全文**不含**"后台任务"；该措辞的真实出处是 `M5.1-D01-…md` §7 的验收场景表第 3 行',
  tgpCount === 0 && d01Section7Count === 1,
  `Test-and-Gate-Plan=${tgpCount} · D01 全文=${d01Count} · D01 §7 表内=${d01Section7Count}`
)
check(
  '★ R-47 引用的**实质**有出处：S3 的"必须回答"与 D01 §7 第 3 行同义（都是"是否正确标 SYSTEM"）',
  norm(FROZEN.d01Row3).includes('是否正确标 `SYSTEM`') && norm(FROZEN.s3Row).includes('是否正确标 `SYSTEM`'),
  '两处逐字都含「是否正确标 `SYSTEM`」'
)

// ---------------------------------------------------------------------------
// §5 覆盖率矩阵（每行结论由读数推导）
// ---------------------------------------------------------------------------

section('§5 覆盖率矩阵（结论列由读数推导，不是手写）')

interface MatrixRow {
  id: number
  claim: string
  criterion: string
  verdict: 'supported' | 'not-proven' | 'not-substitutable'
  reading: string
  source: string
}

const matrix: MatrixRow[] = []
const b2Read = (path: string): unknown => {
  const node = path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, b2)
  return node
}

const E4A_EXPECTED: Record<string, string> = {
  initiator: `KNOWN|SYSTEM|state-bootstrap|-`,
  actor: `KNOWN|SYSTEM|state-bootstrap|-`,
  executor: 'ABSENT|-|-|-',
  authority: 'KNOWN|SYSTEM_RULE|state-bootstrap-rule|-',
  recordedBy: 'KNOWN|SYSTEM|kernel|-',
  contentOriginator: 'ABSENT|-|-|-',
}
const E4B_EXPECTED: Record<string, string> = {
  initiator: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  actor: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  executor: 'ABSENT|-|-|-',
  authority: 'UNKNOWN|-|-|RUNTIME_UNRESOLVED',
  recordedBy: 'KNOWN|SYSTEM|kernel|-',
  contentOriginator: 'ABSENT|-|-|-',
}
const e4a = (b2Read('e4a.physicalSlots') ?? {}) as Record<string, string>
const e4b = (b2Read('e4b.physicalSlots') ?? {}) as Record<string, string>
const e4aOrigin = String(b2Read('e4a.attributionOrigin') ?? '')
const e4aReadbackOrigin = String(b2Read('e4a.readback.attributionOrigin') ?? '')
const e4aSlotsCount = Object.keys(e4a).length
measure('材料四/E4-A 读回的槽位数', e4aSlotsCount)
measure('材料四/E4-B 读回的槽位数', Object.keys(e4b).length)

matrix.push({
  id: 1,
  claim: '真实 SYSTEM 身份可受信建立',
  criterion: 'B2 E4-A：受信证据 ⇒ Known(SYSTEM/state-bootstrap)（品牌 + 运行期 WeakSet）',
  verdict: JSON.stringify(e4a) === JSON.stringify(E4A_EXPECTED) ? 'supported' : 'not-proven',
  reading: `initiator=${e4a.initiator ?? '(缺)'} · actor=${e4a.actor ?? '(缺)'}`,
  source: 'artifacts/m5.1.1/wp9b2-attestation.json → e4a.physicalSlots',
})
matrix.push({
  id: 2,
  claim: 'SYSTEM 发起的状态转换可持久化',
  criterion: `B2 E4-A：物理行 attribution_origin = RECORDED（family = ${STATE_BOOTSTRAP_FAMILY}）`,
  verdict: e4aOrigin === 'RECORDED' ? 'supported' : 'not-proven',
  reading: `attributionOrigin=${e4aOrigin}`,
  source: 'artifacts/m5.1.1/wp9b2-attestation.json → e4a.attributionOrigin',
})
matrix.push({
  id: 3,
  claim: 'SYSTEM 归因可受信读回',
  criterion: 'B2 E4-A：canonical 读取器回读 origin = RECORDED（与物理列逐格一致）',
  verdict: e4aReadbackOrigin === 'RECORDED' ? 'supported' : 'not-proven',
  reading: `readback.attributionOrigin=${e4aReadbackOrigin}`,
  source: 'artifacts/m5.1.1/wp9b2-attestation.json → e4a.readback',
})
matrix.push({
  id: 4,
  claim: '真实生产 `system_event` 已接线',
  criterion: 'P1a 对话生产族集合含 system_event ∨ P1b `family: \'system_event\'` 字面量 > 0',
  verdict:
    real.readings.systemEventProducerInIngress === 0 && real.readings.systemEventFamilyLiterals === 0
      ? 'not-proven'
      : 'supported',
  reading: `conversationFamilies=${String(real.readings.conversationFamilies)} · systemEventFamilyLiterals=${String(real.readings.systemEventFamilyLiterals)}`,
  source: 'scripts/verify-m5.1.1-wp9c0-e4-boundary.ts §2 P1a/P1b',
})
matrix.push({
  id: 5,
  claim: 'SYSTEM 发起 ActionGateway 行动',
  criterion:
    'P3 行动目录（`kernel/action` + `infrastructure/action`）里的 SYSTEM 位次 = 0，' +
    '而仓库里**确实**存在 SYSTEM 位次构造（探针非空转）；行动 initiator 只有两式，其二来自 `triggeringEvent`',
  verdict:
    Number(real.readings.systemPrincipalsInSrc) > 0 && real.readings.actionDirsSystemPrincipals === 0
      ? 'not-proven'
      : 'supported',
  reading:
    `actionDirsSystemPrincipals=${String(real.readings.actionDirsSystemPrincipals)} · ` +
    `systemPrincipalsInSrc=${String(real.readings.systemPrincipalsInSrc)} · ` +
    `actionInitiatorCausalOccurrences=${String(real.readings.actionInitiatorCausalOccurrences)} · ` +
    `actionInitiatorUnresolvedOccurrences=${String(real.readings.actionInitiatorUnresolvedOccurrences)}`,
  source: 'src/kernel/action/action-turn.ts:144-153（§1 锚点）+ §2 P3',
})
matrix.push({
  id: 6,
  claim: 'D01 §7 所述"系统后台任务"真实执行',
  criterion: 'P4 `src/**` import `app/memory/job.ts` = 0 ∧ 开关消费者只有 NOT-WIRED 告警',
  verdict: real.readings.backgroundJobImports === 0 ? 'not-proven' : 'supported',
  reading: `backgroundJobImports=${String(real.readings.backgroundJobImports)}`,
  source: '§2 P4 + src/main.ts:2113-2119（NOT-WIRED 告警）',
})
matrix.push({
  id: 7,
  claim: '非替代性：rows 1–3 的证据不能顶替 rows 4–6',
  criterion:
    `${STATE_BOOTSTRAP_FAMILY} ∉ 对话生产族 ∧ 受信信封唯一构造点不在对话 ingress ∧ 行动侧 0 个 SYSTEM 位次`,
  verdict:
    real.readings.stateTransitionInConversationFamilies === 0 &&
    real.readings.trustedEnvelopeConstructors === 1
      ? 'not-substitutable'
      : 'supported',
  reading:
    `stateTransitionInConversationFamilies=${String(real.readings.stateTransitionInConversationFamilies)} · ` +
    `trustedEnvelopeConstructors=${String(real.readings.trustedEnvelopeConstructors)}`,
  source: '§2 P1a/P5 + src/state/bootstrap-attestation.ts',
})

measure('覆盖率矩阵的行数', matrix.length)
check(
  '★ 覆盖率矩阵 7 行齐备，且 rows 1–3 = `supported`、rows 4–6 = `not-proven`、row 7 = `not-substitutable`',
  matrix.length === 7 &&
    matrix.slice(0, 3).every((row) => row.verdict === 'supported') &&
    matrix.slice(3, 6).every((row) => row.verdict === 'not-proven') &&
    matrix[6]?.verdict === 'not-substitutable',
  matrix.map((row) => `${row.id}:${row.verdict}`).join(' · ')
)
check(
  '★ E4-B 的诚实 Unknown 形态与冻结期望逐格一致（`REQUIRED` 允许 Unknown，不允许 Absent）',
  JSON.stringify(e4b) === JSON.stringify(E4B_EXPECTED),
  Object.entries(e4b).map(([k, v]) => `${k}=${v}`).join(' · ')
)

// ---------------------------------------------------------------------------
// §6 交给用户的判定问题（**本门不裁定**）
// ---------------------------------------------------------------------------

section('§6 交给用户的判定问题（本门不裁定）')

interface OpenQuestion {
  id: string
  question: string
  frozenEvidence: string
  candidates: { label: string; reading: string; consequence: string }[]
  decidedBy: string
}

const openQuestions: OpenQuestion[] = [
  {
    id: 'Q1',
    question: 'canonical `E4 / S3` 绑定哪个载体？',
    frozenEvidence:
      'S3 单元格不指定表/族/入口（Test-and-Gate-Plan:97）；计划只说 `E4 system initiated`（Execution-Plan:1061）；' +
      'WP9-0 把它映射为 E4→S3（WP9 F4:34），而 WP9 的其余场景都跑在对话/行动运行时上。',
    candidates: [
      {
        label: 'Q1-a 任意权威账本',
        reading: '只要某个权威账本的某槽位是 `Known(SYSTEM/组件名)` 即满足 E4/S3。',
        consequence: 'B2 的 `state_events` E4-A **即**满足 E4/S3 ⇒ 可进入 C1（但需另行处置 rows 4–6 的语义）。',
      },
      {
        label: 'Q1-b 对话/行动运行时',
        reading: 'E4/S3 要求的是 WP9 同一条真实运行时链上的系统发起（对话 ingress 或行动账本）。',
        consequence: '`state_events` 不满足 ⇒ 需要拆出「Conversation SYSTEM producer」与/或「行动侧 SYSTEM 路径」的独立 WP。',
      },
      {
        label: 'Q1-c D01 §7 的"系统后台任务"',
        reading: '场景名从"系统后台任务"一般化为"System initiated"是**改名**，要求仍是后台/周期性自主行为。',
        consequence: '既非 `state_events`、也非对话 ingress 能满足 ⇒ 需要真实的调度器/后台任务入口（R-45 的 C 路径；M3.5 明文"只登记不实现"）。',
      },
    ],
    decidedBy: '用户（R-47 §5：C0 完成后**再根据冻结定义决定**）',
  },
  {
    id: 'Q2',
    question: '若 Q1 的答案是"后台任务"：真实后台任务从哪来？',
    frozenEvidence:
      'D01 §7 第 3 行 = `系统后台任务`；R-45 的 C 路径 = "引入真实的调度器/后台任务" = **DEFERRED**；' +
      '本门实测 `src/**` 对 `kernel/app/memory/job.ts` 的 import = 0、开关只有 NOT-WIRED 告警。',
    candidates: [
      {
        label: 'Q2-a 新建真实调度器',
        reading: '按 R-45 的 C 路径实现真实周期性行为。',
        consequence: '属**产品新能力**（M3.5 明文只登记不实现）⇒ 需要新的 WP + 可能的新 ADR，且不属验收 WP。',
      },
      {
        label: 'Q2-b 重估已有真实系统行为',
        reading: '把 B0 已登记的"真实、无回合因果"的系统行为（如启动修复 `recoverMemoryProjections`）升格为一等可归因行为。',
        consequence: 'B0 已否决过一次（"不产生任何可归因事件"）⇒ 需要用户显式改判，且要单独设计语义，不得在验收 WP 里顺手加。',
      },
      {
        label: 'Q2-c 收窄 E4/S3 的验收含义',
        reading: '承认当前不存在该能力，把它写成有销账条件的 deferred 项，并让 E4 以显式的 capability-gap 收口。',
        consequence: '`WP9` 仍然不能 PASS 为"八场景全过"；需要用户明确接受一个**带 gap** 的 `WP9` 判定词汇。',
      },
    ],
    decidedBy: '用户',
  },
]

measure('交给用户的判定问题数', openQuestions.length)
check(
  '每个判定问题都带**冻结出处**与 ≥2 种备选读法（各自的后果都写明）—— 本门不代答',
  openQuestions.every((q) => q.frozenEvidence.length > 0 && q.candidates.length >= 2 && q.decidedBy.includes('用户')),
  openQuestions.map((q) => `${q.id}:${q.candidates.length} 种读法`).join(' · ')
)

// ---------------------------------------------------------------------------
// §7 三段式：合法输入安静 / 注入假象必响 / 放回真实实现重新安静
// ---------------------------------------------------------------------------

section('§7 三段式（同一个 `detect()`，真实仓库 / 注入副本 / 恢复）')

const injectedRoot = join(mkdtempSync(join(tmpdir(), 'wp9c0-')), 'repo')
let injected: Detection | null = null
let injectedError = ''
try {
  mkdirSync(injectedRoot, { recursive: true })
  cpSync(SRC, join(injectedRoot, 'src'), { recursive: true })
  cpSync(join(DOCS, 'm5.1.1'), join(injectedRoot, 'docs/m5.1.1'), { recursive: true })
  cpSync(join(DOCS, 'm5.1'), join(injectedRoot, 'docs/m5.1'), { recursive: true })

  // 注入①：改写 S3 单元格 ⇒ 引用锚点必须漂移
  const tgpPath = join(injectedRoot, 'docs/m5.1.1/M5.1.1-Test-and-Gate-Plan.md')
  const tgpLines = readFileSync(tgpPath, 'utf8').split('\n')
  tgpLines[96] = String(tgpLines[96]).replace('Known(SYSTEM/组件名)', 'Known(USER/组件名)')
  writeFileSync(tgpPath, tgpLines.join('\n'), 'utf8')

  // 注入②：合成一个声称 system_event 族的对话生产者
  writeFileSync(
    join(injectedRoot, 'src/kernel/zz-synthetic-system-producer.ts'),
    [
      'export function createSyntheticSystemIngress() {',
      "  return { producerId: 'synthetic-system', family: 'system_event' }",
      '}',
      '',
    ].join('\n'),
    'utf8'
  )
  // 注入③：合成一个调用录制端口的写者
  writeFileSync(
    join(injectedRoot, 'src/state/zz-synthetic-system-writer.ts'),
    [
      'export async function syntheticWrite(recorder: { recordSystemEvent(t: string, s: number): unknown }) {',
      "  return recorder.recordSystemEvent('合成候选', 1)",
      '}',
      '',
    ].join('\n'),
    'utf8'
  )
  // 注入④：合成一个后台任务 import
  writeFileSync(
    join(injectedRoot, 'src/zz-synthetic-background.ts'),
    ["import type { TriggerKind } from './kernel/app/memory/job.ts'", 'export type Synthetic = TriggerKind', ''].join('\n'),
    'utf8'
  )
  // 注入⑤：合成一个行动侧 SYSTEM 位次
  writeFileSync(
    join(injectedRoot, 'src/kernel/action/zz-synthetic-system-initiator.ts'),
    ["export const synthetic = { kind: 'SYSTEM', id: 'synthetic' }", ''].join('\n'),
    'utf8'
  )

  injected = detect(injectedRoot)
} catch (error) {
  injectedError = String((error as { message?: string }).message ?? error)
}

const injectedRules = [...new Set((injected?.findings ?? []).map((f) => f.rule))].sort()
measure('注入负控下命中的规则数', injectedRules.length)
check(
  '★ 负控（检测器必须响）：注入「改写 S3 单元格 + 合成 system_event 族 + 合成录制端口调用 + ' +
    '合成后台任务 import + 合成行动侧 SYSTEM 位次」⇒ 必报 R2 且静态探针由 0 变 > 0',
  injectedError === '' &&
    injectedRules.includes('R2') &&
    Number(injected?.readings.systemEventFamilyLiterals ?? 0) > 0 &&
    Number(injected?.readings.recordSystemCallSites ?? 0) > 0 &&
    Number(injected?.readings.backgroundJobImports ?? 0) > 0 &&
    Number(injected?.readings.actionDirsSystemPrincipals ?? 0) > 0,
  injectedError !== ''
    ? `注入环境异常：${injectedError}`
    : `R=${JSON.stringify(injectedRules)} · literals=${String(injected?.readings.systemEventFamilyLiterals)} · ` +
      `calls=${String(injected?.readings.recordSystemCallSites)} · jobImports=${String(injected?.readings.backgroundJobImports)} · ` +
      `actionSystem=${String(injected?.readings.actionDirsSystemPrincipals)}`
)

const restored = detect(ROOT)
measure('恢复后命中的规则数（预期 0，作为读数仍有效）', restored.findings.length, true)
check(
  '★ 恢复（放回真实实现）⇒ 检测器**重新安静**（0 条），且探针回到 0',
  restored.findings.length === 0 &&
    restored.readings.recordSystemCallSites === 0 &&
    restored.readings.backgroundJobImports === 0,
  restored.findings.map((f) => `${f.rule}:${f.detail}`).join(' ; ') || '0 条'
)
check(
  '★ 运行期探针（P1a）在三段中**恒定**：它不是靠读文本得出的（承重的正控）',
  restored.readings.conversationFamilies === real.readings.conversationFamilies,
  String(restored.readings.conversationFamilies)
)
rmSync(injectedRoot, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// §8 量具健康 / 判定 / 证据
// ---------------------------------------------------------------------------

section('§8 量具健康 / 判定 / 证据')

const measurementInvalid = measurements.filter((item) => !item.valid)
check(
  '所有计数型判据都自检过 `measured_count > 0`（测到 0 个对象的一律 MEASUREMENT INVALID，不报 PASS）',
  measurementInvalid.length === 0,
  `${measurements.length} 个量具，无效 ${measurementInvalid.length} 个${
    measurementInvalid.length > 0 ? `：${measurementInvalid.map((m) => m.label).join(' , ')}` : ''
  }`
)

const prodAfter = dirFingerprint(PROD_DB_DIR)
check(
  '真实库 `data/pglite` 三项指纹前后一致（本门从未打开它）',
  prodBefore !== null &&
    prodAfter !== null &&
    prodBefore.files === prodAfter.files &&
    prodBefore.bytes === prodAfter.bytes &&
    prodBefore.mtime === prodAfter.mtime,
  `${JSON.stringify(prodBefore)} → ${JSON.stringify(prodAfter)}`
)

const completed = failed === 0
const measurementOk = measurementInvalid.length === 0
const verdict = measurementOk ? (completed ? 'COMPLETE' : 'INCOMPLETE') : 'MEASUREMENT INVALID'
const exitCode = measurementOk ? (completed ? 0 : 1) : 2

mkdirSync(ART, { recursive: true })

const evidence = {
  testId: 'M5.1.1 / WP9-C0 Canonical E4 Acceptance Boundary Review（R-47 §5；只读）',
  generatedAt: new Date().toISOString(),
  command: 'pnpm m5.1.1:wp9c0:verify',
  verdict,
  exitCodeSemantics: {
    '0': '复核完成（引用未漂移 · 矩阵齐备 · 探针有读数 · 量具有效）',
    '1': '复核未完成（引用漂移 / 矩阵缺行 / 来源缺失）',
    '2': '量具无效（MEASUREMENT INVALID）',
  },
  passed,
  failed,
  failures,
  readOnlyBoundary: {
    dbModuleImports: 0,
    isolateDatabaseCalled: false,
    productionDbFingerprintBefore: prodBefore,
    productionDbFingerprintAfter: prodAfter,
    writtenPaths: ['artifacts/m5.1.1/wp9c0-e4-boundary.json'],
  },
  citations: {
    anchorCount: anchorReadings.length,
    anchors: anchorReadings,
    frozenPaths: {
      executionPlan: 'docs/m5.1.1/M5.1.1-Execution-Plan.md',
      testAndGatePlan: 'docs/m5.1.1/M5.1.1-Test-and-Gate-Plan.md',
      wp9AssertionRecord: 'docs/m5.1.1/M5.1.1-WP9-Compatible-Assertion-Record.md',
      d01GapReport: 'docs/m5.1/M5.1-D01-Ledger-Actor-Attribution-Gap.md',
      wp9b2Evidence: 'artifacts/m5.1.1/wp9b2-attestation.json',
    },
  },
  probeReadings: real.readings,
  provenanceChain: {
    d01Section7ScenarioNames: d01Names,
    s1s6ScenarioNames: sNames,
    alignment,
    /** 两条**被机器判定**的措辞变化（不是启发式猜的） */
    wordingChangesSupportedByReading: [3, 6],
    row3: { d01: row3.d01, s: row3.s },
    row6: { d01: row6.d01, s: row6.s },
  },
  premiseCheck: {
    backgroundTaskOccurrences: {
      testAndGatePlan: tgpCount,
      d01FullText: d01Count,
      d01Section7Table: d01Section7Count,
    },
    finding:
      'R-47 把该措辞归给 Test-and-Gate-Plan 的 S3 单元格；实测该文档全文 0 次，' +
      '真实出处是 D01 报告 §7 的验收场景表第 3 行（`| 系统后台任务 | 是否正确标 `SYSTEM` |`）。' +
      '实质判断不受影响（D01 §7 正是 S1–S6 的直接祖先，1:1 顺序对齐），' +
      '但"场景名一般化 = 改名还是放宽"是用户裁定项（Q1）。',
  },
  coverageMatrix: matrix,
  openQuestions,
  threeStage: {
    detector: 'scripts/verify-m5.1.1-wp9c0-e4-boundary.ts::detect',
    positive: { findings: real.findings, readings: real.readings },
    injected: {
      error: injectedError,
      rules: injectedRules,
      findings: injected?.findings ?? [],
      readings: injected?.readings ?? null,
    },
    restored: { findings: restored.findings, readings: restored.readings },
  },
  measurements,
  measurementInvalid: measurementInvalid.length,
  boundaryStatement: {
    thisGateDecides: 'NOTHING about E4 PASS/FAIL',
    claimsEstablished: [
      'rows 1–3（State-origin SYSTEM attribution）由 B2 的实测支持',
      'rows 4–6（Conversation-origin / Action / 后台任务）在生产里**尚未证明可达**',
      'row 7：rows 1–3 的证据不能顶替 rows 4–6',
    ],
    claimsNotEstablished: [
      '不主张 E4 = PASS 或 FAIL',
      '不主张 WP9 = PASS（仍 PARTIAL / BLOCKED）',
      '不主张 WP9-C1 的先行条件已成立',
      '不主张 State Bootstrap 就是/不是 S3 所述的后台任务',
    ],
  },
}
writeFileSync(join(ART, 'wp9c0-e4-boundary.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log('  ↳ 证据：artifacts/m5.1.1/wp9c0-e4-boundary.json')
console.log(
  '     （`wp9c0-gate-exits.txt` 是**逐门串行再鉴定**读数，由执行代理在跑完全部门之后手写 —— ' +
    '理由与 `wp9b1-gate-exits.txt` / `wp9b2-gate-exits.txt` 相同）'
)

console.log(`\n${'='.repeat(78)}`)
console.log(
  `M5.1.1 WP9-C0（Canonical E4 Acceptance Boundary Review）：${passed} 通过 / ${failed} 失败｜**WP9-C0 = ${verdict}**（EXIT=${exitCode}）`
)
console.log(`${'='.repeat(78)}`)
console.log('  覆盖率矩阵：')
for (const row of matrix) console.log(`    ${row.id}. ${row.verdict.padEnd(18)} ${row.claim}`)
console.log('  交给用户的判定问题：')
for (const q of openQuestions) console.log(`    ${q.id}  ${q.question}（${q.candidates.length} 种读法）`)
if (failed > 0) console.log(`失败项：\n${failures.map((failure) => `    - ${failure}`).join('\n')}`)
process.exit(exitCode)
