/**
 * M4.1 WP-09 / G13 —— **Production-copy Live Smoke**（Layer D，**Hard Gate**）。
 *
 * ============================================================================
 *  它是 M4.1 唯一能回答"用户看到的是不是真的"的那道门
 * ============================================================================
 * Layer A/B/C 都是离线、确定性的（那是对的，它们必须能进 CI）。
 * 但它们**看不见**一件事：
 *
 *     真实模型 + 真实 turn loop + 真实回复
 *
 * M4 正是栽在这里 —— `M4-verification.md` §5.6 的原话：
 *
 *     发现它的途径不是任何测试，而是**在真库里真的说了一句话**。
 *
 * 所以这道门跑真实多轮，并对**每一轮**同时检查三样东西：
 *   ① 库变了没有（真实持久状态）
 *   ② 她说了什么（用户看到什么）
 *   ③ 两者是否一致（C23：**声明必须与事实一致**）
 *
 * ---------------------------------------------------------------------------
 *  安全（不可协商）
 * ---------------------------------------------------------------------------
 * 全部在 `data/pglite` 的**副本**上跑。真实库只被复制，**从不被打开**。
 *
 * 跑法：pnpm m4:smoke:live        （需要 OPENAI_API_KEY，约 10–20 分钟）
 */

import 'dotenv/config'

import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import { replyClaimsSuccess } from '../src/kernel/app/memory/response-truth.ts'

const ROOT = resolve('.')
const evidenceDir = join(ROOT, 'artifacts', 'm4.1', 'smoke')

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

// ---------------------------------------------------------------------------
// 副本（**绝不打开真实库**）
// ---------------------------------------------------------------------------
if (!existsSync(PRODUCTION_DB_DIR)) {
  console.error(`找不到真实库：${PRODUCTION_DB_DIR}`)
  process.exit(2)
}
const work = mkdtempSync(join(tmpdir(), 'project-lg-m41-smoke-'))
const dbDir = join(work, 'pglite')
console.log('='.repeat(72))
console.log('M4.1 Production-copy Live Smoke（Layer D / G13 / Hard Gate）')
console.log('='.repeat(72))
console.log(`真实库（只复制，从不打开）：${PRODUCTION_DB_DIR}`)
cpSync(PRODUCTION_DB_DIR, dbDir, { recursive: true })
console.log(`副本（全部读写都在这里）  ：${dbDir}`)
if (isProductionDir(dbDir)) {
  console.error('拒绝运行：副本目录与真实库重叠')
  process.exit(2)
}

const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')
const envFor = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  PGLITE_DATA_DIR: dbDir,
  PROJECT_LG_SANDBOX: dbDir,
  ...extra,
})

function runMain(args: readonly string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [tsxCli, 'src/main.ts', ...args], {
    cwd: ROOT,
    env: envFor(extraEnv),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return { status: r.status ?? 1, stdout: String(r.stdout ?? '') }
}

interface Stats {
  total: number
  active: number
  retracted: number
}
function parseNum(text: string, label: string): number {
  const m = text.match(new RegExp(`${label}\\s*:\\s*(\\d+)`))
  return m ? Number(m[1]) : -1
}
function stats(): Stats {
  const { stdout } = runMain(['--memory-stats'])
  return {
    total: parseNum(stdout, 'total'),
    active: parseNum(stdout, 'active'),
    retracted: parseNum(stdout, 'retracted'),
  }
}
/**
 * 读出当前的 active 记忆（用生产的只读命令 `--memory-list`）。
 *
 * ============================================================================
 *  ⚠️ 必须只取**记录内容行**，不能取整段 stdout
 * ============================================================================
 * 第一版写的是"取所有含 `=` 的行"，于是把启动日志里的
 * `hash=0837c648…`、`载入状态 v13：valence=0.000 …` 一起收了进来。
 * 后果：两次调用之间**日志本身**会变（运行 id / 状态版本会变），于是
 * 「active 集合逐条不变」这条断言在**库根本没动**的情况下红了 ——
 * 实测输出 `24 → 24`：条数一样、内容不一样，因为**噪声在变**。
 *
 * 这正是本项目反复记录的那类错误：**测量工具量的是错的东西**。
 * 判据必须只看记录块，所以这里按内容行的形状来筛：
 * 形如 `predicate = value`，且不含日志特征词。
 *
 * 第三版（本版）：上面那条只解决了"噪声"，没解决"**范围**"——
 * 函数名叫 activeValues，但 `--memory-list` 默认列出**所有状态**的记录，
 * 于是 retracted 的旧行也被算成"当前有效事实"。
 * 实测后果：S3 正确 forget 之后 `stats` 明确显示 active 2→1，
 * 而这里仍然读出 cilantro，S7 因此假红（"她已经忘了"这件事明明是好的）。
 * 这与上面那段是**同一类**错误的两个面：噪声混进来、范围放太宽。
 * 判据必须只看 active，所以显式加 `--status active`（生产 CLI 本来就支持）。
 */
function activeValues(): string[] {
  const { stdout } = runMain(['--memory-list', '--status', 'active'])
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^\S+\s=\s\S/.test(l))
    .filter((l) => !l.includes('hash=') && !l.includes('parameters=') && !l.startsWith('Info'))
}

