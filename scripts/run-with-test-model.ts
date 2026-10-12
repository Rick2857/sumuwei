/**
 * M5.1.1 —— **测试专用模型端点**包装器（`pnpm with-test-model <command...>`）
 *
 * ============================================================================
 *  用户 2026-09-19 裁定（本脚本是它的机器落点）
 * ============================================================================
 * ```text
 * · 真实记忆库聊天（我手动打开并与她聊天）      ⇒ 用 `.env` 里的**原 key**
 * · 执行测试（全量回归 / 冒烟 / 评测）          ⇒ 用 `.env.test` 的测试端点
 *   url: https://r.dis.115.zone/v1 · model: deepseek-v4.1-flash
 * · 默认为**没有预算上限**
 * ```
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 * ```text
 * ① 先加载 `.env`（基线：数据库路径 / 日志级别 / 用户名 …）
 * ② 再用 `.env.test` **覆盖**（该文件只写它要覆盖的模型变量）
 * ③ 用合并后的 env **spawn** 真正的命令
 *    ⇒ 子进程自己 `import 'dotenv/config'` 时，dotenv 默认**不覆盖**已存在的
 *      环境变量，因此继承下来的测试端点会赢 —— 这条已实测（见 §自检）
 * ④ 打印**非机密**读数：endpoint host / model / key 只报"存在 + 长度"，
 *    **绝不打印取值** —— 让每次测试跑都能留一条"这次用的是哪个端点"的证据
 * ```
 *
 * ============================================================================
 *  两条**失败关闭**（这是本脚本存在的主要理由）
 * ============================================================================
 * ```text
 * G1  `.env.test` 不存在 / 缺 key ⇒ **拒绝运行**（exit 2）。
 *     ⚠️ 绝不静默回落 `.env` 的原 key —— "以为在跑测试、其实在烧生产 key"
 *        是这里最坏的失败模式。
 * G2  命令看起来是**真实聊天**（`pnpm chat` / `src/main.ts` 且无 `--test`）
 *     ⇒ **拒绝**（exit 2）。测试端点不得用于真实对话。
 * ```
 * **G2 的诚实边界**：它是一个**启发式护栏**，不是证明 —— 它挡的是"明显写错"的
 * 调用形状，不是所有可能。真实聊天用不用测试 key，最终由 `.env` 决定。
 *
 * ============================================================================
 *  跑法
 * ============================================================================
 * ```bash
 * pnpm with-test-model pnpm m4.5:ci:full        # 全量门（含 Live Smoke）
 * pnpm with-test-model pnpm eval:m4             # 评测
 * pnpm with-test-model pnpm diag-model          # 只读诊断（Level 1 证明）
 * ```
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { config } from 'dotenv'

const ROOT = process.cwd()
const BASE_ENV = join(ROOT, '.env')
const TEST_ENV = process.env.TEST_MODEL_ENV_FILE ?? join(ROOT, '.env.test')

const command = process.argv.slice(2)
if (command.length === 0) {
  console.error('用法：pnpm with-test-model <command...>')
  console.error('例：  pnpm with-test-model pnpm m4.5:ci:full')
  process.exit(2)
}

/** G1：`.env.test` 必须存在且给出 key —— **绝不**回落到原 key */
if (!existsSync(TEST_ENV)) {
  console.error(`❌ 拒绝运行：找不到测试端点配置 ${TEST_ENV}`)
  console.error('   **不会**回落到 `.env` 的原 key（那会把测试跑到真实额度的 key 上）。')
  console.error('   请照 `.env.test.example` 建立 `.env.test`（它已被 .gitignore 排除）。')
  process.exit(2)
}
const testEnvRaw = readFileSync(TEST_ENV, 'utf8')
const testKeyPresent = /^\s*OPENAI_API_KEY\s*=\s*\S+/m.test(testEnvRaw)
const testBaseUrl = (/^\s*OPENAI_BASE_URL\s*=\s*(\S+)/m.exec(testEnvRaw)?.[1] ?? '').trim()
const testModel = (/^\s*OPENAI_LARGE_MODEL\s*=\s*(\S+)/m.exec(testEnvRaw)?.[1] ?? '').trim()
if (!testKeyPresent || testBaseUrl === '' || testModel === '') {
  console.error(`❌ 拒绝运行：${TEST_ENV} 缺 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_LARGE_MODEL 之一`)
  process.exit(2)
}

/** G2：真实聊天的调用形状 ⇒ 拒绝
 *
 * ⚠️ 判据是 `arg === 'chat'`（精确匹配），**不是** `includes('chat')`。
 *    本脚本第一版用了 includes，于是把 `pnpm eval:phoenix-chat`（一个**合法的测试**）
 *    也挡住了 —— 过宽的护栏与没有护栏在"误伤"这一面同样有害。已实测两向。 */
const joined = command.join(' ')
const looksLikeChat =
  command.some((a) => a === 'chat') ||
  (/(^|\s|\/)(src\/)?main\.ts(\s|$)/.test(joined) && !/--test\b/.test(joined) && !/--dev-server\b/.test(joined))
if (looksLikeChat) {
  console.error('❌ 拒绝运行：这条命令看起来是**真实聊天**（`pnpm chat` / `src/main.ts` 且无 `--test`）。')
  console.error('   真实记忆库聊天必须用 `.env` 的**原 key** —— 不要套 `with-test-model`。')
  process.exit(2)
}

/** ① 基线 ② 覆盖（顺序与 override 都显式，不靠默认值猜） */
config({ path: BASE_ENV })
config({ path: TEST_ENV, override: true })

/** ④ 非机密读数 */
const host = (() => {
  try {
    return new URL(testBaseUrl).host
  } catch {
    return '(不可解析)'
  }
})()
const keyLen = (process.env.OPENAI_API_KEY ?? '').length
console.log('─'.repeat(78))
console.log('测试模型端点（with-test-model）')
console.log(`  env 文件     : .env（基线） + ${TEST_ENV.slice(ROOT.length + 1) || TEST_ENV}（覆盖）`)
console.log(`  endpoint host: ${host}`)
console.log(`  model        : ${String(process.env.OPENAI_LARGE_MODEL)}（small = ${String(process.env.OPENAI_SMALL_MODEL ?? '(未设)')}）`)
console.log(`  api key      : 存在（长度 ${keyLen}）—— **不打印取值**`)
console.log(`  预算上限     : 无（用户 2026-09-19 裁定；仓库**没有**花费计量机制，本脚本也不发明一个）`)
console.log(`  命令         : ${joined}`)
console.log('─'.repeat(78))

const result = spawnSync(command[0], command.slice(1), {
  cwd: ROOT,
  stdio: 'inherit',
  /*
   * M6 / WP4：给子进程一个**可检测的标记**。
   *
   * 在这之前，"命令是否经过测试包装器"这件事**无法从子进程里判断** ——
   * 于是一条 Live 入口只能靠注释自律（"必须经包装器"），而写错的表现是
   * "以为在跑测试、其实在烧 `.env` 里的原 key"，正是本仓库登记过的最坏失败模式。
   *
   * ⚠️ 这是一个**追加**的环境变量：今天没有任何东西读它，
   *    因此对所有既有命令的语义零影响（M6 的 `m6:live` 是第一个消费者）。
   */
  env: { ...process.env, DSH_TEST_MODEL_WRAPPER: '1' },
  shell: true,
})
process.exit(result.status === null ? 1 : result.status)
