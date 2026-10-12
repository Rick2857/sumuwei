/**
 * ⚠️ 本文件是**工具**（**不是门**）：给"重判清单"用 —— 对比两份审阅档，列出**变了哪几张**。
 *    它没有 npm 脚本（`gates:verify` 的 G3 只管 `package.json` 里的 `m10:*` 脚本）
 *    ⇒ 它**不占门位**，与 `m10-gauge-audit.ts` 同一处置。
 *
 * 重生成卡片之后，算出**与用户已填那一版相比变了什么** ——
 * 好让他**只重判变动的那几张**，不必重判已经一致的 52 条。
 *
 * 对比口径：caseId 集合（新增 / 消失）+ 同 caseId 的 (上文, 原话, 金标) 是否变了。
 * ⚠️ 归一化：旧版卡面曾多一个"上文："前缀（后来的去重修饰）—— 那是**排版**，不是内容；
 *    第一版没归一化，于是把 68 张全报成"变了"（**量错了东西**）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'artifacts/m10'
const dirs = readdirSync(ROOT)
  .filter((n) => n.startsWith('m10-wp10-review-'))
  .map((n) => ({ n, t: statSync(join(ROOT, n)).mtimeMs }))
  .sort((a, b) => b.t - a.t)
const [newest, previous] = dirs
if (newest === undefined || previous === undefined) throw new Error('需要至少两份审阅档')

interface Card {
  context: string
  utterance: string
  gold: string
}
function load(dir: { n: string }): Map<string, Card> {
  const md = readFileSync(join(ROOT, dir.n, 'blind-cards.md'), 'utf8')
  const sheet = JSON.parse(readFileSync(join(ROOT, dir.n, 'answer-sheet.json'), 'utf8')) as {
    entries: { caseId: string; gold: string }[]
  }
  const goldByCase = new Map(sheet.entries.map((e) => [e.caseId, e.gold]))
  const blocks = md.split(/^### \d+\. `([^`]+)`/m)
  const out = new Map<string, Card>()
  for (let i = 1; i + 1 < blocks.length; i += 2) {
    const body = blocks[i + 1]!
    out.set(blocks[i]!, {
      context: /上文（系统当时知道什么）\*\*：(.+)/.exec(body)?.[1]?.trim() ?? '',
      utterance: /用户原话：「(.+?)」/.exec(body)?.[1]?.trim() ?? '',
      gold: goldByCase.get(blocks[i]!) ?? '?',
    })
  }
  return out
}

const after = load(newest)
const before = load(previous)
/** ⚠️ 归一化：旧版卡面曾多一个"上文："前缀（后来的去重修饰）—— 那是**排版**，不是内容 */
const norm = (text: string): string => text.replace(/^上文：/, '').trim()
for (const card of after.values()) card.context = norm(card.context)
for (const card of before.values()) card.context = norm(card.context)
console.log(`新档：${newest.n}（${String(after.size)} 张）`)
console.log(`旧档：${previous.n}（${String(before.size)} 张 · 用户已填的那一版）\n`)

const added = [...after.keys()].filter((id) => !before.has(id)).sort()
const removed = [...before.keys()].filter((id) => !after.has(id)).sort()
const changed = [...after.keys()]
  .filter((id) => before.has(id))
  .filter((id) => {
    const a = after.get(id)!
    const b = before.get(id)!
    return a.context !== b.context || a.utterance !== b.utterance || a.gold !== b.gold
  })
  .sort()
const untouched = [...after.keys()].filter(
  (id) => before.has(id) && !changed.includes(id),
)

console.log(`新增 ${String(added.length)} 张：${added.join(', ') || '（无）'}`)
console.log(`消失 ${String(removed.length)} 张：${removed.join(', ') || '（无）'}`)
console.log(`\n**内容变了的 ${String(changed.length)} 张**（要重判）：`)
for (const id of changed) {
  const a = after.get(id)!
  const b = before.get(id)!
  console.log(`  ${id}  金标 ${b.gold} → ${a.gold}`)
  if (b.context !== a.context) console.log(`      上文 旧：${b.context}\n      上文 新：${a.context}`)
  if (b.utterance !== a.utterance) console.log(`      原话 旧：「${b.utterance}」→ 新：「${a.utterance}」`)
}
console.log(`\n**未变** ${String(untouched.length)} 张（已一致的 52 条都在这里面，不用重判）`)
