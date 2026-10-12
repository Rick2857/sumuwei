/**
 * M7 WP6-B · TD-06 —— **场景 setup 注入器**（独立子进程；零模型调用）。
 *
 * 把 `evals/m7/td06-current-input-v1.jsonl` 里一个场景的 setup[]（往轮对话）
 * 写进隔离库账本——归因形状与生产交互控制台**同款**（human-console 用户
 * ingress + character 助手 ingress；WP6 离线门 G 段的接线形状）。
 *
 * 为什么是独立进程：注入完就退出 ⇒ pgLite 单持有立即释放，随后的探针轮
 * spawn（src/main.ts）不会与注入器抢锁（INC-01 的跨进程单持有纪律）。
 *
 * 用法：tsx scripts/m7-td06-setup-inject.ts --db-dir <沙箱> --scenario TDS-01 [--user-name Alex]
 */
import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { isProductionDir, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'

interface CorpusEntry {
  readonly role: 'user' | 'assistant'
  readonly text: string
}
interface CorpusScenario {
  readonly id: string
  readonly setup: readonly CorpusEntry[]
  readonly probe: string
}

const argValue = (name: string): string | undefined => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

async function inject(): Promise<void> {
  const dbDir = argValue('--db-dir')
  const scenarioId = argValue('--scenario')
  const userName = argValue('--user-name') ?? 'Alex'
  if (dbDir === undefined || scenarioId === undefined) {
    console.error('用法：tsx scripts/m7-td06-setup-inject.ts --db-dir <沙箱> --scenario <TDS-xx> [--user-name Alex]')
    process.exit(2)
  }
  const resolved = resolve(dbDir)
  if (!existsSync(resolved)) {
    console.error(`沙箱目录不存在：${resolved}`)
    process.exit(3)
  }
  if (isProductionDir(resolved) || resolved === resolve(PRODUCTION_DB_DIR)) {
    console.error('拒绝：该路径被判成生产库')
    process.exit(3)
  }

  const corpusPath = resolve(process.cwd(), 'evals', 'm7', 'td06-current-input-v1.jsonl')
  const scenarios = readFileSync(corpusPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as CorpusScenario)
  const scenario = scenarios.find((s) => s.id === scenarioId)
  if (scenario === undefined) {
    console.error(`场景不存在：${scenarioId}（语料 ${corpusPath}）`)
    process.exit(3)
  }
  /* 形状闸：setup 必须以 user 开头且 user/assistant 交替（语料冻结形状） */
  for (let i = 0; i < scenario.setup.length; i += 1) {
    const entry = scenario.setup[i]
    const expectedRole = i % 2 === 0 ? 'user' : 'assistant'
    if (entry.role !== expectedRole) {
      console.error(`场景 ${scenarioId} setup[${String(i)}] 角色是 ${entry.role}，冻结形状要求 ${expectedRole} ⇒ 拒绝注入`)
      process.exit(3)
    }
  }

  process.env.PGLITE_DATA_DIR = resolved
  process.env.PROJECT_LG_SANDBOX = resolved

  const { AgentRuntime, stringToUuid } = await import('@elizaos/core')
  const sqlPlugin = (await import('@elizaos/plugin-sql')).default
  const { character } = await import('../src/character/index.ts')
  const { initDatabase } = await import('../src/db/index.ts')
  const { getRawDb } = await import('../src/infrastructure/persistence/db.ts')
  const { asCharacterId, asConversationId } = await import('../src/kernel/contracts/ids.ts')
  const { ConversationRecorder } = await import('../src/infrastructure/runtime/conversation-recorder.ts')
  const {
    createCharacterAssistantTurnIngress,
    createHumanConsoleUserTurnIngress,
  } = await import('../src/infrastructure/runtime/conversation-attribution.ts')
  const { latestConversationSequence } = await import('../src/infrastructure/persistence/conversation-store.ts')

  const characterId = asCharacterId(character.id ?? character.name)
  const userId = stringToUuid(`user-${userName}`)
  const conversationId = asConversationId(`td06-${scenarioId}`)

  const runtime = new AgentRuntime({
    character: character as never,
    plugins: [sqlPlugin],
    conversationLength: 16,
    settings: { OPENAI_API_KEY: 'placeholder', OPENAI_BASE_URL: '' },
  } as never)
  await initDatabase(runtime, sqlPlugin)
  const db = getRawDb(runtime)

  const recorder = new ConversationRecorder({
    db,
    characterId,
    conversationId,
    dryRun: false,
    userName,
    characterName: character.name,
    transport: 'm7-td06-setup',
    attribution: [createHumanConsoleUserTurnIngress(), createCharacterAssistantTurnIngress()],
    userId,
    userRef: userName,
  })

  /* 会话内序号必须连续（conversation-recorder 的 assertSequenceContiguous：
     只有角色级序号允许空洞）。逐条目 +1：user@n、assistant@n+1。 */
  let conversationSequence = (await latestConversationSequence(db, characterId, conversationId)) + 1
  let injected = 0
  for (const entry of scenario.setup) {
    if (entry.role === 'user') {
      const outcome = await recorder.recordUserMessage(entry.text, conversationSequence)
      if (outcome.event === undefined) throw new Error(`setup 注入失败（user @cs${String(conversationSequence)}）`)
      lastUserEventId = outcome.event.id
      lastAssistantSeq = outcome.assistantSequence
    } else {
      if (lastUserEventId === undefined || lastAssistantSeq === undefined) {
        throw new Error('setup 形状破损：assistant 先于 user（注入器拒绝猜测 replyTo）')
      }
      await recorder.recordAssistantMessage({
        text: entry.text,
        conversationSequence,
        characterSequence: lastAssistantSeq,
        replyToEventId: lastUserEventId,
        deliveryStatus: 'delivered',
      })
    }
    injected += 1
    conversationSequence += 1
  }
  console.log(`  注入完成：${scenarioId} · ${String(injected)} 条 setup · 会话 ${conversationId}`)
}

let lastUserEventId: import('../src/kernel/contracts/ids.ts').ConversationEventId | undefined
let lastAssistantSeq: number | undefined

await inject()
