/**
 * 服务器仿真环境 · 生成服务器形状的凭据文件（2026-10-20）
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 *  读本机真实的 `.env`，按 `serversim/server-spec.json` 里的**服务器口径**
 *  改写成一份"服务器形状"的 `.env`，连同 `.env.qq` / `.env.wechat` 一起写进
 *  `artifacts/serversim/local/env/`（只读挂载进仿真容器）。
 *
 * ============================================================================
 *  为什么要"改写"而不是"直接抄一份"
 * ============================================================================
 *  服务器与本机的差异**就是**部署事故的主要来源（10-15 审计 §3.3 列了 14 项，
 *  10-16 复核后涨到 23 项）。仿真必须**在形状上**就是服务器的：
 *
 *  · PC 专属能力（浏览器 sidecar / 桌面控制 / 本地文件 / 资料库 / 语音）→ 关
 *  · 两条 Windows 绝对路径 → 删
 *  · 自动记忆的 Python → Linux venv 路径
 *  · 数据库 → 仿真自己的 PG（**独立角色**，见下）
 *  · 模型 → 仿真自己的假端点（默认）或测试端点（`--live`）
 *
 * ============================================================================
 *  密钥纪律（三条，逐条都有出处）
 * ============================================================================
 *  1. **真实密钥不进仿真**：`OPENAI_API_KEY` 换成假值；生产库口令不出现。
 *     唯一例外是 `--live`：那时只取 `.env.test` 里的**测试端点**——
 *     仓库的既有纪律是"真实聊天用原 key、执行测试用测试端点"
 *     （scripts/run-with-test-model.ts 的 G1/G2 失败关闭）。
 *  2. **仿真库用独立角色**：`lg_simu`（生产是 `lg_migrate`）。
 *     这样即便有人把生产库地址填进仿真，核心的"库身份核对"
 *     （database-backend.ts 的 `verifyDatabaseIdentityReading`，
 *     **在任何迁移与业务写入之前**执行）也会直接拒绝。
 *  3. **QQ / 微信令牌每次重生成**：仿真专用，不复用生产令牌。
 *
 * ============================================================================
 *  用法
 * ============================================================================
 *  ```bash
 *  pnpm serversim:prepare            # 离线档（假模型端点）
 *  pnpm serversim:prepare -- --live  # 接测试端点（会用到 .env.test）
 *  ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const OUT_DIR = join(REPO, 'artifacts', 'serversim', 'local', 'env')
const SPEC = join(REPO, 'serversim', 'server-spec.json')

const LIVE = process.argv.includes('--live')

// ---------------------------------------------------------------------------
//  服务器画像（从 server-spec.json 读，不在这里复述第二份）
// ---------------------------------------------------------------------------
interface ServerSpec {
  env: {
    serverDisabledSwitches: { mustBeOff: string[]; mustBeAbsent: string[] }
    linuxPaths: Record<string, string>
  }
}
const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as ServerSpec

// ---------------------------------------------------------------------------
//  .env 解析（保留原顺序与注释无关性：只取键值，输出时重排）
// ---------------------------------------------------------------------------
function parseEnv (text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (match === null) continue
    let value = (match[2] ?? '').trim()
    // 去掉行尾注释（仅当引号外出现 # 且前面有空格时才当注释，避免砍掉 token 里的 #）
    if (!/^["']/.test(value)) {
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    map.set(match[1]!, value)
  }
  return map
}

const sourceEnv = parseEnv(readFileSync(join(REPO, '.env'), 'utf8'))

function readTestEnv (): Map<string, string> {
  const path = join(REPO, '.env.test')
  if (!existsSync(path)) return new Map()
  return parseEnv(readFileSync(path, 'utf8'))
}

// ---------------------------------------------------------------------------
//  仿真常量
// ---------------------------------------------------------------------------
const SIM = {
  /*
   * ⚠️ 库名与角色名与**生产逐字相同**（这是要仿真的东西）。
   *    挡住"把仿真配置误指到生产库"的是**口令**与**实例隔离**，
   *    不是身份核对 —— 身份核对在仿真里与生产同形，因此不提供额外保护。
   *    （这条如实记在 docs/post-lv2/Server-Simulator-2026-10-20.md。）
   */
  dbUser: 'lg_migrate',
  dbPassword: 'lg_migrate_local_only',
  dbName: 'sumuwei',
  dbPort: 55432,
  qqBotId: '9000000001',
  qqOwnerId: '9000000002',
  qqGroupId: '9900000001',
  wechatBotId: 'sim_wechat_bot',
  wechatOwnerId: 'sim_wechat_owner',
  wechatGroupId: '9000000003@chatroom',
  modelBaseUrl: 'http://127.0.0.1:18080/v1',
  modelApiKey: 'serversim-local-not-a-real-key',
}
const token = (): string => randomBytes(24).toString('base64url')

