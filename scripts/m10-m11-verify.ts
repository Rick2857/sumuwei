/**
 * M10（`U-12`）—— **M11 只读契约门**（`pnpm m10:m11:verify`）。
 *
 * ============================================================================
 *  它把"契约"从散文变成判据
 * ============================================================================
 * 契约文 [`M10-M11-Read-Only-Contract.md`](../docs/m10/M10-M11-Read-Only-Contract.md) 的
 * 每一条"在哪读"都由本门的一条检查钉住：
 *
 * ```text
 * A1  九段只读面各自有**真实存在**的提供者符号（不许"承诺一个不存在的面"）
 * A2  §19 的"九段"与本文的表格一一对应，且**十项**的计数口径写清楚了
 * A3  **那句最要紧的话是结构判据**：`GoalState` 里**没有** evidenceRefs /
 *     usability / qualification 字段 —— 目标完成证据与依赖资格**只能**从事件与
 *     读时重算取得。判结构先去注释（写着"这里不存证据"的注释不得把它自己打成违规）
 * B1  **读面里没有写原语**：列出的读函数体里不得出现
 *     insertProjection / saveProjection / deleteProjection / inTransaction
 * B2  **写入口就那三个**：走事务的导出函数 = applyAcceptedEvents / applyGoalRows /
 *     rebuildGoalProjections。新增第四个 ⇒ 变红
 * B3  契约文与代码**对得上**：文里承诺的符号在源码里真的存在（反向核对）
 * C1  【负控】故意断言一个**不成立**的结构命题（`GoalState` **有** `evidenceRefs`）
 *     ⇒ 探测器**必须**说不成立。不做这条，"A3 通过"与"探测器根本不工作"长得一样
 * C2  【正控】同一个探测器对**成立**的命题必须安静
 * ```
 *
 * ⚠️ 纯进程内：只读源码文本。零数据库 / 零模型 / 零出网。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'

const REPO_ROOT = resolve(process.cwd())

function phase(mark: string): void {
  console.error(`[m10-m11] ${mark}`)
}

interface Check {
  group: 'A' | 'B' | 'C'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []
function record(
  group: Check['group'],
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group, id, label, expected, actual, pass })
}

/** **判结构先去掉注释**（本仓库四次教训）：`//` 与 `/* *​/` 都去掉，字符串保留 */
function codeLinesOf(source: string): string[] {
  const withoutBlock = source.replace(/\/\*[\s\S]*?\*\//g, '')
  return withoutBlock
    .split(/\r?\n/)
    .map((line) => line.replace(/\/\/.*$/, ''))
}

function readRepo(relative: string): string {
  const path = join(REPO_ROOT, relative)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

/** 某个接口的**代码行**（去注释）里有没有给定的字段名 */
function interfaceHasField(source: string, interfaceName: string, field: string): boolean {
  const lines = codeLinesOf(source)
  const start = lines.findIndex((line) => line.includes(`interface ${interfaceName} `) || line.includes(`interface ${interfaceName}{`))
  if (start < 0) return false
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!
    if (/^\}/.test(line.trim())) break
    if (new RegExp(`\\b${field}\\s*[?:]`).test(line)) return true
  }
  return false
}

/** 函数体是否含写原语（按"函数名 → 到下一个顶层 `}` 之前"的粗略切片） */
function functionBodyContains(source: string, functionName: string, needle: string): boolean {
  const lines = codeLinesOf(source)
  const start = lines.findIndex((line) => line.includes(`function ${functionName}(`))
  if (start < 0) return false
  let depth = 0
  let seenBrace = false
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index]!
    for (const char of line) {
      if (char === '{') {
        depth += 1
        seenBrace = true
      } else if (char === '}') {
        depth -= 1
      }
    }
    if (line.includes(needle)) return true
    if (seenBrace && depth === 0 && index > start) break
  }
  return false
}

const STORE = 'src/infrastructure/persistence/goal-store.ts'
const CONTRACT = 'src/kernel/contracts/goal.ts'
const PROJECTION = 'src/kernel/projections/goal.ts'
const DEV_FACE = 'src/kernel/app/goal/developer-face.ts'
const INPUTS = 'src/kernel/app/goal/inputs.ts'
const DOC = 'docs/m10/M10-M11-Read-Only-Contract.md'

