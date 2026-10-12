/**
 * M10（WP11）—— **文档一致性门**（`pnpm m10:docs:verify`，即计划 §5 的 `m10:docs:verify`）。
 *
 * ============================================================================
 *  它防的是**文档静默腐烂**
 * ============================================================================
 * `M10-Known-Limitations.md` 是 WP11 的交付物，它的价值全在"**每条都有范围和处置**"。
 * 而**手写的汇总表一定会腐烂**：加一条 `L-M10-55` 却忘了写进汇总、
 * 汇总里留着一个交接单里已删掉的编号、或者某条只剩一个光秃秃的编号没有处置。
 * ⇒ 这三种腐烂都做成判据：
 *
 * ```text
 * A1  交接单里出现的**每个** L-M10-xx 都在汇总里（不许漏）
 * A2  编号总数与登记册的声称**一致**（54 条；数字对不上 ⇒ 变红）
 * A3  汇总里出现的**每个**编号都真的在某个交接单里（不许编）
 * A4  每条都有**实质内容**：该编号所在的行必须长于一个阈值
 *     （防"只剩编号、处置被删掉"这种看起来完整的表）
 * B1  汇总里**不得**出现语义结论类的数字（它只汇总边界，不出读数）
 * C1  【负控】探测器对一个**不存在**的编号必须报"漏"
 * C2  【正控】探测器对**存在**的编号必须安静（否则 C1 可靠"永远报漏"通过）
 * ```
 *
 * ⚠️ 纯进程内：只读 `docs/m10/*.md`。零数据库 / 零模型 / 零出网。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'

const REPO_ROOT = resolve(process.cwd())
const DOCS = join(REPO_ROOT, 'docs', 'm10')
const SUMMARY_DOC = 'M10-Known-Limitations.md'

function phase(mark: string): void {
  console.error(`[m10-docs] ${mark}`)
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

/** 抽出文本里所有 `L-M10-NN` 编号（去重、排序） */
export function limitationIdsIn(text: string): string[] {
  const found = new Set<string>()
  for (const match of text.matchAll(/L-M10-(\d{2})/g)) found.add(`L-M10-${match[1]!}`)
  return [...found].sort()
}

/**
 * 某个编号在汇总里有没有**实质内容**。
 *
 * 判据：该编号所在的那一行（或紧随其后的一行）去掉编号本身后仍有 ≥ 20 个字符。
 * ⇒ 防"只剩一个编号"的行：那种表看起来完整，实际什么都没说。
 */
export function hasSubstanceFor(text: string, id: string): boolean {
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]!.includes(id)) continue
    const stripped = lines[index]!.replaceAll(id, '').replace(/[|\s`*〔〕]/g, '')
    if (stripped.length >= 20) return true
    const next = lines[index + 1]
    if (next !== undefined && next.replace(/[|\s`*]/g, '').length >= 20) return true
  }
  return false
}

