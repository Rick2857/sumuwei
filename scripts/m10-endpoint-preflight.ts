/**
 * M10 —— **真模型端点预检**（`pnpm m10:preflight`）。
 *
 * ============================================================================
 *  它为什么必须在 WP10 的**第一个真模型门之前**跑
 * ============================================================================
 * AGENTS §8.1 把两条失败关闭写在了 `run-with-test-model` 里：
 *
 * ```text
 * G1  `.env.test` 缺失 / 缺 key ⇒ 拒绝运行（exit 2）—— **绝不**回落 `.env` 的原 key
 * G2  命令形状是真实聊天       ⇒ 拒绝运行（exit 2）
 * ```
 * ⇒ **"以为在跑测试、其实在烧生产 key"** 是这里最坏的失败模式。
 *
 * 本门把同一件事在**跑评测之前**再检一遍，而且检的是"**值**对不对"而不是"能不能跑"：
 *
 * ```text
 * P1  `.env.test` 在不在（缺 ⇒ FAIL，与 G1 同一条）
 * P2  它声明了 key（**只报存在与长度，绝不打印取值**）
 * P3  它的 base URL 与 `.env` 的**不同** ⇒ 没有在烧生产端点
 * P4  它的模型名与 `.env` 的不同（或显式就是测试模型）
 * P5  `.env.test.example` 进仓库且**不含**真实 key（只有占位符）
 * P6  `with-test-model` 的失败关闭**真的在代码里**（不是"文档说它有"）
 * P7  **本门不出网**：可达性是 `NOT PROBED`（如实登记，不假装检过）
 * ```
 *
 * ⚠️ **它不是一次模型调用**：零出网、零花费、秒级。真可达性会在 WP10 的第一个
 *    真模型门里被顺带证明（那一次会真的出站）。
 *
 * ⚠️ 密钥纪律：本文件**只**读 `.env*` 的键名与"长度"，任何输出都**不**含取值。
 *    它连"前 4 位"都不打印 —— 那也已经是泄漏的一半。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const REPO_ROOT = resolve(process.cwd())

interface Check {
  group: 'P'
  id: string
  label: string
  expected: string
  actual: string
  pass: boolean
}

const checks: Check[] = []
function record(
  id: string,
  label: string,
  expected: string,
  actual: string,
  pass: boolean,
): void {
  checks.push({ group: 'P', id, label, expected, actual, pass })
}

/** 极简 `.env` 解析（**只要键名与"值是否存在"**；不引 dotenv、不打印取值） */
function parseEnvFile(path: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(path)) return out
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out.set(key, value)
  }
  return out
}

/** 只报"存在 + 长度" */
function describeSecret(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return '(缺失)'
  return `存在（长度 ${String(value.length)}）`
}

const KEY_NAMES = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_LARGE_MODEL', 'OPENAI_SMALL_MODEL']

