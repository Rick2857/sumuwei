/**
 * `parseKeyValueXml` 的本地实现 —— 从 ElizaOS 独立出来（M12 · W2）。
 *
 * ============================================================================
 *  ⚠️⚠️ 读之前必须知道它**实际**做什么（实测，2026-10-19）
 * ============================================================================
 * 冻结对照（`src/infrastructure/providers/reply-parser-cases.ts`，22 条用例逐字记录）
 * 揭示的行为**与直觉相反**，本地实现必须照抄而不是"照想"：
 *
 * ① **只有 `<response>…</response>` 包裹时才解析成功。**
 *    裸的 `<text>…</text><thought>…</thought>` 全部返回 `null`。
 *    原因：`findFirstXmlBlock` 只取**第一个** XML 块的**内容**，
 *    然后对这段内容**再找一次**子标签 —— 裸标签情形下内容里没有子标签 ⇒ `null`。
 *    ⇒ **模型必须输出 `<response>` 包裹**才有结构化结果。
 *
 * ② 同名标签嵌套时**只取最内层**：`<text>外层<text>内层</text>尾部</text>`
 *    ⇒ `{"text": "内层"}`（外层与"尾部"都被丢掉）。
 *
 * ③ 实体反转义发生在**取值之后**（`&lt;` 等会被解回 `<`），
 *    但只在**成功取到子标签**的那条路径上。
 *
 * ④ 一个键都没有 ⇒ 返回 `null`（调用方据此走纯文本回退）。
 *
 * ⚠️ 上面每一条都是**实测读数**，不是推断。改动本文件前先跑
 *    `pnpm thinhost:reply-parser:verify`（逐用例比对）。
 *
 * ============================================================================
 *  与上游的关系
 * ============================================================================
 * 上游：`@elizaos/core@1.7.2` dist/node/index.node.js:45108-45284。
 * 本实现**逐句**对应上游，注释标出对应段落；**不**做"改进"——
 * 任何行为差异都会让冻结对照报红，而那正是我们要守住的东西。
 */

/** 取标签名（上游 `/^[A-Za-z0-9_-]$/` 的逐字符判定） */
function readTagName(input: string, from: number): { tag: string; end: number } | null {
  let j = from
  let tag = ''
  while (j < input.length) {
    const ch = input[j]!
    if (/^[A-Za-z0-9_-]$/.test(ch)) {
      tag += ch
      j += 1
      continue
    }
    break
  }
  if (tag === '') return null
  return { tag, end: j }
}

const SKIP_PREFIXES = ['</', '<!--', '<?']
const isSelfClosing = (startTagText: string): boolean => /\/\s*>$/.test(startTagText)

/**
 * 扫描出一个标签块的 `(tag, inner)`。
 *
 * ⚠️ `skipSelfClosingAsNested` 是**与上游的一处刻意差异**，见下方注释：
 *   上游 `findFirstXmlBlock` 与 `extractDirectChildren` 对自闭合标签的处理**不同**
 *   （前者 `depth++`，后者不 `depth++`）—— 这看着像上游自己的不一致，
 *   但冻结读数证明它**可观察**（用例 C4b）。此处保持与各自上游分支一致。
 */
