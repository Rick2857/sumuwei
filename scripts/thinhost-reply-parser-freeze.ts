/**
 * W2 · 主回复解析器 `parseKeyValueXml` 的**冻结对照**（M12）。
 *
 * ============================================================================
 *  为什么先做这个、而不是直接本地化
 * ============================================================================
 * `parseKeyValueXml` 在 [src/providers/openai-compatible.ts:87] 上 —— **每一次回复都过**。
 * 而它**全仓零测试覆盖**（只有两处源码引用与一处注释）。
 * ⚠️ 更要紧：`pnpm postlv2:bridge:verify` **测不到它** —— 那道门注入 `replyText`
 *    绕过模型解析层。
 *
 * ⇒ 所以在**删包之前**必须先把"它现在到底做什么"**逐用例固定下来**，
 *    否则本地化就是盲改：改错了没有任何东西会告诉你。
 *
 * 上游实现在 `@elizaos/core@1.7.2` dist/node/index.node.js:45108-45284（约 175 行）：
 *   ① `<response>…</response>` 包裹优先
 *   ② 否则 `findFirstXmlBlock`：跳过 `</` `<!--` `<?`，自闭合跳过，按深度找配对
 *   ③ `extractDirectChildren` 同形扫描，**只取直接子级**，并做实体反转义
 *   ④ 键归一：`actions`/`providers`/`evaluators` → 逗号切分成数组；
 *      `simple` → `value.toLowerCase() === 'true'`；其余原样
 *   ⑤ 一个键都没有 ⇒ 返回 `null`
 *
 * ============================================================================
 *  用法
 * ============================================================================
 *   --freeze   用上游跑一遍，把**输入与期望输出**写成字面量并落盘
 *   （默认）    读冻结语料，与**待实现**逐用例比对（删包后靠这条路）
 *
 * ⚠️ 判据纪律（L-QQP-09 + §5.5）：
 *   ① 输入是字面量 ② 期望值是字面量 ③ 有负控（改坏实现 ⇒ 必须报红）
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const CORPUS = resolve(REPO, 'src/infrastructure/providers/reply-parser-cases.ts')

/**
 * 语料：五类（对应 M12 计划 §4.2 的 C1–C5）。
 *
 * ⚠️ 这些是**输入字面量**，不是"跑出来的" —— 生成器只跑一次上游拿期望值。
 */
interface Case { id: string; group: string; input: string }
const INPUTS: readonly Case[] = [
  // ---- C1 三字段齐全 -------------------------------------------------------
  { id: 'C1a-response-wrapper', group: 'C1', input: '<response><text>你好呀</text><thought>他在打招呼</thought><actions>SEARCH, MEMORY</actions></response>' },
  { id: 'C1b-bare-fields', group: 'C1', input: '<text>今天天气不错</text>\n<thought>闲聊</thought>\n<actions>LOOKUP</actions>' },
  { id: 'C1c-providers-and-evaluators', group: 'C1', input: '<text>x</text><providers>A,B</providers><evaluators>C</evaluators>' },
  { id: 'C1d-simple-bool', group: 'C1', input: '<text>y</text><simple>TRUE</simple>' },

  // ---- C2 部分 / 缺字段 ----------------------------------------------------
  { id: 'C2a-text-only', group: 'C2', input: '<text>只有正文</text>' },
  { id: 'C2b-empty-actions', group: 'C2', input: '<text>t</text><actions></actions>' },
  { id: 'C2b2-actions-spaces', group: 'C2', input: '<text>t</text><actions> A , B ,C </actions>' },

  // ---- C3 纯文本 / 无 XML ---------------------------------------------------
  { id: 'C3a-plain', group: 'C3', input: '这只是一段普通回复，没有任何标签。' },
  { id: 'C3b-empty', group: 'C3', input: '' },
  { id: 'C3c-prose-with-angle', group: 'C3', input: '5 < 7 且 x > 3' },

  // ---- C4 异常格式 ---------------------------------------------------------
  { id: 'C4a-unclosed', group: 'C4', input: '<text>没闭合' },
  { id: 'C4b-selfclosing', group: 'C4', input: '<text/><thought>只有自闭合</thought>' },
  { id: 'C4c-comment-and-pi', group: 'C4', input: '<!-- 注释 --><?xml version="1.0"?><text>带注释与处理指令</text>' },
  { id: 'C4d-nested-same-tag', group: 'C4', input: '<text>外层<text>内层</text>尾部</text>' },
  { id: 'C4e-entities', group: 'C4', input: '<text>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;</text>' },
  { id: 'C4f-response-unclosed', group: 'C4', input: '<response><text>包裹没闭合' },
  { id: 'C4g-extra-whitespace', group: 'C4', input: '  <text>   前后空白   </text>  ' },
  { id: 'C4h-mismatched-close', group: 'C4', input: '<text>内容</wrong>' },

  // ---- C5 非 ASCII ---------------------------------------------------------
  { id: 'C5a-cjk', group: 'C5', input: '<text>苏沐薇，今天想做什么？</text>' },
  { id: 'C5b-cjk-attrs', group: 'C5', input: '<text data-名字="值">中文属性</text>' },
  { id: 'C5c-emoji', group: 'C5', input: '<text>我想吃 🍜 和 🧸</text>' },
  { id: 'C5d-newlines', group: 'C5', input: '<text>第一行\n第二行</text>' },
]

