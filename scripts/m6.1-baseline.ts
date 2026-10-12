/**
 * M6.1 **WP3 基线** —— 在**未修复候选**上，用**生产装配本体**跑短场景。
 *
 * ============================================================================
 *  它为什么这样搭（每一件都是被"别的路子证不了"逼出来的）
 * ============================================================================
 * ```text
 * · 用 `src/main.ts` **本尊**（不是 harness 复刻）：计划书 §WP3 要沿**真链路**核对，
 *   而 `ContextPacket` → 模型提示的渲染发生在 ElizaOS runtime 里 —— 自己写一个渲染器
 *   就等于**换掉了被测对象**（回复不再来自生产提示）。
 * · 用 `PROJECT_LG_SANDBOX` 指向**空目录**：合成隔离库（`src/main.ts:407` 的
 *   `guarded = PROJECT_LG_SANDBOX === undefined && isProductionDir(dataDir)` 正是这个闸）。
 *   ⇒ 全链路（ConversationRecorder / 记忆操作 / Recall / rollup）都在生产装配里被接上，
 *   而这正是计划书 §1.2 第 5 条（旧 `evals/m3/runtime/host.ts` 的 `rebindConversation`
 *   **未注入** memoryWriter/recall/actionWriter/rollup）缺掉的那一半。
 * · 回复**由真模型生成**（经 `pnpm with-test-model` 的测试端点）：计划书 §WP4 明写
 *   WP7a 那种 fixture 回复「**不能拿来证明模型自己学会了不编造**」。
 * · 两档预算**逐轮显式给值**（`CHARACTER_ROLLUP_TOKENS` 0 / 400），不依赖 `.env.test`
 *   当前内容（WP0 的 `D-1`：计划书说 `.env.test` 也配了 400，实测**未设该键**，
 *   于是测试档会**继承 `.env` 的 400**）。
 * ```
 *
 * ============================================================================
 *  它**不**做什么
 * ============================================================================
 * ```text
 * · **不打开真实库**：只对 `PRODUCTION_DB_DIR` 做**文件树摘要**（不通过打开数据库计算）
 * · **不改**任何生产配置、不写 `.env`、不动生产库
 * · **不**自己发明提示词、**不**自己发明场景回复
 * · **不**在此判定"根因"——它只采集读数；根因要等证据齐了再谈（计划书 §1.2 末句）
 * ```
 *
 * 用法（**必须**经测试包装器；否则失败关闭）：
 * ```bash
 * pnpm with-test-model pnpm exec tsx scripts/m6.1-baseline.ts --arm code-default
 * pnpm with-test-model pnpm exec tsx scripts/m6.1-baseline.ts --arm deployed
 * ```
 * 诊断档：`--limit <n>` 只跑前 n 轮（改动分母 ⇒ 读数一律标 `diagnostic`，不作结论）。
 */

import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { digestTree } from '../src/infrastructure/persistence/production-db-safety.ts'
import { TEST_MODEL_WRAPPER_MARKER } from './m6.1-command-surface.ts'
import { newestMtimeMs } from './m6.1-realdb-readout.ts'
import {
  M6_1_LOCAL_PARENT,
  createRunId,
  openRunDir,
  sha256OfText,
  writeManifestAtomic,
} from './m6.1-evidence.ts'
import { standardManifestFields } from './m6.1-run-manifest.ts'

const ROOT = resolve(process.cwd())
const TSX_CLI = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

/* 清单公共字段用（L-M61-14）：进程开始时刻 + 实际命令行（`standardManifestFields()` 不读 argv）。 */
const STARTED_AT = new Date().toISOString()
const INVOKED_COMMAND = `pnpm with-test-model pnpm m6.1:wp3:baseline ${process.argv.slice(2).join(' ')}`.trim()

// ---------------------------------------------------------------------------
// 两档预算（计划书 §7：部署档与代码缺省档必须**分别**报）
// ---------------------------------------------------------------------------

const ARMS = {
  'code-default': {
    rollupTokens: 0,
    note: '代码缺省档：`DEFAULT_CONTEXT_BUDGET.rollupTokens = 0`（摘要端口被构造但默认不读库、不产 section）',
  },
  deployed: {
    rollupTokens: 400,
    note: '部署档：`.env` 的 `CHARACTER_ROLLUP_TOKENS=400`（ADR-052 载体，另一会话激活）',
  },
} as const
type ArmName = keyof typeof ARMS

