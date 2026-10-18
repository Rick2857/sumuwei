/**
 * 在 **PC 上**起执行端（ADR-146 `D03`）。
 *
 * ⚠️⚠️ **它会真的动鼠标键盘**（收到委派且核对通过时）。
 *    所以启动时打印清楚，并要求 `--i-am-here`。
 *
 * 用法：
 *   pnpm postlv2:executor:run -- --i-am-here --port=18766
 *
 * ⚠️ 令牌从 `CHARACTER_EXECUTOR_TOKEN` 读（与服务器侧同一份）；
 *    没有令牌 ⇒ **拒绝启动**（失败关闭），不"用个默认值凑合"。
 */
import { ActionExecutorServer } from '../src/infrastructure/action/executor-server.ts'
import { readLiveSnapshot, performLiveAction } from '../src/infrastructure/action/adapters/desktop-executor-adapter.ts'

const argv = process.argv.slice(2)
if (!argv.includes('--i-am-here')) {
  console.error('执行端会真的动鼠标键盘。确认要跑就加 --i-am-here。')
  process.exit(2)
}
const token = process.env['CHARACTER_EXECUTOR_TOKEN'] ?? ''
if (token === '') {
  console.error('CHARACTER_EXECUTOR_TOKEN 为空 ⇒ 拒绝启动（失败关闭，不设默认值）')
  process.exit(2)
}
const portArg = argv.find((a) => a.startsWith('--port='))?.slice('--port='.length) ?? '18766'
const port = Number.parseInt(portArg, 10)
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error(`--port 不合法：${portArg}`)
  process.exit(2)
}

const log = (m: string): void => console.log(m)

const server = new ActionExecutorServer({
  host: '127.0.0.1',
  port,
  token,
  // ⚠️ 真读回：**此刻**的桌面。读不到就抛 ⇒ 上层拒绝执行（失败关闭）
  snapshot: async () => await readLiveSnapshot(),
  // ⚠️ 真动手。只有上层核对通过才走到这里
  // ⚠️ 动作对象**已带齐** window/index（revalidation 用此刻读数解析出来的）
  execute: async (action) => {
    await performLiveAction(action, { window: action.window, index: action.index, name: action.name })
  },
  onLog: log,
  onState: (s) => log(`[executor] ${s}`),
})

server.listen().then((actual) => {
  log(`[executor] 已监听 127.0.0.1:${actual}`)
  log(`[executor] ★ 它会真的动鼠标键盘；关掉这个窗口即停`)
  // 进程退出时优雅关闭
  process.on('SIGINT', () => { void server.stop().then(() => process.exit(0)) })
  process.on('SIGTERM', () => { void server.stop().then(() => process.exit(0)) })
}).catch((error: Error) => {
  console.error(`[executor] 起不来：${error.message}`)
  process.exit(1)
})