/** 上游的签名（结构上够用即可） */
type Upstream = (text: string) => Record<string, unknown> | null

/*
 * ⚠️⚠️ **删包后这条路径必然失败，且这是**有意的**（M12 · W4）。
 *
 * 冻结语料（`reply-parser-cases.ts`）里的 `input` 与 `expected` **都是字面量**，
 * 所以**日常的核对（`verify()`）根本不需要上游** —— 那才是这道门的价值。
 * 只有 `--freeze`（重新从上游生成语料）需要它，而删包后**做不到**。
 *
 * ⇒ 用**变量形式**的 specifier：TypeScript 在 `moduleResolution: bundler` 下
 *   **不会**去解析 `import(变量)` ⇒ 编译期不再硬依赖这个包；
 *   运行期若包还在（临时装回）就照旧能重生成，不在则**具名失败**。
 */
async function upstreamFn(): Promise<Upstream> {
  const specifier = '@elizaos/core'
  try {
    const core = (await import(/* @vite-ignore */ specifier)) as unknown as { parseKeyValueXml: Upstream }
    return core.parseKeyValueXml
  } catch (error) {
    throw new Error(
      '无法重生成冻结语料：`@elizaos/core` 已从本仓依赖中删除（M12 · W4）。\n' +
        '  日常核对用**默认路径**即可（它只读冻结语料里的字面量，不需要上游）：\n' +
        '    pnpm thinhost:reply-parser:parity\n' +
        '  只有在**上游行为有意变更**时才需要重生成 —— 那需要临时装回该包。\n' +
        `  （原始错误：${error instanceof Error ? error.message : String(error)}）`
    )
  }
}

// ---------------------------------------------------------------------------
// --freeze：用上游跑一遍，把**期望值固化成字面量**
// ---------------------------------------------------------------------------
async function freeze(): Promise<void> {
  const upstream = await upstreamFn()
  const rows = INPUTS.map((c) => ({ ...c, expected: upstream(c.input) }))

  const body = rows
    .map(
      (r) =>
        `  {\n` +
        `    id: ${JSON.stringify(r.id)},\n` +
        `    group: ${JSON.stringify(r.group)},\n` +
        `    input: ${JSON.stringify(r.input)},\n` +
        `    expected: ${JSON.stringify(r.expected)},\n` +
        `  },`
    )
    .join('\n')

  const file = `/**
 * \`parseKeyValueXml\` 的**冻结语料**（M12 · W2）。
 *
 * ⚠️ **本文件是冻结产物，生成后不得手改** ——
 *   它记录的是 \`@elizaos/core@1.7.2\` 的既有行为，
 *   用途是让本地实现在**删包之后**仍能被逐用例核对。
 *
 * · \`input\` 与 \`expected\` 都是**字面量**（不是"跑上游算出来的"）——
 *   否则删包后这段代码自身失效（同 UUID 门踩过的坑，见计划 §5.4）。
 * · 覆盖五类：C1 三字段齐全 / C2 部分字段 / C3 无 XML / C4 异常格式 / C5 非 ASCII。
 *
 * 重新生成（需要依赖还在时）：
 *   pnpm thinhost:reply-parser:freeze
 *
 * 生成时间：2026-10-19 · 用例 ${rows.length} 条
 */

export interface ReplyParserCase {
  readonly id: string
  readonly group: string
  readonly input: string
  /** null 表示上游返回 null（调用方据此走纯文本回退） */
  readonly expected: Record<string, unknown> | null
}

export const REPLY_PARSER_CASES: readonly ReplyParserCase[] = [
${body}
]
`
  mkdirSync(dirname(CORPUS), { recursive: true })
  writeFileSync(CORPUS, file, 'utf8')
  console.log(`冻结完成：${String(rows.length)} 条用例 → ${CORPUS}`)
}