// ---------------------------------------------------------------------------
// 短场景（计划书 §5 的 A–J 里先取能被短场景定位的几类；对着 P-1…P-3 设计）
// ---------------------------------------------------------------------------

interface Turn {
  readonly id: string
  readonly category: string
  readonly text: string
  /** 这一轮在核什么（写进证据，供人读） */
  readonly note: string
}

const CHAIN_SCENARIO: readonly Turn[] = [
  { id: 'A-1', category: 'A', text: '我们刚才聊到哪儿了？', note: 'P-1：无历史首轮问"刚才"' },
  { id: 'A-2', category: 'A', text: '那我上次说的事你还记得吗？', note: 'P-1：追问既有经历' },
  {
    id: 'C-1',
    category: 'C',
    text: '记住：我不吃辣。',
    note:
      '显式记住（**全角冒号**）。内容换成了**已登记槽位**（cue「辣」→ predicate `food.avoid.general`）：' +
      '默认抽取器是**规则型**（`memoryLlmExtractorEnabled` 默认 off），认不出自由文本 ⇒ ' +
      '原先用"皮料"那两句被如实回成 `content_unresolved`（程序层 trace 已证）。' +
      '这次**只改内容**、结构不动，用来把"槽位可解析与否"与其他因素分开',
  },
  {
    id: 'C-1b',
    category: 'C',
    text: '记住，我不吃辣。',
    note:
      '与 C-1 **只差标点**（逗号）。与 C-1 一起构成单因素对：标点 / 词形 是不是因素',
  },
  { id: 'C-2', category: 'C', text: '我吃辣吗？', note: '正控：刚写进去的槽位应当能回忆出来' },
  {
    id: 'F-1',
    category: 'F',
    text: '之前那个改一下，我现在吃辣了。',
    note:
      'P-3：纠正。**用计划书第 175 节自己的句式**（cue `改一下` ⇒ 应判 `correct`，' +
      '而 `correct` 与 `remember` 是两条不同的服务路径）。' +
      '上一版「记住，我现在吃辣了。」 被判成 `remember`（`remember` 要求句首命中，符合规则），' +
      '结果**新增一条、旧值仍 active**。这次**只改这一处**，用来判定：' +
      '`correct` 路径到底能不能作废旧值 —— 这直接决定"改意图"（候选 B）是否可行',
  },
  { id: 'F-2', category: 'F', text: '我现在吃辣吗？', note: 'P-3：纠正后追问——旧值不得复活' },
  { id: 'B-1', category: 'B', text: '我搬到了城西。', note: '当前告知（正控：接纳为新告知）' },
  {
    id: 'E-1',
    category: 'E',
    text: '我们以前是不是养过一只叫团子的猫？你再想想。',
    note: 'P-2：诱导编造',
  },
]

/**
 * **遗忘（forget）场景** —— 计划书 §WP3 的核对点「纠正/**遗忘**是否真的成功」在
 * §1.9–§1.12 里**一点证据都没有**（那几轮只跑了 remember / correct / 追问）。
 * 这一段补它，纪律不变：**一次只动一个因素**，期望值**跑之前**先按源码写下，跑完对账。
 *
 * ```text
 *  期望（源码预测，不是结论）：
 *   1 建立        `remember` ⇒ written（§1.10 已证这条槽位能写进去）
 *   2 正控        「我吃辣吗？」⇒ 召回 selected=1、她应当说"不吃辣"
 *   3 遗忘        `forget` 目标可解析 ⇒ written、记忆 → RETRACTED（`explicit-service.ts:427`）
 *   4 遗忘后追问   该记忆**不得**再被召回（`selected=0`），也不得再被当作当前事实说
 *   5 词形变体    换另一条 forget cue（`别再记`，见 `intent-detector.ts:226`）；
 *                 此时目标已被作废 ⇒ 预期走"找不到目标"那一支（**这条同时是对 3 的复验**）
 *   6 负控        忘掉一件**从来没记过**的事 ⇒ **必须** `target_not_found`，
 *                 且回复**不得**有成功口吻（守卫会顶替成「我没找到你说的那条记忆，所以什么都没改。」）
 * ```
 *
 * ⚠️ 第 5 轮**不是**独立因素：它依赖第 3 轮是否真的作废了那条记忆。这一点写在这里，
 *    免得后面把"5 的结果"当成"另一条 cue 行不行"的独立证据。
 */
