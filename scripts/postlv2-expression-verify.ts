/** Offline guard, bridge, queue identity and Cubism playback lifecycle checks. No database or model calls. */
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { bindSpeechExpression, decodeExpressiveSpeech, EXPRESSION_CUES, withoutAppendices } from '../src/kernel/contracts/expressive-speech.ts'
import { createExpressiveSpeechProvider } from '../src/kernel/context/expressive-speech-section.ts'
import { runReplyGuardChain } from '../src/kernel/app/reply-guard-chain.ts'
import { TurnBridge, handleBridgeMessage } from '../src/kernel/app/bridge/turn-bridge.ts'

const checks: string[] = []
function check(name: string, body: () => void) { body(); checks.push(name) }
const envelope = (segments: unknown) => `<lg-speech>${JSON.stringify({ segments })}</lg-speech>`
const draft = decodeExpressiveSpeech(envelope([{ text: '别担心。', cue: 'reassuring' }, { text: '我在这里。', cue: 'firm' }]))
const sidecar = bindSpeechExpression('reply:test', draft.text, draft)
check('two sentences retain distinct cues and checked text', () => {
  assert.deepEqual(sidecar.segments.map((item) => item.cue), ['reassuring', 'firm'])
  assert.equal(sidecar.segments.map((item) => item.text).join(''), draft.text)
  assert.deepEqual(sidecar.segments.map((item) => item.segmentId), ['reply:test#0', 'reply:test#1'])
})
check('all six cues are accepted', () => {
  for (const cue of EXPRESSION_CUES) assert.equal(decodeExpressiveSpeech(envelope([{ text: '你好。', cue }])).segments[0].cue, cue)
})
check('unknown cue falls back without modifying speech', () => {
  const value = decodeExpressiveSpeech(envelope([{ text: '这是 [TODO] 字段。', cue: 'costume_v0100' }]))
  assert.equal(value.text, '这是 [TODO] 字段。')
  assert.equal(value.segments[0].cue, 'natural')
  assert.equal(value.fallback, 'unknown_cue')
})
check('plain text fallback preserves literal tags', () => {
  const text = '正文里提到 [happy] 和 <response>。'
  assert.equal(decodeExpressiveSpeech(text).text, text)
})
check('invalid protocol body never becomes spoken metadata', () => {
  for (const raw of ['<lg-speech>broken</lg-speech>', envelope([]), envelope([{ text: '', cue: 'firm' }]), '<lg-speech>']) {
    assert.throws(() => decodeExpressiveSpeech(raw))
  }
})
check('real reply guard rewrite invalidates old expressive alignment', () => {
  const raw = decodeExpressiveSpeech(envelope([{ text: '我已经记住了。', cue: 'playful' }]))
  const guarded = runReplyGuardChain({ replyText: raw.text, memoryWriteResult: {
    kind: 'not_written', intent: 'remember', reason: 'persistence_failed', summary: 'offline synthetic write failure',
  } })
  assert.notEqual(guarded.replyText, raw.text)
  const rebound = bindSpeechExpression('reply:guard', guarded.replyText, raw)
  assert.equal(rebound.fallback, 'guard_rewrite')
  assert.ok(rebound.segments.every((item) => item.cue === 'natural'))
  assert.equal(rebound.segments.map((item) => item.text).join(''), guarded.replyText)
})
/*
 * Lv4.5 / P1：**程序追加的附录不该被念出来**（2026-10-04 真实链路实测到的缺陷）。
 *
 * 实测原话：她把 `[E1] 7-day forecast — https://www.kxan.com/7-day-forecast` 与
 * `lat=30.26759000000004&lon=-97.74298999999996` 当成句子念了出来。
 *
 * 这一组判据守三件事：
 * ```text
 * ① 结尾的附录被去掉（语音与字幕都不含它）
 * ② 去掉之后**分句仍然逐字拼回同一份文本**（外壳会校验 join(分句) === replyText）
 * ③ **不做模糊匹配**：附录没出现、或只出现在中间时，文本一个字不变
 *    （否则"去掉附录"会变成"改写她的话"，那是另一回事）
 * ```
 */
