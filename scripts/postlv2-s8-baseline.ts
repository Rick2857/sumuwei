/**
 * S8（状态与习惯链）—— **WP0 基线门**（`pnpm postlv2:s8:baseline`）。
 *
 * ============================================================================
 *  载体：`docs/post-lv2/S8-State-and-Habit-Execution-Plan.md` §4「WP0」
 *       退出条件原文：
 *         · 故事根缺口和消费者缺口**可定位**
 *         · **没有**把旧 `NOT RUN` 写成实现完成
 *         · 每个拟引用的既有命令**确实注册**
 *         · 当前混合树被**如实归属**，未来证据可追到执行源版本
 * ============================================================================
 *
 *  ---------------------------------------------------------------------------
 *  ⚠️ 这道门**不宣告 S8 通过**
 *  ---------------------------------------------------------------------------
 * 它的两种输出是不同的东西，混起来就没有意义：
 *
 *  ```
 *  checks[]    结构性判据（PASS/FAIL）—— 只在"基线事实是否被回写/丢失"上判
 *  readings{}  当前读数（**不判**）—— 迁移号、词汇表、开关缺省、消费者可达性……
 *  ```
 *
 *  为什么 `readings` 必须**不判**：WP0 记录的是"S8 **尚未实现**时**长什么样**"
 *  （例如"迁移里没有 `storyline_events`"）。WP2 落地之后那句话就**不再成立**了，
 *  而基线门要被反复重跑。把读数写成断言 ⇒ 要么实现之后门必红，要么实现时要回写基线
 *  —— 后者正是本仓库明令禁止的（"不得回写历史读数"）。
 *  ⇒ 判据只锁**必须永远成立**的东西：计划书原文、前置裁定、迁移表良构、
 *     既有命令注册齐全、许可与复用决定在案、本门自身不开库。
 *
 *  ---------------------------------------------------------------------------
 *  ⚠️ 纯离线（AGENTS.md §6.6 的 Level 0）
 *  ---------------------------------------------------------------------------
 *  只 `node:fs` / `node:path` / `node:child_process` + **kernel 纯契约**。
 *  不 import 任何 persistence / database / drizzle / pglite 模块 ⇒ 不打开真实库。
 *  本门的 `S8-B09` 是对**本文件自身**的静态自检（import 行扫描）。
 *
 *  ⚠️ 计数型自检（AGENTS.md §6.8）：`measured_count` 必须 > 0，
 *     否则判定必须是 `MEASUREMENT INVALID`，**不是** PASS。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// --- kernel 纯契约（无 SQL / 无 IO）-----------------------------------------
import { EVIDENCE_KINDS } from '../src/kernel/contracts/memory.ts'
import { LINEAGE_SOURCE_CLASSES } from '../src/kernel/contracts/reflection-lineage.ts'
import { REFLECTION_SLOTS } from '../src/kernel/contracts/reflection.ts'
import {
  REFLECTION_TRIGGER_FACTS,
  REFLECTION_TRIGGER_KINDS,
  REFLECTION_MAX_WINDOW_INPUTS,
} from '../src/kernel/contracts/reflection-input.ts'
import { MAX_AFFECT_DELTA_PER_EVENT } from '../src/kernel/contracts/affect.ts'
import {
  REFLECTION_MIN_CONVERSATIONS,
  REFLECTION_MIN_INDEPENDENT_ROOTS,
} from '../src/kernel/app/reflection/inputs.ts'
import { ADAPTIVE_SELF_SCOPE, ADAPTIVE_SELF_SLOTS } from '../src/kernel/contracts/adaptive-self.ts'
import { readKernelFlags } from '../src/kernel/app/flags.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../src/kernel/recall/selector.ts'

const REPO_ROOT = resolve(process.cwd())
const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), 'utf8')
const has = (relative: string): boolean => existsSync(join(REPO_ROOT, relative))
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

// ---------------------------------------------------------------------------
// 载体路径
// ---------------------------------------------------------------------------
const PLAN = 'docs/post-lv2/S8-State-and-Habit-Execution-Plan.md'
const RESEARCH = 'docs/research/S8-Story-Experience-Cognition-Solutions-2026-10-03.md'
const BASELINE_DOC = 'docs/post-lv2/S8-WP0-Baseline.md'
const LICENSE_DOC = 'docs/post-lv2/Post-Lv2-Dependency-and-License-Freeze.md'
const ADR_090 = 'docs/adr/ADR-090-lv2-risk-acceptance-release.md'
const ADR_091 = 'docs/adr/ADR-091-post-lv2-world-boundary-and-story-source.md'
const ADR_092 = 'docs/adr/ADR-092-pl2-sr-01-story-durable-root-ruling.md'
const PACKAGE_JSON = 'package.json'

/**
 * 本门冻结的**相关源文件清单**（摘要进 manifest ⇒ "证据可追到执行源版本"）。
 *
 * ⚠️ 清单一经冻结**只许追加**：删项等于让"当时的 S8 相关面"从证据里消失。
 */