const FORGET_SCENARIO: readonly Turn[] = [
  { id: 'G-1', category: 'G', text: '记住：我不吃辣。', note: '建立（正控①：该槽位已知可写入）' },
  { id: 'G-2', category: 'G', text: '我吃辣吗？', note: '正控②：应当能回忆出"不吃辣"' },
  { id: 'G-3', category: 'G', text: '忘掉我不吃辣这件事。', note: '遗忘（目标可解析）：期望 RETRACTED' },
  { id: 'G-4', category: 'G', text: '我吃辣吗？', note: '遗忘后追问：旧值**不得**复活' },
  {
    id: 'G-5',
    category: 'G',
    text: '别再记我不吃辣了。',
    note: '词形变体（**依赖 G-3**，不是独立因素）：换一条 forget cue，此时目标已被作废',
  },
  {
    id: 'G-6',
    category: 'G',
    text: '忘掉我养过鹦鹉这件事。',
    note: '负控：从来没记过 ⇒ 必须走拒绝分支、不得有成功口吻',
  },
]

/**
 * **长场景（24 轮普通对话）** —— 只为一件事：给摘要端口**源**。
 *
 * §1.11 登记了一个**未决问题**：9 轮场景里 `rollup_scanned` **全是 0**
 * （连 8 轮对话 + 1 条记忆之后），至少有两种解释 ——
 * ① 那个场景**确实够不上**摘要的源条件；② 源读取器没看到事件。
 * 当时写下的区分实验是"把同一场景拉长，看 `rollup_scanned` 是否随事件累计上升"。
 *
 * ⚠️ **本场景不是对链条的单因素对照**：它同时改了长度与内容（没有 P-1/P-2/P-3 探针）。
 *    它只回答"源够不够"这一个问题；`rollup_*` 才是它的读数，回复行为**不作对照**。
 * ⚠️ 因此它的读数只与**同一个 run 的 trace** 比，不拿去和 9 轮场景比回复。
 */
const LONG_SCENARIO: readonly Turn[] = [
  { id: 'L-01', category: 'L', text: '早。今天有课吗？', note: '普通对话（给摘要攒事件）' },
  { id: 'L-02', category: 'L', text: '第一节课几点开始？', note: '普通对话' },
  { id: 'L-03', category: 'L', text: '我昨晚没睡好。', note: '普通对话' },
  { id: 'L-04', category: 'L', text: '中午一起吃饭吗？', note: '普通对话' },
  { id: 'L-05', category: 'L', text: '食堂三楼那家还开着吗？', note: '普通对话' },
  { id: 'L-06', category: 'L', text: '记住：我下周三要交作业。', note: '一次显式记忆写入（正控：路径通）' },
  { id: 'L-07', category: 'L', text: '作业是小组的还是个人的？', note: '普通对话' },
  { id: 'L-08', category: 'L', text: '下午要去图书馆。', note: '普通对话' },
  { id: 'L-09', category: 'L', text: '图书馆几点关门？', note: '普通对话' },
  { id: 'L-10', category: 'L', text: '今天天气怎么样？', note: '普通对话' },
  { id: 'L-11', category: 'L', text: '晚上有课吗？', note: '普通对话' },
  { id: 'L-12', category: 'L', text: '我明天想去跑步。', note: '普通对话' },
  { id: 'L-13', category: 'L', text: '操场几点人少？', note: '普通对话' },
  { id: 'L-14', category: 'L', text: '你平时几点睡？', note: '普通对话' },
  { id: 'L-15', category: 'L', text: '周末有什么打算吗？', note: '普通对话' },
  { id: 'L-16', category: 'L', text: '我想去看电影。', note: '普通对话' },
  { id: 'L-17', category: 'L', text: '最近有什么新片吗？', note: '普通对话' },
  { id: 'L-18', category: 'L', text: '我手机快没电了。', note: '普通对话' },
  { id: 'L-19', category: 'L', text: '你带充电宝了吗？', note: '普通对话' },
  { id: 'L-20', category: 'L', text: '明天记得提醒我买牙膏。', note: '普通对话（非记忆入口的说法）' },
  { id: 'L-21', category: 'L', text: '我还得去一趟超市。', note: '普通对话' },
  { id: 'L-22', category: 'L', text: '你要带什么吗？', note: '普通对话' },
  { id: 'L-23', category: 'L', text: '晚上想吃点什么？', note: '普通对话' },
  { id: 'L-24', category: 'L', text: '行，那先这样。', note: '收尾' },
]

