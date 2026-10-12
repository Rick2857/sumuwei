/**
 * M6.1 WP5 / B① —— **更新轮抽取缺口的离线复现**（`pnpm m6.1:update-turn:repro`）。
 *
 * ============================================================================
 *  它复现什么（用户 2026-09-25 裁定 B①：先离线复现，再改）
 * ============================================================================
 * ```text
 * 冻结条文（evals/m6.1/control/supported-recall-positive-v1.jsonl）里的两条**更正轮**：
 *   SRP-C-04  education.major   「更正一下，我转到历史学了。」   ⇒ 槽位抽不出来（value = null）
 *   SRP-C-09  device.primary    「更正一下，我换成 Mac 了。」     ⇒ 槽位抽不出来
 * 后果（四轮实测，逐条相同）：这两条在"依据建立失败"组里**四轮全中**，
 * 于是她那一轮**根本没有新值可用** —— 这是**确定性管道缺陷**，不是抖动。
 * ```
 *
 * ============================================================================
 *  判据结构（三段式 + 一条**方向相反**的负控）
 * ============================================================================
 * ```text
 * 正控①  同一条更正、换用**已有线索词**的说法 ⇒ **必须**抽得出
 *          「更正一下，我的专业是历史学。」→ education.major = 历史学
 *          「更正一下，我平时用的是 Mac。」→ device.primary = Mac
 *        ⇒ 证明"路径本身没坏"，缺的**就是**「转到/换成」这两个词形
 * 复现    上面那两句冻结原文 ⇒ 期望**今天抽不出**（这就是被复现的缺陷）
 * ★ 负控（方向相反，也是最要紧的一条）：
 *        「更正一下，我换成 Mac 了。」**只给抽取器**（没有上下文、没有目标槽位）⇒ **必须仍然抽不出**
 *        ⇒ 这条机器守着用户的裁定："**不得**把「换成」「转到」无条件变成全局记忆指令"。
 *        修法若让抽取器直接认这两个词，这条负控立刻变红。
 * 其它负控  非更正语境里的「换成/转到」⇒ 必须抽不出：
 *          「我把闹钟换成七点了。」「我把这首歌换成另一首了。」「课本第 3 章我转到第 5 章了。」
 * 恢复    同一组用例再跑一遍 ⇒ 与正控逐字段相同
 * ```
 *
 * ⚠️ 它**不打开数据库、不调模型**；只调用生产**规则**抽取器（`createRuleOnlyContentExtractor`）。
 * 退出码：`0` = 自证通过（读数写在 verdict 字段里）· `3` = **自证失败**（读数不可用）。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { createRuleOnlyContentExtractor } from '../src/kernel/app/memory/content-extractor.ts'
import { entityRef } from '../src/kernel/contracts/entity.ts'

const ROOT = resolve(process.cwd())
const extractor = createRuleOnlyContentExtractor()
const USER = entityRef('user', 'b1-update-turn-repro')

interface Case {
  readonly id: string
  readonly text: string
  readonly origin: string
  /** `extractable` = 期望抽得出（并给期望槽位/取值）；`missing` = 期望今天抽不出（被复现的缺陷）；`must_not` = 负控，必须抽不出 */
  readonly expect: 'extractable' | 'missing' | 'must_not'
  readonly predicate?: string
  readonly value?: string
}

/** ⚠️ 逐字来自冻结条文 / 或由它们派生；**不要**顺手加"想当然"的句子 */
const CASES: readonly Case[] = [
  /* ---- 正控：路径没坏（换用已有线索词）---- */
  {
    id: 'ctl-major-cue',
    text: '更正一下，我的专业是历史学。',
    origin: '用已有线索词「专业」写同一条更正（对照）',
    expect: 'extractable',
    predicate: 'education.major',
    value: '历史学',
  },
  {
    id: 'ctl-device-cue',
    text: '更正一下，我平时用的是 Mac。',
    origin: '用已有线索词「用的是」写同一条更正（对照）',
    expect: 'extractable',
    predicate: 'device.primary',
    value: 'Mac',
  },
  /* ---- 复现：冻结原文的两条更正轮 ---- */
  {
    id: 'miss-major',
    text: '更正一下，我转到历史学了。',
    origin: 'SRP-C-04 的第 2 轮（冻结原文）',
    expect: 'missing',
  },
  {
    id: 'miss-device',
    text: '更正一下，我换成 Mac 了。',
    origin: 'SRP-C-09 的第 2 轮（冻结原文）',
    expect: 'missing',
  },
  /* ---- ★ 负控：只给抽取器时，「换成」不得成为全局线索 ---- */
  {
    id: 'neg-lexeme-alone',
    text: '更正一下，我换成 Mac 了。',
    origin: '★ 同一句，但**只给抽取器**（无上下文/无目标槽位）⇒ 必须仍抽不出',
    expect: 'must_not',
  },
  /* ---- 其它负控：非更正语境 ---- */
  { id: 'neg-alarm', text: '我把闹钟换成七点了。', origin: '非更正语境（换的是闹钟）', expect: 'must_not' },
  { id: 'neg-song', text: '我把这首歌换成另一首了。', origin: '非更正语境（换的是歌）', expect: 'must_not' },
  { id: 'neg-chapter', text: '课本第 3 章我转到第 5 章了。', origin: '非更正语境（转的是章节）', expect: 'must_not' },
]

interface Reading {
  readonly id: string
  readonly text: string
  readonly origin: string
  readonly expect: Case['expect']
  readonly actualPredicate: string | null
  readonly actualValue: string | null
  readonly ok: boolean
}

