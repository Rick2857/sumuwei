/**
 * 服务器仿真环境 · 一致性对照门（2026-10-20）
 *
 * ============================================================================
 *  它守的是**"仿真到底像不像服务器"**这件事
 * ============================================================================
 *  仿真环境的价值全部建立在"它与服务器同形"这个前提上。前提一旦悄悄漂移
 *  （镜像换了、开关忘了关、路径又变回 Windows 的、模型换回真的了），
 *  仿真就变成"一个能跑起来的 Linux 环境"，不再能回答
 *  "这个东西上服务器会不会炸"。
 *
 *  ⇒ 所以本门**逐项对照** `serversim/server-spec.json`（服务器画像），
 *    任何一项对不上就红。
 *
 * ============================================================================
 *  三类检查
 * ============================================================================
 *  · **形状检查**（宿主机侧）：配置、镜像 digest、端口映射、卷
 *  · **实物检查**（容器内）：Node/Python/pnpm 版本、tsx 加载器、语义模型
 *    资产的 sha256、`.npmrc` 有没有代理、`.env` 权限是不是 600
 *  · **隔离检查**（最要紧的一条）：**本机生产容器有没有被仿真碰过**
 *
 * ============================================================================
 *  ⚠️ 诚实边界
 * ============================================================================
 *  · 本门证明的是**仿真侧**与服务器画像一致。
 *    它**不能**证明服务器现在长什么样（服务器上没有这个门）。
 *  · 资产校验复用的是**产品自己的** `verifyEmbeddingAssets`，
 *    所以"模型资产对不对"用的是与核心装配同一把尺子。
 *  · 隔离检查读的是**本机**生产容器的读数（启动时刻 + 表数 + 挂载来源）。
 *    服务器上的库不在本门的射程内。
 * ============================================================================
 *
 * 用法：pnpm serversim:preflight
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const COMPOSE = join(REPO, 'serversim', 'compose.yml')
const ENV_DIR = join(REPO, 'artifacts', 'serversim', 'local', 'env')
const STATE_DIR = join(REPO, 'artifacts', 'serversim', 'local', 'state')

let checks = 0
let failures = 0
const unverified: string[] = []

function check (id: string, passed: boolean, reading: string): void {
  checks += 1
  if (passed) console.log(`  PASS ${id.padEnd(6)} ${reading}`)
  else { failures += 1; console.log(`  FAIL ${id.padEnd(6)} ${reading}`) }
}

function section (title: string): void {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`)
}

function sh (command: string, args: string[]): string {
  return execFileSync(command, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function docker (args: string[]): string {
  return sh('docker', args)
}

function compose (args: string[]): string {
  return sh('docker', ['compose', '-f', COMPOSE, ...args])
}

function parseEnv (text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    map.set(match[1]!, (match[2] ?? '').trim().replace(/^["']|["']$/g, ''))
  }
  return map
}

interface ServerSpec {
  specVersion: string
  host: { node: { version: string }; python: { series: string } }
  services: {
    postgresql: {
      image: string
      hostPort: number
      database: string
      appUser: string
      schemaVersion: number
      serverSchemaVersionAtAudit?: number
      tablesAtBackup: number
    }
    napcat: { image: string; onebotWsPort: number; webuiPort: number }
  }
  env: {
    serverDisabledSwitches: { mustBeOff: string[]; mustBeAbsent: string[] }
    npmrc: { mustNotBe: string[] }
  }
  assets: { embeddingModels: { path: string; modelId?: string } }
}
const spec = JSON.parse(readFileSync(join(REPO, 'serversim', 'server-spec.json'), 'utf8')) as ServerSpec

// ============================================================================
section('① 形状：编排与配置在位')
// ============================================================================
check('S1', existsSync(COMPOSE), `编排文件在位：serversim/compose.yml`)
check('S2', existsSync(join(ENV_DIR, '.env')) && existsSync(join(ENV_DIR, '.env.qq')) && existsSync(join(ENV_DIR, '.env.wechat')),
  '三份凭据文件已生成（先跑 pnpm serversim:prepare）')

const simEnv = parseEnv(existsSync(join(ENV_DIR, '.env')) ? readFileSync(join(ENV_DIR, '.env'), 'utf8') : '')
const simQq = parseEnv(existsSync(join(ENV_DIR, '.env.qq')) ? readFileSync(join(ENV_DIR, '.env.qq'), 'utf8') : '')

check('S3', simEnv.get('SERVERSIM_MARKER') === 'lg-serversim@2026-10-20',
  `仿真标记在位（SERVERSIM_MARKER=${simEnv.get('SERVERSIM_MARKER') ?? '(无)'}）`)

// --- PC 专属开关必须已关 ---------------------------------------------------
const stillOn = spec.env.serverDisabledSwitches.mustBeOff.filter(key => (simEnv.get(key) ?? 'false').toLowerCase() === 'true')
check('S4', stillOn.length === 0,
  stillOn.length === 0
    ? `${spec.env.serverDisabledSwitches.mustBeOff.length} 个 PC 专属开关全部已关`
    : `这些开关还是 true：${stillOn.join(', ')}`)

const stillPresent = spec.env.serverDisabledSwitches.mustBeAbsent.filter(key => simEnv.has(key))
check('S5', stillPresent.length === 0,
  stillPresent.length === 0
    ? 'Windows 绝对路径类键已全部删除'
    : `这些键还在：${stillPresent.join(', ')}`)

// --- 不得残留 Windows 路径 -------------------------------------------------
const envText = existsSync(join(ENV_DIR, '.env')) ? readFileSync(join(ENV_DIR, '.env'), 'utf8') : ''
/*
 * ⚠️ 判据要认的是**盘符路径**（`C:\…` / `C:/…`），不是任意 `字母:/`。
 *    第一版写成 `/[A-Za-z]:[\\/]/` ⇒ 把 `http://127.0.0.1:18080/v1` 里的 `p:/`
 *    当成了盘符（实测误报，2026-10-20）。
 *    ⇒ 加上"盘符前面不能是字母"的前瞻断言。
 */