function main(): void {
  const testPath = join(REPO_ROOT, '.env.test')
  const prodPath = join(REPO_ROOT, '.env')
  const examplePath = join(REPO_ROOT, '.env.test.example')

  /* ---- P1 ---- */
  const testExists = existsSync(testPath)
  record(
    'P1',
    '`.env.test` **存在**（缺失时 `with-test-model` 会拒绝运行 —— 本门在更早一步发现）',
    '存在',
    testExists ? '存在' : '**缺失** ⇒ 真模型门会 exit 2',
    testExists,
  )

  const test = parseEnvFile(testPath)
  const prod = parseEnvFile(prodPath)

  /* ---- P2 ---- */
  const testKey = test.get('OPENAI_API_KEY')
  record(
    'P2',
    '`.env.test` 声明了 key（**只报存在与长度；取值永不打印**）',
    '非空',
    describeSecret(testKey),
    testKey !== undefined && testKey.trim() !== '',
  )

  /* ---- P3 ---- */
  const testUrl = test.get('OPENAI_BASE_URL')
  const prodUrl = prod.get('OPENAI_BASE_URL')
  record(
    'P3',
    '`.env.test` 的 `OPENAI_BASE_URL` 与 `.env` 的**不同** ⇒ 评测**没有**在烧生产端点',
    '两者不同（或 .env.test 显式给出）',
    `测试端点 host=${hostOf(testUrl)} · 生产端点 host=${hostOf(prodUrl)}`,
    testUrl !== undefined && testUrl.trim() !== '' && testUrl !== prodUrl,
  )

  /* ---- P4 ---- */
  const testModel = test.get('OPENAI_LARGE_MODEL') ?? test.get('OPENAI_SMALL_MODEL')
  const prodModel = prod.get('OPENAI_LARGE_MODEL') ?? prod.get('OPENAI_SMALL_MODEL')
  record(
    'P4',
    '`.env.test` 的模型名与 `.env` 的**不同**（模型换代会让读数不可比 ⇒ 显式声明）',
    '两者不同（或测试侧显式声明）',
    `测试模型=${testModel ?? '(未声明)'} · 生产模型=${prodModel ?? '(未声明)'}`,
    testModel !== undefined && testModel !== '' && testModel !== prodModel,
  )

  /* ---- P5 ---- */
  const exampleExists = existsSync(examplePath)
  const exampleText = exampleExists ? readFileSync(examplePath, 'utf8') : ''
  /* 模板里**不该**出现看起来像真 key 的长串（`sk-` 开头 + 20 位以上） */
  const looksLikeRealKey = /sk-[A-Za-z0-9_-]{20,}/.test(exampleText)
  record(
    'P5',
    '`.env.test.example` **进仓库**且**不含**真实 key（只有占位符）',
    '存在 · 无 `sk-` 长串',
    `${exampleExists ? '存在' : '缺失'} · 含疑似真 key=${String(looksLikeRealKey)}`,
    exampleExists && !looksLikeRealKey,
  )

  /* ---- P6 ---- */
  const runnerPath = join(REPO_ROOT, 'scripts/run-with-test-model.ts')
  const runner = existsSync(runnerPath) ? readFileSync(runnerPath, 'utf8') : ''
  const hasRefusal =
    /exit\(2\)/.test(runner) && /\.env\.test/.test(runner) && /缺失|缺 key|missing/.test(runner)
  record(
    'P6',
    '`with-test-model` 的失败关闭**真的在代码里**（不是"文档说它有"）：缺 `.env.test` ⇒ `exit(2)`',
    '源码里有 exit(2) + .env.test 判定',
    `${existsSync(runnerPath) ? '文件在场' : '文件缺失'} · 失败关闭=${String(hasRefusal)}`,
    hasRefusal,
  )

  /* ---- P7 ---- */
  record(
    'P7',
    '**本门不出网**：端点的**可达性**是 `NOT PROBED`（零出站、零花费、秒级）'
      + ' —— 如实登记，不假装检过',
    'NOT PROBED（明写）',
    'NOT PROBED',
    true,
  )

  /*
   * ⚠️ **第一版这条检查太宽**：它把"每个 ≥12 字符的取值"都当成秘密，
   *    于是 **host 与模型名**（`ark.cn-beijing.volces.com` / `deepseek-v4.1-flash`）
   *    被判成 4 处泄漏 —— 而 AGENTS §8.1 明确要求 `with-test-model`
   *    **打印** endpoint host 与 model（它们是**非机密**读数，正是用来核对
   *    "这次跑的是哪个端点"的）。
   *
   * ⇒ 判据收窄为：**按键名判断哪些值是凭据**（含 KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL），
   *    只拿那些值与输出比对。同时用 `P9` 把"host 与模型名**应当**出现"也变成判据 ——
   *    否则下一次可能反过来"把该打印的也藏起来"。
   */
  const CREDENTIAL_KEY = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i
  const credentialValues = [...test.entries(), ...prod.entries()]
    .filter(([key, value]) => CREDENTIAL_KEY.test(key) && value.trim() !== '')
    .map(([, value]) => value)
  const rendered = checks
    .map((check) => `${check.id} ${check.label} ${check.expected} ${check.actual}`)
    .join('\n')
  const leaked = credentialValues.filter((value) => rendered.includes(value))
  record(
    'P8',
    '**本门的输出不含任何凭据取值**（按**键名**挑出凭据类字段，再与自己的输出比一遍）'
      + ' —— 密钥纪律的机器判据，不是"我记得别打印"',
    `0 处泄漏（比了 ${String(credentialValues.length)} 个凭据值）`,
    leaked.length === 0 ? '0 处' : `**泄漏 ${String(leaked.length)} 处**`,
    leaked.length === 0 && credentialValues.length > 0,
  )

  /* ---- P9 ---- */
  const hostShown = rendered.includes(hostOf(test.get('OPENAI_BASE_URL')))
  const modelShown = rendered.includes(String(testModel ?? '(未声明)'))
  record(
    'P9',
    '【正控】**该打印的确实打印了**：测试端点的 host 与模型名出现在输出里'
      + '（AGENTS §8.1：它们是非机密读数，正是用来核对"这次跑的是哪个端点"的）',
    'host 与模型名都出现',
    `host 出现=${String(hostShown)} · 模型出现=${String(modelShown)}`,
    hostShown && modelShown,
  )

  const passed = checks.filter((check) => check.pass).length
  const failed = checks.length - passed
  console.log('M10 真模型端点预检（**零出网**）')
  for (const check of checks) {
    console.log(`  ${check.pass ? '✅' : '❌'} ${check.id} ${check.label}`)
    console.log(`      期望 ${check.expected} · 实测 ${check.actual}`)
  }
  console.log(`verdict: ${failed === 0 ? 'PASS' : 'FAIL'}（${String(passed)}/${String(checks.length)}）`)
  console.log('⚠️ 可达性 = NOT PROBED：真正的出站由 WP10 的第一个真模型门证明。')
  process.exitCode = failed === 0 ? 0 : 1
}

/** 只报 host（**不报路径 / 不报查询串**：那两处可能带 key） */
function hostOf(url: string | undefined): string {
  if (url === undefined || url.trim() === '') return '(未声明)'
  try {
    return new URL(url).host
  } catch {
    return '(不是合法 URL)'
  }
}

main()
