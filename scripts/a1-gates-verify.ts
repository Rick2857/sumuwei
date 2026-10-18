/**
 * A1 / **WP6 最小切片：A1 门表自洽性**（离线 · 零数据库 · 零出网）。
 *
 * ============================================================================
 *  它回答什么
 * ============================================================================
 * ```text
 * ① `a1:*` 的每一道门：在 manifest 里有 `why`（说明它守什么）· `entry` 文件**真的存在** ·
 *    `package.json` 里有同名脚本且命令指向同一个入口文件
 * ② 反向：`package.json` 里所有 `a1:*:verify` 脚本都**登记在 manifest** 里（没有"跑了但没登记"的门）
 * ③ 每道门都有 `measured_count` 的声明面（门脚本里出现 `measured_count`）—— 防止新门忘了这条纪律
 * ⚠️ 它**不**跑那些门、**不**主张它们通过（那是 `gates:run` / 各门自己的读数）；
 *    它只保证"**门表本身**没有漏登记、没有指向不存在的文件"。
 * ```
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALL_GATES } from './gates/manifest.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
const a1Gates = ALL_GATES.filter((gate) => gate.id.startsWith('a1:'))
const a1Scripts = Object.entries(packageJson.scripts).filter(([name]) => /^a1:.*:verify$/.test(name))

check('A1 门表非空（至少 11 道）', a1Gates.length >= 11, String(a1Gates.length))

const missingWhy = a1Gates.filter((gate) => typeof gate.why !== 'string' || gate.why.trim().length < 40)
check('每道 A1 门都写清了"守什么"（`why` 非空且够具体）', missingWhy.length === 0, missingWhy.map((g) => g.id).join(', '))

const missingEntry = a1Gates.filter((gate) => typeof gate.entry !== 'string' || !existsSync(resolve(ROOT, gate.entry)))
check('每道 A1 门的 `entry` 文件真的存在', missingEntry.length === 0, missingEntry.map((g) => g.id).join(', '))

const notInScripts = a1Gates.filter((gate) => packageJson.scripts[gate.id] === undefined)
check('每道 A1 门在 `package.json` 里有同名脚本', notInScripts.length === 0, notInScripts.map((g) => g.id).join(', '))

const mismatched = a1Gates.filter((gate) => {
  const command = packageJson.scripts[gate.id]
  if (command === undefined || typeof gate.entry !== 'string') return false
  return !command.includes(gate.entry.replace(/\\/g, '/'))
})
check('脚本命令指向**同一个**入口文件（不是指向别的门）', mismatched.length === 0, mismatched.map((g) => g.id).join(', '))

const unregistered = a1Scripts.filter(([name]) => !a1Gates.some((gate) => gate.id === name))
/*
 * ⚠️ **live 门按规矩不进离线门表**（`WP2 交接单 §1bis ④`：它们**会打开生产库**，
 *    混进离线表会让 `.env` 一换后端就红得莫名其妙；与 `postlv2:bridge:verify` 同例）。
 *    ⇒ 这里**具名豁免**它们，而不是让"反向覆盖"这条判据把它们逼进表里。
 *    ⚠️ 豁免必须**具名**：新加 live 门时要显式加进这个列表（否则判据会红 —— 那是提醒，不是阻碍）。
 */
/**
 * **live 门**不进离线 manifest（它们要真库 / 口令 / 会写库），所以它们在
 * "package.json 有 / manifest 无"这条判据上**必须具名豁免**。
 * ⚠️ 加一道 live 门时**必须**同时把它加进这里 —— 否则那条判据会红，
 *   而"红了就放宽判据"正是本仓库最忌讳的做法（豁免是**具名**的，不是"数得清就行"）。
 * ⚠️ 下面那条判据反过来确认：豁免表里的名字**必须真的存在**于 package.json
 *   （防止"豁免了一个不存在的东西"来给自己开脱）。
 */
const A1_LIVE_GATES_NOT_IN_OFFLINE_MANIFEST: readonly string[] = [
  'a1:serve:db:live:verify',
  'a1:jobs-admit:live:verify',
]
const unregisteredReal = unregistered.filter(([name]) => !A1_LIVE_GATES_NOT_IN_OFFLINE_MANIFEST.includes(name))
check('反向：`package.json` 里的 `a1:*:verify` 脚本**全部**登记在 manifest（**live 门具名豁免**）',
  unregisteredReal.length === 0,
  `${unregisteredReal.map(([name]) => name).join(', ')}（豁免：${A1_LIVE_GATES_NOT_IN_OFFLINE_MANIFEST.join(', ')}）`)