const windowsPaths = envText.split(/\r?\n/)
  .filter(line => !line.trimStart().startsWith('#'))
  .filter(line => /(?<![A-Za-z])[A-Za-z]:[\\/]/.test(line))
check('S6', windowsPaths.length === 0,
  windowsPaths.length === 0
    ? '配置里没有 Windows 绝对路径'
    : `仍有 ${windowsPaths.length} 行含 Windows 路径（例：${(windowsPaths[0] ?? '').slice(0, 60)}）`)

// --- 库身份：与生产**同形**（这是要仿真的东西）------------------------------
/*
 * ⚠️ 口径（2026-10-20 修正）：仿真的**库名与角色名与生产逐字相同**
 *    （sumuwei / lg_migrate）—— 这正是要仿真的形状。
 *    ⇒ 库身份核对（LG_PG_EXPECT_*）在仿真里**与生产同形，因此不提供额外保护**。
 *    真正挡住"把仿真配置误指到生产库"的是另外两条：
 *      ① **口令**：仿真用自己的一组本地口令；
 *      ② **实例隔离**：独立容器 + 独立卷 + 独立端口。
 *    ⇒ 下面核的是这两条，不是"角色名必须不一样"。
 */
const postgresUrl = simEnv.get('POSTGRES_URL') ?? ''
const postgresPassword = postgresUrl.split('//')[1]?.split('@')[0]?.split(':')[1] ?? ''
check('S7', postgresPassword.length > 0 && postgresPassword.endsWith('_local_only'),
  `仿真库口令是**本地专用**的（不以生产口令为准）`)
check('S8', simEnv.get('LG_PG_EXPECT_DATABASE') === spec.services.postgresql.database
  && simEnv.get('LG_PG_EXPECT_USER') === spec.services.postgresql.appUser,
  `库身份期望 = ${simEnv.get('LG_PG_EXPECT_DATABASE') ?? '?'} / ${simEnv.get('LG_PG_EXPECT_USER') ?? '?'}（与生产同形）`)

// --- 不得带真模型端点 ------------------------------------------------------
const baseUrl = simEnv.get('OPENAI_BASE_URL') ?? ''
check('S9', baseUrl.startsWith('http://127.0.0.1:18080') || baseUrl.startsWith('https://'),
  `模型端点 = ${baseUrl}（offline 档指向仿真假端点；live 档指向测试端点）`)
