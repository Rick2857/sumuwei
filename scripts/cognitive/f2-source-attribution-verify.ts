/*
 * F2 写来源归属门（纯函数 · **零模型请求 · 零数据库**）。
 *
 * 覆盖用户核对列出的全部情形：
 *  ① 同时读过缓存与权威源 ⇒ 按**内容**归属（读了两个源不改变归属依据）
 *  ② 两个源内容相同 ⇒ 归属**不明**（内容无法区分来源）
 *  ③ 读失败 / 没有读 / 跨任务旧读 ⇒ 归属**不明**
 *  ④ 读后源内容变化 ⇒ 归属**不明**
 *  ⑤ 尚未执行的候选（无真实读回执）⇒ 归属**不明**
 *  ⑥ 归属不明**绝不**被当成"可靠来源"
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  attributeWriteSource,
  type WriteSourceDeclaration,
  type WriteSourceReadReceipt,
} from '../../src/kernel/contracts/write-source-attribution.ts'

const OUT_DIR = resolve('artifacts/local/f2-source-attribution')
const CACHE = 'f1/a/obj-01.cache'
const SOURCE = 'f1/a/obj-01.src'

const declarations: WriteSourceDeclaration[] = [
  { kind: 'cache', path: CACHE },
  { kind: 'authoritative', path: SOURCE },
]

const receipt = (path: string, contentFingerprint: string, taskId = 'w1-obj-01'): WriteSourceReadReceipt =>
  ({ path, contentFingerprint, taskId, ok: true })

const checks: Array<{ label: string, pass: boolean, detail: string }> = []
const check = (label: string, pass: boolean, detail = ''): void => {
  checks.push({ label, pass, detail })
  assert.ok(pass, `${label}${detail === '' ? '' : ` — ${detail}`}`)
}

// ① 只读缓存 ⇒ 归属 cache
const onlyCache = attributeWriteSource({
  declarations, receipts: [receipt(CACHE, 'fp-cache')], candidate: { contentFingerprint: 'fp-cache', taskId: 'w1-obj-01' },
})
check('① 只读过缓存 ⇒ 归属 cache（按内容追溯）',
  onlyCache.attribution === 'cache' && onlyCache.reason === 'traced_to_cache_read')

// ①b **同时读过两个源**（内容不同）⇒ 仍按内容归属到被写的那一路
const bothRead = attributeWriteSource({
  declarations,
  receipts: [receipt(CACHE, 'fp-cache'), receipt(SOURCE, 'fp-auth')],
  candidate: { contentFingerprint: 'fp-cache', taskId: 'w1-obj-01' },
})
check('①b 同时读过缓存与权威源，写的是缓存内容 ⇒ 归属仍是 cache（读了两个源不改变依据）',
  bothRead.attribution === 'cache' && bothRead.reason === 'traced_to_cache_read')
const bothReadAuth = attributeWriteSource({
  declarations,
  receipts: [receipt(CACHE, 'fp-cache'), receipt(SOURCE, 'fp-auth')],
  candidate: { contentFingerprint: 'fp-auth', taskId: 'w1-obj-01' },
})
check('①c 同时读过两个源，写的是权威内容 ⇒ 归属 authoritative',
  bothReadAuth.attribution === 'authoritative' && bothReadAuth.reason === 'traced_to_authoritative_read')

// ② 两个源内容相同 ⇒ 归属不明
const identical = attributeWriteSource({
  declarations,
  receipts: [receipt(CACHE, 'fp-same'), receipt(SOURCE, 'fp-same')],
  candidate: { contentFingerprint: 'fp-same', taskId: 'w1-obj-01' },
})
check('② 两个源内容相同 ⇒ 归属**不明**（内容无法区分来源）',
  identical.attribution === 'unknown' && identical.reason === 'sources_have_identical_content')

// ③a 没有读 ⇒ 不明
const noRead = attributeWriteSource({
  declarations, receipts: [], candidate: { contentFingerprint: 'fp-cache', taskId: 'w1-obj-01' },
})
check('③a 没有读回执 ⇒ 归属**不明**', noRead.attribution === 'unknown' && noRead.reason === 'no_read_receipt')

// ③b 跨任务的旧读 ⇒ 不明（不能用上一题的读）
const staleRead = attributeWriteSource({
  declarations, receipts: [receipt(CACHE, 'fp-cache', 'w1-obj-00')], candidate: { contentFingerprint: 'fp-cache', taskId: 'w1-obj-01' },
})
check('③b 跨任务的旧读 ⇒ 归属**不明**（任务范围外不算）',
  staleRead.attribution === 'unknown' && staleRead.reason === 'read_out_of_task_scope')

// ④ 读后源内容变了 ⇒ 不明
const changed = attributeWriteSource({
  declarations,
  receipts: [receipt(CACHE, 'fp-cache')],
  candidate: { contentFingerprint: 'fp-cache', taskId: 'w1-obj-01' },
  currentSourceFingerprints: { [CACHE]: 'fp-cache-v2' },
})
check('④ 读后源内容变化 ⇒ 归属**不明**（回执指向的不是现在的源）',
  changed.attribution === 'unknown' && changed.reason === 'source_changed_after_read')

// ⑤ 尚未执行的候选：没有真实读回执 ⇒ 不明（哪怕它"声称"读了缓存）
const notExecuted = attributeWriteSource({
  declarations, receipts: [receipt(CACHE, 'fp-cache')], candidate: { contentFingerprint: 'fp-other', taskId: 'w1-obj-01' },
})
check('⑤ 候选内容与任何读回执都不匹配（未执行/未追溯）⇒ 归属**不明**',
  notExecuted.attribution === 'unknown' && notExecuted.reason === 'content_not_traced_to_any_read')

// ⑥ 归属不明**绝不**被当成可靠来源
const unknownCases = [identical, noRead, staleRead, changed, notExecuted]
const unknownCount = unknownCases.filter(result => result.attribution === 'unknown').length
const unknownAsAuthoritative = unknownCases.filter(result => result.attribution === 'authoritative').length
check('⑥ 全部"不明"情形都没有被判成 authoritative（不猜成可靠来源）',
  unknownCount === 5 && unknownAsAuthoritative === 0,
  `unknown=${String(unknownCount)} 误判=${String(unknownAsAuthoritative)}`)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(resolve(OUT_DIR, 'verification.json'), `${JSON.stringify({
  schema: 'f2-source-attribution-gate@1',
  status: 'PASS',
  checks,
  boundaries: [
    '本门是**纯函数**门（零模型请求、零数据库、零文件系统）',
    '它只证明**归属判定**的语义；**不**证明真实读面/守卫/否决链已经接上（那是本批的下一段）',
  ],
}, null, 2)}\n`, 'utf8')
console.log(`F2 写来源归属门：${String(checks.length)} 项检查全部通过（零模型请求）`)
for (const item of checks) console.log(`PASS ${item.label}${item.detail === '' ? '' : ` — ${item.detail}`}`)
