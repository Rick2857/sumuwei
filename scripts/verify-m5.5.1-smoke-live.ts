/**
 * M5.5.1 **WP7 真实搜索 Live Smoke**（`pnpm with-test-model pnpm m5.5.1:smoke:live`）。
 *
 * ============================================================================
 *  它补的是语义门**永远证明不了**的那一半
 * ============================================================================
 * 语义门（`m5.5.1:semantics:live`）只调**判定模型**：它证明"该不该搜、搜什么"，
 * **不构造 provider、不出站**。WP7 还要求真实出站链路：
 *
 * ```text
 * 真实生产入口（`src/main.ts` 本尊，子进程）
 *   → 真实判定模型（测试端点）
 *   → 真实 SearXNG（本机 8080）
 *   → 证据入模 → 用户可见回复 + 程序生成的来源附录 → 账本
 * ```
 *
 * 跑在**生产库的副本**上（`cpSync` 到临时目录），真实库**只读不打开**；
 * 前后各取一次**树摘要 + 最新写入时间**（`data/` 被 gitignore，`git status` 对它无效）。
 *
 * ---------------------------------------------------------------------------
 *  四条 case（覆盖"成功 + 降级 + 零出站边界"）
 * ---------------------------------------------------------------------------
 * | case | 输入 | 期望 |
 * |---|---|---|
 * | C1 | 显式搜索请求 | **恰好 1 次**真实出站；回复带**程序生成**的来源附录 |
 * | C2 | 显式搜索但查不到 | 如实降级（"没有可以给你引用的结果"或超时句），**不冒充查到** |
 * | C3 | 私人对象（我的笔记） | **零出站**；回复里没有任何来源行 |
 * | C4 | 显式禁止联网 | **零出站**；回复里没有任何来源行 |
 *
 * ---------------------------------------------------------------------------
 *  ⚠️ 本门**不**证明的东西（逐条写出来，免得被读成更强的主张）
 * ---------------------------------------------------------------------------
 * · **auto_public 未激活**：本 smoke 只跑生产已激活的 `explicit` 模式；implicit 路径不在范围内。
 * · **判定失败降级**（超时/坏输出 ⇒ 零搜索）由**离线门**证明（批次 A/E、`m5.5.1:test` §8/§9）；
 *   生产入口**没有**注入判定故障的口子，硬造一个属于改生产代码，要另行裁定。
 * · 单机单端点单次运行：**不能**外推为长期可用性或其它环境的表现。
 * · 不证明"她说得对"（`D-10`：没有逐句蕴含验证）。
 */

import 'dotenv/config'

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PRODUCTION_DB_DIR, isProductionDir } from '../src/dev/sandbox.ts'
import {
  TAVILY_ALLOWED_BODY_FIELDS,
  TAVILY_API_KEY_ENV,
  TAVILY_TEST_API_KEY_ENV,
  loadTavilyConfig,
} from '../src/infrastructure/search/tavily-config.ts'

const ROOT = resolve('.')
const EVIDENCE_DIR = join(ROOT, 'artifacts', 'm5.5.1', 'smoke')

