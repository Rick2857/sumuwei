/**
 * killProcessTree 的 POSIX 进程组分支验证（服务器 Linux 专用）
 *
 * ⚠️ 这道门在 Windows 上永远是 `not_verified` —— 它必须真的 fork 出**子孙进程**
 *    才能证伪"杀整棵树"，光看代码看不出来。
 *
 * 覆盖两条：
 *   D-P1  detached: true  ⇒ 必须走 posix_group，且**子孙一起死**
 *   D-P2  detached: false ⇒ 必须走 posix_child，且**只杀直接子进程，子孙活着**
 *                          （这条是**负控**：证明它没有盲杀 -pid 误伤别人的进程组）
 */
import { spawn } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killProcessTree, type KillTreeRoute } from '../../src/infrastructure/action/adapters/kill-process-tree.ts'

const WORK = mkdtempSync(join(tmpdir(), 'lg-killtree-'))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    pass += 1
    console.log(`  PASS  ${name}  ${detail}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}  ${detail}`)
  }
}

/** 子进程脚本：自己 spawn 一个孙进程，然后两个都睡到被杀 */
const CHILD_SRC = `
const { spawn } = require('node:child_process')
const { writeFileSync } = require('node:fs')
const grand = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' })
writeFileSync(process.env.LG_GRANDCHILD_FILE, String(grand.pid))
writeFileSync(process.env.LG_CHILD_FILE, String(process.pid))
setTimeout(() => {}, 60000)
`

async function spawnTree(detached: boolean): Promise<{ child: ReturnType<typeof spawn>; childPid: number; grandPid: number }> {
  const childFile = join(WORK, `child-${detached}.pid`)
  const grandFile = join(WORK, `grand-${detached}.pid`)
  const child = spawn(process.execPath, ['-e', CHILD_SRC], {
    stdio: 'ignore',
    detached,
    env: { ...process.env, LG_CHILD_FILE: childFile, LG_GRANDCHILD_FILE: grandFile },
  })
  // 等两个 pid 文件都写出来
  for (let i = 0; i < 60; i += 1) {
    try {
      const { readFileSync, existsSync } = await import('node:fs')
      if (existsSync(childFile) && existsSync(grandFile)) {
        return {
          child,
          childPid: Number(readFileSync(childFile, 'utf8')),
          grandPid: Number(readFileSync(grandFile, 'utf8')),
        }
      }
    } catch { /* 还没写出来 */ }
    await sleep(100)
  }
  throw new Error('子孙 pid 文件没出现')
}

console.log('=== killProcessTree POSIX 进程组分支 ===')
console.log(`  platform = ${process.platform}`)

if (process.platform !== 'linux' && process.platform !== 'darwin') {
  console.log(`  SKIP  本轮平台是 ${process.platform}，POSIX 分支无法验证`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
console.log('\n--- D-P1 正控：detached: true ⇒ 整棵树一起死 ---')
{
  const { child, childPid, grandPid } = await spawnTree(true)
  console.log(`  子 pid=${childPid}  孙 pid=${grandPid}`)
  const beforeChild = alive(childPid)
  const beforeGrand = alive(grandPid)
  check('正控前置：两个进程都活着', beforeChild && beforeGrand, `child=${beforeChild} grand=${beforeGrand}`)

  const route: KillTreeRoute = killProcessTree(child)
  check('返回 posix_group', route === 'posix_group', `实际=${route}`)

  await sleep(600)
  check('直接子进程已死', !alive(childPid), `alive=${alive(childPid)}`)
  check('★ 孙进程也死了（这才是"树"）', !alive(grandPid), `alive=${alive(grandPid)}`)
}

// ---------------------------------------------------------------------------
console.log('\n--- D-P2 负控：detached: false ⇒ 只杀直接子，孙子必须活着 ---')
{
  const { child, childPid, grandPid } = await spawnTree(false)
  console.log(`  子 pid=${childPid}  孙 pid=${grandPid}`)

  const route: KillTreeRoute = killProcessTree(child)
  check('返回 posix_child（没有盲杀 -pid）', route === 'posix_child', `实际=${route}`)

  await sleep(600)
  check('直接子进程已死', !alive(childPid), `alive=${alive(childPid)}`)
  check('★ 孙进程**仍然活着**（证明没误杀整个进程组）', alive(grandPid), `alive=${alive(grandPid)}`)

  // 清理：负控刻意留了活着的孙进程，不收尾会泄漏
  try {
    process.kill(grandPid, 'SIGKILL')
  } catch { /* 已经没了 */ }
}

// ---------------------------------------------------------------------------
console.log('\n--- D-P3 永不抛：传 undefined / 无 pid ---')
{
  let threw = false
  let r1: KillTreeRoute = 'no_pid'
  try {
    r1 = killProcessTree(undefined)
  } catch {
    threw = true
  }
  check('killProcessTree(undefined) 返回 no_pid 且不抛', !threw && r1 === 'no_pid', `route=${r1} threw=${threw}`)
}

console.log(`\n合计：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
