/**
 * HTTP 层的**自有**错误类型（M5.1 WP2）。
 *
 * ============================================================================
 *  为什么不让 `KernelError` 兼职
 * ============================================================================
 * `KernelError.kind` 是**领域**分类（validation / persistence / …），
 * 而 HTTP 状态码是**传输**分类。把 403 / 405 / 404-route 这类"这一层才有的结论"
 * 塞进领域错误，会让领域层凭空多出几个它根本不该认识的种类。
 *
 * 反过来，本文件**不**拦领域错误：`statusOfError` 先看 HttpError，再按
 * `KernelError.kind` 映射 —— 两种错误各有各的主人。
 */

export class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}