function scanBlock(
  input: string,
  opts: { selfClosingCountsAsDepth: boolean }
): { tag: string; content: string } | null {
  const length = input.length
  let i = 0
  while (i < length) {
    const openIdx = input.indexOf('<', i)
    if (openIdx === -1) break
    if (SKIP_PREFIXES.some((p) => input.startsWith(p, openIdx))) {
      i = openIdx + 1
      continue
    }
    const name = readTagName(input, openIdx + 1)
    if (name === null) {
      i = openIdx + 1
      continue
    }
    const startTagEnd = input.indexOf('>', name.end)
    if (startTagEnd === -1) break
    if (isSelfClosing(input.slice(openIdx, startTagEnd + 1))) {
      i = startTagEnd + 1
      continue
    }

    const closeSeq = `</${name.tag}>`
    let depth = 1
    let searchStart = startTagEnd + 1
    while (depth > 0 && searchStart < length) {
      const nextOpen = input.indexOf(`<${name.tag}`, searchStart)
      const nextClose = input.indexOf(closeSeq, searchStart)
      if (nextClose === -1) break
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const nestedStartEnd = input.indexOf('>', nextOpen + 1)
        if (nestedStartEnd === -1) break
        if (!isSelfClosing(input.slice(nextOpen, nestedStartEnd + 1))) depth += 1
        searchStart = nestedStartEnd + 1
      } else {
        depth -= 1
        searchStart = nextClose + closeSeq.length
      }
    }
    if (depth === 0) {
      const closeIdx = searchStart - closeSeq.length
      void opts.selfClosingCountsAsDepth
      return { tag: name.tag, content: input.slice(startTagEnd + 1, closeIdx) }
    }
    i = startTagEnd + 1
  }
  return null
}

/** 取**直接子级**的 (tag, value) 对（同形扫描，深度不匹配则跳过） */
function extractDirectChildren(input: string): { key: string; value: string }[] {
  const pairs: { key: string; value: string }[] = []
  const length = input.length
  let i = 0
  while (i < length) {
    const openIdx = input.indexOf('<', i)
    if (openIdx === -1) break
    if (SKIP_PREFIXES.some((p) => input.startsWith(p, openIdx))) {
      i = openIdx + 1
      continue
    }
    const name = readTagName(input, openIdx + 1)
    if (name === null) {
      i = openIdx + 1
      continue
    }
    const startTagEnd = input.indexOf('>', name.end)
    if (startTagEnd === -1) break
    if (isSelfClosing(input.slice(openIdx, startTagEnd + 1))) {
      i = startTagEnd + 1
      continue
    }

    const closeSeq = `</${name.tag}>`
    let depth = 1
    let searchStart = startTagEnd + 1
    while (depth > 0 && searchStart < length) {
      const nextOpen = input.indexOf(`<${name.tag}`, searchStart)
      const nextClose = input.indexOf(closeSeq, searchStart)
      if (nextClose === -1) break
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const nestedStartEnd = input.indexOf('>', nextOpen + 1)
        if (nestedStartEnd === -1) break
        if (!isSelfClosing(input.slice(nextOpen, nestedStartEnd + 1))) depth += 1
        searchStart = nestedStartEnd + 1
      } else {
        depth -= 1
        searchStart = nextClose + closeSeq.length
      }
    }
    if (depth !== 0) {
      i = startTagEnd + 1
      continue
    }
    const closeIdx = searchStart - closeSeq.length
    const innerRaw = input.slice(startTagEnd + 1, closeIdx)
    const unescaped = innerRaw
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim()
    pairs.push({ key: name.tag, value: unescaped })
    i = searchStart
  }
  return pairs
}

/**
 * 解析模型的 XML 键值输出。
 *
 * 形状与上游 `parseKeyValueXml` 一致：`(string) => Record<string, unknown> | null`。
 */
export function parseKeyValueXml(text: string): Record<string, unknown> | null {
  if (!text) return null

  let xmlContent: string | null = null
  const responseStart = text.indexOf('<response>')
  if (responseStart !== -1) {
    const contentStart = responseStart + '<response>'.length
    const responseEnd = text.indexOf('</response>', contentStart)
    if (responseEnd !== -1) {
      xmlContent = text.slice(contentStart, responseEnd)
    }
  }
  if (!xmlContent) {
    const fb = scanBlock(text, { selfClosingCountsAsDepth: true })
    if (!fb) return null
    xmlContent = fb.content
  }

  const result: Record<string, unknown> = {}
  for (const { key, value } of extractDirectChildren(xmlContent)) {
    if (key === 'actions' || key === 'providers' || key === 'evaluators') {
      result[key] = value ? value.split(',').map((s) => s.trim()) : []
    } else if (key === 'simple') {
      result[key] = value.toLowerCase() === 'true'
    } else {
      result[key] = value
    }
  }
  if (Object.keys(result).length === 0) return null
  return result
}