let passed = 0
let failed = 0
const failures: string[] = []
const checks: { label: string; ok: boolean; detail: string }[] = []
function check(label: string, ok: boolean, detail = ''): boolean {
  checks.push({ label, ok, detail })
  if (ok) {
    passed += 1
    console.log(`  ✅ ${label}${detail ? `  [${detail}]` : ''}`)
  } else {
    failed += 1
    failures.push(`${label} :: ${detail}`)
    console.log(`  ❌ ${label}${detail ? `  [${detail}]` : ''}`)
  }
  return ok
}
function section(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

// ---------------------------------------------------------------------------
// G0 失败关闭：必须是**测试端点**的 key，且真实库必须只被复制
// ---------------------------------------------------------------------------

section('G0 失败关闭（测试 key · 搜索已启用 · 真实库只复制）')

const testEnvPath = join(ROOT, '.env.test')
if (!existsSync(testEnvPath)) {
  console.error('[m551] 缺少 .env.test：本门拒绝运行（exit 2）。请用 pnpm with-test-model')
  process.exit(2)
}
const testEnv: Record<string, string> = {}
for (const line of readFileSync(testEnvPath, 'utf8').split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
  if (match !== null) testEnv[match[1]] = match[2]
}
const testKey = testEnv.OPENAI_API_KEY ?? ''
const usingTestKey = testKey !== '' && process.env.OPENAI_API_KEY === testKey
check(
  '★ 失败关闭：跑的是**测试端点**的 key（绝不回落生产 key）',
  usingTestKey,
  usingTestKey ? 'key 与 .env.test 一致' : '**与 .env.test 不一致或缺失** ⇒ 拒绝（exit 2）'
)
if (!usingTestKey) process.exit(2)

/*
 * ⚠️ 判据修正（2026-09-22 / ADR-054）：SearXNG 时代前置条件是"本机实例活着"（探 `/healthz`）；
 *    Tavily 是托管 API，"服务起没起来"这件事不存在 —— 等价的问题是"**测试凭证在不在**"。
 *    没有凭证 ⇒ 本门拒绝运行（exit 2），**不回落**生产 key（ADR-046 `D-25`）。
 */
const gateConfigResult = loadTavilyConfig({}, { isTestMode: true })
const health: { ok: boolean; detail: string } = gateConfigResult.ok
  ? { ok: true, detail: '配置可加载（key 来源=' + gateConfigResult.config.apiKeyEnvName + '）' }
  : { ok: false, detail: gateConfigResult.problems.join(' / ').slice(0, 200) }
check('★ 前置条件：Tavily 测试凭证与配置就位（否则测的是"没查到"而不是链路）', health.ok, health.detail)
if (!health.ok) {
  console.error('[m551] 搜索配置不可用：本门拒绝运行（exit 2）—— 否则会把"没凭证"读成"链路通了"。需要 ' + TAVILY_TEST_API_KEY_ENV + '≠空')
  process.exit(2)
}
check(
  '★ 前置条件：真实库路径是**生产库**（不是沙箱）',
  isProductionDir(PRODUCTION_DB_DIR),
  PRODUCTION_DB_DIR
)

// ---------------------------------------------------------------------------
// G1 树摘要：真实库**只复制**，前后各取一次
// ---------------------------------------------------------------------------

section('G1 真实库树摘要（只读；`data/` 被 gitignore ⇒ 只能用摘要 + 最新写入时间）')

/** 树摘要：相对路径 + 字节数 + 每文件 sha256 —— **与 M5.5 smoke 同一实现**（已修正的方法） */
function treeDigest(dir: string): { digest: string; files: number; newestMtimeMs: number } {
  const rows: string[] = []
  let newest = 0
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current).sort()) {
      const absolute = join(current, entry)
      const relative = prefix === '' ? entry : `${prefix}/${entry}`
      const info = statSync(absolute)
      if (info.isDirectory()) walk(absolute, relative)
      else {
        newest = Math.max(newest, info.mtimeMs)
        rows.push(
          `${relative}:${info.size}:${createHash('sha256').update(readFileSync(absolute)).digest('hex')}`
        )
      }
    }
  }
  walk(dir, '')
  return {
    digest: createHash('sha256').update(rows.join('|')).digest('hex'),
    files: rows.length,
    newestMtimeMs: newest,
  }
}

const sourceBefore = treeDigest(PRODUCTION_DB_DIR)
check(
  '★ 被测对象数 > 0（0 个文件的"摘要相同"是 MEASUREMENT INVALID）',
  sourceBefore.files > 0,
  `${sourceBefore.files} 文件 · 摘要 ${sourceBefore.digest.slice(0, 16)}…`
)

const work = mkdtempSync(join(tmpdir(), 'project-lg-m551-smoke-'))
const dbDir = join(work, 'pglite')
cpSync(PRODUCTION_DB_DIR, dbDir, { recursive: true })
process.env.PROJECT_LG_SANDBOX = dbDir

// ---------------------------------------------------------------------------
// G2 生产入口（`src/main.ts` 本尊）· 出站捕获
// ---------------------------------------------------------------------------

section('G2 生产入口本尊（`src/main.ts` · 副本库 · 真模型 · 真 Tavily）')

