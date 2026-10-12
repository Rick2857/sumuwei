/**
 * 公共 8 组（第二批计划 §6A 的表格逐字）。
 *
 * ```text
 * ① 默认关闭/授权     ② 旧聊天与第一批兼容   ③ 目标/路径域事实      ④ 正文/token 隐私与来源资格
 * ⑤ 预算/实际入模     ⑥ 取消/迟到           ⑦ 任务归因/操作范围与风险  ⑧ 量具正控/负控/恢复与非空计数
 * ```
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'

import { newActionId, newTraceId } from '../../src/kernel/contracts/ids.ts'
import {
  aggregateTurnContentForTurn,
  selectTurnContentContext,
  validateTurnContentList,
  type TurnContent,
} from '../../src/kernel/contracts/turn-content.ts'
import { createActionRequest } from '../../src/kernel/action/action-request.ts'
import { evaluateActionPolicy } from '../../src/kernel/action/policy.ts'
import { inspectLocalPath } from '../../src/kernel/action/local-path.ts'
import { resolveLocalTarget } from '../../src/kernel/action/local-target.ts'
import { extractLocalPathTokens } from '../../src/kernel/action/local-file-intent.ts'
import { looksLikeTask } from '../../src/kernel/action/task-intent.ts'
import { createTaskAuthorizationRegistry } from '../../src/kernel/action/task-authorization.ts'
import { validateTaskPlan } from '../../src/kernel/action/task-plan.ts'
import {
  createCapabilityRegistry,
  createDefaultCapabilityDefinitions,
} from '../../src/kernel/action/capability-registry.ts'
import { createLocalFileCapabilityDefinitions } from '../../src/kernel/action/local-file-capabilities.ts'
import { createWeatherCapabilityDefinitions } from '../../src/kernel/action/weather-capability.ts'
import { createOfficeCapabilityDefinitions } from '../../src/kernel/action/office-capability.ts'
import { createNewsCapabilityDefinitions } from '../../src/kernel/action/news-capability.ts'
import { createBrowserCapabilityDefinitions } from '../../src/kernel/action/browser-capability.ts'
import { createUtilityCapabilityDefinitions } from '../../src/kernel/action/utility-capabilities.ts'
import { createExternalEvidenceCapabilityDefinitions } from '../../src/kernel/action/external-evidence-capability.ts'

import {
  contentOf,
  resultOf,
  scriptedPlanner,
  unresolvedInvocation,
  type ProductivitySwitches,
  type ProductivityTurnOptions,
} from './assembly.ts'
import { GroupRecorder } from './reading.ts'
import type { BedEntry, GroupRunner, Suite } from './groups.ts'
import type { GroupReading, VerifyContext } from './reading.ts'

const SENTINEL = 'LGSENTINEL-DO-NOT-PERSIST-9F3A'

/**
 * 一份**合法**的 `local-text` 当轮内容夹具（用于汇聚层的纯函数检查）。
 *
 * ⚠️ 它是手搓的，但必须过 `validateTurnContent` 那套逐份断言 —— 否则下面
 *    "契约没被改弱"的对照就量错了对象。
 */
function localListFixture(
  contentId: string,
  resourceRef: string,
  resultFingerprint: string
): TurnContent {
  const text = `目录：${resourceRef}\n（夹具）`
  return {
    contentId,
    kind: 'local-text',
    capability: 'local.file.list',
    operation: 'list',
    sourceKind: 'local-disk',
    resourceRef,
    resultFingerprint,
    scope: { totalChars: text.length, includedChars: text.length, truncated: false },
    facts: ['（验收夹具）'],
    text,
    mediaType: 'text/x-directory-listing',
    lineCount: text.split('\n').length,
    sourceBytes: text.length,
  }
}

function switchesLine(switches: ProductivitySwitches): readonly (readonly [string, boolean])[] {
  return [
    ['local.file.list', switches.localFileRead === true],
    ['local.file.read', switches.localFileRead === true],
    ['local.file.write', switches.localFileWrite === true],
    ['weather.query', switches.weather === true],
    ['office.generate', switches.office === true && switches.localFileWrite === true],
    ['news.read', switches.news === true],
    ['browser.read', switches.browser === true],
    ['browser.operate', switches.browser === true],
  ]
}

const PERMISSION_OF: Readonly<Record<string, string>> = {
  'local.file.list': 'local-file:list',
  'local.file.read': 'local-file:read',
  'local.file.write': 'local-file:write',
  'weather.query': 'weather:query',
  'office.generate': 'office:generate',
  'news.read': 'news:read',
  'browser.read': 'browser:read',
  'browser.operate': 'browser:operate',
}

/**
 * 授予某能力时需要**全部**哪些权限。
 *
 * ⚠️ `office.generate` 需要**两条**（矩阵逐字：`office:generate` + `local-file:write`）——
 *    这正是"生成"与"落盘"分别可关那条边界。只给一条仍会 `missing_permission`，
 *    而那是**正确**行为（本表的作用就是让断言知道这件事）。
 */
const GRANTS_FOR: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(Object.entries(PERMISSION_OF).map(([key, value]) => [key, [value]])),
  'office.generate': ['office:generate', 'local-file:write'],
}

// ---------------------------------------------------------------------------
// common-01 默认关闭 / 授权
// ---------------------------------------------------------------------------

const common01: GroupRunner = {
  id: 'common-01',
  async run(ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('common-01')
    const entry = await suite.openBed('common-01')
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
    void ctx

    for (const [capability, enabled] of switchesLine({})) {
      rec.countInput()
      const definition = registry.get(capability)
      /*
       * ① **恒登记**：关闭的能力也在登记表里（于是"没启用"是一条可审计的事实，
       *    而不是"装作没听懂"）。
       */
      rec.check(
        `${capability}：能力恒登记（关闭时也在表里）`,
        definition !== undefined,
        definition === undefined ? '登记表里没有它' : `${definition.version} risk=${definition.riskLevel}`
      )
      const operation = definition?.operations[0]
      if (definition === undefined || operation === undefined) continue
      /*
       * ② 开关关闭 ⇒ 装配层**不授予**权限 ⇒ 策略第 ③ 步拒绝（`missing_permission`）。
       *    这里直接跑策略（不跑网关）：判据是"权限不足"，而它正是装配层按开关决定的那件事。
       */
      const request = createActionRequest({
        actionId: newActionId(),
        traceId: newTraceId(),
        capability,
        operation: operation.name,
        requestedBy: { kind: 'user' },
        arguments: {},
        sideEffect: operation.sideEffect,
      })
      const decision = evaluateActionPolicy({
        request,
        definition,
        operation,
        targetConfidence: 'exact',
        scopeViolation: false,
        grantedPermissions: [
          'system:echo',
          'sandbox:read',
          'sandbox:write',
        ],
        maxRiskLevel: 'R1',
        dryRun: false,
      })
      rec.check(
        `${capability}：开关关闭 ⇒ 权限拒绝（可审计）`,
        decision.code === 'missing_permission',
        `code=${decision.code} enabled=${String(enabled)}`
      )
      /*
       * ③ 开关打开（权限已授予）⇒ 这一层**不再**是权限问题。
       *    预算是 R1 ⇒ `browser.operate`（R2）在这里仍被风险上限拒绝 —— 那是**如实**的，
       *    也正是公共第 ⑦ 组要测的那一条。因此这一条只断言"不是 missing_permission"。
       */
      const granted = [...GRANTS_FOR[capability]!, 'system:echo', 'sandbox:read', 'sandbox:write']
      const opened = evaluateActionPolicy({
        request,
        definition,
        operation,
        targetConfidence: 'exact',
        scopeViolation: false,
        grantedPermissions: granted,
        maxRiskLevel: 'R2',
        dryRun: false,
      })
      rec.check(
        `${capability}：权限授予后不再是 missing_permission`,
        opened.code !== 'missing_permission',
        `code=${opened.code}`
      )
    }

    rec.note('登记的能力数', registry.list().length)
    rec.note('开关关闭时的权限拒绝条数', rec.measured)
    void entry
    return rec.finish('默认关闭 / 授权')
  },
}

