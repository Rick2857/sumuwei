/**
 * 受限计算的**可终止执行器**（计划书 §3.1：「计算运行在可终止的独立执行器，
 * 超时后释放进程」）。
 *
 * ============================================================================
 *  为什么要有这个进程
 * ============================================================================
 * mathjs 的求值是**同步**的。同步求值一旦卡住，事件循环被占满 ——
 * 主进程里的任何计时器都**没有机会**触发，"2 秒超时"就变成一句空话。
 * 因此真正的超时只能靠"能杀掉的东西"：本文件是那个东西。
 *
 * ```text
 * 父进程（适配器）                      子进程（本文件）
 *   spawn(node --experimental-strip-types 本文件)  →
 *   stdin  ← {"expression": "0.1+0.2"}    读一行 JSON
 *   stdout → {"ok":true,"value":"0.3"}    受限校验 + 求值 + 写一行 JSON
 *   2s 未回 ⇒ kill（连同它的整个进程树）
 * ```
 *
 * ⚠️ 本文件**只**做一件事：把受限核心的结果翻译成一行 JSON。
 *    所有安全判断都在 `src/kernel/action/restricted-math.ts` 里（唯一实现）。
 */

import { evaluateRestrictedExpression } from '../../../kernel/action/restricted-math.ts'

function writeLine(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer))
  return Buffer.concat(chunks).toString('utf8')
}

const raw = await readStdin()
let expression = ''
try {
  const parsed = JSON.parse(raw) as { expression?: unknown }
  expression = typeof parsed.expression === 'string' ? parsed.expression : ''
} catch (error) {
  writeLine({ ok: false, reason: 'parse_error', detail: `请求不是合法 JSON：${(error as Error).message}` })
  process.exit(0)
}

try {
  const outcome = evaluateRestrictedExpression(expression)
  writeLine(outcome)
} catch (error) {
  writeLine({ ok: false, reason: 'evaluation_failed', detail: (error as Error).message })
}
process.exit(0)