check('S10', (simEnv.get('OPENAI_API_KEY') ?? '').startsWith('serversim-local') || baseUrl.startsWith('https://'),
  '离线档的 API Key 是仿真假值，不是生产 key')

// --- QQ 入口口径 -----------------------------------------------------------
check('S11', simQq.get('QQ_ONEBOT_WS_URL') === 'ws://127.0.0.1:6701/',
  `OneBot 地址 = ${simQq.get('QQ_ONEBOT_WS_URL') ?? '?'}（与服务器同址）`)
check('S12', (simQq.get('QQ_ONEBOT_ACCESS_TOKEN') ?? '').length >= 24,
  'OneBot 令牌长度合规（≥24）')

// ============================================================================
section('② 实物：容器与容器内的运行时')
// ============================================================================
let containers: Array<{ name: string; state: string; status: string; image: string }> = []
try {
  const raw = docker(['ps', '-a', '--format', '{{.Names}}\t{{.State}}\t{{.Status}}\t{{.Image}}'])
  containers = raw.split(/\r?\n/).filter(Boolean).map(line => {
    const [name, state, status, image] = line.split('\t')
    return { name: name ?? '', state: state ?? '', status: status ?? '', image: image ?? '' }
  })
} catch (error) {
  unverified.push(`读不到容器列表：${(error as Error).message}`)
}
const expected = ['lg-serversim-host', 'lg-serversim-postgresql', 'lg-serversim-onebot', 'lg-serversim-wechat', 'lg-serversim-model']
const missing = expected.filter(name => !containers.some(c => c.name === name))
check('R1', missing.length === 0,
  missing.length === 0 ? `五个仿真容器都在（${expected.length}/5）` : `缺容器：${missing.join(', ')}`)
const notRunning = expected.filter(name => containers.find(c => c.name === name)?.state !== 'running')
check('R2', notRunning.length === 0,
  notRunning.length === 0 ? '五个仿真容器都在 running' : `没在跑：${notRunning.join(', ')}`)

const pgImage = containers.find(c => c.name === 'lg-serversim-postgresql')?.image ?? ''
check('R3', pgImage.startsWith('pgvector/pgvector') || pgImage.includes('ac08538c6f8b'),
  `PostgreSQL 镜像 = ${pgImage || '(读不到)'}（服务器 digest 前缀 ac08538c6f8b）`)

// --- 容器内探针 ------------------------------------------------------------
function probe (script: string): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const text = compose(['exec', '-T', 'simhost', 'bash', '-lc', script])
    for (const line of text.split(/\r?\n/)) {
      const at = line.indexOf('=')
      if (at <= 0) continue
      out.set(line.slice(0, at).trim(), line.slice(at + 1).trim())
    }
  } catch (error) {
    unverified.push(`容器内探针失败：${(error as Error).message.slice(0, 160)}`)
  }
  return out
}

const p = probe(`
set +e
echo "node=$(node -v 2>&1)"
echo "pnpm=$(pnpm -v 2>&1)"
echo "python312=$(python3.12 -V 2>&1 | awk '{print $2}')"
echo "tsx_loader=$([ -f node_modules/tsx/dist/loader.mjs ] && echo present || echo MISSING)"
echo "npmrc_proxy_lines=$(grep -cE '^[[:space:]]*(https-)?proxy[[:space:]]*=' .npmrc 2>/dev/null || echo 0)"
echo "npmrc_insecure=$(grep -cE '^[[:space:]]*strict-ssl[[:space:]]*=' .npmrc 2>/dev/null || echo 0)"
echo "env_mode=$(stat -c %a .env 2>/dev/null || echo MISSING)"
echo "envqq_mode=$(stat -c %a .env.qq 2>/dev/null || echo MISSING)"
echo "env_marker=$(grep -c '^SERVERSIM_MARKER=' .env 2>/dev/null || echo 0)"
echo "transformers=$(node --import ./node_modules/tsx/dist/loader.mjs -e "import('@huggingface/transformers').then(m=>console.log(m.env?.version||'resolvable')).catch(()=>console.log('MISSING'))" 2>/dev/null | tail -1)"
echo "assets=$(node --import ./node_modules/tsx/dist/loader.mjs -e "import('./src/infrastructure/semantic/embedding-manifest.ts').then(async mod=>{const m=mod.loadEmbeddingManifest('evals/m9.5/embedding-manifest.json');const v=mod.verifyEmbeddingAssets('artifacts/m9.5/local/embedding-lab/models/'+m.modelId,m,{hash:true});console.log(JSON.stringify(v))}).catch(e=>console.log(JSON.stringify({ok:false,error:String(e).slice(0,120)})))" 2>/dev/null | tail -1)"
echo "heartbeat_age=$([ -f /opt/serversim/state/heartbeat.json ] && echo $(( $(date +%s) - $(stat -c %Y /opt/serversim/state/heartbeat.json) )) || echo MISSING)"
`)

