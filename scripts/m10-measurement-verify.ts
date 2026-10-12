/**
 * M10 WP8 —— **量具自证门**（`pnpm m10:measurement:verify`）。
 *
 * ============================================================================
 *  它回答的问题（AGENTS.md §6 第 7 条 / `INV-M45-06`）
 * ============================================================================
 * ```text
 *     我现在的九道 M10 门，测到的真的是我要判断的那个东西吗？
 * ```
 * 只做正控的量具与"什么都不检查"在输出上**无法区分**。因此对每一道 M10 门，
 * 本门走**三段**：
 *
 * ```text
 * ① 正控（合法输入 ⇒ 安静）  未改动的树上，那道门必须 PASS
 * ② 负控（注入假象 ⇒ 必须响）在**它测量的那个面**上注入一处**具名**缺陷
 *                            ⇒ 那道门必须 FAIL，且**具体那一条检查**变红
 * ③ 恢复（放回真实实现 ⇒ 重新安静）
 *                            字节还原（比 sha256）⇒ 那道门必须重新 PASS
 * ```
 *
 * ============================================================================
 *  三条硬性质
 * ============================================================================
 * ① **注入点必须在被测面上，不在判据上**：例如"让 `GOAL_CREATED` 折不出行"
 *    是改**产品**；"把那一条检查注释掉"什么也没证明（那只是把量具拆了）。
 * ② **注入前的存在性检查**：目标片段找不到 ⇒ 那个 case 报
 *    `MEASUREMENT INVALID`（**不是** PASS）—— 否则一次重命名会让负控**静默失效**。
 * ③ **恢复按内容比对**（sha256），不是"我记得还原了"。
 *
 * ⚠️ 负控运行会在 `artifacts/m10/` 下留下 FAIL 档。**它们不是产品缺陷**，
 *    本门的摘要会记下它们的 runId（`negativeControlRunIds`），
 *    让后来读档的人分得清"门抓到的失败"与"我们故意注入的失败"。
 *
 * ⚠️ 零模型 / 零真实库。子进程之间的库隔离由被调用的门各自负责
 *    （它们本来就 `isolateDatabase` 或不碰库）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createM10RunId, openM10RunDir, writeM10Manifest } from './m10-evidence.ts'
import { auditGaugeConditions } from './m10-gauge-audit.ts'

const REPO_ROOT = resolve(process.cwd())

function phase(mark: string): void {
  console.error(`[m10-measurement] ${mark}`)
}

// ---------------------------------------------------------------------------
// 量具
// ---------------------------------------------------------------------------

interface Check {
  group: 'S' | 'N' | 'R' | 'V'
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

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

interface GateRun {
  readonly exitCode: number
  readonly stdout: string
  readonly runId?: string
}

/** 跑一道 M10 门（子进程），捕获退出码与 stdout */
function runGate(script: string, injectionId?: string): GateRun {
  /*
   * ⚠️ **注入态要给子进程打标记**（`M10_INJECTION`），让它的证据档**自报**是注入档。
   *
   * 不加标记的后果（实测）：注入态那次运行会照常写一份 FAIL 证据档，而它与被测门
   * **真正的** FAIL 档在盘上**完全同形** ⇒ `m10:gates` 读"最新一份"时把
   * `m10:source:verify` / `m10:context:verify` 判成 FAIL —— 那两份**都是注入档**。
   * 标记由 `writeM10Manifest`（唯一写清单的地方）记录 ⇒ 所有门免费获得。
   *
   * ⚠️ **正控那一次绝不能带标记**（`baselineMap()` 不传 `injectionId`）：
   *    否则"未注入 ⇒ 安静"那条读数自己也会被标成注入档。
   */
  const env =
    injectionId === undefined
      ? process.env
      : { ...process.env, M10_INJECTION: injectionId }
  try {
    const stdout = execFileSync('pnpm', ['exec', 'tsx', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: true,
      env,
    })
    const runId = /runId:\s*(\S+)/.exec(stdout)?.[1]
    return { exitCode: 0, stdout, ...(runId !== undefined ? { runId } : {}) }
  } catch (error) {
    const err = error as { status?: number; stdout?: string }
    const stdout = err.stdout ?? ''
    const runId = /runId:\s*(\S+)/.exec(stdout)?.[1]
    return { exitCode: err.status ?? 1, stdout, ...(runId !== undefined ? { runId } : {}) }
  }
}

