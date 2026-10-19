/**
 * `parseKeyValueXml` 的**冻结语料**（M12 · W2）。
 *
 * ⚠️ **本文件是冻结产物，生成后不得手改** ——
 *   它记录的是 `@elizaos/core@1.7.2` 的既有行为，
 *   用途是让本地实现在**删包之后**仍能被逐用例核对。
 *
 * · `input` 与 `expected` 都是**字面量**（不是"跑上游算出来的"）——
 *   否则删包后这段代码自身失效（同 UUID 门踩过的坑，见计划 §5.4）。
 * · 覆盖五类：C1 三字段齐全 / C2 部分字段 / C3 无 XML / C4 异常格式 / C5 非 ASCII。
 *
 * 重新生成（需要依赖还在时）：
 *   pnpm thinhost:reply-parser:freeze
 *
 * 生成时间：2026-10-19 · 用例 22 条
 */

export interface ReplyParserCase {
  readonly id: string
  readonly group: string
  readonly input: string
  /** null 表示上游返回 null（调用方据此走纯文本回退） */
  readonly expected: Record<string, unknown> | null
}

export const REPLY_PARSER_CASES: readonly ReplyParserCase[] = [
  {
    id: "C1a-response-wrapper",
    group: "C1",
    input: "<response><text>你好呀</text><thought>他在打招呼</thought><actions>SEARCH, MEMORY</actions></response>",
    expected: {"text":"你好呀","thought":"他在打招呼","actions":["SEARCH","MEMORY"]},
  },
  {
    id: "C1b-bare-fields",
    group: "C1",
    input: "<text>今天天气不错</text>\n<thought>闲聊</thought>\n<actions>LOOKUP</actions>",
    expected: null,
  },
  {
    id: "C1c-providers-and-evaluators",
    group: "C1",
    input: "<text>x</text><providers>A,B</providers><evaluators>C</evaluators>",
    expected: null,
  },
  {
    id: "C1d-simple-bool",
    group: "C1",
    input: "<text>y</text><simple>TRUE</simple>",
    expected: null,
  },
  {
    id: "C2a-text-only",
    group: "C2",
    input: "<text>只有正文</text>",
    expected: null,
  },
  {
    id: "C2b-empty-actions",
    group: "C2",
    input: "<text>t</text><actions></actions>",
    expected: null,
  },
  {
    id: "C2b2-actions-spaces",
    group: "C2",
    input: "<text>t</text><actions> A , B ,C </actions>",
    expected: null,
  },
  {
    id: "C3a-plain",
    group: "C3",
    input: "这只是一段普通回复，没有任何标签。",
    expected: null,
  },
  {
    id: "C3b-empty",
    group: "C3",
    input: "",
    expected: null,
  },
  {
    id: "C3c-prose-with-angle",
    group: "C3",
    input: "5 < 7 且 x > 3",
    expected: null,
  },
  {
    id: "C4a-unclosed",
    group: "C4",
    input: "<text>没闭合",
    expected: null,
  },
  {
    id: "C4b-selfclosing",
    group: "C4",
    input: "<text/><thought>只有自闭合</thought>",
    expected: null,
  },
  {
    id: "C4c-comment-and-pi",
    group: "C4",
    input: "<!-- 注释 --><?xml version=\"1.0\"?><text>带注释与处理指令</text>",
    expected: null,
  },
  {
    id: "C4d-nested-same-tag",
    group: "C4",
    input: "<text>外层<text>内层</text>尾部</text>",
    expected: {"text":"内层"},
  },
  {
    id: "C4e-entities",
    group: "C4",
    input: "<text>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;</text>",
    expected: null,
  },
  {
    id: "C4f-response-unclosed",
    group: "C4",
    input: "<response><text>包裹没闭合",
    expected: null,
  },
  {
    id: "C4g-extra-whitespace",
    group: "C4",
    input: "  <text>   前后空白   </text>  ",
    expected: null,
  },
  {
    id: "C4h-mismatched-close",
    group: "C4",
    input: "<text>内容</wrong>",
    expected: null,
  },
  {
    id: "C5a-cjk",
    group: "C5",
    input: "<text>苏沐薇，今天想做什么？</text>",
    expected: null,
  },
  {
    id: "C5b-cjk-attrs",
    group: "C5",
    input: "<text data-名字=\"值\">中文属性</text>",
    expected: null,
  },
  {
    id: "C5c-emoji",
    group: "C5",
    input: "<text>我想吃 🍜 和 🧸</text>",
    expected: null,
  },
  {
    id: "C5d-newlines",
    group: "C5",
    input: "<text>第一行\n第二行</text>",
    expected: null,
  },
]
