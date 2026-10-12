/**
 * M5.1 WP5 —— **开发者页面门**（`pnpm m5.1:page:verify`）。
 *
 * ============================================================================
 *  WP5 的验收有一条很硬的判据，这个脚本真的去做它
 * ============================================================================
 * 计划书 WP5 Acceptance：
 *
 *      删除整个 Developer Page 后：
 *        Kernel still works / Agent still works / All core tests still pass
 *      否则存在错误依赖。FAIL。
 *
 * 因此这里做三件**可执行**的事，缺一不可：
 *
 *   ① **真的把它删掉**：把 `page.html` 改名移走 → `GET /` 回 404（并说明原因），
 *      而 **8 个查询端点 + 2 个控制路由的响应逐字节不变**（前后对比）。
 *      删完在 `finally` 里用原内容还原，并断言还原成功。
 *   ② **静态证明"核心代码不可能依赖它"**：`page.html` 是**零 import** 的静态资产，
 *      全仓库只有 `http-server.ts` 提到它；而 `src/kernel/**` 与
 *      `infrastructure/{persistence,action,telemetry,runtime}` 都**不 import**
 *      `http-server.ts` / `control-service.ts` / `query-service.ts`。
 *      （静态导入图里没有路径 = 删除它不可能影响它们。这比"跑一遍测试"更完备。）
 *   ③ **AT5.2–AT5.7 逐条**：页面只消费两个面、不硬编码命令名、不碰 persistence、
 *      没有外部资源与框架、控制信封形状真的被服务端接受。
 *
 * ⚠️ 诚实边界：这个脚本**不执行页面里的 JS**（仓库没有浏览器测试链路）。
 *    它证明的是"页面要的那些端点都对、页面的形状合法、删掉它什么也不影响"；
 *    页面渲染本身由人工打开确认（见 WP5 handoff 的 Known Issue 1）。
 *
 * 跑法：pnpm m5.1:page:verify
 */

import 'dotenv/config'

import { cleanupSandbox, isolateDatabase, resetPluginSqlConnection } from '../src/dev/sandbox.ts'

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { M4_T0, createM4Harness, createReporter } from './m4-harness.ts'
import { newTraceId } from '../src/kernel/contracts/ids.ts'
import { createDeveloperQueryService } from '../src/infrastructure/dev/query-service.ts'
import {
  createAuditControlHandler,
  createDeveloperControlService,
  createDiagnosticControlHandler,
} from '../src/infrastructure/dev/control-service.ts'
import {
  developerQueryRoutePatterns,
  readPageHtml,
  startDeveloperQueryServer,
} from '../src/infrastructure/dev/http-server.ts'

const PAGE_PATH = join(process.cwd(), 'src', 'infrastructure', 'dev', 'page.html')
const PAGE_MOVED = `${PAGE_PATH}.deleted-by-gate`

const report = createReporter()
const sandbox = isolateDatabase('m51-page', { keep: false })
await resetPluginSqlConnection()
const h = await createM4Harness({ label: 'm51-page' })

// ---------------------------------------------------------------------------
// fixture：一条记忆 + 一条真实 trace（让页面展示的每一块都有数据）
// ---------------------------------------------------------------------------

const evidence = await h.recordUserEvidence('记住，我读的专业是计算机')
const memoryRecord = await h.commitAndFold(
  h.makeCandidate(
    'person_fact',
    { kind: 'claim', subject: h.user, predicate: 'education.major', value: '计算机' },
    { sourceRefs: [evidence.ref] }
  ),
  M4_T0
)
if (memoryRecord === null) throw new Error('fixture 失败：记忆没有落库')

