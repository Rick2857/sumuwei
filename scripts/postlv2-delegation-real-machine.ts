/**
 * ★★ M-03 / M-04 的**真机档**（ADR-146 `D03`）★★
 *
 * ⚠️⚠️⚠️ **这道门会真的动你的鼠标和键盘。**
 * ⚠️⚠️⚠️ 因此它：
 *   · **必须**显式给 `--i-am-here`，否则**什么都不做就退出**（不打印"怎么运行"的提示也不跑）
 *   · **不登记**在任何门表里（`package.json` 的 scripts 只是一个名字，没有 `m4.5:ci` 之类会串跑它的地方）
 *   · **不接 CI**，理由与 `desktop-control:act --i-am-here` 完全相同（ADR-106 纪律）
 *
 * ============================================================================
 *  它要证的两件事（这是 D03 的全部）
 * ============================================================================
 *
 * ```text
 * M-04 正控  此刻快照与委派一致        ⇒ 执行端**执行**
 * M-03 负控  用户已切走窗口            ⇒ 执行端**拒绝**，且**一次都不点**
 * ```
 *
 * ⚠️ 负控才是这道门存在的原因。
 *    正控在"什么都不核对"的实现下**也会通过** —— 它只证明"能点"。
 *    负控证明的是"**不乱点**"，而那正是跨机器委派唯一危险的地方：
 *    核心在服务器、快照是几十秒前的，你可能早就切走了。
 *
 * ============================================================================
 *  运行方式
 * ============================================================================
 *
 * ```powershell
 * # ① 先自己起一个记事本（门不代你开应用，因为 launch_app 也会动鼠标）
 * notepad 记事本.txt
 * # ② 在记事本里点一下，让它成为前台
 * # ③ 然后跑：
 * pnpm postlv2:delegation:real -- --i-am-here
 * ```
 *
 * ⚠️ 门**不会**自己切窗口去做负控 —— 那等于用机器制造一个"用户切走了"的假现场。
 *    它会**请你切**，然后读回结果。
 */

import { spawn } from 'node:child_process'
import { readLiveSnapshot, performLiveAction } from '../src/infrastructure/action/adapters/desktop-executor-adapter.ts'
import { revalidateAgainstSnapshot, type DesktopSnapshot } from '../src/kernel/action/delegation-revalidation.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}  ${detail}`) }
  else { fail += 1; console.log(`  FAIL  ${name}  ${detail}`) }
}

if (!process.argv.includes('--i-am-here')) {
  console.error('这道门会真的动鼠标键盘。确认要跑就加 --i-am-here。')
  process.exit(2)
}

/*
 * ⚠️ 非交互模式（`--non-interactive`）是给**没有 TTY 的执行环境**用的。
 *
 * ⚠️ 它**不放宽任何一条**：
 *   · 仍然必须给 `--i-am-here`（上面那道闸在它之前，无条件）
 *   · 仍然**必须显式给 `--target=N`** —— 没有"自动挑第一个"这件事
 *     （自动挑可能挑中「删除」，见下面候选列表那段注释）
 *   · 仍然**必须显式给 `--yes`** 才动手
 *   · 负控仍然**真的换前台窗口**
 *
 * ⚠️ 负控在非交互模式下**由本门启动一个记事本**来换前台 ——
 *   那**不是**"制造假现场"：用户切应用做的事，启动应用同样做到，
 *   而且前台**真的**变了、快照**真的**读到了新前台。
 */
const NON_INTERACTIVE = process.argv.includes('--non-interactive')
const YES = process.argv.includes('--yes')
const targetArg = process.argv.find((a) => a.startsWith('--target='))
if (NON_INTERACTIVE && (targetArg === undefined || !YES)) {
  console.error('非交互模式必须同时给 --target=N 与 --yes（不替你选目标、不替你点头）')
  process.exit(2)
}

const ask = async (question: string): Promise<string> => {
  if (NON_INTERACTIVE) return ''
  return await new Promise<string>((done) => {
    process.stdout.write(`${question} `)
    process.stdin.setEncoding('utf8')
    process.stdin.once('data', (c: string) => done(c.trim()))
  })
}

