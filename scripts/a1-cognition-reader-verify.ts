/**
 * A1 / **WP2 reader 门（第三面 · 选择半）**：`cognition` 的三类投影选择 + 水位整理。
 *
 * ```text
 * 正控：affect 精确命中 · relationships 前缀命中 · beliefs 前缀命中 · 水位按键排序且只留整数
 * 负控：⚠️ **`belief:origin` 必须被排除**（朴素前缀过滤会多报一条）·
 *       affect **不许**用前缀命中（`affect:character:extra` 之类不算）· 缺行 ⇒ null/空数组（不是编造）·
 *       非整数 revision ⇒ 丢弃（不塞进水位）
 * 恢复：把被排除的 `belief:origin` 改回 `belief:<id>` ⇒ 又能被选中
 * 结构：**代码**里不 import 任何认知引擎/折叠模块（"不重算"）
 * ⚠️ 本门**不碰数据库**：真 `db` 注入（`listProjections`/`projectionRevisions`/`getProjection`）是下一步。
 * ```
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COGNITION_AFFECT_TYPE,
  COGNITION_BELIEF_ORIGIN_TYPE,
  cognitionCellsFromProjections,
  selectAffect,
  selectBeliefs,
  selectRelationships,
  selectWatermarks,
} from '../src/infrastructure/admin-readers/cognition.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const READER = 'src/infrastructure/admin-readers/cognition.ts'

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

const rows = [
  { projectionType: COGNITION_AFFECT_TYPE, state: { mood: 'calm' } },
  { projectionType: 'relationship:user-a', state: { trust: 0.5 } },
  { projectionType: 'relationship:user-b', state: { trust: 0.2 } },
  { projectionType: 'belief:b1', state: { key: 'education.institution' } },
  { projectionType: COGNITION_BELIEF_ORIGIN_TYPE, state: { origin: 'cutover' } },
  { projectionType: 'goal:g1', state: { status: 'active' } },
]

// ---------------------------------------------------------------------------
// 1. 选择（正控 / 负控 / 恢复）
// ---------------------------------------------------------------------------

check('正控 affect 精确命中单行投影', JSON.stringify(selectAffect(rows)) === JSON.stringify({ mood: 'calm' }), JSON.stringify(selectAffect(rows)))
check('负控 affect **不用**前缀匹配（`affect:character:extra` 不算）',
  selectAffect([{ projectionType: `${COGNITION_AFFECT_TYPE}:extra`, state: { mood: 'x' } }]) === undefined, '应 undefined')
check('负控 affect 缺席 ⇒ undefined（不是编造的对象）', selectAffect([{ projectionType: 'goal:g', state: {} }]) === undefined, '应 undefined')

check('正控 relationships 前缀命中 2 条（且不含 goal/belief）', selectRelationships(rows).length === 2, String(selectRelationships(rows).length))
check('正控 beliefs 前缀命中 1 条', selectBeliefs(rows).length === 1, String(selectBeliefs(rows).length))
check('⚠️ 负控 **`belief:origin` 被排除**（朴素前缀过滤会多报一条）',
  selectBeliefs(rows).length === 1 && !JSON.stringify(selectBeliefs(rows)).includes('cutover'),
  JSON.stringify(selectBeliefs(rows)))
check('负控 只给 `belief:origin` ⇒ beliefs 是**空数组**（不是"一条信念"）',
  selectBeliefs([{ projectionType: COGNITION_BELIEF_ORIGIN_TYPE, state: {} }]).length === 0, '应 0')
check('恢复 把 `belief:origin` 改成 `belief:<id>` ⇒ 又能被选中',
  selectBeliefs([{ projectionType: 'belief:origin-2', state: { key: 'x' } }]).length === 1, '应 1')

check('正控 水位：按键排序且只留安全整数',
  JSON.stringify(selectWatermarks({ belief: 133, affect: 117, bad: 1.5, worse: 'x' as unknown as number })) ===
  JSON.stringify({ affect: 117, belief: 133 }), JSON.stringify(selectWatermarks({ belief: 133, affect: 117, bad: 1.5, worse: 'x' as unknown as number })))
check('负控 水位空输入 ⇒ 空对象（不是 null）', JSON.stringify(selectWatermarks({})) === '{}', JSON.stringify(selectWatermarks({})))

// ---------------------------------------------------------------------------
// 2. 五格整装（原样呈现，不推导）
// ---------------------------------------------------------------------------

const cells = cognitionCellsFromProjections({ characterId: 'c-1', rows, revisions: { affect: 117, belief: 133 } })
check('正控 五格齐：characterId/affect/relationships/beliefs/watermarks',
  cells.characterId === 'c-1' && (cells.affect as { mood?: string })?.mood === 'calm' &&
  cells.relationships.length === 2 && cells.beliefs.length === 1 && cells.watermarks.belief === 133,
  JSON.stringify(cells).slice(0, 140))
check('负控 空 characterId ⇒ null（空串不算身份）',
  cognitionCellsFromProjections({ characterId: '   ', rows: [], revisions: {} }).characterId === null, '应 null')
check('负控 没有行 ⇒ 三格是 null/空数组（**不**编造）',
  JSON.stringify(cognitionCellsFromProjections({ characterId: 'c-1', rows: [], revisions: {} })) ===
  JSON.stringify({ characterId: 'c-1', affect: null, relationships: [], beliefs: [], watermarks: {} }),
  JSON.stringify(cognitionCellsFromProjections({ characterId: 'c-1', rows: [], revisions: {} })))
check('不重算：beliefs 原样是 `state`（没有被折叠成结论）',
  JSON.stringify(cells.beliefs[0]) === JSON.stringify({ key: 'education.institution' }), JSON.stringify(cells.beliefs[0]))

// ---------------------------------------------------------------------------
// 3. 结构：不 import 认知引擎
// ---------------------------------------------------------------------------

const text = readFileSync(resolve(ROOT, READER), 'utf8')
const codeOnly = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
check('结构：**代码**里不 import 任何折叠/认知引擎（`kernel/projections`、`kernel/app`）',
  !/from '[^']*kernel\/projections\//.test(codeOnly) && !/from '[^']*kernel\/app\//.test(codeOnly), '不应 import')
check('结构：**代码**里不出现写侧入口（`apply*` / `rebuild*` / `deleteProjection`）',
  !/apply[A-Z]/.test(codeOnly) && !/rebuild[A-Z]/.test(codeOnly) && !codeOnly.includes('deleteProjection'), '不应出现')
check('接线：reader **调**既有只读入口 `listProjections` 与 `projectionRevisions`',
  codeOnly.includes('listProjections(') && codeOnly.includes('projectionRevisions('), '两个都应在')
check('接线：**代码**里不出现投影写侧（`saveProjection` / `insertProjection` / `deleteProjection`）',
  !codeOnly.includes('saveProjection') && !codeOnly.includes('insertProjection') && !codeOnly.includes('deleteProjection'),
  '不应出现')
/*
 * ⚠️ 第一版写成"不许 import 任何别的 persistence 模块" —— 结果被**合法的类型导入**
 *    （`import type { RawDb } from '../persistence/db.ts'`）判红：判据太粗，不是代码错。
 *    判据改成：**值导入**只许来自 `event-store.ts`（`import type` 不受限 —— 类型不产生读行为）。
 */
