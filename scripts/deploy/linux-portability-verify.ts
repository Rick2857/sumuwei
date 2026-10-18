/**
 * 部署前 · Linux 可移植性与诊断层判据（2026-10-16 新增）
 *
 * ============================================================================
 *  它守的是本轮改过的两件事
 * ============================================================================
 *
 * **① 工具超时清理的跨平台化**
 *
 * 改之前：`math-calculate` / `office-generate` / `document-read` 各自写了一份
 * `try { spawn('taskkill', …) } catch {}`。
 *
 * ⚠️ 那个 `try/catch` **接不到** `spawn` 找不到命令时发的**异步** `'error'` 事件
 *    ⇒ 没有监听器时 Node 把它当未捕获异常 ⇒ **整个核心进程崩掉**。
 *    Windows 上因为 `taskkill` 恰好存在而从未暴露；**Linux 上一次工具超时就可能崩核心**。
 *
 * **② 自动记忆失败的具名诊断层**
 *
 * 改之前：`invokeWorker` 把四种失败压成同一个错误串（且分不清超时与取消），
 * python stderr 被丢弃，`automatic-memory.ts` 用 `catch {}` 把结果也丢了
 * ⇒ 三层信息塌陷 ⇒ 容量测试里那 2 个失败"定位不了"。
 *
 * ============================================================================
 *  三段式（正控 / 负控 / 恢复），缺一段都不算通过
 * ============================================================================
 *
 * · **正控**：真的起一棵进程树，`killProcessTree()` 之后**父子都得死**。
 * · **负控**：**证明旧写法真的会崩** —— 在隔离子进程里跑
 *   `spawn(<不存在的命令>)` 且**不挂** `'error'` 监听器，断言它**非零退出**。
 *   ⇒ 没有这条，"修好了"就只是一句没有证据的话。
 * · **恢复**：杀掉树之后，**本门自己还活着**（旧写法的受害者正是门进程本身）。
 *
 * ⚠️ **平台诚实**：本门在 Windows 与 Linux 上都能跑，但**一次只验到一条路径**。
 *    读数里逐字写明本轮**实测**的是哪条，另一条标 `not_verified`。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { killProcessTree, type KillTreeRoute } from '../../src/infrastructure/action/adapters/kill-process-tree.ts'
import { automaticMemoryFailureCauseOf, type AutomaticMemoryFailureCause } from '../../src/infrastructure/runtime/automatic-memory.ts'
import { LangMemWorkerFailure, invokeWorker, type LangMemWorkerFailureReason } from '../../src/infrastructure/model/langmem-memory-extractor.ts'
import { composeJobError } from '../../src/infrastructure/persistence/job-store.ts'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SRC = join(REPO, 'src')

let checks = 0
let failures = 0
const unverified: string[] = []

function check(id: string, passed: boolean, reading: string): void {
  checks += 1
  if (passed) {
    console.log(`  PASS ${id.padEnd(6)} ${reading}`)
  } else {
    failures += 1
    console.log(`  FAIL ${id.padEnd(6)} ${reading}`)
  }
}

function section(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
}

/** 递归列出 `src/` 下的 .ts 文件（排除测试与门脚本）。 */
function tsFilesIn(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) tsFilesIn(full, acc)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) acc.push(full)
  }
  return acc
}

// ============================================================================
section('① 静态：产品代码里不再有 taskkill 调用')
// ============================================================================

/*
 * ⚠️ 判据纪律（`L-QQP-09`：本仓库已经因为"全文按词找"被自己的注释打败过三次）。
 *
 *   这里**刻意不按文本找**。第一版写的是正则 `spawn\(\s*['"\`]taskkill['"\`]`
 *   —— 结果它把我自己写在新注释里的那句"本地这份 spawn('taskkill') 已删除"判成了命中，
 *   外加把**合法**的那一处（共享助手自己）也判成了命中。
 *
 *   ⇒ 改用 **TypeScript 自己的解析器**走 AST，只找真正的 `CallExpression`。
 *   注释、字符串、文档里的字样**结构上不可能**命中。
 */