check('R4', p.get('node') === `v${spec.host.node.version}`,
  `容器内 Node = ${p.get('node') ?? '?'}（服务器口径 v${spec.host.node.version}）`)
check('R5', (p.get('python312') ?? '').startsWith('3.12'),
  `容器内 Python = ${p.get('python312') ?? '?'}（服务器口径 3.12）`)
check('R6', p.get('tsx_loader') === 'present',
  'tsx 加载器在位（node_modules/tsx/dist/loader.mjs）—— 10-17 之后的核心启动方式依赖它')
check('R7', p.get('npmrc_proxy_lines') === '0' && p.get('npmrc_insecure') === '0',
  `.npmrc 无代理、无 strict-ssl=false（服务器上这两样都不该有）`)
check('R8', p.get('env_mode') === '600' && p.get('envqq_mode') === '600',
  `.env=${p.get('env_mode') ?? '?'} .env.qq=${p.get('envqq_mode') ?? '?'}（服务器口径 600）`)
check('R9', p.get('env_marker') === '1', '容器内 .env 带仿真标记')
check('R10', p.get('transformers') !== 'MISSING' && (p.get('transformers') ?? '').length > 0,
  `语义召回运行时可解析：@huggingface/transformers ${p.get('transformers') ?? 'MISSING'}`)

let assets: { ok?: boolean; verified?: number; missing?: string[] } = {}
try { assets = JSON.parse(p.get('assets') ?? '{}') as typeof assets } catch { assets = {} }
check('R11', assets.ok === true && (assets.verified ?? 0) > 0,
  `语义模型资产校验：ok=${String(assets.ok)} verified=${String(assets.verified ?? 0)}（用产品自己的 verifyEmbeddingAssets）`)

const hb = p.get('heartbeat_age') ?? 'MISSING'
check('R12', hb !== 'MISSING' && Number(hb) < 30,
  `supervisor 心跳 ${hb}s 前（判据：supervisor 活着且子进程在跑）`)

// --- PG 版本与 schema ------------------------------------------------------
let pgVersion = '读不到'
let pgvector = '读不到'
let tables = -1
let schemaVersion = -1
/*
 * ⚠️ psql 在 **pg 容器内**执行：它用容器自己的缺省端口 **5432**
 *    （"宿主机 55432" 那个地址由仿真主机里的环回转发器提供）。
 * ⚠️ 用**应用账号**（lg_migrate）而不是超级用户探 —— 免得"超级用户能连、
 *    应用账号连不上"这类问题溜过去。TCP 连接需要口令 ⇒ 走 PGPASSWORD。
 */
const PSQL = ['exec', '-T', '-e', 'PGPASSWORD=lg_migrate_local_only', 'pg', 'psql',
  '-h', '127.0.0.1', '-p', '5432', '-U', 'lg_migrate', '-d', 'sumuwei', '-tAc']
try {
  pgVersion = compose([...PSQL, 'show server_version']).trim()
  pgvector = compose([...PSQL, "select extversion from pg_extension where extname='vector'"]).trim()
  tables = Number(compose([...PSQL, "select count(*) from information_schema.tables where table_schema='public'"]).trim())
  schemaVersion = Number(compose([...PSQL, 'select coalesce(max(version),0) from character_schema_migrations']).trim())
} catch (error) {
  unverified.push(`PG 读数失败：${(error as Error).message.slice(0, 160)}`)
}
check('R13', pgVersion.startsWith('17.'),
  `PostgreSQL = ${pgVersion}（服务器口径 17.11）`)