/**
 * **H3 的证伪实验**（设计文档 §3 的 H3）—— 分三段，每段一次只动一个因素。
 *
 * ```text
 * H3 说：编造的直接触发 = "共同经历类提问" **且** 上下文里没有任何可依据条目。
 * 证伪实验（H3 自己写的）：① 同一提问，只改"本轮有没有可用依据"，看 alert 是否翻转；
 *                          ② 再只改**提问措辞**，看是否仍翻转。
 * ```
 *
 * ```text
 * 段一 `basis`（2 轮，**有依据**）  B-1 显式写入一条事实 → B-2 问它
 * 段二 `nobasis-1`（1 轮，**无依据**）与段一**逐字同一个问题**，只是沙箱是新的
 * 段三 `nobasis-2`（1 轮，**无依据**）同一件事的**另一种问法**（措辞是唯一变量）
 * ```
 * ⚠️ 三段**各自一个新沙箱** —— 这是"无依据"能成立的前提（同一沙箱里问第二遍就已经有历史了）。
 * ⚠️ 段三与段二之间还差一个因素：**话题同名但问法不同**，所以"段二/段三都报警"只能支持
 *    "措辞不是唯一触发"，不能支持"措辞完全无关"。
 */
const BASIS_SCENARIO: readonly Turn[] = [
  { id: 'B-1', category: 'H', text: '记住：我们周三有一场小组答辩。', note: '建立依据（显式记忆写入）' },
  { id: 'B-2', category: 'H', text: '我们周三有什么事？', note: '**有依据**地问同一件事（与段二逐字相同）' },
]

const NOBASIS_1_SCENARIO: readonly Turn[] = [
  {
    id: 'N1-1',
    category: 'H',
    text: '我们周三有什么事？',
    note: '**无依据**：与新沙箱的第一轮，问的是同一句（与段一逐字相同）',
  },
]

const NOBASIS_2_SCENARIO: readonly Turn[] = [
  {
    id: 'N2-1',
    category: 'H',
    text: '周三那个事是什么来着？',
    note: '**无依据**（新沙箱第一轮）：同一件事的另一种问法 —— 措辞是这三段之间唯一的变量之一',
  },
]

/**
 * **无标记的矛盾**（R-1 设计缺口的残差那一条）—— 修复前的基线。
 *
 * 设计文档 §4.1 用源码回答用户的问题时写明：
 * ```text
 * 「记住，我现在吃辣了。」含「现在」⇒ TEMPORAL_UPDATE ⇒ SUPERSEDE
 * 「记住，我吃辣。」  **无标记** ⇒ CONTRADICTION ⇒ **MARK_DISPUTED**（不覆盖、不删）
 * ```
 * ⚠️ 但**今天**（A 尚未实施）`remember` **根本不消费**冲突判定 ⇒ 无标记这一支的现状是
 * "又写一条、两条 active 并存"。本场景把**实施前的现状**钉下来，供 WP4 前后对照：
 * 修复后这一支应当变成 `MARK_DISPUTED`（旧值不被覆盖、新值也不冒充现状），
 * **而不是**变成 SUPERSEDE —— 那是 §4.1 的残差，用户批准的是 A，不是"自动取代一切"。
 */
const NOMARKER_SCENARIO: readonly Turn[] = [
  { id: 'M-1', category: 'M', text: '记住：我不吃辣。', note: '建立（已知可写入的槽位）' },
  {
    id: 'M-2',
    category: 'M',
    text: '记住，我吃辣。',
    note: '**无时间标记**的更正值：期望（修复后）= 同槽位 + 取值不同 + 无标记 ⇒ `CONTRADICTION` ⇒ `MARK_DISPUTED`',
  },
  { id: 'M-3', category: 'M', text: '我吃辣吗？', note: '追问：修复后应能看出"这条存疑"，而不是静悄悄取新值或旧值' },
]

/**
 * **有时间标记的更正**（A 的另一支）—— 用户设计缺口问题里举的那句话。
 *
 * 设计文档 §4.1 断言：「记住，我**现在**吃辣了。」含「现在」⇒ `TEMPORAL_UPDATE` ⇒ `SUPERSEDE`
 * （旧值 superseded、新值 active）。这一支在 A 接线**之前**的表现是"又建一条、两条 active"
 * （与 `nomarker` 相同）⇒ 本场景量的是接线**之后**它是否真的走成了取代。
 *
 * ⚠️ 与 `nomarker` 是**同一个单因素对照的两半**：只差"有没有时间标记"。
 */