async function run(): Promise<Reading[]> {
  const out: Reading[] = []
  for (const testCase of CASES) {
    const result = await extractor.extract({ text: testCase.text, owner: USER, speaker: USER })
    const predicate = result?.predicate ?? null
    const value = result === undefined ? null : String((result.content as { value?: unknown }).value ?? '')
    const ok =
      testCase.expect === 'extractable'
        ? predicate === testCase.predicate && value === testCase.value
        : predicate === null
    out.push({
      id: testCase.id,
      text: testCase.text,
      origin: testCase.origin,
      expect: testCase.expect,
      actualPredicate: predicate,
      actualValue: value,
      ok,
    })
  }
  return out
}

const first = await run()
const replay = await run()
const restoreOk = JSON.stringify(first) === JSON.stringify(replay)

const failures: string[] = []
if (CASES.length < 6) failures.push('计数自检：用例少于 6 条 ⇒ 覆盖不足')
const controls = first.filter((row) => row.expect === 'extractable')
if (controls.length === 0) failures.push('计数自检：正控 0 条')
if (!controls.every((row) => row.ok)) failures.push('正控未成立：换用已有线索词的更正**必须**抽得出（否则缺的不是词形）')
const negatives = first.filter((row) => row.expect === 'must_not')
if (negatives.length === 0) failures.push('计数自检：负控 0 条')
if (!negatives.every((row) => row.ok)) {
  failures.push(
    '★ 负控被打破：「换成/转到」在**只给抽取器**或非更正语境时也抽出东西了 ⇒ ' +
      '那就等于把它们变成了全局记忆指令（用户明令禁止）'
  )
}
if (!restoreOk) failures.push('恢复失败：同一组用例两次读数不同')

const missingToday = first.filter((row) => row.expect === 'missing')
const reproduced = missingToday.filter((row) => row.ok).length

console.log('='.repeat(96))
console.log('M6.1 WP5 / B① · 更新轮抽取缺口 离线复现（零模型调用 · 不打开数据库）')
console.log('='.repeat(96))
for (const row of first) {
  const mark = row.expect === 'extractable' ? '正控' : row.expect === 'missing' ? '复现' : '负控'
  console.log(
    `  [${mark}] ${row.id.padEnd(16)} ${row.text}`
  )
  console.log(
    `         期望 ${row.expect === 'extractable' ? '抽得出' : row.expect === 'missing' ? '今天**抽不出**' : '**必须抽不出**'}` +
      ` · 实际 ${row.actualPredicate === null ? '抽不出' : `${row.actualPredicate} = ${String(row.actualValue)}`} · ${row.ok ? 'OK' : '**不符**'}`
  )
}
console.log('')
console.log(
  `  正控 ${controls.filter((r) => r.ok).length}/${controls.length} · ` +
    `复现 ${reproduced}/${missingToday.length}（冻结原文两条今天是否抽不出）· ` +
    `负控 ${negatives.filter((r) => r.ok).length}/${negatives.length} · 恢复 ${restoreOk ? 'PASS' : '**FAIL**'}`
)
console.log(
  `  结论 verdict = ${
    failures.length > 0 ? 'SELF_PROOF_FAILED' : reproduced === missingToday.length && missingToday.length > 0 ? 'MISS_REPRODUCED' : 'NO_LONGER_MISSING'
  }`
)

const evidence = {
  schemaVersion: 'm6.1-update-turn-repro@1',
  testId: 'M6.1 WP5 / B① 更新轮抽取缺口离线复现',
  what: '把冻结条文的两条更正轮（SRP-C-04 / SRP-C-09）喂给生产规则抽取器，并带正控与"方向相反"的负控。',
  why:
    '用户裁定 B①：先离线复现再改；且**不得**把「换成」「转到」无条件变成全局记忆指令 —— ' +
    '因此有一条负控专门守"只给抽取器时必须仍抽不出"。',
  verdict:
    failures.length > 0
      ? 'SELF_PROOF_FAILED'
      : reproduced === missingToday.length && missingToday.length > 0
        ? 'MISS_REPRODUCED'
        : 'NO_LONGER_MISSING',
  cases: first,
  selfProof: {
    positiveControls: controls.map((row) => ({ id: row.id, ok: row.ok })),
    negatives: negatives.map((row) => ({ id: row.id, ok: row.ok })),
    restore: restoreOk,
    countCheck: { cases: CASES.length, controls: controls.length, negatives: negatives.length },
  },
  failures,
  notProven: [
    '它只测**规则抽取器**这一层；"更正轮最终有没有落库"由服务层与 M4 门负责。',
    '它**不**证明修好之后端到端就好了：还要跑 `m4:nl-mutation:verify`（12 条误触发负控）与短场景小样。',
    '负控集里原本**没有**「换成/转到」用例（已核实）⇒ 修复必须自带这一组负控，不能指望既有 12 条覆盖。',
  ],
}
mkdirSync(join(ROOT, 'artifacts', 'm6.1'), { recursive: true })
writeFileSync(join(ROOT, 'artifacts', 'm6.1', 'update-turn-repro.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
console.log('  证据：artifacts/m6.1/update-turn-repro.json')

if (failures.length > 0) {
  console.error('\n  ⚠️ 自证失败 ⇒ 读数不可用：')
  for (const message of failures) console.error(`     · ${message}`)
  process.exitCode = 3
} else {
  process.exitCode = 0
}