const SOURCE_FILES: readonly string[] = [
  'src/kernel/storyline/story-types.ts',
  'src/kernel/storyline/world-machine.ts',
  'src/kernel/storyline/world-observation.ts',
  'src/infrastructure/storyline/ink-runtime.ts',
  'evals/storyline/jichuang-interview-two/story-pack.ts',
  'evals/storyline/jichuang-interview-two/jichuang-interview-two.ink',
  'evals/storyline/jichuang-interview-two/content-manifest.json',
  'src/kernel/contracts/processor.ts',
  'src/kernel/contracts/proposal.ts',
  'src/kernel/contracts/domain-event.ts',
  'src/kernel/contracts/memory.ts',
  'src/kernel/contracts/reflection.ts',
  'src/kernel/contracts/reflection-input.ts',
  'src/kernel/contracts/reflection-lineage.ts',
  'src/kernel/contracts/adaptive-self.ts',
  'src/kernel/contracts/affect.ts',
  'src/kernel/contracts/relationship.ts',
  'src/kernel/app/affect/evaluator.ts',
  'src/kernel/app/relationship/evaluator.ts',
  'src/kernel/app/reflection/inputs.ts',
  'src/kernel/app/reflection/lineage.ts',
  'src/kernel/app/reflection/adaptive-self.ts',
  'src/kernel/app/flags.ts',
  'src/infrastructure/persistence/qualification-read.ts',
  'src/infrastructure/persistence/reflection-lineage-read.ts',
  'src/infrastructure/persistence/migrations.ts',
  'src/main.ts',
]

/**
 * 计划 §7 表格里**拟引用**的既有回归入口（逐字抄自计划书，不在这里重新命名）。
 *
 * ⚠️ 这是 WP0 退出条件第三条的机器形态：**每个拟引用的既有命令确实注册**。
 *    以后某个脚本被改名/删除时，这道门会立刻红 —— 而不是等到实施当天才发现。
 */
const PLAN_REFERENCED_COMMANDS: readonly string[] = [
  'typecheck',
  'm4.5:ci',
  'kernel:test',
  'kernel:verify',
  'kernel:test:conversation',
  'm5.1.1:migration:verify',
  'm5.1.1:wp3.2:verify',
  'm4:test',
  'm4:verify',
  'm4:mutation-safety:verify',
  'm4:nl-mutation:verify',
  'eval:m4',
  'memory-coverage:verify',
  'm7:test',
  'm7:measurement:verify',
  'm7:e2e:verify',
  'm8:wp2:contracts',
  'm8:wp3:verify',
  'm8:wp4:verify',
  'm8:wp5:verify',
  'm8:wp6:verify',
  'm8:e2e:verify',
  'm8:long:verify',
  'm8.5:test',
  'm8.5:verify',
  'm8.5:e2e:verify',
  'm8.5:long:verify',
  'm11:lineage:verify',
  'm11:inputs:verify',
  'm11:policy:verify',
  'm11:adaptive:verify',
  'm11:invalidation:verify',
  'm11:recovery:verify',
  'm11:context:verify',
  'm11:measurement:verify',
  'm11:observability:verify',
  'm11:e2e:verify',
  'm11:long:verify',
  'm11.1:wiring:verify',
  'm11.1:recovery:verify',
  'm11.1:e2e:verify',
  'm11.1:measurement:verify',
  'm11.1:source:verify',
  'm11.1:joint:verify',
  'postlv2:story:verify',
  'postlv2:source:verify',
  'postlv2:world:verify',
  'postlv2:source-root:verify',
  'postlv2:bridge:verify',
  'postlv2:transport:verify',
  'postlv2:db:verify',
]

