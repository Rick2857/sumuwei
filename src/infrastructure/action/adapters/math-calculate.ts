/**
 * `math.calculate` 适配器（计划书 §3.1「精确计算」/ §1 首版能力第 1 项）。
 *
 * ============================================================================
 *  它做什么、不做什么
 * ============================================================================
 * ```text
 * 做    把用户给的**受限算式**交给可终止的独立执行器，取回程序结果
 * 不做  任意程序执行 / shell / 网络 / 文件 / 单位换算 / 统计 / 矩阵
 * ```
 * 安全判断**不在本文件**：全部在 `src/kernel/action/restricted-math.ts`
 * （AST 类型白名单 + 函数名白名单 + 节点数/深度/整数幂指数上限 + 有限性/结果长度）。
 * 本文件只负责三件工程事实：
 *   ① 把算式放进一个**能杀掉**的子进程，2 秒不返回就终结它（且记 `timeout`，**不是** success）
 *   ② 把结果翻译成 `TurnContent`（`kind: 'calculation'`）—— 含算式、精确值、展示文本、
 *      有效数字位数、是否有限精度、节点数/深度
 *   ③ 失败时归一成 `ActionFailure`（**没有半截答案**：拒绝就是拒绝）
 *
 * ⚠️ 结果**不写长期记忆**：`TurnContent` 是当轮内存载体（`action-result.ts` 的类型边界）。
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { actionFailure, ActionFailureError } from '../../../kernel/action/errors.ts'
import type {
  AdapterExecuteInput,
  AdapterOutcome,
  CapabilityAdapter,
} from '../../../kernel/action/executor-port.ts'
import { stringArg } from '../../../kernel/action/executor-port.ts'
import {
  MATH_CALCULATE,
  MATH_CALCULATE_OPERATION,
} from '../../../kernel/action/utility-capabilities.ts'
/*
 * ⚠️ 只 import **契约**模块（不 import mathjs）：父进程这一侧因此不装载 mathjs，
 *    真正求值的 mathjs 只在 `math-calculate-worker.ts` 那个子进程里装载。
 *    这是计划书 §2 第 5 点「关闭时不加载重组件」的落点。
 */
import {
  RESTRICTED_MATH_LIMITS,
  type RestrictedMathOutcome,
} from '../../../kernel/action/restricted-math-contract.ts'
import type { CalculationTurnContent, TurnContent } from '../../../kernel/contracts/turn-content.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 可终止执行器的入口（TS；Node 22 原生剥离类型，避免加载 tsx 占用求解时限） */
const WORKER_ENTRY = join(HERE, 'math-calculate-worker.ts')

export interface MathCalculateOptions {
  /** 求解墙钟上限（缺省 2000ms，计划书 §3.1） */
  timeoutMs?: number
  /** 测试注入点：换成别的执行器实现（**不改变生产缺省**） */
  runWorker?: (input: { expression: string; timeoutMs: number }) => Promise<RestrictedMathOutcome>
}

interface WorkerReading {
  outcome: RestrictedMathOutcome | null
  timedOut: boolean
  exitCode: number | null
  ms: number
  stderr: string
}

/**
 * 默认执行器：Node 22 原生剥离类型 + 2 秒硬超时 + **杀掉进程树**。
 *
 * ⚠️ Windows 上 `child.kill()` 只杀直接子进程，因此用 `taskkill /T /F`
 *    把整棵树带走。这不是洁癖：留下一个仍在算的孙进程等于"超时"这件事没有被真的执行。
 */
