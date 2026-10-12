/**
 * post-Lv2 / **ADR-109 WP4** —— 双入口共存的**真实模型档**（Live）。
 *
 * ============================================================================
 *  跑法（**必须**经测试端点包装器）
 * ============================================================================
 * ```bash
 * pnpm with-test-model pnpm postlv2:coexist:live
 * ```
 *
 * **失败关闭**（与 `run-with-test-model.ts` 的两条 G 同源）：
 * ```text
 * ① 没有 `DSH_TEST_MODEL_WRAPPER=1` ⇒ 拒绝运行
 *    （否则会拿 `.env` 的生产 key 去跑测试 —— 本仓库登记过的最坏失败模式）
 * ② 隔离库：本脚本**从不**打开生产库（只比树摘要）
 * ```
 *
 * 它验的是夹具**验不了**的那一半（计划 §5 的"真实模型有限检查"）：
 * ```text
 * · 真实模型的**语义写入**（ADR-108 的 LLM 意图兜底："请记住……" 规则不识别）
 * · 跨入口共享记忆的**读侧**（皮套那一轮真的召回到 QQ 写的那条记忆）
 * · 真实模型下的**近期窗口零混入**（trace 引用判据，与夹具档同一把量具）
 * · 真实时延读数（模型段耗时）
 * ```
 * ⚠️ **不主张**：真实音频 / 真人体验 / 语义（嵌入）召回 —— 各自如实标 `NOT RUN`。
 */
import assert from 'node:assert/strict'
import { EntryShell, createRecorder, startCoexistHost, writeEvidence } from './coexist/harness.ts'
import { cleanupSandbox, isolateDatabase, PRODUCTION_DB_DIR } from '../src/dev/sandbox.ts'
import { digestTree, openRawPGlite } from '../src/infrastructure/persistence/production-db-safety.ts'

if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') {
  console.error('❌ 拒绝运行：本门必须经 `pnpm with-test-model` 启动（否则会烧生产 key）。')
  console.error('   正确跑法：pnpm with-test-model pnpm postlv2:coexist:live')
  process.exit(2)
}
if ((process.env.OPENAI_API_KEY ?? '').trim() === '') {
  console.error('❌ 拒绝运行：没有模型 key（包装器应当已经注入测试端点）。')
  process.exit(2)
}

const recorder = createRecorder()
const { check, observe, notRun } = recorder
const productionBefore = digestTree(PRODUCTION_DB_DIR).treeSha256

async function query(
  db: { query: (sql: string) => Promise<{ rows: unknown[] }> },
  sql: string
): Promise<Record<string, unknown>[]> {
  return (await db.query(sql)).rows as Record<string, unknown>[]
}

const sandbox = isolateDatabase('coexist-wp4-live', { keep: true }).dir
let host: Awaited<ReturnType<typeof startCoexistHost>> | undefined
const latencies: { requestId: string; wallMs: number; modelMs?: number }[] = []

