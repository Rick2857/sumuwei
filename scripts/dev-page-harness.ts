/**
 * M5.1.1 WP7 · **页面渲染 harness**（AT-W7-11 的预研与复用工具）
 *
 * ============================================================================
 *  它解决什么问题
 * ============================================================================
 * 执行计划 §AT-W7-11 要求专项门做到：
 *
 * ```text
 *   actual DTO  →  actual renderer/page logic  →  rendered output  →  assertions
 * ```
 *
 * 而 `page.html` 是**零 import / 零外部资源 / 无框架的单文件**：它的脚本是一个
 * **闭包私有**的 IIFE（`(function () { … })()`），里面的渲染函数从外面一个都拿不到。
 * 因此"页面里存在某段文案"这种 grep 不算证据 —— 必须**真的把页面跑起来**。
 *
 * 本模块给出的办法（**不给页面加任何 seam、不改产品代码**）：
 *
 * ```text
 *   ① 从 HTML 里抽出 <script> 体
 *   ② 用一个**桩 DOM**（createElement / getElementById）与**桩 fetch**（路由表）在 node:vm 里
 *      把它跑起来 —— 页面的启动块会**直接调用**各 load 函数，于是渲染逻辑真的执行
 *   ③ 断言发生在**桩 DOM 的节点树**上（= 页面的真实渲染输出），而不是源码文本
 * ```
 *
 * 为什么不用"把渲染函数 export 出来"：那要给页面加运行时 seam（`window.__x = …`），
 * 会改变被验收的东西本身。本模块的桩只**替代环境**（DOM / fetch），页面的代码一行不改。
 *
 * ⚠️ 它**不**定义任何渲染语义（那是 AT-W7-1 的事）；它只负责"把页面跑起来并读出它渲染了什么"。
 *
 * 用法：见 `scripts/verify-m5.1.1-wp7-preflight.ts` 的 AT-W7-11 段（正控 / 负控 / 恢复）。
 */

import { createContext, runInContext } from 'node:vm'

/** 桩 DOM 节点（只实现 page.html 真正用到的那部分 DOM 表面） */
export class StubNode {
  readonly tag: string
  className = ''
  title = ''
  value = ''
  checked = false
  id = ''
  readonly children: StubNode[] = []
  readonly listeners: Record<string, ((event?: unknown) => void)[]> = {}
  readonly attributes: Record<string, string> = {}
  /** 自身文本（DOM 语义：设置 `textContent` 会清空子节点） */
  private ownText = ''

  constructor(tag: string) {
    this.tag = tag
  }

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join('')
  }

  set textContent(value: string) {
    this.ownText = value === undefined || value === null ? '' : String(value)
    this.children.length = 0
  }

  appendChild<T extends StubNode>(child: T): T {
    this.children.push(child)
    return child
  }

  addEventListener(type: string, listener: (event?: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(listener)
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value)
    if (name === 'id') this.id = String(value)
  }

  /** 便于断言：把整棵子树的文本按行拼起来 */
  lines(): string[] {
    const out: string[] = []
    const visit = (node: StubNode): void => {
      if (node.children.length === 0 && node.textContent.trim() !== '') out.push(node.textContent.trim())
      for (const child of node.children) visit(child)
    }
    visit(this)
    return out
  }
}

export interface PageRunResult {
  /** 页面请求过的元素 id（按出现顺序，去重后仍在同一数组里） */
  readonly requestedIds: string[]
  /** 页面请求了、但 HTML 里**不存在**的 id（真 bug 会被这条抓住） */
  readonly missingIds: string[]
  /** 页面发出的 fetch 路径（按顺序） */
  readonly requestedPaths: string[]
  /** 路由表没有覆盖的路径（探针要求的"每个请求都可解释"） */
  readonly unroutedPaths: string[]
  /** 页面脚本抛出的错误（同步的、被 vm 边界捕获的） */
  readonly pageErrors: string[]
  /** 按 id 取桩节点的渲染文本 */
  textOf(id: string): string
  /** 按 id 取桩节点的渲染文本行 */
  linesOf(id: string): string[]
  /** 按 id 取桩节点本身（高级断言用） */
  nodeOf(id: string): StubNode | undefined
  /** 该 id 的节点是否被创建过（页面没碰过的 id 为 false） */
  touchedIds(): string[]
  /**
   * 触发某个容器里**第一个**注册了该事件的监听器（默认 click）。
   *
   * 页面的详情面板只在点击时加载（`loadTraceDetail` / `loadExecutionDetail`），
   * 所以"渲染输出"的断言必须先点一下 —— 这也是 AT-W7-11 要的
   * "实际页面逻辑 → 渲染输出"（不是"源码里有这段文案"）。
   *
   * 返回是否真的触发到了；回调抛错会记进 `pageErrors`。
   */
  fireFirst(containerId: string, type?: string): boolean
}

