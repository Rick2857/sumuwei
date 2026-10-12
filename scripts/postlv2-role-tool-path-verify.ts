/**
 * 角色自选工具（Role-Tool-Decision）· **WP1 路径验收**（离线 · 真网关 · 真执行环）。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * 计划书 §6 WP1：「无关键词问题可触发；普通闲聊可直接回答；非法提案拒绝且零动作」。
 * 设计：[`ADR-104`](../../docs/adr/ADR-104-role-tool-decision.md) `D01`–`D15`。
 *
 * ```bash
 * pnpm postlv2:role-tool:path                    # 跑这一组（写证据）
 * pnpm postlv2:role-tool:path --no-evidence      # 跑但不落盘
 * ```
 *
 * ============================================================================
 *  它**替换的只有决策端口**（其余全是生产实现）
 * ============================================================================
 * ```text
 * 真 `TurnGateway`（beginTurn → compileTurn → completeTurn）
 * 真 `ActionTurnPort`（role 路径）· 真 `ActionGateway` / Policy / 账本 / 适配器
 * 真 `runTask`（预算 / 期限 / 进度闸 / 暂存 / 归因）
 * fixture 决策端口（**不调模型**：提案由脚本给，这样测的是"提案怎么被处理"）
 * ```
 * ⚠️ "模型会不会好好提案"**不在本门里** —— 那要真模型样本（W1 的语义评估），
 *    本门的读数对那件事**一个字都不主张**。
 * ⚠️ 真实库 `data/pglite` 一次都不打开：本门用 `Suite` 的隔离库，
 *    并在开头/结尾各比一次真实库的 mtime 与文件数（"没被动过"只能这样证明）。
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { looksLikeTask } from '../src/kernel/action/task-intent.ts'
import { createActionIntentDetector } from '../src/kernel/action/intent-detector.ts'
import { createUtilityIntentDetector } from '../src/kernel/action/utility-intent.ts'
import type {
  ToolDecisionFailure,
  ToolDecisionInput,
  ToolDecisionPort,
} from '../src/kernel/action/tool-decision.ts'
import type { TaskPlannerPort } from '../src/kernel/action/task-plan.ts'
import {
  KNOWN_DIRECTORY_KEYS,
  describeKnownDirectories,
  knownDirectoryProbeFailed,
  parseKnownDirectoryProbe,
  renderKnownDirectoriesForModel,
} from '../src/kernel/action/known-directories.ts'

import { Suite } from './productivity-skills/groups.ts'
import { GroupRecorder, type VerifyContext } from './productivity-skills/reading.ts'
import { idlePlanner } from './productivity-skills/assembly.ts'

const REPO_ROOT = resolve(process.cwd())
const EVIDENCE_PARENT = 'artifacts/post-lv2/role-tool-decision'
const LOCAL_PARENT = 'artifacts/post-lv2/local/role-tool-decision'
const REAL_DB = join(REPO_ROOT, 'data', 'pglite')

const SOURCE_FILES: readonly string[] = [
  'src/kernel/action/tool-catalog.ts',
  'src/kernel/action/tool-decision.ts',
  'src/kernel/action/action-turn.ts',
  'src/kernel/action/task-plan.ts',
  'src/kernel/action/task-loop.ts',
  'src/kernel/app/flags.ts',
  'src/kernel/app/turn-gateway.ts',
  'src/main.ts',
  'src/infrastructure/model/openai-tool-decision.ts',
  'scripts/postlv2-role-tool-path-verify.ts',
  'scripts/productivity-skills/assembly.ts',
]

/**
 * 缺口 1 的**原句**（计划书 §1 逐字）。
 *
 * ⚠️ 它不命中 `looksLikeTask`，也不命中任何既有检测器 —— 本门第一条判据就是**证明**这一点，
 *    然后证明 role 档下它真的能触发一次工具（同一句话、同一套执行面）。
 * ⚠️ 本门**不读真实的用户桌面**（隐私 + 不可复现）。合成树在 `%TEMP%`，
 *    它是"一个被授权的本机目录"的替身；**真实的已知目录证据是 WP2 的活**（如实登记）。
 */
const NL_QUESTION = '我想问个问题，就是我的电脑桌面上有几个快捷方式。'

// ---------------------------------------------------------------------------
// fixture 决策端口（**脚本给提案**，不调模型）
// ---------------------------------------------------------------------------

type DecisionScriptItem =
  | { readonly raw: unknown }
  | { readonly fail: ToolDecisionFailure }
  | { readonly throw: string }

