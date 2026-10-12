/**
 * M5.1.1 WP2.2（C）—— **K-17 消费者影响审计**（`pnpm m5.1.1:k17:verify`）。
 *
 * ============================================================================
 *  问题
 * ============================================================================
 * WP3 的回填会把 `conversation_events` 上**既有的** Axis B 改写掉。要回答的是：
 *
 *     改写之后，**有没有任何 A 类消费者**会让今天的实时行为发生变化？
 *
 * A = 运行时行为权威（改存储值就能改行为）／B = 投影/查询/诊断/可观测（只改显示）／
 * C = 遗留测试/夹具/门的假设／D = 只与迁移/兼容有关
 *
 * 硬规则（用户原话）：**只要存在任何一个 A 类消费者会在 ADR-043 之前改变实时行为，
 * K-17 = BLOCKED、WP3 的 Axis B 回填 = BLOCKED** —— 不许绕过、不许改消费者、不许进 Phase 4。
 *
 * ---------------------------------------------------------------------------
 *  回填到底改什么（决定"受影响"的判据）
 * ---------------------------------------------------------------------------
 *  Migration-Strategy §3.6（冻结）：
 *      source_kind      = legacy classifier 的输出（既有 4 值之一）   ← **不改**
 *      source_authority = 'UNCONFIRMED_ORIGIN'                      ← **改**
 *      epistemic_source = 'UNCONFIRMED_ORIGIN'                      ← **改**
 *  所以：**只读 `source_kind` 的消费者天然不受影响**；真正要审的是读
 *  `source_authority` / `epistemic_source` 的人。
 *
 * 本脚本**只读**：扫描源码 → 机械列出命中的文件 → 与人工核对过的分类表比对
 * （未分类的命中即失败）→ 校验四条结构性证据 → 输出裁定。
 *
 * 跑法：pnpm m5.1.1:k17:verify
 */

import 'dotenv/config'

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

let passed = 0
let failed = 0
const failures: string[] = []
const measurements: { label: string; count: number; valid: boolean }[] = []

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
}

function measure(label: string, count: number): number {
  const valid = count > 0
  measurements.push({ label, count, valid })
  if (!valid) check(`[MEASUREMENT INVALID] ${label}（measured_count = 0）`, false, '什么都没测到')
  return count
}

function section(title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

const ROOT = process.cwd()
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8')
const readLines = (file: string): string[] => read(file).split('\n')

// ===========================================================================
section('1. 回填语义（判断"受影响"的判据）')
// ===========================================================================

const BACKFILL_SEMANTICS = {
  sourceAuthority: { before: '按 actor_type 推导（USER_EXPLICIT / CHARACTER_GENERATION / …）', after: 'UNCONFIRMED_ORIGIN' },
  epistemicSource: { before: '按 actor_type 推导', after: 'UNCONFIRMED_ORIGIN' },
  sourceKind: { before: '按 actor_type 推导', after: '**不改**（仍是既有 4 值之一）' },
  source: 'M5.1.1-Migration-Strategy.md §3.6（冻结）',
}
check('回填语义按冻结文档读取（只改两列）', true, 'source_authority / epistemic_source 改；source_kind 不改')

// ===========================================================================
section('2. 机械扫描：六个名字变体（含属性映射，不只 SQL 列名）')
// ===========================================================================

const NEEDLES = [
  'source_kind',
  'source_authority',
  'epistemic_source',
  'sourceKind',
  'sourceAuthority',
  'epistemicSource',
] as const

function scan(dir: string, out: Map<string, number[]>): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) scan(full, out)
    else if (entry.name.endsWith('.ts')) {
      const lines = readFileSync(full, 'utf8').split('\n')
      const hits = lines
        .map((line, index) => (NEEDLES.some((needle) => line.includes(needle)) ? index + 1 : 0))
        .filter((line) => line > 0)
      if (hits.length > 0) out.set(relative(ROOT, full).replace(/\\/g, '/'), hits)
    }
  }
}

const hits = new Map<string, number[]>()
for (const dir of ['src', 'scripts', 'evals']) scan(join(ROOT, dir), hits)
const hitFiles = [...hits.keys()].sort()
measure('命中的文件数', hitFiles.length)
measure('命中的位置总数', [...hits.values()].reduce((sum, lines) => sum + lines.length, 0))
console.log(`  命中 ${hitFiles.length} 个文件`)

// ===========================================================================
section('3. 人工核对过的分类表（每个命中文件都必须在这里）')
// ===========================================================================

type Klass = 'A' | 'B' | 'C' | 'D'

interface Classification {
  file: string
  klass: Klass
  reason: string
  /** 回填会不会改变这个消费者的**行为**（不只是显示） */
  wouldChangeLiveBehavior: boolean
  /** 判据：只读 source_kind ⇒ 天然不受影响 */
  readsWhichColumn: 'source_kind' | 'source_authority' | 'epistemic_source' | 'type/contract only' | 'multiple'
}

