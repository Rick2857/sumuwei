/**
 * 执行端重新核对（ADR-146 `D03`）的门。
 *
 * ⚠️ 这里证的是**核对逻辑本身**（纯函数 + 注入快照）——
 *    **不是** M-03/M-04 那一档。真机档要真开窗口、真点鼠标、且要人在场，
 *    按 ADR-106 纪律不进 CI。本门通过**不等于** M-03/M-04 通过。
 */
import {
  revalidateAgainstSnapshot,
  type DesktopSnapshot,
} from '../src/kernel/action/delegation-revalidation.ts'

let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail: string): void => {
  if (ok) { pass += 1; console.log(`  PASS  ${name}  ${detail}`) }
  else { fail += 1; console.log(`  FAIL  ${name}  ${detail}`) }
}

const snapshot = (active: string, windows: DesktopSnapshot['windows']): DesktopSnapshot =>
  ({ activeWindow: active, windows })

/** 核心理 40 秒前看到的：记事本在前台，序号 3 是"保存"按钮 */
const thenSnapshot = snapshot('记事本', [{
  name: '记事本',
  elements: [
    { index: 1, name: '编辑菜单', actionable: true },
    { index: 3, name: '保存', actionable: true },
    { index: 7, name: '密码', actionable: false },
  ],
}])
const req = { action: 'click', window: '记事本', index: 3, name: '保存' }

console.log('=== M-04 正控：此刻快照与委派一致 ⇒ 放行 ===')
{
  const v = revalidateAgainstSnapshot(thenSnapshot, req)
  check('一致时放行', v.ok, JSON.stringify(v))
  check('解析出的动作用的是**此刻**读数', v.ok && v.action.kind === 'click', JSON.stringify(v.ok ? v.action : v))
}

console.log('\n=== M-03 ★★★ 过期快照：用户已经切窗口 ⇒ 必须拒绝 ===')
{
  // 用户切到了浏览器 —— 核心那个"记事本/序号3"现在是**过期**的
  const nowSnapshot = snapshot('浏览器 - GitHub', [{
    name: '记事本',
    elements: [{ index: 1, name: '编辑菜单', actionable: true }, { index: 3, name: '保存', actionable: true }],
  }])
  const v = revalidateAgainstSnapshot(nowSnapshot, req)
  check('★ 非前台窗口被拒', !v.ok && v.rejection === 'executor_window_not_foreground',
    `rejection=${v.ok ? '(放行了!)' : v.rejection}`)
  check('拒绝里带上前台窗口名（诊断"点错哪扇窗"）', !v.ok && (v.detail ?? '').startsWith('active='),
    `detail=${v.ok ? '-' : v.detail}`)
}

console.log('\n=== M-03b ★ 同一扇窗，但序号漂了（列表刷新）⇒ 必须拒绝 ===')
{
  const nowSnapshot = snapshot('记事本', [{
    name: '记事本',
    // 序号 3 现在是"撤销"，不是"保存"了
    elements: [{ index: 1, name: '编辑菜单', actionable: true }, { index: 3, name: '撤销', actionable: true }],
  }])
  const v = revalidateAgainstSnapshot(nowSnapshot, req)
  check('控件名对不上 ⇒ 拒', !v.ok && v.rejection === 'executor_control_renamed',
    `rejection=${v.ok ? '(放行了!)' : v.rejection}`)
  check('拒绝里说出此刻是什么', !v.ok && (v.detail ?? '').includes('撤销'), `detail=${v.ok ? '-' : v.detail}`)
}