// ---------------------------------------------------------------------------
//  构造 .env
// ---------------------------------------------------------------------------
const env = new Map<string, string>(sourceEnv)

// 1) PC 专属能力：关（server-spec.env.serverDisabledSwitches.mustBeOff）
for (const key of spec.env.serverDisabledSwitches.mustBeOff) env.set(key, 'false')
// 2) Windows 绝对路径：删
for (const key of spec.env.serverDisabledSwitches.mustBeAbsent) env.delete(key)
// 3) Linux 路径：写
for (const [key, value] of Object.entries(spec.env.linuxPaths)) {
  env.set(key, value.replace('<projectRoot>', '/opt/project-lg'))
}
env.set('PROJECT_LG_RAPIDOCR_MODEL_DIR', '/opt/project-lg/artifacts/post-lv2/local/ocr-runtime/models')
env.set('PROJECT_LG_OCR_BACKEND', 'rapidocr')
env.set('PGLITE_SNAPSHOT_DIR', './data/snapshots/serversim')
env.set('PGLITE_DATA_DIR', './data/pglite')

// 4) 数据库：仿真自己的 PG，**独立角色**
env.set('CHARACTER_DB_BACKEND', 'postgres')
env.set('POSTGRES_URL', `postgresql://${SIM.dbUser}:${SIM.dbPassword}@127.0.0.1:${String(SIM.dbPort)}/${SIM.dbName}`)
env.set('LG_PG_EXPECT_DATABASE', SIM.dbName)
env.set('LG_PG_EXPECT_USER', SIM.dbUser)
env.set('LG_PG_CONTAINER', 'lg-serversim-postgresql')

// 5) 模型：默认假端点；--live 用 .env.test 的测试端点
const testEnv = LIVE ? readTestEnv() : new Map<string, string>()
if (LIVE) {
  const key = testEnv.get('OPENAI_API_KEY') ?? ''
  const base = testEnv.get('OPENAI_BASE_URL') ?? ''
  if (key === '' || base === '') {
    console.error('❌ --live 需要 .env.test 里的 OPENAI_API_KEY 与 OPENAI_BASE_URL。')
    console.error('   **不会**回落到 .env 的生产 key（那会把仿真跑到真实额度上）。')
    process.exit(2)
  }
  env.set('OPENAI_API_KEY', key)
  env.set('OPENAI_BASE_URL', base)
  env.set('OPENAI_LARGE_MODEL', testEnv.get('OPENAI_LARGE_MODEL') ?? env.get('OPENAI_LARGE_MODEL') ?? '')
  env.set('OPENAI_SMALL_MODEL', testEnv.get('OPENAI_SMALL_MODEL') ?? env.get('OPENAI_SMALL_MODEL') ?? '')
} else {
  env.set('OPENAI_API_KEY', SIM.modelApiKey)
  env.set('OPENAI_BASE_URL', SIM.modelBaseUrl)
  env.set('OPENAI_EMBEDDING_API_KEY', '')
  env.set('OPENAI_EMBEDDING_URL', '')
}

// 6) 仿真标记（让 preflight 能认出"这是仿真文件"，并挡住误用）
env.set('SERVERSIM_MARKER', 'lg-serversim@2026-10-20')
env.set('TZ', 'Asia/Shanghai')

// 7) 联网搜索：**关掉**（这是一条**有理由的偏离**，不是偷懒）
//
//    ⚠️ 产品里有一条硬闸：`native_search_requires_official_deepseek_route`
//    —— 原生搜索（ADR-141 之后）**要求官方 DeepSeek 路线**。
//    仿真接的是假端点（--live 档接的是测试端点）⇒ 两者都不是官方路线
//    ⇒ 核心会在启动时**直接拒绝**（实测 2026-10-20：核心退出码 1）。
//
//    ⇒ 所以仿真的联网搜索只能是关的。
//    ⚠️ 顺带一条**发现**：10-15 审计 §3.3 与 10-16 §3.2 都写着
//    "联网搜索 → 纯网络 → **可留**"。在 ADR-141 之后这句**已经过时**：
//    端点不是官方路线时，核心根本起不来。
//    （服务器端点确实是 api.deepseek.com ⇒ 那里没问题；过时的是那份审计文本。）
env.set('CHARACTER_WEB_SEARCH_ENABLED', 'false')

// ---------------------------------------------------------------------------
//  写出
// ---------------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true })

