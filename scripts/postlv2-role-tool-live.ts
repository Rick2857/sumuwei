/**
 * 角色自选工具（Role-Tool-Decision）· **隔离真实链**（真模型 · 真网关 · 真适配器 · 真账本）。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * 计划书 §6 WP4 的"隔离真实链"；设计
 * [`ADR-104`](../../docs/adr/ADR-104-role-tool-decision.md) `D03`/`D05`/`D07`。
 *
 * ```bash
 * pnpm with-test-model pnpm postlv2:role-tool:live
 * ```
 *
 * ============================================================================
 *  它与另外两支的分工（**三支互不替代**）
 * ============================================================================
 * ```text
 * `postlv2:role-tool:path` / `:matrix`  离线：决策端口是**脚本夹具** ⇒ 量"提案怎么被处理"
 * `postlv2:role-tool:semantic:eval`     真模型，但**不执行**：量"她选得对不对"
 * 本支                                   真模型 **且** 真执行：量"选完之后世界真的被改了吗、
 *                                       回复绑的是不是真实结果、账本能不能对上"
 * ```
 * ⚠️ 三处安全边界：
 * ```text
 * ① 必须经 `with-test-model`（`DSH_TEST_MODEL_WRAPPER=1`）⇒ 不烧生产 key
 * ② 库是 `Suite` 的**隔离库**（不是生产库；真实库只比摘要，从不打开）
 * ③ 动作只发生在临时目录：合成树（%TEMP%）与动作沙箱（隔离目录）
 * ```
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
} from '../src/kernel/action/capability-registry.ts'
import { createExternalEvidenceCapabilityDefinitions } from '../src/kernel/action/external-evidence-capability.ts'
import { createUtilityCapabilityDefinitions } from '../src/kernel/action/utility-capabilities.ts'
import { createLocalFileCapabilityDefinitions } from '../src/kernel/action/local-file-capabilities.ts'
import { createWeatherCapabilityDefinitions } from '../src/kernel/action/weather-capability.ts'
import { createOfficeCapabilityDefinitions } from '../src/kernel/action/office-capability.ts'
import { createNewsCapabilityDefinitions } from '../src/kernel/action/news-capability.ts'
import { createBrowserCapabilityDefinitions } from '../src/kernel/action/browser-capability.ts'
import { createOpenAiTaskPlanner } from '../src/infrastructure/model/openai-task-planner.ts'
import { createOpenAiToolDecisionPort } from '../src/infrastructure/model/openai-tool-decision.ts'

import { Suite } from './productivity-skills/groups.ts'
import { GroupRecorder, type VerifyContext } from './productivity-skills/reading.ts'
import { contentOf, resultOf, type ProductivityReading } from './productivity-skills/assembly.ts'

const REPO_ROOT = resolve(process.cwd())
const EVIDENCE_PARENT = 'artifacts/post-lv2/role-tool-decision'
const REAL_DB = join(REPO_ROOT, 'data', 'pglite')

function git(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/** 真实库的**只读**摘要（只 readdir + 文件名哈希；打开会写 WAL，见 INV-DB-02） */
function realDbDigest(): string {
  if (!existsSync(REAL_DB)) return 'absent'
  const names: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else names.push(path)
    }
  }
  walk(REAL_DB)
  names.sort()
  return createHash('sha256').update(names.join('|')).digest('hex').slice(0, 16)
}

/**
 * 决策读数（**闭集码**）从轮次 trace 的那一步读回。
 *
 * ⚠️ 两种情形落在**同一个 kind** 上，但标签不同：
 *   · 动过手的轮次 ⇒ 既有 `action_dispatch` 步（"动作分发（…）"），读数挂在它的属性上
 *   · 什么都没做的轮次 ⇒ 同 kind、标签带"角色决策：不动作"
 * ⇒ 判据是"**属性里有 `decision`**"，不是"标签含某个词"
 *   （第一版按标签找，于是在 L1 那条**成功执行**的轮次上找不到 ⇒ 那是本支自己的量具缺陷）。
 * 兜底：`actionResults[0].diagnostics`（同一份读数，执行面也带着）。
 */
function decisionAttributesOf(reading: ProductivityReading): Record<string, unknown> {
  for (const step of reading.trace.steps) {
    const attributes = (step.attributes ?? {}) as Record<string, unknown>
    if (attributes.decision !== undefined || attributes.tool_decision === 'role') {
      /*
       * ⚠️ 两种记录形状的**归一**：动过手的那一步用 `decision`，没动的那一步用 `branch`
       *    （后者是 `roleDiagnostics()` 原样落盘的形状）。归一放在量具里，
       *    否则每一条判据都要自己兼容两种键 —— 那正是判据长歪的方式。
       */
      const branch = attributes.branch ?? attributes.decision
      return { ...attributes, ...(branch !== undefined ? { branch } : {}) }
    }
  }
  const fallback = reading.actionResults[0]?.diagnostics
  return (fallback ?? {}) as Record<string, unknown>
}