console.log('\n=== M-03c 窗口没了 / 序号没了 / 不可操作 ⇒ 逐条拒 ===')
{
  const gone = revalidateAgainstSnapshot(snapshot('记事本', []), req)
  check('窗口已关', !gone.ok && gone.rejection === 'executor_window_gone', `rejection=${gone.ok ? '-' : gone.rejection}`)

  const moved = revalidateAgainstSnapshot(
    snapshot('记事本', [{ name: '记事本', elements: [{ index: 1, name: '编辑菜单', actionable: true }] }]), req)
  check('序号消失', !moved.ok && moved.rejection === 'executor_index_moved', `rejection=${moved.ok ? '-' : moved.rejection}`)

  const locked = revalidateAgainstSnapshot(
    snapshot('记事本', [{ name: '记事本', elements: [{ index: 7, name: '密码', actionable: false }] }]),
    { action: 'click', window: '记事本', index: 7, name: '密码' })
  check('密码字段永远不可操作', !locked.ok && locked.rejection === 'executor_control_not_actionable',
    `rejection=${locked.ok ? '(放行了!)' : locked.rejection}`)
}

console.log('\n=== 闭集与缺名 ===')
{
  const bogus = revalidateAgainstSnapshot(thenSnapshot, { action: 'format_disk', window: '记事本', index: 3 })
  check('闭集外的动作被拒', !bogus.ok && bogus.rejection === 'executor_action_not_allowed',
    `rejection=${bogus.ok ? '(放行了!)' : bogus.rejection}`)

  const noWin = revalidateAgainstSnapshot(thenSnapshot, { action: 'click', index: 3 })
  check('没给窗口名 ⇒ 没有可核对的东西 ⇒ 拒', !noWin.ok && noWin.rejection === 'executor_window_unspecified',
    `rejection=${noWin.ok ? '(放行了!)' : noWin.rejection}`)

  const emptyWin = revalidateAgainstSnapshot(thenSnapshot, { action: 'click', window: '', index: 3 })
  check('空窗口名被拒', !emptyWin.ok && emptyWin.rejection === 'executor_window_unspecified',
    `rejection=${emptyWin.ok ? '(放行了!)' : emptyWin.rejection}`)
}

console.log('\n=== 核对顺序：前台优先于"窗��还在吗" ===')
{
  // 那扇窗已经不在了，同时前台也是别的 —— 报哪个？
  const v = revalidateAgainstSnapshot(snapshot('浏览器', []), req)
  check('★ 先报"不是前台"（不是"窗没了"）', !v.ok && v.rejection === 'executor_window_not_foreground',
    `rejection=${v.ok ? '-' : v.rejection}`)
}

console.log('\n=== type 动作：正文走核验过的那一步，不被核对改写 ===')
{
  const v = revalidateAgainstSnapshot(thenSnapshot,
    { action: 'type', window: '记事本', index: 3, name: '保存', content: '晚上八点开会' })
  check('type 放行', v.ok, JSON.stringify(v.ok ? v.action : v))
  check('★ 正文逐字保留', v.ok && v.action.content === '晚上八点开会', `content=${v.ok ? v.action.content : '-'}`)
  // ⚠️ 窗口名在 `window`，**不是** `name`（第一版把窗口名塞进 name 是**错的**：
  //    执行端的 `execute(action)` 只有这一个对象，没有第二份参数来源，
  //    不带齐 window+index 它就点不了）。
  check('窗口名在 `window`（取自此刻读数）', v.ok && v.action.window === '记事本', `window=${v.ok ? v.action.window : '-'}`)
  check('★ `index` 也在（否则执行端无从下手）', v.ok && v.action.index === 3, `index=${v.ok ? v.action.index : '-'}`)
  check('`name` 是**控件名**不是窗口名', v.ok && v.action.name === '保存', `name=${v.ok ? v.action.name : '-'}`)
}

console.log('\n=== 这一层**不**评估风险（线上没额度可评估）===')
{
  const v = revalidateAgainstSnapshot(thenSnapshot, req)
  check('返回里不含任何额度字段', v.ok && !Object.keys(v.action).some((k) => /risk|budget|level/i.test(k)),
    `keys=${v.ok ? Object.keys(v.action).join(',') : '-'}`)
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
console.log(`⚠️ 本门只证核对逻辑；M-03/M-04 的**真机档**（真开窗口、真点鼠标、需人在场）仍 NOT RUN。`)
process.exit(fail === 0 ? 0 : 1)
