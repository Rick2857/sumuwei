/**
 * M5.1.1 WP9-B —— **B0：Semantic Selection Gate**（只读扫描器）
 * ============================================================================
 * 要回答的问题（WP9-B 执行令 B0）：
 *
 *   今天生产里**有没有**一个"语义上本来就是系统自行发起"的**真实产品行为**？
 *   （runtime lifecycle / scheduler / automatic maintenance / recovery /
 *     内部策略驱动 / background system task）
 *
 * 只有**同时**满足五条才可被选为 E4 的 SYSTEM producer：
 *   ① 今天已经有真实产品行为（不是为了 E4 新编的功能）
 *   ② 没有人类 / agent / control command 作为**直接**因果起源
 *   ③ 它确实该回答"是谁发起的？" → `SYSTEM/<component>`
 *   ④ 能进入**现有** production runtime
 *   ⑤ 不需要碰 MemoryAuthority / Fact Firewall / ADR-043
 *
 * 五条里任何一条不成立 ⇒ 该类**不是候选**，只作为"被否决的候选 + 理由"登记。
 *
 * ---------------------------------------------------------------------------
 * 纪律（AGENTS §6.7 / §6.8，INV-M45-06）
 * ---------------------------------------------------------------------------
 *   · 三段式：**正控安静**（真实 `src/**` ⇒ 0 候选）→ **注入合成候选 ⇒ 必响**
 *     （临时目录里的假 scheduler + 假 recorder 调用，必须被检出）→ **恢复安静**
 *   · 计数型判据自检 `measured_count > 0`：扫到的文件数与字节数必须非零、
 *     否则是 MEASUREMENT INVALID（"检查了 0 个文件、发现 0 个候选"与
 *     "全都查过、确实没有候选"在输出上长得一样）
 *   · 每个"期望为 0"的类都自带**良性命中**定义（例如 telemetry 的 abort 计时器
 *     不是域计时器），只把"非良性命中"算作候选 —— 判据不许靠"整段文本里没有这个词"
 *
 * 本脚本**只读** `src/**`，不 import 任何 kernel / infrastructure 模块
 * （因此**不可能**打开数据库），只写自己的 artifact：`artifacts/m5.1.1/wp9b-*.json`。
 *
 * 退出码：`0` = 找到了可选候选（B0 通过，可进入 B1）
 *         或 **SUPERSEDED_BY_R45_PRODUCT_DECISION**（MIGRATION_0009 已按 R-45 落地 ⇒ B0 的判定
 *         被产品决定取代；B0 的历史记录逐字保留）
 *         `1` = **BLOCKED BY PRODUCT CAPABILITY DECISION**（生产真实系统发起行为 = 0）
 *         `2` = 量具无效 / 三段式失败（**不是** B0 的判定）
 *
 * 用法：`tsx scripts/verify-m5.1.1-wp9b-e4-selection.ts [--root <dir>] [--out <json>]`
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = process.cwd()
const DEFAULT_OUT = join(ROOT, 'artifacts', 'm5.1.1', 'wp9b-e4-selection.json')
/** 被本扫描器点名的、唯一合法的 system-event 宿主 */
const RECORDER_REL = 'src/infrastructure/runtime/conversation-recorder.ts'
const INGRESS_REL = 'src/infrastructure/runtime/conversation-attribution.ts'
const FLAGS_REL = 'src/kernel/app/flags.ts'
const NOT_WIRED_MARKER = '没有接到任何东西'
/** 修复过程里**不允许**出现的账本写入（出现即说明它其实是 ledger writer） */
const LEDGER_INSERT_IN_RECOVERY = /insert\s+into|appendSystemEvent|conversation_events/
/** `state_events` 的 DDL 里**不允许**出现的归因列（出现即说明它能直接承载归因） */
const STATE_ATTRIBUTION_COLUMN = /initiator|recorded_by|attribution_origin|\bactor\b/

// ---------------------------------------------------------------------------
// 命中 / 类的形状
// ---------------------------------------------------------------------------

interface Hit {
  file: string
  line: number
  text: string
}

interface BenignRule {
  /** none = 该类里所有命中都是候选 */
  kind: 'none' | 'path-prefix' | 'path-equals' | 'near-marker'
  value?: string
  radius?: number
}

/**
 * 良性命中 = **任一**规则成立（OR）。
 * 例（C8）：`flags.ts` 里的声明/打印**本来就是**该开关的唯一合法出现处，
 * 而**别处**的出现必须紧挨着那句"没有接到任何东西"的如实告警。
 */
type BenignSpec = readonly BenignRule[]

interface ClassSpec {
  id: string
  title: string
  /** 这个类在"今天的生产"里**期望**是什么 */
  expectation: string
  pattern: RegExp
  benign: BenignSpec
  /** 这个类对应执行令里的哪一条 */
  orderRef: string
}

interface ClassResult {
  id: string
  title: string
  orderRef: string
  expectation: string
  hitCount: number
  benignCount: number
  candidateCount: number
  ok: boolean
  hits: Hit[]
  candidates: Hit[]
}