const MARKER_SCENARIO: readonly Turn[] = [
  { id: 'K-1', category: 'K', text: '记住：我不吃辣。', note: '建立（已知可写入的槽位）' },
  {
    id: 'K-2',
    category: 'K',
    text: '记住，我现在吃辣了。',
    note: '**带时间标记**（「现在」）：期望 `TEMPORAL_UPDATE` ⇒ `SUPERSEDE`（新建 + 旧条作废）',
  },
  { id: 'K-3', category: 'K', text: '我吃辣吗？', note: '追问：修复后应以**新值**为准' },
]

const SCENARIOS = {
  chain: { turns: CHAIN_SCENARIO, note: '§1.9 起的 9 轮链路场景（对着 P-1/P-2/P-3 设计）' },  forget: {
    turns: FORGET_SCENARIO,
    note: '遗忘（forget）单因素场景：成功支 / 拒绝支 / 遗忘后不得复活',
  },
  long: { turns: LONG_SCENARIO, note: '长场景（24 轮普通对话）：给摘要端口**源**，检验 §1.11 的未决问题' },
  basis: { turns: BASIS_SCENARIO, note: 'H3 段一：**有依据**地问（先写入再问，两轮）' },
  'nobasis-1': { turns: NOBASIS_1_SCENARIO, note: 'H3 段二：**无依据**地问**逐字同一句**（单轮新沙箱）' },
  'nobasis-2': { turns: NOBASIS_2_SCENARIO, note: 'H3 段三：**无依据**地换一种问法（单轮新沙箱）' },
  nomarker: {
    turns: NOMARKER_SCENARIO,
    note: 'R-1 残差（无标记的矛盾）**修复前**基线：今天会并存两条 active，修复后应为 MARK_DISPUTED',
  },
  marker: {
    turns: MARKER_SCENARIO,
    note: 'A 的另一支（**带时间标记**的更正）：「现在」⇒ TEMPORAL_UPDATE ⇒ SUPERSEDE（与 nomarker 只差标记）',
  },
} as const
type ScenarioName = keyof typeof SCENARIOS

// ---------------------------------------------------------------------------
// 只读的程序状态视图（**现成入口**，不自造）
// ---------------------------------------------------------------------------

const STATE_VIEWS: readonly { readonly flag: string; readonly key: string }[] = [
  { flag: '--kernel-status', key: 'kernelStatus' },
  { flag: '--memory-list', key: 'memoryList' },
  { flag: '--memory-audit', key: 'memoryAudit' },
]

// ---------------------------------------------------------------------------
// 参数与守卫
// ---------------------------------------------------------------------------

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * 从 `src/main.ts` 的 stdout 里取出**她的回复**。
 *
 * ⚠️ 两处刻意不同于既有写法（`verify-m6-wp10b-live.ts` 的 `say()`）：
 * ```text
 * ① 它用 `slice(...).split('\n')[0]` —— **只取第一行**。她的回复经常是多行
 *    （实测首轮就是三行），那样会把回复截断，判定器看到的是半句话。
 * ② 它没有剥掉尾随日志：本机的 stdout 在回复之后还会打
 *    ` Info …[PLUGIN:BOOTSTRAP:…] Stopping …` —— 那些不属于回复，
 *    混进去会让语义判定判到日志上。
 * ```
 * 这里的规则：从**最后**一个 `苏沐薇:` 之后开始，一直取到**下一条日志行**为止。
 * 取不到标记 ⇒ 返回空串（**不是**把整段 stdout 当回复）。
 */
const REPLY_MARKER = '苏沐薇:'
const LOG_LINE = /^\s*(Info|Warn|Error|Debug|Trace)\s/

function extractReply(stdout: string): string {
  const at = stdout.lastIndexOf(REPLY_MARKER)
  if (at === -1) return ''
  const kept: string[] = []
  for (const line of stdout.slice(at + REPLY_MARKER.length).split(/\r?\n/)) {
    if (LOG_LINE.test(line)) break
    kept.push(line)
  }
  return kept.join('\n').trim()
}