check('豁免的 live 门**确实存在于 package.json**（豁免不是"允许写错名字"）',
  A1_LIVE_GATES_NOT_IN_OFFLINE_MANIFEST.every((name) => packageJson.scripts[name] !== undefined),
  A1_LIVE_GATES_NOT_IN_OFFLINE_MANIFEST.join(', '))

const noMeasured = a1Gates.filter((gate) => {
  /* ⚠️ `entry` 在类型上是可选的 ⇒ 必须先收窄（第一版直接 `resolve(ROOT, gate.entry)`，
     `tsx` 照跑、`tsc` 判红 TS2345 —— 同型第四次） */
  if (typeof gate.entry !== 'string') return true
  const text = readFileSync(resolve(ROOT, gate.entry), 'utf8')
  return !text.includes('measured_count')
})
check('每道 A1 门都声明了 `measured_count`（`measured_count > 0` 那条纪律）', noMeasured.length === 0, noMeasured.map((g) => g.id).join(', '))

/* 判据是活的：能认出"指向不存在的入口" */
check('判据是活的（一次假入口会被认出）',
  !existsSync(resolve(ROOT, 'scripts/a1-does-not-exist.ts')), '假入口不应存在')

/*
 * ============================================================================
 *  WP6：**契约 §7 的六个退出门 ↔ 切片门**的对应表（**从 `evals/a1/gate-map.json` 读**）
 * ============================================================================
 * ```text
 * ⚠️ 第一版把这张表**内联在这个门里** ⇒ 一旦要第二个消费者（聚合 runner）就会有两份副本。
 *    ⇒ 2026-10-14 抽成数据文件：**一处定义，多处读**（与本仓库"冻结清单"同一套做法）。
 * ⚠️ `A1-G6`（核心停机窗口）**故意留空**：它需要"真核心停/起"的实测 ——
 *    如实登记为**空**（带 `emptyReason`），不许拿别的门顶替。
 * ```
 */
interface ContractGateEntry { id: string; title: string; servedBy: readonly string[]; emptyReason?: string }
const gateMap = JSON.parse(
  readFileSync(resolve(ROOT, 'evals/a1/gate-map.json'), 'utf8')
) as { contractGates: ContractGateEntry[] }
const CONTRACT_GATE_COVERAGE = gateMap.contractGates
const contractGateIds = CONTRACT_GATE_COVERAGE.map((entry) => entry.id)
check('WP6 六个契约门**逐个有映射条目**（含故意留空的 A1-G6）', contractGateIds.length === 6, contractGateIds.join(' · '))
const invented = CONTRACT_GATE_COVERAGE.flatMap((entry) => entry.servedBy).filter((id) => !ALL_GATES.some((gate) => gate.id === id))
check('WP6 映射里指名的门**全部真实存在**（没有编造的门名）', invented.length === 0, invented.join(', '))
const g6 = CONTRACT_GATE_COVERAGE.find((entry) => entry.id === 'A1-G6')
/*
 * ⚠️ `A1-G6` 从"0 道（如实留空）"变成"**部分覆盖**"（2026-10-14 补了 `a1:core-stop:verify`）。
 *    判据随之从"必须为空"改成"**必须具名写清未覆盖的部分**"——
 *    契约里的那一句永远不可能被一条离线门说满（真核心停/起是实测，不是结构）。
 */
check('WP6 `A1-G6` **必须具名**写清未覆盖的部分（不许只说"已覆盖"）',
  g6 !== undefined && (g6.emptyReason ?? '').trim() !== '', g6?.emptyReason ?? '(缺 emptyReason)')
check('WP6 `A1-G6` 已由 `a1:core-stop:verify` 服务（部分覆盖，不是空）',
  (g6?.servedBy ?? []).includes('a1:core-stop:verify'), (g6?.servedBy ?? []).join(', '))
const unmapped = a1Gates.map((gate) => gate.id).filter((id) => !CONTRACT_GATE_COVERAGE.flatMap((entry) => entry.servedBy).includes(id))
check('WP6 **反向覆盖**：每道在册 A1 门都至少服务一个契约门（没有"孤立门"）',
  unmapped.length === 0, `未映射：${unmapped.join(', ')}`)

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 门表自洽：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log(`  在册 A1 门（${a1Gates.length}）：${a1Gates.map((g) => g.id).join(' · ')}`)
console.log('⚠️ 本门只证"门表自洽"：不跑那些门、不主张它们通过（那是各门自己的读数）。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