async function main(): Promise<void> {
  console.log('=== 前置：读一次**此刻**的桌面 ===')
  let first: DesktopSnapshot
  try {
    first = await readLiveSnapshot()
  } catch (error) {
    console.error(`  读不到桌面（${(error as Error).message}）`)
    console.error('  ⇒ 这不是门失败，是**环境**读不到（AT-SPI 不可用 / 桌面上没有前台窗口）。')
    process.exit(1)
  }
  console.log(`  前台窗口 : ${first.activeWindow}`)
  console.log(`  窗口数   : ${first.windows.length}`)
  /*
   * ⚠️⚠️ 目标必须**从前台窗口里挑**，不能对所有窗口摊平后取第一个。
   *    摊平后第一个元素**可能来自后台窗口** ⇒ `revalidateAgainstSnapshot` 会
   *    以 `executor_window_not_foreground` 拒掉 ⇒ **M-04 正控会因为错误的原因失败**。
   *    （本机读数里它碰巧在前台，是因为窗口顺序恰好 —— **靠巧合对的代码就是没对**。）
   */
  const foreground = first.windows.find((w) => w.name === first.activeWindow)
  const actionable = (foreground?.elements ?? []).filter((e) => e.actionable)
  console.log(`  前台窗口内可操作元素: ${actionable.length}（**只从前台窗口里挑**）`)
  if (actionable.length === 0) {
    console.error('  ⇒ 前台窗口里没有可操作元素。请把一个**普通窗口**放到前台（记事本就行）再跑。')
    console.error('     ⚠️ 上游只枚举**前台窗口**的元素 —— 后台窗口里有多少都不算数。')
    process.exit(1)
  }
  const target = actionable[0]!
  const win = foreground!

  /*
   * ⚠️⚠️ **不自动挑** `actionable[0]`，而是**列出候选让你挑**。
   *    原版自动挑第一个可操作元素，然后问"点这个？"
   *    —— 如果前台恰好是某个有「删除」按钮的应用，第一个元素**可能就是删除**，
   *    而那道确认题只有一行「点这个？」，人很容易直接敲 yes。
   *    ⇒ 真机档的输入是人，**不该由程序替人选一个会动的目标**。
   */
  const candidates = actionable.slice(0, 8)
  console.log(`\n  候选目标（前 ${candidates.length} 个，前台窗口「${win.name}」）：`)
  candidates.forEach((e, i) => {
    console.log(`    [${i}] #${e.index} 「${e.name || '(无名)'}」`)
  })
  if (actionable.length > candidates.length) {
    console.log(`    …另有 ${actionable.length - candidates.length} 个未列出`)
  }
  const pickRaw = await ask(`  选哪个？（回车 = 0）: `)
  const explicit = targetArg === undefined ? Number.NaN : Number.parseInt(targetArg.slice('--target='.length), 10)
  const requested = NON_INTERACTIVE ? explicit : Number.parseInt(pickRaw === '' ? '0' : pickRaw, 10)
  const chosen = Number.isInteger(requested) && requested >= 0 && requested < candidates.length
    ? candidates[requested]!
    : candidates[0]!
  console.log(`  选中：#${chosen.index} 「${chosen.name || '(无名)'}」${NON_INTERACTIVE ? '（**由 --target 指定**）' : ''}`)

  // -------------------------------------------------------------------------
  console.log('\n=== M-04 ★ 正控：此刻一致 ⇒ 必须放行 ===')
  {
    const v = revalidateAgainstSnapshot(first, {
      action: 'click', window: win.name, index: chosen.index, name: chosen.name,
    })
    check('核对通过', v.ok, JSON.stringify(v))
    if (!v.ok) { console.log('  ⇒ 核对没过就不该继续点'); return }
    const answer = NON_INTERACTIVE ? 'yes' : await ask(`  即将**真的点击**「${win.name}」的「${chosen.name}」。继续？(yes/no) `)
    if (answer !== 'yes') { console.log('  已取消 —— 不点。'); return }
    try {
      await performLiveAction(v.action, { window: win.name, index: chosen.index, name: chosen.name })
      check('★ 真执行完成（worker 没有报失败）', true, 'worker 已返回')
    } catch (error) {
      check('真执行完成', false, (error as Error).message.slice(0, 100))
    }
  }

  // -------------------------------------------------------------------------
  console.log('\n=== M-03 ★★★ 负控：你切走窗口 ⇒ 必须拒绝，且一次都不点 ===')
  if (NON_INTERACTIVE) {
    /*
     * ⚠️ 非交互负控：**启动一个与目标不同的应用**（默认计算器）来换前台。
     *   · 这**不是**"用机器制造假现场"：用户切应用做的事，启动应用同样做到；
     *     前台**真的**变了，下一次快照**真的**读到了新前台。
     *   · ⚠️ **必须换一个不同的应用**。第一版这里启动的是**记事本**，
     *     而目标窗口**恰好就是记事本** ⇒ 前台根本没变 ⇒ 负控不成立却看不出来。
     *     下面那句 `前台确实变了` 正是为了抓住这类假通过。
     */
    const switchWith = process.argv.find((a) => a.startsWith('--switch-with='))?.slice('--switch-with='.length) ?? 'calc.exe'
    console.log(`  非交互模式：启动 ${switchWith} 以换前台（目标窗口是「${win.name}」）…`)
    spawn(switchWith, [], { detached: true, stdio: 'ignore' }).unref()
    await new Promise((r) => setTimeout(r, 4000))
  } else {
    console.log('  请现在**手动**切换到另一个窗口（点一下别的程序，或 Alt+Tab）。')
    console.log('  ⚠️ 你回车之后，门要**再读一次桌面**才敢下结论 —— 实测约 **9 秒**（worker 冷读）。')
    console.log('     那几秒它**什么都不会做**，等就是了。')
    await ask('  切好了就回车: ')
  }
  {
    let now: DesktopSnapshot
    try { now = await readLiveSnapshot() }
    catch (error) { check('切走后仍读得到桌面', false, (error as Error).message.slice(0, 100)); return }
    console.log(`  此刻前台 : ${now.activeWindow}`)
    check('★ 前台确实变了（否则这道负控不成立）', now.activeWindow !== win.name,
      `before=${win.name}  now=${now.activeWindow}`)

    const v = revalidateAgainstSnapshot(now, {
      action: 'click', window: win.name, index: chosen.index, name: chosen.name,
    })
    check('★ 用**此刻**的快照重核对 ⇒ 拒绝', !v.ok, `verdict=${JSON.stringify(v)}`)
    check('★ 理由是"窗口不是前台"', !v.ok && v.rejection === 'executor_window_not_foreground',
      `rejection=${v.ok ? '(放行了!)' : v.rejection}`)
    console.log('\n  ⇒ 注意：门到这里**没有再调 performLiveAction`。')
    console.log('     那正是要证的：过期委派**到不了**执行 worker 那一层。')
  }
}

main().then(() => {
  console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}).catch((error: Error) => {
  console.error(`门自身崩了：${error.message}`)
  process.exit(1)
})