// ---------------------------------------------------------------------------
// 默认：用冻结语料核对**待实现**
// ---------------------------------------------------------------------------
async function verify(): Promise<void> {
  if (!existsSync(CORPUS)) {
    console.error(`拒绝：冻结语料不存在（${CORPUS}）—— 先跑 pnpm thinhost:reply-parser:freeze`)
    process.exit(2)
  }
  const { REPLY_PARSER_CASES } = (await import('../src/infrastructure/providers/reply-parser-cases.ts')) as {
    REPLY_PARSER_CASES: readonly { id: string; group: string; input: string; expected: Record<string, unknown> | null }[]
  }
  const { parseKeyValueXml: local } = (await import('../src/infrastructure/providers/reply-parser.ts')) as {
    parseKeyValueXml: Upstream
  }

  let failed = 0
  const byGroup = new Map<string, { ok: number; total: number }>()
  for (const c of REPLY_PARSER_CASES) {
    const got = local(c.input)
    const ok = JSON.stringify(got) === JSON.stringify(c.expected)
    const g = byGroup.get(c.group) ?? { ok: 0, total: 0 }
    g.total += 1
    if (ok) g.ok += 1
    else {
      failed += 1
      console.log(`FAIL ${c.id}`)
      console.log(`     expected: ${JSON.stringify(c.expected)}`)
      console.log(`     actual  : ${JSON.stringify(got)}`)
    }
    byGroup.set(c.group, g)
  }
  for (const [group, g] of [...byGroup.entries()].sort()) {
    console.log(`${g.ok === g.total ? 'PASS' : 'FAIL'} ${group} — ${g.ok}/${g.total}`)
  }
  const total = REPLY_PARSER_CASES.length

  // -------------------------------------------------------------------------
  // 负控：**故意改坏实现一位** ⇒ 门必须报红
  //
  // ⚠️ 没有这条，一个恒真的 `() => null` 也能"全绿"（22 条里 19 条期望值就是 null）。
  //    这是 §5.5「冻结语料类门必须有负控」的硬要求。
  // -------------------------------------------------------------------------
  {
    const c1a = REPLY_PARSER_CASES.find((c) => c.expected !== null)
    if (c1a === undefined) {
      console.log('FAIL N-negative-control — 语料里没有"期望非 null"的用例，负控无法成立')
      failed += 1
    } else {
      // 用一个**故意错的**实现（把 `<response>` 支持去掉，只保留裸标签扫描）
      const broken = (s: string): Record<string, unknown> | null => {
        const stripped = s.replace(/<response>/g, '').replace(/<\/response>/g, '')
        const m = /<text>([\s\S]*?)<\/text>/.exec(stripped)
        return m === null ? null : { text: m[1]! }
      }
      const got = broken(c1a.input)
      const detected = JSON.stringify(got) !== JSON.stringify(c1a.expected)
      console.log(
        `${detected ? 'PASS' : 'FAIL'} N-negative-control — ` +
          `改坏实现后对用例 ${c1a.id} 必须报红（实际 ${JSON.stringify(got)} vs 期望 ${JSON.stringify(c1a.expected)}）`
      )
      if (!detected) failed += 1
    }
  }

  console.log(`\n=== 主回复解析器冻结对照: ${total}/${total} 用例 + 负控 ===`)
  if (failed > 0) {
    console.log(`FAILED: ${String(failed)} 项`)
    process.exitCode = 1
  } else {
    console.log('ALL PASS')
  }
}

if (process.argv.includes('--freeze')) {
  await freeze()
} else {
  await verify()
}