check('R14', pgvector === '0.8.7',
  `pgvector = ${pgvector}（服务器口径 0.8.7）`)
check('R15', schemaVersion === spec.services.postgresql.schemaVersion,
  `schema 版本 = v${String(schemaVersion)}（仓库当前口径 v${String(spec.services.postgresql.schemaVersion)}）`)

/*
 * ⚠️ **漂移告警**（不是仿真的失败，是**部署**的发现）：
 *    服务器 10-18 的读数是 schema v22，而仓库现在是 v23
 *    （新增 #23 lg-runtime-compatibility-tables）。
 *    ⇒ 用当前代码部署到服务器，核心会因**迁移闸**拒绝启动
 *      （src/db/index.ts：有待应用迁移且目标是生产库 ⇒ 拒绝）。
 *    ⇒ 部署前必须先在服务器上跑一次 `pnpm migrate:apply` 并读回版本。
 */
if (spec.services.postgresql.serverSchemaVersionAtAudit !== undefined
  && spec.services.postgresql.serverSchemaVersionAtAudit !== spec.services.postgresql.schemaVersion) {
  console.log(`  ⚠️ 漂移  服务器 10-18 读数 = v${String(spec.services.postgresql.serverSchemaVersionAtAudit)}，仓库当前 = v${String(spec.services.postgresql.schemaVersion)}`)
  console.log('     ⇒ 部署前必须先在**服务器**上跑 `pnpm migrate:apply` 并读回版本；')
  console.log('       否则核心会因迁移闸拒绝启动（src/db/index.ts）。这一条与仿真本身无关。')
}

// ============================================================================
section('③ 隔离：本机生产容器有没有被仿真碰过')
// ============================================================================
const PROD_CONTAINER = 'lg-postgresql-production'
/*
 * ⚠️ 判据用 **`Created`**（容器被**创建**的时刻），**不是 `StartedAt`**。
 *
 *    原因（2026-10-21 实测）：`StartedAt` 会因为 **Docker Desktop 重启**而变化 ——
 *    那台生产容器会跟着 daemon 一起重启，而那与仿真**毫无关系**。
 *    第一版拿 `StartedAt` 当判据 ⇒ 每次重启 Docker 都会假报
 *    "仿真重启过生产容器"（实测撞到，已改）。
 *
 *    真正要守的性质是：**仿真没有创建/重建/替换过那个容器**。
 *    `Created` 只在容器被 `create`（含 `compose up` 重建）时变 ⇒ 正好对上。
 *    `RestartCount` 也一起记（它记的是重启策略触发的重启，不是 daemon 重启）。
 */
function prodReading (): { created: string; restarts: number; tables: number } | undefined {
  try {
    const created = docker(['inspect', '-f', '{{.Created}}', PROD_CONTAINER]).trim()
    const restarts = Number(docker(['inspect', '-f', '{{.RestartCount}}', PROD_CONTAINER]).trim())
    const tables = Number(docker(['exec', PROD_CONTAINER, 'psql', '-U', 'lg_migrate', '-d', 'sumuwei', '-tAc',
      "select count(*) from information_schema.tables where table_schema='public'"]).trim())
    return { created, restarts, tables }
  } catch { return undefined }
}
const prod = prodReading()
mkdirSync(STATE_DIR, { recursive: true })
const baselinePath = join(STATE_DIR, 'production-baseline.json')
if (prod !== undefined) {
  /*
   * 基线里没有 `created` ⇒ 是旧格式（用 `startedAt` 那版）⇒ **重记一次**。
   * ⚠️ 这是"判据口径变了"，不是"绕过失败"：旧的 `startedAt` 判据本身是错的，
   *    留着它只会继续假报。
   */
  const old = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as { created?: string; tables?: number })
    : undefined
  if (old === undefined || typeof old.created !== 'string') {
    writeFileSync(baselinePath, JSON.stringify({ ...prod, recordedAt: new Date().toISOString() }, null, 2), 'utf8')
    check('P1', true, `已记录本机生产容器基线：Created=${prod.created} restarts=${String(prod.restarts)} public 表数=${String(prod.tables)}`)
  } else {
    const baseline = old as { created: string; restarts?: number; tables: number }
    check('P1', prod.created === baseline.created,
      prod.created === baseline.created
        ? `生产容器 Created 未变（${prod.created}）—— 仿真没有创建/重建过它`
        : `生产容器被**重建**过：${baseline.created} → ${prod.created}`)
    check('P2', prod.tables === baseline.tables,
      `生产容器 public 表数未变（${String(baseline.tables)} → ${String(prod.tables)}）—— 仿真没有动过生产库`)
    if (typeof baseline.restarts === 'number') {
      check('P4', prod.restarts === baseline.restarts,
        `生产容器 RestartCount 未变（${String(prod.restarts)}）—— 仿真没有重启过它`)
    }
  }
} else {
  unverified.push('本机生产容器不存在或读不到 —— 隔离检查这一段没有生效')
}

