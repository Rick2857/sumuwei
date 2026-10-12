/**
 * 读数与断言器（**独立文件**，避免 `groups.ts` 与各组运行器之间的值级循环导入）。
 *
 * ⚠️ 循环导入在 ESM 里"通常能用"（活绑定 + 延迟访问），但"通常"不是判据：
 *    真实踩过的形状是"某个模块在求值期就访问了对方还没初始化的绑定"。
 *    把**值**（`GroupRecorder`）与**类型**分开，循环就只剩类型（编译期擦除）。
 */

export type CaseStatus = 'PASS' | 'FAIL' | 'NOT RUN' | 'MEASUREMENT INVALID'

export interface CaseReading {
  readonly caseId: string
  readonly title: string
  readonly status: CaseStatus
  readonly measuredCount: number
  readonly expected?: unknown
  readonly observed?: unknown
  readonly notes?: readonly string[]
}

export interface GroupReading {
  readonly id: string
  readonly title: string
  readonly status: CaseStatus
  readonly measuredCount: number
  readonly cases: readonly CaseReading[]
  readonly reason?: string
  readonly ms?: number
}

export interface VerifyContext {
  readonly only: readonly string[]
  readonly fixturesDir: string
  readonly runDir: string
  readonly localDir: string
  readonly log: (message: string) => void
}

interface Assertion {
  readonly label: string
  readonly ok: boolean
  readonly detail?: string
}

/**
 * 极小的断言器（本批自己用；**不** `process.exit`）。
 *
 * ⚠️ 三条与第一批同形的性质：
 * ```text
 * ① `countInput()` 是"真的执行了一条参数化输入"，**不是**断言条数
 * ② `measured === 0` ⇒ 整组判 `MEASUREMENT INVALID`（0 条输入的"0 失败"不是 PASS）
 * ③ `note()` 只放**计数 / 枚举 / 指纹 / 取值**，不放正文
 * ```
 */
export class GroupRecorder {
  readonly id: string
  private readonly assertions: Assertion[] = []
  private inputs = 0
  readonly observed: Record<string, unknown> = {}

  constructor(id: string) {
    this.id = id
  }

  countInput(n = 1): void {
    this.inputs += n
  }

  note(key: string, value: unknown): void {
    this.observed[key] = value
  }

  check(label: string, ok: boolean, detail?: string): void {
    this.assertions.push({ label, ok, ...(detail !== undefined ? { detail } : {}) })
  }

  get measured(): number {
    return this.inputs
  }

  get failed(): readonly Assertion[] {
    return this.assertions.filter((item) => !item.ok)
  }

  toCases(): readonly CaseReading[] {
    return this.assertions.map((item, index) => ({
      caseId: `${this.id}-${String(index + 1).padStart(2, '0')}`,
      title: item.label,
      status: item.ok ? 'PASS' : 'FAIL',
      measuredCount: 1,
      ...(item.detail !== undefined ? { observed: item.detail } : {}),
    }))
  }

  finish(title: string, options?: { notRunReason?: string }): GroupReading {
    if (options?.notRunReason !== undefined) {
      return {
        id: this.id,
        title,
        status: 'NOT RUN',
        measuredCount: this.inputs,
        cases: this.toCases(),
        reason: options.notRunReason,
      }
    }
    const cases = this.toCases()
    if (this.inputs === 0) {
      return {
        id: this.id,
        title,
        status: 'MEASUREMENT INVALID',
        measuredCount: 0,
        cases,
        reason: '这一组没有执行任何参数化输入（0 条输入的"0 失败"不是 PASS）',
      }
    }
    const failed = this.failed
    return {
      id: this.id,
      title,
      status: failed.length === 0 ? 'PASS' : 'FAIL',
      measuredCount: this.inputs,
      cases,
      ...(failed.length > 0
        ? {
            reason: `${String(failed.length)} 项断言未通过：${failed
              .map((item) => item.label)
              .join(' | ')}`,
          }
        : {}),
    }
  }
}