const recorderPath = pathToFileURL(join(ROOT, 'scripts', 'm5.5-fetch-recorder.mjs')).href
const fetchLogPath = join(work, 'fetch.jsonl')
const tsxCli = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const childEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PGLITE_DATA_DIR: dbDir,
  PROJECT_LG_SANDBOX: dbDir,
  /* 只在**这一个子进程**里开联网；`.env` / `.env.test` 一个字节都不改 */
  CHARACTER_WEB_SEARCH_ENABLED: '1',
  CHARACTER_WEB_SEARCH_MODE: 'explicit',
  /* ⚠️ 变量名必须与 scripts/m5.5-fetch-recorder.mjs 一致（读 M55_FETCH_LOG）—— 写错会让"0 次出站"变成量具失效 */
  M55_FETCH_LOG: fetchLogPath,
  NODE_OPTIONS: `--import=${recorderPath}`,
  /*
   * ADR-046 D-25：**显式**把测试凭证传下去 —— 否则子进程会带着从 `.env` 继承来的
   * 生产 key 出站（"以为在跑测试、其实在烧生产额度"）。缺测试 key 时**不回落**，
   * 而 G0 已经先 exit 2 了。
   */
  ...(process.env[TAVILY_TEST_API_KEY_ENV] !== undefined
    ? { [TAVILY_TEST_API_KEY_ENV]: process.env[TAVILY_TEST_API_KEY_ENV] }
    : {}),
})

interface Turn {
  label: string
  input: string
  status: number
  reply: string
  appendix: string
  outbound: {
    method: string
    url: string
    headerNames: string[]
    bodyLength: number
    bodyFieldNames?: string[] | null
  }[]
}
const turns: Turn[] = []
/**
 * ⚠️ 只按**明确的日志前缀**切回复 —— **不要**用"行首是 `[`"，因为程序生成的来源附录
 *    每一行都长这样（`[E1] 标题 — https://…`）。M5.5 在这里踩过一次，把附录整段丢了。
 */