async function runWorkerProcess(input: {
  expression: string
  timeoutMs: number
}): Promise<WorkerReading> {
  const startedAt = Date.now()
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', WORKER_ENTRY],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
  )

  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  child.stdin.write(`${JSON.stringify({ expression: input.expression })}\n`)
  child.stdin.end()

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child.pid)
  }, input.timeoutMs)

  const exitCode = await new Promise<number | null>((resolvePromise) => {
    child.on('close', (code) => resolvePromise(code))
    child.on('error', () => resolvePromise(null))
  })
  clearTimeout(timer)

  const line = stdout.trim().split('\n').filter((l) => l.trim() !== '').pop()
  let outcome: RestrictedMathOutcome | null = null
  if (line !== undefined && line.startsWith('{')) {
    try {
      outcome = JSON.parse(line) as RestrictedMathOutcome
    } catch {
      outcome = null
    }
  }
  return { outcome, timedOut, exitCode, ms: Date.now() - startedAt, stderr }
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } catch {
    /* 杀不掉也不能让父进程崩：真正的判据是"父进程不等它" */
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function createMathCalculateAdapter(
  options: MathCalculateOptions = {}
): CapabilityAdapter {
  const timeoutMs = options.timeoutMs ?? RESTRICTED_MATH_LIMITS.timeoutMs

  return {
    capabilityId: MATH_CALCULATE,
    async execute(input: AdapterExecuteInput): Promise<AdapterOutcome> {
      const expression = stringArg(input.args, 'expression')
      if (expression === undefined || expression.trim() === '') {
        throw new ActionFailureError(
          actionFailure('validation_failed', '没有给出要计算的算式')
        )
      }

      const run =
        options.runWorker ??
        (async (request: { expression: string; timeoutMs: number }) => {
          const reading = await runWorkerProcess(request)
          if (reading.timedOut) {
            throw new ActionFailureError(
              actionFailure(
                'timeout',
                `受限计算在 ${String(request.timeoutMs)}ms 内没有返回，执行器已被终结`
              )
            )
          }
          if (reading.outcome === null) {
            throw new ActionFailureError(
              actionFailure(
                'execution_failed',
                `计算执行器没有给出可解析的结果（exit=${String(reading.exitCode)}）`
              )
            )
          }
          return reading.outcome
        })

      const outcome = await run({ expression, timeoutMs })

      if (!outcome.ok) {
        /*
         * ⚠️ 拒绝**不**返回半截答案，也**不**返回 content：
         *    "结果太大"截成一个貌似完整的答案是最坏的一种（计划书 §3.1）。
         *    状态由失败码决定（`validation_failed` → `rejected`）。
         */
        throw new ActionFailureError(
          actionFailure('validation_failed', `算式未被接受：${outcome.detail}`)
        )
      }

      /*
       * ⚠️ 真实事故（本批实测，2026-10-04）：第一版把 `scope` 记成**结果值**的长度，
       *    而 `text` 是 `算式 = 结果` —— 于是契约断言（`includedChars === text.length`）
       *    立刻响，19 条用例里 6 条"算对了但内容不合法"。
       *    正确的读法是：`scope` 描述**这一份内容文本本身**取了多少（结果值多长算结构事实，
       *    写进 `facts`）。这也是那条断言存在的意义：它逼着实现说清"实际入模的是哪一段文本"。
       */
      const text = `${expression} = ${outcome.display}`
      const content: CalculationTurnContent = {
        contentId: `${String(input.actionId)}:calculation`,
        kind: 'calculation',
        capability: MATH_CALCULATE,
        operation: MATH_CALCULATE_OPERATION,
        sourceKind: 'program-calculation',
        resultFingerprint: sha256(`${expression}=${outcome.value}`),
        scope: {
          totalChars: text.length,
          includedChars: text.length,
          truncated: false,
        },
        facts: [
          `算式：${expression}`,
          `结果字符数：${String(outcome.value.length)}`,
          `有效数字：${String(outcome.precision)} 位`,
          outcome.approx ? '结果按有限精度给出（除法/开方）' : '结果为精确十进制值',
          `AST 节点数：${String(outcome.nodeCount)}`,
          `AST 深度：${String(outcome.depth)}`,
          ...(outcome.maxIntExponentUsed > 0
            ? [`最大整数幂指数：${String(outcome.maxIntExponentUsed)}`]
            : []),
          '由本地受限计算器求出（不是模型心算）',
        ],
        text,
        expression,
        value: outcome.value,
        display: outcome.display,
        precision: outcome.precision,
        approx: outcome.approx,
      }

      const turnContent: TurnContent[] = [content]
      return {
        effect: {
          kind: 'none',
          /*
           * ⚠️ **effect.detail 里不放算式、也不放结果**（实测发现，2026-10-04）：
           *    它落进账本，而账本只允许"引用 / 指纹 / 计数 / 状态"（计划书 §2 第 2 点）。
           *    算式本身作为**请求参数**进账本是可以的（`arguments.expression` —— 它就是"用户
           *    要求算的那个东西"，与 `web.read` 的 URL、`document.read` 的路径同属"引用"），
           *    但**结果正文**只能活在当轮内存与可裁 section 里。
           */
          detail: `受限计算：${outcome.approx ? 'approx' : 'exact'} nodes=${String(outcome.nodeCount)}`,
          fingerprint: content.resultFingerprint,
        },
        evidence: [
          {
            kind: 'adapter',
            detail:
              `受限计算 ${outcome.approx ? 'approx' : 'exact'} ` +
              `nodes=${String(outcome.nodeCount)} depth=${String(outcome.depth)}`,
            ref: String(input.actionId),
          },
        ],
        turnContent,
      }
    },
  }
}
