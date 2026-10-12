/**
 * 自研 mini 测试框架（零依赖）。
 *
 * ============================================================================
 *  为什么不再写一个大脚本
 * ============================================================================
 * 既有的 `scripts/run-tests.ts` 是 788 行的**集成**测试（真实调模型），
 * 它适合验收"她答得像不像"，但不适合承载 M2.5 的**契约**测试：
 * 那些测试必须 deterministic、离线、秒级完成，而且每个文件只关心一件事。
 *
 * 这个 runner 提供恰好够用的东西：
 *   · `test()` 注册用例，`expect` 风格断言
 *   · 失败时打印**期望 vs 实际**，而不是一句 false
 *   · 汇总退出码，可直接被 CI 使用
 *   · 不引入 jest/vitest：M2.5 的依赖 Gate 明确反对为"测试方便"加重量依赖
 */

export interface AssertionFailure {
  message: string
  expected?: string
  actual?: string
}

export class ExpectationError extends Error {
  readonly failure: AssertionFailure
  constructor(failure: AssertionFailure) {
    super(failure.message)
    this.name = 'ExpectationError'
    this.failure = failure
  }
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const expect = {
  equal<T>(actual: T, expected: T, message = '值应当相等'): void {
    if (actual !== expected) {
      throw new ExpectationError({
        message,
        expected: stringify(expected),
        actual: stringify(actual),
      })
    }
  },

  deepEqual(actual: unknown, expected: unknown, message = '结构应当相等'): void {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a !== b) {
      throw new ExpectationError({ message, expected: b, actual: a })
    }
  },

  ok(value: unknown, message = '应当为真'): void {
    if (!value) {
      throw new ExpectationError({ message, actual: stringify(value) })
    }
  },

  notOk(value: unknown, message = '应当为假'): void {
    if (value) {
      throw new ExpectationError({ message, actual: stringify(value) })
    }
  },

  includes(haystack: string, needle: string, message = '应当包含'): void {
    if (!haystack.includes(needle)) {
      throw new ExpectationError({
        message,
        expected: `包含 ${stringify(needle)}`,
        actual: haystack.length > 400 ? `${haystack.slice(0, 400)}…` : haystack,
      })
    }
  },

  notIncludes(haystack: string, needle: string, message = '不应包含'): void {
    if (haystack.includes(needle)) {
      throw new ExpectationError({
        message,
        expected: `不包含 ${stringify(needle)}`,
        actual: haystack.length > 400 ? `${haystack.slice(0, 400)}…` : haystack,
      })
    }
  },

  greater(actual: number, than: number, message = '应当更大'): void {
    if (!(actual > than)) {
      throw new ExpectationError({ message, expected: `> ${than}`, actual: String(actual) })
    }
  },

  atLeast(actual: number, floor: number, message = '应当不小于'): void {
    if (!(actual >= floor)) {
      throw new ExpectationError({ message, expected: `>= ${floor}`, actual: String(actual) })
    }
  },

  atMost(actual: number, ceiling: number, message = '应当不大于'): void {
    if (!(actual <= ceiling)) {
      throw new ExpectationError({ message, expected: `<= ${ceiling}`, actual: String(actual) })
    }
  },

  /** 断言一段异步代码**必须失败**，并且（可选）错误码匹配 */
  async rejects(fn: () => Promise<unknown>, codeOrMessage?: string): Promise<unknown> {
    try {
      await fn()
    } catch (error) {
      if (codeOrMessage) {
        const text = `${(error as { code?: string }).code ?? ''} ${(error as Error).message ?? ''}`
        if (!text.includes(codeOrMessage)) {
          throw new ExpectationError({
            message: `抛出的错误里应当包含 ${stringify(codeOrMessage)}`,
            actual: text,
          })
        }
      }
      return error
    }
    throw new ExpectationError({
      message: '这段代码本应抛错，但它成功了（fail closed 被破坏）',
    })
  },
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface RegisteredTest {
  name: string
  fn: () => Promise<void> | void
}

const registry: RegisteredTest[] = []
let currentGroup = ''

export function group(name: string): void {
  currentGroup = name
}

export function test(name: string, fn: () => Promise<void> | void): void {
  registry.push({ name: currentGroup ? `${currentGroup} :: ${name}` : name, fn })
}

export function registeredCount(): number {
  return registry.length
}

export interface RunSummary {
  passed: number
  failed: number
  failures: { name: string; failure: AssertionFailure | { message: string } }[]
  durationMs: number
}

export async function runAll(options: { filter?: string } = {}): Promise<RunSummary> {
  const started = Date.now()
  const failures: RunSummary['failures'] = []
  let passed = 0

  const selected = options.filter
    ? registry.filter((t) => t.name.includes(options.filter!))
    : registry

  for (const item of selected) {
    const t0 = Date.now()
    try {
      await item.fn()
      passed += 1
      console.log(`  ✅ ${item.name}  (${Date.now() - t0}ms)`)
    } catch (error) {
      const failure =
        error instanceof ExpectationError
          ? error.failure
          : { message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
      failures.push({ name: item.name, failure })
      console.log(`  ❌ ${item.name}`)
      console.log(`       ${failure.message}`)
      if ('expected' in failure && failure.expected !== undefined) {
        console.log(`       期望: ${failure.expected}`)
        console.log(`       实际: ${failure.actual}`)
      }
      if (error instanceof Error && error.stack && !(error instanceof ExpectationError)) {
        console.log(
          error.stack
            .split('\n')
            .slice(1, 4)
            .map((l) => `       ${l.trim()}`)
            .join('\n')
        )
      }
    }
  }

  return { passed, failed: failures.length, failures, durationMs: Date.now() - started }
}

export function printSummary(summary: RunSummary, title: string): void {
  console.log(`\n${'='.repeat(72)}`)
  console.log(`${title}：${summary.passed} 通过 / ${summary.failed} 失败（${summary.durationMs}ms）`)
  if (summary.failures.length > 0) {
    console.log('失败用例：')
    for (const f of summary.failures) console.log(`  - ${f.name} → ${f.failure.message}`)
  }
  console.log('='.repeat(72))
}