interface TurnResult {
  line: string
  reply: string
  before: Stats
  after: Stats
  changed: boolean
  successClaim: { claims: boolean; markers: string[] }
}

/**
 * 跑一轮真实对话，并对"声明 vs 事实"做断言。
 *
 * 这一条是 C23：**用户看到的必须与库里真实发生的一致。**
 * `expectChange` 由场景给出，因此判据不依赖我对模型的猜测。
 */
function turn(
  scene: string,
  line: string,
  expectChange: 'yes' | 'no' | 'any',
  extraEnv: Record<string, string> = {}
): TurnResult {
  const before = stats()
  const { stdout } = runMain([line], extraEnv)
  const reply = (stdout.match(/苏沐薇:\s*([\s\S]*?)(?:\n\n|\n\[|$)/)?.[1] ?? '').trim()
  const after = stats()
  const changed =
    after.total !== before.total || after.active !== before.active || after.retracted !== before.retracted

  const claim = replyClaimsSuccess(reply)
  console.log(`  · ${scene}`)
  console.log(`    我：${line}`)
  console.log(`    她：${reply.slice(0, 160) || '(没有捕获到回复)'}`)
  console.log(
    `    库：total ${before.total}→${after.total} active ${before.active}→${after.active} ` +
      `retracted ${before.retracted}→${after.retracted}`
  )

  if (expectChange === 'yes') {
    check(`${scene}：库**确实**发生了变化`, changed, changed ? '' : '预期有变化，实际没有')
  } else if (expectChange === 'no') {
    check(
      `${scene}：库**没有**发生任何变化（无 silent mutation）`,
      !changed,
      changed ? `❌ 意外变化：active ${before.active}→${after.active}` : ''
    )
    check(
      `${scene}：她**没有**宣称成功（声明与事实一致，C23）`,
      !claim.claims,
      claim.claims ? `❌ 回复里出现成功口吻：${claim.markers.join('/')}｜"${reply.slice(0, 80)}"` : ''
    )
  }

  transcript.push({ scene, line, reply, before, after, changed, successClaim: claim })
  return { line, reply, before, after, changed, successClaim: claim }
}

// ---------------------------------------------------------------------------
section('基线（生产库副本的当前状态）')
// ---------------------------------------------------------------------------
const base = stats()
console.log(`  total=${base.total} active=${base.active} retracted=${base.retracted}`)
check('副本可读', base.total >= 0)
check('基线里有 1 条 active（就是示科那条）', base.active === 1, `active=${base.active}`)

// ---------------------------------------------------------------------------
section('S1a 正常 remember（受支持的确定性说法）')
// ---------------------------------------------------------------------------
turn('S1a', '记住，我不吃香菜', 'yes')

// ---------------------------------------------------------------------------
section('S6 写入之后读取一致（M4 只保证"存得住"；会话语义召回是 M5）')
// ---------------------------------------------------------------------------
{
  const values = activeValues()
  check(
    'S6：写进去的那条**在库里读得到**（write→read 一致）',
    values.some((v) => v.toLowerCase().includes('cilantro')),
    values.join(' | ')
  )
  const r = turn('S6', '我喜欢吃香菜吗？', 'any')
  console.log(`    （她的回答作为观察记录，不作为断言 —— 语境召回属 M5）`)
  void r
}

// ---------------------------------------------------------------------------
section('S1b / S8 Failure Truth（任务书原话：规则抽取器不支持的说法）')
// ---------------------------------------------------------------------------
turn('S1b', '记住，我平时主要用 VS Code', 'no')

// ---------------------------------------------------------------------------
section('S2 另一条不支持的说法')
// ---------------------------------------------------------------------------
turn('S2', '记住，我最近开始学 Rust 了', 'no')

// ---------------------------------------------------------------------------
section('S3 正确 forget（目标真的存在）')
// ---------------------------------------------------------------------------
turn('S3', '忘掉我不吃香菜这件事', 'yes')

// ---------------------------------------------------------------------------
section('S7 remember → forget 之后，它**不再**是当前有效事实')
// ---------------------------------------------------------------------------
{
  const values = activeValues()
  check(
    'S7：cilantro 那条不再是 active',
    !values.some((v) => v.toLowerCase().includes('cilantro')),
    `active=${values.join(' | ')}`
  )
  const r = turn('S7', '我平时吃什么口味？', 'any')
  void r
}

// ---------------------------------------------------------------------------
section('S4 不存在目标 forget（D1 的原形：示科那条必须完好）')
// ---------------------------------------------------------------------------
{
  const before = activeValues()
  const r = turn('S4', '忘掉我养过一只鹦鹉这件事', 'no')
  const after = activeValues()
  check(
    'S4：示科那条**仍然 active**',
    after.some((v) => v.includes('示例工程科技大学')),
    after.join(' | ')
  )
  check(
    'S4：active 集合逐条不变',
    JSON.stringify([...before].sort()) === JSON.stringify([...after].sort()),
    `${before.length} → ${after.length}`
  )
  void r
}

// ---------------------------------------------------------------------------
section('S5 模糊 forget（不得挑一条）')
// ---------------------------------------------------------------------------
turn('S5', '忘掉我学校的事', 'no')

// ---------------------------------------------------------------------------
section('S6b 后台抽取开关打开后仍然不产出（D3 的如实状态）')
// ---------------------------------------------------------------------------
{
  const bg = { CHARACTER_MEMORY_BACKGROUND_ENABLED: '1' }
  const before = activeValues()
  turn('S6b-1', '我平时住在西安', 'any', bg)
  const after = activeValues()
  console.log(
    `    观察：开关打开后 active 集合变化 ${before.length} → ${after.length}` +
      '（D3：该开关没有消费者，预期不产出）'
  )
}

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  join(evidenceDir, 'smoke-result.json'),
  `${JSON.stringify(
    {
      testId: 'M4.1 / Layer D / G13',
      name: 'Production-copy Live Smoke (HARD GATE)',
      priority: 'P0',
      status: failed === 0 ? 'PASS' : 'FAIL',
      productionDb: PRODUCTION_DB_DIR,
      note: '生产库全程只被复制，未被打开；每一轮同时检查库变化与回复口吻',
      baseline: base,
      transcript,
      checks: { passed, failed, failures },
    },
    null,
    2
  )}\n`,
  'utf8'
)

rmSync(work, { recursive: true, force: true })

console.log(`\n${'='.repeat(72)}`)
console.log(`M4.1 Production-copy Live Smoke：${passed} 通过 / ${failed} 失败`)
if (failures.length > 0) console.log(`失败项：${failures.join(' | ')}`)
console.log(`证据：${join(evidenceDir, 'smoke-result.json')}`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