/** 计划 §5 拟定、但**当时未注册**的 S8 入口（WP0 只注册其中 `baseline` 一条）。 */
const PLANNED_S8_COMMANDS: readonly string[] = [
  'postlv2:s8:baseline',
  'postlv2:s8:contracts:verify',
  'postlv2:s8:store:verify',
  'postlv2:s8:roots:verify',
  'postlv2:s8:state:verify',
  'postlv2:s8:reflection:verify',
  'postlv2:s8:lifecycle:verify',
  'postlv2:s8:measurement:verify',
  'postlv2:s8:e2e:verify',
  'postlv2:s8:semantic:eval',
  'postlv2:s8:behavior:live',
  'postlv2:s8:long:live',
  'postlv2:s8:gates',
]

/** 上游候选组件（调研报告 §8 的固定提交；WP0 只核对许可与复用决定，不安装） */
const UPSTREAM_COMPONENTS: readonly { name: string; commit: string; license: string; decision: string }[] = [
  {
    name: 'Concordia',
    commit: 'b71d202750e23444ce1bf28d9f114bcd88aa41db',
    license: 'Apache-2.0',
    decision: '方法参考',
  },
  {
    name: 'FAtiMA-Toolkit',
    commit: '56b7cbd992f953cfe21a7b12cb1a0e6cdf6ccf9f',
    license: 'Apache-2.0',
    decision: '方法参考',
  },
  {
    name: 'Ensemble',
    commit: '8b74bdec4ba2ef4e14795b7591df3b5d73f283e3',
    license: 'NOASSERTION（LICENSE.md = 四条款 BSD 文本）',
    decision: '方法参考',
  },
  {
    name: 'ExpeL',
    commit: 'e41ec9a24823e7b560c561ab191441b56d9bcefc',
    license: 'Apache-2.0',
    decision: '方法参考',
  },
]

// ---------------------------------------------------------------------------
// 判据记录
// ---------------------------------------------------------------------------
interface Check {
  id: string
  label: string
  pass: boolean
  detail: string
  measured: number
}
const checks: Check[] = []
const record = (id: string, label: string, pass: boolean, detail: string, measured: number): void => {
  checks.push({ id, label, pass, detail, measured })
  console.log(`  ${pass ? '✅' : '❌'} ${id} ${label} —— ${detail}`)
}

// ---------------------------------------------------------------------------
// S8-B01 计划书在案，且**没有被回写成"已完成"**
// ---------------------------------------------------------------------------
const planText = has(PLAN) ? read(PLAN) : ''
const planDeclaresNotStarted = /实现尚未开始/.test(planText) && /验收尚未执行/.test(planText)
const planDeclaresEngineeringGap = /工程缺失；测量未执行/.test(planText)
const planKeepsOldReading = /不把风险接受当作 S8 验收证据/.test(planText)
record(
  'S8-B01',
  'S8 计划书在案，且原文仍声明"实现尚未开始 / 验收尚未执行"（不得被回写成已完成）',
  planText.length > 0 && planDeclaresNotStarted && planDeclaresEngineeringGap && planKeepsOldReading,
  `字节=${planText.length} · 未开始=${String(planDeclaresNotStarted)} · 工程缺失=${String(planDeclaresEngineeringGap)} · 不回写=${String(planKeepsOldReading)}`,
  [planDeclaresNotStarted, planDeclaresEngineeringGap, planKeepsOldReading].filter(Boolean).length
)