/**
 * 在 Node 里驱动一段 HTML 里的页面脚本。
 *
 * `routes` 的键是 **fetch 的完整路径**（含 query，如 `/traces?limit=5`）。
 * 路由未命中时返回空对象并记进 `unroutedPaths`（**不**静默成功）。
 */
export async function runDevPage(
  html: string,
  routes: Readonly<Record<string, unknown>>,
  options: { flushTurns?: number } = {}
): Promise<PageRunResult> {
  const scriptMatch = /<script>([\s\S]*?)<\/script>/.exec(html)
  if (scriptMatch === null) throw new Error('页面里没有 <script> 块 —— harness 无法驱动它')

  const knownIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!))
  const byId = new Map<string, StubNode>()
  const requestedIds: string[] = []
  const missingIds: string[] = []
  const requestedPaths: string[] = []
  const unroutedPaths: string[] = []
  const pageErrors: string[] = []

  const documentStub = {
    createElement: (tag: string): StubNode => new StubNode(String(tag)),
    createTextNode: (text: string): StubNode => {
      const node = new StubNode('#text')
      node.textContent = text
      return node
    },
    getElementById: (id: string): StubNode => {
      requestedIds.push(id)
      if (!knownIds.has(id)) missingIds.push(id)
      let node = byId.get(id)
      if (node === undefined) {
        node = new StubNode('div')
        node.id = id
        byId.set(id, node)
      }
      return node
    },
    querySelector: (): StubNode | null => null,
    addEventListener: (): void => {},
    body: new StubNode('body'),
  }

  const fetchStub = async (
    path: string,
    _options?: unknown
  ): Promise<{ status: number; ok: boolean; json: () => Promise<unknown> }> => {
    requestedPaths.push(String(path))
    const has = Object.prototype.hasOwnProperty.call(routes, path)
    if (!has) unroutedPaths.push(String(path))
    const body = has ? routes[path] : {}
    return { status: 200, ok: true, json: async () => body }
  }

  const sandbox = {
    document: documentStub,
    fetch: fetchStub,
    console: { log: (): void => {}, warn: (): void => {}, error: (): void => {}, debug: (): void => {} },
    window: {},
    setTimeout,
    clearTimeout,
  }

  try {
    const context = createContext(sandbox)
    runInContext(scriptMatch[1]!, context, { filename: 'page.html<script>' })
  } catch (error) {
    pageErrors.push((error as Error).message)
  }

  // 页面用 `.then()` 链驱动渲染；冲刷微任务/宏任务若干轮让它们跑完
  const flush = async (): Promise<void> => {
    const turns = options.flushTurns ?? 12
    for (let index = 0; index < turns; index += 1) {
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  await flush()

  const findFirstListener = (
    node: StubNode | undefined,
    type: string
  ): ((event?: unknown) => void) | undefined => {
    if (node === undefined) return undefined
    const own = node.listeners[type]
    if (own !== undefined && own.length > 0) return own[0]
    for (const child of node.children) {
      const found = findFirstListener(child, type)
      if (found !== undefined) return found
    }
    return undefined
  }

  return {
    requestedIds,
    missingIds,
    requestedPaths,
    unroutedPaths,
    pageErrors,
    textOf: (id: string) => byId.get(id)?.textContent ?? '',
    linesOf: (id: string) => byId.get(id)?.lines() ?? [],
    nodeOf: (id: string) => byId.get(id),
    touchedIds: () => [...byId.keys()],
    fireFirst: (containerId: string, type = 'click'): boolean => {
      const listener = findFirstListener(byId.get(containerId), type)
      if (listener === undefined) return false
      try {
        listener()
      } catch (error) {
        pageErrors.push((error as Error).message)
      }
      return true
    },
  }
}

/** 触发了点击之后，页面会再走一轮 promise 链 —— 调用方要再冲刷一次 */
export async function flushPage(html: string, turns = 12): Promise<void> {
  void html
  for (let index = 0; index < turns; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}