async function main(): Promise<number> {
  if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') {
    process.stderr.write(
      '❌ 拒绝运行：本支要调真实模型并真的执行动作，必须经测试包装器：\n' +
        '   pnpm with-test-model pnpm postlv2:role-tool:live\n'
    )
    return 2
  }

  const startedAt = new Date().toISOString()
  const dbBefore = realDbDigest()
  const stamp = startedAt.replace(/[-:]/g, '').replace(/\..+$/, '')
  const runId = `role-tool-live-${stamp}-${git(['rev-parse', '--short=8', 'HEAD']) || 'unknown'}`
  const runDir = join(REPO_ROOT, EVIDENCE_PARENT, runId)
  const localDir = join(REPO_ROOT, 'artifacts/post-lv2/local/role-tool-decision', runId)
  mkdirSync(runDir, { recursive: true })
  mkdirSync(localDir, { recursive: true })

  const log = (message: string): void => {
    process.stdout.write(`${message}\n`)
  }
  const ctx: VerifyContext = { only: ['common'], fixturesDir: join(localDir, 'fixtures'), runDir, localDir, log }
  const suite = new Suite(ctx)
  const rec = new GroupRecorder('wp4-live-chain')

  const registry = createCapabilityRegistry([
    ...createDefaultCapabilityDefinitions(),
    ...createExternalEvidenceCapabilityDefinitions(),
    ...createUtilityCapabilityDefinitions(),
    ...createLocalFileCapabilityDefinitions(),
    ...createWeatherCapabilityDefinitions(),
    ...createOfficeCapabilityDefinitions(),
    ...createNewsCapabilityDefinitions(),
    ...createBrowserCapabilityDefinitions(),
  ])
  const decisionPort = createOpenAiToolDecisionPort({ timeoutMs: 20_000 })
  const planner = createOpenAiTaskPlanner({ registry })

  log(`[role-tool:live] 决策端点=${decisionPort.endpointHost}（经 with-test-model）`)
  log(`[role-tool:live] 真实库（只比摘要，从不打开）：${dbBefore}`)

  try {
    const bed = await suite.openBed('live')
    const treeRoot = bed.tree.root
    const switches = { localFileRead: true, localFileWrite: true, taskAutonomy: true }
    const base = {
      sandboxRoot: bed.bed.sandboxRoot,
      recoveryRoot: bed.bed.recoveryRoot,
      switches,
      planner,
      turnContentTokens: 2000,
      plannerContentTokens: 2000,
      toolDecision: { port: decisionPort },
    }

    /*
     * ======================================================================
     *  L1：**该用工具**的一句真话 ⇒ 她真的选、真的执行、账本对得上
     * ====================================================================
     * ⚠️ 目录是合成树（`%TEMP%`），不是用户的真实桌面：这一档量的是"真实链通不通"，
     *    不是"她认不认得桌面"（后者由 `:known-dirs` 与语义评估量）。
     */
    const l1 = await bed.bed.say({
      options: base,
      text: `帮我看看这个目录里有哪些文件：${treeRoot}`,
      replyText: '（夹具回复：这一条量的是动作，不是措辞）',
    })
    const l1Result = resultOf(l1, 'local.file.list')
    const l1Content = contentOf(l1, 'local.file.list')
    const l1Decision = decisionAttributesOf(l1)
    const l1Rows = (await bed.bed.actionRows()).filter(
      (row) => String(row.capability) === 'local.file.list'
    )
    rec.countInput(5)
    rec.check(
      'L1 真实链：她**真的选了**工具（决策读数 branch=tools）',
      l1Decision.branch === 'tools',
      JSON.stringify(l1Decision)
    )
    rec.check(
      'L1 真实链：动作**真的被执行**（适配器被调用且成功）',
      l1Result?.status === 'success' && l1Result.executed === true,
      JSON.stringify({ status: l1Result?.status ?? null, executed: l1Result?.executed ?? null })
    )
    rec.check(
      'L1 真实链：**真实内容**回到轮次（含合成树里的真实文件名）',
      (l1Content?.text ?? '').includes('notes-cn.txt'),
      JSON.stringify({ chars: l1Content?.text.length ?? 0 })
    )
    rec.check(
      'L1 真实链：账本里有对应的一条执行记录（Level 2 证据）',
      l1Rows.length >= 1,
      JSON.stringify({ rows: l1Rows.length, statuses: l1Rows.map((row) => String(row.status)) })
    )
    rec.check(
      'L1 真实链：那份内容**真的进了 prompt**（turn-content section 含文件名）',
      l1.sectionOf('turn-content').includes('notes-cn.txt'),
      JSON.stringify({ sectionChars: l1.sectionOf('turn-content').length })
    )

    /* ---- L2：闲聊 ⇒ **零动作**（真实链上也要证"不该动就不动"） ---- */
    const l2 = await bed.bed.say({
      options: base,
      text: '今天有点累，随便聊两句吧。',
      replyText: '（夹具回复）',
    })
    rec.countInput(2)
    rec.check(
      'L2 真实链：闲聊 ⇒ 决策 branch=answer 且**零动作**',
      decisionAttributesOf(l2).branch === 'answer' && l2.actionResults.length === 0,
      JSON.stringify({
        decision: decisionAttributesOf(l2),
        actions: l2.actionResults.length,
      })
    )
    rec.check(
      'L2 真实链：账本里**没有**新增执行记录',
      (await bed.bed.actionRows()).filter((row) => String(row.capability) === 'local.file.list')
        .length === l1Rows.length,
      '与 L1 之后的条数比较'
    )

    /* ---- L3：指代不明 ⇒ 问一句（真实链上量"不许猜"） ---- */
    const l3 = await bed.bed.say({
      options: base,
      text: '帮我把它整理一下。',
      replyText: '（夹具回复）',
    })
    const l3Decision = decisionAttributesOf(l3)
    rec.countInput(2)
    rec.check(
      'L3 真实链：指代不明 ⇒ **零动作**（clarify 或 answer，不许猜一个目标就动手）',
      l3.actionResults.length === 0,
      JSON.stringify({ decision: l3Decision, actions: l3.actionResults.length })
    )
    rec.check(
      'L3 真实链：决策读数如实留在 trace 上（可查是哪一支）',
      typeof l3Decision.branch === 'string',
      JSON.stringify(l3Decision)
    )

    /* ---- L5：目录发现 → 两份输入 → 精确计算 → 写入 → 读回（真模型选顺序） ---- */
    const inputDir = join(treeRoot, 'orchestration-inputs')
    mkdirSync(inputDir)
    const inputA = join(inputDir, 'measurement-a.txt')
    const inputB = join(inputDir, 'measurement-b.txt')
    const output = join(treeRoot, 'orchestration-total.txt')
    writeFileSync(inputA, 'a=347', 'utf8')
    writeFileSync(inputB, 'b=829', 'utf8')
    const l5 = await bed.bed.say({
      options: { ...base, switches: { ...switches, math: true } },
      text: `帮我先列出 ${inputDir}，读取找到的两份测量记录，使用 math.calculate 计算 a*b，把结果写到 ${output}，内容单独一行 TOTAL=计算结果；然后读回核对。`,
      replyText: '（夹具回复：独立检查产物与账本，不评价措辞）',
    })
    const l5Actions = l5.actionResults.filter(({ request }) => request !== undefined)
    const readInputs = l5Actions.filter(({ request, result }) => request?.capability === 'local.file.read' && result?.status === 'success' && [inputA, inputB].includes(String(request.arguments.path)))
    const calculationIndex = l5Actions.findIndex(({ request }) => request?.capability === 'math.calculate')
    const writeIndex = l5Actions.findIndex(({ request }) => request?.capability === 'local.file.write')
    const verifyIndex = l5Actions.findIndex(({ request }) => request?.capability === 'local.file.read' && request.arguments.path === output)
    rec.countInput()
    rec.check('L5 输入依赖：先列目录，再读两份真实输入，最后才计算', l5Actions[0]?.request?.capability === 'local.file.list' && readInputs.length === 2 && calculationIndex > 2 && readInputs.every((item) => l5Actions.indexOf(item) < calculationIndex), `readInputs=${String(readInputs.length)} calculationIndex=${String(calculationIndex)}`)
    rec.check('L5 产物依赖：计算后写入，写入成功后读回', writeIndex > calculationIndex && verifyIndex > writeIndex && l5Actions.every(({ result }) => result?.status === 'success'), JSON.stringify({ calculate: calculationIndex, write: writeIndex, verify: verifyIndex, actions: l5Actions.map(({ request, result }) => ({ capability: request?.capability, status: result?.status, failure: result?.error?.code })) }))
    rec.check('L5 Level 1：独立读文件，产物等于真实计算结果', existsSync(output) && readFileSync(output, 'utf8').trim() === 'TOTAL=287663', `outputExists=${String(existsSync(output))}`)
    const l5Ledger = (await bed.bed.actionRows()).filter((row) => String(row.traceId) === String(l5.trace.traceId))
    rec.check('L5 Level 2：组合步骤同 trace，账本逐项对应', l5Ledger.length === l5Actions.length && l5Actions.length >= 6 && l5Actions.every(({ request }) => request?.traceId === l5.trace.traceId), `actions=${String(l5Actions.length)} ledger=${String(l5Ledger.length)}`)

    /* ---- L6：失败反馈 → 真模型选择已授权备用输入 → 产物读回 ---- */
    const fallback = join(treeRoot, 'orchestration-backup.txt')
    const recoveryOutput = join(treeRoot, 'orchestration-recovery.txt')
    writeFileSync(fallback, 'RECOVERY-VALUE=179', 'utf8')
    const l6 = await bed.bed.say({
      options: base,
      text: `帮我先读取 ${fallback}.missing，只有读取失败时才改读备用文件 ${fallback}；将实际读到的内容原样写入 ${recoveryOutput}，然后读回核对。`,
      replyText: '（夹具回复）',
    })
    const l6Actions = l6.actionResults.filter(({ request }) => request !== undefined)
    rec.countInput()
    rec.check('L6 真实失败仍保留，备用步骤在失败之后执行', l6Actions[0]?.request?.arguments.path === `${fallback}.missing` && l6Actions[0]?.result?.status !== 'success' && l6Actions[1]?.request?.arguments.path === fallback && l6Actions[1]?.result?.status === 'success', `statuses=${l6Actions.map(({ result }) => result?.status).join(',')}`)
    rec.check('L6 Level 1：恢复产物包含真实备用输入', existsSync(recoveryOutput) && readFileSync(recoveryOutput, 'utf8').trim() === 'RECOVERY-VALUE=179', `outputExists=${String(existsSync(recoveryOutput))}`)
    rec.check('L6 恢复后读回，所有步骤仍共享原任务归因', l6Actions.some(({ request, result }) => request?.capability === 'local.file.read' && request.arguments.path === recoveryOutput && result?.status === 'success') && l6Actions.every(({ request }) => request?.traceId === l6.trace.traceId), `actions=${String(l6Actions.length)}`)

    /* ---- L4：真实库未被打开（前后摘要逐字相同） ---- */
    const dbAfter = realDbDigest()
    rec.countInput(1)
    rec.check(
      'L4 真实库未被打开：`data/pglite` 的文件摘要前后逐字相同',
      dbBefore === dbAfter,
      JSON.stringify({ before: dbBefore, after: dbAfter })
    )

    const group = rec.finish('WP4 隔离真实链（真模型决策 + 真网关执行 + 真账本）')
    log(`[role-tool:live] ${group.id} ${group.status}（${String(group.measuredCount)} 条输入）`)
    for (const item of group.cases) {
      log(`[role-tool:live]   ${item.status === 'PASS' ? '·' : '×'} ${item.title}`)
      if (item.status !== 'PASS') log(`[role-tool:live]     observed = ${String(item.observed)}`)
    }

    writeFileSync(
      join(runDir, 'live-chain.json'),
      `${JSON.stringify(
        {
          schemaVersion: 'role-tool-decision-live@1',
          runId,
          head: git(['rev-parse', 'HEAD']),
          startedAt,
          endedAt: new Date().toISOString(),
          endpointHost: decisionPort.endpointHost,
          model: (process.env.OPENAI_SMALL_MODEL ?? '').trim() || '(缺省)',
          sourceHashes: Object.fromEntries([
            'src/infrastructure/model/task-orchestration-instructions.ts',
            'src/infrastructure/model/openai-task-planner.ts',
            'src/infrastructure/model/openai-tool-decision.ts',
            'src/kernel/action/task-loop.ts',
            'src/infrastructure/action/adapters/math-calculate.ts',
            'src/infrastructure/action/adapters/math-calculate-worker.ts',
            'scripts/postlv2-role-tool-live.ts',
            'scripts/productivity-skills/assembly.ts',
          ].map((path) => [path, createHash('sha256').update(readFileSync(join(REPO_ROOT, path))).digest('hex')])),
          isolation: {
            kind: 'suite-isolated-db',
            note: '隔离库 + 合成树；真实库只比摘要，从不打开',
          },
          realDb: { before: dbBefore, after: dbAfter },
          group,
          decisions: {
            l1: decisionAttributesOf(l1),
            l2: decisionAttributesOf(l2),
            l3: decisionAttributesOf(l3),
          },
          orchestrationActions: Object.fromEntries(
            Object.entries({ l5: l5Actions, l6: l6Actions }).map(([id, actions]) => [id, actions.map(({ request, result }) => ({
              actionId: request?.actionId, traceId: request?.traceId, capability: request?.capability,
              operation: request?.operation, status: result?.status, failure: result?.error?.code,
            }))])
          ),
        },
        null,
        2
      )}\n`,
      'utf8'
    )
    log(`[role-tool:live] 证据 = ${EVIDENCE_PARENT}/${runId}/live-chain.json`)
    log(`[role-tool:live] overall = ${group.status === 'PASS' ? 'PASS' : 'NOT PASS'}`)
    return group.status === 'PASS' ? 0 : 1
  } finally {
    await suite.dispose()
  }
}

process.exit(await main())
