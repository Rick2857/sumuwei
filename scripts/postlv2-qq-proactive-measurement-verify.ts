/**
 * post-Lv2 / ADR-110：**量具有效性**（WP6）—— 关心的"够不够格"这一套判据。
 *
 * ============================================================================
 *  三段式（本仓库的纪律：只有正控 + 负控**不够**）
 * ============================================================================
 * ```text
 * ① 正控      ：一个**够格**的输入 ⇒ 必须 `eligible: true`
 * ② 负控      ：九种"不该发"的情形 ⇒ 每一种都必须 `eligible: false`
 * ③ **差分正控**：②里的每一种，都是拿①那**同一个**输入**只改一个字段**得到的
 *                ⇒ 判据必须**恰好**因为那一个字段翻红（否则它可能只是"永远说不"）
 * ```
 * ⚠️ ②③ 是**同一批输入**的两面：没有 ③，②就可能被一个"无论如何都拒"的实现蒙过；
 *    没有 ②，③ 就没有可翻的那一面。所以它们成对出现，**不许**拆开跑。
 * ⚠️ 另有一条**恢复档**：把改掉的那个字段改回来 ⇒ 必须**重新**变成够格
 *    （证明判据是"看当前状态"，不是"粘住"）。
 *
 * ⚠️ 它**不需要数据库、不需要模型、不出站**：判据是纯函数，量具就该是纯的。
 */
import {
  precheckCareOpportunity,
  type CarePrecheckInput,
} from '../src/kernel/contracts/notification-intake.ts'
import { DEFAULT_PROACTIVE_POLICY } from '../src/kernel/contracts/notification.ts'
import {
  boundProactiveSources,
  parseProactiveProposal,
  verifyProactiveSources,
} from '../src/kernel/contracts/proactive-proposal.ts'