function scriptedDecision(script: readonly DecisionScriptItem[]): {
  readonly port: ToolDecisionPort
  readonly inputs: ToolDecisionInput[]
  readonly calls: () => number
} {
  const inputs: ToolDecisionInput[] = []
  let index = 0
  return {
    inputs,
    calls: () => index,
    port: {
      id: 'fixture-role-decision',
      endpointHost: 'fixture.local',
      async decide(input) {
        inputs.push(input)
        const item = script[Math.min(index, script.length - 1)]
        index += 1
        if (item === undefined) return { ok: false, failure: 'call_failed', requestCount: 1 }
        if ('throw' in item) throw new Error(item.throw)
        if ('fail' in item) return { ok: false, failure: item.fail, requestCount: 1 }
        return { ok: true, raw: item.raw, requestCount: 1 }
      },
    },
  }
}

function toolsProposal(steps: readonly Record<string, unknown>[]): unknown {
  return { branch: 'tools', goal: '（夹具）数一数这个目录里的东西', steps, done: true }
}

/**
 * WP2：**会记录自己被问了什么**的规划器（把"规划器到底看到了什么"变成可断言的读数）。
 *
 * ⚠️ 它**不改**规划器的语义：给的计划就是"什么都不做"（`steps: []`, `done: true`），
 *    因此它**不可能**替被测对象做出"再来一步"的决定 —— 它只是一个输入记录器。
 */
function recordingPlanner(): {
  readonly planner: TaskPlannerPort
  readonly inputs: PlannerInput[]
} {
  const inputs: PlannerInput[] = []
  return {
    inputs,
    planner: {
      id: 'fixture-recording-planner',
      endpointHost: 'fixture.local',
      async plan(input) {
        inputs.push(input)
        return {
          ok: true,
          plan: { goal: '（夹具）到此为止', steps: [], done: true },
          requestCount: 0,
        }
      },
    },
  }
}

type PlannerInput = Parameters<TaskPlannerPort['plan']>[0]

/** 夹具探测输出（**假** stdout）：个人桌面被重定向到 OneDrive，公共桌面是常规位置 */
const FIXTURE_PROBE_STDOUT = [
  'personal_desktop=C:\\Users\\someone\\OneDrive\\Desktop',
  'public_desktop=C:\\Users\\Public\\Desktop',
  '',
].join('\r\n')

// ---------------------------------------------------------------------------
// 真实库只读探针（"没被动过"的证据）
// ---------------------------------------------------------------------------

function realDbFingerprint(): { files: number; maxMtimeMs: number } | 'absent' {
  if (!existsSync(REAL_DB)) return 'absent'
  let files = 0
  let maxMtimeMs = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      files += 1
      maxMtimeMs = Math.max(maxMtimeMs, statSync(path).mtimeMs)
    }
  }
  walk(REAL_DB)
  return { files, maxMtimeMs }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

interface Cli {
  readonly writeEvidence: boolean
  readonly label: string
}

function parseArgv(argv: readonly string[]): Cli {
  let writeEvidence = true
  let label = 'role-tool-path'
  for (const arg of argv) {
    if (arg === '--no-evidence') {
      writeEvidence = false
      continue
    }
    if (arg.startsWith('--label=')) {
      label = arg.slice('--label='.length)
      continue
    }
    throw new Error(`不认识的参数：${arg}`)
  }
  return { writeEvidence, label }
}