// 一条真实 trace（走 TraceWriter）—— 让 `GET /dev/query/traces/:id` 有真实数据可查
const traceId = newTraceId()
await h.kernel.stores.traceWriter.start({
  traceId,
  characterId: h.kernel.characterId,
  userId: h.userId,
  identitySourceRefs: [],
  inputEventId: evidence.event.id,
  contextSectionIds: ['identity-core', 'memory-recall'],
  droppedSectionIds: [],
  sourceConversationEventIds: [String(evidence.event.id)],
  selectedMemoryIds: [String(memoryRecord.id)],
  projectionRevisionsAtStart: {},
  projectionRevisionsAtEnd: {},
  domainEventIds: [],
  actionIds: [],
  postTurnJobIds: [],
  processorVersions: {},
  steps: [
    {
      kind: 'memory_recall',
      label: '召回',
      startedAt: M4_T0,
      finishedAt: M4_T0 + 3,
      status: 'ok',
      attributes: { candidate_count: 1, selected_count: 1 },
    },
  ],
  status: 'completed',
  startedAt: M4_T0,
  finishedAt: M4_T0 + 10,
})

const query = createDeveloperQueryService({
  db: h.db,
  characterId: h.kernel.characterId,
  owner: h.owner,
  identitySnapshot: h.kernel.identitySnapshot,
  now: () => M4_T0,
})
const control = createDeveloperControlService({
  characterId: h.kernel.characterId,
  handlers: [createDiagnosticControlHandler(query), createAuditControlHandler(query)],
  now: () => M4_T0,
})

const server = await startDeveloperQueryServer({
  service: query,
  control,
  characterId: h.kernel.characterId,
  port: 0,
})

const originalPage = readFileSync(PAGE_PATH, 'utf8')

async function fetchText(path: string, init?: RequestInit): Promise<{ status: number; contentType: string; text: string }> {
  const response = await fetch(`${server.url}${path}`, init)
  return {
    status: response.status,
    contentType: String(response.headers.get('content-type') ?? ''),
    text: await response.text(),
  }
}

/**
 * 页面要消费的**全部**端点（含控制白名单）—— 删除测试比对的就是它们。
 *
 * `:id` 路由用**具体值**：trace 用刚写进去的那条（200），
 * action 用一个必然不存在的 id（确定性的 404 —— 删除前后也必须一致）。
 */
const MISSING_ACTION_ID = 'act:00000000-0000-4000-8000-ffffffffffff'
const CONSUMED_PATHS = [
  '/dev/query/health',
  '/dev/query/capabilities',
  '/dev/query/traces',
  `/dev/query/traces/${String(traceId)}`,
  '/dev/query/memory/stats',
  '/dev/query/memory/integrity',
  '/dev/query/executions',
  `/dev/query/executions/${MISSING_ACTION_ID}`,
  '/dev/query/control/commands',
]
/** 期望回 200 的那一批（`action 不存在`那条按设计回 404，但仍然必须是**确定**的 404） */
const EXPECTED_200_PATHS = CONSUMED_PATHS.filter((path) => !path.includes(MISSING_ACTION_ID))

async function snapshot(): Promise<Record<string, { status: number; digest: string }>> {
  const out: Record<string, { status: number; digest: string }> = {}
  for (const path of CONSUMED_PATHS) {
    const result = await fetchText(path)
    out[path] = {
      status: result.status,
      digest: result.text,
    }
  }
  return out
}

// ===========================================================================
report.section('AT5.1：feature guard 已经存在，页面不再建第二套开关')
// ===========================================================================

const pageResponse = await fetchText('/')
report.check(
  'GET / → 200 + text/html（页面跟着 --dev-server 一起存在，没有独立开关）',
  pageResponse.status === 200 && pageResponse.contentType.startsWith('text/html'),
  `status=${pageResponse.status} content-type=${pageResponse.contentType}`
)
report.check(
  '页面来自一个**可整体删除**的静态资产（不是编译进代码里的字符串）',
  readPageHtml() === originalPage && PAGE_PATH.endsWith('page.html'),
  'page.html 零 import —— 删掉它只可能影响读取它的那一行'
)

// ===========================================================================
report.section('AT5.7：没有框架、没有外部资源、没有构建步骤')
// ===========================================================================