/**
 * 某一条检查在该次运行里是不是红的。
 *
 * ⚠️ **不要要求 id 后面紧跟 `[`**（WP10 扩展自证时抓到的）。
 *
 * 第一版写的是 `❌\s+<id>\s+\[` —— 那条正则假设**所有门都打印 `[group]` 标记**，
 * 而 WP2 的 `m10:inputs:verify` 写在那个约定之前，它的输出是
 * `❌ I9 【负控…】…`（**没有方括号**）。后果：
 *
 * ```text
 * 注入真的生效了、I9 真的红了（JSON 证据里 pass:false），
 * 而**检测器说"没红"** ⇒ 负控被判成失败。
 * ```
 * ⇒ 这是"量具自己去假设**别人的表现层**"的缺陷。判据只该依赖
 * **id 这个 token 本身**，不该依赖它周围的排版。
 *
 * `\b` 是必要的：没有它，`I1` 会匹配到 `I10`、`X1` 会匹配到 `X11`。
 */
function checkIsRed(stdout: string, checkId: string): boolean {
  return (
    new RegExp(`❌\\s+${checkId}\\b`).test(stdout) ||
    new RegExp(`"id":\\s*"${checkId}"[\\s\\S]{0,400}?"pass":\\s*false`).test(stdout)
  )
}

// ---------------------------------------------------------------------------
// 注入表：每一行说清"改哪个产品的哪一处，哪一道门的哪一条检查必须因此变红"
// ---------------------------------------------------------------------------

interface Injection {
  readonly id: string
  readonly gate: string
  readonly gateLabel: string
  /** **被测面**上的文件 */
  readonly file: string
  /** 注入前的原文（找不到 ⇒ MEASUREMENT INVALID） */
  readonly from: string
  /** 注入后的原文 */
  readonly to: string
  /** 必须因此变红的那一条检查 */
  readonly expectCheckId: string
  readonly why: string
}

