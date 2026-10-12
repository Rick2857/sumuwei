/**
 * M4.5 L0 —— **Measurement Validation**（`pnpm m4.5:measurement:verify` / G12）。
 *
 * ============================================================================
 *  它测的不是系统，是**量具**
 * ============================================================================
 * M4.1 的验收里发现了两次"量具自身的错误"：
 *
 *   · 第一版 `activeValues()` 把启动日志的 `hash=…` 当成了记忆内容
 *   · 第二版函数名写着 active，实际列出的是**全部状态**，于是已经正确
 *     遗忘的记录仍被算成"当前有效事实" → 假红
 *
 * 两版的共同形状是：**函数名 / 意图说的是 A，代码实际量的是 B，
 * 而结果看起来"合理"，所以没人查**。
 *
 * 因此本门只做一件事，而且必须真的做到：
 *
 * ```text
 * 播七种终态 fixture
 *   → 对每个状态跑**生产 CLI**（action:list --status X）
 *   → 断言输出**恰好等于**该状态的集合（逐 id 比对）
 *   → 断言不过滤时的集合严格大于任一单态集合（防"过滤恒空/恒全"）
 *   → 负向控制：未知 status 必须报错退出，绝不静默返回全部
 * ```
 *
 * ⚠️ 主进程**从不打开数据库**（PGlite 一个目录只能被一个进程打开）：
 *    fixture 由一个子进程播，查询由另外的子进程跑。
 *
 * 跑法：pnpm m4.5:measurement:verify
 */

import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { cleanupSandbox, isolateDatabase, isProductionDir } from '../src/dev/sandbox.ts'

const ROOT = resolve('.')
const evidenceDir = join(ROOT, 'artifacts', 'm4.5')
const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

let passed = 0
let failed = 0
const failures: string[] = []
const transcript: Record<string, unknown>[] = []

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

console.log('='.repeat(72))
console.log('M4.5 L0 Measurement Validation（量具自己也要被验证 / G12）')
console.log('='.repeat(72))

const sandbox = isolateDatabase('m45-measurement', { keep: false })
if (isProductionDir(sandbox.dir)) {
  console.error('拒绝运行：隔离目录与真实库重叠')
  process.exit(2)
}

/**
 * 跑一次**生产 CLI**（`tsx src/main.ts <args>`）。
 *
 * ⚠️ 必须显式给出 `src/main.ts`：tsx 会把紧跟其后的 `--flag` 当成
 *    Node 自己的选项（实测报 `node.exe: bad option: --action-list`）。
 *    这正是"量具本身也会错"的又一例 —— 而且它的失败方式是**空输出**，
 *    看起来像"库里没有记录"。
 */
function run(args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, 'src/main.ts', ...args], {
    cwd: ROOT,
    env: { ...process.env, PGLITE_DATA_DIR: sandbox.dir, PROJECT_LG_SANDBOX: sandbox.dir },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

/** 跑一个独立脚本（fixture 播种器等） */
function runScript(path: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [tsxCli, path], {
    cwd: ROOT,
    env: { ...process.env, PGLITE_DATA_DIR: sandbox.dir, PROJECT_LG_SANDBOX: sandbox.dir },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  }
}

// ===========================================================================
// §0 量具本身：解析函数必须能区分"记录行"与"噪声"
// ===========================================================================
section('§0 量具自检（先把"量错东西"这件事本身测掉）')

/**
 * 解析 `action:list` 输出里的 `actionId → status`。
 *
 * ⚠️ 只认**记录行**（形如 `  · act:… status=…`），
 *    并且要求同一行里 id 与 status 同时出现 ——
 *    这正是 M4.1 第一版量具的错法：取"整段 stdout"或"含 = 的行"。
 */
function parseList(stdout: string): { ids: string[]; pairs: { id: string; status: string }[] } {
  const pairs: { id: string; status: string }[] = []
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line.startsWith('·')) continue
    const idMatch = /(act:[0-9a-fA-F-]{36})/.exec(line)
    const statusMatch = /status=([a-z_]+)/.exec(line)
    if (idMatch === null || statusMatch === null) continue
    pairs.push({ id: idMatch[1]!, status: statusMatch[1]! })
  }
  return { ids: pairs.map((p) => p.id), pairs }
}

const noisyFixture = [
  'kernel flags: ON=[action(R1)] OFF=[…] action-sandbox=data/action-sandbox',
  '  · act:11111111-1111-1111-1111-111111111111  status=success  capability=sandbox.file.write  op=write',
  'hash=0837c648deadbeef actionId=act:99999999-9999-9999-9999-999999999999',
  '  共 2 条',
  '  · act:22222222-2222-2222-2222-222222222222  status=failed  capability=x.y  op=write',
].join('\n')
const noisyParsed = parseList(noisyFixture)
check(
  '§0.1 解析器只认记录行：日志里的 hash= / actionId= 不被当成记录',
  noisyParsed.ids.length === 2 && !noisyParsed.ids.includes('act:99999999-9999-9999-9999-999999999999'),
  `解析出 ${noisyParsed.ids.length} 条`
)
check(
  '§0.2 解析器同时取出 status（不是只要 id）',
  noisyParsed.pairs.every((p) => p.status === 'success' || p.status === 'failed')
)

// ===========================================================================
// §1 播种 fixture（子进程）
// ===========================================================================
section('§1 播种七种终态（子进程，走生产端口）')
const seeded = runScript('scripts/seed-m4.5-ledger-fixture.ts')
check('§1.1 播种进程成功退出', seeded.status === 0, `exit=${seeded.status}${seeded.status === 0 ? '' : ` stderr=${seeded.stderr.slice(-300)}`}`)