function git(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

async function main(): Promise<number> {
  const cli = parseArgv(process.argv.slice(2))
  const startedAt = new Date().toISOString()
  const dbBefore = realDbFingerprint()

  const stamp = startedAt.replace(/[-:]/g, '').replace(/\..+$/, '')
  const runId = `${cli.label}-${stamp}-${git(['rev-parse', '--short=8', 'HEAD']) || 'unknown'}`
  const runDir = join(REPO_ROOT, EVIDENCE_PARENT, runId)
  const localDir = join(REPO_ROOT, LOCAL_PARENT, runId)
  if (cli.writeEvidence) {
    if (existsSync(runDir)) throw new Error(`runId 目录已存在，拒绝覆盖：${runDir}`)
    mkdirSync(runDir, { recursive: true })
    mkdirSync(localDir, { recursive: true })
  }

  const log = (message: string): void => {
    process.stdout.write(`${message}\n`)
  }
  const ctx: VerifyContext = {
    only: ['common'],
    fixturesDir: join(localDir, 'fixtures'),
    runDir,
    localDir,
    log,
  }
  const suite = new Suite(ctx)
  const rec = new GroupRecorder('wp1-role-path')

  try {
    /* ---- ① 缺口 1 的机器事实：这句话**看不见**词形入口 ---------------------- */
    const legacyChain = createUtilityIntentDetector({
      math: true,
      document: true,
      web: true,
      ocr: true,
    })
    const legacyDetector = createActionIntentDetector()
    rec.countInput(3)
    rec.check(
      '缺口 1 的机器事实：原句不命中任务形词形判据（looksLikeTask = false）',
      looksLikeTask(NL_QUESTION) === false,
      `looksLikeTask=${String(looksLikeTask(NL_QUESTION))}`
    )
    rec.check(
      '缺口 1 的机器事实：原句也不命中 M4.5 与本机文件域的检测器',
      legacyDetector.detect(NL_QUESTION) === undefined,
      JSON.stringify(legacyDetector.detect(NL_QUESTION) ?? null)
    )
    rec.check(
      '缺口 1 的机器事实：原句不命中第一批四项的检测器',
      legacyChain.detect(NL_QUESTION) === undefined,
      JSON.stringify(legacyChain.detect(NL_QUESTION) ?? null)
    )

    /* ---- ② 旧档对照（负控）：同一句话在 rules 档**零动作** ------------------- */
    const rulesBed = await suite.openBed('rp-rules')
    const rulesReading = await rulesBed.bed.say({
      options: {
        switches: { localFileRead: true, taskAutonomy: true },
        sandboxRoot: rulesBed.dir,
        recoveryRoot: join(rulesBed.dir, 'recovery-rules'),
        planner: idlePlanner(),
      },
      text: NL_QUESTION,
      replyText: '（夹具回复）',
    })
    const rulesRows = await rulesBed.bed.actionRows()
    rec.countInput(2)
    rec.check(
      '旧档对照：同一句话在 rules 档不产生任何动作（所以缺口 1 是真缺口）',
      rulesReading.actionResults.length === 0,
      `actionResults=${String(rulesReading.actionResults.length)}`
    )
    rec.check(
      '旧档对照：账本里也没有任何一条执行记录（不是"执行了但没返回"）',
      rulesRows.length === 0,
      `ledgerRows=${String(rulesRows.length)}`
    )

    /* ---- ③ role 档：同一句话**真的触发一次工具**，并带回真实内容 ------------ */
    const roleBed = await suite.openBed('rp-tools')
    const listingPath = roleBed.tree.root
    const listDecision = scriptedDecision([
      {
        raw: toolsProposal([
          {
            capability: 'local.file.list',
            operation: 'list',
            args: { path: listingPath },
            purpose: '列出这个目录',
          },
        ]),
      },
    ])
    const toolsReading = await roleBed.bed.say({
      options: {
        switches: { localFileRead: true, taskAutonomy: true },
        sandboxRoot: roleBed.dir,
        recoveryRoot: join(roleBed.dir, 'recovery-tools'),
        planner: idlePlanner(),
        turnContentTokens: 2000,
        toolDecision: { port: listDecision.port },
      },
      text: NL_QUESTION,
      replyText: '（夹具回复）',
      decisionLines: ['对方：前面那句是寒暄', '苏沐薇：嗯，我在听'],
    })
    const listed = toolsReading.actionResults.find(
      (item) => String(item.result?.capability) === 'local.file.list'
    )
    rec.countInput(4)
    rec.check(
      'role 档：无关键词的问题句触发了一次工具（这是缺口 1 的正面读数）',
      listed !== undefined && listed.result?.status === 'success',
      JSON.stringify({
        capability: listed?.result?.capability ?? null,
        status: listed?.result?.status ?? null,
        executed: listed?.result?.executed ?? null,
      })
    )
    const listedText = toolsReading.turnContent.map((item) => item.text).join('\n')
    /* 夹具树里的真实文件名（`fixtures.ts` 的 `SYNTH_TEXT_FILES`） */
    const aSynthFileName = 'notes-cn.txt'
    rec.check(
      'role 档：真实内容回到轮次（当轮内容里带着目录里的真实条目名）',
      toolsReading.turnContent.length > 0 && listedText.includes(aSynthFileName),
      JSON.stringify({
        items: toolsReading.turnContent.length,
        hasSynthName: listedText.includes(aSynthFileName),
        sample: listedText.slice(0, 200),
      })
    )
    const turnContentSection = toolsReading.sectionOf('turn-content')
    rec.check(
      'role 档：那份内容**真的进了 prompt**（turn-content section 非空且含条目名）',
      turnContentSection !== '' && turnContentSection.includes(aSynthFileName),
      JSON.stringify({
        sectionChars: turnContentSection.length,
        hasSynthName: turnContentSection.includes(aSynthFileName),
      })
    )
    rec.check(
      'role 档：决策端口恰好被问了**一次**（每轮至多一次，D07）',
      listDecision.calls() === 1,
      `calls=${String(listDecision.calls())}`
    )

    /* ---- ④ 决策**看得到什么**（有界输入 + 程序生成的目录） ------------------ */
    const seen = listDecision.inputs[0]
    rec.countInput(4)
    rec.check(
      '决策输入：本轮原话**逐字**（触发仍是那条原用户事件）',
      seen?.text === NL_QUESTION,
      `textLen=${String(seen?.text.length ?? -1)}`
    )
    rec.check(
      '决策输入：最近对话行原样送到（本门传了两行，决策就收到两行）',
      seen?.recentLines.length === 2,
      `recentLines=${String(seen?.recentLines.length ?? -1)}`
    )
    rec.check(
      '决策输入：目录是**程序生成**的，含已启用能力、且不含通用执行入口',
      seen !== undefined &&
        seen.catalog.includes('local.file.list') &&
        seen.catalog.includes('local.file.read') &&
        /*
         * ⚠️ 只扫**条目行**（`- 能力：…` 那几行）：目录 header 里那句
         *    "不要用任意 Shell / 脚本"本身就含 `Shell` —— 把它算成泄漏是量具在量错的东西。
         */
        !/shell|exec\(|eval\(/i.test(
          seen.catalog
            .split('\n')
            .filter((line) => line.trim().startsWith('- '))
            .join('\n')
        ),
      JSON.stringify({ catalogChars: seen?.catalog.length ?? -1 })
    )
    rec.check(
      '决策输入：能力清单**包含**旧沙箱三件（计划书 §3 能力矩阵逐字）',
      seen !== undefined &&
        ['system.echo', 'sandbox.file.read', 'sandbox.file.write'].every((capability) =>
          seen.allowedCapabilities.includes(capability)
        ),
      JSON.stringify(seen?.allowedCapabilities ?? [])
    )

    /* ---- ⑤ 单一入口：关键词说"要做"，决策说 `answer` ⇒ 零动作 --------------- */
    const answerBed = await suite.openBed('rp-answer')
    const mathText = '帮我算一下 0.1+0.2'
    const mathWouldFire =
      createUtilityIntentDetector({ math: true, document: false, web: false, ocr: false }).detect(
        mathText
      ) !== undefined
    const answerDecision = scriptedDecision([{ raw: { branch: 'answer' } }])
    const answerReading = await answerBed.bed.say({
      options: {
        switches: { math: true, taskAutonomy: true },
        sandboxRoot: answerBed.dir,
        recoveryRoot: join(answerBed.dir, 'recovery-answer'),
        planner: idlePlanner(),
        toolDecision: { port: answerDecision.port },
      },
      text: mathText,
      replyText: '（夹具回复）',
    })
    const answerSteps = answerReading.trace.steps
    const decisionStep = answerSteps.find((step) =>
      String(step.label ?? '').includes('角色决策')
    )
    rec.countInput(4)
    rec.check(
      '单一入口的前置事实：这句话在旧档里**会**触发计算意图（所以下面的零动作是决策的功劳）',
      mathWouldFire,
      `mathWouldFire=${String(mathWouldFire)}`
    )
    rec.check(
      '单一入口：决策说 answer ⇒ **零动作**（关键词不参战）',
      answerReading.actionResults.length === 0,
      `actionResults=${String(answerReading.actionResults.length)}`
    )
    rec.check(
      '单一入口：决策读数留在 trace 上（她"决定不用工具"是可查的，不是不可观测）',
      decisionStep !== undefined &&
        String((decisionStep.attributes as Record<string, unknown> | undefined)?.branch) === 'answer',
      JSON.stringify({
        kinds: answerSteps.map((step) => String(step.kind)),
        label: decisionStep?.label ?? null,
      })
    )
    rec.check(
      '单一入口：`answer` 分支的读数是 `result=answered`（与"失败"分得开）',
      (decisionStep?.attributes as Record<string, unknown> | undefined)?.result === 'answered',
      JSON.stringify(decisionStep?.attributes ?? null)
    )

    /* ---- ⑥ 澄清 / 超时 / 抛错 / 非法提案 ⇒ 零动作且如实记 -------------------- */
    const negativeCases: readonly {
      readonly id: string
      readonly title: string
      readonly script: readonly DecisionScriptItem[]
      readonly expectFailure?: string
      readonly expectParse?: string
    }[] = [
      {
        id: 'clarify',
        title: '澄清分支 ⇒ 零动作',
        script: [{ raw: { branch: 'clarify', question: '你说的是哪个桌面？' } }],
      },
      {
        id: 'timeout',
        title: '决策超时 ⇒ 零动作（不回落关键词）',
        script: [{ fail: 'timeout' }],
        expectFailure: 'timeout',
      },
      {
        id: 'throw',
        title: '决策端口抛错 ⇒ 零动作（记 call_failed）',
        script: [{ throw: 'boom' }],
        expectFailure: 'call_failed',
      },
      {
        id: 'extrafield',
        title: '提案多一个字段 ⇒ invalid_output + 闭集码',
        script: [{ raw: { branch: 'tools', goal: 'g', steps: [], done: true, shell: 'dir' } }],
        expectFailure: 'invalid_output',
        expectParse: 'tool_decision_unknown_field',
      },
      {
        id: 'unauth',
        title: '提案里出现没登记的能力 ⇒ 拒绝（不是"执行了再拒"）',
        script: [
          {
            raw: toolsProposal([
              { capability: 'system.shell', operation: 'run', args: {} },
            ]),
          },
        ],
        expectFailure: 'invalid_output',
        expectParse: 'task_plan_step_capability_not_authorized',
      },
      {
        id: 'disabled',
        title: '提案里出现**开关关着**的能力 ⇒ 拒绝（授权集合是装配层算的）',
        script: [
          {
            raw: toolsProposal([
              {
                capability: 'local.file.write',
                operation: 'write',
                args: { path: join(localDir, 'x.txt'), content: 'x' },
              },
            ]),
          },
        ],
        expectFailure: 'invalid_output',
        expectParse: 'task_plan_step_capability_not_authorized',
      },
    ]

    for (const item of negativeCases) {
      const bed = await suite.openBed(`rp-${item.id}`)
      const decision = scriptedDecision(item.script)
      const reading = await bed.bed.say({
        options: {
          switches: { localFileRead: true, taskAutonomy: true },
          sandboxRoot: bed.dir,
          recoveryRoot: join(bed.dir, `recovery-${item.id}`),
          planner: idlePlanner(),
          toolDecision: { port: decision.port },
        },
        text: NL_QUESTION,
        replyText: '（夹具回复）',
      })
      const rows = await bed.bed.actionRows()
      const step = reading.trace.steps.find((one) => String(one.label ?? '').includes('角色决策'))
      const attributes = (step?.attributes ?? {}) as Record<string, unknown>
      rec.countInput(3)
      rec.check(
        `${item.id}：零动作（且账本里没有一条执行记录）`,
        reading.actionResults.length === 0 && rows.length === 0,
        JSON.stringify({ actionResults: reading.actionResults.length, ledgerRows: rows.length })
      )
      rec.check(
        `${item.id}：如实记在 trace 上（branch=failed 或 clarify）`,
        step !== undefined,
        JSON.stringify({ label: step?.label ?? null, attributes })
      )
      if (item.expectFailure !== undefined) {
        rec.check(
          `${item.id}：失败分桶正确（failure=${item.expectFailure}${
            item.expectParse === undefined ? '' : ` / parseFailure=${item.expectParse}`
          }）`,
          attributes.failure === item.expectFailure &&
            (item.expectParse === undefined || attributes.parseFailure === item.expectParse),
          JSON.stringify(attributes)
        )
      }
    }

    /* ---- ⑦ WP2：已知目录事实（**纯解析 + 渲染**，不 spawn） ------------------ */
    const probeFacts = parseKnownDirectoryProbe(FIXTURE_PROBE_STDOUT, { exists: () => true })
    const personal = probeFacts.find((fact) => fact.key === 'personal_desktop')
    const publicFact = probeFacts.find((fact) => fact.key === 'public_desktop')
    rec.countInput(4)
    rec.check(
      'WP2 已知目录：探测输出被如实解析，**重定向后**的真实路径被保留（含 OneDrive 那种搬家）',
      personal?.path === 'C:\\Users\\someone\\OneDrive\\Desktop' &&
        publicFact?.path === 'C:\\Users\\Public\\Desktop' &&
        personal.source === 'probe' &&
        publicFact.source === 'probe',
      JSON.stringify({ personal, public: publicFact })
    )
    rec.check(
      'WP2 已知目录：程序**不拼** `%USERPROFILE%\\Desktop` 这类猜测（只认系统 API 给的那一个）',
      probeFacts.every((fact) => fact.path === undefined || fact.path.includes('\\')) &&
        !probeFacts.some((fact) => /\buser\b|Administrator/i.test(fact.path ?? '')) &&
        personal?.path !== 'C:\\Users\\<user>\\Desktop',
      JSON.stringify(probeFacts.map((fact) => fact.path ?? '(无)'))
    )
    const missingFacts = parseKnownDirectoryProbe(FIXTURE_PROBE_STDOUT, {
      exists: (path) => path.startsWith('C:\\Users\\Public'),
    })
    rec.check(
      'WP2 已知目录：查到了但目录不在 ⇒ `probe_missing`（且**保留**查到的那条路径供排查）',
      missingFacts.find((fact) => fact.key === 'personal_desktop')?.source === 'probe_missing' &&
        missingFacts.find((fact) => fact.key === 'personal_desktop')?.path ===
          'C:\\Users\\someone\\OneDrive\\Desktop',
      JSON.stringify(missingFacts)
    )
    const garbageFacts = parseKnownDirectoryProbe('这不是探测输出\nrandom=1\npersonal_desktop=\n', {
      exists: () => true,
    })
    rec.check(
      'WP2 已知目录：输出不可解析 ⇒ **两档都是 `probe_failed`**（宁可说不知道，不许猜）',
      garbageFacts.length === KNOWN_DIRECTORY_KEYS.length &&
        garbageFacts.every((fact) => fact.source === 'probe_failed' && fact.path === undefined),
      JSON.stringify(garbageFacts)
    )
    const duplicateFirstWins = parseKnownDirectoryProbe(
      'personal_desktop=C:\\first\npersonal_desktop=C:\\second\n',
      { exists: () => true }
    ).find((fact) => fact.key === 'personal_desktop')
    const absentFacts = knownDirectoryProbeFailed('probe_absent')
    const renderedProbe = renderKnownDirectoriesForModel(probeFacts)
    const renderedFailed = renderKnownDirectoriesForModel(garbageFacts)
    rec.countInput(4)
    rec.check(
      'WP2 已知目录：同一个键出现两次 ⇒ 取第一条（保序可复现）',
      duplicateFirstWins?.path === 'C:\\first',
      JSON.stringify(duplicateFirstWins)
    )
    rec.check(
      'WP2 已知目录：`probe_absent`（没探测）与 `probe_failed`（探测失败）**分列**',
      absentFacts.every((fact) => fact.source === 'probe_absent') &&
        garbageFacts.every((fact) => fact.source === 'probe_failed'),
      JSON.stringify(describeKnownDirectories(absentFacts))
    )
    rec.check(
      'WP2 已知目录：渲染给出**真实路径**（模型可以逐字用）',
      renderedProbe.includes('C:\\Users\\someone\\OneDrive\\Desktop') &&
        renderedProbe.includes('C:\\Users\\Public\\Desktop') &&
        renderedProbe.includes('不要'),
      JSON.stringify({ chars: renderedProbe.length })
    )
    rec.check(
      'WP2 已知目录：探测失败时渲染**如实说"探测失败"**，且不给任何可猜的路径',
      renderedFailed.includes('探测失败') &&
        /* ⚠️ 判据只能是"里面没有**路径**"：header 里那句"不要用 user / Administrator"
           本身就含这两个词 —— 拿它们做扫描是量具在量错的东西（本轮第三次同型陷阱）。 */
        !/[A-Za-z]:\\/.test(renderedFailed) &&
        !renderedFailed.includes('%USERPROFILE%'),
      JSON.stringify({ chars: renderedFailed.length, hasDrivePath: /[A-Za-z]:\\/.test(renderedFailed) })
    )

    /* ---- ⑧ WP2：**实际内容回传**（真执行环重新规划时看到了什么） -------------- */
    const knownDirBlock = renderKnownDirectoriesForModel(probeFacts)
    const contentBed = await suite.openBed('rp-content')
    const contentPath = contentBed.tree.root
    const contentDecision = scriptedDecision([
      /* ⚠️ `done: false` ⇒ 执行环会在这一步之后**再规划一次**（那一次才带内容） */
      {
        raw: {
          branch: 'tools',
          goal: '先列一下这个目录',
          steps: [
            { capability: 'local.file.list', operation: 'list', args: { path: contentPath } },
          ],
          done: false,
        },
      },
    ])
    const contentPlanner = recordingPlanner()
    const contentReading = await contentBed.bed.say({
      options: {
        switches: { localFileRead: true, taskAutonomy: true },
        sandboxRoot: contentBed.dir,
        recoveryRoot: join(contentBed.dir, 'recovery-content'),
        planner: contentPlanner.planner,
        toolDecision: { port: contentDecision.port },
        knownDirectories: [knownDirBlock],
        plannerContentTokens: 2000,
      },
      text: NL_QUESTION,
      replyText: '（夹具回复）',
    })
    const replanInput = contentPlanner.inputs[0]
    const replanContent = (replanInput?.content ?? []).join('\n')
    rec.countInput(4)
    rec.check(
      'WP2 内容回传：执行环**真的重新规划了一次**（所以下面量的是"规划器看到了什么"）',
      contentPlanner.inputs.length === 1 && contentReading.actionResults.length > 0,
      JSON.stringify({
        plannerCalls: contentPlanner.inputs.length,
        actionResults: contentReading.actionResults.length,
      })
    )
    rec.check(
      'WP2 内容回传：重新规划时拿到的是**实际内容**（目录条目名在），不是 `path=…=success`',
      replanContent.includes('notes-cn.txt') && replanContent.includes('目录：'),
      JSON.stringify({ chars: replanContent.length, sample: replanContent.slice(0, 160) })
    )
    rec.check(
      'WP2 内容回传：内容与"注入 prompt 的那一份"**同源**（规划器看到的是整段正文，不是摘要）',
      contentReading.turnContent.length > 0 &&
        (replanInput?.content ?? []).some((line) => line.includes(contentReading.turnContent[0]!.text)),
      JSON.stringify({
        items: contentReading.turnContent.length,
        textChars: contentReading.turnContent[0]?.text.length ?? null,
      })
    )
    rec.check(
      'WP2 内容回传：规划器同时拿到**程序给出的已知目录事实**（个人 / 公共桌面）',
      (replanInput?.knownDirectories ?? []).join('\n').includes('OneDrive\\Desktop'),
      JSON.stringify({ knownDirs: (replanInput?.knownDirectories ?? []).length })
    )

    /* 七份不同内容后仍需重新规划：不得在已执行后因内容条数异常丢失全部结果。 */
    const overflowBed = await suite.openBed('rp-replan-overflow')
    const overflowPaths = Array.from({ length: 7 }, (_, index) => {
      const path = join(overflowBed.tree.root, `replan-${String(index)}.txt`)
      writeFileSync(path, `REPLAN-CONTENT-${String(index)}`, 'utf8')
      return path
    })
    const overflowDecision = scriptedDecision([{
      raw: {
        branch: 'tools',
        goal: '读七份文件后检查结果',
        steps: overflowPaths.map((path) => ({
          capability: 'local.file.read', operation: 'read', args: { path },
        })),
        done: false,
      },
    }])
    const overflowPlanner = recordingPlanner()
    const overflowReading = await overflowBed.bed.say({
      options: {
        switches: { localFileRead: true, taskAutonomy: true },
        sandboxRoot: overflowBed.dir,
        recoveryRoot: join(overflowBed.dir, 'recovery-overflow'),
        planner: overflowPlanner.planner,
        toolDecision: { port: overflowDecision.port },
        plannerContentTokens: 2000,
      },
      text: '请读取这七份文件，并检查结果。',
      replyText: '（夹具回复）',
    })
    const overflowContent = (overflowPlanner.inputs[0]?.content ?? []).join('\n')
    rec.countInput(7)
    rec.check(
      '重新规划：七份不同内容之后仍返回全部七个成功动作，并完成下一次规划',
      overflowReading.actionResults.length === 7 &&
        overflowReading.actionResults.every((item) => item.result?.status === 'success') &&
        overflowPlanner.inputs.length === 1,
      JSON.stringify({ actions: overflowReading.actionResults.length, replans: overflowPlanner.inputs.length })
    )
    rec.check(
      '重新规划：有界内容保留最新结果，不再携带最早的过期结果',
      overflowContent.includes('REPLAN-CONTENT-6') && !overflowContent.includes('REPLAN-CONTENT-0'),
      JSON.stringify({ chars: overflowContent.length })
    )

    /* 额度 0 的对照：同一场景、只把额度改成 0 ⇒ **一份内容都不带** */
    const zeroBed = await suite.openBed('rp-content0')
    const zeroDecision = scriptedDecision([
      {
        raw: {
          branch: 'tools',
          goal: '先列一下这个目录',
          steps: [
            { capability: 'local.file.list', operation: 'list', args: { path: zeroBed.tree.root } },
          ],
          done: false,
        },
      },
    ])
    const zeroPlanner = recordingPlanner()
    await zeroBed.bed.say({
      options: {
        switches: { localFileRead: true, taskAutonomy: true },
        sandboxRoot: zeroBed.dir,
        recoveryRoot: join(zeroBed.dir, 'recovery-content0'),
        planner: zeroPlanner.planner,
        toolDecision: { port: zeroDecision.port },
        knownDirectories: [knownDirBlock],
        plannerContentTokens: 0,
      },
      text: NL_QUESTION,
      replyText: '（夹具回复）',
    })
    const zeroInput = zeroPlanner.inputs[0]
    rec.countInput(2)
    rec.check(
      'WP2 内容回传：额度 **0** ⇒ 重新规划**一份内容都不带**（"接了线但额度为 0"是一个真实配置）',
      zeroInput !== undefined &&
        (zeroInput.content === undefined || zeroInput.content.length === 0),
      JSON.stringify({ content: zeroInput?.content?.length ?? null })
    )
    rec.check(
      'WP2 内容回传：额度 0 时**已知目录事实照旧**（两件事各有各的开关）',
      (zeroInput?.knownDirectories ?? []).join('\n').includes('OneDrive\\Desktop'),
      JSON.stringify({ knownDirs: (zeroInput?.knownDirectories ?? []).length })
    )

    /* ---- ⑨ WP2：决策器也拿到同一份已知目录事实 ------------------------------ */
    const factsBed = await suite.openBed('rp-facts')
    const factsDecision = scriptedDecision([{ raw: { branch: 'answer' } }])
    await factsBed.bed.say({
      options: {
        switches: { localFileRead: true, taskAutonomy: true },
        sandboxRoot: factsBed.dir,
        recoveryRoot: join(factsBed.dir, 'recovery-facts'),
        planner: idlePlanner(),
        toolDecision: { port: factsDecision.port },
        knownDirectories: [knownDirBlock],
      },
      text: NL_QUESTION,
      replyText: '（夹具回复）',
    })
    const decisionFacts = (factsDecision.inputs[0]?.knownDirectories ?? []).join('\n')
    rec.countInput(1)
    rec.check(
      'WP2：决策器与规划器拿到的是**同一份**已知目录渲染（一处产出、两处消费）',
      decisionFacts.includes('C:\\Users\\someone\\OneDrive\\Desktop') &&
        decisionFacts === knownDirBlock,
      JSON.stringify({ chars: decisionFacts.length })
    )


    const catalogBed = await suite.openBed('rp-catalog')
    const catalogDecision = scriptedDecision([{ raw: { branch: 'answer' } }])
    await catalogBed.bed.say({
      options: {
        switches: { localFileRead: true, localFileWrite: false, taskAutonomy: true },
        sandboxRoot: catalogBed.dir,
        recoveryRoot: join(catalogBed.dir, 'recovery-catalog'),
        planner: idlePlanner(),
        toolDecision: { port: catalogDecision.port },
      },
      text: NL_QUESTION,
      replyText: '（夹具回复）',
    })
    const catalogText = catalogDecision.inputs[0]?.catalog ?? ''
    const writeLine = catalogText
      .split('\n')
      .find((line) => line.trim().startsWith('- local.file.write')) ?? ''
    const writeBlock = catalogText.split('- local.file.write')[1]?.split('\n- ')[0] ?? ''
    rec.countInput(2)
    rec.check(
      '目录真相：`local.file.write` 在写入开关关闭时被标成"未开启"（程序说的，不是模型猜的）',
      writeLine !== '' && writeBlock.includes('未开启'),
      JSON.stringify({ line: writeLine.trim(), block: writeBlock.replace(/\s+/g, ' ').trim() })
    )
    rec.check(
      '目录真相：同一行同时标出"未授权"（两个状态**分列**，不合并成一个"不可用"）',
      writeBlock.includes('未授权'),
      JSON.stringify({ block: writeBlock.replace(/\s+/g, ' ').trim() })
    )
  } finally {
    await suite.dispose()
  }

  const dbAfter = realDbFingerprint()
  rec.countInput(1)
  rec.check(
    '真实库未被打开：`data/pglite` 的文件数与最新 mtime 前后逐字相同',
    JSON.stringify(dbBefore) === JSON.stringify(dbAfter),
    JSON.stringify({ before: dbBefore, after: dbAfter })
  )

  const group = rec.finish('WP1 角色决策路径（真网关 + 真执行环 + fixture 决策端口）')
  log(`[role-tool:path] ${group.id} ${group.status}（${String(group.measuredCount)} 条输入）`)
  for (const item of group.cases) {
    log(`[role-tool:path]   ${item.status === 'PASS' ? '·' : '×'} ${item.title}`)
    if (item.status === 'FAIL') log(`[role-tool:path]     observed = ${String(item.observed)}`)
  }

  if (cli.writeEvidence) {
    const sourceHashes: Record<string, string> = {}
    for (const file of SOURCE_FILES) {
      const full = join(REPO_ROOT, file)
      if (!existsSync(full)) continue
      sourceHashes[file] = createHash('sha256').update(readFileSync(full)).digest('hex')
    }
    const evidence = {
      schemaVersion: 'role-tool-decision-path@1',
      runId,
      label: cli.label,
      wp: ['WP1-path'],
      head: git(['rev-parse', 'HEAD']),
      headShort: git(['rev-parse', '--short=12', 'HEAD']),
      branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
      startedAt,
      endedAt: new Date().toISOString(),
      sourceHashes,
      realDb: { before: dbBefore, after: dbAfter },
      /** ⚠️ 本门**不调模型**：它量的是"提案怎么被处理"，不是"模型会不会好好提案" */
      modelCalls: 0,
      group,
    }
    writeFileSync(join(runDir, 'wp1-role-path.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
    log(`[role-tool:path] runId = ${runId}`)
    log(`[role-tool:path] 证据 = ${EVIDENCE_PARENT}/${runId}/wp1-role-path.json`)
  }
  log(`[role-tool:path] overall = ${group.status === 'PASS' ? 'PASS' : 'NOT PASS'}`)
  return group.status === 'PASS' ? 0 : 1
}

process.exit(await main())