const INJECTIONS: readonly Injection[] = [
  {
    /*
     * N13 —— `m10:activation:verify`（WP11/WP12 的**绊线门**）。
     *
     * ⚠️ 它的**被测面是一份文档**（激活候选的缺口表），不是源文件。
     *    这没问题：那道门的**输入**就是这张表，把表改坏正是"被测面"上的缺陷。
     *    但注入点必须**唯一** —— G-1/G-2 的末列**都是** `| \`CLOSED\` |`，
     *    所以 `from` 取 G-2 那一行里**独有的** `S8` 那段（接线点的静态锁）。
     *
     * ⚠️ **2026-09-30 方向翻转**：`G-1`/`G-2` 真的接上之后，表里就是 `CLOSED` 了
     *    ⇒ 负控从"谎写成 `CLOSED`"改成"谎写成 `OPEN`"（表**低估**自己），
     *      而 `A3` 抓的正是"表 ≠ 真实"这个**方向无关**的不一致。
     *    ⚠️ 当时这条注入点**当场失效**（`V-N13`：找不到注入点 ⇒ MEASUREMENT INVALID）——
     *      门**如实拒收**而不是静默跳过，这正是"找不到注入点会让负控静默失效"那条纪律的落点。
     */
    id: 'N13',
    gate: 'scripts/m10-activation-verify.ts',
    gateLabel: 'm10:activation:verify（WP11 激活候选绊线）',
    file: 'docs/m10/M10-Activation-Candidate.md',
    from: '（`S8` 钉着接线点） | **M10 自己的实现** | `CLOSED` |',
    to: '（`S8` 钉着接线点） | **M10 自己的实现** | `OPEN` |',
    expectCheckId: 'A3',
    why:
      '**这就是绊线门存在的理由**：把 G-2 的表内状态谎写成 `OPEN`，'
      + '而 `src/main.ts` 里**已经**接了 `runGoalTurn` ⇒ 表在**低估**自己。'
      + '若 `A3` 不变红，那道绊线就是假的 —— 而"表与代码不一致"正是它唯一要抓的东西'
      + '（**方向无关**：高估与低估都算）。',
  },
  {
    id: 'N1',
    gate: 'scripts/m10-test.ts',
    gateLabel: 'm10:test（WP3 纯内核）',
    file: 'src/kernel/projections/goal.ts',
    from: `  if (event.type === GOAL_CREATED) {
    const payload = payloadOf<GoalCreatedPayload>(event)
    const goalId = payload?.goal?.goalId
    if (goalId === undefined) return undefined
    return goalRowKeyOf(String(goalId))
  }
`,
    to: '',
    expectCheckId: 'R3',
    why:
      '**就是 WP3 真实踩过的那个缺陷**：`GOAL_CREATED` 的 id 嵌在 `payload.goal.goalId`，' +
      '去掉显式分派后建目标的事件折不出行，而且**不报错**（静默跳过）。' +
      '若 `R3` 不变红，那条检查就是假的。',
  },
  {
    id: 'N2',
    gate: 'scripts/m10-source-verify.ts',
    gateLabel: 'm10:source:verify（WP4 语料与语义链）',
    file: 'evals/m10/goal-corpus.ts',
    from: 'testHighRiskMinimum: 30,',
    to: 'testHighRiskMinimum: 40,',
    expectCheckId: 'A2',
    why:
      '把高风险层的**硬下界抬到实际之上**（实际 35）⇒ `planMatches` 与分层下界检查必须响。' +
      '若它不响，"有效分母"这句话就没有机器判据。',
  },
  {
    id: 'N3',
    gate: 'scripts/m10-invalidation-verify.ts',
    gateLabel: 'm10:invalidation:verify（WP5 失效与遮蔽）',
    file: 'src/kernel/app/goal/invalidation.ts',
    from: `export const CERTAIN_INVALIDATION_REASONS: readonly ReferenceRejectionReason[] = [
  'forgotten',`,
    to: `export const CERTAIN_INVALIDATION_REASONS: readonly ReferenceRejectionReason[] = [
  'unavailable',
  'forgotten',`,
    expectCheckId: 'D2',
    why:
      '把"读不到"（`unavailable`）混进"确定失效"⇒ 一次数据库抖动就能 `cancel` 掉用户的约定。' +
      '这正是 WP5 裁定过的最危险的一处混淆，`D2` 必须响。',
  },
  {
    id: 'N4',
    gate: 'scripts/m10-completion-verify.ts',
    gateLabel: 'm10:completion:verify（WP6 完成判定）',
    file: 'src/kernel/app/goal/completion.ts',
    from: `        const foreignActor = found.filter((event) => event.actorType !== 'user')`,
    to: `        const foreignActor = found.filter(() => false)`,
    expectCheckId: 'J2',
    why:
      '关掉"依据必须是用户"的检查 ⇒ **她的输出可以自我确认**（"我已经帮你做完了"）。' +
      '这是本层存在的唯一理由，`J2` 必须响。',
  },
  {
    id: 'N5',
    gate: 'scripts/m10-context-verify.ts',
    gateLabel: 'm10:context:verify（WP7a 上下文段）',
    file: 'src/kernel/contracts/context.ts',
    from: '  goals: 45,',
    to: '  goals: 44,',
    expectCheckId: 'C5',
    why:
      '把目标段从 45 降到 44 ⇒ 与外部证据的**平局消失**，`D22` 的"外部证据先保留"' +
      '不再由排序规则保证。若 `C5` 不响，改 `SECTION_PRIORITY` 会静默改变优先级。',
  },
  {
    id: 'N6',
    gate: 'scripts/m10-observability-verify.ts',
    gateLabel: 'm10:observability:verify（WP7b 可观察面）',
    file: 'src/kernel/contracts/observability.ts',
    from: `  goal_context: 'context',`,
    to: `  goal_ctx: 'context',`,
    expectCheckId: 'T1',
    why:
      '重命名一个已登记的目标 trace 步骤 ⇒ 那一处的观测会落进 `unknown`（静默丢失）。' +
      '若 `T1` 不响，"五个步骤都登记了"就只是一句声明。',
  },
  /* ---------------------------------------------------------------------
   * WP10 追加：把自证从 6 道门扩到 10 道（覆盖 WP7a/WP7b/WP9-B/WP10 的新门）
   * ------------------------------------------------------------------- */
  {
    id: 'N7',
    gate: 'scripts/m10-context-verify.ts',
    gateLabel: 'm10:context:verify（WP7a 上下文段）',
    file: 'src/kernel/context/goal-sections.ts',
    from: 'export const GOAL_CONTEXT_MAX_ITEMS = 3',
    to: 'export const GOAL_CONTEXT_MAX_ITEMS = 4',
    expectCheckId: 'C2',
    why:
      '把 `D08` 的**入模项数上界**从 3 放宽到 4 ⇒ 第 4 项不再被 `beyond_item_limit` 拦住。' +
      '`D08` 是**冻结值**，它会静默地让 prompt 多带一项目标。若 `C2` 不响，' +
      '"至多 3 项"就没有机器判据。',
  },
  {
    id: 'N8',
    gate: 'scripts/m10-observability-verify.ts',
    gateLabel: 'm10:observability:verify（WP7b 可观察面）',
    file: 'src/kernel/app/goal/developer-face.ts',
    from: 'export interface DeveloperGoalMaskedDto extends DeveloperGoalStructuralFields {',
    to:
      'export interface DeveloperGoalMaskedDto extends DeveloperGoalStructuralFields {\n' +
      '  /** 注入的缺陷：遮蔽分支上多了内容字段 */\n' +
      '  readonly statement?: string',
    expectCheckId: 'R3',
    why:
      '在**遮蔽分支**的类型上加一个内容字段 ⇒ "遮蔽了还带正文"不再是类型错误。' +
      '这正是 M9 的 F-1（呈现层遗忘泄漏）同族的形状：泄漏从"类型允许"开始。' +
      '若 `R3` 不响，那条"类型上不可能"的说法就只是注释。',
  },
  {
    id: 'N9',
    gate: 'scripts/m10-gateway-verify.ts',
    gateLabel: 'm10:gateway:verify（U-20 网关注入）',
    file: 'src/kernel/app/turn-gateway.ts',
    /*
     * ⚠️ 第一版的注入是"把 `goalTokens` 换成字面量 200" —— **它不会让门变红**，
     *    因为那条路径只在端口**同时给了 `contextState`** 时才会挂状态块，
     *    而 `S2` 的场景**根本不带 `contextState`**（它验的是"只给事实时状态块不挂"）。
     *    ⇒ 注入必须落在**那条检查真正读的那个面**上。
     *
     * 现在改的是**转发那一段的门禁**：去掉 `if (input.runGoalTurn !== undefined)`，
     * 于是端口**没接**时也会追加五步。`O1`（"不接端口 ⇒ 0 个目标步骤"）必须响。
     */
    from:
      '    if (input.runGoalTurn !== undefined) {\n' +
      '      const goalStateSurvived = packet.sections.some(',
    to:
      '    if (true) {\n' +
      '      const goalStateSurvived = packet.sections.some(',
    expectCheckId: 'O1',
    why:
      '把"只在端口接上时转发五步"改成"总是转发" ⇒ 关闭档的轮次 trace **变长**，' +
      '而"开关关着"与"本轮没有目标操作"在 trace 上从此分不开。' +
      '`O1`（不接端口 ⇒ 0 个 `goal_*` 步骤）必须响。',
  },
  {
    id: 'N10',
    gate: 'scripts/m10-long-verify.ts',
    gateLabel: 'm10:long:verify（WP9-B 时间维度）',
    file: 'scripts/m10-long-verify.ts',
    from: '    (row) => !isGoalTerminal(row.goal.status),',
    to: "    (row) => row.goal.status === 'active',",
    expectCheckId: 'L8',
    why:
      '**把 WP9-B 真实踩过的那处缺陷放回去**：重复触发探针改挑 `active` 的行，' +
      '而前一个检查已经把目标暂停 ⇒ 挑不到 ⇒ `goalId: ""` ⇒ 放行口报 ' +
      '`goal_proposal_invalid_shape`，而读数**看起来像"幂等生效了"**。' +
      '若 `L8` 不响，那次修复就没有回归保护。',
  },
  {
    id: 'N11',
    gate: 'scripts/m10-inputs-verify.ts',
    gateLabel: 'm10:inputs:verify（WP2 来源引用与只读输入）',
    file: 'src/kernel/app/goal/inputs.ts',
    from:
      '      if (!withdrawn.ok) {\n' +
      "        set(dep, unusable('withdrawn_incomplete'))\n" +
      '        continue\n' +
      '      }\n' +
      '      const reference = options.memoryReferences?.get(dep.memoryId)',
    to:
      '      if (false) {\n' +
      "        set(dep, unusable('withdrawn_incomplete'))\n" +
      '        continue\n' +
      '      }\n' +
      '      const reference = options.memoryReferences?.get(dep.memoryId)',
    expectCheckId: 'I9',
    why:
      '把"撤销集有**具名缺口**"当成"撤销集完整" ⇒ 无法证明"没有被遗忘"，' +
      '却按**可采信**继续用。这是 M9 的 F-1 同族的形状：缺口意味着覆盖不保证，' +
      '而这里的失效方向是**漏遮**（severe 轴）。`I9` 必须响。',
  },
  {
    id: 'N12',
    gate: 'scripts/m10-scale-verify.ts',
    gateLabel: 'm10:scale:verify（WP9-A 规模）',
    file: 'src/infrastructure/persistence/goal-store.ts',
    from: '    foldGoalRows(cache, relevant)',
    to: '    foldGoalRows(cache, [])',
    expectCheckId: 'S5',
    why:
      '**把"投影是派生的"这条铁律弄坏**：重建路径删掉全部行之后**一条都不重放** ⇒ ' +
      '整池消失。`S5`（全量重放后逐字段相同）必须响 —— ' +
      '若它不响，"rebuild 能从事件重放回来"就没有机器判据。',
  },
]