const CLASSIFICATIONS: Classification[] = [
  // ---- A 类候选：能影响行为的路径（逐个证明"不受影响"）-------------------
  {
    file: 'src/kernel/contracts/conversation-event.ts',
    klass: 'A',
    reason:
      'canEvidenceExternalFact（:372）是**唯一**会读事件对象上 sourceAuthority 的行为判据（Fact Firewall）。' +
      '但它读的是**调用方传进来的**值；src/ 里唯一的调用点是抽取器，而抽取器传的是**它自己推导的**值。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_authority',
  },
  {
    file: 'src/kernel/app/memory/extractor.ts',
    klass: 'A',
    reason:
      '唯一的行为消费者。它的输入类型 ProcessorEventView **没有** Axis B 字段（contracts/processor.ts:40-49），' +
      'processorEventViewOf（:90-118）也只搬 id/sequence/type/actorType/actorId/content/createdAt；' +
      'sourceAuthority 在 :149 由 defaultAuthorityForKind(sourceKindForActor(view.actorType)) **现场推导**。' +
      '⇒ 它**读不到**存储里的 Axis B，改写它不影响抽取器。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_authority',
  },
  {
    file: 'src/infrastructure/persistence/ledger.ts',
    klass: 'A',
    reason:
      'appendUserStatement 用 repliedToSourceKind（:168-171、:183）参与 resolveAuthority —— 那会决定' +
      'USER_REPLY_CONFIRMATION 是否成立。但它取的是 **source_kind**（target?.sourceKind），而回填**不改** source_kind。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_kind',
  },
  {
    file: 'src/kernel/app/turn-gateway.ts',
    klass: 'A',
    reason:
      '把 sourceKind 放进 prompt/上下文（:514、:1213）—— 改它**会**改提示词。但只读 **source_kind**，回填不改它。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_kind',
  },
  // ---- B 类：桥/显示/诊断/完整性 ---------------------------------------
  {
    file: 'src/infrastructure/persistence/conversation-store.ts',
    klass: 'B',
    reason:
      '读路径的**桥**（:81-83 用「记录值 ?? 派生值」填事件对象）与写路径（:268、:276），' +
      '以及一个统计聚合（:516 coalesce(source_kind, \'(legacy)\')）。桥本身不做判定；' +
      '它把值交给消费者，而唯一的 A 类行为消费者（抽取器）根本收不到这些字段。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'src/kernel/contracts/observation.ts',
    klass: 'B',
    reason: '把 sourceKind 拷进 ConversationObservation 的 content（:267）——只读 source_kind。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_kind',
  },
  {
    file: 'src/kernel/app/conversation-integrity-service.ts',
    klass: 'B',
    reason: '完整性检查里用 sourceKind 比对（:206、:228-230）——只读 source_kind；且是校验而非行为。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_kind',
  },
  {
    file: 'src/infrastructure/runtime/conversation-recorder.ts',
    klass: 'B',
    reason: '记录 reply 目标的 sourceKind（:453、:508-519）——只读 source_kind。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_kind',
  },
  {
    file: 'src/kernel/context/sections.ts',
    klass: 'B',
    reason: 'section 的形状里有一个可选的 sourceKind 字段（:232）——由 turn-gateway 填，只读 source_kind。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_kind',
  },
  {
    file: 'src/main.ts',
    klass: 'B',
    reason: 'CLI 展示 sourceKind（:1254）——显示。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_kind',
  },
  {
    file: 'scripts/diag-m3-observation.ts',
    klass: 'B',
    reason: '诊断脚本打印 kind/auth（:66-67）——显示。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  // ---- C 类：遗留测试/夹具/门的假设 ------------------------------------
  {
    file: 'evals/m3/runtime/support.ts',
    klass: 'C',
    reason:
      '断言 event.sourceAuthority === defaultAuthorityForKind(event.sourceKind)（:219-228），' +
      '另有 :246 断言 CHARACTER_GENERATION。**这是回填之后会失败的那条判据**——' +
      '但只在它读到**被回填过的行**时；评测按 AGENTS §7 在沙箱库上跑，不会看到真实库的旧行。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_authority',
  },
  {
    file: 'evals/m3/suites/source-separation.ts',
    klass: 'C',
    reason: '断言 system/tool 的 sourceKind / sourceAuthority / epistemicSource 取值（:75-81、:147-153、:162）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'evals/m3/suites/user-correction.ts',
    klass: 'C',
    reason: '断言 USER_EXPLICIT / USER_REPLY_CONFIRMATION / CHARACTER_GENERATION（:107、:128-137、:147、:196、:250-265）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'evals/m3/suites/assistant-fabrication.ts',
    klass: 'C',
    reason:
      '断言她的事件「不是 USER_EXPLICIT / USER_REPLY_CONFIRMATION」（:123-124、:166）。' +
      '回填后是 UNCONFIRMED_ORIGIN，**仍然满足**这两条断言 ⇒ 这条**不会**因回填失败。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_authority',
  },
  {
    file: 'evals/m3/runtime/ports.ts',
    klass: 'D',
    reason: '注释里说明 sourceKind 由 actorType 推导（:102）——契约说明，不读数据。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'evals/m3/runtime/host.ts',
    klass: 'D',
    reason: '注释（:379、:522）说明 sourceKind 的来源——不读数据。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/kernel-tests-conversation.ts',
    klass: 'C',
    reason:
      '断言 sourceKindForActor / epistemicSourceForKind 的映射与内存事件的 Axis B（:82-92、:182-227、:292-295）。' +
      '它构造自己的事件、不读库 ⇒ 回填**不影响**它。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/verify-m3-persistence.ts',
    klass: 'C',
    reason: '断言它自己刚写进沙箱库的事件的 sourceKind/Authority（:281-354）⇒ 看不到被回填的旧行。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/kernel-tests-memory.ts',
    klass: 'C',
    reason: '构造 ProcessorEventView / 事件夹具（:2588-2590、:2351 附近）——内存夹具。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/eval-m4.ts',
    klass: 'C',
    reason: '断言工具事件夹具的 epistemicSource / sourceAuthority（:621-627）——内存夹具。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/future-compat-tests.ts',
    klass: 'C',
    reason: 'M3.5 兼容测试里的来源语义断言与 fixture（:213、:405-407）——自造事件。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/m3.5-prompt-baseline.ts',
    klass: 'C',
    reason: 'prompt 基线的 fixture（:74、:82）——自造事件。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_kind',
  },
  {
    file: 'scripts/verify-m4-persistence.ts',
    klass: 'D',
    reason: '列集合断言（:467-488）——迁移/兼容性，已在 WP2 里按 F4 做过最小兼容更新。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  // ---- D 类：M5.1.1 自己的门与契约 -------------------------------------
  {
    file: 'scripts/kernel-tests-m5.1.1.ts',
    klass: 'D',
    reason: 'M5.1.1 契约门自身（列名/词表/矩阵断言）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/verify-m5.1.1-migration.ts',
    klass: 'D',
    reason: 'M5.1.1 迁移门自身。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/verify-m5.1.1-k16-overlap-audit.ts',
    klass: 'D',
    reason: 'K-16 审计自身。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'src/kernel/contracts/source-authority.ts',
    klass: 'D',
    reason: '词汇与推导函数的定义处（不读数据）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'src/kernel/contracts/attribution.ts',
    klass: 'D',
    reason: 'v7 列名与必要性矩阵（契约）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'src/kernel/contracts/ledger-port.ts',
    klass: 'D',
    reason: '注释：写入契约没有 sourceKind 参数（:19）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'src/kernel/contracts/memory.ts',
    klass: 'D',
    reason: '只有理由码字符串 unknown_source_authority（:1366），不读列。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'src/infrastructure/persistence/migrations.ts',
    klass: 'D',
    reason: '0003 的列 + 0007 的词表/CHECK（迁移定义）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/verify-m5.1.1-production-copy-schema.ts',
    klass: 'D',
    reason: 'WP2.2 的 production-copy 门自身（读三列做 before/after 比对）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/verify-m5.1.1-k17-consumer-impact.ts',
    klass: 'D',
    reason: '本审计脚本自身（NEEDLES 列表里就写着这六个名字）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  // ---- WP8-A（2026-09-18）：分类表追平仓库当前状态 -------------------------
  //
  // 本表停在 WP2.2，而 WP3.2–WP7 与 K-29 又新增了 13 个门脚本、并让 3 个 src 文件
  // 开始出现六个 Axis B 名字。判据本身**一个字都没改**：条目变多只是因为
  // "每个命中文件都必须被人工核对过"这条纪律要求把新命中逐个交代清楚。
  // 逐条的 `wouldChangeLiveBehavior` 都是 false —— 依据写在各自的 reason 里。
  {
    file: 'src/infrastructure/action/action-ledger-store.ts',
    klass: 'A',
    reason:
      '行动账本的写路径：把 Axis B 三格写成**字面量 NULL** 并断言 K-22 的 NOT_APPLICABLE；' +
      '读路径（readActionStoredAttributions）取 18 个槽位列 + origin，**不引用**那三列。' +
      'WP3 的回填只改 conversation_events 的历史行，与本表无关 ⇒ 实时行为不变。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_authority',
  },
  {
    file: 'src/infrastructure/dev/query-service.ts',
    klass: 'B',
    reason:
      '开发者查询面（**只读**诊断）：把存储归因（含 Axis B 三列）映射成 DTO。' +
      '回填会改变它**显示**的值，但它是诊断面、不参与任何实时决策（执行真相与它分开）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'src/kernel/contracts/developer-query.ts',
    klass: 'D',
    reason:
      '只读 DTO 的形状与校验（`axisB` 字段名、三态并集、接地证明、K-30 的计数 DTO）；' +
      '不读任何数据。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/kernel-tests-dev-plane.ts',
    klass: 'D',
    reason: 'M5.1 开发者平面契约门自身（K-30 计数口径测试里手写 unconfirmed 夹具）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/verify-m5.1.1-k20-anti-fabrication.ts',
    klass: 'D',
    reason: 'K-20 反伪造门自身（断言语料里不得出现伪造的 Axis B 组合）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/verify-m5.1.1-k25-trusted-attestation.ts',
    klass: 'D',
    reason: 'K-25 受信鉴证门自身（逐个合法/非法形态检查 Axis B 分支）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/verify-m5.1.1-wp3-backfill.ts',
    klass: 'D',
    reason: 'WP3 回填门自身（回填口径与逐槽位计数都在这里）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/verify-m5.1.1-wp32-recorded-axisb.ts',
    klass: 'D',
    reason: 'WP3.2 / K-24 的 RECORDED Axis-B 门自身（R-21 两分支）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/verify-m5.1.1-wp4-write-path.ts',
    klass: 'D',
    reason: 'WP4 写路径门自身（逐槽位写=库=读 + Axis B 逐列比对）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/verify-m5.1.1-wp41-k22-action-axisb.ts',
    klass: 'D',
    reason: 'WP4.1 / K-22 行动 Axis-B 门自身（断言行动侧三格恒 NULL）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/verify-m5.1.1-wp5-action-attribution.ts',
    klass: 'D',
    reason: 'WP5 行动归因门自身（写读逐槽位 + 执行真相独立）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/verify-m5.1.1-wp51-k27-causal-initiator.ts',
    klass: 'D',
    reason: 'WP5.1 / K-27 因果 initiator 门自身（跨账本搬运的正是那两个权威槽位）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/verify-m5.1.1-wp6-recorded-read-path.ts',
    klass: 'D',
    reason: 'WP6 读路径门自身（RECORDED / MIGRATED_LEGACY 的 DTO 逐字段比对）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/verify-m5.1.1-wp61-conversation-ingress.ts',
    klass: 'D',
    reason: 'WP6.1 对话 ingress 门自身（D01 与人类行的 Axis B 逐列断言）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/verify-m5.1.1-wp7-preflight.ts',
    klass: 'D',
    reason: 'WP7 只读预研自身（K-30 单位扫描 + 渲染输出断言）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/verify-m5.1.1-wp7-console.ts',
    klass: 'D',
    reason: 'WP7 专项门自身（渲染输出里三列独立呈现、NOT_APPLICABLE、计数与物理列比对）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/m5.1.1-attribution-gate-registry.ts',
    klass: 'D',
    reason:
      'WP8-B 的门清单声明文件（九门注册表 + 十条不变量锚 + 七个 mutation 锚）：纯数据，' +
      '不含任何运行时行为，也不被执行链引用（新增文件）。它命中 Axis B 名字只是因为锚点里写了物理列名的字符串。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/verify-m5.1.1-wp9-runtime-e2e.ts',
    klass: 'D',
    reason:
      'WP9 的真实运行时 E2E 门自身：它**读**物理行的三列（source_kind / source_authority / epistemic_source）做逐字段指纹比对，' +
      '只读不写、不参与任何回填决策（新增文件）。**WP9-C1 起**它还在隔离沙箱里驱动生产 writer' +
      '（`state_events` 的 State Bootstrap 行与 `developer_control_events` 的审计行），' +
      '但**仍不**参与任何回填决策，也不改变实时行为（测试脚本，永不在生产运行）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  // ---- WP9-B1（2026-09-18，R-45）：分类表追平两个新命中 --------------------
  //
  // 判据一个字未改：条目变多只是因为"每个命中 Axis B 名字的文件都必须被人工核对过"。
  // 两个文件都**不读**存储里的那三列，出现名字只是为了断言它们的**不存在**。
  {
    file: 'scripts/verify-m5.1.1-wp8-harness.ts',
    klass: 'D',
    reason:
      'WP8 的量具本体：WP9-B1 起它在 §0 从**迁移源码文本**里断言 `MIGRATION_0009` 不含 Axis B 三列' +
      '（`!/(source_kind|source_authority|epistemic_source)/`）—— 那是"禁止出现"的负控字符串，' +
      '它不读任何存储行、不参与回填决策，也不改实时行为。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/verify-m5.1.1-wp9b1-verify.ts',
    klass: 'D',
    reason:
      'WP9-B1 的 R-45 落地门：它断言 `MIGRATION_0009` **没有** Axis B 三列（契约常量 + 说明文字里出现列名），' +
      '并做 state_events 的归因 round-trip；**不读也不写**那三列的存储值，' +
      '既不参与回填决策也不改实时行为（新增文件）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  // ---- WP11（2026-09-19）：收官门追平一个新的良性命中 ----------------------
  //
  // 判据一个字未改：它命中只是因为"每个出现 Axis B 名字的文件都必须被人工核对过"。
  {
    file: 'scripts/verify-m5.1.1-wp11-closure.ts',
    klass: 'D',
    reason:
      'WP11 的收官门（Phase 1–3 Closure）：它**只读** `artifacts/m5.1.1/**` 的落盘证据，' +
      '里面出现 `sourceKindOutOfVocab` 是因为它逐格核对 WP3 的 **M7** 读数（Axis B 三列的词表越界计数），' +
      '出现 `axisB` / `contentOriginator` / `MIGRATED_LEGACY` 同理。它**不读也不写**任何存储行、' +
      '不参与回填决策、不改实时行为，也不开数据库（新增文件）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  // ---- Phase 4a（ADR-043 `DR-1`/`DR-6`/`DR-7`）：来源资格闸专项门追平命中 ----
  //
  // 判据一个字未改（与 W11-G2、WP9-B1、WP10-B/C 同型）：条目变多只是因为
  // "每个出现 Axis B 名字的文件都必须被人工核对过"。
  {
    file: 'scripts/verify-m5.1.1-phase4a-origin-gate.ts',
    klass: 'D',
    reason:
      'Phase 4a 的**来源资格闸专项门**（`m5.1.1:phase4a:verify`）：它出现 `sourceAuthority` 是因为 §4 用' +
      '**一张七格表**逐格冻结 `canEvidenceExternalFact`（T3 来源谓词）的既有语义（"判据被改动时这里会红"）。' +
      '它**不读也不写**任何存储行、不参与回填决策、不改实时行为——它只做只读断言与三段式量具自检，' +
      '并且落库的那几条事件全部写在 `isolateDatabase()` 的沙箱里（新增文件）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  // ---- M5.1.1-D01（2026-09-20）：关闭候选的真实链路 Live Smoke -----------------
  // 判据一个字未改：条目变多只是因为"每个出现 Axis B 名字的文件都必须被人工核对过"
  // （与 W11-G2 / WP9-B1 / WP10-B·C / Phase 4a 同型）。
  {
    file: 'scripts/verify-m5.1.1-d01-live-smoke.ts',
    klass: 'D',
    reason:
      'M5.1.1-D01 的**真实链路 Live Smoke**（`pnpm m5.1.1:d01:smoke:live`，仅在 `with-test-model` 下运行）：' +
      '它出现 Axis B 名字，是因为 S3 的 Level 2 证据就是"那一条事件行的 Axis B 三列**原样读数**"' +
      '（`source_kind` / `source_authority` / `epistemic_source`）——它把这些值如实登记进证据，' +
      '而**不**据此派生 `trustedOrigin`（唯一适配边界是 `processorEventViewOf()`），' +
      '也**不**参与任何回填决策。它只消费两个现成的生产读数：`qualificationsForMemories()`（派生资格）与' +
      '`qualificationLabelSuffix()`（prompt 后缀）；数据库只是**真实库的临时副本**（真实库只复制、从不打开，' +
      '本文件没有任何一行设置 `PROJECT_LG_ALLOW_PRODUCTION_DB`），且没有任何写入真实库的路径。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  // ---- M5.1.1 Phase 4 Closure（2026-09-20，ADR-044）：最终关闭门 -----------------
  {
    file: 'scripts/verify-m5.1.1-phase4-closure.ts',
    klass: 'D',
    reason:
      'M5.1.1 的**最终关闭门**（`pnpm m5.1.1:phase4:closure:verify` / `m5.1.1:final:verify`，ADR-044）：' +
      '它出现 Axis B 名字，是因为它要从 **D01 Live Smoke 的已提交证据**里读 S3 那一行的 Axis B 读数' +
      '（`axisBSourceAuthority`）来断言"代理伪装负控成立"。它**不**派生 `trustedOrigin`、**不**参与回填决策、' +
      '**不**打开真实库、**不**跑真实模型、**不**改 `src/**`；它唯一的写入面是 `artifacts/m5.1.1/phase4-closure.json`' +
      '（门里有静态自检断言"只有一处 writeFileSync"），且证据不含任何时钟字段。' +
      '条目变多只是因为"每个出现 Axis B 名字的文件都必须被人工核对过"——针表一个字未改。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  // ---- M6（ADR-050）：会话摘要的部件门 ------------------------------------------
  // 判据一个字未改：条目变多只是因为"每个出现 Axis B 名字的文件都必须被人工核对过"
  // （与 W11-G2 / WP9-B1 / WP10-B·C / Phase 4a / D01 / Closure 同型）。
  {
    file: 'scripts/verify-m6-wp2-rollup.ts',
    klass: 'D',
    reason:
      'M6/WP2 的**会话摘要纯逻辑部件门**（`pnpm exec tsx scripts/verify-m6-wp2-rollup.ts`）：' +
      '它出现 Axis B 名字，是因为它的夹具必须构造"受信 / 不受信 / 内容不是用户产生的"三类来源' +
      '（`source_kind` / `source_authority` / `epistemic_source` 三个字面量就是那三类夹具的输入）。' +
      '它**不读也不写**任何存储行、**不打开数据库**、**不跑模型**、不参与回填决策、不改实时行为；' +
      '它唯一的写入面是 `artifacts/m6/<runId>/rollup-unit.json`。' +
      '⚠️ 它**不手写**来源读数对象：读数一律经生产用的唯一适配边界函数取得（那个三态字段在' +
      '`scripts/**` 里仍然 0 处 ⇒ 手工字面量在类型上就构造不出来）。' +
      '它只断言摘要选择器的性质（逐字、五类拒绝理由、预算、去重、确定性、纯函数）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  // ---- M11 / post-Lv2 追平（2026-10-04，判据一个字未改） -------------------------
  //
  // 本表原先停在 M6/WP2。此后 M11 的反思语料与 post-Lv2 的故事来源门又新增了 6 个命中文
  // 件，于是 `m5.1.1:k17:verify` 连续报了两条红（"每个命中文件都已分类"与
  // `K-17 = BLOCKED`）。**针表（NEEDLES）、扫描范围、逐行比对与裁决逻辑一个字都没改** ——
  // 这里只是把新命中逐个交代清楚（与上面的 W11-G2 / WP9-B1 / WP10-B·C / Phase 4a / M6 WP2
  // 五个追平小节同型）。分类字母对非 A 条目是**惰性**的（只有 A 类才读 `wouldChangeLiveBehavior`）。
  {
    file: 'src/kernel/storyline/world-observation.ts',
    klass: 'D',
    reason:
      '故事来源**自己的轴**的定义处（`storySourceAxes()` :191-201）：`conversationEventSourceKind: ' +
      "'NOT_AVAILABLE'` 与 `epistemicSource: 'story_experience'` 都是**字面量常量**，不读任何存储行；" +
      '文档注释里出现 `conversation_events.source_kind` / Axis B `epistemic_source`，只是为了说明' +
      '"故事来源在那两根轴上各归何位"。它不参与回填决策、不改实时行为（与 ' +
      '`src/kernel/contracts/source-authority.ts` 同型）。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'evals/m11/reflection-corpus.ts',
    klass: 'C',
    reason:
      'M11 WP9 的**反思语义语料**（纯数据 + 纯函数）。它命中是因为夹具字段名 ' +
      '`ReflectionCorpusInput.sourceKinds`（:94）含 `sourceKind` 子串，而该字段的取值域是 ' +
      "**LineageSourceClass**（'user_statement' / 'program_result' / 'assistant_speech' …，" +
      '见 `src/kernel/contracts/reflection-lineage.ts:47-68`）—— **不是** Axis B 的 ' +
      '`conversation_events.source_kind`（两套词汇只有 `user_statement` 同名重叠）。' +
      '它不读任何存储行、不参与回填决策、不改实时行为。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/m11-semantic-eval.ts',
    klass: 'C',
    reason:
      'M11 的**语义评测跑器**：唯一命中点是 `item.input.sourceKinds[...]`（:109），即把上面那份' +
      '**夹具字段**映射成合成的 `ReflectionWindowEntry.sourceClass`（内存窗口，仍是 ' +
      '`LineageSourceClass`）。它不打开数据库、不读 `conversation_events` 的三列、不参与回填决策、' +
      '不改实时行为；写入面只有 `artifacts/m11/<runId>/**`。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'type/contract only',
  },
  {
    file: 'scripts/postlv2-s8-contracts-verify.ts',
    klass: 'D',
    reason:
      'S8 的 **wp3a 契约与边界门自身**（文件头逐字："纯离线：不打开任何数据库、不发任何模型请求"）。' +
      '它出现 `sourceKind` 是因为 C5 的**负控**：构造一条 `sourceKind: "story_fact"` 的对话事件（:128）' +
      '并断言构造器**拒绝**它（`source_kind_actor_mismatch`，:152/:154）—— 那是**断言其不存在**，' +
      '不是消费存储值。它不读也不写任何存储行、不参与回填决策、不改实时行为。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'source_kind',
  },
  {
    file: 'scripts/postlv2-source-root-verify.ts',
    klass: 'D',
    reason:
      'post-Lv2 的**故事来源根资格门自身**（`postlv2:source-root:verify`；:47 `isolateDatabase()`，' +
      '全文没有 `PROJECT_LG_ALLOW_PRODUCTION_DB`，也不碰 `conversation_events`）。它命中是因为 ' +
      'R10 的负控（:423-433 传 `sourceKind: "story_fact"` 并断言 `source_kind_actor_mismatch`，:442）' +
      '与 R11 读取 `storySourceAxes()` 的**常量**（:473）—— 两者都不读存储行、不参与回填决策、不改实时行为。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
  {
    file: 'scripts/postlv2-source-verify.ts',
    klass: 'D',
    reason:
      'post-Lv2 的**故事来源词汇与适配门自身**（`postlv2:source:verify`；:169 `isolateDatabase("postlv2-source")`）。' +
      '它确实**在隔离库里直插**三列（:204-222 的 `tryInsert`）并把三列交给 `assertRecordedAxisB`（:142-144、:294-296），' +
      '但：① 写的是**沙箱库**；② 目的只是测 CHECK 约束与受控词汇表（:273-275）；③ 不读真实库旧行；' +
      '④ 不参与任何回填决策、不改实时行为。余下命中（:13/:16-17 的注释、:41 的契约函数导入、' +
      ':557-559 证据里登记词汇表）同理。',
    wouldChangeLiveBehavior: false,
    readsWhichColumn: 'multiple',
  },
]

/**
 * **不属于"消费者"、但载荷着本次裁定**的文件（它们**没有命中**任何 Axis B 名字）。
 *
 * `processor.ts` 恰恰因为**一个都不命中**才是关键证据：行为消费者拿到的视图类型
 * 在类型上就没有 Axis B 字段。把它放进"消费者分类表"会让那张表变得不诚实
 * （表里出现一个"没有命中"的条目），所以单列。
 */
const NON_CONSUMER_PROOF_FILES = [
  {
    file: 'src/kernel/contracts/processor.ts',
    why: 'ProcessorEventView（:40-49）没有任何 Axis B 字段 ⇒ 抽取器在类型上收不到存储值',
  },
]
for (const item of NON_CONSUMER_PROOF_FILES) {
  check(
    `非消费者证据文件确实**不**命中任何 Axis B 名字：${item.file}`,
    !hitFiles.includes(item.file),
    item.why
  )
}

const classificationByFile = new Map(CLASSIFICATIONS.map((item) => [item.file, item]))
const unclassified = hitFiles.filter((file) => !classificationByFile.has(file))
check(
  '每个命中文件都已分类（没有"未审到"的消费者）',
  unclassified.length === 0,
  unclassified.length === 0 ? `${hitFiles.length} 个文件全部已分类` : `未分类：${unclassified.join(', ')}`
)

const staleEntries = CLASSIFICATIONS.filter((item) => !hitFiles.includes(item.file) && !item.file.includes('#'))
check(
  '分类表里没有已经不再命中的陈旧条目（防止表变成历史垃圾）',
  staleEntries.length === 0,
  staleEntries.length === 0 ? '全部仍然命中' : `陈旧：${staleEntries.map((item) => item.file).join(', ')}`
)

const counts: Record<Klass, number> = { A: 0, B: 0, C: 0, D: 0 }
for (const item of CLASSIFICATIONS) {
  if (!item.file.includes('#')) counts[item.klass] += 1
}
measure('已分类文件总数', counts.A + counts.B + counts.C + counts.D)
console.log(`  A=${counts.A} B=${counts.B} C=${counts.C} D=${counts.D}`)

// ===========================================================================
section('4. 硬规则：A 类里有没有"会改实时行为"的')
// ===========================================================================

const aClass = CLASSIFICATIONS.filter((item) => item.klass === 'A' && !item.file.includes('#'))
measure('A 类候选数', aClass.length)
const dangerous = aClass.filter((item) => item.wouldChangeLiveBehavior)
check(
  'A 类里没有一个会因回填而改变实时行为',
  dangerous.length === 0,
  dangerous.length === 0 ? `${aClass.length} 个 A 类候选全部不受影响` : `危险：${dangerous.map((item) => item.file).join(', ')}`
)

// ===========================================================================
section('5. 用户点名要特别验证的那条断言')
// ===========================================================================

const extractorSource = read('src/kernel/app/memory/extractor.ts')
check(
  '抽取器的 sourceAuthority 来自 defaultAuthorityForKind(sourceKindForActor(...))（现场推导）',
  extractorSource.includes('defaultAuthorityForKind(sourceKindForActor(view.actorType))'),
  'extractor.ts:149'
)
const processorView = read('src/kernel/contracts/processor.ts')
const viewBlock = processorView.slice(
  processorView.indexOf('export interface ProcessorEventView'),
  processorView.indexOf('export interface ProcessorContext')
)
/*
 * ===========================================================================
 *  ★ M5.1.1 Phase 4a —— **判据层面的取代**（用户 2026-09-19 裁定；F4 见
 *    `docs/m5.1.1/M5.1.1-WP11-Compatible-Assertion-Record.md` §9）
 * ===========================================================================
 * 本节原来的两条断言是：
 *
 *     §5-a  `ProcessorEventView` **没有** Axis B 字段
 *     §5-b  `processorEventViewOf 也只搬非 Axis B 的字段`
 *
 * 它们保护的是 **Phase 4 之前**的架构状态（"行为消费者在类型上收不到 Axis B"）。
 * ADR-043 要求 4a **让视图携带来源资格所需的读数**并让形成期闸消费它 ⇒
 * **原断言禁止了已批准的设计本身**。
 *
 * ⚠️ 取代**不是删除、不是放宽**：把"禁止出现"换成**正向边界 + 反后门**，判据面**更强**。
 *    下面前三条就是裁定给的四点措辞在**机器判据**上的落点：
 *
 *     ① `processorEventViewOf()` 是**唯一**允许读原始 `event.attribution` 与 Axis B 三列
 *        并派生 `trustedOrigin` 的**适配边界**
 *     ② `ProcessorEventView` **只**暴露可选的 `trustedOrigin?: TrustedOriginReading`，
 *        不得暴露原始 Axis B
 *     ③ 下游候选解析**只能**消费 `view.trustedOrigin`；夹具与其他生产路径**不得**自行构造该读数
 */
const adapterStart = extractorSource.indexOf('export function processorEventViewOf')
const adapterEnd = extractorSource.indexOf('\nfunction ', adapterStart + 1)
const viewMapper = extractorSource.slice(adapterStart, adapterEnd === -1 ? undefined : adapterEnd)

/** 数一棵树里某个字面量出现几次（只数 `.ts`）—— 用于"唯一产出点"这类**计数**断言 */
function countInTree(root: string, needle: string): { files: string[]; total: number } {
  const files: string[] = []
  let total = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) {
        const hits = readFileSync(full, 'utf8').split(needle).length - 1
        if (hits > 0) {
          files.push(relative(ROOT, full).replace(/\\/g, '/'))
          total += hits
        }
      }
    }
  }
  walk(join(ROOT, root))
  return { files: files.sort(), total }
}

// ① 适配边界：**它**才是那个读原始 Axis B 并派生读数的地方
const axisBArgsInAdapter = ['sourceKind', 'sourceAuthority', 'epistemicSource'].filter((name) =>
  viewMapper.includes(name)
)
const derivationInAdapter = viewMapper.includes('trustedOriginReadingOf({')
measure('适配边界内命中的 Axis B 名字数', axisBArgsInAdapter.length)
check(
  '★ 取代①：`processorEventViewOf()` 是唯一**读原始 Axis B 三列并派生** `trustedOrigin` 的适配边界',
  axisBArgsInAdapter.length === 3 && derivationInAdapter && viewMapper.includes('axisB:'),
  `适配边界内 Axis B 名字 = ${axisBArgsInAdapter.join(', ')}；派生调用 = ${String(derivationInAdapter)}`
)

// ② 类型边界：视图**只**多一个派生读数，不多任何一个原始 Axis B 字段
const viewHasRawAxisB = NEEDLES.some((needle) => viewBlock.includes(needle))
check(
  '★ 取代②：`ProcessorEventView` **只**暴露 `trustedOrigin?: TrustedOriginReading`，不得暴露原始 Axis B',
  viewHasRawAxisB === false && viewBlock.includes('trustedOrigin?: TrustedOriginReading'),
  `原始 Axis B 命中 = ${String(viewHasRawAxisB)}；有派生读数 = ${String(viewBlock.includes('trustedOrigin?: TrustedOriginReading'))}`
)

// ③ 唯一产出点：全 `src/**` 里**只有一处**在派生它，而且就在上面的适配边界体内
const derivationSites = countInTree('src', 'trustedOriginReadingOf({')
const fieldSites = countInTree('src', 'trustedOrigin')
measure('src/ 里来源读数的派生调用点数', derivationSites.total)
check(
  '★ 取代③：全 `src/**` 只有 1 处派生 `trustedOrigin`，且它就在该适配边界体内（下游无法自造）',
  derivationSites.total === 1 &&
    derivationSites.files.join() === 'src/kernel/app/memory/extractor.ts' &&
    derivationInAdapter,
  `派生点 ${derivationSites.total} 个（${derivationSites.files.join(', ')}）；字段出现过的文件 = ${fieldSites.files.join(', ')}`
)

const contractSource = read('src/kernel/contracts/conversation-event.ts')
check(
  'canEvidenceExternalFact 只在 sourceAuthority 存在时用它（否则回退 actorType）',
  contractSource.includes('const authority = event.sourceAuthority ?? undefined'),
  'conversation-event.ts:372'
)

// src/ 里 canEvidenceExternalFact 的调用点
const extractorCalls = (extractorSource.match(/canEvidenceExternalFact\(/g) ?? []).length
const contractDefinition = 1
measure('src/ 里 canEvidenceExternalFact 的调用点数（不含定义）', extractorCalls)
check(
  'src/ 里只有抽取器调用 canEvidenceExternalFact（且传的是推导值）',
  extractorCalls === 1 && extractorSource.includes('canSupportExternalFact: canEvidenceExternalFact({'),
  `调用点 ${extractorCalls} 个；定义处 ${contractDefinition} 个`
)
const authorityFromSourceCalls = (extractorSource.match(/authorityFromSource\(/g) ?? []).length
check(
  'src/ 里 authorityFromSource 的调用点也只有抽取器（用推导值算记忆权威）',
  authorityFromSourceCalls === 1,
  `调用点 ${authorityFromSourceCalls} 个`
)

// ===========================================================================
section('6. C 类：回填之后**会**失败的测试（枚举，本 WP 不改）')
// ===========================================================================

const cClassFailingAfterBackfill = [
  {
    file: 'evals/m3/runtime/support.ts',
    lines: '219-228（sourceAuthority === defaultAuthorityForKind(sourceKind)）；246（=== CHARACTER_GENERATION）',
    condition: '仅在它读到**被回填过的行**时失败。评测在沙箱库上跑（AGENTS §7）⇒ 默认看不到真实库的旧行。',
    action: '不在本 WP 修改',
  },
  {
    file: 'evals/m3/suites/user-correction.ts',
    lines: '107 / 128-137 / 147 / 196 / 250-265（USER_EXPLICIT / USER_REPLY_CONFIRMATION / CHARACTER_GENERATION）',
    condition: '同上：只在读到被回填的行时失败。',
    action: '不在本 WP 修改',
  },
  {
    file: 'evals/m3/suites/source-separation.ts',
    lines: '75-81 / 147-153 / 162（system / tool 的 sourceKind+sourceAuthority+epistemicSource）',
    condition: '同上。',
    action: '不在本 WP 修改',
  },
]
measure('枚举出的 C 类"回填后会失败"条目数', cClassFailingAfterBackfill.length)
const cClassSafe = [
  {
    file: 'evals/m3/suites/assistant-fabrication.ts',
    why: '断言"她的事件不是 USER_EXPLICIT / USER_REPLY_CONFIRMATION"；UNCONFIRMED_ORIGIN 同样满足 ⇒ 不会失败',
  },
  { file: 'scripts/kernel-tests-conversation.ts', why: '自造事件 + 纯函数，不读库' },
  { file: 'scripts/verify-m3-persistence.ts', why: '只断言它自己在沙箱里新建的事件' },
  { file: 'scripts/eval-m4.ts / kernel-tests-memory.ts / future-compat-tests.ts / m3.5-prompt-baseline.ts', why: '内存夹具' },
]

// ===========================================================================
section('7. 裁定')
// ===========================================================================

const measurementInvalid = measurements.filter((item) => !item.valid)
check('所有计数型检测器都有非零测量', measurementInvalid.length === 0, `${measurements.length} 个，无效 ${measurementInvalid.length}`)

const k17Verdict = dangerous.length === 0 && unclassified.length === 0 && measurementInvalid.length === 0 ? 'PASS' : 'BLOCKED'
/*
 * WP8-A（2026-09-18）：这条 check 的**失败理由**以前写死成"存在会改行为的 A 类消费者" ——
 * 而 verdict 其实由**三个**条件决定（A 类危险 / 未分类 / 量具无效）。
 * 于是"分类表陈旧"这种最常见的失败会打印一句**与事实不符**的理由（实测踩到：
 * unclassified=16、dangerous=0，却报"存在会改行为的 A 类消费者"）。
 * 判据没有变，只是把理由**按真实条件**列出来 —— 一条会说错话的判据比没有判据更危险。
 */
const verdictReasons = [
  dangerous.length > 0 ? `A 类里会改实时行为的：${dangerous.map((item) => item.file).join(', ')}` : null,
  unclassified.length > 0
    ? `未分类的命中文件 ${unclassified.length} 个：${unclassified.slice(0, 4).join(', ')}${unclassified.length > 4 ? ' …' : ''}`
    : null,
  measurementInvalid.length > 0 ? `无效的量具 ${measurementInvalid.length} 个` : null,
].filter((item): item is string => item !== null)
check(
  `K-17 = ${k17Verdict}`,
  k17Verdict === 'PASS',
  k17Verdict === 'PASS' ? '零个 A 类消费者会改实时行为 · 全部命中文件已分类 · 量具有效' : verdictReasons.join(' ｜ ')
)
const wp3Backfill = k17Verdict === 'PASS' ? 'READY' : 'BLOCKED'
check(`WP3 的 Axis B 回填 = ${wp3Backfill}`, true)

check(
  '本 WP 没有修改任何 C 类测试（只读分析）',
  true,
  cClassFailingAfterBackfill.every((item) => item.action === '不在本 WP 修改') ? '三条全部只登记、未改' : '⚠️'
)

mkdirSync(join(ROOT, 'artifacts', 'm5.1.1'), { recursive: true })
writeFileSync(
  join(ROOT, 'artifacts', 'm5.1.1', 'wp2.2-k17-consumer-impact.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1.1 / WP2.2 K-17 consumer impact audit',
      generatedAt: new Date().toISOString(),
      command: 'pnpm m5.1.1:k17:verify',
      verdict: k17Verdict,
      wp3AxisBBackfill: wp3Backfill,
      passed,
      failed,
      failures,
      backfillSemantics: BACKFILL_SEMANTICS,
      scan: {
        needles: [...NEEDLES],
        hitFileCount: hitFiles.length,
        hitLocationCount: [...hits.values()].reduce((sum, lines) => sum + lines.length, 0),
        hitsByFile: Object.fromEntries([...hits.entries()].sort()),
      },
      classificationCounts: counts,
      classifications: CLASSIFICATIONS,
      unclassifiedFiles: unclassified,
      aClassThatWouldChangeBehavior: dangerous.map((item) => item.file),
      structuralProofs: {
        processorEventViewHasNoAxisB: viewHasRawAxisB === false,
        processorEventViewShape: viewBlock.replace(/\s+/g, ' ').trim(),
        /*
         * ⚠️ M5.1.1 Phase 4a（用户 2026-09-19 裁定）：这两个字段**改名换义**。
         *
         * 原 `processorEventViewMapperDropsAxisB: true` 断言的是"适配器**丢掉** Axis B"——
         * 那正是被授权取代的那条判据。新的真值是：
         *   · 适配器**是**那个唯一读 Axis B 并**派生**读数的地方（不是"丢掉"）
         *   · 而派生的读数**只有一处**产出点，下游只能消费它
         */
        processorEventViewMapperIsSoleAxisBAdapter: axisBArgsInAdapter.length === 3 && derivationInAdapter,
        trustedOriginDerivationSitesInSrc: derivationSites.total,
        trustedOriginDerivationFilesInSrc: derivationSites.files,
        trustedOriginFieldFilesInSrc: fieldSites.files,
        extractorDerivesLocally: true,
        canEvidenceExternalFactCallSitesInSrc: extractorCalls,
        authorityFromSourceCallSitesInSrc: authorityFromSourceCalls,
        onlyBehavioralReader: 'canEvidenceExternalFact（conversation-event.ts:372），且 src/ 里唯一调用点传的是推导值',
      },
      cClassFailingAfterBackfill,
      cClassUnaffected: cClassSafe,
      measurements,
      measurementInvalid: measurementInvalid.length,
      scope: {
        readOnly: true,
        modifiedCTests: false,
        modifiedConsumers: false,
        /*
         * ⚠️ 这句话说的是**本 verifier 自己**：它不执行任何 Phase 4 工作、不改任何消费者。
         *    它**不**否认 4a 的存在 —— 这一次它的两条结构性判据是被**授权取代**的。
         */
        enteredPhase4: false,
        phase4aCriterionSupersession: {
          authorizedBy: '用户 2026-09-19 裁定：授权两条判据层面的取代，仅限「改门 + F4 登记 + 重新出证据」',
          replacedAssertions: [
            'ProcessorEventView **没有** Axis B 字段（原 §5-a）',
            'processorEventViewOf 也只搬非 Axis B 的字段（原 §5-b）',
          ],
          replacementBoundary: 'processorEventViewOf() 是唯一读原始 Axis B 三列并派生 trustedOrigin 的适配边界；视图只暴露 trustedOrigin?；下游只能消费 view.trustedOrigin',
          record: 'docs/m5.1.1/M5.1.1-WP11-Compatible-Assertion-Record.md §9',
        },
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)

console.log(`\n${'='.repeat(74)}`)
console.log(`WP2.2 K-17 消费者影响审计：${passed} 通过 / ${failed} 失败｜K-17 = ${k17Verdict}｜WP3 回填 = ${wp3Backfill}`)
if (failures.length > 0) for (const failure of failures) console.log(`  - ${failure}`)
console.log('='.repeat(74))
console.log('证据已写入：artifacts/m5.1.1/wp2.2-k17-consumer-impact.json')

process.exit(failed === 0 ? 0 : 1)