const valueImportsFromPersistence = [...codeOnly.matchAll(/import\s*\{[^}]*\}\s*from\s*'\.\.\/persistence\/([^']+)'/g)]
  .map((match) => match[1])
  .filter((module) => module !== 'event-store.ts')
check('接线：**值导入**只许来自 `event-store.ts`（其它持久层模块只能 `import type`）',
  valueImportsFromPersistence.length === 0, valueImportsFromPersistence.join(', '))
check('接线：`RawDb` 是**类型**导入（`import type`）——不引入运行时依赖',
  /import type \{[^}]*RawDb[^}]*\} from '\.\.\/persistence\/db\.ts'/.test(codeOnly), '应是 import type')
check('结构：只 import 类型与**读**入口（`contracts/ids.ts` / `persistence/db.ts` 类型 / `event-store.ts`），不 import 认知引擎',
  !/from '[^']*kernel\/projections\//.test(codeOnly) && !/from '[^']*kernel\/app\//.test(codeOnly), '不应 import 引擎')
check('判据是活的（剥注释这一步真的生效）', codeOnly.length < text.length, `${codeOnly.length} < ${text.length}`)

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP2 cognition reader（选择半）：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ 本门**不碰数据库**：真 `db` 注入（listProjections / projectionRevisions / getProjection）是下一步。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
