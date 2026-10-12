/**
 * 上游孤儿定时器的处理 —— `@elizaos/core@1.7.2` 的 `AgentRuntime.registerService`
 * 会为**每一个服务**建一个 30 秒的守卫定时器，用于 `Promise.race` 的"初始化超时"分支，
 * 但服务启动成功后**从不清除它**：
 *
 * ```js
 * // node_modules/@elizaos/core/dist/node/index.node.js:50037-50042
 * const initTimeout = new Promise((_, reject) => {
 *   setTimeout(() => {
 *     reject(new Error(`Service ${serviceType} registration timed out waiting for
 *                      runtime initialization (30s timeout)`));
 *   }, 30000);          // ← 从不 clearTimeout
 * });
 * await Promise.race([this.initPromise, initTimeout]);
 * ```
 *
 * ============================================================================
 *  它的实际代价（实测，2026-09-22）
 * ============================================================================
 * 这个定时器本身不再有用途，但它**会维持 Node 的事件循环**。于是每一次
 * `tsx src/main.ts <任何只读命令>`（`--kernel-status` / `--action-list` / `--seed-status` …）
 * 的进程生命周期是：
 *
 * ```text
 *   0.0s  node + tsx 启动
 *   0.8s  模块加载完成（实测 import 全图 0.78–0.83s）
 *   1.0s  PGlite 打开 + 迁移检查 + initCharacterState（实测 0.5–1.9s）
 *   1.1s  runtime.initialize() —— 在这里建出 2 个 30s 孤儿定时器
 *   ~1.5s 命令跑完、有序收尾（stop → close → closed check）跑完
 *   ~1.5s 起**无事可做**，但事件循环被那两个定时器按住
 *   31.5s 定时器到点 ⇒ 进程才退出
 * ```
 *
 * 实测：`--kernel-status` 墙钟 **31.4s**，而 CPU profile 里 **29.85s / 32.65s 是 `(idle)`**
 * （真算力不到 1.5s）。六个读数（三种只读命令 × 各两次）全部落在 31.4–33.2s。
 *
 * 这不是"某个门慢"，而是**每一次启动 CLI 的固定税**：Live Smoke 一次要 spawn
 * 约 40 次 `src/main.ts`（其中只有约 10 次是真模型轮）⇒ 约 1240s 的墙钟其实就是
 * 40 × 31s 的退出税，而不是模型慢。
 *
 * ============================================================================
 *  为什么用 `unref` 而不是 `process.exit()`
 * ============================================================================
 * `process.exit()` 会**截断尚未落盘的 stdout**（管道写入是异步的）——
 * 那正是最危险的一种失败：冒烟门的量具读 stdout，最后几行（往往就是她的回复或
 * 一条 FAIL 明细）会被静默丢掉，而退出码仍然是 0。
 *
 * `unref()` 只做一件事：**不靠这个定时器维持事件循环**。语义上完全等价于
 * "它已经没用了"：
 *   · 服务真的还在启动 ⇒ 它自己的句柄仍在，进程不会提前退出；
 *   · 30s 超时**照样会触发并 reject**（只是不再独自撑着进程）；
 *   · 进程在自然退出前会把 stdout 冲干净。
 *
 * 作用域也刻意收窄：**只在 `runtime.initialize()` 期间**、**只对 ≥30s 的定时器**生效，
 * 结束后立刻还原 `globalThis.setTimeout`。长驻模式（`--dev-server` 的 HTTP server、
 * 对话循环的 stdin）都有自己的句柄，不受影响。
 */

/** 只处理"长延时"定时器：短定时器是正常业务逻辑，不该被碰。 */
export const GUARD_TIMER_MIN_DELAY_MS = 30_000

export interface GuardTimerReport {
  /** 本次调用期间被 unref 掉的定时器个数（0 也是合法读数 —— 例如离线命令不建服务）。 */
  unrefed: number
  /** 被 unref 的定时器延时（用于证据；便于发现上游改了阈值）。 */
  delays: number[]
}

/**
 * 在 `thunk()` 执行期间，把新创建的长延时定时器 `unref()` 掉。
 *
 * ⚠️ 这是**有意的、作用域极小的猴子补丁**，理由见文件头。它**不改**任何
 * 定时器的回调、延时或清除语义，只改"要不要靠它维持事件循环"。
 */
export async function withGuardTimersUnrefed<T>(
  thunk: () => Promise<T>,
  options: { minDelayMs?: number } = {}
): Promise<{ value: T; report: GuardTimerReport }> {
  const minDelay = options.minDelayMs ?? GUARD_TIMER_MIN_DELAY_MS
  const original = globalThis.setTimeout
  const report: GuardTimerReport = { unrefed: 0, delays: [] }

  const patched = ((handler: (...a: unknown[]) => void, delay?: number, ...rest: unknown[]) => {
    const handle = original(handler, delay, ...rest)
    if (typeof delay === 'number' && delay >= minDelay) {
      const candidate = handle as unknown as { unref?: () => void }
      if (typeof candidate.unref === 'function') {
        candidate.unref()
        report.unrefed += 1
        report.delays.push(delay)
      }
    }
    return handle
  }) as unknown as typeof globalThis.setTimeout

  globalThis.setTimeout = patched
  try {
    const value = await thunk()
    return { value, report }
  } finally {
    globalThis.setTimeout = original
  }
}