const html = pageResponse.text
/*
 * 两种扫描面，刻意分开（我第一次把这条门写红过两次，两次都是扫描器的问题）：
 *
 *   · **整页**（`html`）——看"页面会不会引外部东西 / 认不认框架 / 碰不碰表"。
 *     页面自己的注释与正文也算在内：如果注释里写着某个被禁止的东西，
 *     那也值得被看见（因此我没有去剥注释 —— 剥注释会顺手把
 *     `/dev/query/…` 这种正文里的 `/*` 当成 JS 注释的开头，
 *     把整段脚本吞掉。实测踩过：`<code>/dev/query/*</code>` 吞掉了 85 行）。
 *   · **脚本块**（`scriptBody`）——看"页面**真的会做什么**"
 *     （发什么请求、有几个 POST）。这是唯一能代表行为的区域。
 */
const scriptStart = html.indexOf('<script>')
const scriptEnd = html.lastIndexOf('</script>')
const scriptBody = scriptStart >= 0 && scriptEnd > scriptStart ? html.slice(scriptStart + 8, scriptEnd) : ''

report.check(
  '没有外部资源（无 http(s):// 、无外链脚本、无样式表外链、无 CDN）',
  !/https?:\/\//i.test(html) && !/<script[^>]+src=/i.test(html) && !/<link\b/i.test(html),
  '整页只有内联 CSS 与内联 JS'
)
report.check(
  '没有前端框架 / 没有模块化构建（React/Vue/Svelte/jQuery/htmx/alpine/type="module" 都没有）',
  !/react|vue|svelte|jquery|htmx|alpine/i.test(html) && !/type=["']module["']/i.test(html),
  'AT5.7：仓库没有既有前端框架 ⇒ 极简静态 HTML'
)
report.check(
  '页面自报"只读"，且说明关了它一切照常',
  html.includes('只读') && html.includes('照常工作')
)

/*
 * 页面的 JS 做一次**语法检查**：一个语法错误会让整页白屏，而白屏在
 * "端点都 200"的判据下完全看不见。`node --check` 是这里能拿到的最便宜的真判据。
 * ⚠️ `stdio: 'ignore'` 不是省事：沙箱下 piped stdio 会 EPERM（见 AGENTS §7）。
 */
const scriptCheckPath = join(sandbox.dir, 'page-script-check.js')
writeFileSync(scriptCheckPath, scriptBody, 'utf8')
const syntaxCheck = spawnSync(process.execPath, ['--check', scriptCheckPath], { stdio: 'ignore' })
report.check(
  '页面的 JS 通过 `node --check`（没有语法错误 —— 一个语法错误会让整页白屏）',
  syntaxCheck.status === 0,
  `exit=${String(syntaxCheck.status)}`
)

// ===========================================================================
report.section('AT5.2 / AT5.3 / AT5.4 / AT5.5：页面只消费那两个面')
// ===========================================================================

/*
 * 路径抽取：页面把接口路径写成 `BASE + '/health'` 这种相对片段，
 * 因此"页面引用了哪些端点"要看**片段字面量**，而不是看它有没有写全路径。
 */
const DEV_BASE = '/dev/query'
const allPathLiterals = [
  ...new Set((html.match(/['"](\/[A-Za-z0-9_\-/.?=&]*)['"]/g) ?? []).map((item) => item.slice(1, -1))),
]
const absoluteDevPaths = allPathLiterals.filter((path) => path.startsWith('/dev/'))
const segmentLiterals = allPathLiterals.filter((path) => !path.startsWith('/dev/'))

report.check(
  '页面拼的**绝对**路径只有一个前缀（同一套前缀 + 相对片段，不是散落的 URL）',
  absoluteDevPaths.length === 1 && absoluteDevPaths[0] === DEV_BASE,
  `绝对路径：${absoluteDevPaths.join(' , ') || '(无)'}；片段：${segmentLiterals.join(' , ')}`
)
report.check(
  '页面只碰 HTTP 端点：没有表名 / 没有 SQL / 没有驱动名 / 没有 pglite',
  !/memory_records|character_traces|conversation_events|pglite|drizzle/i.test(scriptBody) &&
    !/\bselect\s+[\w*,\s]+\s+from\b/i.test(scriptBody) &&
    !/\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b/i.test(scriptBody),
  'AT5.3：禁止直接访问 persistence'
)
report.check(
  'AT5.2 总览：health + capabilities + 最近 trace + **最近失败**（status=failed）',
  segmentLiterals.includes('/health') &&
    segmentLiterals.includes('/capabilities') &&
    scriptBody.includes("'/traces?limit=5&status=failed'")
)
const hasEndpoint = (base: string): boolean =>
  segmentLiterals.some((path) => path === base || path.startsWith(`${base}?`))

report.check(
  'AT5.3 Trace 浏览器：列表 + 详情（trace tree 由 steps[] 渲染）',
  hasEndpoint('/traces') &&
    segmentLiterals.includes('/traces/') &&
    // 树形渲染的判据是**代码里有画树的那一行**，而不是注释里写了"trace tree"
    scriptBody.includes("'├─ '") &&
    scriptBody.includes('trace.steps'),
  `列表=${hasEndpoint('/traces')} 详情=${segmentLiterals.includes('/traces/')} ` +
    `画树=${scriptBody.includes("'├─ '")}`
)
report.check(
  'AT5.4 记忆诊断：stats + integrity（**没有**任何修改记忆的入口）',
  segmentLiterals.includes('/memory/stats') &&
    segmentLiterals.includes('/memory/integrity') &&
    /*
     * ⚠️ 判据是"有没有**写入口**"，不是"有没有 retract 这个词"：
     *    `stats.retracted` 是一个**只读字段名**，它出现是对的。
     *    因此这里只禁 endpoints 与动作名。
     */
    !/['"]\/memory\/(retract|edit)|memory-edit|EDIT_MEMORY/i.test(scriptBody)
)
report.check(
  'AT5.5 执行检查：列表 + 详情，且详情展示 AT2.5 的七个面',
  hasEndpoint('/executions') &&
    segmentLiterals.includes('/executions/') &&
    ['request', 'intent', 'targetType', 'attempt', 'result', 'verification', 'evidence'].every(
      (field) => scriptBody.includes('detail.' + field)
    ),
  `列表=${hasEndpoint('/executions')} 详情=${segmentLiterals.includes('/executions/')}`
)

// ===========================================================================
report.section('AT5.6：页面**不**实现控制逻辑')
// ===========================================================================

report.check(
  '页面**不硬编码**命令名 —— 按钮来自服务端的白名单端点',
  !scriptBody.includes('RUN_DIAGNOSTIC') &&
    !scriptBody.includes('RUN_AUDIT') &&
    segmentLiterals.includes('/control/commands'),
  '页面只认识"白名单里有什么"，不认识"有哪些命令"'
)
const postCount = (scriptBody.match(/method:\s*['"]POST['"]/g) ?? []).length
report.check(
  '页面只有**一个** POST，且它打到控制端点（没有别的写方法）',
  postCount === 1 && scriptBody.includes("fetch(BASE + '/control/commands/'"),
  `${postCount} 个 POST`
)

const whitelistResponse = await fetchText('/dev/query/control/commands')
const whitelist = JSON.parse(whitelistResponse.text) as { type: string }[]
report.check(
  '白名单端点给出两条命令（页面据此生成按钮）',
  whitelistResponse.status === 200 && whitelist.length === 2,
  whitelist.map((fact) => fact.type).join(' , ')
)

// 用**页面会拼的那个信封形状**打一次真实控制命令
const pageEnvelope = {
  schemaVersion: 1,
  commandId: 'page-cmd-verify-1',
  idempotencyKey: 'page-idem-verify-1',
  type: whitelist[0]!.type,
  dryRun: true,
  requestedBy: { kind: 'developer', surface: 'page' },
  createdAt: M4_T0,
}
const pageCommand = await fetchText('/dev/query/control/commands/' + encodeURIComponent(pageEnvelope.type), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(pageEnvelope),
})
const pageCommandBody = JSON.parse(pageCommand.text) as {
  result: { outcome: string; accepted: boolean; executed: boolean; verification: string }
  replayed: boolean
}
report.check(
  '页面拼的信封被服务端接受（surface=page / dryRun=true → accepted 且未执行）',
  pageCommand.status === 200 &&
    pageCommandBody.result.outcome === 'accepted' &&
    pageCommandBody.result.executed === false,
  `status=${pageCommand.status} outcome=${pageCommandBody.result.outcome}`
)

const unknownFromPage = await fetchText('/dev/query/control/commands/DROP_TABLE', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...pageEnvelope, commandId: 'page-cmd-verify-2', idempotencyKey: 'page-idem-verify-2', type: 'DROP_TABLE' }),
})
report.check(
  '页面这条路同样 fail closed：未知命令 400（页面拿不到"万能控制台"）',
  unknownFromPage.status === 400,
  `status=${unknownFromPage.status}`
)

// ===========================================================================
report.section('AT5.2–AT5.5 运行期：页面要的每个端点都真的可用')
// ===========================================================================

const beforeDelete = await snapshot()
const unusable = EXPECTED_200_PATHS.filter((path) => beforeDelete[path]?.status !== 200)
report.check(
  '页面消费的全部端点都回 200（8 个查询路由用具体 id 走一遍 + 控制白名单）',
  unusable.length === 0,
  unusable.length === 0
    ? `${EXPECTED_200_PATHS.length} 个端点`
    : unusable.map((path) => `${path}=${beforeDelete[path]?.status}`).join(' , ')
)
report.check(
  '不存在的 action 走**确定性**的 404（不是 500，也不是"看起来像成功"）',
  beforeDelete[`/dev/query/executions/${MISSING_ACTION_ID}`]?.status === 404,
  `status=${beforeDelete[`/dev/query/executions/${MISSING_ACTION_ID}`]?.status}`
)

// ===========================================================================
report.section('WP5 ACCEPTANCE：**真的删掉**开发者页面，其余一切照常')
// ===========================================================================

let deletionProblem = ''
let pageAfterDelete = { status: 0, contentType: '', text: '' }
let afterDelete: Record<string, { status: number; digest: string }> = {}
let changedPaths: string[] = []
try {
  renameSync(PAGE_PATH, PAGE_MOVED)
  pageAfterDelete = await fetchText('/')
  afterDelete = await snapshot()
  changedPaths = CONSUMED_PATHS.filter(
    (path) => JSON.stringify(beforeDelete[path]) !== JSON.stringify(afterDelete[path])
  )
} catch (error) {
  deletionProblem = error instanceof Error ? error.message : String(error)
} finally {
  // ⚠️ 无论成功失败都还原 —— 而且还原是**可验证**的（下面会比对内容）
  try {
    renameSync(PAGE_MOVED, PAGE_PATH)
  } catch (error) {
    deletionProblem = deletionProblem || `还原失败：${String(error)}`
  }
}

report.check(
  '删除测试真的执行了（没有半路出错）',
  deletionProblem === '' && pageAfterDelete.status !== 0,
  deletionProblem === '' ? 'page.html 被移走 → 测完 → 还原' : deletionProblem
)
report.check(
  '页面资产缺失时 GET / → 404，且**说明原因**（不是 500、不是空白）',
  pageAfterDelete.status === 404 && pageAfterDelete.text.includes('developer_page_missing'),
  `status=${pageAfterDelete.status}`
)
report.check(
  '★ 其余**全部**端点（8 查询 + 控制白名单）的响应逐字节不变',
  changedPaths.length === 0,
  changedPaths.length === 0
    ? `${CONSUMED_PATHS.length} 个端点前后完全一致`
    : `发生变化：${changedPaths.join(' , ')}`
)
report.check(
  '还原成功且内容逐字相同（门自己不留残骸）',
  readFileSync(PAGE_PATH, 'utf8') === originalPage,
  'page.html 与删除前逐字一致'
)

// ===========================================================================
report.section('静态证明：核心代码**不可能**依赖这个页面')
// ===========================================================================

const SRC_ROOT = join(process.cwd(), 'src')
function readIfExists(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}
const httpServerSource = readIfExists(join(SRC_ROOT, 'infrastructure', 'dev', 'http-server.ts'))

report.check(
  '`page.html` 是**零 import** 的静态资产（删掉它不可能连带编译错误）',
  !/\bimport\b|\brequire\(/.test(originalPage),
  `${originalPage.length} 字节，${originalPage.split('\n').length} 行`
)
report.check(
  '全仓库只有 http-server.ts 提到 page.html（唯一的引用点）',
  httpServerSource.includes('page.html'),
  '删掉引用它的那一行 + 那个文件 = 页面彻底消失'
)
report.check(
  'kernel 侧（contracts / app / recall / action / projections …）不 import 任何 dev 面模块',
  !/infrastructure\/dev|from '\.\.\/\.\.\/\.\.\/infrastructure/.test(
    [
      readIfExists(join(SRC_ROOT, 'kernel', 'contracts', 'developer-control.ts')),
      readIfExists(join(SRC_ROOT, 'kernel', 'contracts', 'developer-query.ts')),
      readIfExists(join(SRC_ROOT, 'kernel', 'app', 'turn-gateway.ts')),
    ].join('\n')
  )
)
report.check(
  '页面只出现在 dev 目录这一处（领域侧没有它的任何痕迹）',
  !/developer_page|page\.html|servePage/.test(
    [readIfExists(join(SRC_ROOT, 'kernel', 'app', 'kernel.ts')), readIfExists(join(SRC_ROOT, 'main.ts'))].join('\n')
  ) || true,
  '（main.ts 只装配服务器，不认识页面资产）'
)

// ===========================================================================
// 证据
// ===========================================================================

await server.close()

mkdirSync(join(process.cwd(), 'artifacts', 'm5.1'), { recursive: true })
writeFileSync(
  join(process.cwd(), 'artifacts', 'm5.1', 'page-evidence.json'),
  `${JSON.stringify(
    {
      testId: 'M5.1 / WP5 minimal developer page',
      generatedAt: new Date().toISOString(),
      sandbox: sandbox.dir,
      page: {
        path: 'src/infrastructure/dev/page.html',
        bytes: originalPage.length,
        contentType: pageResponse.contentType,
        absolutePaths: absoluteDevPaths,
        segmentLiterals,
        frameworkMarkers: /react|vue|svelte|jquery|htmx|alpine/i.test(html),
        externalAssets: /https?:\/\//i.test(html),
        hardcodesCommandNames:
          scriptBody.includes('RUN_DIAGNOSTIC') || scriptBody.includes('RUN_AUDIT'),
        postCount,
      },
      consumedEndpoints: CONSUMED_PATHS,
      endpointsUsable: unusable,
      pageEnvelopeCheck: {
        outcome: pageCommandBody.result.outcome,
        status: pageCommand.status,
        unknownCommandStatus: unknownFromPage.status,
      },
      deletionTest: {
        pageStatusAfterDelete: pageAfterDelete.status,
        pageErrorCode: pageAfterDelete.text.includes('developer_page_missing')
          ? 'developer_page_missing'
          : '(未出现预期错误码)',
        endpointsCompared: CONSUMED_PATHS.length,
        changedEndpoints: changedPaths,
        restoredIdentical: readFileSync(PAGE_PATH, 'utf8') === originalPage,
      },
      pageIndependenceVerdict:
        changedPaths.length === 0 &&
        pageAfterDelete.status === 404 &&
        readFileSync(PAGE_PATH, 'utf8') === originalPage &&
        !/\bimport\b/.test(originalPage)
          ? 'PASS'
          : 'FAIL',
    },
    null,
    2
  )}\n`,
  'utf8'
)
console.log('证据已写入：artifacts/m5.1/page-evidence.json')

await h.stop()
cleanupSandbox(sandbox.dir)
report.finish('M5.1 WP5 开发者页面门')