// --- 物理卷不得共享（10-14 事故的根因）------------------------------------
try {
  const prodMounts = docker(['inspect', '-f', '{{range .Mounts}}{{.Source}}|{{.Name}}{{println}}{{end}}', PROD_CONTAINER])
  const simVolume = docker(['inspect', '-f', '{{range .Mounts}}{{.Name}}{{println}}{{end}}', 'lg-serversim-postgresql'])
  const shared = prodMounts.split(/\r?\n/).map(l => l.split('|')[1] ?? '').filter(Boolean)
    .filter(name => simVolume.split(/\r?\n/).map(s => s.trim()).includes(name))
  check('P3', shared.length === 0,
    shared.length === 0
      ? `仿真 PG 的卷与生产卷**没有共享**（仿真卷：${simVolume.trim() || '(无)'}）`
      : `⚠️ 仿真与生产共享了卷：${shared.join(', ')}`)
} catch (error) {
  unverified.push(`卷隔离检查失败：${(error as Error).message.slice(0, 160)}`)
}

// ============================================================================
section('④ 隔离测试库实例（数据库门的底座 · 2026-10-21 新增）')
// ============================================================================
/*
 * 这一组核的是**门执行底座**：2026-10-21 起，数据库门在**仿真内**执行，
 * 库住在 compose 服务 `pgtest`（另一个实例、另一个卷）。
 *
 * ⚠️ 它与核心在用的 `pg` 实例**必须完全分开** ——
 *    `pg` 里装着**真实数据副本**（`sumuwei`）；
 *    `pgtest` 里**从来没有**那份数据 ⇒ "误连到真实副本"在结构上不可能。
 *    这几条就是那个"结构上不可能"的**机器判据**。
 */
const PGTEST_CONTAINER = 'lg-serversim-pgtest'
const pgtestContainer = containers.find(c => c.name === PGTEST_CONTAINER)
check('T1', pgtestContainer !== undefined && pgtestContainer.state === 'running',
  pgtestContainer === undefined
    ? '隔离测试库容器 lg-serversim-pgtest 不存在（先跑 pnpm serversim:up）'
    : `隔离测试库容器在 running（镜像 ${pgtestContainer.image}）`)

check('T2', pgtestContainer !== undefined && pgtestContainer.image === pgImage,
  `隔离测试库与核心库**同一套引擎镜像**（${pgtestContainer?.image || '(读不到)'}）`)

/* --- 卷三方不共享 -------------------------------------------------------- */
try {
  const prodVolumes = docker(['inspect', '-f', '{{range .Mounts}}{{.Name}}{{println}}{{end}}', PROD_CONTAINER])
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const simVolumes = docker(['inspect', '-f', '{{range .Mounts}}{{.Name}}{{println}}{{end}}', 'lg-serversim-postgresql'])
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const testVolumes = docker(['inspect', '-f', '{{range .Mounts}}{{.Name}}{{println}}{{end}}', PGTEST_CONTAINER])
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const overlap = [
    ...testVolumes.filter(v => prodVolumes.includes(v)).map(v => `生产:${v}`),
    ...testVolumes.filter(v => simVolumes.includes(v)).map(v => `核心:${v}`),
  ]
  check('T3', overlap.length === 0,
    overlap.length === 0
      ? `测试库卷与生产卷、核心库卷**三者互不共享**（测试卷：${testVolumes.join(',') || '(无)'}）`
      : `⚠️ 测试库卷与别处共享：${overlap.join(', ')}`)
} catch (error) {
  unverified.push(`测试库卷隔离检查失败：${(error as Error).message.slice(0, 160)}`)
}