let failures = 0
let measured = 0
function check(label: string, ok: boolean, detail = ''): void {
  measured += 1
  if (ok) {
    console.log(`  ✅ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
    return
  }
  failures += 1
  console.error(`  ❌ ${label}${detail === '' ? '' : ` —— ${detail}`}`)
}

/* ---- ① 正控的基线：2026-10-07 21:40（Asia/Shanghai 活动时段内）· 从未有过入站 ---------- */
const insideWindow = Date.parse('2026-10-07T21:40:00+08:00')
const baseline: CarePrecheckInput = {
  mode: 'on',
  paused: false,
  entryScopedConversations: true,
  now: insideWindow,
  lastInboundAt: undefined,
  lastCareAt: undefined,
  newInboundSinceLastCare: true,
  careUsedToday: 0,
  allUsedToday: 0,
  candidateInFlight: false,
  permissionVersion: 'care-permission@1',
}

console.log('=== ① 正控 ===')
const base = precheckCareOpportunity(baseline)
check(
  '够格的输入 ⇒ `eligible: true`，且给出机会键 / 空转档 / 空闲时长',
  base.eligible === true && base.opportunityKey !== '' && base.idleMs >= 0,
  base.eligible ? `key=${base.opportunityKey} dryRun=${String(base.dryRun)}` : `拒：${base.code}`
)

/*
 * ---- ② + ③ 负控与差分正控：**只改一个字段** ----------------------------------
 * ⚠️ 每一条都写成 `{...baseline, <一个字段>}`：**这就是"只改一个"的证明**，
 *    不是靠注释声明。任何一条若不小心改了第二个字段，读代码就能看出来。
 */
console.log('=== ② 负控 + ③ 差分正控（每一条只改一个字段） ===')
const mutations: readonly (readonly [string, Partial<CarePrecheckInput>])[] = [
  ['模式切成 off', { mode: 'off' }],
  ['被暂停', { paused: true }],
  ['入口作用域关着', { entryScopedConversations: false }],
  ['已有一个候选在途', { candidateInFlight: true }],
  ['不在活动时段（凌晨 3 点）', { now: Date.parse('2026-10-07T03:00:00+08:00') }],
  ['不够空闲（刚有人说过话）', { lastInboundAt: insideWindow - 60_000 }],
  ['还在冷却里（上次关心很近）', { lastCareAt: insideWindow - 60_000 }],
  ['上次关心之后**没有**新入站', { lastCareAt: insideWindow - 4 * 3600_000, newInboundSinceLastCare: false }],
  ['关心日额度用完', { careUsedToday: DEFAULT_PROACTIVE_POLICY.maxCarePerDay }],
  ['全类日额度用完', { allUsedToday: DEFAULT_PROACTIVE_POLICY.maxProactiveMessagesPerDay }],
]
const codes: string[] = []
for (const [what, patch] of mutations) {
  const result = precheckCareOpportunity({ ...baseline, ...patch })
  const code = result.eligible ? '(够格)' : result.code
  codes.push(code)
  check(`③ 差分：只改「${what}」⇒ 恰好翻红`, result.eligible === false, `code=${code}`)
}

console.log('=== 判据是**逐维命名**的，不是一句通用的"不许" ===')
const distinct = new Set(codes)
check(
  '③ 十条拒绝给出**互不相同**的具名码（否则"十种情形"只是同一个"不"）',
  distinct.size === mutations.length,
  `${String(distinct.size)} 个不同的码 / ${String(mutations.length)} 条`
)
check(
  '② 且**没有一个**码是空的（每个拒绝都得说清是哪一条）',
  codes.every((code) => code !== '' && code !== '(够格)'),
  codes.join(' · ')
)

/* ---- 恢复档：把字段改回来 ⇒ 必须重新够格 ---- */
console.log('=== 恢复档 ===')
const restored = precheckCareOpportunity({ ...baseline, mode: 'off', paused: true })
const restoredBack = precheckCareOpportunity({ ...baseline, mode: 'on', paused: false })
check(
  '恢复：把「模式 / 暂停」改回来 ⇒ **重新**够格（判据看当前状态，不粘住）',
  restored.eligible === false && restoredBack.eligible === true,
  `改坏=${restored.eligible ? '够格' : '拒'} · 改回=${restoredBack.eligible ? '够格' : '拒'}`
)

/* ---- 量具自证：这次真的量了东西 ---- */
console.log('=== 量具自证 ===')
check(
  '★ `measured_count > 0`（本批的硬要求：不许"零断言全绿"）',
  measured > 0,
  `measured_count=${String(measured)}`
)

/*
 * ===========================================================================
 *  第二组：**依据面**（§29–§30）也走同一套"只改一处"的纪律
 * ===========================================================================
 * ⚠️ 第一组量的是"够不够格"。这一组量的是"依据面"那三件纯函数 ——
 *    它们此前只有**分散的结构判据**（§29/§30），没有统一的差分形式。
 */

/* ---- 依据集有界化：基线 3 条好条目，每条只改一处 ---- */
console.log('=== 依据集有界化：基线 + 只改一处 ===')
const goodSources = [
  { ref: 'fact:a', label: '甲' },
  { ref: 'fact:b', label: '乙' },
  { ref: 'fact:c', label: '丙' },
]
const boundedBase = boundProactiveSources(goodSources)
check(
  '① 正控：3 条好条目 ⇒ 3 条（顺序不变）',
  boundedBase.length === 3 && boundedBase[0]!.ref === 'fact:a' && boundedBase[2]!.ref === 'fact:c',
  boundedBase.map((row) => row.ref).join(',')
)
const boundCases: readonly (readonly [string, readonly { ref: string; label: string }[], (out: readonly { ref: string; summary: string }[]) => boolean])[] = [
  ['只把一条的 ref 改成空', [...goodSources.slice(0, 1), { ref: '  ', label: '乙' }, goodSources[2]!], (out) => out.length === 2],
  ['只把一条的 label 改成空', [{ ref: 'fact:a', label: '甲' }, { ref: 'fact:b', label: '   ' }, goodSources[2]!], (out) => out.length === 2],
  ['只多加一条**同 ref** 的', [...goodSources, { ref: 'fact:a', label: '甲的复述' }], (out) => out.length === 3],
  ['只把 label 拉长到 200 码点', [{ ref: 'fact:a', label: '字'.repeat(200) }, ...goodSources.slice(1)], (out) => [...out[0]!.summary].length === 120],
  ['只把条数加到 9 条', [...goodSources, { ref: 'd', label: '丁' }, { ref: 'e', label: '戊' }, { ref: 'f', label: '己' }, { ref: 'g', label: '庚' }, { ref: 'h', label: '辛' }, { ref: 'i', label: '壬' }], (out) => out.length === 8],
]
for (const [what, input, want] of boundCases) {
  const out = boundProactiveSources(input)
  check(`③ 差分：${what} ⇒ 结果按那一条变`, want(out), `${String(out.length)} 条`)
}
check(
  '② 负控：**空输入 ⇒ 空集合**（不是"退回全部"、也不是"给个默认依据"）',
  boundProactiveSources([]).length === 0,
  '0'
)

/* ---- 来源复核：基线合法，每条只改一处 ---- */
console.log('=== 来源复核：基线 + 只改一处 ===')
const available = new Set(['fact:a', 'fact:b'])
const verifyBase = verifyProactiveSources({ sourceRefs: ['fact:a', 'fact:b'], available })
check('① 正控：引用**全部**在闭集里 ⇒ 通过', verifyBase.ok === true, verifyBase.ok ? 'ok' : verifyBase.code)
const verifyCases: readonly (readonly [string, { sourceRefs: string[]; available: Set<string> }, string])[] = [
  ['只把一条引用换成闭集外的', { sourceRefs: ['fact:a', 'fact:zzz'], available }, 'proactive_source_stale'],
  ['只把可用集换成空', { sourceRefs: ['fact:a'], available: new Set<string>() }, 'proactive_source_set_unavailable'],
  ['只把引用清空', { sourceRefs: [], available }, 'proactive_without_source'],
]
for (const [what, input, wantCode] of verifyCases) {
  const out = verifyProactiveSources(input)
  check(
    `③ 差分：${what} ⇒ 恰好翻红，且码是 \`${wantCode}\``,
    out.ok === false && out.code === wantCode,
    out.ok ? '(过了)' : out.code
  )
}

/* ---- 严格解析：基线合法，每条只改一处 ---- */
console.log('=== 严格解析：基线 + 只改一处 ===')
const validProposal = {
  decision: 'send',
  reasonCode: 'care_check_in',
  sourceRefs: ['fact:a'],
  text: '在的',
}
const parseBase = parseProactiveProposal(validProposal)
check('① 正控：合法提案 ⇒ 通过', parseBase.ok === true, parseBase.ok ? 'ok' : parseBase.code)
const parseCases: readonly (readonly [string, Record<string, unknown>])[] = [
  ['只多出**一个**字段', { ...validProposal, extra: 1 }],
  ['只把 decision 换成闭集外的词', { ...validProposal, decision: 'shout' }],
  ['只把 text 删掉（send 却没有正文）', { decision: 'send', reasonCode: 'r', sourceRefs: ['fact:a'] }],
  /*
   * ⚠️ **这里不测"sourceRefs 清空"** —— 第一版测了，结果是**过了**，而我当时的判断是"该拒"。
   *    查下来是**我测错了层**：空引用由 `verifyProactiveSources` 拒（`proactive_without_source`，
   *    上面那一组已经量过），**不是**解析器的活。
   * ⇒ 这个错误的期望值本身是一条**真读数**：两道闸各管各的，解析器不会替复核层下结论。
   *    所以这里换成"只缺 reasonCode"这个**解析层**的缺失字段。
   */
  ['只把 reasonCode 删掉', { decision: 'send', sourceRefs: ['fact:a'], text: '在的' }],
]
const parseCodes: string[] = []
for (const [what, input] of parseCases) {
  const out = parseProactiveProposal(input)
  const code = out.ok ? '(过了)' : out.code
  parseCodes.push(code)
  check(`③ 差分：${what} ⇒ 恰好作废`, out.ok === false, `code=${code}`)
}
check(
  '③ 四条作废里**至少三种不同的具名码**（否则"多一个字段整条作废"和其它作废就分不出来了）',
  new Set(parseCodes.filter((code) => code !== '(过了)')).size >= 3,
  parseCodes.join(' · ')
)

console.log(
  '\n' +
    '='.repeat(72) +
    `\nQQ 主动联系 · 量具有效性（三段式）：${String(measured - failures)} 通过 / ${String(failures)} 失败（measured_count=${String(measured)}）\n` +
    '='.repeat(72)
)
if (failures > 0) process.exitCode = 1
