/**
 * 只读探针：执行端能不能在**此刻**真读到桌面（ADR-146 `D03` 的前置条件）。
 *
 * ⚠️⚠️ **全程只读** —— 只发 `op:'state'`，**不发** `op:'act'`。
 *    所以它**不动鼠标键盘**，可以安全地在没人时跑。
 * ⚠️ 它的作用是**提前暴露环境问题**：真机门（M-03/M-04）第一步就调
 *    `readLiveSnapshot()`；如果 AT-SPI 在这台机器上不可用，门会当场失败。
 *    与其等你在场时才发现，不如现在就知道。
 */
import {
  readLiveSnapshot,
  buildActHeader,
} from '../src/infrastructure/action/adapters/desktop-executor-adapter.ts'
import { runDesktopWorker } from '../src/infrastructure/action/adapters/desktop-control.ts'
import { verifyArxivRuntimeSync } from '../src/infrastructure/action/adapters/arxiv.ts'
import { defaultDesktopControlPython, defaultDesktopControlWorker } from '../src/infrastructure/action/adapters/desktop-control-assets.ts'
import { existsSync } from 'node:fs'

let pass = 0
let fail = 0
/*
 * ⚠️ 这里**必须**两条分支都打印。
 *    第一版 `else { fail += 1 }` **不打印**，于是每个 FAIL 都被静默吞掉 ——
 *    量具骗人：输出里只看到两条解释性警告，看不到"哪一条挂了、报什么"。
 *    与"未读数即失败"的纪律同源：**没打印出来 = 没发生**，那是在骗读数的人。
 */
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}  ${detail}`) }
  else { fail += 1; console.log(`  FAIL  ${name}  ${detail}`) }
}

console.log('=== 0. 运行时文件在不在（只读核对，不启动进程）===')
{
  const py = defaultDesktopControlPython()
  const wk = defaultDesktopControlWorker()
  check('解释器存在', existsSync(py), py)
  check('worker 脚本存在', existsSync(wk), wk)
}

console.log('\n=== 1. arXiv 运行时（本机只读核对）===')
{
  check('verifyArxivRuntimeSync()', verifyArxivRuntimeSync(), `platform=${process.platform}`)
}

console.log('\n=== 2. ★ 真读一次桌面（只读 op:state，不动鼠标）===')
{
  try {
    const snap = await readLiveSnapshot()
    check('读到前台窗口名', snap.activeWindow !== '', `activeWindow="${snap.activeWindow}"`)
    check('读到窗口数组', Array.isArray(snap.windows), `windows=${snap.windows.length}`)
    const actionable = snap.windows.flatMap((w) => w.elements.filter((e) => e.actionable))
    check('读到至少一个可操作元素', actionable.length > 0, `actionable=${actionable.length}`)
    const noName = snap.windows.flatMap((w) => w.elements).filter((e) => e.name === '').length
    console.log(`  （⚠️ 元素总数 ${snap.windows.flatMap((w) => w.elements).length}，其中无名的 ${noName}）`)
    for (const w of snap.windows.slice(0, 4)) {
      console.log(`    窗口「${w.name}」 ${w.elements.length} 个元素`)
    }
  } catch (error) {
    check('读到桌面', false, (error as Error).message.slice(0, 140))
    console.log('\n  ⚠️ 这**不是**门失败，是**环境**读不到。真机门的第一步就是它；')
    console.log('     跑之前需要：桌面会话存在 + 有一个普通前台窗口（AT-SPI 只枚举前台窗口）。')
  }
}

console.log('\n=== 3. ★ act 头对着**真 worker** 验形状（dryRun ⇒ 核对链全跑、**不动手**）===')
{
  /*
   * ⚠️ 为什么用 worker 自己的 `dryRun`：它会把整条核对链跑一遍然后**停在动手之前**
   *   （`desktop-control-worker.py:538`）⇒ 能验"这个头 worker 认不认、目标解析不解析得到"，
   *   又**不会**动鼠标。仓库自己的实机只读门就是这么做的（见 ADR-106 记的那次事故）。
   * ⚠️ 这正是今天"凭想象定形状"那条教训的**主动应用**：
   *   我修过 `op:'state'` 那条路（真机探针抓出三处错），
   *   但 `op:'act'` 的头**从没对着真 worker 核过** —— 同一个盲区，不能只补一半。
   */
  try {
    const snap = await readLiveSnapshot()
    const actionable = snap.windows.flatMap((w) => w.elements.filter((e) => e.actionable))
    if (actionable.length === 0) {
      check('有可操作元素可验 act 头', false, '前台没有可操作元素，跳过（不是失败）')
    } else {
      const t = actionable[0]!
      const win = snap.windows.find((w) => w.elements.some((e) => e.index === t.index))!
      for (const [label, header] of [
        ['click', buildActHeader({ kind: 'click' }, { window: win.name, index: t.index, name: t.name }, true)],
        ['type', buildActHeader({ kind: 'type', content: '形状校验' }, { window: win.name, index: t.index, name: t.name }, true)],
      ] as const) {
        const run = await runDesktopWorker({
          executable: defaultDesktopControlPython(),
          workerScript: defaultDesktopControlWorker(),
          header, timeoutMs: 30_000,
        })
        const problem = run.parseProblem ?? (run.result === undefined ? '没有结果行' : '')
        const workerCode = run.result?.['problem'] ?? ''
        check(`${label} 头被真 worker 接受`, problem === '',
          problem === '' ? `workerCode=${String(workerCode)}` : `problem=${problem.slice(0, 90)}`)
        check(`${label} dryRun 没动手（worker 回 ok）`, run.result?.['ok'] === true,
          `ok=${String(run.result?.['ok'])} dryRun=${String(run.result?.['dryRun'])}`)
      }
    }
  } catch (error) {
    check('act 头对着真 worker 验形状', false, (error as Error).message.slice(0, 120))
  }
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
console.log('⚠️ 本探针**只读**。M-03/M-04 真机档仍然 NOT RUN —— 它必须有人在场且会真的动鼠标。')
process.exit(0)