function taskkillCallSites(root: string, ts: typeof import('typescript')): string[] {
  const hits: string[] = []
  for (const file of tsFilesIn(root)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true)
    const visit = (node: import('typescript').Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'spawn'
        && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0]!)
        && node.arguments[0]!.text.toLowerCase() === 'taskkill') {
        hits.push(file.replace(REPO, ''))
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return hits
}

const ts = (await import('typescript')).default
const taskkillSites = taskkillCallSites(SRC, ts)
// 共享助手是**唯一合法**的一处：它就是那个平台分支本身。
const offenders = taskkillSites.filter((f) => !f.endsWith('kill-process-tree.ts'))
check('S1', offenders.length === 0,
  offenders.length === 0
    ? `src/ 下真正调用 spawn('taskkill') 的地方**只剩共享助手那 1 处**（AST 判据，共扫 ${tsFilesIn(SRC).length} 个 .ts）`
    : `这些文件仍在直接调用 taskkill：${offenders.join(', ')}`)
check('S1b', taskkillSites.length === 1,
  `taskkill 调用点总数 = ${String(taskkillSites.length)}（应当恰好 1：共享助手里的平台分支）`)

const helpers = ['math-calculate.ts', 'office-generate.ts', 'document-read.ts']
const missingHelperUse = helpers.filter((name) => {
  const text = readFileSync(join(SRC, 'infrastructure/action/adapters', name), 'utf8')
  return !text.includes('killProcessTree')
})
check('S2', missingHelperUse.length === 0,
  missingHelperUse.length === 0
    ? `三个适配器都调用了共享助手（${helpers.join(', ')}）`
    : `这些适配器没调用共享助手：${missingHelperUse.join(', ')}`)

check('S3', existsSync(join(SRC, 'infrastructure/action/adapters/kill-process-tree.ts')),
  '共享助手文件存在（逻辑只有一处）')

// ---- S4：每个 Python 入口都必须有 env 覆盖口 -------------------------------
/*
 * 为什么这条要单列：`arxiv.ts` 原来硬编码 `Scripts/python.exe` 且**没有任何覆盖口**
 * ⇒ 在 Linux 上 `arxiv` 一调必失败。而 `rapid-ocr` / `desktop` 早就有覆盖口。
 * 这是"同一类缺陷只漏了一处"的形状，**结构判据**比"再读一遍代码"可靠。
 *
 * 判据走 AST：找 `process.env.<NAME>` 这样的属性访问节点 —— 注释里写名字不会命中。
 */