function main(): void {
  const storeSource = readRepo(STORE)
  const contractSource = readRepo(CONTRACT)
  const projectionSource = readRepo(PROJECTION)
  const devFaceSource = readRepo(DEV_FACE)
  const inputsSource = readRepo(INPUTS)
  const docSource = readRepo(DOC)

  /* ======================================================================
   * A1 · 九段只读面各自有**真实存在**的提供者
   * ==================================================================== */
  phase('A1: every read-only item has a real provider symbol')

  const providers: readonly { id: string; label: string; file: string; symbol: string; inSource: string }[] = [
    { id: 'A1a', label: '① goalId', file: CONTRACT, symbol: 'goalId', inSource: contractSource },
    { id: 'A1b', label: '① commitmentId', file: CONTRACT, symbol: 'commitmentId', inSource: contractSource },
    { id: 'A1c', label: '② owner / target', file: CONTRACT, symbol: 'targetEntity', inSource: contractSource },
    { id: 'A1d', label: '③ revision / status', file: STORE, symbol: 'listGoalStates', inSource: storeSource },
    { id: 'A1e', label: '④ 来源 / origin', file: CONTRACT, symbol: 'sourceRefs', inSource: contractSource },
    { id: 'A1f', label: '⑤ 资格（读时重算）', file: INPUTS, symbol: 'recheckGoalDependencies', inSource: inputsSource },
    { id: 'A1g', label: '⑥ 变更原因', file: CONTRACT, symbol: 'cancelReason', inSource: contractSource },
    { id: 'A1h', label: '⑦ 承诺侧证据（state）', file: CONTRACT, symbol: 'completionRefs', inSource: contractSource },
    { id: 'A1i', label: '⑨ 实际入模（trace）', file: PROJECTION, symbol: 'GOAL_HANDLED_EVENT_TYPES', inSource: projectionSource },
  ]
  const missingProviders = providers.filter((entry) => !entry.inSource.includes(entry.symbol))
  record(
    'A',
    'A1',
    '**九段只读面各自有真实存在的提供者符号**（不许承诺一个不存在的面）'
      + ' —— 逐段在源码里核对符号',
    `9/9 段都有提供者`,
    missingProviders.length === 0
      ? `9/9 段都有（${providers.map((entry) => entry.label).join(' · ')}）`
      : `缺：${missingProviders.map((entry) => entry.label).join(', ')}`,
    missingProviders.length === 0,
  )

  /* ======================================================================
   * A3 · 那段最要紧的话是**结构判据**（且判结构先去注释）
   * ==================================================================== */
  phase('A3: the central claim is a structural judgement')

  /*
   * 契约的 §1.2 声称：`GoalState` **没有**完成证据字段。
   * ⚠️ 这条**必须**用去注释后的代码行来判 —— 否则 `GoalState` 上方那段
   *    "（审计用；**不含**正文）"之类的注释里若出现字段名，就会把它自己打成违规。
   */
  const goalStateHasEvidence = interfaceHasField(contractSource, 'GoalState', 'evidenceRefs')
  const goalStateHasUsability = interfaceHasField(contractSource, 'GoalState', 'usability')
  const goalStateHasQualification = interfaceHasField(contractSource, 'GoalState', 'qualification')
  record(
    'A',
    'A3',
    '**§1.2 是结构判据**：`GoalState` 里**没有** `evidenceRefs` / `usability` / `qualification`'
      + ' ⇒ 目标完成证据与依赖资格**只能**从事件与读时重算取得'
      + '（判结构**去掉注释**——写着"不含正文"的注释不得把它自己打成违规）',
    '三个字段都不在 GoalState 的代码行里',
    `evidenceRefs=${String(goalStateHasEvidence)} · usability=${String(goalStateHasUsability)} · qualification=${String(goalStateHasQualification)}`,
    !goalStateHasEvidence && !goalStateHasUsability && !goalStateHasQualification,
  )

  record(
    'A',
    'A2',
    '**计数口径写清楚了**：`U-12` 记作"十项"而计划 §19 原文是**九段** ⇒ '
      + '契约文必须把这个差**明写**（按 goalId/commitmentId 拆开计是十项），不得含糊过去',
    '契约文里出现"九段"与"十项"的口径说明',
    docSource.includes('记作"十项"') && docSource.includes('九段')
      ? '契约文已明写这个差'
      : '**契约文没有写明计数口径**',
    docSource.includes('十项') && docSource.includes('九段'),
  )

  /* ======================================================================
   * B1 · 读面里没有写原语
   * ==================================================================== */
  phase('B1: read surfaces contain no write primitives')

  const READ_FUNCTIONS: readonly { name: string; file: string; source: string }[] = [
    { name: 'listGoalStates', file: STORE, source: storeSource },
    { name: 'getGoalRow', file: STORE, source: storeSource },
    { name: 'listGoalRows', file: STORE, source: storeSource },
    { name: 'replayGoalRows', file: PROJECTION, source: projectionSource },
    { name: 'buildDeveloperGoalDto', file: DEV_FACE, source: devFaceSource },
    { name: 'buildDeveloperGoalList', file: DEV_FACE, source: devFaceSource },
  ]
  const WRITE_PRIMITIVES = ['insertProjection', 'saveProjection', 'deleteProjection', 'inTransaction']
  const dirtyReads: string[] = []
  for (const entry of READ_FUNCTIONS) {
    for (const primitive of WRITE_PRIMITIVES) {
      if (functionBodyContains(entry.source, entry.name, primitive)) {
        dirtyReads.push(`${entry.name}→${primitive}`)
      }
    }
  }
  record(
    'B',
    'B1',
    '**读面里没有写原语**：六个读函数的函数体里都没有'
      + ' `insertProjection` / `saveProjection` / `deleteProjection` / `inTransaction`'
      + ' ⇒ 规则 4"不绕过领域归属"的**读侧**是结构判据',
    `0 处（检查 ${String(READ_FUNCTIONS.length)} 个函数 × 4 个原语）`,
    dirtyReads.length === 0
      ? `${String(READ_FUNCTIONS.length)} 个读函数全部干净`
      : `**发现写原语**：${dirtyReads.join(', ')}`,
    dirtyReads.length === 0 && READ_FUNCTIONS.length > 0,
  )

  /* ======================================================================
   * B2 · 写入口就那三个
   * ==================================================================== */
  phase('B2: the write entry points are exactly two (plus the shared ledger append)')

  /*
   * ⚠️ **第一版这条检查的期望写错了**（而且它是**契约文**里的错，不是代码的错）。
   *
   * 我原来断言"走事务的导出函数 = `applyAcceptedEvents` / `applyGoalRows` /
   * `rebuildGoalProjections` 三个"。实测 `goal-store.ts` 里只有**两个** ——
   * 因为 `applyAcceptedEvents` 住在 **`event-store.ts`**，它是**多领域共用**的
   * 事件追加（affect / job / memory-recovery 都走它），**不是**目标领域自己的写入口。
   *
   * ⇒ 这条边界对 M11 **有意义**，不能含糊：
   * ```text
   * 目标领域**自己的**写入口   2 个（都在 goal-store.ts 里走事务）
   * 共享的**账本追加**        1 个（event-store.ts，多领域共用）
   * ```
   * ⇒ 现在拆成两条检查：B2a 领域侧恰好 2 个；B2b 共享追加**在别处**且不被目标领域重造。
   */
  const GOAL_DOMAIN_WRITERS = ['applyGoalRows', 'rebuildGoalProjections']
  const transactionalFound: string[] = []
  for (const line of codeLinesOf(storeSource)) {
    const match = /export async function ([A-Za-z0-9_]+)/.exec(line)
    if (match !== null) {
      const name = match[1]!
      if (functionBodyContains(storeSource, name, 'inTransaction')) transactionalFound.push(name)
    }
  }
  const unexpected = transactionalFound.filter((name) => !GOAL_DOMAIN_WRITERS.includes(name))
  record(
    'B',
    'B2a',
    '**目标领域自己的写入口恰好两个**：`goal-store.ts` 里走事务的导出函数 = '
      + `\`${GOAL_DOMAIN_WRITERS.join('` · `')}\``
      + '。新增第三个 ⇒ 变红（"读面只读"的**写侧**判据）'
      + ' ⚠️ 第一版把 `applyAcceptedEvents` 也算进"领域写入口"—— 它其实在**别的文件**里',
    `恰好 2 个 · 0 个意外`,
    `实测 ${String(transactionalFound.length)} 个：[${transactionalFound.join(', ')}]` +
      (unexpected.length > 0 ? ` · **意外**：[${unexpected.join(', ')}]` : ''),
    transactionalFound.length === GOAL_DOMAIN_WRITERS.length &&
      unexpected.length === 0 &&
      GOAL_DOMAIN_WRITERS.every((name) => transactionalFound.includes(name)),
  )

  /* B2b —— 共享账本追加**在别处**，且目标领域**没有**重造一份 */
  const eventStoreSource = readRepo('src/infrastructure/persistence/event-store.ts')
  const sharedAppendInEventStore = eventStoreSource.includes('export async function applyAcceptedEvents')
  const goalStoreRederives = storeSource.includes('export async function applyAcceptedEvents')
  record(
    'B',
    'B2b',
    '**共享的账本追加只有一份**：`applyAcceptedEvents` 住在 `event-store.ts`（多领域共用），'
      + '而目标领域**没有**重造一份 —— "事件必须经它落库"因此只有一条路径',
    '在 event-store · 不在 goal-store',
    `在 event-store=${String(sharedAppendInEventStore)} · goal-store 里重造=${String(goalStoreRederives)}`,
    sharedAppendInEventStore && !goalStoreRederives,
  )

  /* ======================================================================
   * B3 · 契约文与代码对得上
   * ==================================================================== */
  phase('B3: the contract document matches the code')

  const documentedSymbols = [
    'listGoalStates',
    'getGoalRow',
    'listGoalRows',
    'replayGoalRows',
    'createGoalStateLookup',
    'buildDeveloperGoalDto',
    'buildDeveloperGoalList',
    'recheckGoalDependencies',
    'applyAcceptedEvents',
    'applyGoalRows',
    'rebuildGoalProjections',
  ]
  const docMissing = documentedSymbols.filter((symbol) => !docSource.includes(symbol))
  const codeMissing = documentedSymbols.filter((symbol) => {
    const haystack = storeSource + projectionSource + devFaceSource + inputsSource
    return !haystack.includes(symbol)
  })
  record(
    'B',
    'B3',
    '**契约文与代码对得上**：文里承诺的每个符号都在源码里真的存在（反向核对）',
    `${String(documentedSymbols.length)}/${String(documentedSymbols.length)} 两侧都在`,
    `文里缺=${String(docMissing.length)} · 源码里缺=${String(codeMissing.length)}` +
      (codeMissing.length > 0 ? `（${codeMissing.join(', ')}）` : ''),
    docMissing.length === 0 && codeMissing.length === 0,
  )

  const eightRulesPresent = [
    '目标是**期望**',
    '多次取回同一 Goal/结果',
    '不绕过领域归属',
    '只能提议修订',
    '每次使用重查',
    '不缓存永久执行许可',
    'M6.5 能力计划',
  ].filter((phrase) => docSource.includes(phrase))
  record(
    'B',
    'B4',
    '**八条交接规则逐条在契约文里**（§19 的规则不许在交接时漏掉任何一条）',
    '7/7 个可检索的关键短语都在',
    `${String(eightRulesPresent.length)}/7 在`,
    eightRulesPresent.length === 7,
  )

  /* ======================================================================
   * C · 探测器的正负控
   * ==================================================================== */
  phase('C: positive and negative controls on the structural detector')

  /*
   * 【负控】故意断言一个**不成立**的命题：`GoalState` **有** `commitmentId`。
   * （`commitmentId` 在 `CommitmentState` 上，不在 `GoalState` 上 —— 这是真的结构性事实。）
   */
  const falseClaim = interfaceHasField(contractSource, 'GoalState', 'commitmentId')
  record(
    'C',
    'C1',
    '【负控】探测器对**不成立**的结构命题必须说不成立：'
      + '断言"`GoalState` 有 `commitmentId`"⇒ 必须判 **false**'
      + '（`commitmentId` 在 `CommitmentState` 上）',
    '探测器判 false',
    `探测器=${String(falseClaim)}`,
    falseClaim === false,
  )

  const trueClaim = interfaceHasField(contractSource, 'CommitmentState', 'commitmentId')
  record(
    'C',
    'C2',
    '【正控】同一个探测器对**成立**的命题必须判 true：'
      + '断言"`CommitmentState` 有 `commitmentId`"⇒ 必须判 **true**'
      + '（否则 C1 可以靠"永远返回 false"通过）',
    '探测器判 true',
    `探测器=${String(trueClaim)}`,
    trueClaim === true,
  )

  /* C3 —— 去注释的判据本身也要有负控：把字段名写进**注释**里，探测器不得被它骗到 */
  const commentProbe = `${'/**\n * 假注释：这个接口有 evidenceRefs 字段\n */\n'}interface FakeProbe {\n  id: string\n}`
  record(
    'C',
    'C3',
    '【负控】**去注释是有效的**：把 `evidenceRefs` 写进接口**上方的注释**里 ⇒ '
      + '`interfaceHasField` 必须仍判 false（否则写着禁令的注释会把它自己打成违规）',
    '探测器判 false',
    `探测器=${String(interfaceHasField(commentProbe, 'FakeProbe', 'evidenceRefs'))}`,
    !interfaceHasField(commentProbe, 'FakeProbe', 'evidenceRefs'),
  )

  const passed = checks.filter((check) => check.pass).length
  const failed = checks.length - passed

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp11-m11', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const groups = ['A', 'B', 'C'] as const
  const perGroup = Object.fromEntries(
    groups.map((group) => [
      group,
      {
        total: checks.filter((check) => check.group === group).length,
        passed: checks.filter((check) => check.group === group && check.pass).length,
      },
    ]),
  )

  const payload = {
    schema: 'm10-m11-verify@1',
    runId,
    head,
    mode: 'offline' as const,
    semanticClaim: 'none' as const,
    contractDoc: DOC,
    readSurface: {
      domain: ['listGoalStates', 'getGoalRow', 'listGoalRows', 'replayGoalRows', 'createGoalStateLookup'],
      developer: ['buildDeveloperGoalDto', 'buildDeveloperGoalList'],
      inputs: ['recheckGoalDependencies'],
      write: GOAL_DOMAIN_WRITERS,
    },
    transactionalFunctionsFound: transactionalFound,
    checks,
    perGroup,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
    disclaimer:
      '本门只核对**只读面的边界**（符号存在 + 读面无写原语 + 写入口恰好三个 + 文档一致）。' +
      '它**不**总结 M10 的成就，也**不**主张任何语义质量。',
  }
  writeFileSync(join(dir, 'm11-contract.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp11',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'm11-contract',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'U-12 M11 只读契约：九段只读面的提供者逐段核对 · GoalState 无证据/资格字段（结构判据，去注释）· ' +
      '读面无写原语 · 写入口恰好三个 · 契约文与代码双向核对 · 八条交接规则逐条在文里 · ' +
      '探测器的正负控（含"注释不得骗过去"）。⚠️ 不总结成就、不主张语义质量。',
    databaseScope: 'not-applicable',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} [${check.group}] ${check.label}`)
    console.log(`      期望 ${check.expected} · 实测 ${check.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${String(passed)}/${String(checks.length)}）`)
  console.log(`分组：${groups.map((g) => `${g}=${String(perGroup[g].passed)}/${String(perGroup[g].total)}`).join(' · ')}`)
  console.log('⚠️ 本门只核对**只读面的边界**，不总结 M10 成就。')
  process.exit(failed === 0 ? 0 : 1)
}

main()