function main(): void {
  const armName = (argValue('--arm') ?? 'code-default') as ArmName
  if (ARMS[armName] === undefined) {
    throw new Error(
      `--arm 只能是 ${Object.keys(ARMS).join(' / ')}（收到 ${JSON.stringify(armName)}）`
    )
  }
  const arm = ARMS[armName]
  const scenarioName = (argValue('--scenario') ?? 'chain') as ScenarioName
  if (SCENARIOS[scenarioName] === undefined) {
    throw new Error(
      `--scenario 只能是 ${Object.keys(SCENARIOS).join(' / ')}（收到 ${JSON.stringify(scenarioName)}）`
    )
  }
  const scenario = SCENARIOS[scenarioName].turns
  const limitRaw = argValue('--limit')
  const limit = limitRaw === undefined ? scenario.length : Number(limitRaw)
  if (!Number.isInteger(limit) || limit <= 0 || limit > scenario.length) {
    throw new Error(`--limit 必须是 1..${String(scenario.length)} 的整数（收到 ${String(limitRaw)}）`)
  }
  const diagnostic = limit < scenario.length

  /*
   * ---- 守卫①：必须经测试包装器 ----
   * 与 `m6.1:live` 同一条纪律：写错的表现是"以为在跑测试、其实在烧 `.env` 里的原 Key"。
   */
  if (process.env[TEST_MODEL_WRAPPER_MARKER] !== '1') {
    console.error(
      `失败关闭：缺 ${TEST_MODEL_WRAPPER_MARKER} 标记 ⇒ 拒绝运行。` +
        '本门必须经 `pnpm with-test-model` 跑（绝不回落到 .env 的原 key）。'
    )
    process.exit(2)
  }

  /* ---- 守卫②：真实库只做**文件树摘要**，且绝不被指向 ---- */
  if (!existsSync(PRODUCTION_DB_DIR)) {
    throw new Error(`找不到真实库目录 ${PRODUCTION_DB_DIR}（本门只对它做文件树摘要，不打开它）`)
  }
  const realDbBefore = digestTree(PRODUCTION_DB_DIR)
  const mtimeBefore = newestMtimeMs(PRODUCTION_DB_DIR)

  const headShort = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).stdout.trim()
  /*
   * ⚠️ runId 里带上场景名 —— 但 `chain` 保持历史命名不变（已落盘的 runId 与文档引用都不动），
   *    只有新场景才加前缀。这样"哪个 runId 是哪个场景"在目录名上就能读出来。
   */
  const wpId = scenarioName === 'chain' ? `baseline-${armName}` : `baseline-${scenarioName}-${armName}`
  const runId = createRunId({ wpId, headShort })
  const runDir = openRunDir(ROOT, runId)
  const localDir = join(ROOT, M6_1_LOCAL_PARENT, runId)
  mkdirSync(localDir, { recursive: true })

  /*
   * ---- 合成隔离库：**空目录**（不是真实库副本）----
   * 空库 = 全新合成场景；记忆、账本、摘要都从零开始累积。
   */
  const work = mkdtempSync(join(tmpdir(), 'project-lg-m61-baseline-'))
  const dbDir = join(work, 'pglite')
  mkdirSync(dbDir, { recursive: true })
  if (isProductionDir(dbDir)) throw new Error('拒绝：沙箱目录被判成生产库')
  if (resolve(dbDir) === resolve(PRODUCTION_DB_DIR)) throw new Error('拒绝：沙箱目录就是真实库')

  const childEnv = (): NodeJS.ProcessEnv => ({
    ...process.env,
    PGLITE_DATA_DIR: dbDir,
    PROJECT_LG_SANDBOX: dbDir,
    CHARACTER_ROLLUP_TOKENS: String(arm.rollupTokens),
  })

  const run = (
    args: readonly string[]
  ): { status: number; stdout: string; stderrTail: string; durationMs: number } => {
    const started = Date.now()
    const result = spawnSync(process.execPath, [TSX_CLI, 'src/main.ts', ...args], {
      cwd: ROOT,
      env: childEnv(),
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    const stderr = String(result.stderr ?? '')
    return {
      status: result.status ?? -1,
      stdout: String(result.stdout ?? ''),
      // 只留尾部若干行并截断长度 —— 不摘对话正文，也不能让日志把证据撑爆
      stderrTail: stderr.split(/\r?\n/).slice(-8).join('\n').slice(0, 1200),
      durationMs: Date.now() - started,
    }
  }

  console.log('='.repeat(78))
  console.log('M6.1 WP3 基线（生产装配本尊 · 空合成隔离库 · 真模型）')
  console.log('='.repeat(78))
  console.log(`  runId        ${runId}`)
  console.log(`  预算臂       ${armName}（rollupTokens=${String(arm.rollupTokens)}）`)
  console.log(`  ${arm.note}`)
  console.log(`  合成库       ${dbDir}`)
  console.log(
    `  真实库       ${String(realDbBefore.measuredCount)} 文件 · ${realDbBefore.treeSha256.slice(0, 16)}…（**只摘要，不打开**）`
  )
  console.log(
    `  场景         ${scenarioName} · ${String(limit)} / ${String(scenario.length)} 轮${diagnostic ? '（**诊断档**：分母被截，不作结论）' : ''}`
  )
  console.log('')

  // -------------------------------------------------------------------------
  // 逐轮：真轮次 + 只读状态视图
  // -------------------------------------------------------------------------

  const turns: {
    readonly id: string
    readonly category: string
    readonly userTextSha256: string
    readonly replySha256: string
    readonly replyChars: number
    readonly status: number
    readonly durationMs: number
    readonly stderrTail: string
    readonly replyMarkerFound: boolean
    readonly memoryListEmpty: boolean
    readonly stateViewChars: Record<string, { readonly status: number; readonly chars: number }>
  }[] = []
  const rawLines: string[] = []

  for (const turn of scenario.slice(0, limit)) {
    const said = run([turn.text])
    const stateViews: Record<string, { status: number; text: string }> = {}
    for (const view of STATE_VIEWS) {
      const result = run([view.flag])
      stateViews[view.key] = { status: result.status, text: result.stdout }
    }
    const reply = extractReply(said.stdout)
    /*
     * ③（记忆操作）的**结构化**读数：这一个布尔值把"显式记忆到底写没写进去"变成可判的，
     * 而不是靠人读一大段 stdout。空列表时 CLI 会打「没有匹配的记忆」这句固定提示。
     */
    const memoryListEmpty = String(stateViews.memoryList?.text ?? '').includes('没有匹配的记忆')
    turns.push({
      id: turn.id,
      category: turn.category,
      userTextSha256: sha256OfText(turn.text),
      replySha256: sha256OfText(reply),
      replyChars: reply.length,
      status: said.status,
      durationMs: said.durationMs,
      stderrTail: said.stderrTail,
      replyMarkerFound: said.stdout.includes(REPLY_MARKER),
      memoryListEmpty,
      stateViewChars: Object.fromEntries(
        Object.entries(stateViews).map(([key, value]) => [
          key,
          { status: value.status, chars: value.text.length },
        ])
      ),
    })
    // 正文只进 gitignored 的 local 目录
    rawLines.push(
      JSON.stringify({
        id: turn.id,
        category: turn.category,
        note: turn.note,
        userText: turn.text,
        reply,
        replyStatus: said.status,
        stderrTail: said.stderrTail,
        stateViews: Object.fromEntries(
          Object.entries(stateViews).map(([key, value]) => [key, value.text])
        ),
      })
    )
    console.log(
      `  ${turn.id.padEnd(5)} status=${String(said.status)} ${String(said.durationMs).padStart(6)}ms ` +
        `回复 ${String(reply.length).padStart(4)} 字 · ${reply.slice(0, 60).replace(/\n/g, ' ')}`
    )
  }

  // -------------------------------------------------------------------------
  // 落盘：正文 → local（gitignored）；哈希/计数 → Git
  // -------------------------------------------------------------------------

  const realDbAfter = digestTree(PRODUCTION_DB_DIR)
  const mtimeAfter = newestMtimeMs(PRODUCTION_DB_DIR)
  writeFileSync(join(localDir, 'turns.jsonl'), `${rawLines.join('\n')}\n`, 'utf8')
  writeFileSync(
    join(localDir, 'sandbox-dir.txt'),
    `${dbDir}\n（合成隔离库；正文面全部在本目录，Git 内只留哈希与计数）\n`,
    'utf8'
  )

  const realDbReadout = {
    note:
      '只做**文件树摘要**与 **mtime 扫描**，都不通过打开数据库计算；有变化时报"无法归属"，不宣称污染。' +
      '摘要 = 内容证据（更强）；mtime = "有没有被碰过"的独立信号 —— 两者都要（计划书 §6.3）。',
    before: {
      files: realDbBefore.measuredCount,
      bytes: realDbBefore.totalBytes,
      treeSha256: realDbBefore.treeSha256,
      newestMtimeMs: mtimeBefore.newestMtimeMs,
      newestMtimeIso: new Date(mtimeBefore.newestMtimeMs).toISOString(),
      newestPath: mtimeBefore.newestPath,
    },
    after: {
      files: realDbAfter.measuredCount,
      bytes: realDbAfter.totalBytes,
      treeSha256: realDbAfter.treeSha256,
      newestMtimeMs: mtimeAfter.newestMtimeMs,
      newestMtimeIso: new Date(mtimeAfter.newestMtimeMs).toISOString(),
      newestPath: mtimeAfter.newestPath,
    },
    unchanged: realDbBefore.treeSha256 === realDbAfter.treeSha256,
    mtimeUnchanged: mtimeBefore.newestMtimeMs === mtimeAfter.newestMtimeMs,
  }

  const reading = {
    schemaVersion: 'm6.1-wp3-baseline@1',
    runId,
    arm: armName,
    armNote: arm.note,
    rollupTokens: arm.rollupTokens,
    diagnostic,
    note:
      '**重建合成案例**（不是原始轨迹）：生产装配本尊 `src/main.ts` + **空**合成隔离库 + 真模型。' +
      '原始轨迹（V1/V2 的 P-1…P-3）与本读数是两类证据，**分列**，不得互相替代。',
    scenarioName,
    scenarioNote: SCENARIOS[scenarioName].note,
    scenario: scenario.slice(0, limit).map((turn) => ({
      id: turn.id,
      category: turn.category,
      note: turn.note,
      textSha256: sha256OfText(turn.text),
    })),
    turns,
    counts: {
      attempted: limit,
      completed: turns.filter((turn) => turn.status === 0).length,
      failed: turns.filter((turn) => turn.status !== 0).length,
      emptyReplies: turns.filter((turn) => turn.replyChars === 0).length,
    },
    realDb: realDbReadout,
    rawTextLocation: relative(ROOT, join(localDir, 'turns.jsonl')).split(/[\\/]/).join('/'),
    notClaimed: [
      '**不**主张任何根因（计划书 §1.2 末句）',
      '**不**主张摘要 / 检索 / 人格 / 数据库是原因',
      '**不**主张本场景设计已经过人工审阅（它是提案）',
      diagnostic
        ? '**诊断档**：分母被 `--limit` 截断 ⇒ 本读数不构成任何判定'
        : '未截断，但仍只是基线读数',
    ],
  }

  const baselineText = `${JSON.stringify(reading, null, 2)}\n`
  writeFileSync(join(runDir, 'baseline.json'), baselineText, 'utf8')
  const manifestPath = writeManifestAtomic(runDir, {
    schemaVersion: 'm6.1-manifest@1',
    runId,
    testType:
      'M6.1 WP3 基线（生产装配本尊 · 空合成隔离库 · 真模型；**不**打开真实库、**不**改生产配置）',
    phases: ['wp3-baseline'],
    counts: { executed: 1, completed: 1, skipped: 0, failed: reading.counts.failed },
    evidence: [
      {
        path: relative(ROOT, join(runDir, 'baseline.json')).split(/[\\/]/).join('/'),
        sha256: sha256OfText(baselineText),
      },
    ],
    realDbProtection: realDbReadout,
    notClaimed: reading.notClaimed,
    /*
     * L-M61-14（2026-09-26 技术债清偿）：此前只写了子集 ⇒ `m6.1:gates` 读不进来。
     * 公共字段改由唯一实现装配（与 `m6.1-live-short` 同一份）。
     */
    ...standardManifestFields({
      startedAt: STARTED_AT,
      commands: [{ cmd: INVOKED_COMMAND, exitCode: null }],
      corpusVersionDefinition:
        'WP3 基线的场景来自运行器内联的冻结场景表，而**不是**从 `evals/m6.1/` 语料目录逐条读的；' +
        '因此 `corpusVersion` 记的是冻结语料版本号，本轮的场景与回复见 `baseline.json`。',
    }),
  })

  console.log('')
  console.log(`  证据   ${relative(ROOT, join(runDir, 'baseline.json')).split(/[\\/]/).join('/')}`)
  console.log(`  清单   ${relative(ROOT, manifestPath).split(/[\\/]/).join('/')}`)
  console.log(`  正文   ${reading.rawTextLocation}（gitignored）`)
  console.log(
    `  真实库 ${realDbReadout.unchanged ? '**摘要未被改动**' : '**摘要不同 ⇒ 无法归属，必须人工看**'}` +
      ` · mtime ${realDbReadout.mtimeUnchanged ? '未被触碰' : '**变了（摘要相同也算"被碰过"，要人工看）**'}`
  )
}

main()
