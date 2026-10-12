/**
 * M7 WP6 —— **TD-07 预检**：`--history` 视图 vs 权威账本视图（`pnpm m7:wp6:td07`）。
 *
 * ============================================================================
 *  TD-07 是什么（WP0 接待单的 QUEUED 项）
 * ============================================================================
 * 缺陷登记：`--history` 读的是 ElizaOS `messages` 遗留镜像而非 Kernel 账本，
 * 且 `who` 判据把"任何非本用户的 entity"一律显示成她的名字。
 * 接待单约束：**不把错误历史视图当认知证据**；**不顺带重做 Console**；
 * 裁定形态二选一——"不作为认知证据"的守卫登记，或**最小替换**。
 *
 * ============================================================================
 *  本门的裁定与证明（三段式）
 * ============================================================================
 * 裁定 = **最小替换**（`renderHistory` 改读 Kernel 账本，见
 * `src/infrastructure/runtime/history-view.ts`）。理由：缺陷是**视图源错误**，
 * 守卫只是把错误文档化；换源在十几行内消除整个缺陷类，且与
 * `memory:list` / `--kernel-status` 归一到同一个权威源。不重做 Console：
 * 只换数据源，命令形状不变。
 *
 *  · **A 段（缺陷在场证明）**：按 main.ts 旧实现的**逐字复刻**跑镜像视图，
 *    断言三个缺陷**确实在场**——缺一半（用户的话从不进镜像）/
 *    标错人（user-2 的行被显示成她的名字）/ 作用域错（角色级账本的
 *    其它会话结构性不可见）。缺陷不在场 ⇒ 本门 INVALID（量具没量到东西）。
 *  · **B 段（替换后安静）**：真实现 `renderLedgerHistory`（不是复刻）——
 *    角色（actorType 如实分列，非本用户不冒名）/ 顺序（sequence）/
 *    作用域（角色级，跨会话可见）/ 分页（limit=尾部 N 条）/
 *    重启读回（同目录二次装配 ⇒ 逐字相同）/ 与权威读数 1:1。
 *  · **C 段（认知链静态事实）**：`src/kernel/**` 与认知装配路径里
 *    **零**镜像读取；`--history` 不进任何认知链（机器事实，非口头承诺）。
 *
 * 量具纪律：§6.7 三段式 + §6.8 measured_count 自检；隔离库，真实库不打开。
 */
import 'dotenv/config'

import { isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

const RUN_ID = `m7-wp6-td07-${Date.now()}-${process.pid}`
isolateDatabase('m7-wp6-td07', { runId: RUN_ID, keep: true })

import { AgentRuntime, type Character, stringToUuid, type UUID } from '@elizaos/core'
import sqlPlugin from '@elizaos/plugin-sql'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { character } from '../src/character/index.ts'
import { initDatabase } from '../src/db/index.ts'
import { initKernel } from '../src/kernel/app/kernel.ts'
import { characterDefinitionFromCharacter } from '../src/infrastructure/runtime/seed-projection.ts'
import { createConversationLedger } from '../src/infrastructure/persistence/ledger.ts'
import { createHumanConsoleUserTurnIngress } from '../src/infrastructure/runtime/conversation-attribution.ts'
import { appendConversationEvent } from '../src/infrastructure/persistence/conversation-store.ts'
import { renderLedgerHistory } from '../src/infrastructure/runtime/history-view.ts'
import { asConversationId, type CharacterId } from '../src/kernel/contracts/ids.ts'
import { createM7RunId, openM7RunDir, writeM7Manifest } from './m7-evidence.ts'

const REPO_ROOT = resolve(import.meta.dirname, '..')

// ---------------------------------------------------------------------------
// 检查条目
// ---------------------------------------------------------------------------

interface Check {
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}
const checks: Check[] = []
function record(id: string, label: string, expected: string, actual: string, pass: boolean): void {
  checks.push({ id, label, expected, actual, pass })
}

// ---------------------------------------------------------------------------
// 装配（重启读回要二次装配同一目录）
// ---------------------------------------------------------------------------

interface Bed {
  runtime: AgentRuntime
  db: import('../src/infrastructure/persistence/db.ts').RawDb
  characterId: CharacterId
  dispose: () => Promise<void>
}

async function assemble(): Promise<Bed> {
  await resetPluginSqlConnection()
  isolateDatabase('m7-wp6-td07', { runId: RUN_ID, keep: true })
  const runtime = new AgentRuntime({
    character: character as Character,
    plugins: [sqlPlugin],
    settings: {},
  })
  await initDatabase(runtime, sqlPlugin)
  await runtime.initialize()
  const kernel = await initKernel(runtime, {
    definition: characterDefinitionFromCharacter(character),
  })
  return {
    runtime,
    db: kernel.stores.db,
    characterId: kernel.characterId,
    dispose: async () => {
      await runtime.stop()
    },
  }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const T0 = 1_800_000_000_000
  const USER1 = stringToUuid('user-沐薇的主人')
  const USER1_NAME = '沐薇的主人'
  const USER2 = stringToUuid('user-另一位用户')
  const AGENT_ENTITY = stringToUuid('agent-entity')
  const ROOM_A = stringToUuid('room-A')
  const WORLD = stringToUuid('world-A')
  const CONV_A = asConversationId('td07-conversation-A')
  const CONV_B = asConversationId('td07-conversation-B')

  const bed = await assemble()
  const db = bed.db
  const characterId = bed.characterId

  const ledger = createConversationLedger({
    db,
    attribution: [createHumanConsoleUserTurnIngress()],
  })
  // 会话内序号：单一计数器交替推进（真实对话的形状：用户 N → 她的 N+1）
  let seqA = 0
  const appendUserA = async (userId: UUID, content: string, createdAt: number) => {
    seqA += 1
    return ledger.appendUserStatement({
      characterId,
      conversationId: CONV_A,
      userId,
      content,
      createdAt,
      conversationSequence: seqA,
    })
  }
  const appendAssistantA = async (content: string, createdAt: number) => {
    seqA += 1
    return appendConversationEvent(db, {
      characterId,
      conversationId: CONV_A,
      conversationSequence: seqA,
      type: 'assistant_message',
      actorType: 'character',
      actorId: characterId,
      content,
      createdAt,
    })
  }
  const appendSystemA = async (content: string, createdAt: number) => {
    seqA += 1
    return appendConversationEvent(db, {
      characterId,
      conversationId: CONV_A,
      conversationSequence: seqA,
      type: 'system_event',
      actorType: 'system',
      content,
      createdAt,
    })
  }
  let seqB = 0
  const appendUserB = async (userId: UUID, content: string, createdAt: number) => {
    seqB += 1
    return ledger.appendUserStatement({
      characterId,
      conversationId: CONV_B,
      userId,
      content,
      createdAt,
      conversationSequence: seqB,
    })
  }

  // ---- 种子：账本（权威）----
  // 会话 A：user-1 三轮 + 她的回复三条 + 系统一条 + user-2 一条（多用户）
  await appendUserA(USER1, '今天天气真好', T0 + 1)
  await appendAssistantA('是呀，适合出门走走', T0 + 2)
  await appendUserA(USER1, '你昨天说的那本书我看完了', T0 + 3)
  await appendAssistantA('结尾那章怎么样？', T0 + 4)
  await appendUserA(USER1, '结尾很震撼', T0 + 5)
  await appendAssistantA('下次我们聊聊', T0 + 6)
  await appendSystemA('会话归档点', T0 + 7)
  await appendUserA(USER2, '你好，我是另一位用户', T0 + 8)
  // 会话 B：user-1 两条（角色级账本里有，镜像里没有）
  await appendUserB(USER1, 'B 会话的第一句', T0 + 9)
  await appendUserB(USER1, 'B 会话的第二句', T0 + 10)

  // ---- 种子：镜像（复刻 main.ts 的真实写法：只为她的回复写 messages）----
  // 镜像表有外键（entity/room/world 必须先存在）——与 verify-l1-suite 同款前置
  const agentId = bed.runtime.agentId as UUID
  await bed.runtime.ensureWorldExists({
    id: WORLD,
    name: `${character.name}'s World`,
    agentId,
  })
  await bed.runtime.ensureEntity({ id: AGENT_ENTITY, names: [character.name], agentId, metadata: {} })
  await bed.runtime.ensureEntity({ id: USER1, names: [USER1_NAME], agentId, metadata: {} })
  await bed.runtime.ensureEntity({ id: USER2, names: ['另一位用户'], agentId, metadata: {} })
  await bed.runtime.ensureRoomExists({
    id: ROOM_A,
    name: 'td07-room-A',
    source: 'cli',
    type: 'dm' as never,
    worldId: WORLD,
  })
  await bed.runtime.ensureParticipantInRoom(AGENT_ENTITY, ROOM_A)
  await bed.runtime.ensureParticipantInRoom(USER1, ROOM_A)
  await bed.runtime.ensureParticipantInRoom(USER2, ROOM_A)

  const mirrorWrite = (id: string, entityId: UUID, text: string, createdAt: number) =>
    bed.runtime.createMemory(
      {
        id: stringToUuid(id),
        entityId,
        agentId: bed.runtime.agentId as UUID,
        roomId: ROOM_A,
        worldId: WORLD,
        content: { text, source: 'cli', channelType: 'dm' as never },
        createdAt,
      },
      'messages',
      true,
    )
  await mirrorWrite('mirror-a1', AGENT_ENTITY, '是呀，适合出门走走', T0 + 2)
  await mirrorWrite('mirror-a2', AGENT_ENTITY, '结尾那章怎么样？', T0 + 4)
  await mirrorWrite('mirror-a3', AGENT_ENTITY, '下次我们聊聊', T0 + 6)
  // user-2 在同一房间留下的镜像行（旧视图会把它标成她的名字——冒名缺陷的素材）
  await mirrorWrite('mirror-u2', USER2, '你好，我是另一位用户', T0 + 8)

  // ===========================================================================
  // A 段：旧视图缺陷在场证明（main.ts 旧实现的逐字复刻，跑在镜像上）
  // ===========================================================================

  const oldRender = async (limit = 20): Promise<string> => {
    const all = await bed.runtime.getMemories({
      tableName: 'messages',
      roomId: ROOM_A,
      count: 1000,
    })
    const sorted = all
      .filter((m) => typeof m.content?.text === 'string')
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
      .slice(-limit)
    if (sorted.length === 0) return '（她还没有任何对话记忆）'
    const lines = [`${character.name} 记得的最近 ${sorted.length} 条消息：`, '']
    for (const m of sorted) {
      const who = m.entityId === USER1 ? USER1_NAME : character.name
      const when = m.createdAt
        ? new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })
        : '(时间未知)'
      lines.push(`  [${when}] ${who}: ${String(m.content.text).replace(/\n/g, ' / ')}`)
    }
    return lines.join('\n')
  }

  const oldView = await oldRender()
  // A1 缺一半：镜像里没有 user-1 的任何一行（send() 只为 agent 写镜像）
  const a1ok =
    !oldView.includes(USER1_NAME) &&
    oldView.includes('是呀，适合出门走走') &&
    oldView.includes('今天天气真好') === false
  record(
    'A1',
    '缺陷①在场（缺一半）：旧镜像视图只有她的回复，user-1 的三轮一句都不在',
    '无用户行 · 有她的回复',
    `用户行=${oldView.includes(USER1_NAME) ? '有（缺陷不在场）' : '无'} · 她的回复=${oldView.includes('是呀，适合出门走走') ? '有' : '无'}`,
    a1ok,
  )
  // A2 标错人：user-2 的镜像行被显示成她的名字（冒名）
  const a2ok =
    oldView.includes(`${character.name}: 你好，我是另一位用户`) &&
    !oldView.includes(`用户 ${String(USER2)}`)
  record(
    'A2',
    '缺陷②在场（标错人）：user-2 的行被冒名成她的名字',
    '该行显示为角色名',
    a2ok ? '该行显示为角色名（冒名在场）' : '未冒名（缺陷不在场）',
    a2ok,
  )
  // A3 作用域：会话 B 的两条在角色级账本里，旧视图结构性看不见
  const a3ok = !oldView.includes('B 会话的第一句') && !oldView.includes('B 会话的第二句')
  record(
    'A3',
    '缺陷③在场（作用域）：会话 B 的两条在账本里，旧视图（roomId 过滤）结构性不可见',
    'B 会话不可见',
    a3ok ? 'B 会话不可见（缺陷在场）' : 'B 会话可见（缺陷不在场）',
    a3ok,
  )

  // ===========================================================================
  // B 段：替换后安静（真实现，不是复刻）
  // ===========================================================================

  const newViewFull = await renderLedgerHistory({
    db,
    characterId,
    userId: USER1,
    userName: USER1_NAME,
    characterName: character.name,
    limit: 20,
  })

  // B1 角色：user-1 → 用户名；她 → 角色名；系统 → 系统；user-2 → 用户 <id>（不冒名）
  const b1ok =
    newViewFull.includes(`${USER1_NAME}: 今天天气真好`) &&
    newViewFull.includes(`${character.name}: 是呀，适合出门走走`) &&
    newViewFull.includes('系统: 会话归档点') &&
    newViewFull.includes(`用户 ${String(USER2)}: 你好，我是另一位用户`) &&
    !newViewFull.includes(`${character.name}: 你好，我是另一位用户`)
  record(
    'B1',
    '角色如实分列：user-1=用户名 · 她=角色名 · 系统=系统 · user-2=用户 <id>（不冒名）',
    '四类各归其名',
    `user-1=${newViewFull.includes(`${USER1_NAME}: 今天天气真好`)} · 系统=${newViewFull.includes('系统: 会话归档点')} · user-2 不冒名=${!newViewFull.includes(`${character.name}: 你好，我是另一位用户`)}`,
    b1ok,
  )
  // B2 顺序：渲染顺序 = 账本 sequence 升序（第一句在前，B 会话第二句在最后）
  const idxFirst = newViewFull.indexOf('今天天气真好')
  const idxLastB = newViewFull.indexOf('B 会话的第二句')
  const idxSys = newViewFull.indexOf('会话归档点')
  const b2ok = idxFirst >= 0 && idxLastB >= 0 && idxSys >= 0 && idxFirst < idxSys && idxSys < idxLastB
  record(
    'B2',
    '顺序 = 账本序：用户首句 → 系统行 → B 会话末句（sequence 升序）',
    '首句 < 系统行 < B 末句',
    `${String(idxFirst)} < ${String(idxSys)} < ${String(idxLastB)}`,
    b2ok,
  )
  // B3 作用域：会话 B 两条都可见（角色级视图）
  const b3ok = newViewFull.includes('B 会话的第一句') && newViewFull.includes('B 会话的第二句')
  record(
    'B3',
    '作用域 = 角色级：会话 B 的两条可见（与 memory:list 同源）',
    'B 会话两条可见',
    b3ok ? '可见' : '不可见',
    b3ok,
  )
  // B4 分页：limit=5 ⇒ 恰好尾部 5 条（按 sequence）
  const newView5 = await renderLedgerHistory({
    db,
    characterId,
    userId: USER1,
    userName: USER1_NAME,
    characterName: character.name,
    limit: 5,
  })
  const b4ok =
    newView5.includes('最近 5 条') &&
    newView5.includes('B 会话的第二句') &&
    !newView5.includes('今天天气真好')
  record(
    'B4',
    '分页：limit=5 ⇒ 尾部 5 条（含 B 末句，不含首句）',
    '最近 5 条 · 含末句 · 无首句',
    `含末句=${newView5.includes('B 会话的第二句')} · 无首句=${!newView5.includes('今天天气真好')}`,
    b4ok,
  )
  // B6（先算，B5 要用）：与权威读数 1:1 —— 渲染行数 = 账本事件数，文本集合一致
  const { recentConversationEvents } = await import(
    '../src/infrastructure/persistence/conversation-store.ts'
  )
  const authoritative = await recentConversationEvents(db, { characterId, limit: 20 })
  const renderedTexts = newViewFull
    .split('\n')
    .filter((l) => l.startsWith('  ['))
    .map((l) => l.replace(/^  \[[^\]]+\] [^:]+: /, ''))
  const authoritativeTexts = authoritative.map((e) =>
    (typeof e.content === 'string' ? e.content : JSON.stringify(e.content)).replace(/\n/g, ' / ')
  )
  const b6ok =
    renderedTexts.length === authoritativeTexts.length &&
    authoritativeTexts.every((t, i) => renderedTexts[i] === t)
  record(
    'B6',
    '与权威读数 1:1：渲染行 = recentConversationEvents 逐条对应（顺序与文本）',
    `${String(authoritativeTexts.length)} 条逐条一致`,
    `渲染 ${String(renderedTexts.length)} 条 vs 账本 ${String(authoritativeTexts.length)} 条 · 逐条一致=${String(authoritativeTexts.every((t, i) => renderedTexts[i] === t))}`,
    b6ok,
  )

  // B5 重启读回：同目录二次装配（新进程语义：连接重置 + 重新初始化）⇒ 逐字相同
  await bed.dispose()
  const bed2 = await assemble()
  const newViewAfterRestart = await renderLedgerHistory({
    db: bed2.db,
    characterId: bed2.characterId,
    userId: USER1,
    userName: USER1_NAME,
    characterName: character.name,
    limit: 20,
  })
  const b5ok = newViewAfterRestart === newViewFull
  record(
    'B5',
    '重启读回：同目录二次装配 ⇒ 视图逐字相同（账本是持久权威源）',
    '逐字相同',
    b5ok ? '逐字相同' : '发生了漂移',
    b5ok,
  )
  await bed2.dispose()

  // ===========================================================================
  // C 段：认知链静态事实（--history 不进任何认知链；kernel 零镜像读取）
  // ===========================================================================

  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = join(dir, e.name)
      return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
  const kernelFiles = walk(join(REPO_ROOT, 'src', 'kernel'))
  const cognitiveInfra = [
    ...walk(join(REPO_ROOT, 'src', 'infrastructure', 'runtime')).filter((p) =>
      p.includes('adapters.ts') || p.includes('history-view.ts') || p.includes('relationship-scheduler.ts'),
    ),
  ]
  const mirrorReadPattern = /tableName:\s*'messages'|getMemories\(\{\s*tableName:\s*'messages'/
  const kernelViolations = kernelFiles.filter((p) => {
    try {
      return mirrorReadPattern.test(readFileSync(p, 'utf8'))
    } catch {
      return false
    }
  })
  const c1ok = kernelViolations.length === 0 && kernelFiles.length > 0
  record(
    'C1',
    '认知链零镜像读取：src/kernel/**（contracts/policies/projections/context/app/recall/action）无 messages 镜像读取',
    `0 处（扫描 ${String(kernelFiles.length)} 个 .ts）`,
    `${String(kernelViolations.length)} 处${kernelViolations.length > 0 ? `：${kernelViolations.join(', ')}` : ''}`,
    c1ok,
  )
  const historyViewUsesLedger = readFileSync(
    join(REPO_ROOT, 'src', 'infrastructure', 'runtime', 'history-view.ts'),
    'utf8',
  )
  const c2ok =
    historyViewUsesLedger.includes('recentConversationEvents') &&
    !mirrorReadPattern.test(historyViewUsesLedger) &&
    cognitiveInfra.length > 0
  record(
    'C2',
    '替换落地：history-view.ts 只读账本（recentConversationEvents），无镜像读取',
    '只读账本',
    c2ok ? '只读账本' : '仍有镜像读取（未替换干净）',
    c2ok,
  )

  // ===========================================================================
  // 汇总 + 证据
  // ===========================================================================

  const passed = checks.filter((c) => c.pass).length
  const failed = checks.length - passed
  const stageA = checks.filter((c) => c.id.startsWith('A')).length
  const stageB = checks.filter((c) => c.id.startsWith('B')).length
  const stageC = checks.filter((c) => c.id.startsWith('C')).length
  const measuredEvents = authoritativeTexts.length
  const stagesValid = stageA > 0 && stageB > 0 && stageC > 0 && measuredEvents > 0
  const verdict = !stagesValid ? 'MEASUREMENT INVALID' : failed === 0 ? 'PASS' : 'FAIL'

  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  const runId = createM7RunId({ wpId: 'wp6-td07', headShort: head })
  const dir = openM7RunDir(REPO_ROOT, runId)
  const payload = {
    schema: 'm7-wp6-td07@1',
    runId,
    capturedAt: new Date().toISOString(),
    head,
    adjudication: {
      decision: 'minimal-replacement',
      summary:
        'renderHistory 数据源从 ElizaOS messages 遗留镜像换为 Kernel 账本（conversation_events）；' +
        '三缺陷（缺一半/标错人/作用域错）由换源消除；--history 仍是人类调试视图，不进认知链（C 段静态事实）。',
      constraintsHonored: [
        '不把错误历史视图当认知证据（C1/C2 机器事实）',
        '不顺带重做 Console（只换数据源，命令形状不变）',
      ],
    },
    stages: { defectPresent: stageA, replacementQuiet: stageB, staticFacts: stageC },
    measured: { ledgerEvents: measuredEvents, checks: checks.length },
    checks,
    verdict,
    counts: { total: checks.length, passed, failed },
  }
  writeFileSync(join(dir, 'verify.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  writeM7Manifest(dir, {
    runId,
    wp: 'wp6-td07',
    head,
    headShort: head.slice(0, 12),
    branch: 'feature/m7-relationship',
    date: payload.capturedAt.slice(0, 10),
    toolVersions: { node: process.version },
    testType: 'component-verify',
    counts: { total: checks.length, passed, failed },
    phases: ['single'],
    supersedes: null,
    notes: 'TD-07 预检：缺陷在场证明（旧镜像视图复刻）→ 最小替换后安静（账本视图真实现）→ 认知链静态事实（隔离库）',
  })

  console.log(`runId: ${runId}`)
  for (const c of checks) {
    console.log(`  ${c.pass ? '✅' : '❌'} ${c.id} ${c.label}`)
  }
  console.log(
    `stages: 缺陷在场=${String(stageA)} · 替换后安静=${String(stageB)} · 静态事实=${String(stageC)} · 账本事件=${String(measuredEvents)}`,
  )
  console.log(`verdict: ${verdict}（${String(passed)}/${String(checks.length)}）`)
  process.exitCode = verdict === 'PASS' ? 0 : 1
}

await main()