const header = [
  '# ============================================================================',
  '#  服务器仿真环境 · 自动生成的凭据文件（2026-10-20）',
  '# ============================================================================',
  '#  ⚠️ 这份文件是**派生产物**，不是生产配置。请勿手工编辑 —— 改 `scripts/serversim/prepare-env.ts`。',
  '#  ⚠️ 里面**没有真实密钥**：模型走仿真假端点，数据库口令是仿真专用的。',
  `#  口径来源：serversim/server-spec.json（服务器画像）`,
  `#  模式：${LIVE ? 'live（接 .env.test 的测试端点）' : 'offline（仿真假模型端点）'}`,
  '# ============================================================================',
  '',
].join('\n')

const body = [...env.entries()].map(([key, value]) => `${key}=${value}`).join('\n')
writeFileSync(join(OUT_DIR, '.env'), `${header}${body}\n`, 'utf8')

// ---------------------------------------------------------------------------
//  .env.qq（服务器口径：OneBot WS 在 127.0.0.1:6701，令牌 ≥24 个安全字符）
// ---------------------------------------------------------------------------
/**
 * 令牌**保持稳定**：已存在就复用。
 * ⚠️ 原因（实测 2026-10-20）：假 OneBot 容器在**创建时**读 env_file；
 *    如果每次 prepare 都重新生成令牌，容器里的旧令牌与仿真主机上的新令牌
 *    就对不上 ⇒ 表现为 `ws_rejected_bad_token` 反复重连。
 */
function stableToken (file: string, key: string): string {
  const path = join(OUT_DIR, file)
  if (existsSync(path)) {
    const existing = parseEnv(readFileSync(path, 'utf8')).get(key)
    if (existing !== undefined && existing.length >= 24) return existing
  }
  return token()
}

const qq = [
  '# 服务器仿真环境 · 仿真的 QQ 入口（自动生成）',
  '# 令牌是**仿真专用**的随机值，与生产无关；**保持稳定**（复用已有值）。',
  `QQ_OWNER_ID=${SIM.qqOwnerId}`,
  `QQ_BOT_ID=${SIM.qqBotId}`,
  'QQ_ONEBOT_WS_URL=ws://127.0.0.1:6701/',
  `QQ_ONEBOT_ACCESS_TOKEN=${stableToken('.env.qq', 'QQ_ONEBOT_ACCESS_TOKEN')}`,
  `QQ_NAPCAT_WEBUI_TOKEN=${stableToken('.env.qq', 'QQ_NAPCAT_WEBUI_TOKEN')}`,
  'QQ_MULTI_USER_ENABLED=true',
  `QQ_ALLOWED_GROUP_IDS=${SIM.qqGroupId}`,
  '',
].join('\n')
writeFileSync(join(OUT_DIR, '.env.qq'), qq, 'utf8')

// ---------------------------------------------------------------------------
//  .env.wechat（服务器口径：API 在 127.0.0.1:16174）
// ---------------------------------------------------------------------------
const wechat = [
  '# 服务器仿真环境 · 仿真的微信入口（自动生成）',
  `WECHAT_ENABLED=true`,
  'WECHAT_API_URL=http://127.0.0.1:16174',
  `WECHAT_API_TOKEN=${stableToken('.env.wechat', 'WECHAT_API_TOKEN')}`,
  `WECHAT_BOT_ID=${SIM.wechatBotId}`,
  `WECHAT_OWNER_ID=${SIM.wechatOwnerId}`,
  `WECHAT_ALLOWED_GROUP_IDS=${SIM.wechatGroupId}`,
  'WECHAT_STATE_FILE=/opt/project-lg/data/runtime/serversim-wechat-state.json',
  '',
].join('\n')
writeFileSync(join(OUT_DIR, '.env.wechat'), wechat, 'utf8')

// ---------------------------------------------------------------------------
//  读数
// ---------------------------------------------------------------------------
console.log('─'.repeat(78))
console.log('服务器仿真环境 · 凭据已生成')
console.log(`  目录        : ${OUT_DIR.replace(REPO, '<repo>')}`)
console.log(`  模式        : ${LIVE ? 'live（.env.test 的测试端点）' : 'offline（仿真假模型端点）'}`)
console.log(`  数据库      : postgresql://${SIM.dbUser}@127.0.0.1:${String(SIM.dbPort)}/${SIM.dbName}  ← **独立角色**，生产是 lg_migrate`)
console.log(`  模型        : ${env.get('OPENAI_BASE_URL') ?? ''}`)
console.log(`  已关闭开关  : ${spec.env.serverDisabledSwitches.mustBeOff.length} 个（PC 专属能力）`)
console.log(`  已删除键    : ${spec.env.serverDisabledSwitches.mustBeAbsent.join(', ')}`)
console.log(`  QQ          : owner=${SIM.qqOwnerId} bot=${SIM.qqBotId} ws=ws://127.0.0.1:6701/`)
console.log(`  微信        : ${SIM.wechatGroupId} @ 127.0.0.1:16174`)
console.log('  ⚠️ 真实密钥一个都没有进仿真。')
console.log('─'.repeat(78))
