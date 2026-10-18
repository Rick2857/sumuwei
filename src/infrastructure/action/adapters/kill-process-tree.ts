/**
 * 跨平台**杀进程树**（2026-10-16 · 服务器部署 Linux 适配）。
 *
 * ============================================================================
 *  为什么这个模块存在（一个会让服务器上核心崩掉的问题）
 * ============================================================================
 *
 * 四个产品适配器原先各自写了一份同名函数，形状都是：
 *
 * ```text
 *   try   spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
 *   catch  —— 空处理，注释写着"杀不掉也不能让父进程崩"
 * ```
 *
 * ⚠️ **那个 `try/catch` 是无效防护**：`child_process.spawn` 找不到可执行文件时
 *    **不抛同步异常**，而是**异步**在子进程对象上发 `'error'` 事件；
 *    没有监听器 ⇒ Node 把它当未捕获异常 ⇒ **整个核心进程崩掉**。
 *
 * ⚠️ 在 Windows 上这个洞被"命令存在"掩盖着，所以从来没暴露。
 *    **服务器是 Linux ⇒ 一次 `math.calculate` / `office.generate` / `document.read`
 *    超时就会打崩核心。** 这正是部署清单第 ① 条说的"仍使用 taskkill 的工具超时清理"。
 *
 * ============================================================================
 *  两条纪律（先例：L-QQP 那批「失败只回具名码」的修法）
 * ============================================================================
 *
 * ① **这个函数永远不抛。** 超时清理发生在错误路径上，
 *    在那里抛第二个异常会把"超时"变成"崩溃"，那是更坏的形状。
 * ② **判定不是"杀干净了"，而是"父进程不等它"。** 杀不掉要如实放过。
 */

import { spawn, type ChildProcess } from 'node:child_process'

/**
 * 杀掉一个子进程**及其子孙**，尽力而为，**永不抛**。
 *
 * @param child 目标子进程。传 `undefined` / 没有 pid 时什么都不做。
 * @returns 用了哪条路径（**只用于读数与门**，不用于判定成败）。
 */
export type KillTreeRoute = 'no_pid' | 'win32_taskkill' | 'posix_group' | 'posix_child' | 'win32_fallback_child'

export function killProcessTree(child: ChildProcess | undefined): KillTreeRoute {
  const pid = child?.pid
  if (child === undefined || pid === undefined) return 'no_pid'

  if (process.platform === 'win32') {
    /*
     * Windows：`/T` = 连子孙一起，`/F` = 强杀。
     * ⚠️ 关键：`taskkill` **自己**也可能不存在或被策略拦住 ⇒ 必须挂 `'error'`，
     *    否则**这个监听器本身就是新的崩溃点**（与被替换掉的那段同一个坑）。
     */
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => { safeKill(child) })
      return 'win32_taskkill'
    } catch {
      safeKill(child)
      return 'win32_fallback_child'
    }
  }

  /*
   * POSIX：
   * · 子进程是**自建进程组组长**（spawn 时 `detached: true`）⇒ 杀 `-pid` 能带走整棵树，
   *   这与 Windows 上 `/T` 的意图**逐条对得上**。
   * · 否则只杀直接子进程。**刻意不做"盲杀 -pid"**：没有 detached 时 pid 不是组长，
   *   `process.kill(-pid)` 要么打不中、要么打到**不相干的进程组**。
   *   ⇒ 宁可少杀，不可误杀（误杀 = 杀掉服务器上别人的进程）。
   */
  if (childConstructorWasDetached(child)) {
    try {
      process.kill(-pid, 'SIGKILL')
      return 'posix_group'
    } catch {
      // 组不存在或无权限 ⇒ 退到只杀直接子进程
    }
  }
  safeKill(child)
  return 'posix_child'
}

/** `child.kill()` 的安全包装：它**自己**也可能抛（ESRCH / EPERM）。 */
function safeKill(child: ChildProcess): void {
  try {
    child.kill('SIGKILL')
  } catch {
    /* 纪律 ②：杀不掉就放过 */
  }
}

/**
 * 这个子进程是不是**自建进程组组长**（即 spawn 时带了 `detached: true`）。
 *
 * ⚠️ Node 的 ChildProcess **没有公开这个标志**，所以只能间接判断：
 *    组长进程的 `pid` 就是它的进程组 id（POSIX 语义）。
 *    用 `kill(-pid, 0)` 探一次：**只探测、不投递信号**（信号 0 不杀进程）。
 */
function childConstructorWasDetached(child: ChildProcess): boolean {
  const pid = child.pid
  if (pid === undefined || pid <= 1) return false
  try {
    // 信号 0 = 只做权限/存在性检查。若 -pid 这个组存在，它就是组长。
    process.kill(-pid, 0)
    return true
  } catch {
    return false
  }
}