// ---------------------------------------------------------------------------
// common-02 旧聊天与第一批兼容
// ---------------------------------------------------------------------------

const common02: GroupRunner = {
  id: 'common-02',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('common-02')
    const entry = await suite.openBed('common-02')

    // ① 旧沙箱相对路径读回（M4.5 的行为逐字不变）
    const name = 'notes-cn.txt'
    const insidePath = entry.bed.sandboxRoot
    // 先把一份合成文件放进沙箱（M4.5 的相对路径域）
    const { mkdirSync, copyFileSync } = await import('node:fs')
    mkdirSync(insidePath, { recursive: true })
    copyFileSync(entry.tree.files[0]!, `${insidePath}/${name}`)
    const readOutcome = await entry.bed.say({
      options: {
        switches: {},
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
      },
      text: `读一下 ${name}`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    const sandboxResult = resultOf(readOutcome, 'sandbox.file.read')
    rec.check(
      '旧路径：沙箱内相对路径仍可读（M4.5 行为不变）',
      sandboxResult !== undefined && sandboxResult.status === 'success',
      `status=${sandboxResult?.status ?? '(没有动作)'}`
    )
    rec.check(
      '旧路径：结果形状仍是"只返回字节数 / 指纹"（**不带正文**）',
      sandboxResult?.effect?.kind === 'content_read' &&
        sandboxResult.turnContent === undefined,
      `effect=${sandboxResult?.effect?.kind ?? '(无)'} turnContent=${String(sandboxResult?.turnContent !== undefined)}`
    )

    // ② 旧沙箱的**措辞**逐字不变（缺省 = 沙箱那三句）
    const registry = createCapabilityRegistry([
      ...createDefaultCapabilityDefinitions(),
      ...createLocalFileCapabilityDefinitions(),
    ])
    const sandboxDef = registry.get('sandbox.file.read')!
    const sandboxOp = sandboxDef.operations[0]!
    const sandboxDecision = evaluateActionPolicy({
      request: createActionRequest({
        actionId: newActionId(),
        traceId: newTraceId(),
        capability: 'sandbox.file.read',
        operation: 'read',
        requestedBy: { kind: 'user' },
        arguments: { path: 'a.txt' },
        sideEffect: 'read',
      }),
      definition: sandboxDef,
      operation: sandboxOp,
      targetConfidence: 'exact',
      scopeViolation: false,
      grantedPermissions: ['sandbox:read'],
      maxRiskLevel: 'R1',
      dryRun: false,
    })
    rec.countInput()
    const inScopeCheck = sandboxDecision.checks.find((check) => check.name === 'target_in_scope')
    rec.check(
      '措辞兼容：沙箱能力仍说「在沙箱范围内」（逐字不变）',
      inScopeCheck?.detail === '在沙箱范围内',
      `detail=${inScopeCheck?.detail ?? '(缺)'}`
    )

    // ③ 本机文件域**不说**沙箱
    const localDef = registry.get('local.file.read')!
    const localDecision = evaluateActionPolicy({
      request: createActionRequest({
        actionId: newActionId(),
        traceId: newTraceId(),
        capability: 'local.file.read',
        operation: 'read',
        requestedBy: { kind: 'user' },
        arguments: { path: 'C:\\x.txt' },
        sideEffect: 'read',
      }),
      definition: localDef,
      operation: localDef.operations[0]!,
      targetConfidence: 'exact',
      scopeViolation: false,
      grantedPermissions: ['local-file:read'],
      maxRiskLevel: 'R1',
      dryRun: false,
      scopeWording: {
        inScope: '在已授权的本机文件域内（**不是**沙箱：这是本机真实路径）',
        outOfScope: '目标在本机文件域之外：未触碰真实文件系统',
        outOfScopeMessage: '这个目标不在我能碰的本机文件域里，拒绝执行',
      },
    })
    rec.countInput()
    const localCheck = localDecision.checks.find((check) => check.name === 'target_in_scope')
    rec.check(
      '措辞分叉：本机文件域**不说**「在沙箱范围内」',
      localCheck?.detail !== undefined && !localCheck.detail.includes('沙箱范围内'),
      `detail=${localCheck?.detail ?? '(缺)'}`
    )

    // ④ 第一批四项的意图检测行为不变（算式仍触发计算）
    const mathTurn = await entry.bed.say({
      options: {
        switches: { math: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
      },
      text: '帮我算一下 0.1+0.2',
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    rec.check(
      '第一批兼容：算式意图仍然触发计算能力',
      resultOf(mathTurn, 'math.calculate') !== undefined,
      `动作=${String(mathTurn.actionResults.length)} 条`
    )

    rec.note('沙箱读结果', {
      status: sandboxResult?.status ?? null,
      hasTurnContent: sandboxResult?.turnContent !== undefined,
    })
    return rec.finish('旧聊天与第一批兼容')
  },
}

// ---------------------------------------------------------------------------
// common-03 目标 / 路径域事实
// ---------------------------------------------------------------------------

const common03: GroupRunner = {
  id: 'common-03',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('common-03')
    const entry = await suite.openBed('common-03')

    const legal = entry.tree.files[0]!
    const outcome = resolveLocalTarget({ targetType: 'local_file', rawPath: legal })
    rec.countInput()
    rec.check(
      '合法本机绝对路径 ⇒ 目标 exact（绝对路径本身就是确定的）',
      outcome.target.confidence === 'exact' && outcome.scopeViolation === false,
      `confidence=${outcome.target.confidence} violation=${String(outcome.scopeViolation)}`
    )
    const details = (outcome.target.evidence ?? []).map((item) => item.detail).join(' | ')
    rec.check(
      '目标证据说「本机文件域」，并**明说不在沙箱约束内**',
      details.includes('本机文件域') && details.includes('在沙箱约束内=false'),
      details.slice(0, 220)
    )
    rec.check(
      '目标证据**没有**把本机路径说成"沙箱范围内的相对路径"',
      !details.includes('沙箱内精确相对路径'),
      details.includes('沙箱内精确相对路径') ? '出现了沙箱相对路径措辞' : '未出现'
    )

    const unc = resolveLocalTarget({ targetType: 'local_file', rawPath: '\\\\server\\share\\a.txt' })
    rec.countInput()
    rec.check(
      '网络共享路径 ⇒ 域外（scopeViolation）',
      unc.scopeViolation === true,
      `violation=${String(unc.scopeViolation)} confidence=${unc.target.confidence}`
    )

    const relative = resolveLocalTarget({ targetType: 'local_file', rawPath: 'notes.txt' })
    rec.countInput()
    rec.check(
      '相对路径 ⇒ **不越界**而是"无法确定"（weak）',
      relative.scopeViolation === false && relative.target.confidence === 'weak',
      `violation=${String(relative.scopeViolation)} confidence=${relative.target.confidence}`
    )

    const missing = resolveLocalTarget({ targetType: 'local_file', rawPath: '' })
    rec.countInput()
    rec.check(
      '空路径 ⇒ 没有候选（none），不猜',
      missing.target.confidence === 'none' && missing.scopeViolation === false,
      `confidence=${missing.target.confidence}`
    )

    // 域外路径经由**策略**得到的措辞必须是本机域那一句
    const domainWording = resolveLocalTarget({ targetType: 'local_file', rawPath: '\\\\.\\PHYSICALDRIVE0' })
    rec.countInput()
    rec.check(
      '设备命名空间 ⇒ 域外',
      domainWording.scopeViolation === true,
      `violation=${String(domainWording.scopeViolation)}`
    )

    rec.note('合法路径', legal)
    rec.note('证据片段', details.slice(0, 220))
    void entry
    return rec.finish('目标 / 路径域事实')
  },
}

// ---------------------------------------------------------------------------
// common-04 正文 / token 隐私与来源资格
// ---------------------------------------------------------------------------

const common04: GroupRunner = {
  id: 'common-04',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('common-04')
    const entry = await suite.openBed('common-04')
    const workRoot = entry.tree.root
    const { writeFileSync } = await import('node:fs')
    /*
     * ⚠️ 哨兵**只**放在文件**正文**里，**不**放在文件名里。
     *    第一版把哨兵写进了文件名 ⇒ 路径（一个合法的"引用"参数）里也带着它，
     *    于是三条隐私断言全红 —— 而那是**量具设计错**，不是隐私缺陷。
     *    "参数里有路径"是设计；"参数里有正文"才是缺陷。
     */
    const secretPath = `${workRoot}\\secret-a.txt`
    writeFileSync(secretPath, `正文里带着哨兵 ${SENTINEL} 以及一行不该进账本的内容。`, 'utf8')

    // ① 读：正文进了当轮内容，但**不进账本**
    const readTurn = await entry.bed.say({
      options: {
        switches: { localFileRead: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        turnContentTokens: 2000,
      },
      text: `读一下 ${secretPath}`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    const content = contentOf(readTurn, 'local.file.read')
    rec.check(
      '读：正文确实进了当轮内容（内存载体）',
      content?.text.includes(SENTINEL) === true,
      `内容存在=${String(content !== undefined)}`
    )
    rec.check(
      '读：参数里只有路径（引用），没有正文',
      !JSON.stringify(readTurn.actionResults.map((item) => item.request?.arguments ?? {})).includes(
        SENTINEL
      ),
      '动作参数里出现了正文'
    )

    // ② 写：正文**只**经私有暂存（参数里是 payloadRef）
    const targetPath = `${workRoot}\\out-a.txt`
    const writeTurn = await entry.bed.say({
      options: {
        switches: { localFileRead: true, localFileWrite: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        planner: scriptedPlanner([
          {
            goal: '写一个文件',
            steps: [
              {
                capability: 'local.file.write',
                operation: 'write',
                args: { path: targetPath, content: `写入内容 ${SENTINEL}` },
              },
            ],
            done: true,
          },
        ]),
        taskRiskLevel: 'R1',
      },
      text: `帮我写一个文件到 ${targetPath}`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    const writeResult = resultOf(writeTurn, 'local.file.write')
    rec.check(
      '写：动作真的执行了',
      writeResult !== undefined && writeResult.executed,
      `status=${writeResult?.status ?? '(没有动作)'}`
    )
    const writeArgs = JSON.stringify(
      writeTurn.actionResults.map((item) => item.request?.arguments ?? {})
    )
    rec.check(
      '写：参数里**没有**正文（只有 payloadRef / 指纹 / 字节数）',
      !writeArgs.includes(SENTINEL) && writeArgs.includes('payloadRef'),
      writeArgs.slice(0, 200)
    )
    rec.check(
      '写：文件真的落盘且内容正确',
      readFileSync(targetPath, 'utf8').includes(SENTINEL),
      '文件内容不含哨兵'
    )

    // ③ 账本 / 会话事件逐表扫哨兵
    const tables = await entry.bed.tableTexts([
      'character_action_events',
      'conversation_events',
      'memory_records',
      'memory_events',
      'character_traces',
      'character_domain_events',
      'character_projections',
    ])
    let leakTable: string | undefined
    for (const [table, text] of Object.entries(tables)) {
      if (text.includes(SENTINEL)) {
        leakTable = table
        break
      }
    }
    rec.countInput()
    rec.check(
      '隐私：账本 / 会话事件 / 记忆 / trace 里**没有**文件正文哨兵',
      leakTable === undefined,
      leakTable === undefined ? '10 张表级扫描 0 命中' : `命中了 ${leakTable}`
    )

    // ④ 正控：扫描器**确实能**发现哨兵（否则上面那条是"什么都没量到"）
    const positive = Object.values(tables).some((text) => text.includes(SENTINEL))
    const injected = JSON.stringify({ probe: SENTINEL })
    rec.countInput()
    rec.check(
      '隐私量具正控：把哨兵注入一份假数据，同一个判据必须响',
      injected.includes(SENTINEL) && positive === false,
      `真表命中=${String(positive)} · 注入后命中=${String(injected.includes(SENTINEL))}`
    )

    rec.note('扫描的表', Object.keys(tables))
    rec.note('泄漏表', leakTable ?? null)
    return rec.finish('正文 / token 隐私与来源资格')
  },
}

// ---------------------------------------------------------------------------
// common-05 预算 / 实际入模
// ---------------------------------------------------------------------------

const common05: GroupRunner = {
  id: 'common-05',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('common-05')
    const entry = await suite.openBed('common-05')
    const path = entry.tree.files[0]!
    const base: ProductivityTurnOptions = {
      switches: { localFileRead: true },
      sandboxRoot: entry.bed.sandboxRoot,
      recoveryRoot: entry.bed.recoveryRoot,
    }

    const zero = await entry.bed.say({
      options: { ...base, turnContentTokens: 0 },
      text: `读一下 ${path}`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    rec.check(
      '额度 0 ⇒ 当轮内容**不入模**（section 不在 packet 里）',
      !zero.sectionIds.includes('turn-content'),
      `sections=${zero.sectionIds.join(',')}`
    )
    rec.check(
      '额度 0 ⇒ 回复守卫看到"没有入模"（不给交付态）',
      (zero.guard.turnContent.states.length === 0 ||
        zero.guard.turnContent.states.every((state) => state.state !== 'delivered')),
      JSON.stringify(zero.guard.turnContent.states)
    )

    const enough = await entry.bed.say({
      options: { ...base, turnContentTokens: 2000 },
      text: `读一下 ${path}`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    rec.check(
      '额度足够 ⇒ 当轮内容**真的进 packet**',
      enough.sectionIds.includes('turn-content'),
      `sections=${enough.sectionIds.join(',')}`
    )
    const reality = enough.turnContentInContext
    rec.check(
      '实际入模份数与 reality 一致（refs 数 = selected 数）',
      reality !== undefined && reality.refs.length === reality.selected.length && reality.refs.length > 0,
      `refs=${String(reality?.refs.length)} selected=${String(reality?.selected.length)} reached=${String(reality?.reachedContext)}`
    )
    const section = enough.sectionOf('turn-content')
    rec.check(
      '入模的正文里含 fixture 的**独立期望值**',
      section.includes('LG-4096') && section.includes('青鳉三号'),
      section.length === 0 ? 'section 为空' : 'section 含期望值'
    )
    rec.check(
      '入模范围声明与实际字符数一致（截断了就说截断了）',
      reality !== undefined &&
        reality.refs.every((ref) => ref.scope.truncated === ref.scope.totalChars > ref.scope.includedChars),
      JSON.stringify(reality?.refs.map((ref) => ref.scope) ?? [])
    )

    /*
     * ======================================================================
     *  ⑥~⑧ 一个轮次的**内容汇聚**（2026-10-05 真实事故的回归）
     * ======================================================================
     * 事故形态：一个任务里 `C:\Users\Public\Desktop` 被列了 6 次、`C:\Users` 4 次，
     * 10 份当轮内容撞上 `maxItemsPerTurn = 6` 的断言 ⇒ **整轮失败**，
     * 用户一个字都没得到（`turn_content_list_invalid`）。25 秒与 12 次行动全白烧。
     *
     * 判据必须同时证明三件事：
     * ```text
     * ① 契约**没有**被改弱（8 份在契约层仍然不合法，选择器仍然拒）
     * ② 汇聚层把份数降级**并如实计数**（不是悄悄删掉）
     * ③ 真走一轮：**轮次不再失败**，动作一个都没少，内容只留 6 份
     * ```
     */
    const pureThree = [1, 2, 3].map((index) =>
      localListFixture(
        `fixture-${String(index)}`,
        `C:\\fixture\\dir-${String(index)}`,
        `fp-${String(index)}`
      )
    )
    const quiet = aggregateTurnContentForTurn(pureThree)
    rec.countInput()
    rec.check(
      '⑥-a 正控（合法输入 ⇒ 检测器**安静**）：3 份互不相同 ⇒ 一份不丢、顺序不变、两个计数都是 0',
      quiet.reading.candidates === 3 &&
        quiet.reading.kept === 3 &&
        quiet.reading.droppedDuplicates === 0 &&
        quiet.reading.droppedByLimit === 0 &&
        quiet.items.map((item) => item.contentId).join(',') === 'fixture-1,fixture-2,fixture-3',
      JSON.stringify(quiet.reading)
    )
    const eight = [1, 2, 3, 4, 5, 6, 7, 8].map((index) =>
      localListFixture(`over-${String(index)}`, `C:\\fixture\\dir-${String(index)}`, `fp-${String(index)}`)
    )
    const capped = aggregateTurnContentForTurn(eight)
    rec.countInput()
    rec.check(
      '⑥-b 负控（注入超限 ⇒ 检测器**必须响**）：8 份 ⇒ 留 6、超上限丢 2，且**保序**丢的是后面两份',
      capped.reading.candidates === 8 &&
        capped.reading.kept === 6 &&
        capped.reading.droppedByLimit === 2 &&
        capped.reading.droppedDuplicates === 0 &&
        capped.items.map((item) => item.contentId).join(',') === 'over-1,over-2,over-3,over-4,over-5,over-6',
      JSON.stringify(capped.reading)
    )
    /*
     * 计数型自检（AGENTS §6.8）：`droppedByLimit = 2` 必须来自**真的量到了东西**
     * —— 否则"0 丢弃"与"根本没量"在输出上长得一样。
     */
    rec.check(
      '⑥-c 计数型自检：负控里 `droppedByLimit > 0`（量具真的量到了，不是零分母）',
      capped.reading.droppedByLimit > 0 && capped.reading.candidates === eight.length,
      `measured=${String(capped.reading.droppedByLimit)} / candidates=${String(capped.reading.candidates)}`
    )
    const restored = aggregateTurnContentForTurn(pureThree)
    rec.check(
      '⑥-d 恢复（放回合法输入 ⇒ 重新安静）：又是 3 份、又不丢',
      restored.reading.droppedByLimit === 0 &&
        restored.reading.droppedDuplicates === 0 &&
        restored.items.length === 3,
      JSON.stringify(restored.reading)
    )
    rec.check(
      '⑥-e **契约没有被改弱**：8 份在契约层仍然不合法（`validateTurnContentList` 有话说）',
      validateTurnContentList(eight).length > 0,
      JSON.stringify(validateTurnContentList(eight))
    )
    let selectorThrew: string | undefined
    try {
      selectTurnContentContext({ items: eight, budgetTokens: 3000 })
    } catch (error) {
      selectorThrew = String((error as { code?: unknown }).code ?? error)
    }
    rec.check(
      '⑥-f **契约没有被改弱**：选择器拿到 8 份仍然拒（`turn_content_list_invalid`）—— 降级发生在**汇聚层**',
      selectorThrew === 'turn_content_list_invalid',
      `threw=${String(selectorThrew)}`
    )
    rec.check(
      '⑥-g 降级后的列表**仍然合法**（不是把一个非法列表喂给下一层）',
      validateTurnContentList(capped.items).length === 0,
      JSON.stringify(validateTurnContentList(capped.items))
    )
    const duplicated = [1, 2, 3, 4, 5, 6, 7, 8].map((index) =>
      localListFixture(`dup-${String(index)}`, 'C:\\same\\dir', 'same-fingerprint')
    )
    const deduped = aggregateTurnContentForTurn(duplicated)
    rec.check(
      '⑥-h 同源同指纹去重：8 次列举**同一个**目录 ⇒ 轮次上只留 1 份（动作仍在账本里）',
      deduped.reading.candidates === 8 &&
        deduped.reading.kept === 1 &&
        deduped.reading.droppedDuplicates === 7 &&
        deduped.reading.droppedByLimit === 0,
      JSON.stringify(deduped.reading)
    )
    rec.check(
      '⑥-i 指纹不同 ⇒ **不**去重（同一路径读两次而中间被改过，是两条不同的事实）',
      aggregateTurnContentForTurn([
        localListFixture('fp-a', 'C:\\same\\dir', 'fp-one'),
        localListFixture('fp-b', 'C:\\same\\dir', 'fp-two'),
      ]).items.length === 2,
      '两条不同指纹的内容必须都在'
    )
    let malformedThrew: string | undefined
    try {
      aggregateTurnContentForTurn([
        ...pureThree,
        {
          ...localListFixture('bad-1', 'C:\\bad', 'fp-bad'),
          scope: { totalChars: 3, includedChars: 99, truncated: false },
        },
      ])
    } catch (error) {
      malformedThrew = String((error as { code?: unknown }).code ?? error)
    }
    rec.check(
      '⑥-j 逐份契约仍然是**硬的**：混进一份非法内容 ⇒ 汇聚层照样抛 `turn_content_invalid`（降级不掩盖生产者缺陷）',
      malformedThrew === 'turn_content_invalid',
      `threw=${String(malformedThrew)}`
    )

    /*
     * ⑦ 真走一轮（真适配器 + 真网关 + 任务环）：**轮次不再因为份数超顶而失败**
     */
    const capDirs = [1, 2, 3, 4, 5, 6, 7, 8].map((index) => {
      const dir = `${entry.tree.root}\\cap-${String(index)}`
      mkdirSync(dir, { recursive: true })
      return dir
    })
    const many = await entry.bed.say({
      options: {
        switches: { localFileRead: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        turnContentTokens: 3000,
        planner: scriptedPlanner([
          {
            goal: '列八个目录',
            steps: capDirs.map((dir) => ({
              capability: 'local.file.list',
              operation: 'list',
              args: { path: dir },
            })),
            done: true,
          },
        ]),
      },
      text: `帮我看看这 ${String(capDirs.length)} 个目录里各有什么`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    const aggregation = many.turn.turnContentAggregation
    rec.check(
      '⑦-a 8 步都产出内容 ⇒ **轮次照样成功**（修复前：`turn_content_list_invalid` 整轮失败）',
      many.turnContent.length === 6 && many.turnContentInContext?.reachedContext === true,
      `kept=${String(many.turnContent.length)} reached=${String(many.turnContentInContext?.reachedContext)}`
    )
    rec.check(
      '⑦-b 汇聚读数如实：候选 8 / 入轮 6 / 超上限丢 2（三个计数对得上，没有"沉默的份数"）',
      aggregation !== undefined &&
        aggregation.candidates === 8 &&
        aggregation.kept === 6 &&
        aggregation.droppedByLimit === 2 &&
        aggregation.droppedDuplicates === 0 &&
        aggregation.candidates ===
          aggregation.kept + aggregation.droppedByLimit + aggregation.droppedDuplicates,
      JSON.stringify(aggregation ?? null)
    )
    rec.check(
      '⑦-c 动作**一个都没少**（8 条都真的执行了；降级只作用于当轮上下文）',
      many.actionResults.filter((item) => item.result?.executed === true).length === 8,
      `executed=${String(many.actionResults.filter((item) => item.result?.executed === true).length)}`
    )
    const contentStep = many.trace.steps.find((traceStep) => traceStep.kind === 'turn_content')
    rec.check(
      '⑦-d trace 记的是**降级之前的候选数**（否则"她做了 8 次列举"在 trace 上消失）',
      Number(contentStep?.attributes.candidate_count ?? 0) === 8 &&
        Number(contentStep?.attributes.kept_count ?? 0) === 6 &&
        Number(contentStep?.attributes.aggregate_limit_dropped_count ?? 0) === 2,
      JSON.stringify(contentStep?.attributes ?? {})
    )

    /* ⑧ 事故的原始形态：同一个目录列 8 次 ⇒ 轮次上只留一份 */
    const dupDir = `${entry.tree.root}\\dup-dir`
    mkdirSync(dupDir, { recursive: true })
    const repeated = await entry.bed.say({
      options: {
        switches: { localFileRead: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        turnContentTokens: 3000,
        planner: scriptedPlanner([
          {
            goal: '反复列同一个目录',
            steps: [1, 2, 3, 4, 5, 6, 7, 8].map(() => ({
              capability: 'local.file.list',
              operation: 'list',
              args: { path: dupDir },
            })),
            done: true,
          },
        ]),
      },
      text: `帮我把 ${dupDir} 反复列几遍`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    rec.check(
      '⑧-a 同一个目录列 8 次 ⇒ 轮次上只剩 1 份（同源同指纹去重），但**8 次动作都发生过**',
      repeated.turnContent.length === 1 &&
        repeated.turn.turnContentAggregation?.droppedDuplicates === 7 &&
        repeated.actionResults.filter((item) => item.result?.executed === true).length === 8,
      `kept=${String(repeated.turnContent.length)} dup=${String(repeated.turn.turnContentAggregation?.droppedDuplicates)}`
    )

    rec.note('额度 0 的 sections', zero.sectionIds)
    rec.note('额度 2000 的 sections', enough.sectionIds)
    return rec.finish('预算 / 实际入模')
  },
}
// ---------------------------------------------------------------------------
// common-06 取消 / 迟到
// ---------------------------------------------------------------------------

const common06: GroupRunner = {
  id: 'common-06',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('common-06')
    const entry = await suite.openBed('common-06')
    const target = `${entry.tree.root}\\cancel-target.txt`

    // ① 行动预算 1：三步计划只执行一步，其余**如实**不执行
    const turn = await entry.bed.say({
      options: {
        switches: { localFileWrite: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        taskMaxActions: 1,
        taskMaxPlans: 3,
        planner: scriptedPlanner([
          {
            goal: '写三个文件',
            steps: [
              { capability: 'local.file.write', operation: 'write', args: { path: target, content: '第一份' } },
              { capability: 'local.file.write', operation: 'write', args: { path: `${target}.2`, content: '第二份' } },
              { capability: 'local.file.write', operation: 'write', args: { path: `${target}.3`, content: '第三份' } },
            ],
            done: true,
          },
        ]),
      },
      text: `帮我写几个文件到 ${target}`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    const writes = turn.actionResults.filter((item) => item.result !== undefined)
    rec.check(
      '行动预算 1 ⇒ 只执行 1 次（其余不执行，不假报）',
      writes.length === 1,
      `执行了 ${String(writes.length)} 次`
    )
    rec.check(
      '第二个目标文件**没有**被创建（预算是执行层的硬闸）',
      !statSyncExists(`${target}.2`),
      statSyncExists(`${target}.2`) ? '第二个文件竟然存在' : '不存在（正确）'
    )

    // ② 规划预算 1 + 计划说 done=false ⇒ 停止原因如实
    const turn2 = await entry.bed.say({
      options: {
        switches: { localFileWrite: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        taskMaxActions: 5,
        taskMaxPlans: 1,
        planner: scriptedPlanner([
          {
            goal: '写一份并说还没完',
            steps: [
              { capability: 'local.file.write', operation: 'write', args: { path: `${target}.b`, content: '内容' } },
            ],
            done: false,
          },
        ]),
      },
      text: `帮我写一份到 ${target}.b`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    rec.check(
      '规划预算用尽 ⇒ 停止（不无限追问模型）',
      turn2.actionResults.filter((item) => item.result !== undefined).length === 1,
      `执行了 ${turn2.actionResults.filter((item) => item.result !== undefined).length} 次`
    )

    // ③ 规划器失败 ⇒ 保留已做过的事，并如实停止
    const registry = createCapabilityRegistry([
      ...createDefaultCapabilityDefinitions(),
      ...createLocalFileCapabilityDefinitions(),
    ])
    const authorizations = createTaskAuthorizationRegistry({ now: () => 1_000 })
    const authorization = authorizations.issue({
      conversationKey: 'cancel-fixture',
      originalText: '（验收原话）',
      triggeringEventId: 'evt-1',
      allowedCapabilities: ['local.file.write'],
      maxRiskLevel: 'R1',
    })
    authorizations.close(authorization.taskId, 'cancelled')
    rec.countInput()
    rec.check(
      '任务被取消 ⇒ `findOpen` 返回 undefined（不在已关闭的授权上继续执行）',
      authorizations.findOpen('cancel-fixture', 1_000) === undefined,
      `findOpen=${String(authorizations.findOpen('cancel-fixture', 1_000))}`
    )
    rec.check(
      '取消原因如实登记（`cancelled`，不是静默消失）',
      authorizations.find(authorization.taskId)?.closedReason === 'cancelled',
      `reason=${String(authorizations.find(authorization.taskId)?.closedReason)}`
    )
    void registry

    /*
     * ④ **计划原地打转** ⇒ 如实停止（`no_progress`）
     *
     * 2026-10-05 的真实事故：规划器看不到内容（摘要里连路径都没有），于是它把
     * 同一个目录反复列出来；12 次行动预算烧光、25 秒白等，最后整轮还因为
     * 当轮内容超单轮上限而失败。⇒ 整份计划都是"已经成功过的引用 + 同一个操作"时，
     * 再执行一遍不会产生任何新事实，必须停 —— 而且停的原因**不能**写成 `done`
     * （任务并没有做完，那是假报）。
     */
    const loopDir = `${entry.tree.root}\\loop-dir`
    mkdirSync(loopDir, { recursive: true })
    const samePlan = {
      goal: '再列一次同一个目录',
      steps: [{ capability: 'local.file.list', operation: 'list', args: { path: loopDir } }],
      done: false,
    }
    const turn3 = await entry.bed.say({
      options: {
        switches: { localFileRead: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        taskMaxActions: 30,
        taskMaxPlans: 6,
        planner: scriptedPlanner([samePlan, samePlan, samePlan, samePlan, samePlan, samePlan]),
      },
      text: `帮我列一下 ${loopDir} 里有什么`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    const loopExecuted = turn3.actionResults.filter((item) => item.result !== undefined).length
    rec.check(
      '④-a 重复计划 ⇒ **只执行一次**（不再把 30 次行动预算烧在同一个列举上）',
      loopExecuted === 1,
      `执行了 ${String(loopExecuted)} 次`
    )
    rec.check(
      '④-b 停止原因如实：`no_progress` —— **不是** `done`（任务并没有做完）',
      turn3.actionResults[0]?.task?.stopped === 'no_progress',
      `stopped=${String(turn3.actionResults[0]?.task?.stopped)}`
    )
    rec.check(
      '④-c 执行过的动作仍在（停止**不**推翻已经做过的事）',
      turn3.turnContent.length === 1,
      `turnContent=${String(turn3.turnContent.length)}`
    )

    /*
     * ④-d **进度闸的负控**（这条比 ④-a/b/c 更重要）：
     * ```text
     * 读 A → **写 A**（正文换掉）→ 再读 A
     * ```
     * "写完之后再读回来核对"是**合理**的重复，绝不能被判成打转：
     *   · 带载荷的步骤（`local.file.write` 的 `content`）**不进**进度闸 ——
     *     同一个路径 + 不同正文是两件事；
     *   · 有副作用的步骤会**作废**同一条引用上的读取记录（世界变了）。
     * 两条少任何一条，这一轮的第三次读都不会发生，而用户以为它发生了。
     */
    const readPath = `${entry.tree.root}\\progress-guard.txt`
    writeFileSync(readPath, 'FIRST', 'utf8')
    const guardTurn = await entry.bed.say({
      options: {
        switches: { localFileRead: true, localFileWrite: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        taskMaxActions: 10,
        taskMaxPlans: 6,
        planner: scriptedPlanner([
          {
            goal: '先读一遍',
            steps: [{ capability: 'local.file.read', operation: 'read', args: { path: readPath } }],
            done: false,
          },
          {
            goal: '改写它',
            steps: [
              {
                capability: 'local.file.write',
                operation: 'write',
                args: { path: readPath, content: 'SECOND' },
              },
            ],
            done: false,
          },
          {
            goal: '再读回来核对',
            steps: [{ capability: 'local.file.read', operation: 'read', args: { path: readPath } }],
            done: true,
          },
        ]),
      },
      text: `帮我读一下 ${readPath}，改一下，再读回来核对`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    const guardExecuted = guardTurn.actionResults.filter((item) => item.result !== undefined).length
    rec.check(
      '④-d 负控：读→写→再读 **不算**打转（带载荷的写步骤永不进闸；有副作用的步骤作废该引用的读取记录）',
      guardExecuted === 3 && guardTurn.actionResults[0]?.task?.stopped === 'done',
      `执行了 ${String(guardExecuted)} 次 · stopped=${String(guardTurn.actionResults[0]?.task?.stopped)}`
    )
    rec.check(
      '④-e 负控：那一写**真的发生了**（正文换掉；若被误判成重复，这里还是 FIRST）',
      readFileSync(readPath, 'utf8') === 'SECOND',
      `文件内容=${readFileSync(readPath, 'utf8')}`
    )

    // 失败的输入步骤不得带着旧计划继续写；备用输入必须在下一次规划里选择。
    const fallbackPath = `${entry.tree.root}\\orchestration-fallback.txt`
    const prematurePath = `${entry.tree.root}\\orchestration-premature.txt`
    const recoveredPath = `${entry.tree.root}\\orchestration-recovered.txt`
    writeFileSync(fallbackPath, 'FALLBACK-INPUT-47', 'utf8')
    let recoveryPlans = 0
    let sawFailedInput = false
    let sawFallbackContent = false
    const recoveryTurn = await entry.bed.say({
      options: {
        switches: { localFileRead: true, localFileWrite: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        taskMaxPlans: 4,
        plannerContentTokens: 2000,
        toolDecision: {
          port: {
            id: 'fixture-orchestration-decision', endpointHost: 'fixture.local',
            async decide() {
              return { ok: true, requestCount: 0, raw: {
                branch: 'tools', goal: '读取输入后写报告', done: true,
                steps: [
                  { capability: 'local.file.read', operation: 'read', args: { path: `${fallbackPath}.missing` } },
                  { capability: 'local.file.write', operation: 'write', args: { path: prematurePath, content: 'UNVERIFIED' } },
                ],
              } }
            },
          },
        },
        planner: {
          id: 'fixture-orchestration-recovery', endpointHost: 'fixture.local',
          async plan(input) {
            recoveryPlans += 1
            if (recoveryPlans === 1) {
              sawFailedInput = input.failures.length > 0 && input.executed.some((line) => line.includes('.missing'))
              return { ok: true, requestCount: 0, plan: {
                goal: '改读备用输入', done: false,
                steps: [{ capability: 'local.file.read', operation: 'read', args: { path: fallbackPath } }],
              } }
            }
            sawFallbackContent = input.content?.some((text) => text.includes('FALLBACK-INPUT-47')) === true
            return { ok: true, requestCount: 0, plan: {
              goal: '依据真实输入写报告', done: true,
              steps: [{ capability: 'local.file.write', operation: 'write', args: { path: recoveredPath, content: 'FALLBACK-INPUT-47' } }],
            } }
          },
        },
      },
      text: `帮我读取 ${fallbackPath}.missing；失败时改读 ${fallbackPath}，把结果写到 ${recoveredPath}`,
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    rec.check('失败后暂停旧计划：后续写入没有发生', !statSyncExists(prematurePath), `exists=${String(statSyncExists(prematurePath))}`)
    rec.check('首份计划即使 done=true，失败仍交回规划器', recoveryPlans === 2 && sawFailedInput, `plans=${String(recoveryPlans)} failureFeedback=${String(sawFailedInput)}`)
    rec.check('备用输入的实际正文回传，恢复后的写入真的完成', sawFallbackContent && statSyncExists(recoveredPath) && readFileSync(recoveredPath, 'utf8') === 'FALLBACK-INPUT-47', `contentFeedback=${String(sawFallbackContent)}`)
    rec.check('失败记录保留，恢复过程仍归属于同一个 trace', recoveryTurn.actionResults.length === 3 && recoveryTurn.actionResults.every(({ request }) => request?.traceId === recoveryTurn.trace.traceId), `actions=${String(recoveryTurn.actionResults.length)}`)

    rec.note('预算 1 时执行的动作数', writes.length)
    rec.note('第二个文件存在', statSyncExists(`${target}.2`))
    return rec.finish('取消 / 迟到')
  },
}

function statSyncExists(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// common-07 任务归因 / 操作范围与风险
// ---------------------------------------------------------------------------

const common07: GroupRunner = {
  id: 'common-07',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('common-07')
    const entry = await suite.openBed('common-07')

    // ① 越权步骤：计划里出现授权集合之外的能力 ⇒ **整条计划作废**（一步都不执行）
    const registry = createCapabilityRegistry([
      ...createDefaultCapabilityDefinitions(),
      ...createLocalFileCapabilityDefinitions(),
      ...createBrowserCapabilityDefinitions(),
    ])
    const overreach = ((): { rejected: boolean; code: string } => {
      try {
        validateTaskPlan(
          {
            goal: '越权',
            steps: [{ capability: 'browser.operate', operation: 'act', args: { action: 'navigate', url: 'https://x.example.com/' } }],
            done: true,
          },
          { registry, allowedCapabilities: ['local.file.read'] }
        )
        return { rejected: false, code: '(被放过)' }
      } catch (error) {
        return { rejected: true, code: String((error as { code?: unknown }).code ?? 'unknown') }
      }
    })()
    rec.countInput()
    rec.check(
      '越权步骤 ⇒ 计划被拒（`task_plan_step_capability_not_authorized`）',
      overreach.rejected && overreach.code === 'task_plan_step_capability_not_authorized',
      `rejected=${String(overreach.rejected)} code=${overreach.code}`
    )

    // ② 参数白名单：白名单之外的参数名 ⇒ 整条计划作废
    const badArg = ((): string => {
      try {
        validateTaskPlan(
          {
            goal: '塞一个别的参数',
            steps: [{ capability: 'local.file.read', operation: 'read', args: { path: 'C:\\a.txt', shell: 'whoami' } }],
            done: true,
          },
          { registry, allowedCapabilities: ['local.file.read'] }
        )
        return '(被放过)'
      } catch (error) {
        return String((error as { code?: unknown }).code ?? 'unknown')
      }
    })()
    rec.countInput()
    rec.check(
      '参数白名单：未知参数键 ⇒ 计划被拒（`task_plan_step_arg_key_not_allowed`）',
      badArg === 'task_plan_step_arg_key_not_allowed',
      `code=${badArg}`
    )

    // ③ 未知字段：多一个字段整条丢弃（与 M5.5.1 判定器同一条纪律）
    const extraField = ((): string => {
      try {
        validateTaskPlan(
          { goal: '多字段', steps: [], done: true, authorized: true },
          { registry, allowedCapabilities: ['local.file.read'] }
        )
        return '(被放过)'
      } catch (error) {
        return String((error as { code?: unknown }).code ?? 'unknown')
      }
    })()
    rec.countInput()
    rec.check(
      '未知顶层字段 ⇒ 整条计划作废（`task_plan_unknown_field`）',
      extraField === 'task_plan_unknown_field',
      `code=${extraField}`
    )

    // ④ 风险：R2 的操作在 R1 额度下被**策略**拒绝（任务额度没有抬高时）
    const turnR1 = await entry.bed.say({
      options: {
        switches: { browser: true, taskAutonomy: true },
        sandboxRoot: entry.bed.sandboxRoot,
        recoveryRoot: entry.bed.recoveryRoot,
        taskRiskLevel: 'R1',
        planner: scriptedPlanner([
          {
            goal: '导航',
            steps: [
              {
                capability: 'browser.operate',
                operation: 'act',
                args: { action: 'navigate', url: 'https://portal.example.com/dashboard' },
              },
            ],
            done: true,
          },
        ]),
      },
      text: '帮我打开 https://portal.example.com/dashboard',
      replyText: '（离线固定回复）',
    })
    rec.countInput()
    const browserResult = resultOf(turnR1, 'browser.operate')
    rec.check(
      'R2 操作在 R1 任务额度下被拒（`risk_exceeds_limit` ⇒ permission_denied）',
      browserResult !== undefined &&
        browserResult.status === 'rejected' &&
        browserResult.error?.code === 'permission_denied',
      `status=${browserResult?.status ?? '(无)'} code=${browserResult?.error?.code ?? '(无)'}`
    )

    // ⑤ 归因：任务里的每一步都挂在**同一轮 trace** 上（不伪造轮次）
    const traceIds = new Set(
      turnR1.actionResults
        .map((item) => item.request?.traceId)
        .filter((value): value is NonNullable<typeof value> => value !== undefined)
        .map(String)
    )
    rec.check(
      '任务步骤全部挂在同一个 traceId 上（不伪造新轮次）',
      traceIds.size === 1 && traceIds.size > 0,
      `traceIds=${[...traceIds].join(',')}`
    )
    rec.check(
      '任务步骤的 requestedBy 是 user（原任务归因，不是自造身份）',
      turnR1.actionResults.every((item) => item.request?.requestedBy.kind === 'user'),
      JSON.stringify(turnR1.actionResults.map((item) => item.request?.requestedBy ?? null))
    )

    rec.note('越权拒绝码', overreach.code)
    rec.note('R2 在 R1 下的结果', {
      status: browserResult?.status ?? null,
      code: browserResult?.error?.code ?? null,
    })
    return rec.finish('任务归因 / 操作范围与风险')
  },
}

// ---------------------------------------------------------------------------
// common-08 量具正控 / 负控 / 恢复与非空计数
// ---------------------------------------------------------------------------

const common08: GroupRunner = {
  id: 'common-08',
  async run(_ctx: VerifyContext, suite: Suite): Promise<GroupReading> {
    const rec = new GroupRecorder('common-08')
    const entry = await suite.openBed('common-08')
    void entry

    /**
     * 三段式的**被测判据**：`inspectLocalPath()` 必须拒绝网络共享路径。
     *
     * ⚠️ 判据写成函数，才能把它同时喂给"真实实现"与"注入的假象"——
     *    只做正控的量具与"什么都不检查"在输出上无法区分（AGENTS.md §6.7）。
     */
    const judge = (inspect: (raw: string) => { ok: boolean }): boolean =>
      inspect('\\\\server\\share\\a.txt').ok === false

    // ① 正控：合法输入 ⇒ 判据**安静**（不误报）
    const legal = inspectLocalPath('C:\\work\\a.txt')
    rec.countInput()
    rec.check(
      '三段式① 正控：合法绝对路径 ⇒ 判据安静（ok=true，不误报）',
      legal.ok === true,
      `ok=${String(legal.ok)}`
    )

    // ② 负控：注入假象（一个"永远说 ok"的 inspector）⇒ 判据**必须响**
    const alwaysOk = (): { ok: boolean } => ({ ok: true })
    rec.countInput()
    rec.check(
      '三段式② 负控：注入"永远放行"的假实现 ⇒ 同一个判据必须响',
      judge(alwaysOk) === false,
      `judge(假实现)=${String(judge(alwaysOk))}（必须是 false）`
    )

    // ③ 恢复：放回真实实现 ⇒ 重新安静
    rec.countInput()
    rec.check(
      '三段式③ 恢复：放回真实实现 ⇒ 判据重新安静',
      judge(inspectLocalPath) === true,
      `judge(真实现)=${String(judge(inspectLocalPath))}（必须是 true）`
    )

    // ④ 非空计数自检：本组必须真的执行了输入
    rec.countInput()
    rec.check(
      '非空计数：本组实测输入条数 > 0',
      rec.measured > 0,
      `measured=${String(rec.measured)}`
    )

    // ⑤ 第二组三段式：任务词形判据（`looksLikeTask`）——负控注入"永远说是"
    const taskJudge = (looks: (text: string) => boolean): boolean =>
      looks('今天天气不错') === false
    rec.countInput()
    rec.check(
      '三段式（第二例）正控：一句闲聊 ⇒ 任务判据安静',
      taskJudge(looksLikeTask) === true,
      `judge(真实现)=${String(taskJudge(looksLikeTask))}`
    )
    rec.countInput()
    rec.check(
      '三段式（第二例）负控：注入"永远说是"的假实现 ⇒ 判据必须响',
      taskJudge(() => true) === false,
      `judge(假实现)=${String(taskJudge(() => true))}`
    )

    // ⑥ 计数型量具的第三种形态：路径 token 抽取（0 条与"全部一致"长得一样）
    const noToken = extractLocalPathTokens('今天天气不错')
    const withToken = extractLocalPathTokens('读一下 C:\\work\\a.txt')
    rec.countInput()
    rec.check(
      '计数型判据自检：无路径 ⇒ 0 条；有路径 ⇒ 1 条（0/0 与"全对"必须分得开）',
      noToken.length === 0 && withToken.length === 1,
      `noToken=${String(noToken.length)} withToken=${String(withToken.length)}`
    )

    rec.note('三段式结果', { positive: legal.ok, negative: judge(alwaysOk), restore: judge(inspectLocalPath) })
    return rec.finish('量具正控 / 负控 / 恢复与非空计数')
  },
}

export const COMMON_GROUPS: readonly GroupRunner[] = [
  common01,
  common02,
  common03,
  common04,
  common05,
  common06,
  common07,
  common08,
]

export { SENTINEL, unresolvedInvocation }
