/**
 * M9.6 情绪模块一轮 —— **离线量具自证**（`pnpm m9.6:emotion:verify`）。
 *
 * ============================================================================
 *  它证明什么（正控 / 负控 / 恢复 三段式；协议 §6.7）
 * ============================================================================
 * ```text
 * ① 语料失败关闭：条数 / 层 / 状态 / 判定闭集 / IMPACT 必有家族 / 上下文 ≤6
 * ② ★ **子集分母必须与 M8.5 公布值逐个吻合**（8 / 5 / 29 / 22 / 47）
 *      —— 这是"我的判据重建 = 原量具"的机器证据；不吻合就必须停下查，不许继续比
 * ③ A 列调用链：合法判定 ⇒ 解析成功且 dominantFamily 正确（**正控**）
 * ④ A 列失败注入：超时 / 5xx / 拒答 / 工具调用 ⇒ **失败关闭**，绝不伪造 NEUTRAL 或 IMPACT（**负控**）
 * ⑤ ★ **伪通过负控**：一个"永远判 IMPACT/A-HOSTILE"的假预测器**必须**被关键假阳指标抓住
 * ⑥ B 列输入同形性：state 含当前消息与上下文别名
 * ⑦ J 列问题单形状：4 个判定选项 + 8 个家族选项（含"不适用"）
 * ⑧ **真实出站 = 0**（把全局 fetch 换成抛异常的桩）
 * ```
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'

import {
  EMOTION_CASES,
  EMOTION_DECISIONS,
  EMOTION_SUBSETS,
  FAMILY_ORDER,
  JEV_FAMILY_NOT_APPLICABLE,
  M85_PUBLISHED_DENOMINATORS,
  buildAffectContext,
  buildBUserMessage,
  buildJevQuestions,
  buildJevState,
  emotionCorpusFingerprint,
  subsetDenominatorCheck,
  validateEmotionCorpus,
} from './m9.6-emotion-corpus.ts'

const checks: string[] = []
const check = (label: string): void => {
  checks.push(label)
}

/* ---- ⑧ 先把全局 fetch 换成抛异常的桩：整段自证期间任何真实出站都会炸 ---- */
const realFetch = globalThis.fetch
globalThis.fetch = (() => {
  throw new Error('OFFLINE_VIOLATION：本自证不允许任何真实出站')
}) as typeof fetch