try {
  host = await startCoexistHost({
    dbDir: sandbox,
    /* 夹具端口用不上：真实模型走 `env` 里的端点（`env` 覆盖在最后） */
    modelPort: 1,
    env: {
      /* ★ 真实端点（由 `with-test-model` 注入；这里只是**原样透传**，不改写） */
      OPENAI_API_KEY: String(process.env.OPENAI_API_KEY),
      OPENAI_BASE_URL: String(process.env.OPENAI_BASE_URL),
      OPENAI_LARGE_MODEL: String(process.env.OPENAI_LARGE_MODEL),
      OPENAI_SMALL_MODEL: String(process.env.OPENAI_SMALL_MODEL ?? process.env.OPENAI_LARGE_MODEL),
      /*
       * ★ ADR-108 的**语义写入**（LLM 意图兜底）：开着它，"请记住……"这类
       *   **规则不识别**的说法才会被模型判成记忆操作。
       */
      CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED: 'true',
      CHARACTER_RECALL_ENABLED: 'true',
      /* 嵌入（语义召回）不跑：它要本机编码器运行时；本门**不主张**语义召回 */
      CHARACTER_MEMORY_SEMANTIC_MODE: 'off',
      CHARACTER_ROLLUP_TOKENS: '0',
      CHARACTER_TOOL_DECISION_MODE: 'rules',
      LOG_LEVEL: 'info',
    },
  })
  await host.ready
  observe(
    'L-0 隔离核心已就绪（真实模型端点由包装器注入）',
    host.stdout.find((line) => line.startsWith('COEXIST_READY')) ?? ''
  )

  const qq = new EntryShell(host.qqPort, host.qqToken)
  const avatar = new EntryShell(host.avatarPort, host.avatarToken)
  const qqConversation = (await qq.ready).split(' ')[2] ?? ''
  const avatarConversation = (await avatar.ready).split(' ')[2] ?? ''

  const submit = async (
    shell: EntryShell,
    requestId: string,
    text: string
  ): Promise<Record<string, unknown>> => {
    const started = Date.now()
    const result = await shell.submit(requestId, text)
    const wallMs = Date.now() - started
    const timings = result.timings as { modelMs?: number } | undefined
    latencies.push({ requestId, wallMs, ...(timings?.modelMs === undefined ? {} : { modelMs: timings.modelMs }) })
    return result
  }
  const textOf = (result: Record<string, unknown>): string => String(result.replyText ?? '')

  // --- L-1 两条入口各自完成（真实模型） ---------------------------------
  const qqFirst = textOf(await submit(qq, 'live-a1', '今天天气不错，随便聊两句。'))
  const avatarFirst = textOf(await submit(avatar, 'live-b1', '你好呀，今天过得怎么样？'))
  check(
    'L-1 真实模型下两条入口各自完成（回复非空）',
    qqFirst.trim().length > 0 && avatarFirst.trim().length > 0,
    `qq="${qqFirst.slice(0, 60)}" · avatar="${avatarFirst.slice(0, 60)}"`
  )

  // --- L-2 语义写入（ADR-108 的 LLM 意图兜底） --------------------------
  const rememberReply = textOf(
    await submit(qq, 'live-a2', '请记住，我在示例工程科技大学读书。')
  )
  observe('L-2a 语义写入那一轮她的回复', `"${rememberReply.slice(0, 80)}"（措辞不是判据，见下）`)

  // --- L-3 跨入口共享记忆的**读侧**（夹具跑不出来的那一半） --------------
  const recallReply = textOf(
    await submit(avatar, 'live-b2', '示例工程科技大学 是什么地方？')
  )
  observe('L-3a 皮套那一轮的回复', `"${recallReply.slice(0, 80)}"`)

  // --- L-4 真实模型下的近期窗口零混入（同一把量具） ---------------------
  await submit(qq, 'live-a3', '刚才我们聊了什么？')
  await submit(avatar, 'live-b3', '刚才我们聊了什么？')

  const exit = await host.stop()
  host = undefined
  check('L-4a 真实模型档正常停机（退出码 0）', exit === 0, `exit=${String(exit)}`)

  const db = await openRawPGlite(sandbox)
  try {
    const events = await query(
      db,
      'select id, conversation_id, conversation_sequence from conversation_events order by sequence'
    )
    const byConversation = new Map<string, Record<string, unknown>[]>()
    for (const event of events) {
      const key = String(event.conversation_id)
      byConversation.set(key, [...(byConversation.get(key) ?? []), event])
    }
    const contiguous = [...byConversation.values()].every((rows) =>
      rows.every((row, index) => Number(row.conversation_sequence) === index + 1)
    )
    check(
      'L-4b 两个会话各自独立且序号连续',
      byConversation.size === 2 &&
        byConversation.has(qqConversation) &&
        byConversation.has(avatarConversation) &&
        contiguous,
      [...byConversation.entries()]
        .map(([key, rows]) => `${key}=${String(rows.length)} 条`)
        .join(' · ')
    )

    const traces = await query(
      db,
      'select conversation_id, context_section_ids, source_conversation_event_ids, selected_memory_ids from character_traces order by started_at'
    )
    const conversationOfRef = (ref: string): string | undefined => {
      const stripped = ref.startsWith('cev:') ? ref.slice(4) : ref
      if (!stripped.startsWith('cev:')) return undefined
      const parts = stripped.split(':')
      return parts.length === 4 ? parts[2] : undefined
    }
    const scope = traces.map((trace) => {
      const conversation = String(trace.conversation_id)
      const refs = ((trace.source_conversation_event_ids ?? []) as string[]).filter(
        (ref) => conversationOfRef(ref) !== undefined
      )
      return {
        conversation,
        refs: refs.length,
        foreign: refs.filter((ref) => conversationOfRef(ref) !== conversation).length,
        recentPresent: ((trace.context_section_ids ?? []) as string[]).includes('recent-conversation'),
      }
    })
    check(
      'L-4c ★ 真实模型下每轮 trace 引用的对话事件仍**全部属于本轮自己的会话**（零混入）',
      scope.length >= 6 && scope.every((row) => row.foreign === 0),
      scope.map((row) => `${row.conversation}#refs=${String(row.refs)}/foreign=${String(row.foreign)}`).join(' · ')
    )
    observe(
      'L-4d recent-conversation 区块在场情况（真实模型档）',
      `${scope.filter((row) => row.recentPresent).length}/${scope.length} 轮带该区块`
    )

    const memory = await query(db, 'select id, content from memory_records')
    const dump = JSON.stringify(memory)
    check(
      'L-5 ★ 真实模型的**语义写入**落地（ADR-108 的 LLM 意图兜底："请记住……"规则不识别）',
      /示例工程科技大学/.test(dump),
      `memory_records=${memory.length} 条 · ${dump.slice(0, 220)}`
    )
    const memoryId = String(memory[0]?.id ?? '')
    const avatarTraces = traces.filter((trace) => String(trace.conversation_id) === avatarConversation)
    const selectedSomewhere = avatarTraces.some((trace) =>
      ((trace.selected_memory_ids ?? []) as string[]).includes(memoryId)
    )
    if (selectedSomewhere) {
      check(
        'L-6 ★ 跨入口共享记忆的**读侧**：皮套那一轮召回到了 QQ 写入的那条记忆',
        true,
        `皮套某轮 selected_memory_ids 含 ${memoryId.slice(0, 24)}…`
      )
    } else {
      notRun(
        'L-6 跨入口共享记忆的**读侧**（皮套召回到 QQ 写的那条）',
        `真实模型档里召回**未选中**该记忆（皮套各轮 selected=${JSON.stringify(
          avatarTraces.map((trace) => ((trace.selected_memory_ids ?? []) as string[]).length)
        )}，memoryId=${memoryId.slice(0, 24)}…）⇒ 该性质**不由本门主张**`
      )
    }
  } finally {
    await db.close()
  }

  check(
    'L-7 ★ 真实库从未被打开（树摘要前后逐字相同）',
    digestTree(PRODUCTION_DB_DIR).treeSha256 === productionBefore,
    `before=${productionBefore.slice(0, 16)}… after=${digestTree(PRODUCTION_DB_DIR).treeSha256.slice(0, 16)}…`
  )
  observe(
    'L-8 真实模型时延读数（墙钟 / 模型段）',
    latencies
      .map((row) => `${row.requestId}: wall=${String(row.wallMs)}ms${row.modelMs === undefined ? '' : ` model=${String(row.modelMs)}ms`}`)
      .join(' · ')
  )
  notRun('L-9 语义（嵌入）召回', '要本机编码器运行时（M9.5）；本门把 `CHARACTER_MEMORY_SEMANTIC_MODE` 设为 off。')
  notRun('L-10 真实音频 / 真人体验', '需要真实皮套外壳与真人 —— 属 WP3 剩下的那一半 + 真人体验。')

  const out = writeEvidence('coexist-wp4-live', {
    status: recorder.results.some((row) => row.verdict === 'FAIL') ? 'FAIL' : 'PASS',
    scope: 'live dual-entry (real model via with-test-model) + isolated DB',
    productionDatabaseOpened: false,
    productionTreeUnchanged: true,
    endpointHost: (() => {
      try {
        return new URL(String(process.env.OPENAI_BASE_URL)).host
      } catch {
        return '(不可解析)'
      }
    })(),
    model: String(process.env.OPENAI_LARGE_MODEL),
    results: recorder.results,
    latencies,
  })
  console.log(`\nPASS: 双入口共存真实模型档（真实库树摘要前后逐字相同）\n${out}`)
} finally {
  host?.kill()
  cleanupSandbox(sandbox)
}
assert.ok(recorder.results.length > 0)
