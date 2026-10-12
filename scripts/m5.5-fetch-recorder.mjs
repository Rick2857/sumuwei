/**
 * M5.5 —— **出站请求记录器**（`NODE_OPTIONS=--import` 预载；只给 WP9 Live Smoke 用）。
 *
 * ============================================================================
 *  为什么需要一个**预载模块**，而不是改 provider
 * ============================================================================
 * WP9 的计划要求是"**出站请求捕获**，证明只有 query / limit / locale，
 * 没有记忆或人设"。而真实链路跑在 `src/main.ts` 的**子进程**里 ——
 * 父进程看不见它的 fetch。
 *
 * 两条不能走的路：
 *   · 把 endpoint 指到一个本地代理 —— endpoint 是**代码常量**且有逐段校验，改它就是改裁定；
 *   · 在 provider 里加记录钩子 —— 那是给生产代码加测试专用的分支。
 *
 * 于是只有一条：进程启动时**包一层 `globalThis.fetch`**，把每一条出站请求的
 * **方法 / URL / 头部名 / body 长度 / body 的字段名**写进一个 JSONL。
 *
 * ⚠️ 它**绝不**记录：头部的**值**、body 的**内容**、任何凭证。
 *    这与 `recording-fetch.ts` 是同一条隐私纪律 —— 记录器自己不能成为泄漏面。
 *
 * ⚠️ 2026-09-22（ADR-054）：provider 换成 Tavily 之后出站是 **POST + JSON**，
 *    于是"零 body"这条断言不再适用，"发了哪几个字段"必须仍可核对。
 *    做法是**只记 `Object.keys()`**：键名集合是冻结常量，而 query 正文在**值**里 ——
 *    记键名不扩大泄漏面，记值才会（那是被明确否决的形状）。
 *
 * ⚠️ 本文件是**纯 JS**（`.mjs`）：预载路径不经过 tsx 的转译，写 TS 注解会直接语法错误。
 *    （真实踩过：`const headerNames: string[] = []` ⇒ `SyntaxError: Missing initializer`。）
 *
 * 用法（由 smoke 脚本组装；Windows 上必须是**百分号编码过的 file:// URL**）：
 *   NODE_OPTIONS=--import=file:///…/m5.5-fetch-recorder.mjs  M55_FETCH_LOG=<输出文件>  node …
 */

import { appendFileSync } from 'node:fs'

const logPath = process.env.M55_FETCH_LOG
const original = globalThis.fetch

if (typeof logPath === 'string' && logPath.trim() !== '') {
  globalThis.fetch = async (input, init) => {
    try {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method =
        (init && init.method) || (typeof input === 'object' && input && input.method) || 'GET'

      const headerNames = []
      const push = (source) => {
        if (source === undefined || source === null) return
        if (source instanceof Headers) {
          source.forEach((_value, key) => headerNames.push(String(key).toLowerCase()))
        } else if (Array.isArray(source)) {
          for (const pair of source) {
            if (Array.isArray(pair) && typeof pair[0] === 'string') {
              headerNames.push(pair[0].toLowerCase())
            }
          }
        } else if (typeof source === 'object') {
          for (const key of Object.keys(source)) headerNames.push(key.toLowerCase())
        }
      }
      if (typeof input === 'object' && input && 'headers' in input) push(input.headers)
      if (init) push(init.headers)

      let bodyLength = 0
      if (init && typeof init.body === 'string') bodyLength = init.body.length
      else if (init && init.body !== undefined && init.body !== null) bodyLength = -1 // 非字符串 body：只记"有"

      /*
       * 只记 body 的**键名**（值绝不落盘）。非 JSON / 非对象 ⇒ null。
       * 这一段是本文件里唯一"读内容"的地方，读完只留下键名。
       */
      let bodyFieldNames = null
      if (init && typeof init.body === 'string' && init.body !== '') {
        try {
          const parsed = JSON.parse(init.body)
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            bodyFieldNames = Object.keys(parsed).sort()
          }
        } catch {
          bodyFieldNames = null
        }
      }

      appendFileSync(
        logPath,
        `${JSON.stringify({
          method,
          url,
          headerNames: [...new Set(headerNames)].sort(),
          bodyLength,
          bodyFieldNames,
        })}\n`,
        'utf8'
      )
    } catch {
      // 记录器**绝不允许**影响被观测的请求（记不上就记不上）
    }
    return await original(input, init)
  }
}