check('program appendix is not spoken, and text without it is unchanged', () => {
  const body = '查了。出来五条，没一条是这边的。'
  const appendix = '来源：\n[E1] 7-day forecast — https://www.kxan.com/7-day-forecast\n[E2] National Weather Service — https://forecast.weather.gov/MapClick.php?lat=30.26&lon=-97.74'
  const withAppendix = `${body}\n\n${appendix}`
  /* ① 去掉附录 */
  assert.equal(withoutAppendices(withAppendix, [appendix]), body)
  /* ② 去掉之后的文本仍然自洽：分句拼回去 === 那一份文本 */
  const spokenDraft = decodeExpressiveSpeech(withoutAppendices(withAppendix, [appendix]))
  const spokenSidecar = bindSpeechExpression('reply:appendix', spokenDraft.text, spokenDraft)
  assert.equal(spokenSidecar.segments.map((item) => item.text).join(''), body)
  assert.ok(spokenSidecar.segments.every((item) => !item.text.includes('https://')))
  /* ③ 不猜：附录没出现 / 只在中间 ⇒ 原样 */
  assert.equal(withoutAppendices(body, [appendix]), body)
  assert.equal(withoutAppendices(`前 ${appendix} 后`, [appendix]), `前 ${appendix} 后`)
  assert.equal(withoutAppendices(body, ['', '   ']), body)
  /* 长的先剥：短附录是长附录的后缀时，不能把长附录留半截 */
  const short = '来源：\n[E1] a'
  assert.equal(withoutAppendices(`${body}\n\n${short}\n[E2] b`, [short, `${short}\n[E2] b`]), body)
})

/*
 * 2026-10-05 真实链路事故：**同一轮里会出现两个互不嵌套的附录**
 * （联网搜索的 `来源：` + 当轮内容的 `来源与范围：`）。
 *
 * 长度降序只保证"嵌套时不被短的挡"，不保证一轮就剥干净：证据附录更长、
 * 而此刻的后缀是内容附录 ⇒ 证据附录第一轮被略过、第二轮不再回头看。
 * 后果：她真的把来源列表**念出来**，且 `join(分句) === replyText` 判红 ——
 * 整轮以 `ValueError: LG sentence sidecar does not match checked text` 被丢掉。
 */
check('two independent appendices are both stripped, and the sidecar still folds back', () => {
  const body = '查了。出来五条，没一条是这边的。'
  const evidence = '来源：\n[E1] a — https://a.example/x\n[E2] b — https://b.example/y'
  const turnContent = '来源与范围：\n[C1] https://a.example/x（400 字符）'
  const both = `${body}\n\n${evidence}\n\n${turnContent}`
  /* 正控：两个都剥掉（更长的那个在第一轮里确实命中不了） */
  assert.ok(evidence.length > turnContent.length)
  assert.equal(withoutAppendices(both, [evidence, turnContent]), body)
  /* 负控：附录只出现在中间 ⇒ 一个字都不改 */
  assert.equal(withoutAppendices(`前 ${evidence} 后`, [evidence, turnContent]), `前 ${evidence} 后`)
  /* 外壳判据的镜像：剥完之后的正文，分句必须逐字拼得回去 */
  const spokenDraft = decodeExpressiveSpeech(withoutAppendices(both, [evidence, turnContent]))
  const spokenSidecar = bindSpeechExpression('reply:two-appendices', spokenDraft.text, spokenDraft)
  assert.equal(spokenSidecar.segments.map((item) => item.text).join(''), body)
  assert.ok(spokenSidecar.segments.every((item) => !item.text.includes('来源')))
})
const provider = await createExpressiveSpeechProvider().provide({} as never)
check('expression instruction is a named compiler section', () => {
  assert.equal(provider[0].id, 'expressive-speech')
  assert.equal(provider[0].kind, 'instruction')
  assert.ok(provider[0].content.includes('reassuring'))
})
const bridge = new TurnBridge({ host: { characterId: 'lg', conversationId: 'test', async runTurn() {
  return { replyText: draft.text, replyId: sidecar.replyId, traceId: 'trace:test', domainEventIds: [], expression: sidecar }
} } })
const first = await handleBridgeMessage(bridge, { kind: 'SUBMIT_TURN', requestId: 'expr:1', userText: '你好' })
const duplicate = await handleBridgeMessage(bridge, { kind: 'SUBMIT_TURN', requestId: 'expr:1', userText: '你好' })
check('sidecar survives bridge wire and idempotent replay', () => {
  assert.deepEqual(first.expression, sidecar)
  assert.deepEqual(duplicate.expression, first.expression)
  assert.equal(first.delivery, 'generated')
})