// ---------------------------------------------------------------------------
// 三段式
// ---------------------------------------------------------------------------

interface InjectionRecord {
  readonly id: string
  readonly gate: string
  readonly expectCheckId: string
  readonly stage1ExitCode: number
  readonly injectedExitCode: number
  readonly injectedCheckRed: boolean
  readonly restoredExitCode: number
  readonly restoredByteIdentical: boolean
  readonly negativeControlRunId?: string
}

const records: InjectionRecord[] = []

function baselineMap(): Map<string, GateRun> {
  const map = new Map<string, GateRun>()
  for (const injection of INJECTIONS) {
    if (map.has(injection.gate)) continue
    map.set(injection.gate, runGate(injection.gate))
  }
  return map
}

function main(): void {
  phase('stage 1: 正控（未改动的树上，每道门必须 PASS）')
  const baselines = baselineMap()

  /* 正控：每道门在**未注入**时必须通过 */
  for (const [gate, run] of baselines) {
    const labels = INJECTIONS.filter((i) => i.gate === gate).map((i) => i.gateLabel)
    record(
      'S',
      `S-${gate.replace(/[^a-z0-9]/gi, '_')}`,
      `【正控】${labels[0] ?? gate} 在未注入的树上通过（合法输入 ⇒ 安静）`,
      'exit 0',
      `exit ${String(run.exitCode)}`,
      run.exitCode === 0,
    )
  }
  record(
    'S',
    'S0',
    '**`measured_count > 0` 自检**：本次真的跑了 ≥1 道门、≥1 个注入点'
      + '（0 道门 / 0 注入与"全部通过"在输出上长得一样）',
    `门 ≥1 · 注入 ≥1`,
    `门 ${String(baselines.size)} 道 · 注入 ${String(INJECTIONS.length)} 个`,
    baselines.size > 0 && INJECTIONS.length > 0,
  )

  phase('stage 2: 负控（注入假象 ⇒ 必须响）+ stage 3: 恢复（字节还原 ⇒ 重新安静）')
  for (const injection of INJECTIONS) {
    const path = join(REPO_ROOT, injection.file)
    const original = readFileSync(path, 'utf8')
    const originalSha = sha256(original)

    /*
     * ⚠️ **行尾归一化**（WP10 扩展自证时抓到的）。
     *
     * 本仓库的文件是 **CRLF**（`turn-gateway.ts` 实测 2753 个 `\r\n`），而注入表里
     * 的多行 `from` 是用 `\n` 写的 ⇒ **匹配不上**。第一版只有单行注入点，
     * 所以这个缺陷一直没暴露；`N9` 一开多行就撞上了。
     *
     * 它**没有**静默失效 —— 下面的"存在性检查"把它报成 `MEASUREMENT INVALID`
     * 而不是 PASS。**这正是那条检查存在的理由**：注入点找不到时，
     * "负控没响"与"负控根本没注入"在输出上长得一样。
     *
     * ⇒ 表格仍用 `\n` 写（可读），匹配与写入前按**文件自己的行尾**转换。
     */
    const eol = original.includes('\r\n') ? '\r\n' : '\n'
    const from = injection.from.replace(/\n/g, eol)
    const to = injection.to.replace(/\n/g, eol)

    /* 注入前的**存在性检查**：找不到目标片段 ⇒ MEASUREMENT INVALID，不是 PASS */
    if (!original.includes(from)) {
      record(
        'V',
        `V-${injection.id}`,
        `【量具有效性】${injection.id} 的注入点在 ${injection.file} 里**存在**`
          + '（找不到就无法注入 ⇒ 那个负控会静默失效）',
        '注入点在场',
        '**找不到注入点** ⇒ MEASUREMENT INVALID',
        false,
      )
      continue
    }
    record(
      'V',
      `V-${injection.id}`,
      `【量具有效性】${injection.id} 的注入点在 ${injection.file} 里存在`
        + `（行尾按文件自己的 ${eol === '\r\n' ? 'CRLF' : 'LF'} 匹配）`,
      '注入点在场',
      `命中长度 ${String(from.length)} 字符`,
      true,
    )

    /* ---- 阶段 2：注入 ---- */
    /*
     * ⚠️ `try/finally` **不是**形式主义：门会在 `writeFileSync(injected)` 与
     *    `writeFileSync(original)` 之间读文件。若那段里抛出一个未预料的错
     *    （或未来的改动引入一个新异常），没有 `finally` 就会把**改动过的源文件**
     *    留在树上 —— 那比"这次没测成"糟得多。
     *    （已知的口子：**进程被强杀**在这里时仍会留下注入态，见交接单的限制。）
     */
    let injected: GateRun
    let red = false
    try {
      writeFileSync(path, original.replace(from, to), 'utf8')
      injected = runGate(injection.gate, injection.id)
      red = checkIsRed(injected.stdout, injection.expectCheckId)
    } finally {
      writeFileSync(path, original, 'utf8')
    }
    record(
      'N',
      injection.id,
      `【负控】${injection.gateLabel} 必须因注入而 FAIL，且 **${injection.expectCheckId}** 变红`,
      `exit≠0 · ${injection.expectCheckId} 红`,
      `exit ${String(injected.exitCode)} · ${injection.expectCheckId} 红=${String(red)}` +
        `${injected.runId !== undefined ? ` · runId=${injected.runId}` : ''}`,
      injected.exitCode !== 0 && red,
    )

    /* ---- 阶段 3：恢复（**按内容比对**，不是"我记得还原了"） ---- */
    const restoredSha = sha256(readFileSync(path, 'utf8'))
    const restored = runGate(injection.gate)
    record(
      'R',
      injection.id,
      `【恢复】字节还原后 ${injection.gateLabel} 重新 PASS（放回真实实现 ⇒ 重新安静）`,
      'sha 一致 · exit 0',
      `sha 一致=${String(restoredSha === originalSha)} · exit ${String(restored.exitCode)}`,
      restoredSha === originalSha && restored.exitCode === 0,
    )

    records.push({
      id: injection.id,
      gate: injection.gate,
      expectCheckId: injection.expectCheckId,
      stage1ExitCode: baselines.get(injection.gate)?.exitCode ?? -1,
      injectedExitCode: injected.exitCode,
      injectedCheckRed: red,
      restoredExitCode: restored.exitCode,
      restoredByteIdentical: restoredSha === originalSha,
      ...(injected.runId !== undefined ? { negativeControlRunId: injected.runId } : {}),
    })
  }

  /* ====================================================================== */
  phase('V2: the gauges themselves do not pass unconditionally')
  /*
   * ⚠️ **本节是 `L-M10-64` / `L-M10-65` 的产物**，也是本门"尺子可信吗"这个主题的**自指**部分：
   *    前三段（正控 / 负控 / 恢复）证明"**注入能弄红**"，
   *    这一段证明"**没有人靠'永远为真'混过去**"。
   *
   * ```text
   * 已抓到的三例（都在 M10 自己的门里）：
   *   ① G39：`members.length <= allRows.length && members.join(',') === […].sort().join(',')`
   *      ⇒ 恒真 ⇒ 一条"关于冲突"的检查**观察到 0 个冲突**却始终绿（L-M10-64）
   *   ② I1/I3：`goalCompletionUnitOf(marker) === goalCompletionUnitOf(marker)` ⇒ 恒真
   *   ③ S5：判据就是字面量 `true`，而 expected 却用断言口吻写着"排序规则不变"
   * ```
   * ⇒ 判据（见 `scripts/m10-gauge-audit.ts` 的文件头）：
   *    分母 > 0 · **无条件为真必须自报家门**（两分支的绿半边，或在 expected 里声明不作断言）·
   *    **不许自比较恒真**。
   * ⇒ ⚠️ 它是**筛子不是判决**：实测误报过一次（`m10:measurement:verify` 自己的 `V-<注入>`
   *    被当成"无条件为真"，而它其实是**两分支**：找不到注入点记 `false`、找到记 `true`）。
   */
  const gaugeAudit = auditGaugeConditions(join(REPO_ROOT, 'scripts'))
  record(
    'V',
    'V2a',
    '【量具有效性·自指】**判据审计的分母**：解析到的 `record(...)` 调用数必须 > 0'
      + '（"一条都没解析到"与"全部健康"在输出上长得一样 —— `AGENTS.md` §6.8）',
    'scanned > 0',
    `scanned=${String(gaugeAudit.scanned)} · 调用点=${String(gaugeAudit.callSites)}`,
    gaugeAudit.scanned > 0,
  )
  record(
    'V',
    'V2b',
    '【量具有效性·自指】**无条件为真（pass 恰为 `true`）必须自报家门**：'
      + '要么同一 `(file,id)` 还出现过非 `true`（⇒ 两分支判据的绿半边），'
      + '要么在 `expected` 里声明"不作断言" —— 否则它就是**空量具**',
    '未自报家门 = 0 条',
    `无条件为真 ${String(gaugeAudit.unconditional.length)} 条 · 已自报家门/两分支 ${String(gaugeAudit.declared.length)} 条`
      + ` · **未自报家门 ${String(gaugeAudit.undeclared.length)} 条**`
      + (gaugeAudit.undeclared.length > 0
        ? `：${gaugeAudit.undeclared.map((call) => `${call.file}:${call.id}`).join(', ')}`
        : ''),
    gaugeAudit.undeclared.length === 0,
  )
  record(
    'V',
    'V2c',
    '【量具有效性·自指】**没有自比较恒真**：`f(x) === f(x)` 这种"纯函数、同参数、'
      + '同一表达式里调两次"的判据恒真（实测出现在 `I1`/`I3`，已修成"独立构造 + 负控"）',
    '0 条',
    `${String(gaugeAudit.selfComparison.length)} 条` +
      (gaugeAudit.selfComparison.length > 0
        ? `：${gaugeAudit.selfComparison.map((call) => `${call.file}:${call.id}`).join(', ')}`
        : ''),
    gaugeAudit.selfComparison.length === 0,
  )
  phase('done')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM10RunId({ wpId: 'wp8-measurement', headShort: head })
  const dir = openM10RunDir(REPO_ROOT, runId)

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const groups = ['S', 'N', 'R', 'V'] as const
  const perGroup = Object.fromEntries(
    groups.map((g) => [
      g,
      {
        total: checks.filter((c) => c.group === g).length,
        passed: checks.filter((c) => c.group === g && c.pass).length,
      },
    ]),
  )

  const payload = {
    schema: 'm10-measurement-verify@1',
    runId,
    head,
    /** 三段式的逐例读数 */
    injections: records,
    /**
     * ⚠️ 负控运行在 `artifacts/m10/` 下留下的 FAIL 档 runId。
     *    它们**不是产品缺陷** —— 是本次故意注入的失败。
     *    列出来，是为了让后来读档的人分得清这两件事。
     */
    negativeControlRunIds: records
      .map((r) => r.negativeControlRunId)
      .filter((id): id is string => id !== undefined),
    checks,
    perGroup,
    summary: { total: checks.length, passed, failed, verdict: failed === 0 ? 'PASS' : 'FAIL' },
  }
  writeFileSync(join(dir, 'measurement-verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM10Manifest(dir, {
    runId,
    wp: 'wp8',
    head,
    headShort: head.slice(0, 12),
    branch: execFileSync('git', ['branch', '--show-current'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim(),
    date: new Date().toISOString().slice(0, 10),
    toolVersions: { node: process.version, git: '(见 baseline)' },
    testType: 'measurement-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['positive', 'negative', 'restore'],
    supersedes: null,
    notes:
      'WP8 量具自证三段式：六道 M10 门各注入一处**被测面**上的具名缺陷（正控 / 负控 / 恢复）。' +
      '负控留下的 FAIL 档 runId 记在 payload.negativeControlRunIds —— 它们不是产品缺陷。',
    databaseScope: 'not-applicable',
    mode: 'offline',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
    console.log(`      期望 ${c.expected} · 实测 ${c.actual}`)
  }
  console.log(`verdict: ${payload.summary.verdict}（${String(passed)}/${String(checks.length)}）`)
  console.log(`分组：${groups.map((g) => `${g}=${String(perGroup[g].passed)}/${String(perGroup[g].total)}`).join(' · ')}`)
  console.log(`负控 FAIL 档（**不是产品缺陷**）：${payload.negativeControlRunIds.join(', ') || '（无）'}`)
  process.exitCode = failed === 0 ? 0 : 1
}

main()