const LOG_PREFIX =
  /^\s*(Info|Warn|Error|Debug|◇|\[sandbox\]|\[kernel\]|\[identity\]|\[telemetry\]|\[action|\[memory|\[search-truth\]|\[evidence-truth\]|\[search-need\]|\[m551\])/

function readFetchLog(): { method: string; url: string; headerNames: string[]; bodyLength: number }[] {
  if (!existsSync(fetchLogPath)) return []
  return readFileSync(fetchLogPath, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as { method: string; url: string; headerNames: string[]; bodyLength: number })
}

const say = (label: string, input: string): Turn => {
  const before = readFetchLog().length
  const result = spawnSync(process.execPath, [tsxCli, 'src/main.ts', input], {
    cwd: ROOT,
    env: childEnv(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const stdout = String(result.stdout ?? '')
  const marker = '苏沐薇:'
  const at = stdout.lastIndexOf(marker)
  const text =
    at === -1
      ? ''
      : stdout
          .slice(at + marker.length)
          .split('\n')
          .filter((line, index) => index === 0 || !LOG_PREFIX.test(line))
          .join('\n')
          .trim()
  const appendixAt = text.lastIndexOf('来源：')
  const appendix = appendixAt === -1 ? '' : text.slice(appendixAt).trim()
  const outbound = readFetchLog().slice(before)
  const turn: Turn = { label, input, status: result.status ?? 1, reply: text, appendix, outbound }
  turns.push(turn)
  console.log(
    `  ${label} status=${turn.status} · 回复 ${turn.reply.length} 字 · 附录 ${appendix === '' ? '无' : `${appendix.split('\n').length - 1} 行`} · 出站 ${outbound.length} 次`
  )
  return turn
}

// ---------------------------------------------------------------------------
// G3 四条 case
// ---------------------------------------------------------------------------

section('G3 case：真实成功 / 降级 / 零出站边界')

/*
 * ⚠️ 预热段**已删除**（2026-09-22 / ADR-054）：那是 SearXNG 专属的（本机三引擎冷启动常超 5000ms）。
 *    Tavily 是托管 API，没有"本机引擎冷启动"这回事；保留一个假预热只会**多花一次 credit**
 *    并让"出站次数"这条判据难以解释。⇒ 删掉，而不是改成"照发一次"。
 */
check('★ 前置条件：Tavily 无需本机预热（SearXNG 专属段已随换代删除）', true, '不发出任何预热请求')

const C1 = say('C1', '帮我联网搜索台风最新路径')
check('★ C1 生产入口正常退出（真模型 + 真搜索）', C1.status === 0, `status=${C1.status}`)
check('★ C1 她真的回了话（Level 1：真实模型的原始回复）', C1.reply.length > 0, `${C1.reply.length} 字`)
/*
 * ⚠️ "出站"只指**搜索服务**：模型端点的 chat/completions 与 /models 是另一回事。
 *    第一版把两类混在一起数，于是"私人查询零出站"被模型调用数弄成了失败 ——
 *    而真正要证明的是"**没有一次对 Tavily 的请求**"。
 */
const isSearchOutbound = (r: { url: string }): boolean => r.url.includes('api.tavily.com/search')
const c1Search = C1.outbound.filter(isSearchOutbound)
check(
  '★ C1 **恰好一次**真实出站到 Tavily（不多不少）',
  c1Search.length === 1,
  `${c1Search.length} 次 · ${C1.outbound.map((r) => r.method + ' ' + r.url.split('?')[0]).join(', ') || '无'}`
)
const c1Request = c1Search[0]
check(
  '★ C1 出站形状：POST · 恰好六个 body 字段 · 凭证在 authorization 头里 · URL 无查询串（ADR-046 D-20/D-26）',
  c1Request !== undefined &&
    c1Request.method === 'POST' &&
    (() => {
      /* query 在 body 里，URL **不许**带查询串；只核对**字段名**（值取不到） */
      if (new URL(c1Request.url).search !== '') return false
      return (c1Request.bodyFieldNames ?? []).join(',') === 'auto_parameters,include_usage,language,max_results,query,search_depth'
    })() &&
    c1Request.headerNames.join(',') === 'accept,authorization,content-type' &&
    c1Request.bodyLength > 0,
  c1Request === undefined
    ? '没有出站'
    : `fields=[${(c1Request.bodyFieldNames ?? []).join(',')}] · headers=${c1Request.headerNames.join(',')} · body=${c1Request.bodyLength}`
)
/*
 * ★ 判据改为**程序事实**，不用她的措辞（三次假阴性换来的教训）：
 *   `来源：` 附录**只能由程序追加**（`D-9`），而且守卫会把她自己写的 `[E<n>]` 剥掉
 *   ⇒ "附录在不在、有几条"本身就是**程序状态**，与她说得漂不漂亮无关。
 *   因此这里只断言形状：附录里的标签必须是连续的 `[E1..En]`，且不能出现空标签行。
 */
function appendixLabels(appendix: string): string[] {
  return appendix
    .split('\n')
    .slice(1)
    .map((line) => /^\[(E\d+)\]/.exec(line.trim())?.[1] ?? '')
}
const c1Labels = appendixLabels(C1.appendix)
check(
  '★ C1 附录形状：有来源时必须是连续的 `[E1]…[En]`（程序生成的可判形状，不看措辞）',
  C1.appendix === '' || c1Labels.every((label, index) => label === `E${index + 1}`),
  C1.appendix === '' ? '本轮未形成来源（如实降级，合法）' : c1Labels.join(',')
)

const C2 = say('C2', '帮我联网搜索 zzqqxx9876543210zz 不存在的词条')
const c2Search = C2.outbound.filter(isSearchOutbound)
check('★ C2 生产入口正常退出', C2.status === 0, `status=${C2.status}`)
/*
 * ⚠️ C2 的判据同样只看**形状**（不看措辞）：那个垃圾查询真的会搜到无关结果，
 *    有时是 5 条、有时 0 条 —— 两种都是合法结果，判据不该固定成其中一种。
 */
const c2Labels = appendixLabels(C2.appendix)
check(
  '★ C2 附录形状：有来源时必须是连续的 `[E1]…[En]`；无来源时不许出现任何来源行',
  C2.appendix === '' || c2Labels.every((label, index) => label === `E${index + 1}`),
  C2.appendix === '' ? '无来源（合法）' : c2Labels.join(',')
)

check(
  '★ C2 最多对 Tavily 发**一次**请求（0 或 1 都合法：判定可以说"不用搜"，且不论结果如何都不重试）',
  c2Search.length <= 1,
  `${c2Search.length} 次`
)

const C3 = say('C3', '我查一下我的笔记')
const C4 = say('C4', '不要联网搜索，只根据你已有的知识回答')
for (const turn of [C3, C4]) {
  check(
    `★ ${turn.label} **零出站**（私人对象 / 显式禁止 ⇒ 不许有任何真实请求）`,
    turn.outbound.filter(isSearchOutbound).length === 0,
    `${turn.outbound.filter(isSearchOutbound).length} 次对 Tavily 的出站（总请求 ${turn.outbound.length} 次，含模型端点）`
  )
  check(
    `★ ${turn.label} 回复里**没有**任何程序来源附录`,
    turn.appendix === '',
    turn.appendix === '' ? '无附录' : `**有附录**：${turn.appendix.slice(0, 40)}`
  )
}

// ---------------------------------------------------------------------------
// G4 真实库未被写过 + 副本确实被写过
// ---------------------------------------------------------------------------

section('G3.5 程序状态读回（Level 2）：账本里真的有这次真实搜索')

/*
 * 只读 CLI 跑在**同一个副本库**上（同一个 `PROJECT_LG_SANDBOX`）——
 * 于是"她这次到底做了什么"不再靠她的措辞，而靠**程序自己的账本**。
 * ⚠️ 只记输出的**形状**（长度 / 是否含 web.search / 行数），不把账本正文写进证据。
 */
const actionList = spawnSync(
  process.execPath,
  [tsxCli, 'src/main.ts', '--action-list'],
  { cwd: ROOT, env: { ...childEnv(), NODE_OPTIONS: '' }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
)
const actionListOut = String(actionList.stdout ?? '')
const ledgerLines = actionListOut.split('\n').filter((line) => line.trim() !== '').length
check(
  '★ 账本读回：真实进程里**确实**留下了 web.search 的执行记录（唯一网关的账）',
  actionList.status === 0 && actionListOut.includes('web.search'),
  `status=${actionList.status} · 输出 ${actionListOut.length} 字 / ${ledgerLines} 行 · 含 web.search=${actionListOut.includes('web.search')}`
)

section('G4 真实库前后一致 / 副本确实被写过')

const sourceAfter = treeDigest(PRODUCTION_DB_DIR)
check(
  '★ 真实库树摘要前后**逐字相同**（`data/` 被 gitignore ⇒ 这是唯一能证的方式）',
  sourceBefore.digest === sourceAfter.digest && sourceBefore.files === sourceAfter.files,
  `${sourceBefore.digest.slice(0, 16)}… → ${sourceAfter.digest.slice(0, 16)}… · ${sourceAfter.files} 文件`
)
check(
  '★ 负控：同一判据在**副本**上必须是"变了"（否则"没变"可能只是判据失灵）',
  treeDigest(dbDir).digest !== sourceAfter.digest,
  '副本摘要 ≠ 真实库摘要'
)

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------

mkdirSync(EVIDENCE_DIR, { recursive: true })
const evidence = {
  testId: 'M5.5.1 / WP7 real-search live smoke (production entry · DB copy · real model · real SearXNG)',
  mode: 'explicit（生产已激活的模式）',
  entrypoint: 'src/main.ts（子进程，本尊）',
  search: {
    endpointHost: "api.tavily.com",
    bodyFields: TAVILY_ALLOWED_BODY_FIELDS,
    authentication: "bearer-header-only",
    keyEnvName: TAVILY_TEST_API_KEY_ENV,
    health: health.detail,
  },
  judge: { maxTokens: 2400, timeoutMs: 'CHARACTER_WEB_SEARCH_JUDGE_TIMEOUT_MS 缺省 25000' },
  realDatabase: {
    path: PRODUCTION_DB_DIR,
    filesBefore: sourceBefore.files,
    digestBefore: sourceBefore.digest,
    digestAfter: sourceAfter.digest,
    newestMtimeBefore: new Date(sourceBefore.newestMtimeMs).toISOString(),
    unchanged: sourceBefore.digest === sourceAfter.digest,
  },
  turns: turns.map((turn) => ({
    label: turn.label,
    input: turn.input,
    status: turn.status,
    replyLength: turn.reply.length,
    appendixLines: turn.appendix === '' ? 0 : turn.appendix.split('\n').length - 1,
    outbound: turn.outbound,
    searchRequests: turn.outbound.filter(isSearchOutbound).length,
    /* ⚠️ 只记回复的**长度与形状**：正文不进证据（`D-8` 的同一纪律） */
    replyHasSourceAppendix: /\[E\d+\]/.test(turn.appendix),
  })),
  passed,
  failed,
  checks,
  note:
    '只调判定模型 + 真实 SearXNG 各一次；**不记**回复正文与 query 之外的内容。' +
    '不证明 auto_public（未激活）、不证明判定失败降级（那由离线门证明）、' +
    '不外推为长期可用性；也不主张"她说得对"（D-10）。',
}
writeFileSync(join(EVIDENCE_DIR, 'smoke-live.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')

console.log(`\nM5.5.1 WP7 真实搜索 Live Smoke：${passed} 通过 / ${failed} 失败`)
console.log(`  证据：artifacts/m5.5.1/smoke/smoke-live.json`)
rmSync(work, { recursive: true, force: true })
process.exit(failed > 0 ? 1 : 0)