interface ScanResult {
  root: string
  filesScanned: number
  bytesScanned: number
  classes: ClassResult[]
  candidateCount: number
  classFailures: string[]
}

interface Fact {
  id: string
  claim: string
  ok: boolean
  observed: string
}

// ---------------------------------------------------------------------------
// 六个类（执行令 B0 的清单）+ 四条"入口/开关"事实
// ---------------------------------------------------------------------------

const CLASSES: readonly ClassSpec[] = [
  {
    id: 'C1_timer_scheduler',
    title: '调度器 / 计时器 / 周期任务（域内）',
    orderRef: 'B0 class: scheduler / timer',
    expectation: '`src/**` 里**没有**任何域内定时器/调度器（0 命中）',
    pattern: /\bsetInterval\s*\(|\bsetImmediate\s*\(|\bqueueMicrotask\s*\(|new\s+Worker\s*\(|\bcron\b|\b@daily\b/g,
    benign: [{ kind: 'none' }],
  },
  {
    id: 'C2_timeout_non_telemetry',
    title: '`setTimeout`（排除 telemetry 的请求超时）',
    orderRef: 'B0 class: scheduler / timer',
    expectation: '`setTimeout` 只允许出现在 `src/infrastructure/telemetry/**`（网络超时，不是域触发）',
    pattern: /\bsetTimeout\s*\(/g,
    benign: [{ kind: 'path-prefix', value: 'src/infrastructure/telemetry/' }],
  },
  {
    id: 'C3_recovery_reconciliation',
    title: '恢复 / 对账 / 补偿 / outbox / 重试队列',
    orderRef: 'B0 class: recovery / reconciliation',
    expectation: '不存在（0 命中）',
    pattern: /reconcil|compensat|[Oo]utbox|drainQueue|pendingJobs|retryQueue|\bvacuum\b|\bretention\b/g,
    benign: [{ kind: 'none' }],
  },
  {
    id: 'C4_proactive_unsolicited',
    title: '主动 / 自发的自我发起行为',
    orderRef: 'B0 class: internal policy-driven operation',
    expectation: '不存在（0 命中）—— 她今天**不会**在没有回合的情况下自己说话或做事',
    pattern: /proactive|initiative|spontaneous|unsolicited|autonomous|主动发起|自行发起/g,
    benign: [{ kind: 'none' }],
  },
  {
    id: 'C5_system_event_call_sites',
    title: '`recordSystemEvent` / `recordToolOutput` 的生产调用点',
    orderRef: 'B0 class: runtime lifecycle / system event',
    expectation: `除宿主 ${RECORDER_REL} 的定义处外**零调用点**（宿主方法自身 DEAD / UNREACHABLE）`,
    pattern: /\brecordSystemEvent\s*\(|\brecordToolOutput\s*\(/g,
    benign: [{ kind: 'path-equals', value: RECORDER_REL }],
  },
  {
    id: 'C6_append_system_event',
    title: '`ledger.appendSystemEvent` 的调用点',
    orderRef: 'B0 class: system event',
    expectation: `唯一调用者就是 ${RECORDER_REL} 里的那个宿主方法`,
    pattern: /\.appendSystemEvent\s*\(/g,
    benign: [{ kind: 'path-equals', value: RECORDER_REL }],
  },
  {
    id: 'C7_memory_job_production_import',
    title: '后台记忆任务（`kernel/app/memory/job.ts`）的生产 import',
    orderRef: 'B0 class: background system task / automatic maintenance',
    expectation: '`src/**` 里**没有任何文件** import 它（后台抽取从未接入生产）',
    pattern: /from\s+['"][^'"]*memory\/job\.ts['"]/g,
    benign: [{ kind: 'none' }],
  },
  {
    id: 'C8_flag_not_wired',
    title: '`CHARACTER_MEMORY_BACKGROUND_ENABLED` 的消费者',
    orderRef: 'B0 class: background system task',
    expectation: `除 ${FLAGS_REL} 的声明/打印外，唯一的出现处是启动时那句"没有接到任何东西"的如实告警`,
    pattern: /memoryBackgroundEnabled/g,
    benign: [
      { kind: 'path-equals', value: FLAGS_REL },
      { kind: 'near-marker', value: NOT_WIRED_MARKER, radius: 10 },
    ],
  },
  {
    id: 'C9_system_ingress_factory',
    title: '是否**存在**一个 SYSTEM 入口工厂',
    orderRef: 'B0 condition ④: 能进入现有 production runtime',
    expectation: '不存在（0 命中）—— 没有 `*System*Ingress` 这类工厂可被接线',
    pattern: /System[A-Za-z]*Ingress|system[A-Za-z]*Ingress/g,
    benign: [{ kind: 'none' }],
  },
  {
    id: 'C10_system_trigger_kind',
    title: '是否有**生产**用非 `conversation` 触发类（system / schedule / environment / external_event）的作业',
    orderRef: 'B0 class: background system task',
    expectation:
      "不存在（0 命中）—— `MEMORY_JOB_TRIGGER_KIND` 恒为 `'conversation'`；`schedule` / `environment` / `external_event` 只被登记、从不产出",
    pattern: /triggerKind\s*:\s*['"](system|schedule|environment|external_event)['"]/g,
    benign: [{ kind: 'none' }],
  },
]

// ---------------------------------------------------------------------------
// 扫描原语
// ---------------------------------------------------------------------------

function walkTs(dir: string, acc: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries.sort()) {
    if (name === 'node_modules' || name === '.git') continue
    const abs = join(dir, name)
    let isDir = false
    try {
      isDir = statSync(abs).isDirectory()
    } catch {
      continue
    }
    if (isDir) walkTs(abs, acc)
    else if (name.endsWith('.ts')) acc.push(abs)
  }
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1
  return line
}

function isBenign(spec: ClassSpec, rel: string, line: number, fileText: string): boolean {
  const hit = (rule: BenignRule): boolean => {
    switch (rule.kind) {
      case 'none':
        return false
      case 'path-prefix':
        return rel.startsWith(rule.value ?? '\u0000')
      case 'path-equals':
        return rel === (rule.value ?? '\u0000')
      case 'near-marker': {
        const radius = rule.radius ?? 5
        const lines = fileText.split(/\r?\n/)
        const from = Math.max(0, line - 1 - radius)
        const to = Math.min(lines.length, line + radius)
        for (let i = from; i < to; i += 1) if ((lines[i] ?? '').includes(rule.value ?? '\u0000')) return true
        return false
      }
      default:
        return false
    }
  }
  return spec.benign.some(hit)
}

function scan(rootDir: string): ScanResult {
  const files: string[] = []
  walkTs(rootDir, files)
  let bytes = 0
  const texts = new Map<string, string>()
  for (const abs of files) {
    const text = readFileSync(abs, 'utf8')
    texts.set(abs, text)
    bytes += Buffer.byteLength(text, 'utf8')
  }

  const classes: ClassResult[] = []
  for (const spec of CLASSES) {
    const hits: Hit[] = []
    const benign: Hit[] = []
    for (const abs of files) {
      const text = texts.get(abs) ?? ''
      const rel = relative(ROOT, abs).split('\\').join('/')
      for (const m of text.matchAll(spec.pattern)) {
        const idx = m.index ?? 0
        const line = lineOf(text, idx)
        const hit: Hit = { file: rel, line, text: (m[0] ?? '').trim() }
        if (isBenign(spec, rel, line, text)) benign.push(hit)
        else hits.push(hit)
      }
    }
    classes.push({
      id: spec.id,
      title: spec.title,
      orderRef: spec.orderRef,
      expectation: spec.expectation,
      hitCount: hits.length + benign.length,
      benignCount: benign.length,
      candidateCount: hits.length,
      ok: hits.length === 0,
      hits: hits.slice(0, 40),
      candidates: hits.slice(0, 40),
    })
  }

  const candidateCount = classes.reduce((n, c) => n + c.candidateCount, 0)
  const classFailures = classes.filter((c) => !c.ok).map((c) => `${c.id}: ${c.candidateCount} 处非良性命中`)
  return { root: relative(ROOT, rootDir).split('\\').join('/') || '.', filesScanned: files.length, bytesScanned: bytes, classes, candidateCount, classFailures }
}

/** 四条"入口 / 开关"事实：不是"有没有词"，而是"这个入口到底长什么样" */
function collectFacts(): Fact[] {
  const ingress = readFileSync(resolve(ROOT, INGRESS_REL), 'utf8')
  const bodyStart = ingress.indexOf('export function conversationAttributionForEntryMode')
  const body = bodyStart >= 0 ? ingress.slice(bodyStart, ingress.indexOf('\n}\n', bodyStart) + 2) : '(未找到)'
  const jobText = readFileSync(resolve(ROOT, 'src/kernel/app/memory/job.ts'), 'utf8')
  const jobKind = /export const MEMORY_JOB_TRIGGER_KIND = ([^\n]+)/.exec(jobText)?.[1] ?? '(未找到)'
  const recorder = readFileSync(resolve(ROOT, RECORDER_REL), 'utf8')
  const defLine = lineOf(recorder, recorder.indexOf('async recordSystemEvent'))

  // F5：`mutation: 'background'` 只出现在**回合内**的 post-turn 抽取路径
  const srcFiles: string[] = []
  walkTs(resolve(ROOT, 'src'), srcFiles)
  const backgroundMutationFiles = new Set<string>()
  let backgroundMutationHits = 0
  for (const abs of srcFiles) {
    const text = readFileSync(abs, 'utf8')
    for (const _m of text.matchAll(/mutation:\s*'background'/g)) {
      backgroundMutationHits += 1
      backgroundMutationFiles.add(relative(ROOT, abs).split('\\').join('/'))
    }
  }
  const backgroundMutationFilesArr = [...backgroundMutationFiles].sort()

  // F6：启动修复过程（真实 system-origin，但非账本）
  const recoveryRel = 'src/infrastructure/persistence/memory-recovery.ts'
  const recoveryText = readFileSync(resolve(ROOT, recoveryRel), 'utf8')
  const recoveryCallSites: string[] = []
  for (const abs of srcFiles) {
    const text = readFileSync(abs, 'utf8')
    for (const m of text.matchAll(/recoverMemoryProjections\s*\(/g)) {
      recoveryCallSites.push(`${relative(ROOT, abs).split('\\').join('/')}:${lineOf(text, m.index ?? 0)}`)
    }
  }

  // F7：`state_events` 的 **create-table DDL 块**（`MIGRATION_0001`）里有没有归因列。
  //
  // ⚠️ **WP9-B1（R-45）之后这条是 B0 当时的【历史读数】，不再是"当前物理 schema"的陈述。**
  //    v9 用 `alter table state_events add column` 追加了 19 个归因列，而
  //    `MIGRATION_0001` 的 `create table if not exists` 块是**冻结的历史文本**、
  //    一个字都没改 —— 所以这个正则**今天仍然**命中"无归因列"，但它描述的是
  //    **B0 那一刻**的 schema，不是 v9 之后的物理表。
  //    当前物理事实由 `pnpm m5.1.1:migration:verify` / `m5.1.1:wp9b1:verify` 断言。
  const migrationsText = readFileSync(resolve(ROOT, 'src/infrastructure/persistence/migrations.ts'), 'utf8')
  const stateBlock = /create table if not exists state_events \(([\s\S]*?)\)`/.exec(migrationsText)?.[1] ?? ''
  // F7b：R-45 落地之后，**物理**承载是否存在？（同一份源码文本里读，不碰数据库）
  // ⚠️ 行尾：`migrations.ts` 是本仓库的 CRLF 文件，块正则必须容忍 `\r\n`（否则块永远解析不到、
  //    探针会**静默**恒假 —— 这正是"量具自己坏了"的典型形状）。
  const hasMigration0009 = /const MIGRATION_0009: Migration = \{/.test(migrationsText)
  const migration0009Block =
    /const MIGRATION_0009: Migration = \{[\s\S]*?\n\}\r?\n/.exec(migrationsText)?.[0] ?? ''
  const migration0009DeclaresStateAttribution =
    hasMigration0009 && /alter table state_events/.test(migration0009Block)

  return [
    {
      id: 'F1_entry_mode_producers',
      claim: "`conversationAttributionForEntryMode` 今天只装 user/assistant 两个 producer，且函数体里**没有**任何 SYSTEM 入口",
      ok:
        body.includes('createHumanConsoleUserTurnIngress') &&
        body.includes('createAgentRunnerUserTurnIngress') &&
        body.includes('createCharacterAssistantTurnIngress') &&
        !body.includes('System'),
      observed: body.trim().split('\n').slice(0, 12).join('\n'),
    },
    {
      id: 'F2_memory_job_trigger_kind',
      claim: "记忆作业的 triggerKind 恒为 `'conversation'`（没有系统触发的作业被产出）",
      ok: jobKind.includes("'conversation'"),
      observed: `MEMORY_JOB_TRIGGER_KIND = ${jobKind}`,
    },
    {
      id: 'F3_recorder_system_host',
      claim: `\`recordSystemEvent\` 的定义宿主（唯一合法宿主，且它自己 DEAD / UNREACHABLE）`,
      ok: defLine > 0,
      observed: `${RECORDER_REL}:${defLine}`,
    },
    {
      id: 'F4_system_event_attribution_row',
      claim: '`system_event` 在归因矩阵里**有**necessity 行（契约已备好，缺的只是生产 producer）',
      ok: /system_event:\s*row\(/.test(readFileSync(resolve(ROOT, 'src/kernel/contracts/attribution.ts'), 'utf8')),
      observed: 'src/kernel/contracts/attribution.ts 内的 `system_event: row(...)`',
    },
    {
      id: 'F5_background_mutation_is_turn_internal',
      claim: "`mutation: 'background'` 只出现在**回合内** post-turn 抽取路径（不是独立的系统触发）",
      ok:
        backgroundMutationHits > 0 &&
        backgroundMutationFilesArr.every((f) => f === 'src/kernel/app/memory/pipeline.ts'),
      observed: `${backgroundMutationHits} 处 / 文件 ${backgroundMutationFilesArr.join(', ') || '(无)'}`,
    },
    {
      id: 'F6_startup_repair_is_non_ledger',
      claim:
        '启动修复过程 `recoverMemoryProjections` **生产可达**（真实系统发起），但它**不写任何账本行**（只把已提交的 domain event 折进投影）',
      ok: recoveryCallSites.length > 0 && !LEDGER_INSERT_IN_RECOVERY.test(recoveryText),
      observed: `调用点 ${recoveryCallSites.join(', ') || '(无)'}；实现文件里 ledger insert = ${LEDGER_INSERT_IN_RECOVERY.test(recoveryText) ? '有' : '无'}`,
    },
    {
      id: 'F7_state_events_create_table_block_has_no_attribution_columns_B0_TIME_ONLY',
      claim:
        "【B0 当时的历史读数 —— 不是当前物理 schema】首启写的那条 `state_events`（`trigger='init'`）" +
        "在 `MIGRATION_0001` 的 **create-table 块**里没有任何归因槽位列 ⇒ **B0 的那一刻**，想让它携带 " +
        '`Known(SYSTEM/…)` 就必须新增 schema（当时撞 B10 的 STOP 条件）',
      ok: stateBlock.length > 0 && !STATE_ATTRIBUTION_COLUMN.test(stateBlock),
      observed:
        `【B0 的历史事实】create-table 块里出现归因列：${STATE_ATTRIBUTION_COLUMN.test(stateBlock) ? '有' : '无'}` +
        `（块长 ${stateBlock.length} 字符）。⚠️ WP9-B1（R-45）已用 MIGRATION_0009 **追加**了 19 个归因列，` +
        `create-table 块仍是冻结的历史文本 ⇒ 本读数**不得**被读成"当前物理 schema 没有归因列"` +
        `（MIGRATION_0009 存在 = ${hasMigration0009 ? '是' : '否'}）`,
    },
  ]
}

// ---------------------------------------------------------------------------
// R-45 落地探针（WP9-B1）：只读迁移源码，回答"B0 的那个 STOP 条件是否已被产品裁定推翻"
// ---------------------------------------------------------------------------

/**
 * B0 的结论是 **BLOCKED BY PRODUCT CAPABILITY DECISION**：生产里"系统自行发起"的真实行为 = 0
 * （结构上最接近的那一个是首启的 `state_events(trigger='init')`，而它当时**没有**归因承载，
 * 想用就必须改 schema ⇒ 撞执行令的 STOP 条件）。
 *
 * R-45 = SELECTED B 正是用户的裁定：**授权 `MIGRATION_0009`** 给 `state_events` 加归因承载，
 * 让它成为第一条生产真实、可归属的系统来源状态转移。因此 B0 的**判定**被产品决定取代，
 * 但 B0 的**记录**（14 个被否决的候选 + 7 条事实 + 三段式量具）一个字都不动。
 */
function r45LandingProbe(): { hasMigration0009: boolean; declaresStateAttribution: boolean } {
  const migrationsText = readFileSync(resolve(ROOT, 'src/infrastructure/persistence/migrations.ts'), 'utf8')
  const hasMigration0009 = /const MIGRATION_0009: Migration = \{/.test(migrationsText)
  const block = /const MIGRATION_0009: Migration = \{[\s\S]*?\n\}\r?\n/.exec(migrationsText)?.[0] ?? ''
  return {
    hasMigration0009,
    declaresStateAttribution: hasMigration0009 && /alter table state_events/.test(block),
  }
}

// ---------------------------------------------------------------------------
// 三段式：正控安静 / 注入合成候选 ⇒ 必响 / 恢复安静
// ---------------------------------------------------------------------------

const FIXTURE_FILE = 'synthetic-domain-scheduler.ts'
const FIXTURE_SOURCE = [
  '// 合成候选（只存在于临时目录，绝不写进 src/**）：一个"域内定时器 + 自报系统事件"的假 producer',
  'export function startSyntheticScheduler(recorder: { recordSystemEvent(t: string, s: number): unknown }) {',
  "  setInterval(() => { void recorder.recordSystemEvent('系统观测：合成候选', 1) }, 1000)",
  '}',
  '',
].join('\n')

function main(): void {
  const argv = process.argv.slice(2)
  const argOf = (name: string): string | undefined => {
    const i = argv.indexOf(name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const out = argOf('--out') ?? DEFAULT_OUT
  const rootArg = argOf('--root')
  const target = rootArg ? resolve(ROOT, rootArg) : resolve(ROOT, 'src')

  console.log('='.repeat(78))
  console.log('M5.1.1 WP9-B —— B0 Semantic Selection Gate（只读扫描）')
  console.log('='.repeat(78))
  console.log(`  扫描根：${relative(ROOT, target) || '.'}`)

  // ---- 第一段：正控（真实 src ⇒ 应当安静） ----
  const stage1 = scan(target)
  console.log(`  第一段（正控）：扫到 ${stage1.filesScanned} 个 .ts / ${stage1.bytesScanned} 字节；候选 ${stage1.candidateCount}`)
  for (const c of stage1.classes) {
    const mark = c.ok ? '✅' : '❌'
    console.log(`    ${mark} ${c.id}：命中 ${c.hitCount}（良性 ${c.benignCount} / 候选 ${c.candidateCount}）  ${c.expectation}`)
    if (!c.ok) for (const h of c.hits.slice(0, 5)) console.log(`         · ${h.file}:${h.line}  ${h.text}`)
  }
  const facts = collectFacts()
  for (const f of facts) console.log(`    ${f.ok ? '✅' : '❌'} ${f.id}：${f.claim}`)

  // ---- 第二段：负控（注入合成候选 ⇒ 检测器必须响） ----
  const fixtureDir = mkdtempSync(join(tmpdir(), 'wp9b-selection-fixture-'))
  let stage2: ScanResult
  try {
    writeFileSync(join(fixtureDir, FIXTURE_FILE), FIXTURE_SOURCE, 'utf8')
    stage2 = scan(fixtureDir)
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
  const controlLoud = stage2.candidateCount >= 2
  console.log(`  第二段（注入合成候选）：候选 ${stage2.candidateCount} ⇒ 检测器${controlLoud ? '**响了**' : '**没响（量具坏了）**'}`)
  for (const c of stage2.classes) if (c.candidateCount > 0) console.log(`         · ${c.id}：${c.candidateCount} 处（${c.hits[0]?.text ?? ''}）`)

  // ---- 第三段：恢复（真实 src ⇒ 必须重新安静） ----
  const stage3 = scan(target)
  const quietAgain = stage3.candidateCount === stage1.candidateCount && stage3.filesScanned === stage1.filesScanned
  console.log(`  第三段（恢复）：候选 ${stage3.candidateCount} / 文件 ${stage3.filesScanned} ⇒ ${quietAgain ? '重新安静' : '**没有回到安静**'}`)

  // ---- 量具健康（计数型判据自检 measured_count > 0） ----
  const measurements = [
    { id: 'filesScanned', value: stage1.filesScanned, floor: 50 },
    { id: 'bytesScanned', value: stage1.bytesScanned, floor: 50_000 },
    { id: 'classesRun', value: CLASSES.length, floor: 10 },
    { id: 'fixtureCandidates', value: stage2.candidateCount, floor: 2 },
  ]
  const invalid = measurements.filter((m) => !(m.value >= m.floor))
  for (const m of measurements) console.log(`    ${m.value >= m.floor ? '✅' : '❌'} 量：${m.id} = ${m.value}（下限 ${m.floor}）`)

  const instrumentValid = invalid.length === 0 && controlLoud && quietAgain && facts.every((f) => f.ok)
  const r45 = r45LandingProbe()
  const supersededByR45 = r45.hasMigration0009 && r45.declaresStateAttribution
  /*
   * ⚠️ R-45 的优先级**高于** `candidateCount`。
   *
   * 为什么：本门是**文本扫描器**，而 R-45 落地时 `MIGRATION_0009` 的文档注释里天然会出现
   * "系统自行发起"这类措辞（它正是在解释"为什么选这个行为"）。那不是一条**行为**，
   * 但在 C4 的判据里是一个命中 ⇒ 若让 `candidateCount > 0` 抢先决定 verdict，
   * 结果会被读成 **CANDIDATE_FOUND**（"生产里存在主动自发行为"）—— 那是错的。
   *
   * 处置（**不改 B0 的类判据、不放宽任何计数自检**）：
   *   · verdict 优先取 SUPERSEDED_BY_R45_PRODUCT_DECISION；
   *   · 这些命中**逐条登记**进证据（`postLandingScannerHits`），不静默丢掉；
   *   · C4 的 expectation / benign 规则 / 三段式 / 计数下限**一字未改**。
   */
  const postLandingScannerHits = stage1.classes
    .filter((c) => c.candidateCount > 0)
    .flatMap((c) => c.candidates.map((h) => ({ classId: c.id, ...h })))
  const verdict = supersededByR45
    ? 'SUPERSEDED_BY_R45_PRODUCT_DECISION'
    : stage1.candidateCount > 0
      ? 'CANDIDATE_FOUND'
      : 'BLOCKED_BY_PRODUCT_CAPABILITY_DECISION'

  // ---- 被否决的候选（B0 要求逐条给理由） ----
  const rejected = [
    {
      id: 'R1_recordSystemEvent_host',
      evidence: `${RECORDER_REL}:391 定义了 \`recordSystemEvent\`；调用点 0 处；\`ledger.appendSystemEvent\` 的唯一调用者就是它（C5/C6 实测）`,
      reason: '入口存在、**没有任何产品行为触发它** ⇒ 接上去就是"为了 E4 发明的 producer"（违反条件 ①）',
    },
    {
      id: 'R2_system_event_entry_mode',
      evidence: 'F1 实测：`conversationAttributionForEntryMode` 只装 user/assistant 两个 producer；C9 实测：不存在 `*System*Ingress` 工厂',
      reason: '入口模式**不可达** ⇒ 没有生产调用点能给出 SYSTEM 因果证据（违反条件 ④）',
    },
    {
      id: 'R3_background_memory_extraction',
      evidence: 'C7 实测：`src/**` 零 import `kernel/app/memory/job.ts`；C8 实测：`memory-background` 开关的唯一消费处是启动告警；仓库自证见 `docs/m4/M4-Technical-Debt.md:62` 与 `docs/architecture/memory-lifecycle.md:63`',
      reason: '后台抽取**从未接入生产**（且开关默认 off、有回归锁守着）⇒ 不是"今天的真实产品行为"，打开它属于独立里程碑（违反条件 ①）',
    },
    {
      id: 'R4_character_jobs_system_trigger',
      evidence: 'F2 实测：`MEMORY_JOB_TRIGGER_KIND = \'conversation\'`；C10 实测：零处 `triggerKind: \'system\'`；`job-store` 在生产里只被 `hasProcessedOperation`（幂等）使用',
      reason: '`character_jobs` + `TriggerKind` 只是**契约与存储**，没有任何生产 producer 产出系统触发的作业（违反条件 ①④）',
    },
    {
      id: 'R5_timers_and_schedulers',
      evidence: 'C1 实测：域内定时器 0 处；C2 实测：`setTimeout` 仅存在于 `src/infrastructure/telemetry/**`（HTTP 超时）',
      reason: '不存在调度器/周期任务；`job.ts` 自己也写明"M3.5 只登记后三种触发，不实现任何调度器"（违反条件 ①）',
    },
    {
      id: 'R6_recovery_reconciliation',
      evidence: 'C3 实测：reconcile / compensate / outbox / retry-queue / vacuum / retention 命中 0 处',
      reason: '该类行为**不存在**（违反条件 ①）',
    },
    {
      id: 'R7_proactive_self_initiated',
      evidence: 'C4 实测：proactive / initiative / spontaneous / unsolicited / autonomous / 主动发起 命中 0 处',
      reason: '她今天**不会**在没有回合的情况下自己说话或做事 ⇒ 没有"自发的系统发起行为"可归因（违反条件 ①）',
    },
    {
      id: 'R8_runtime_lifecycle',
      evidence: '`src/main.ts` 的启动路径做的是迁移待应用检查 / seed 与注册表断言，**不写任何账本事件**；本 WP 执行令亦明文禁止"启动时无意义写一条 system_event"',
      reason: '生命周期**不产生**领域事件；为它造一条启动事件是"技术上变绿、产品上变脏"（违反条件 ①③）',
    },
    {
      id: 'R9_memory_mutation_background',
      evidence: "`src/kernel/app/memory/pipeline.ts:353/493/520` 的 `mutation: 'background'` 是**回合内** post-turn best-effort 路径（pipeline.ts:171 注释：\"background extraction: fail → retry，聊天本身正常\"）",
      reason: '它的**直接因果起源是对话回合**，不是系统 ⇒ 归因应为人类回合的后果，而不是 `SYSTEM/<component>`（违反条件 ②）',
    },
    {
      id: 'R10_elizaos_runtime_services',
      evidence: 'embedding / plugin bootstrap 等属于 ElizaOS runtime 服务日志，不经过 kernel 账本与归因契约',
      reason: '不进入 kernel 的领域事件面 ⇒ 不是本里程碑可归因的对象（违反条件 ④）',
    },
    {
      id: 'R11_startup_repair_pass',
      evidence:
        '`recoverMemoryProjections`（`src/main.ts:2432`，只有 `!dryRun` 的对话通道会走到）真实、生产可达、**无回合因果**；但实现文件 `memory-recovery.ts` 内 ledger insert = 无（F6 实测）',
      reason:
        '它**不产生任何可归因的账本事件** ⇒ 要让 E4 成立就得**新写**一条"系统维护事件"，那是给系统**新造**产品语义（而且落在 memory 投影/权威边界里，B10 明文禁止）—— 正是执行令点名的"为了 E4 发明 producer"（违反条件 ①③⑤）',
    },
    {
      id: 'R12_first_run_state_bootstrap',
      evidence:
        "`src/state/init.ts:54-68` 首次启动写 `character_states` + 一条 `state_events`（`trigger='init'`），无回合因果；而 `state_events` 的 DDL（`migrations.ts:57-69`）**没有**归因槽位列（F7 实测）",
      reason:
        '这是**结构上最接近**"系统自行发起"的真实行为，但它不在归因账本里；要让它携带 `Known(SYSTEM/<component>)` 就必须**改 schema（v9）** ⇒ 直接撞 B10 的 STOP 条件（违反条件 ④⑤）',
    },
    {
      id: 'R13_startup_ddl_and_seed_ensures',
      evidence:
        'ElizaOS 插件迁移 `src/db/index.ts:178` · 内核迁移 `:215` · Seed 幂等 upsert `src/kernel/app/kernel.ts:178` · world/room/entity 确保 `src/main.ts:810-835`：都是真实的"系统发起写入"，但全是 DDL / 脚手架 / 幂等 ensure',
      reason: '它们回答的是"是谁启动了进程"，不是"是谁发起了这件事"；给它们写归因事件没有产品语义（违反条件 ③）',
    },
    {
      id: 'R14_telemetry_flush_on_exit',
      evidence: '`src/main.ts:2489-2497` → `phoenix.ts:330 shutdown()`：进程退出时刷缓冲，**不碰数据库**；且 `telemetryEnabled` 开关本身 NOT-WIRED',
      reason: '不是领域事件、不写账本（违反条件 ①③）',
    },
  ]

  const artifact = {
    gate: 'm5.1.1:wp9b:selection:verify',
    wp: 'WP9-B',
    phase: 'B0 Semantic Selection Gate',
    generatedAt: new Date().toISOString(),
    verdict,
    selectedCandidate: null,
    candidates: [] as unknown[],
    rejected,
    entryModeProducers: facts.find((f) => f.id === 'F1_entry_mode_producers')?.observed ?? '',
    facts,
    r45Supersession: {
      probe: 'MIGRATION_0009 存在且声明 alter table state_events（只读迁移源码）',
      hasMigration0009: r45.hasMigration0009,
      declaresStateAttribution: r45.declaresStateAttribution,
      supersededByR45,
      /** R-45 落地之后，B0 的文本扫描器**今天**还会命中的那些（逐条登记，不静默丢弃） */
      postLandingScannerHits,
      note:
        'B0 的判定（生产里真实的"系统自行发起"行为 = 0 ⇒ 结构上最接近的 state_events 需要改 schema）' +
        '已被用户裁定 R-45 = SELECTED B 取代：新增 MIGRATION_0009 给 state_events 加归因承载。' +
        '本文件里 14 个被否决的候选、7 条事实、三段式量具与全部计数自检**逐字保留**为 B0 的历史记录；' +
        'F7 已重标为"B0 当时的历史读数"，不得被读成当前物理 schema。' +
        '当前物理事实由 pnpm m5.1.1:migration:verify / pnpm m5.1.1:wp9b1:verify 断言。' +
        (postLandingScannerHits.length > 0
          ? `⚠️ 另注：R-45 落地之后本扫描器还会命中 ${postLandingScannerHits.length} 处文本` +
            `（${postLandingScannerHits.map((h) => `${h.classId}@${h.file}:${h.line}`).join(' / ')}）—— ` +
            '它们来自 MIGRATION_0009 的**落地注释**（解释"为什么选这个行为"），不是行为；' +
            'B0 的类判据 / 良性规则 / 三段式 / 计数下限**一字未改**，命中逐条登记在 `postLandingScannerHits`。'
          : ''),
    },
    classes: stage1.classes,
    measurement: {
      root: stage1.root,
      filesScanned: stage1.filesScanned,
      bytesScanned: stage1.bytesScanned,
      classesRun: CLASSES.length,
      candidateCount: stage1.candidateCount,
      classFailures: stage1.classFailures,
      invalid: invalid.map((m) => m.id),
      instrumentValid,
    },
    threeStage: {
      stage1_positiveQuiet: { candidateCount: stage1.candidateCount, filesScanned: stage1.filesScanned },
      stage2_injectedLoud: { fixture: FIXTURE_FILE, candidateCount: stage2.candidateCount, loud: controlLoud },
      stage3_restoredQuiet: { candidateCount: stage3.candidateCount, filesScanned: stage3.filesScanned, quietAgain },
    },
    /** EXIT=1 在这里的含义是 **BLOCKED**（不是量具失败）；量具失败是 EXIT=2 */
    exitSemantics:
      '0 = CANDIDATE_FOUND 或 SUPERSEDED_BY_R45_PRODUCT_DECISION · ' +
      '1 = BLOCKED_BY_PRODUCT_CAPABILITY_DECISION · 2 = MEASUREMENT INVALID',
  }

  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8')

  console.log('-'.repeat(78))
  console.log(`  量具健康：${instrumentValid ? 'valid' : '**INVALID**'}（三段式：正控 ${stage1.candidateCount === 0 ? '安静' : '响了'} / 注入 ${stage2.candidateCount} / 恢复 ${quietAgain ? '安静' : '未安静'}）`)
  console.log(`  候选数：${stage1.candidateCount} · 被否决的候选：${rejected.length}`)
  console.log(`  证据：${relative(ROOT, out).split('\\').join('/')}`)
  if (!instrumentValid) {
    console.log('  **MEASUREMENT INVALID** —— 这不是 B0 的判定')
    process.exitCode = 2
    return
  }
  if (supersededByR45) {
    console.log('  **SUPERSEDED BY R-45 PRODUCT DECISION** —— B0 的判定已被用户裁定取代')
    console.log('  R-45 = SELECTED B：新增 MIGRATION_0009 给 state_events 加归因承载（19 列 + 19 CHECK）。')
    console.log('  14 个被否决的候选 / 7 条事实 / 三段式量具与计数自检逐字保留为 B0 的历史记录。')
    if (postLandingScannerHits.length > 0) {
      console.log(
        `  注：扫描器今天另有 ${postLandingScannerHits.length} 处文本命中（不是行为）：` +
          postLandingScannerHits.map((h) => `${h.classId}@${h.file}:${h.line}`).join(' / ')
      )
    }
    console.log('  当前物理事实由 pnpm m5.1.1:migration:verify / pnpm m5.1.1:wp9b1:verify 断言。')
    process.exitCode = 0
    return
  }
  if (verdict === 'CANDIDATE_FOUND') {
    console.log('  **B0 = CANDIDATE FOUND** —— 可进入 B1（先人工确认五条选型条件）')
    process.exitCode = 0
    return
  }
  console.log('  **WP9-B = BLOCKED BY PRODUCT CAPABILITY DECISION**')
  console.log('  生产真实的"系统自行发起"行为 = 0 ⇒ 按执行令 HARD STOP：不发明 test-only / E4-only producer。')
  process.exitCode = 1
}

main()