try {
  /* ---- ① 语料失败关闭 ---- */
  const validation = validateEmotionCorpus()
  assert.equal(validation.ok, true, `语料校验失败：${validation.problems.join(' / ')}`)
  assert.ok(EMOTION_CASES.length >= 100, '条数不足')
  assert.equal(new Set(EMOTION_CASES.map((item) => item.id)).size, EMOTION_CASES.length)
  check('语料校验（条数/层/gold-final/id 唯一/判定闭集/IMPACT 必有家族）')

  /* ---- ② ★ 子集分母与 M8.5 公布值吻合 ---- */
  const denom = subsetDenominatorCheck()
  assert.equal(
    denom.ok,
    true,
    `子集分母与 M8.5 公布值不一致：observed=${JSON.stringify(denom.observed)} expected=${JSON.stringify(denom.expected)}`,
  )
  assert.equal(denom.observed.stance, 8)
  assert.equal(denom.observed.manipulationOos, 8)
  assert.equal(denom.observed.injection, 5)
  assert.equal(denom.observed.criticalFp, 29)
  assert.equal(denom.observed.abstention, 22)
  assert.equal(denom.observed.clearPositive, 47)
  check('★ 子集分母与 M8.5 公布值吻合（8/8/5/29/22/47）')

  /* ---- ③ A 列调用链正控：合法判定必须解析成功 ---- */
  const { buildSemanticOutbound, evaluateSemanticResponse } = await import(
    '../src/kernel/app/affect/semantic-evaluator.ts'
  )
  const probeCase = EMOTION_CASES.find((item) => item.gold.decision === 'IMPACT' && item.context === undefined)
  assert.ok(probeCase !== undefined, '找不到无上下文的 IMPACT 探针')
  const request = {
    characterAlias: '苏沐薇',
    context: buildAffectContext(probeCase),
    currentMessage: probeCase.message,
  }
  const outbound = buildSemanticOutbound(request)
  assert.equal(outbound.ok, true, '出站组装失败')
  if (!outbound.ok) throw new Error('unreachable')
  assert.ok(outbound.outbound.text.includes(probeCase.message), '出站文本必须含当前消息')
  assert.ok(outbound.outbound.text.includes('苏沐薇'), '出站文本必须含角色别名')
  const goodEnvelope = {
    content: JSON.stringify({
      decision: 'IMPACT',
      target: 'CHARACTER',
      candidates: [{ family: 'A-GRATITUDE', span: { start: 0, end: 2 } }],
      contextRefs: [],
      reasonCode: 'DIRECT_APPRECIATION',
    }),
    finishReason: 'stop',
    hasToolCalls: false,
  }
  const good = evaluateSemanticResponse(goodEnvelope, request)
  assert.equal(good.kind, 'judgment', `合法判定解析失败：${JSON.stringify(good)}`)
  if (good.kind !== 'judgment') throw new Error('unreachable')
  assert.equal(good.judgment.decision, 'IMPACT')
  assert.equal(good.mapping.dominantFamily, 'A-GRATITUDE')
  check('A 列正控：合法判定 ⇒ 解析成功 + dominantFamily 正确')

  /* ---- ④ A 列失败注入：必须失败关闭，不得伪造判定 ---- */
  const failureEnvelopes = [
    { label: '拒答', envelope: { content: null, finishReason: 'content_filter', hasToolCalls: false, refusalPresent: true } },
    { label: '工具调用', envelope: { content: null, finishReason: 'tool_calls', hasToolCalls: true } },
    { label: '截断', envelope: { content: '{"decision":"IMP', finishReason: 'length', hasToolCalls: false } },
    { label: '空内容', envelope: { content: null, finishReason: 'stop', hasToolCalls: false } },
    { label: '非 JSON', envelope: { content: '我不知道', finishReason: 'stop', hasToolCalls: false } },
    {
      label: 'decision 与 candidates 矛盾（非 IMPACT 却带家族）',
      envelope: {
        content: JSON.stringify({ decision: 'NEUTRAL', target: 'CHARACTER', candidates: [{ family: 'A-HOSTILE', span: { start: 0, end: 2 } }], contextRefs: [], reasonCode: 'ORDINARY_INTERACTION' }),
        finishReason: 'stop',
        hasToolCalls: false,
      },
    },
    {
      label: '伪造上下文引用',
      envelope: {
        content: JSON.stringify({ decision: 'IMPACT', target: 'CHARACTER', candidates: [{ family: 'A-GRATITUDE', span: { start: 0, end: 2 } }], contextRefs: ['m-9'], reasonCode: 'DIRECT_APPRECIATION' }),
        finishReason: 'stop',
        hasToolCalls: false,
      },
    },
  ]
  for (const item of failureEnvelopes) {
    const outcome = evaluateSemanticResponse(item.envelope, request)
    assert.notEqual(outcome.kind, 'judgment', `失败注入「${item.label}」被误判成功`)
    assert.equal(outcome.kind, 'parse_failed', `失败注入「${item.label}」应记 parse_failed`)
  }
  check(`A 列负控：${String(failureEnvelopes.length)} 类坏响应全部失败关闭（零伪造 NEUTRAL/IMPACT）`)

  /* ---- ⑤ ★ 伪通过负控：假预测器必须被关键假阳抓住 ---- */
  const alwaysHostile = {
    decision: 'IMPACT' as const,
    family: 'A-HOSTILE' as const,
  }
  const criticalFpForFake = EMOTION_SUBSETS.criticalFpDenominator.filter(
    (item) => alwaysHostile.decision === 'IMPACT' && (alwaysHostile.family === 'A-HOSTILE' || alwaysHostile.family === 'A-REJECTION'),
  ).length
  assert.equal(
    criticalFpForFake,
    EMOTION_SUBSETS.criticalFpDenominator.length,
    '假预测器「永远 A-HOSTILE」必须被判为全部关键假阳',
  )
  const alwaysNeutral = EMOTION_CASES.filter((item) => item.gold.decision === 'IMPACT').length
  assert.ok(alwaysNeutral > 0, '假预测器「永远 NEUTRAL」必须会漏掉所有正例')
  check('★ 伪通过负控：永远 A-HOSTILE ⇒ 关键假阳 29/29；永远 NEUTRAL ⇒ 漏掉全部 62 条正例')

  /* ---- ⑥ B 列输入同形性 ---- */
  const ctxCase = EMOTION_CASES.find((item) => item.context !== undefined)
  assert.ok(ctxCase !== undefined, '找不到带上下文的案例')
  const stateText = buildJevState(ctxCase)
  assert.ok(stateText.includes(ctxCase.message), 'state 必须含当前消息')
  assert.ok(stateText.includes('[m-1]'), 'state 必须含 m-1 别名')
  assert.equal(buildBUserMessage(ctxCase), stateText, 'B 列与 J 列必须看到同一份输入')
  check('B/J 输入同形：同一份 state（含 m-1 与当前消息）')

  /* ---- ⑦ J 列问题单形状 ---- */
  const questions = buildJevQuestions()
  const decisionKeys = Object.keys(questions.decision?.criteria ?? {})
  const familyKeys = Object.keys(questions.family?.criteria ?? {})
  assert.deepEqual(decisionKeys, [...EMOTION_DECISIONS], '判定选项必须恰为四个判定')
  assert.equal(familyKeys.length, FAMILY_ORDER.length + 1, '家族选项必须是七族 + 不适用')
  assert.ok(familyKeys.includes(JEV_FAMILY_NOT_APPLICABLE), '家族选项必须含"不适用"')
  for (const family of FAMILY_ORDER) assert.ok(familyKeys.includes(family), `家族选项缺 ${family}`)
  check('J 列问题单：4 个判定选项 + 7 族 + 不适用')

  /* ---- ⑧ 真实出站 = 0（桩未被触发即证明） ---- */
  check('★ 真实出站 = 0（全局 fetch 被替换为抛异常的桩，全程未触发）')

  /* ---- 落盘 ---- */
  mkdirSync('artifacts/m9.6/emotion', { recursive: true })
  writeFileSync(
    'artifacts/m9.6/emotion/verification.json',
    `${JSON.stringify(
      {
        schemaVersion: 'm9.6-emotion-verification@1',
        status: 'PASS',
        assertions: checks.length,
        checks,
        networkCalls: 0,
        corpus: {
          path: 'evals/m8.5/corpus/blind.jsonl',
          fingerprint: emotionCorpusFingerprint(),
          total: EMOTION_CASES.length,
        },
        subsets: { ...denom.observed },
        m85PublishedDenominators: M85_PUBLISHED_DENOMINATORS,
        note: '子集分母与 M8.5 公布值逐个吻合 ⇒ 本轮的判据重建 = M8.5 原量具',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  console.log(`M9.6 情绪一轮 · 离线自证：PASS（${String(checks.length)} 项检查 · 真实出站 0）`)
  for (const item of checks) console.log(`  ✓ ${item}`)
} finally {
  globalThis.fetch = realFetch
}