/* --- 测试实例里没有 sumuwei（结构性隔离的核心判据）------------------------ */
const PGTEST_PSQL = ['exec', '-T', '-e', 'PGPASSWORD=lg_test_bootstrap_local_only', 'pgtest', 'psql',
  '-h', '127.0.0.1', '-p', '5432', '-U', 'lg_test_bootstrap', '-d', 'lg_test_bootstrap', '-tAc']
try {
  const databases = compose([...PGTEST_PSQL, "select datname from pg_database where datname not in ('postgres','template0','template1')"])
    .split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  check('T4', !databases.includes('sumuwei'),
    databases.includes('sumuwei')
      ? `⚠️ 隔离测试实例里出现了 sumuwei —— 那不是隔离测试实例（库：${databases.join(', ')}）`
      : `隔离测试实例里**没有** sumuwei（现存库：${databases.join(', ') || '(无)'}）`)
  const bootstrapTables = Number(compose([...PGTEST_PSQL,
    "select count(*) from information_schema.tables where table_schema='public' and table_name <> 'character_schema_migrations'"]).trim())
  check('T5', bootstrapTables === 0,
    `隔离测试实例的引导库是空的（public 表数 = ${String(bootstrapTables)}，不含迁移表）`)
} catch (error) {
  unverified.push(`隔离测试实例读数失败：${(error as Error).message.slice(0, 160)}`)
}

/* --- simhost 能不能按服务名连到它 ---------------------------------------- */
const reach = probe('node -e "const n=require(\'node:net\');const s=n.connect(5432,\'pgtest\');s.on(\'connect\',()=>{s.destroy();console.log(\'pgtest_reachable=1\');process.exit(0)});s.on(\'error\',(e)=>{console.log(\'pgtest_reachable=0\');process.exit(0)});setTimeout(()=>{s.destroy();console.log(\'pgtest_reachable=0\');process.exit(0)},2000)"')
check('T6', reach.get('pgtest_reachable') === '1',
  `simhost 能按 compose 服务名连到隔离测试实例（读数 ${reach.get('pgtest_reachable') ?? '(无)'}）`)

// ============================================================================
section('⑤ 仿真对外服务可用性')
// ============================================================================
async function httpGet (url: string): Promise<{ status: number; body: string }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return { status: response.status, body: '' }
  } catch (error) {
    return { status: 0, body: (error as Error).message }
  }
}
const onebotHealth = await httpGet('http://127.0.0.1:6102/health')
check('A1', onebotHealth.status === 200, `假 OneBot 控制面 HTTP ${onebotHealth.status}（127.0.0.1:6102）`)
const modelHealth = await httpGet('http://127.0.0.1:18080/health')
check('A2', modelHealth.status === 200, `假模型端点 HTTP ${modelHealth.status}（127.0.0.1:18080）`)
const wechatHealth = await httpGet('http://127.0.0.1:16175/sim/health')
check('A3', wechatHealth.status === 200, `假微信桥 HTTP ${wechatHealth.status}（127.0.0.1:16175）`)
const wechatUnauthorized = await fetch('http://127.0.0.1:16175/api/status/auth', { signal: AbortSignal.timeout(5000) })
  .then(r => r.status).catch(() => 0)
check('A4', wechatUnauthorized === 401, `微信桥无鉴权访问返回 ${wechatUnauthorized}（服务器口径 401）`)

// ============================================================================
console.log(`\n${'='.repeat(74)}`)
console.log(`  检查 ${checks} 项 · 通过 ${checks - failures} · 失败 ${failures} · 未验证 ${unverified.length}`)
if (unverified.length > 0) {
  console.log('\n  未验证（**不是通过**）：')
  for (const item of unverified) console.log(`    · ${item}`)
}
console.log('='.repeat(74))
process.exit(failures === 0 ? 0 : 1)
