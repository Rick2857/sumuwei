/**
 * 门：薄宿主**接线**（不是实现，是"能被真正选用"）。
 *
 * ============================================================================
 *  为什么这道门与"语义等价门"是两回事
 * ============================================================================
 * 语义等价门证明：**薄宿主自己的每个方法**与旧宿主同形。
 * 这道门证明：**装配路径 `buildRuntime()` 在开关打开时真的产出薄宿主**，
 * 而且它造出来的对象**能被既有调用点使用**（`adapter` 形状被
 * `state/repository.ts:getRawDb()` 与 `runtime-shutdown.ts` 直接消费）。
 *
 * 断言：
 *   W1  开关**缺省即薄宿主**（D2，2026-10-19 改写：旧断言是"缺省 off"）
 *   W2  `off` / 非法值 ⇒ **拒绝启动**（旧断言是"失败关闭回 off"）
 *   W3  开关 on ⇒ 工厂产出的是 ThinHostRuntime 实例
 *   W4  该实例的 `adapter` **结构兼容**旧宿主：`getRawDb()` 能取到 db.execute
 *   W5  `stopRuntimeServices` / `isDatabaseClosed` / `closeDatabaseConnection`
 *       这三个**既有收尾注入点**在薄宿主上都能工作
 *   W6  当前宿主标签可读（elizaos / thin-host），读数能归因
 *
 * ⚠️ 全程**不开数据库**：W4/W5 用一个假 pool，只验证结构与收尾链。
 *    真库行为由 thinhost-equivalence-verify.ts 负责。
 */

import { thinHostEnabled, createThinHostRuntime, currentHostLabel } from '../src/infrastructure/runtime/thin-host-factory.ts'
import { ThinHostRuntime } from '../src/infrastructure/runtime/thin-host.ts'
import { stopRuntimeServices, isDatabaseClosed, closeDatabaseConnection } from '../src/infrastructure/persistence/runtime-shutdown.ts'
import { setActiveHostKind } from '../src/infrastructure/runtime/thin-host-bridge.ts'
import { readFileSync } from 'node:fs'
import { parse } from 'dotenv'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

// --- W1 缺省即薄宿主（D2：2026-10-19 改写；旧断言是"缺省 off"）---
check(
  'W1-default-is-thin',
  thinHostEnabled({} as NodeJS.ProcessEnv) === true,
  '未设变量 ⇒ 薄宿主（D2：缺省即唯一实现，不能让人无声失败）'
)

// --- W2 `off` / 非法值 ⇒ 拒绝启动（D2：旧断言是"失败关闭回 off"）---
check('W1-server-template-starts', thinHostEnabled(parse(readFileSync('.env.server.example'))) === true,
  '发行模板必须选择仍受支持的宿主')

{
  let offThrew = false
  let offMessage = ''
  try {
    thinHostEnabled({ CHARACTER_THIN_HOST: 'off' } as NodeJS.ProcessEnv)
  } catch (error) {
    offThrew = true
    offMessage = error instanceof Error ? error.message : String(error)
  }
  check(
    'W2-off-refuses-startup',
    offThrew && offMessage.includes('已退役'),
    `CHARACTER_THIN_HOST=off ⇒ 拒绝启动（消息含"已退役"=${String(offMessage.includes('已退役'))}）`
  )
}

{
  let illegalThrew = false
  let illegalMessage = ''
  try {
    thinHostEnabled({ CHARACTER_THIN_HOST: 'yes-please' } as NodeJS.ProcessEnv)
  } catch (error) {
    illegalThrew = true
    illegalMessage = error instanceof Error ? error.message : String(error)
  }
  check(
    'W2-invalid-refuses-startup',
    illegalThrew && illegalMessage.includes('不是合法值'),
    '拼错的变量值 ⇒ 拒绝启动并列出合法值（不猜）'
  )
}
check(
  'W2-valid-on',
  thinHostEnabled({ CHARACTER_THIN_HOST: 'on' } as NodeJS.ProcessEnv) === true,
  'CHARACTER_THIN_HOST=on ⇒ 选用薄宿主（兼容既有生产 .env）'
)