const { createExpressionPlayback } = await import(pathToFileURL(resolve('scripts/postlv2_expression_client.js')).href)
let clock = 0
const values = [2, 3, 0.7, 0.4] // head Y, head Z, mouth, eye
const renderings: number[][] = []
const ids = ['ParamAngleY', 'ParamAngleZ', 'ParamMouthOpenY', 'ParamEyeLOpen']
const core = {
  getParameterCount: () => ids.length,
  getParameterId: (i: number) => ({ getString: () => ({ s: ids[i] }) }),
  getParameterValueByIndex: (i: number) => values[i],
  setParameterValueByIndex: (i: number, value: number) => { values[i] = value },
  getParameterMinimumValue: () => -30,
  getParameterMaximumValue: () => 30,
  update: () => { renderings.push([...values]) },
}
const originalUpdate = core.update
const expressions: string[] = []
const model = { _model: core, _wavFileHandler: { releasePcmData() {} } }
const adapter = { setExpression: (value: string) => expressions.push(value), getExpressionCount: () => 3,
  getExpressionName: (i: number) => ['neutral', 'smile', 'surprised'][i] }
const client = createExpressionPlayback(() => model, () => adapter, () => clock)
const meta = { version: 'lg-expression@1', generation: 1, replyId: 'r', segmentId: 'r#0', cue: 'reassuring', expression: 'smile', gesture: 'nod' }
const audio = { pause() {}, dispatchEvent() {} }
check('queued or synthesized sentence does not change face', () => {
  client.begin(1)
  assert.equal(client.canPlay(meta), true)
  assert.equal(expressions.length, 0)
})
check('actual playback enables face and bounded nod without mouth or eye writes', () => {
  assert.equal(client.start(meta, audio), true)
  assert.equal(expressions.at(-1), 'smile')
  clock = 350
  core.update()
  assert.ok(renderings.at(-1)![0] > 2 && renderings.at(-1)![0] <= 5)
  assert.deepEqual(renderings.at(-1)!.slice(2), [0.7, 0.4])
  assert.deepEqual(values, [2, 3, 0.7, 0.4])
})
check('natural end restores owned hook and neutral face', () => {
  client.finish('r#0')
  assert.equal(core.update, originalUpdate)
  assert.equal(expressions.at(-1), 'neutral')
  assert.equal(client.reading().active, null)
  assert.equal(client.canPlay({ ...meta, segmentId: 'r#1' }), true)
})
check('duplicate, stale generation and costume expression are rejected', () => {
  assert.equal(client.canPlay(meta), false)
  assert.equal(client.canPlay({ ...meta, generation: 0, segmentId: 'r#1' }), false)
  assert.equal(client.canPlay({ ...meta, expression: 'costume_v0100', segmentId: 'r#2' }), false)
})
check('new turn releases old expression and rejects queued old sentence', () => {
  client.start({ ...meta, segmentId: 'r#1' }, audio)
  client.begin(2)
  assert.equal(core.update, originalUpdate)
  assert.equal(client.canPlay({ ...meta, segmentId: 'r#2' }), false)
})
check('tilt clamps at model range and resets after interruption', () => {
  values[1] = 29
  const next = { ...meta, generation: 2, segmentId: 'r#3', cue: 'playful', gesture: 'tilt' }
  client.start(next, audio)
  clock += 900
  core.update()
  assert.equal(renderings.at(-1)![1], 30)
  assert.equal(values[1], 29)
  client.stop('interrupted')
  assert.equal(core.update, originalUpdate)
  assert.equal(client.reading().active, null)
})
check('disconnect releases expression and resets generation for reconnect', () => {
  client.start({ ...meta, generation: 2, segmentId: 'r#4' }, audio)
  client.disconnect()
  assert.equal(core.update, originalUpdate)
  assert.equal(client.reading().generation, 0)
  assert.equal(client.begin(1), true)
})
check('interruption before playback revokes queued and late audio', () => {
  client.stop('interrupted')
  assert.equal(client.canPlay({ ...meta, generation: 1, segmentId: 'r#5' }), false)
  assert.equal(client.begin(2), true)
  assert.equal(client.canPlay({ ...meta, generation: 2, segmentId: 'r#6' }), true)
})
/**
 * Lv4.5 / `P3`：**跨边界的那个字符串必须两端一致**。
 *
 * ============================================================================
 *  为什么值得单独锁一条
 * ============================================================================
 * "她能不能在你还在说话的时候把「我在。」说出来"取决于**一个字符串**：
 * ```text
 * 外壳把 requestId = "interjection" 写进 lg_expression 元数据
 * 页面用它决定"这一块音频在 listening 时是否放行"
 * ```
 * 任何一端改了写法（比如换成 `interjection:` 或 `wake`），**编译照样过、类型照样对**，
 * 而症状是"**她没反应**" —— 我实测遇到过这个症状（页面把插话整块丢弃），
 * 而当时**没有任何一道门**会发现它。所以这里把两端钉在一起。
 *
 * ⚠️ 另一端在**仓库之外**（已构建的页面），因此这里读的是**补丁脚本**：
 *    它每次从受审的上游提交重建页面 ⇒ 锁住补丁 = 锁住部署结果。
 */