function main(): void {
  /* ---------------------------------------------------------------------
   * 材料：11 份交接单 = **源**；汇总文 = **表**
   * ------------------------------------------------------------------- */
  /*
   * ⚠️ **源集合要覆盖所有会提到 `L-M10-xx` 的文档**（WP11 轮次补上 `Architecture`）。
   *    若某个文件不在源集合里，只在它里面提到的新限制**永远不会被 `A1` 抓到漏项** ——
   *    覆盖率缺口会以"没有漏项"的样子出现在读数里。
   */
  const handoffFiles = readdirSync(DOCS)
    .filter(
      (name) =>
        name.includes('Handoff') ||
        name.includes('Architecture') ||
        name.endsWith('Report.md') ||
        name.endsWith('Materials.md') ||
        name.endsWith('Contract.md'),
    )
    .filter((name) => name !== SUMMARY_DOC)

  const sourceText = handoffFiles
    .map((name) => readFileSync(join(DOCS, name), 'utf8'))
    .join('\n')
  const sourceIds = limitationIdsIn(sourceText)

  const summaryPath = join(DOCS, SUMMARY_DOC)
  const summaryText = existsSync(summaryPath) ? readFileSync(summaryPath, 'utf8') : ''
  const summaryIds = limitationIdsIn(summaryText)

  record(
    'A',
    'A0',
    '**材料在场**：汇总文存在，且源文件（交接单/报告）**真的被读到**'
      + '（源为空字符串时"没有漏项"与"什么都没读"长得一样）',
    `汇总文存在 · 源文件 ≥ 8 份 · 源里 ≥ 40 个编号`,
    `汇总文=${existsSync(summaryPath) ? '在' : '**缺**'} · 源 ${String(handoffFiles.length)} 份 · ` +
      `源里 ${String(sourceIds.length)} 个编号`,
    existsSync(summaryPath) && handoffFiles.length >= 8 && sourceIds.length >= 40,
  )

  /* A1 —— 源里的每个编号都在汇总里 */
  const missing = sourceIds.filter((id) => !summaryIds.includes(id))
  record(
    'A',
    'A1',
    '**不许漏**：交接单/报告里出现的**每个** `L-M10-xx` 都出现在汇总文里'
      + '（漏一条 ⇒ 那条限制从"已知"变成"没人知道"）',
    '0 条漏项',
    missing.length === 0
      ? `${String(sourceIds.length)} 个编号全部在汇总里`
      : `**漏 ${String(missing.length)} 条**：[${missing.join(', ')}]`,
    missing.length === 0 && sourceIds.length > 0,
  )

  /* A2 —— 编号总数与声称一致 */
  /*
   * ⚠️ **要比的是 `源 ∪ 汇总`**（WP11 轮次修正）。
   *    第一版只比"声称的最大编号 vs **源文件里的**最大编号" ⇒
   *    汇总声称 54、而**自己含 55** 时它**不响** —— 正是它该抓的那种"数字对不上"。
   *    ⇒ 现在两侧都取并集的最大编号。
   */
  const allIds = [...new Set([...sourceIds, ...summaryIds])].sort()
  const claimed = /`L-M10-01` … `L-M10-(\d{2})`/.exec(summaryText)
  const claimedMax = claimed === null ? 0 : Number(claimed[1])
  const actualMax = Number((allIds[allIds.length - 1] ?? 'L-M10-0').slice(-2))
  record(
    'A',
    'A2',
    '**总数与声称一致**：汇总文开头的 "`L-M10-01` … `L-M10-NN`" 里的 NN 必须等于'
      + '**源 ∪ 汇总**里的最大编号（数字对不上 ⇒ 表在骗人；只比源会漏掉"汇总自己多了一条"）',
    '声称的最大编号 = 实际最大编号（并集）',
    `声称 ${String(claimedMax)} · 并集最大 ${String(actualMax)} · ` +
      `（源 ${String(sourceIds.length)} · 汇总 ${String(summaryIds.length)} · 并集 ${String(allIds.length)}）`,
    claimedMax === actualMax && claimedMax > 0,
  )

  /* A3 —— 汇总里不许有源里不存在的编号 */
  const invented = summaryIds.filter((id) => !sourceIds.includes(id))
  record(
    'A',
    'A3',
    '**不许编**：汇总里出现的每个编号都真的在某个交接单/报告里'
      + '（编一个编号 = 把一个不存在的边界写进交付物）',
    '0 条编造',
    invented.length === 0 ? '0 条编造' : `**编造 ${String(invented.length)} 条**：[${invented.join(', ')}]`,
    invented.length === 0,
  )

  /* A4 —— 每条都有实质内容 */
  const hollow = summaryIds.filter((id) => !hasSubstanceFor(summaryText, id))
  record(
    'A',
    'A4',
    '**不许空洞**：每个编号所在的行去掉编号后仍有实质内容（≥20 字符）'
      + ' ⇒ 防"只剩一个编号、处置被删掉"这种**看起来完整**的表',
    '0 条空洞',
    hollow.length === 0
      ? `${String(summaryIds.length)} 条都有实质内容`
      : `**空洞 ${String(hollow.length)} 条**：[${hollow.join(', ')}]`,
    hollow.length === 0 && summaryIds.length > 0,
  )

  /* B2 —— 登记册的**开放项计数**不得靠手写（本轮抓到的真实错误） */
  phase('B2: the register counts its own open items')
  /*
   * ⚠️ **这条是本轮一处真实错误的产物**：我此前一直报"3 条开放"，
   *    而按节统计实际是 **U-01 + U-05**（`U-11`/`U-15` 当时确实也开放，但**漏报了 `U-05`**）。
   *    错因是**计数窗口取错**：一行式"标题后若干字符里有没有『已关闭』"会**串到下一节**，
   *    于是把 `U-01` 误判成已关闭（它后面就是已关闭的 `U-02`）。
   *    ⇒ 与仓库反复踩的那类同形：**窗口取错，读数静默地错**。
   *    ⇒ 修法不是"我下次注意"，而是**把它变成判据**。
   */
  const registerPath = join(DOCS, 'M10-Unresolved-Decisions.md')
  const registerText = existsSync(registerPath) ? readFileSync(registerPath, 'utf8') : ''
  const sections = registerText.split(/^### (U-\d\d) · /m)
  const uItems: { id: string; body: string }[] = []
  for (let i = 1; i + 1 < sections.length; i += 2) {
    uItems.push({ id: sections[i]!, body: sections[i + 1]! })
  }
  const openItems = uItems.filter((item) => !item.body.includes('已关闭'))
  /* 开放项必须写明**阻断范围**（否则"开放"与"忘了写"长得一样） */
  const openWithoutScope = openItems.filter((item) => !item.body.includes('阻断范围'))
  /* 正文里声明的计数（"开放项共 **N** 项"）；抓不到 ⇒ 视为缺失，不当 0 */
  const claimedOpen = /开放项共\s*\*\*(\d+)\*\*\s*项/.exec(registerText)?.[1]
  record(
    'B',
    'B2',
    '**登记册的开放项计数自证**：正文声明的"开放项共 **N** 项"必须等于'
      + '**按节统计**出的、未标「已关闭」的 `U-` 条目数；且每条开放项都要写明**阻断范围**。'
      + '⚠️ 判据是**按节切分**，不是"标题后若干字符"（后者会串到下一节 —— 那正是本条的来历）',
    '声称数 = 实际开放数 · 每条开放项有阻断范围',
    claimedOpen === undefined
      ? '**正文里找不到"开放项共 N 项"**'
      : `声称 ${claimedOpen} · 实际开放 ${String(openItems.length)}` +
        `（${openItems.map((item) => item.id).join(', ')}）· 缺阻断范围 ${String(openWithoutScope.length)} 条`,
    claimedOpen !== undefined &&
      Number(claimedOpen) === openItems.length &&
      openWithoutScope.length === 0 &&
      uItems.length > 0,
  )

  /* B3 —— §16.1 的 20 条点名命令必须**逐条有处置**，且账加得起来（轮 45 补） */
  phase('B3: every command the plan names has a disposition')
  /*
   * ⚠️ **这条的来历是一处我方汇报错误**：我在若干轮的口头汇报里写
   *    「§16.1 的 20 条命令：**19 已实现** · 2 判据并入 · 未实现 4」——
   *    **加不起来（19+2+4=25）**，而且"19"是把 §16.1 **没计划过**的命令也算进去了
   *    （`package.json` 里共 27 条 `m10:*`，多出来的那些不在计划清单里）。
   *    文档里的表一直是**对的**；错的是我的**转述**。
   * ⇒ 修法不是"下次注意"，而是**把那张表变成判据**：三种处置必须**恰好划分**计划点名的那 20 条，
   *    且"说实现了就真的在 package.json 里 / 说没实现就真的不在"。
   */
  const planPath = join(DOCS, 'M10-Execution-Plan.md')
  const planText = existsSync(planPath) ? readFileSync(planPath, 'utf8') : ''
  const planStart = planText.indexOf('### 16.1')
  const planEnd = planText.indexOf('### 16.2')
  const planSection =
    planStart >= 0 && planEnd > planStart ? planText.slice(planStart, planEnd) : ''
  const planned = [...planSection.matchAll(/^\|\s*`(m10:[^`]+)`\s*\|/gm)].map((m) => m[1]!)

  const handoffAll = readFileSync(join(DOCS, 'M10-WP11-Evidence-Handoff.md'), 'utf8')
  const tableStart = handoffAll.indexOf('### 6.11.1 ')
  const tableEnd = handoffAll.indexOf('### 6.11.1a')
  const tableSection =
    tableStart >= 0 && tableEnd > tableStart ? handoffAll.slice(tableStart, tableEnd) : ''
  /* 处置列读三种写法之一；命令读第 1 列 */
  const dispositions = [
    ...tableSection.matchAll(/^\|\s*`(m10:[^`]+)`\s*\|\s*(✅ 独立脚本|🔀 判据并入|❌ 未实现)\s*\|/gm),
  ].map((m) => ({ command: m[1]!, kind: m[2]! }))

  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  }
  const scriptNames = new Set(
    Object.keys(packageJson.scripts).filter((name) => name.startsWith('m10:')),
  )

  const implemented = dispositions.filter((d) => d.kind === '✅ 独立脚本').map((d) => d.command)
  const merged = dispositions.filter((d) => d.kind === '🔀 判据并入').map((d) => d.command)
  const notImplemented = dispositions.filter((d) => d.kind === '❌ 未实现').map((d) => d.command)
  /* ① 每条计划命令**恰好一次**，且没有表外的多余行 */
  const listed = dispositions.map((d) => d.command)
  const duplicated = listed.filter((name, index) => listed.indexOf(name) !== index)
  const unaccounted = planned.filter((name) => !listed.includes(name))
  const extra = listed.filter((name) => !planned.includes(name))
  record(
    'B',
    'B3',
    '**§16.1 的 20 条点名命令逐条有处置，且账加得起来**：从计划解析出点名清单，'
      + '从交接单 §6.11.1 的**处置列**读三种写法（`✅ 独立脚本` / `🔀 判据并入` / `❌ 未实现`），'
      + '三者必须**恰好划分**那 20 条。⚠️ 这条判据的来历是一处**我方汇报错误**'
      + '（曾把 §16.1 没计划过的命令也算进去，报出加不起来的"19+2+4"）⇒ 以后它靠机器，不靠我记得',
    '点名 20 条 · 恰好划分（每条一次）· 无表外多余行',
    `点名 ${String(planned.length)} 条 · 表里 ${String(dispositions.length)} 行`
      + `（✅ ${String(implemented.length)} · 🔀 ${String(merged.length)} · ❌ ${String(notImplemented.length)}）`
      + (duplicated.length > 0 ? ` · **重复** ${String(duplicated.length)}` : '')
      + (unaccounted.length > 0 ? ` · **未处置** ${unaccounted.join(', ')}` : '')
      + (extra.length > 0 ? ` · **表外** ${extra.join(', ')}` : ''),
    planned.length === 20 &&
      dispositions.length === planned.length &&
      duplicated.length === 0 &&
      unaccounted.length === 0 &&
      extra.length === 0 &&
      /*
       * ⚠️ **这一条必须显式断言**（它是我自己当场踩出来的）：
       *    三种处置的**和**必须等于表里的行数。
       *
       * 我第一版**没写它**，于是出了一个当场发生的缺陷：改名变量时漏了一处引用，
       * 读数印成 `表里 20 行（✅ 14 · 🔀 2 · ❌ 0）` —— **14+2+0 = 16 ≠ 20**，
       * 而判据**照样 PASS**（它只比了"表里行数"与"点名条数"，没看分类的和）。
       * ⇒ 本仓库反复修的那一族：**读数看起来确定，其实量错了东西**
       *   （那一处 `missing` 指的是上面另一个同名变量，恰好为空 ⇒ 印出一个像样的 0）。
       */
      implemented.length + merged.length + notImplemented.length === dispositions.length,
  )
  /* ② "说实现了"必须真的在 package.json 里；"说没实现"必须真的不在 */
  const liedImplemented = implemented.filter((name) => !scriptNames.has(name))
  const liedMissing = [...merged, ...notImplemented].filter((name) => scriptNames.has(name))
  record(
    'B',
    'B3b',
    '**处置列不许说谎**：标 `✅ 独立脚本` 的必须**真的在 `package.json` 里**；'
      + '标 `🔀 判据并入` / `❌ 未实现` 的必须**真的不在**'
      + '（"说没实现却其实有"与"说实现了却没有"都要红）',
    '0 处不符',
    `说实现却不在 ${String(liedImplemented.length)} 条`
      + (liedImplemented.length > 0 ? `：${liedImplemented.join(', ')}` : '')
      + ` · 说没实现却在 ${String(liedMissing.length)} 条`
      + (liedMissing.length > 0 ? `：${liedMissing.join(', ')}` : ''),
    liedImplemented.length === 0 && liedMissing.length === 0,
  )

  /*
   * B4 —— §21.2 的交付物清单逐条映射到真实文件。
   *
   * ⚠️ **为什么要有它**：`Live Report` 与 `Semantic Evaluation` 两份文档**缺了很久**
   *    而**没有任何判据会发现** —— "少一份交付物"与"计划里本来没写"在输出上长得一样。
   *    与 `B3` 同一条纪律：**把清单变成判据**，而不是靠我记得。
   * ⚠️ 映射**必须显式**（清单里的名字与文件名不是一一对应：`ADR` 在 `docs/adr/`、
   *    `M10-to-M11-Handoff` 实际叫 `M10-M11-Read-Only-Contract.md`）⇒
   *    名字对不上时**写出为什么**，不许"看起来像就算了"。
   */
  phase('B4: every deliverable the plan requires maps to a real file')
  const deliverableStart = planText.indexOf('### 21.2')
  const deliverableEnd = planText.indexOf('## 22.')
  const deliverableSection =
    deliverableStart >= 0 && deliverableEnd > deliverableStart
      ? planText.slice(deliverableStart, deliverableEnd)
      : ''
  const requiredLine = deliverableSection
    .split(/\r?\n/)
    .find((line) => line.includes('至少交付')) ?? ''
  const requiredItems = requiredLine
    .replace(/^.*?至少交付[:：]?/, '')
    .split(/[、，,]/)
    .map((item) => item.replace(/[。\s]+$/g, '').trim())
    .filter((item) => item !== '' && item !== '以及每个已执行 WP 的交接')
  /** 清单名 → 真实文件（相对仓库根）；名字不一致的**必须**在注释里说明 */
  const DELIVERABLE_FILES: Readonly<Record<string, readonly string[]>> = {
    'Execution Plan': ['docs/m10/M10-Execution-Plan.md'],
    'Baseline Report': ['docs/m10/M10-Baseline-Report.md'],
    ADR: ['docs/adr/ADR-076-m10-goals-and-commitments.md'],
    'Acceptance Contract': ['docs/m10/M10-Acceptance-Contract.md'],
    Architecture: ['docs/m10/M10-Architecture.md'],
    'Measurement Report': ['docs/m10/M10-Measurement-Report.md'],
    'E2E Report': ['docs/m10/M10-E2E-Report.md'],
    'Semantic Evaluation': ['docs/m10/M10-Semantic-Evaluation-Report.md'],
    'Live Report': ['docs/m10/M10-Live-Report.md'],
    'Human Review Materials': ['docs/m10/M10-Human-Review-Materials.md'],
    'Acceptance Report': ['docs/m10/M10-Acceptance-Report.md'],
    'Known Limitations': ['docs/m10/M10-Known-Limitations.md'],
    'Gate Decision': ['docs/m10/M10-Gate-Decision.md'],
    'Activation Candidate': ['docs/m10/M10-Activation-Candidate.md'],
    /* ⚠️ 名字不一致：计划叫 `M10-to-M11-Handoff`，仓库里那份叫 `M10-M11-Read-Only-Contract.md`
       （它同时是 U-12 的只读契约）—— 刻意**不**改文件名（既有链接指向它） */
    'M10-to-M11-Handoff': ['docs/m10/M10-M11-Read-Only-Contract.md'],
  }
  /**
   * **具名待办**：清单里有、但**有意还没写**的交付物。
   *
   * ⚠️ 与 `B3` 的 `❌ 未实现` 同一条纪律：待办**必须逐条带理由**，
   *    而且**必须恰好划分**清单（"映射到文件" + "具名待办" = 清单全部，各一次）。
   *    ⇒ 不许用"加个例外就放行"的形状绕过它；待办在门的输出里**看得见**。
   */
  const DELIVERABLE_PENDING: readonly { item: string; why: string }[] = [
    /* ✅ 2026-09-30：`Gate Decision` **已出**（`M10-Gate-Decision.md`）⇒ 待办清空。
       ⚠️ 这张表**保留**（不是删掉）：下一份计划点名的交付物还没写时，它就该在这里**具名**出现，
          而不是让 `B4` 红着 —— 红是"漏了且没人知道"，待办是"漏了但**看得见**"。 */
  ]
  const pendingItems = DELIVERABLE_PENDING.map((entry) => entry.item)
  const unmapped = requiredItems.filter(
    (item) => DELIVERABLE_FILES[item] === undefined && !pendingItems.includes(item),
  )
  const extraMapped = [
    ...Object.keys(DELIVERABLE_FILES),
    ...pendingItems,
  ].filter((item) => !requiredItems.includes(item))
  const mappedItems = Object.keys(DELIVERABLE_FILES).filter(
    (item) => DELIVERABLE_FILES[item] !== undefined && requiredItems.includes(item),
  )
  const overlap = mappedItems.filter((item) => pendingItems.includes(item))
  const missingFiles = Object.entries(DELIVERABLE_FILES)
    .flatMap(([item, files]) => files.map((file) => ({ item, file })))
    .filter(({ file }) => !existsSync(join(REPO_ROOT, file)))
  record(
    'B',
    'B4',
    '**§21.2 的交付物清单逐条有处置，且账加得起来**：每项要么**映射到真实文件**、'
      + '要么是**具名待办**（带理由）—— 两者**恰好划分**清单。"少一份交付物"与"计划里本来没写"'
      + '在输出上长得一样 ⇒ 所以它靠机器，不靠我记得',
    `映射 ${String(mappedItems.length)} 项 + 待办 ${String(pendingItems.length)} 项 = 清单 ${String(requiredItems.length)} 项`
      + ' · 0 缺文件 · 0 未映射 · 0 多余 · 0 重叠',
    `清单 ${String(requiredItems.length)} 项 · 映射 ${String(mappedItems.length)}`
      + ` · **待办 ${String(pendingItems.length)}**${pendingItems.length > 0 ? `（${pendingItems.join(', ')}）` : ''}`
      + ` · 未映射 ${String(unmapped.length)}${unmapped.length > 0 ? `：${unmapped.join(', ')}` : ''}`
      + ` · 多余 ${String(extraMapped.length)}${extraMapped.length > 0 ? `：${extraMapped.join(', ')}` : ''}`
      + ` · 重叠 ${String(overlap.length)}`
      + ` · **缺文件 ${String(missingFiles.length)}**`
      + (missingFiles.length > 0
        ? `：${missingFiles.map(({ item, file }) => `${item}→${file}`).join(' · ')}`
        : ''),
    unmapped.length === 0 &&
      extraMapped.length === 0 &&
      overlap.length === 0 &&
      missingFiles.length === 0 &&
      mappedItems.length + pendingItems.length === requiredItems.length &&
      requiredItems.length > 0,
  )

  /* B1 —— 汇总文不得出现语义结论类的数字 */
  phase('B1: the summary makes no semantic claims')
  const semanticClaimPatterns = [
    /一致率\s*[:：]?\s*\d/,
    /准确率\s*[:：]?\s*\d/,
    /macro-?F1\s*[:：]?\s*0?\.\d/i,
    /人审\s*[:：]?\s*PASS/,
    /live\s*(smoke)?\s*[:：]?\s*PASS/i,
  ]
  const claimedNumbers = semanticClaimPatterns.filter((pattern) => pattern.test(summaryText))
  record(
    'B',
    'B1',
    '**汇总文不得出现语义/人审/live 的结论数字** —— 它只汇总**边界**；'
      + '那三槽的读数由 WP10/WP11 另出（把没跑的东西写成 PASS 是本仓库最严重的错误）',
    '0 处结论数字',
    claimedNumbers.length === 0
      ? '0 处'
      : `**${String(claimedNumbers.length)} 处**：${claimedNumbers.map((p) => String(p)).join(' · ')}`,
    claimedNumbers.length === 0,
  )

  /* ---------------------------------------------------------------------
   * C · 探测器的正负控
   * ------------------------------------------------------------------- */
  phase('C: positive and negative controls on the detector')

  const fakeId = 'L-M10-99'
  const fakeSource = `${sourceText}\n| \`${fakeId}\` | 注入的假编号 | 注入 | 注入 |`
  const fakeIds = limitationIdsIn(fakeSource)
  const wouldBeMissing = fakeIds.filter((id) => !summaryIds.includes(id))
  record(
    'C',
    'C1',
    '【负控】探测器**必须报漏**：往源文本里注入一个假编号 `L-M10-99` ⇒ '
      + '`A1` 的"漏项"判据必须把它抓出来',
    `${fakeId} 被判为漏项`,
    wouldBeMissing.includes(fakeId)
      ? `${fakeId} 被判为漏项`
      : `**没抓到**（判定它"已在汇总里"）`,
    wouldBeMissing.includes(fakeId),
  )

  const realId = sourceIds[0] ?? 'L-M10-01'
  record(
    'C',
    'C2',
    '【正控】探测器对**存在**的编号必须安静（否则 C1 可以靠"永远报漏"通过）',
    `${realId} 不被判为漏项`,
    summaryIds.includes(realId) ? `${realId} 安静` : `**误报**`,
    summaryIds.includes(realId),
  )

  const hollowProbe = `| \`L-M10-50\` | |`
  record(
    'C',
    'C3',
    '【负控】**空洞判据必须响**：一个只有编号、没有内容的行 ⇒ '
      + '`hasSubstanceFor` 必须判它空洞（否则 A4 可以靠"行里有个编号"通过）',
    '判为空洞',
    hasSubstanceFor(hollowProbe, 'L-M10-50') ? '**判为有实质内容**' : '判为空洞',
    !hasSubstanceFor(hollowProbe, 'L-M10-50'),
  )

  const passed = checks.filter((check) => check.pass).length
  const failed = checks.length - passed

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp11-docs', headShort: head })
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
    schema: 'm10-docs-verify@1',
    runId,
    head,
    mode: 'offline' as const,
    semanticClaim: 'none' as const,
    sources: handoffFiles.length,
    sourceLimitationIds: sourceIds,
    summaryLimitationIds: summaryIds,
    checks,
    perGroup,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
    disclaimer:
      '本门只核对**文档一致性**（汇总文不漏/不编/不空洞 · 不出结论数字）。' +
      '它**不**主张任何语义、人审或 live 结论。',
  }
  writeFileSync(join(dir, 'docs-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp11',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'docs-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes:
      'WP11 文档一致性：Known Limitations 的 54 条编号与交接单**双向**核对' +
      '（不漏 / 不编 / 不空洞）+ 汇总文不得出现语义/人审/live 结论数字 + 三个正负控。' +
      '⚠️ 不主张任何结论。',
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
  console.log('⚠️ 本门只核对**文档一致性**，不主张任何语义/人审/live 结论。')
  process.exit(failed === 0 ? 0 : 1)
}

main()
