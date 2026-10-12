/**
 * post-Lv2 / ADR-110：**真实模型档**的主动联系探针（`pnpm with-test-model pnpm postlv2:qq-proactive:live`）。
 *
 * ============================================================================
 *  它回答的是"她真的会怎么说"，而不是"代码接对了没有"
 * ============================================================================
 * ```text
 * 离线门（`postlv2:qq-proactive:verify` 212/0）证的是**判据**；
 * 这一道证的是**措辞层**：真模型拿到同一份简报，会选 send / silence / defer 里的哪一个，
 * 选 send 时她到底说了什么。
 * ```
 * ⚠️ **它不需要数据库**：这一道只跑"私有调用 + 严格解析 + 来源复核"三件，
 *    落库/投递那两件已由离线门（§33）与提醒整链证过。
 * ⚠️ **正文只进证据文件，不进 stdout**（`D-08` 的纪律：正文不进日志/账本）。
 *    证据落在 `artifacts/post-lv2/`，给**人审**看 —— 那正是本批唯一无法由机器替代的一步。
 * ⚠️ 它**不**写任何状态、**不**发任何消息、**不**打开真实库。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildProactiveInstruction,
  extractProactiveJson,
  parseProactiveProposal,
  renderProactiveBriefing,
  verifyProactiveSources,
} from '../src/kernel/contracts/proactive-proposal.ts'
import { createOpenAiProactiveCarePort } from '../src/infrastructure/model/openai-proactive-care.ts'

const ROOT = process.cwd()
/** 问几次。三次足够看出"会不会只吐同一个结局"，又不至于烧钱。 */
const CALLS = 3

const timezone = 'Asia/Shanghai'
const sources = [
  { ref: 'fact:sleep', summary: '他最近常说要早点睡，但总在凌晨还醒着' },
  { ref: 'fact:deadline', summary: '他提过这两天有个期限要交' },
  { ref: 'fact:tea', summary: '他喜欢喝不加糖的乌龙茶' },
]
const briefing = {
  kind: 'care' as const,
  opportunity: '这会儿没有人新说话；这是一次你可以主动开口的机会。',
  localTime: '2026-10-07 21:40',
  timezone,
  sources,
  textBudget: 500,
}

interface Reading {
  readonly index: number
  readonly call: 'ok' | string
  readonly decision?: string
  readonly reasonCode?: string
  readonly parseCode?: string
  readonly refsInsideClosedSet?: boolean
  readonly textCodepoints?: number
  /** ⚠️ 只进证据文件（给人审看），**不**打 stdout */
  readonly text?: string
}

const port = createOpenAiProactiveCarePort({ env: process.env })
console.log(`[live] 端口=${port.id} 端点=${port.endpointHost} 调用次数=${String(CALLS)}`)

const readings: Reading[] = []
const instruction = buildProactiveInstruction()
const userMessage = renderProactiveBriefing(briefing)

for (let index = 1; index <= CALLS; index += 1) {
  const evaluated = await port.evaluate({ instruction, briefing: userMessage })
  if (!evaluated.ok) {
    readings.push({ index, call: evaluated.failure })
    continue
  }
  const parsed = parseProactiveProposal(extractProactiveJson(evaluated.raw))
  if (!parsed.ok) {
    readings.push({ index, call: 'ok', parseCode: parsed.code })
    continue
  }
  const proposal = parsed.proposal
  const verified = verifyProactiveSources({
    sourceRefs: proposal.sourceRefs,
    available: new Set(sources.map((source) => source.ref)),
  })
  const text = proposal.decision === 'send' ? (proposal.text ?? '') : undefined
  readings.push({
    index,
    call: 'ok',
    decision: proposal.decision,
    reasonCode: proposal.reasonCode,
    refsInsideClosedSet: verified.ok,
    ...(text === undefined ? {} : { textCodepoints: [...text].length, text }),
  })
  /* ⚠️ 读数**不含正文** */
  console.log(
    `[live] 第 ${String(index)} 次：${proposal.decision} · refs合法=${String(verified.ok)}` +
      (text === undefined ? '' : ` · 正文 ${String([...text].length)} 码点（正文只进证据文件）`)
  )
}

/* ---- 空依据集：这一条是**负控**（模型说什么都不能过来源复核） ---- */
const emptyEvaluated = await port.evaluate({
  instruction,
  briefing: renderProactiveBriefing({ ...briefing, sources: [] }),
})
const emptyVerdict = (() => {
  if (!emptyEvaluated.ok) return { call: emptyEvaluated.failure, refused: true }
  const parsed = parseProactiveProposal(extractProactiveJson(emptyEvaluated.raw))
  if (!parsed.ok) return { call: 'ok', refused: true, parseCode: parsed.code }
  const verified = verifyProactiveSources({
    sourceRefs: parsed.proposal.sourceRefs,
    available: new Set<string>(),
  })
  return { call: 'ok', refused: verified.ok === false, code: verified.ok ? '' : verified.code }
})()
console.log(
  `[negative] 空依据集 ⇒ ${emptyVerdict.refused ? '拒（正控通过）' : '**没拒**（这是问题）'}` +
    ('code' in emptyVerdict ? ` · ${String(emptyVerdict.code)}` : '')
)

/* ---- 判定：正控 ≥1 次调用成功 · 所有成功解析的引用都在闭集里 · 空集必拒 ---- */
const okCalls = readings.filter((row) => row.call === 'ok')
const outOfSet = okCalls.filter((row) => row.refsInsideClosedSet === false)
const sends = okCalls.filter((row) => row.decision === 'send')
const verdict =
  okCalls.length >= 1 && outOfSet.length === 0 && emptyVerdict.refused ? 'PASS' : 'FAIL'
const runId = `qq-proactive-live-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 17)}`
const dir = join(ROOT, 'artifacts', 'post-lv2', runId)
mkdirSync(dir, { recursive: true })
writeFileSync(
  join(dir, 'readings.json'),
  `${JSON.stringify(
    {
      runId,
      at: new Date().toISOString(),
      endpointHost: port.endpointHost,
      calls: CALLS,
      verdict,
      /* ⚠️ 正文在这份文件里 —— 它是**给人审**的，不是日志 */
      readings,
      negative: emptyVerdict,
      summary: {
        okCalls: okCalls.length,
        sends: sends.length,
        silences: okCalls.filter((row) => row.decision === 'silence').length,
        defers: okCalls.filter((row) => row.decision === 'defer').length,
        refsOutOfClosedSet: outOfSet.length,
      },
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log(
  `[live] ${verdict}：成功 ${String(okCalls.length)}/${String(CALLS)}` +
    ` · send ${String(sends.length)} · silence ${String(okCalls.filter((r) => r.decision === 'silence').length)}` +
    ` · defer ${String(okCalls.filter((r) => r.decision === 'defer').length)}` +
    ` · 越界引用 ${String(outOfSet.length)}`
)
console.log(`[live] 证据（含正文，给人审）：${join(dir, 'readings.json')}`)
if (verdict !== 'PASS') process.exitCode = 1