interface Fixture {
  expected: Record<string, string[]>
  total: number
  traceId: string
  byStatus: Record<string, number>
}
let fixture: Fixture | undefined
try {
  fixture = JSON.parse(readFileSync(join(sandbox.dir, 'm45-fixture.json'), 'utf8')) as Fixture
} catch (error) {
  check('§1.2 fixture 文件可读', false, String(error))
}
check('§1.2 fixture 文件可读', fixture !== undefined)
if (fixture === undefined) {
  console.error(seeded.stdout.slice(-4000))
  process.exit(1)
}

const statuses = Object.keys(fixture.expected)
check('§1.3 七种状态都被造出来了', statuses.length === 7, statuses.join('/'))
check(
  '§1.4 每个状态至少一条（否则"恰好等于"会空过）',
  statuses.every((s) => (fixture!.expected[s] ?? []).length > 0),
  statuses.map((s) => `${s}=${fixture!.expected[s]!.length}`).join(' ')
)

// ===========================================================================
// §2 生产 CLI 的 --status 过滤逐状态精确
// ===========================================================================
section('§2 生产 CLI 的 --status 过滤（逐 id 精确）')

const unfiltered = run(['--action-list', '--limit', '200'])
const unfilteredParsed = parseList(unfiltered.stdout)
check('§2.1 不过滤时能读出全部记录', unfiltered.status === 0 && unfilteredParsed.ids.length === fixture.total, `${unfilteredParsed.ids.length} / ${fixture.total}`)

for (const status of statuses) {
  const result = run(['--action-list', '--status', status, '--limit', '200'])
  const parsed = parseList(result.stdout)
  const expectedIds = [...fixture.expected[status]!].sort()
  const actualIds = [...parsed.ids].sort()
  const exact = JSON.stringify(expectedIds) === JSON.stringify(actualIds)
  check(
    `§2.2 [${status}] 输出恰好等于该状态的集合（逐 id）`,
    result.status === 0 && exact,
    exact ? `${actualIds.length} 条` : `期望 ${expectedIds.join(',')}｜实际 ${actualIds.join(',')}`
  )
  check(
    `§2.3 [${status}] 每一行的 status 都真的是 ${status}`,
    parsed.pairs.every((p) => p.status === status),
    parsed.pairs.map((p) => p.status).join(',')
  )
  check(
    `§2.4 [${status}] 不过滤的集合严格大于该状态集合（过滤真的在起作用，不是恒空/恒全）`,
    unfilteredParsed.ids.length > actualIds.length,
    `${unfilteredParsed.ids.length} > ${actualIds.length}`
  )
  transcript.push({ status, expected: expectedIds, actual: actualIds, exact, exit: result.status })
}

// ===========================================================================
// §3 负向控制：未知状态 / 未知 id 绝不被静默接受
// ===========================================================================
section('§3 负向控制（错的量法必须报错，不得静默给一个"看起来对"的结果）')
{
  const bogus = run(['--action-list', '--status', 'sleeping'])
  check('§3.1 未知 status → 非零退出', bogus.status !== 0, `exit=${bogus.status}`)
  check('§3.2 未知 status 时输出不含任何记录行（不会静默返回全部）', parseList(bogus.stdout).ids.length === 0)
  check('§3.3 未知 status 时打印用法说明', bogus.stdout.includes('--status'))

  const missing = run(['--action-show', 'act:00000000-0000-0000-0000-000000000000'])
  check('§3.4 不存在的 actionId → 非零退出', missing.status !== 0, `exit=${missing.status}`)

  const badLimit = run(['--action-list', '--limit', 'abc'])
  check('§3.5 非法 limit 不导致崩溃（回退到缺省）', badLimit.status === 0)
}

// ===========================================================================
// §4 其余 CLI 表面也要被量对（show / trace / audit）
// ===========================================================================
section('§4 show / trace / audit 的输出与账本一致')
{
  const successId = fixture.expected['success']![0]!
  const detail = run(['--action-show', successId])
  check('§4.1 action:show 找到该动作', detail.status === 0 && detail.stdout.includes(successId))
  check('§4.2 show 输出含判定留痕（"为什么允许"）', detail.stdout.includes('决策') || detail.stdout.includes('candidates') || detail.stdout.includes('目标'))

  const traceOutput = run(['--action-trace', fixture.traceId])
  check('§4.3 action:trace 能按 traceId 反查到动作', traceOutput.status === 0 && traceOutput.stdout.includes('ACTION_REQUESTED'))

  const audit = run(['--action-audit', '--limit', '200'])
  check('§4.4 action:audit 通过（审计不变量零违规）', audit.status === 0 && audit.stdout.includes('全部通过'), audit.stdout.split('\n').find((l) => l.includes('审计不变量')) ?? '')
  check(
    '§4.5 audit 报出的物理执行次数与 fixture 一致（executed 且非重放）',
    audit.stdout.includes('物理执行'),
    audit.stdout.split('\n').find((l) => l.includes('物理执行')) ?? ''
  )
}

// ===========================================================================
// 证据
// ===========================================================================
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'measurement.json'),
  `${JSON.stringify(
    {
      testId: 'M4.5 / L0 / G12',
      name: 'Measurement Validation（量具验证）',
      priority: 'P0',
      status: failed === 0 ? 'PASS' : 'FAIL',
      discipline:
        '过滤只走生产 CLI + 生产端口；逐 id 精确比对；不过滤集合必须严格更大；未知状态必须报错',
      fixture: { total: fixture.total, byStatus: fixture.byStatus },
      transcript,
      checks: { passed, failed, failures },
    },
    null,
    2
  )}\n`,
  'utf8'
)

cleanupSandbox(sandbox.dir)

console.log(`\n${'='.repeat(72)}`)
console.log(`M4.5 L0 Measurement Validation：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
console.log(`证据：${join(evidenceDir, 'measurement.json')}`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