// ---------------------------------------------------------------------------
// S8-B02 调研锚点在案（固定提交 + 四组件）
// ---------------------------------------------------------------------------
const researchText = has(RESEARCH) ? read(RESEARCH) : ''
const planHasResearchAnchor = planText.includes('6c16c11b')
const anchorHits = ['1f801166', ...UPSTREAM_COMPONENTS.map((c) => c.commit.slice(0, 7))].filter((token) =>
  researchText.includes(token)
)
record(
  'S8-B02',
  '调研报告在案（本机核对基线 + 四个上游组件的**固定提交**），且计划书引用的调研锚点在位',
  researchText.length > 0 && planHasResearchAnchor && anchorHits.length === UPSTREAM_COMPONENTS.length + 1,
  `计划里的调研锚点=${String(planHasResearchAnchor)} · 调研文命中=${JSON.stringify(anchorHits)}（期望 ${
    UPSTREAM_COMPONENTS.length + 1
  } 个）`,
  anchorHits.length + (planHasResearchAnchor ? 1 : 0)
)

// ---------------------------------------------------------------------------
// S8-B03 前置裁定三份在案，且 ADR-092 的延后项写明"新建持久根类别"
// ---------------------------------------------------------------------------
const adr090 = has(ADR_090) ? read(ADR_090) : ''
const adr091 = has(ADR_091) ? read(ADR_091) : ''
const adr092 = has(ADR_092) ? read(ADR_092) : ''
const adr090Ok = adr090.includes('Lv2 = PASS') && adr090.includes('不由本裁定改成 PASS')
const adr091Ok = /ACCEPTED \/ DESIGN FROZEN/.test(adr091) && /story_experience/.test(adr091)
/*
 * ADR-092 是**推迟**裁定（不是"已具备"）：判据要同时锁住三件事才不会被回写——
 *   ① 旧裁定仍写着"暂不建设 / 不新建持久根类别"；
 *   ② D03 的四项前置**逐条还在**（没有实施就不许悄悄删掉前置）；
 *   ③ 残余 `L-PL2-03`（`storyline_events` 表不存在）仍在册。
 */
const adr092Deferred = /暂不建设/.test(adr092) && /不\*\*新建持久根类别|不\*\*新建持久根类别/.test(adr092)
const adr092Prereqs = [
  'storyline_events',
  'rootReadingsByMemory',
  'ProcessorEventView',
  'EvidenceKind',
].every((token) => adr092.includes(token))
const adr092Residual = /L-PL2-03/.test(adr092)
const adr092Ok = /PL2-SR-01/.test(adr092) && adr092Deferred && adr092Prereqs && adr092Residual
record(
  'S8-B03',
  '前置三裁定在案：ADR-090（Lv2 放行·不回写）· ADR-091（来源边界）· ADR-092（持久根候选 = **推迟**，四项前置与 L-PL2-03 仍在册）',
  adr090Ok && adr091Ok && adr092Ok,
  `ADR-090=${String(adr090Ok)} · ADR-091=${String(adr091Ok)} · ADR-092=${String(adr092Ok)}（推迟=${String(
    adr092Deferred
  )} · 前置=${String(adr092Prereqs)} · 残余=${String(adr092Residual)}）`,
  [adr090Ok, adr091Ok, adr092Ok].filter(Boolean).length
)

// ---------------------------------------------------------------------------
// S8-B04 迁移登记表良构（版本从 1 起严格连续；**不**断言"有没有 storyline 表"）
// ---------------------------------------------------------------------------
const migrationsText = has('src/infrastructure/persistence/migrations.ts')
  ? read('src/infrastructure/persistence/migrations.ts')
  : ''
/*
 * ⚠️ `\r?\n` 不是装饰：本仓库在 Windows 上检出，这些文件是 **CRLF**。
 *    第一版写成 `\{\n` ⇒ 实读版本 = `[]`（一条都没匹配上），而"连续"判据
 *    在空数组上会给出**假绿**的最后一道防线被 measured_count 挡住 ⇒ 报 FAIL。
 *    这正是 AGENTS.md §6.8 那类"量具没量到东西"的形态，所以判据里同时要求非空。
 */