check('interjection routing string is identical at both ends of the wire', () => {
  const shell = readFileSync(resolve('scripts/postlv2_vtuber_runtime.py'), 'utf8')
  const patcher = readFileSync(resolve('scripts/postlv2-expression-frontend.py'), 'utf8')
  /* ① 外壳确实用这个字面量作为 `presentation(..., request_id, ...)` 的第三个实参 */
  assert.ok(
    shell.includes('"interjection:" + str(payload.get("revision")), "interjection"'),
    '外壳必须把 requestId="interjection" 交给 presentation()'
  )
  /* ② 页面补丁确实按同一个字面量放行 */
  assert.ok(
    patcher.includes("?.requestId === 'interjection'"),
    '页面补丁必须按 requestId === \'interjection\' 放行插话'
  )
  /* ③ 页面**不能**再是无条件丢弃（那正是实测到的症状） */
  assert.ok(
    !patcher.includes("if (aiState === 'interrupted' || aiState === 'listening') break;"),
    '页面不能无条件丢弃 listening 期间的音频块：那会把插话整块吃掉'
  )
})
check('a interrupted user outranks the interjection on the page side too', () => {
  const patcher = readFileSync(resolve('scripts/postlv2-expression-frontend.py'), 'utf8')
  /* ⚠️ 用户明确打断 ⇒ 连插话也不播（用户优先），这一条不能被上面那条放宽掉 */
  assert.ok(patcher.includes("if (aiState === 'interrupted') break;"))
  assert.ok(patcher.includes("if (aiState === 'listening' && !isInterjection) break;"))
})
/**
 * ⚠️ **部署出来的那一份**也要对：补丁对了、但服务供的是**旧包**时，
 *    仓库里一切绿灯而用户依然听不到 —— 那正是实测遇到的症状。
 *
 * ⚠️ 页面在仓库之外（`~/postlv2-deps/.../frontend`）。它**不在**时**不算 PASS**：
 *    这一条如实报 `NOT RUN` 并写进证据（"没检查"与"检查通过"必须分得开）。
 */
const deployedBundle = (() => {
  const root = resolve(homedir(), 'postlv2-deps/Open-LLM-VTuber/frontend/assets')
  try {
    const names = readdirSync(root).filter((name) => /^main-.*\.js$/.test(name))
    if (names.length === 0) return undefined
    const newest = names
      .map((name) => ({ name, at: statSync(resolve(root, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]!
    return { name: newest.name, text: readFileSync(resolve(root, newest.name), 'utf8') }
  } catch {
    return undefined
  }
})()
check('the DEPLOYED page bundle carries the interjection guard (else NOT RUN, never PASS)', () => {
  if (deployedBundle === undefined) {
    /* 明确记为未检查 —— 缺证据不等于通过 */
    console.log('  ⏳ 部署包不存在 ⇒ 这一条 NOT RUN（不是 PASS）')
    return
  }
  /* 压缩后比较式仍在：`...requestId)==="interjection"` ⇒ 守卫在包里 */
  assert.ok(
    deployedBundle.text.includes('"interjection"') || deployedBundle.text.includes("'interjection'"),
    `部署包 ${deployedBundle.name} 里没有插话守卫：页面会把插话整块丢弃`
  )
})
const dir = resolve('artifacts/post-lv2/expression-integration-20261004')
mkdirSync(dir, { recursive: true })
writeFileSync(resolve(dir, 'offline.json'), JSON.stringify({ scope: 'offline behavior only; no GPU, database or real renderer', checks, passed: checks.length }, null, 2) + '\n')
console.log(`Expression offline checks PASS ${checks.length}/${checks.length}`)
console.log(execFileSync(resolve(homedir(), 'postlv2-deps/qwen3-tts-venv/Scripts/python.exe'),
  ['-B', '-X', 'utf8', resolve('scripts/postlv2-expression-verify.py')], { encoding: 'utf8' }).trim())