function envReadsIn(file: string, ts: typeof import('typescript')): Set<string> {
  const names = new Set<string>()
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true)
  const visit = (node: import('typescript').Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'process'
      && ts.isIdentifier(node.expression.name) && node.expression.name.text === 'env'
      && ts.isIdentifier(node.name)) {
      names.add(node.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return names
}

const pythonEntrypoints: ReadonlyArray<{ file: string; override: string; why: string }> = [
  { file: join(SRC, 'infrastructure/action/adapters/arxiv.ts'),
    override: 'PROJECT_LG_ARXIV_PYTHON', why: 'arXiv 论文检索（服务器上要跑）' },
  { file: join(SRC, 'infrastructure/action/adapters/rapid-ocr-assets.ts'),
    override: 'PROJECT_LG_RAPIDOCR_PYTHON', why: 'OCR（服务器上要跑）' },
  { file: join(SRC, 'infrastructure/action/adapters/desktop-control-assets.ts'),
    override: 'PROJECT_LG_DESKTOP_PYTHON', why: '桌面控制（本机跑，服务器上关闭）' },
]
const missingOverride = pythonEntrypoints
  .filter((e) => !envReadsIn(e.file, ts).has(e.override))
  .map((e) => `${e.why}（${e.override}）`)
check('S4', missingOverride.length === 0,
  missingOverride.length === 0
    ? `${String(pythonEntrypoints.length)} 个 Python 入口全部有 env 覆盖口（AST 判据）`
    : `这些 Python 入口**没有** env 覆盖口，在 Linux 上无法重定向：${missingOverride.join('、')}`)

// ---- S5：不再有"光秃秃"的 Windows python 形状 ------------------------------
/*
 * ⚠️⚠️ 复核 §4 指出第一版这里给了**假绿**：它只找**单个字符串字面量**里的
 * `Scripts/python.exe`，**看不见分段 `join(…,'Scripts','python.exe')`** ——
 * 而 `document-read.ts` 与 `office-generate.ts` 恰恰都是分段写法。
 *
 * 现在改成找**字面量本身**（`'Scripts'` 或 `'python.exe'` 各自单独出现），
 * 再看它所在的那条声明**有没有**按平台挑形状（`process.platform`）。
 */
const bareWindowsPython: string[] = []
for (const file of tsFilesIn(SRC)) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true)
  const visit = (node: import('typescript').Node): void => {
    if (ts.isStringLiteralLike(node) && (node.text === 'Scripts' || node.text === 'python.exe')) {
      // 往上找最近的一条变量声明，看它有没有按平台挑形状
      let decl: import('typescript').Node = node
      while (decl !== undefined && decl.parent !== undefined
        && !ts.isVariableDeclaration(decl.parent) && !ts.isPropertyDeclaration(decl.parent)) {
        decl = decl.parent
      }
      const owner = decl.parent ?? decl
      const text = owner.getText()
      const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
      if (!text.includes('process.platform')) {
        bareWindowsPython.push(`${file.replace(REPO, '')}:${String(line)}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
check('S5', bareWindowsPython.length === 0,
  bareWindowsPython.length === 0
    ? '产品代码里每个 Windows 解释器形状都处在"按平台挑"的声明里（含分段 join）'
    : `这些写死的 Windows 解释器片段**没有**按平台挑形状：${bareWindowsPython.join(', ')}`)

const docPythonEntrypoints: ReadonlyArray<{ file: string; override: string; why: string }> = [
  { file: join(SRC, 'infrastructure/action/adapters/arxiv.ts'), override: 'PROJECT_LG_ARXIV_PYTHON', why: 'arXiv' },
  { file: join(SRC, 'infrastructure/action/adapters/rapid-ocr-assets.ts'), override: 'PROJECT_LG_RAPIDOCR_PYTHON', why: 'OCR' },
  { file: join(SRC, 'infrastructure/action/adapters/desktop-control-assets.ts'), override: 'PROJECT_LG_DESKTOP_PYTHON', why: '桌面控制' },
  { file: join(SRC, 'infrastructure/action/adapters/document-read.ts'), override: 'PROJECT_LG_DOC_PYTHON', why: '文档读取' },
  { file: join(SRC, 'infrastructure/action/adapters/office-generate.ts'), override: 'PROJECT_LG_OFFICE_PYTHON', why: 'Office 生成' },
]
const missingOverride2 = docPythonEntrypoints
  .filter((e) => !envReadsIn(e.file, ts).has(e.override))
  .map((e) => `${e.why}（${e.override}）`)
check('S6', missingOverride2.length === 0,
  missingOverride2.length === 0
    ? `${String(docPythonEntrypoints.length)} 个 Python 入口全部有 env 覆盖口`
    : `这些 Python 入口**没有** env 覆盖口：${missingOverride2.join('、')}`)

// ============================================================================
section('② 行为：正控 / 负控 / 恢复')
// ============================================================================

const work = mkdtempSync(join(tmpdir(), 'lg-linux-portability-'))

/** 这个子脚本起一棵"父 → 孙"两层进程树，把两个 pid 写进文件，然后父进程一直等。 */
const grandchildScript = `
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const out = process.argv[1]
const kid = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' })
fs.writeFileSync(out, JSON.stringify({ parent: process.pid, child: kid.pid }))
setTimeout(() => {}, 600000)
`

// ---- 正控 ------------------------------------------------------------------
const pidFile = join(work, 'pids.json')
const tree = spawn(process.execPath, ['-e', grandchildScript, pidFile], {
  stdio: 'ignore',
  /*
   * ⚠️ 复核 §5：夹具**必须**带 `detached`，否则在 Linux 上走的是 `posix_child`
   *   （只杀直接子进程，孙进程会留下）⇒ 那不是产品实现坏了，**是夹具没走产品那条分支**。
   *   第一版漏了它，于是这道门在 Linux 上会假失败，而本机（Windows）却看不出来。
   * ⚠️ win32 上不带 detached：**`detached: true` 会改变子进程存活语义**（可能变孤儿），
   *   与四个产品适配器保持同一取舍。
   */
  detached: process.platform !== 'win32',
})
await new Promise((r) => setTimeout(r, 1200))

let route: KillTreeRoute = 'no_pid'
let grandchildGone = false
let parentGone = false
if (existsSync(pidFile)) {
  const { parent, child } = JSON.parse(readFileSync(pidFile, 'utf8')) as { parent: number; child: number }
  route = killProcessTree(tree)
  await new Promise((r) => setTimeout(r, 1500))
  const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
  parentGone = !alive(parent)
  grandchildGone = !alive(child)
}
check('B1', parentGone, `正控：父进程已死（route=${route}）`)
check('B2', grandchildGone, `正控：**孙进程**也已死 —— 这才是 "/T" 与进程组的等价物`)

// ---- 负控：证明旧写法真的会崩 ------------------------------------------------
/*
 * ⚠️ 这条必须在**隔离子进程**里跑：旧写法的后果正是"进程崩溃"，
 *    在门进程里复现它 = 把门自己弄崩。
 */
const oldPattern = `
const { spawn } = require('node:child_process')
try { spawn('definitely-not-a-real-binary-9d2f', { stdio: 'ignore' }) } catch { /* 旧写法以为接得住 */ }
setTimeout(() => {}, 3000)
`
const crashProbe = spawnSync(process.execPath, ['-e', oldPattern], { encoding: 'utf8', timeout: 10_000 })
const crashed = crashProbe.status !== 0
check('B3', crashed,
  crashed
    ? `负控：旧写法**确实崩了**（退出码 ${String(crashProbe.status)}）⇒ 这不是装饰性修复`
    : `负控：旧写法在这个平台上没崩（退出码 ${String(crashProbe.status)}）⇒ 本条不构成证据` +
      `（若在 Windows 上如此属正常：taskkill 存在，洞被掩盖）`)

// ---- 恢复：门自己还活着 ----------------------------------------------------
check('B4', true, '恢复：本门进程在杀掉整棵树之后**仍然存活并跑到了这里**')

if (route === 'posix_group') {
  console.log('  读数：本轮**实测**的是 POSIX 进程组路径。')
} else if (route.startsWith('win32')) {
  console.log('  读数：本轮**实测**的是 Windows taskkill 路径；POSIX 进程组路径在本平台上 not_verified。')
  unverified.push('killProcessTree 的 POSIX 进程组分支（本轮平台不具备）')
} else {
  /*
   * ⚠️ 复核 §5 点名的洞：门原来**不会**把"没命中预期分支"列进未验，
   *   于是一条只在夹具上生效的退化路径会被当成"测过了"。
   */
  console.log(`  ⚠️ 正控走的是 '${route}' —— **不是**预期的组清理路径。`)
  unverified.push(`killProcessTree 正控未命中进程组/任务树路径（route=${route}）`)
}
if (!crashed) unverified.push('旧写法在 win32 上的崩溃复现（taskkill 存在，洞被掩盖）')

try { rmSync(work, { recursive: true, force: true }) } catch { /* 清理失败不判失败 */ }

// ============================================================================
section('③ 自动记忆诊断层：闭集映射与隐私')
// ============================================================================

// ---- composeJobError 三条性质 ---------------------------------------------
check('C1', composeJobError('boom', undefined) === 'boom', '不传 cause ⇒ 逐字不变')
check('C2', composeJobError('boom', 'x') === 'boom:x', '传 cause ⇒ 以 "error:cause" 拼接')
check('C3', composeJobError(undefined, 'x') === undefined, '不传 error ⇒ undefined（写 null）')
check('C4', composeJobError('boom', '') === 'boom', '空串 cause 视同不传（不产生半截串）')

// ---- 每一个 worker 失败原因都要映射到闭集具名码 ----------------------------
const reasonToCause: Record<LangMemWorkerFailureReason, AutomaticMemoryFailureCause> = {
  timeout: 'extractor_worker_timeout',
  cancelled: 'extractor_worker_cancelled',
  exit_nonzero: 'extractor_worker_exit_nonzero',
  spawn_failed: 'extractor_worker_spawn_failed',
  output_over_budget: 'extractor_worker_output_over_budget',
  stdin_failed: 'extractor_worker_stdin_failed',
  aborted: 'extractor_worker_aborted',
}
const mismatched = (Object.keys(reasonToCause) as LangMemWorkerFailureReason[])
  .filter((reason) => automaticMemoryFailureCauseOf(new LangMemWorkerFailure(reason, 1)) !== reasonToCause[reason])
check('C5', mismatched.length === 0,
  mismatched.length === 0
    ? `7 个 worker 失败原因全部映射正确`
    : `映射不对：${mismatched.join(', ')}`)

// ---- 隐私：消息里不许出现用户内容 / stderr ---------------------------------
const failure = new LangMemWorkerFailure('exit_nonzero', 3)
check('C6', failure.message === 'automatic_memory_worker_failed:exit_nonzero:exit=3',
  `失败消息逐字为具名码 + 退出码：${failure.message}`)
check('C7', !/\n|\r|stdout|stderr/.test(failure.message), '失败消息不含换行、不提 stdout/stderr')

// ---- 已知具名错误也要映射 --------------------------------------------------
check('C8', automaticMemoryFailureCauseOf(new Error('automatic_memory_source_budget')) === 'source_budget',
  'source_budget 映射正确')
check('C9', automaticMemoryFailureCauseOf(new Error('late_write_fenced')) === 'late_write_fenced',
  'late_write_fenced 映射正确')

// ---- 兜底必须是"unknown"，不能把异常原文带出去 ----------------------------
const unknownCause = automaticMemoryFailureCauseOf(new Error('sk-very-secret-looking-token'))
check('C10', unknownCause === 'unknown' && !unknownCause.includes('sk-'),
  `未知异常 ⇒ 'unknown'（原文**不外泄**）`)

// ============================================================================
section('④ 真实驱动 invokeWorker：四种失败必须互相可分')
// ============================================================================
/*
 * ⚠️ 复核 §1 指出：上一轮的门只测了**手工构造**的 `LangMemWorkerFailure` 映射表，
 *   **从没驱动过 `invokeWorker` 本身** —— 所以它给出的"映射全对"完全不能证明
 *   分类逻辑是对的。事实上真跑起来第一版就错了两处：
 *   AbortError 被 `child.on('error')` 抢跑标成 spawn_failed；
 *   被信号杀时 `code === null` 又先命中 `code !== 0` 标成 exit_nonzero。
 *
 * ⇒ 这里**真的**把 worker 逼到超时 / 被取消 / 起不来 / 非零退出，
 *   分别断言闭集原因。**这三条必须互相不同**，否则"定位不了"依然存在。
 */

function findPython(): string | undefined {
  const candidates = [
    join(REPO, 'data/runtime/automatic-memory/langmem-48e3c11/.venv',
      process.platform === 'win32' ? join('Scripts', 'python.exe') : join('bin', 'python')),
    ...(process.platform === 'win32' ? [] : ['/usr/bin/python3', '/usr/local/bin/python3']),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  const probe = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'pass'], { stdio: 'ignore' })
  return probe.status === 0 ? (process.platform === 'win32' ? 'python' : 'python3') : undefined
}

const python = findPython()
if (python === undefined) {
  console.log('  ⚠️ 本机找不到可用的 python ⇒ 这一组**未验**（不是通过）')
  unverified.push('invokeWorker 的四种真实失败分类（缺 python 解释器）')
} else {
  const work2 = mkdtempSync(join(tmpdir(), 'lg-worker-classify-'))
  const slow = join(work2, 'slow.py')
  const boom = join(work2, 'boom.py')
  const good = join(work2, 'good.py')
  writeFileSync(slow, 'import time\ntime.sleep(600)\n')
  writeFileSync(boom, 'import sys\nsys.stderr.write("boom\\n")\nsys.exit(3)\n')
  writeFileSync(good, 'print("{\\"ok\\": true}")\n')

  const reasonOf = async (run: () => Promise<string>): Promise<string> => {
    try {
      await run()
      return 'resolved'
    } catch (error) {
      return error instanceof LangMemWorkerFailure ? error.reason : `not-a-worker-failure:${String(error)}`
    }
  }

  const controller = new AbortController()
  setTimeout(() => { controller.abort() }, 200)
  const observed: Record<string, string> = {
    timeout: await reasonOf(() => invokeWorker({ python, workerScript: slow, timeoutMs: 250 }, '{}')),
    cancelled: await reasonOf(() => invokeWorker({ python, workerScript: slow, signal: controller.signal }, '{}')),
    spawn_failed: await reasonOf(() => invokeWorker({ python: 'definitely-not-a-real-python-9d2f', workerScript: slow }, '{}')),
    exit_nonzero: await reasonOf(() => invokeWorker({ python, workerScript: boom }, '{}')),
    success: await reasonOf(() => invokeWorker({ python, workerScript: good }, '{}')),
  }
  for (const [name, value] of Object.entries(observed)) console.log(`    ${name.padEnd(12)} -> ${value}`)

  check('D1', observed.timeout === 'timeout', `真超时 ⇒ '${observed.timeout}'（第一版会误报 spawn_failed / exit_nonzero）`)
  check('D2', observed.cancelled === 'cancelled', `真外部取消 ⇒ '${observed.cancelled}'`)
  check('D3', observed.spawn_failed === 'spawn_failed', `解释器不存在 ⇒ '${observed.spawn_failed}'`)
  check('D4', observed.exit_nonzero === 'exit_nonzero', `非零退出(3) ⇒ '${observed.exit_nonzero}'`)
  check('D5', observed.success === 'resolved', `正常输出 ⇒ '${observed.success}'`)
  const distinct = new Set([observed.timeout, observed.cancelled, observed.spawn_failed, observed.exit_nonzero])
  check('D6', distinct.size === 4,
    `四种失败**互相可分**（不同值 ${String(distinct.size)}/4）—— 这是"定位得了"的最低条件`)
  try { rmSync(work2, { recursive: true, force: true }) } catch { /* 清理失败不判失败 */ }
}

// ============================================================================
section('结论')
// ============================================================================
console.log(`\n合计 ${String(checks)} 项：${String(checks - failures)} 通过 / ${String(failures)} 失败`)
if (unverified.length > 0) {
  console.log('\n⚠️ 本轮**未验**（不是通过，也不是失败）：')
  for (const item of unverified) console.log(`  · ${item}`)
}
console.log(failures === 0 ? '\nPASS' : '\nFAIL')
process.exit(failures === 0 ? 0 : 1)
