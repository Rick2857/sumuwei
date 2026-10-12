/**
 * post-Lv2 / ADR-109 WP5 —— **有序停机**：写停机哨兵。
 *
 * ⚠️ 它**不**杀任何进程：`pnpm coexist:start` 的编排者会看到哨兵，
 *    然后按"停两条外壳 → 关核心 stdin → 核心排空在飞轮次、关库、释放租约"的顺序收尾。
 *    直接 `taskkill` 会跳过"排空在飞消费者"，那不是有序停机（INC-01 的纪律）。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..', '..')
const runtimeDir = resolve(root, 'artifacts/post-lv2/local/coexist-runtime')
const sentinel = resolve(runtimeDir, 'STOP')
mkdirSync(runtimeDir, { recursive: true })
writeFileSync(sentinel, `${new Date().toISOString()}\n`, 'utf8')
console.log(`已写停机哨兵：${sentinel}`)
console.log('编排者（`pnpm coexist:start` 那个窗口）会在 0.5 秒内开始有序停机；请留在那个窗口看退出码。')