// --- W3 工厂产出真实薄宿主（用假 pool，不碰真库）---
const fakePool = {
  ended: false,
  end: async function (): Promise<void> {
    ;(fakePool as { ended: boolean }).ended = true
  },
  query: (async () => ({ rows: [] })) as unknown,
}

const runtime = createThinHostRuntime({
  character: { name: '苏沐薇', id: 'sumuwei' },
  agentId: '00000000-0000-4000-8000-000000000001',
  settings: { POSTGRES_URL: 'postgresql://fake/fake' },
})
check('W3-factory-thin', runtime instanceof ThinHostRuntime, `工厂产出 ${runtime.constructor.name}`)
check('W6-host-label', currentHostLabel() === 'thin-host', `宿主标签可读：${currentHostLabel()}`)

// --- W3b 工厂自身也做档位校验（造宿主处 ⇒ 任何入口都绕不过）---
{
  const saved = process.env.CHARACTER_THIN_HOST
  process.env.CHARACTER_THIN_HOST = 'off'
  let threw = false
  try {
    createThinHostRuntime({
      character: { name: '苏沐薇', id: 'sumuwei' },
      agentId: '00000000-0000-4000-8000-000000000001',
      settings: { POSTGRES_URL: 'postgresql://fake/fake' },
    })
  } catch {
    threw = true
  } finally {
    if (saved === undefined) delete process.env.CHARACTER_THIN_HOST
    else process.env.CHARACTER_THIN_HOST = saved
  }
  check('W3b-factory-validates-switch', threw, '工厂在造宿主前就校验档位 ⇒ `off` 不会造出宿主')
}

// --- W4 adapter 结构兼容：既有 getRawDb 那条断言能取到 execute ---
// ⚠️ 传空对象：薄宿主的 registerPlugin **不做任何 plugin 检查**（它不是 ElizaOS
//    的插件系统），签名收 `unknown`。这里只为拿到 adapter，不触发任何真实注册。
await runtime.registerPlugin({} as never)
const dbHolder = runtime as unknown as {
  adapter?: { db?: { execute?: unknown } }
}
const dbLike = dbHolder.adapter?.db
check(
  'W4-adapter-shape',
  typeof dbLike?.execute === 'function',
  'adapter.db.execute 存在 ⇒ state/repository.ts:getRawDb() 的既有断言可用'
)

// --- W5 三个既有收尾注入点在薄宿主上工作 ---
// ⚠️ "收尾前已关"这条第一版**顺序写错了**：`stopRuntimeServices()` 内部就会
//    经 `prepareDatabaseClose` / `runtime.stop()` 把连接关掉，所以等它跑完再查
//    必然已是 true。必须**先**查未关状态，**再**跑收尾。
check(
  'W5-isDatabaseClosed-before',
  isDatabaseClosed(runtime) === false,
  '收尾前 isDatabaseClosed = false（未关）'
)
let stopThrew = false
try {
  await stopRuntimeServices(runtime)
} catch {
  stopThrew = true
}
check('W5-stopServices', stopThrew === false, 'stopRuntimeServices(薄宿主) 不抛')
await closeDatabaseConnection(runtime)
check('W5-isDatabaseClosed-after', isDatabaseClosed(runtime) === true, '收尾后 isDatabaseClosed = true（已关）')

// 复原：后续若在同一进程读宿主标签，应回到 elizaos
setActiveHostKind('elizaos')
check('W6-label-resettable', currentHostLabel() === 'elizaos', '宿主标签可复位（便于对照测量）')

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== thinhost 接线: ${checks.length - failed.length}/${checks.length} PASS ===`)
for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
if (failed.length > 0) process.exitCode = 1
void fakePool