const migrationVersions = [
  ...migrationsText.matchAll(/^const MIGRATION_(\d{4}): Migration = \{\r?\n\s*version: (\d+),/gm),
].map((m) => Number(m[2]))
const contiguous =
  migrationVersions.length > 0 && migrationVersions.every((value, index) => value === index + 1)
/*
 * ⚠️ 第二条判据是**量具自检**（AGENTS.md §6.8 的教训）：
 * 正则只认得 `MIGRATION_00NN` 这一种命名。若有人用别的名字新增一条迁移，
 * 上面那段会**少读到一条**而"连续"照样成立（1,2,…,11 仍然连续）。
 * 因此再用**登记数组**独立数一遍：两者不等 ⇒ 量具没覆盖全部迁移 ⇒ 不判 PASS。
 */
const registeredInArray = [...migrationsText.matchAll(/^\s{2}MIGRATION_\d{4},$/gm)].length
const registryAgrees = registeredInArray === migrationVersions.length
record(
  'S8-B04',
  '迁移登记表良构：版本从 1 起**严格连续**，且"逐条定义数"与"MIGRATIONS 数组登记数"一致（量具自检）',
  contiguous && registryAgrees,
  `实读版本=${JSON.stringify(migrationVersions)} · 连续=${String(contiguous)} · 数组登记=${registeredInArray} · 一致=${String(
    registryAgrees
  )}`,
  migrationVersions.length + registeredInArray
)

// ---------------------------------------------------------------------------
// S8-B05 计划 §7 拟引用的既有命令**全部注册**
// ---------------------------------------------------------------------------
const pkg = JSON.parse(read(PACKAGE_JSON)) as { scripts?: Record<string, string> }
const registered = pkg.scripts ?? {}
const missingCommands = PLAN_REFERENCED_COMMANDS.filter((name) => registered[name] === undefined)
record(
  'S8-B05',
  '计划 §7 拟引用的既有回归入口**全部已在 `package.json` 注册**（改名/删除会当场红）',
  missingCommands.length === 0 && PLAN_REFERENCED_COMMANDS.length > 40,
  `检查 ${PLAN_REFERENCED_COMMANDS.length} 条 · 缺=${JSON.stringify(missingCommands)}`,
  PLAN_REFERENCED_COMMANDS.length
)

// ---------------------------------------------------------------------------
// S8-B06 拟定 S8 入口的**注册进度**（如实记录；只要求 baseline 这条已注册）
// ---------------------------------------------------------------------------
const s8Registered = PLANNED_S8_COMMANDS.filter((name) => registered[name] !== undefined)
const s8Missing = PLANNED_S8_COMMANDS.filter((name) => registered[name] === undefined)
record(
  'S8-B06',
  '拟定的 13 条 S8 入口中 `postlv2:s8:baseline` 已注册；其余**如实记为未注册**（禁止空脚本/恒 PASS 占位）',
  registered['postlv2:s8:baseline'] === 'tsx scripts/postlv2-s8-baseline.ts',
  `已注册=${JSON.stringify(s8Registered)} · 未注册=${s8Missing.length} 条`,
  s8Registered.length
)

// ---------------------------------------------------------------------------
// S8-B07 上游许可核对：四个组件在**基线文档**与**调研报告**里都有登记
// ---------------------------------------------------------------------------
const baselineDocText = has(BASELINE_DOC) ? read(BASELINE_DOC) : ''
const licenseRegistered = UPSTREAM_COMPONENTS.filter(
  (component) =>
    baselineDocText.includes(component.name) &&
    baselineDocText.includes(component.commit.slice(0, 7)) &&
    baselineDocText.includes(component.license.split('（')[0]!)
).length
record(
  'S8-B07',
  '上游四组件（Concordia / FAtiMA / Ensemble / ExpeL）的**固定提交与许可**已在基线文档登记',
  licenseRegistered === UPSTREAM_COMPONENTS.length && /NOASSERTION/.test(baselineDocText),
  `已登记=${licenseRegistered}/${UPSTREAM_COMPONENTS.length} · Ensemble 的 NOASSERTION 如实登记=${String(
    /NOASSERTION/.test(baselineDocText)
  )}`,
  licenseRegistered
)

// ---------------------------------------------------------------------------
// S8-B08 复用决定表在位（三档：直接复用 / 方法参考 / 淘汰）
// ---------------------------------------------------------------------------
const decisionRows = ['直接复用', '方法参考', '淘汰'].filter((label) => baselineDocText.includes(label))
const perComponentDecision = UPSTREAM_COMPONENTS.filter(
  (component) => baselineDocText.includes(component.name) && baselineDocText.includes(component.decision)
).length
record(
  'S8-B08',
  '复用决定表在位：三档齐备，且四个组件各有具名决定（首版 **NONE** 新依赖）',
  decisionRows.length === 3 && perComponentDecision === UPSTREAM_COMPONENTS.length,
  `档位命中=${JSON.stringify(decisionRows)} · 组件具名决定=${perComponentDecision}/${UPSTREAM_COMPONENTS.length}`,
  decisionRows.length + perComponentDecision
)

// ---------------------------------------------------------------------------
// S8-B09 只读纪律（对本文件自身的静态自检）
// ---------------------------------------------------------------------------
const selfSource = read('scripts/postlv2-s8-baseline.ts')
const importLines = selfSource
  .split('\n')
  .filter((line) => /^\s*(import|export)\s.*from\s+['"]/.test(line))
const dbImports = importLines.filter((line) => /(persistence\/|database|pglite|drizzle|@elizaos)/i.test(line))
const infrastructureImports = importLines.filter((line) => /from '\.\.\/src\/infrastructure\//.test(line))
record(
  'S8-B09',
  '只读纪律：本门不 import 任何数据库/基础设施模块、不打开 `data/pglite`',
  dbImports.length === 0 && infrastructureImports.length === 0 && importLines.length >= 10,
  `import 行=${importLines.length} · 数据库模块=${JSON.stringify(dbImports)} · infrastructure=${JSON.stringify(
    infrastructureImports
  )}`,
  importLines.length
)

// ---------------------------------------------------------------------------
// S8-B10 混合树如实归属（**只记录，不断言干净**）
// ---------------------------------------------------------------------------
let head = 'unknown'
let porcelain: string[] = []
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  porcelain = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
} catch {
  /* 只读盘点失败不改变判定，但会如实写进证据 */
}
const foreignChanges = porcelain.filter((line) => !line.includes('post-lv2/S8-') && !line.includes('postlv2-s8-'))
record(
  'S8-B10',
  '当前混合树**如实归属**：HEAD 与全部未提交改动都进证据（不假装干净，不接管他人改动）',
  head !== 'unknown',
  `HEAD=${head.slice(0, 12)} · 未提交条目=${porcelain.length} · 其中非本工作包=${foreignChanges.length}`,
  porcelain.length + (head !== 'unknown' ? 1 : 0)
)

// ---------------------------------------------------------------------------
// 读数（**不判**）
// ---------------------------------------------------------------------------
const flags = readKernelFlags({} as NodeJS.ProcessEnv)
const sourceDigests = SOURCE_FILES.map((path) => ({
  path,
  exists: has(path),
  sha256: has(path) ? sha256(read(path)) : null,
  bytes: has(path) ? statSync(join(REPO_ROOT, path)).size : 0,
}))

const lineageHandleKindSource = has('src/kernel/contracts/reflection-lineage.ts')
  ? read('src/kernel/contracts/reflection-lineage.ts')
  : ''
const lineageHandleKinds = [
  ...(/(?:export type LineageHandleKind =)([^\n]*)/.exec(lineageHandleKindSource)?.[1] ?? '').matchAll(
    /'([a-z_]+)'/g
  ),
].map((m) => m[1]!)

const readings = {
  /**
   * ⚠️ 这些读数**表达的是"WP0 执行当时的状态"**，会被后来的 WP 改写。
   *    它们进证据是为了"未来能回答 S8 到底补了什么"，**不是**判据。
   */
  latestMigrationVersion: migrationVersions.length > 0 ? Math.max(...migrationVersions) : null,
  migrationCount: migrationVersions.length,
  /** 世界里有没有**持久**故事事件表（WP2 的交付物） */
  storylineEventsTableInMigrations: /storyline_events/.test(migrationsText),
  /** 迁移里有没有把三个故事词汇写进约束（ADR-091 `D04` 的落地形态） */
  storyVocabularyWidenedInMigrations: /story_fact/.test(migrationsText) && /story_experience/.test(migrationsText),
  evidenceKinds: [...EVIDENCE_KINDS],
  lineageHandleKinds,
  lineageSourceClasses: [...LINEAGE_SOURCE_CLASSES],
  reflectionSlots: [...REFLECTION_SLOTS],
  adaptiveSelfSlots: [...ADAPTIVE_SELF_SLOTS],
  adaptiveSelfScope: ADAPTIVE_SELF_SCOPE,
  reflectionThresholds: {
    minIndependentRoots: REFLECTION_MIN_INDEPENDENT_ROOTS,
    minConversations: REFLECTION_MIN_CONVERSATIONS,
    maxWindowInputs: REFLECTION_MAX_WINDOW_INPUTS,
  },
  reflectionTriggerReachability: REFLECTION_TRIGGER_KINDS.map((kind) => ({
    kind,
    v1Detectable: REFLECTION_TRIGGER_FACTS[kind].v1Detectable,
    detector: REFLECTION_TRIGGER_FACTS[kind].detector,
  })),
  affect: { maxDeltaPerEvent: MAX_AFFECT_DELTA_PER_EVENT },
  /** **代码缺省**（不看本机 `.env`）—— 这是"接线就位 / 激活另裁"的形状 */
  flagDefaults: {
    reflectionEnabled: flags.reflectionEnabled,
    adaptiveSelfEnabled: flags.adaptiveSelfEnabled,
    adaptiveSelfTokens: flags.adaptiveSelfTokens,
    goalTokens: flags.goalTokens,
    commitmentTokens: flags.commitmentTokens,
    affectContextEnabled: flags.affectContextEnabled,
    relationshipContextEnabled: flags.relationshipContextEnabled,
    beliefEnabled: flags.beliefEnabled,
  },
  contextBudgetDefaults: {
    adaptiveSelfTokens: DEFAULT_CONTEXT_BUDGET.adaptiveSelfTokens,
    goalTokens: DEFAULT_CONTEXT_BUDGET.goalTokens,
    commitmentTokens: DEFAULT_CONTEXT_BUDGET.commitmentTokens,
    externalEvidenceTokens: DEFAULT_CONTEXT_BUDGET.externalEvidenceTokens,
    rollupTokens: DEFAULT_CONTEXT_BUDGET.rollupTokens,
  },
  plannedS8Commands: { registered: s8Registered, notRegistered: s8Missing },
  upstreamComponents: UPSTREAM_COMPONENTS,
  policyFingerprints: {
    plan: { path: PLAN, sha256: planText.length > 0 ? sha256(planText) : null, bytes: planText.length },
    research: {
      path: RESEARCH,
      sha256: researchText.length > 0 ? sha256(researchText) : null,
      bytes: researchText.length,
    },
    licenseFreezeDoc: has(LICENSE_DOC)
      ? { path: LICENSE_DOC, sha256: sha256(read(LICENSE_DOC)) }
      : { path: LICENSE_DOC, sha256: null },
  },
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
const measuredCount = checks.reduce((sum, check) => sum + check.measured, 0)
const failed = checks.filter((check) => !check.pass)
const gateValid = measuredCount > 0
const passed = gateValid && failed.length === 0

const dataDir = join(REPO_ROOT, 'data/pglite')
const dataDirReading = existsSync(dataDir)
  ? {
      exists: true,
      mtimeMs: statSync(dataDir).mtimeMs,
      mtimeIso: new Date(statSync(dataDir).mtimeMs).toISOString(),
      note: 'data/ 被 gitignore ⇒ 不能用 git 证明它没被动；本门只用 mtime 记录"本门没有打开过它"',
    }
  : { exists: false }

const runId = `postlv2-s8-wp0-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${head.slice(0, 8)}`
const outDir = join(REPO_ROOT, 'artifacts/post-lv2', runId)
mkdirSync(outDir, { recursive: true })

const reading = {
  runId,
  gate: 'postlv2:s8:baseline',
  milestone: 'post-lv2 / S8 / WP0',
  generatedAt: new Date().toISOString(),
  source: {
    head,
    workingTreeDirty: porcelain.length > 0,
    workingTreePorcelain: porcelain.slice(0, 80),
    foreignChanges,
    note: '混合树：其他会话的在途改动**只记录、不接管**（AGENTS.md §8）',
  },
  versions: {
    node: process.version,
    pnpm: safeVersion('pnpm'),
    platform: `${process.platform} ${process.arch}`,
  },
  sourceDigests,
  dataDir: dataDirReading,
  readings,
  checks,
  measuredCount,
  verdict: gateValid ? (passed ? 'PASS' : 'FAIL') : 'MEASUREMENT INVALID',
}

function safeVersion(command: string): string {
  try {
    return execFileSync(command, ['-v'], { cwd: REPO_ROOT, encoding: 'utf8', shell: true }).trim()
  } catch {
    return 'unknown'
  }
}

writeFileSync(join(outDir, 's8-wp0-baseline.json'), JSON.stringify(reading, null, 2), 'utf8')
writeFileSync(join(outDir, 'README.md'), baselineReadme(reading), 'utf8')

console.log('')
console.log(`  measured_count = ${measuredCount}`)
console.log(`  ${passed ? '✅' : '❌'} postlv2:s8:baseline = ${reading.verdict}`)
console.log(`  证据：artifacts/post-lv2/${runId}/s8-wp0-baseline.json`)

function baselineReadme(value: typeof reading): string {
  const lines = [
    '# S8 · WP0 基线读数',
    '',
    `- runId：\`${value.runId}\``,
    `- 生成：${value.generatedAt}`,
    `- HEAD：\`${value.source.head}\` · 工作树脏：${String(value.source.workingTreeDirty)}`,
    `- 判定：**${value.verdict}** · measured_count = ${value.measuredCount}`,
    '',
    '## 判据',
    '',
    '| 检查 | 标签 | 结果 | 读数 |',
    '|---|---|---|---|',
    ...value.checks.map(
      (check) =>
        `| ${check.id} | ${check.label} | ${check.pass ? 'PASS' : 'FAIL'} | ${check.detail.replace(/\|/g, '\\|')} |`
    ),
    '',
    '## 读数（**不判**；WP2 起会变）',
    '',
    `- 迁移：最新 v${String(value.readings.latestMigrationVersion)} · 共 ${value.readings.migrationCount} 条`,
    `- 迁移里有 \`storyline_events\` 表：**${String(value.readings.storylineEventsTableInMigrations)}**`,
    `- 迁移里扩宽了故事词汇：${String(value.readings.storyVocabularyWidenedInMigrations)}`,
    `- \`EvidenceKind\`：${value.readings.evidenceKinds.join(' / ')}`,
    `- \`LineageHandleKind\`：${value.readings.lineageHandleKinds.join(' / ')}`,
    `- 反思门槛：根 ≥ ${value.readings.reflectionThresholds.minIndependentRoots} · 会话 ≥ ${value.readings.reflectionThresholds.minConversations} · 窗口 ≤ ${value.readings.reflectionThresholds.maxWindowInputs}`,
    `- 代码缺省：reflection=${String(value.readings.flagDefaults.reflectionEnabled)} · adaptive-self=${String(value.readings.flagDefaults.adaptiveSelfEnabled)} · adaptive-self-tokens=${value.readings.flagDefaults.adaptiveSelfTokens}`,
    `- 拟定 13 条 S8 入口：已注册 ${value.readings.plannedS8Commands.registered.length} 条（${value.readings.plannedS8Commands.registered.join(' / ') || '无'}）`,
    '',
    '⚠️ 本门全离线：不打开任何数据库、不发任何模型请求；上表的"读数"**不是**判据。',
    '',
  ]
  return lines.join('\n')
}

process.exitCode = passed ? 0 : 1
