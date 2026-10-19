/**
 * 门：`src/` 里对 `@elizaos/*` 的**脱依赖判据**（M12 · §5.1）。
 *
 * ============================================================================
 *  为什么用 AST，而不是"扫代码行里有没有这个字符串"
 * ============================================================================
 * v1 的判据是"扫描代码行里没有 `@elizaos/`" ⇒ **会误伤**：
 * 架构检查里的禁止规则、测试夹具、说明字符串都会命中。
 *
 * ⇒ 改用 TypeScript AST（仓库已有 `typescript@5.9.3`，直接复用）：
 * 单遍 `ts.createSourceFile` + 完整 `forEachChild` 遍历**已经**能识别全部形态
 * （§5.1 的 v2.3 实测已证伪"必须扫两遍 + Program"的说法）。
 *
 * ============================================================================
 *  ⚠️ 分档：**运行时**依赖（W2） vs **类型/解析期**依赖（W4），如实分列
 * ============================================================================
 * | 档 | 判据 | 何时达成 |
 * | --- | --- | --- |
 * | **A · 运行时** | 值导入 / 动态 import / require / export-from —— 代码会真的从包里拿东西 | **W2**（本门现在守的就是它） |
 * | **B · 类型/解析期** | type-only 导入 / `typeof import()` / `declare module` / `require.resolve` | **W4**（删四个包时） |
 *
 * ⚠️ 为什么要分档（不是"放宽判据"）：
 *   `AgentRuntime` / `IAgentRuntime` / `Memory` / `State` / `UUID` / `Plugin` 这几个
 *   **类型**散布在 51+ 处（adapters 20 · state/repository 11 · main 8 …）；
 *   `src/types/plugins.d.ts` 的 `declare module` 是上游打包问题的**类型补丁**
 *   （§5.1 说"整份可删"，但那要等包真的没了）；
 *   `pglite-entry.ts` 的 `resolve('@elizaos/plugin-sql')` 是 PGlite 的**解析路径**
 *   （要等 `@electric-sql/pglite` 变成直接依赖）。
 *   ⇒ 一次性换掉它们是 W4 的"删依赖"工作，不该混进 W2 的"运行时替代"。
 *   ⇒ 本门**如实报出 B 档的当前计数**，而不是把它藏起来或假装已达成。
 *
 * ⚠️ **A 档只有一个例外**：`src/context/builder.ts`（旧上下文链路本体）——
 *    D2 明写"旧路径**保留可读**但不再被任何入口调用" ⇒ 它必须继续 import 上游那两个函数。
 *    本门断言"**恰好**只有它一个"（再多一个会被抓到）。
 *
 *
 * ⚠️ 判据纪律（L-QQP-09）：
 *   · AST 判据**只看真节点**，不看注释与字符串 ⇒ 不会被我自己的说明文字打败
 *   · 每条判据都配**负控**（造一个违规形态 ⇒ 必须被抓到）
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

interface Check { id: string; ok: boolean; detail: string }
const checks: Check[] = []
function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} — ${detail}`)
}

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

const ELIZA = /^@elizaos\//

interface Finding {
  file: string
  line: number
  kind: string
  detail: string
}

/** 找出文件里所有指向 `@elizaos/*` 的引用形态 */
function scan(file: string): {
  staticImports: Finding[]
  exportFrom: Finding[]
  dynamicImports: Finding[]
  typeOnlyDynamic: Finding[]
  requires: Finding[]
  resolves: Finding[]
  moduleDecls: Finding[]
  /** 只有 importClause.isTypeOnly = true 的静态导入 */
  typeOnlyStatic: Finding[]
} {
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const line = (node: ts.Node): number => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  const rel = (f: string): string => f.replace(SRC, '')

  const out = {
    staticImports: [] as Finding[],
    exportFrom: [] as Finding[],
    dynamicImports: [] as Finding[],
    typeOnlyDynamic: [] as Finding[],
    requires: [] as Finding[],
    resolves: [] as Finding[],
    moduleDecls: [] as Finding[],
    typeOnlyStatic: [] as Finding[],
  }

  const isEliza = (s: string): boolean => ELIZA.test(s)

  const visit = (node: ts.Node): void => {
    // ① import … from '@elizaos/*'
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (isEliza(spec)) {
        const clause = node.importClause
        /*
         * ⚠️ **逐 specifier 判 type-only**（第一版只判 `importClause.isTypeOnly`，误报）：
         *   `import { type AgentRuntime, type Plugin } from '@elizaos/core'`
         *   顶层**没有** `type` 关键字（`importClause.isTypeOnly === false`），
         *   但**每个 specifier 都是 type-only** ⇒ 它**不引入任何运行时值**。
         *   ⇒ 只有"默认导入"或"任一 specifier 不是 type-only"才算**值导入**。
         */
        const named = clause?.namedBindings
        const namedElements = named !== undefined && ts.isNamedImports(named) ? named.elements : undefined
        const allSpecifiersTypeOnly =
          clause?.isTypeOnly === true ||
          (namedElements !== undefined &&
            namedElements.length > 0 &&
            namedElements.every((e) => e.isTypeOnly))
        const hasDefaultValueImport = clause !== undefined && clause.name !== undefined && clause.isTypeOnly !== true
        const typeOnly = allSpecifiersTypeOnly && !hasDefaultValueImport
        const finding: Finding = {
          file: rel(file),
          line: line(node),
          kind: typeOnly ? 'import-type' : 'import-value',
          detail: spec,
        }
        if (typeOnly) out.typeOnlyStatic.push(finding)
        else out.staticImports.push(finding)
      }
    }
    // ② export … from '@elizaos/*'
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (isEliza(spec)) {
        out.exportFrom.push({ file: rel(file), line: line(node), kind: 'export-from', detail: spec })
      }
    }
    // ③ import('@elizaos/*') —— 动态 import
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      isEliza(node.arguments[0]!.text)
    ) {
      const arg = node.arguments[0] as ts.StringLiteral
      const parent = node.parent
      const isTypeOnly =
        parent !== undefined &&
        ts.isTypeQueryNode(parent) === false &&
        ts.isImportTypeNode(parent)
      out.dynamicImports.push({ file: rel(file), line: line(node), kind: 'import()', detail: arg.text })
      void isTypeOnly
    }
    // ④ typeof import('@elizaos/*') —— 类型引用
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      const spec = node.argument.literal.text
      if (isEliza(spec)) {
        out.typeOnlyDynamic.push({ file: rel(file), line: line(node), kind: 'typeof import()', detail: spec })
      }
    }
    // ⑤ require('@elizaos/*')
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      isEliza(node.arguments[0]!.text)
    ) {
      out.requires.push({ file: rel(file), line: line(node), kind: 'require()', detail: node.arguments[0]!.text })
    }
    // ⑥ require.resolve / createRequire(...).resolve('@elizaos/*')
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'resolve' &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      isEliza(node.arguments[0]!.text)
    ) {
      out.resolves.push({ file: rel(file), line: line(node), kind: '.resolve()', detail: node.arguments[0]!.text })
    }
    // ⑦ declare module '@elizaos/*'
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      const spec = node.name.text
      if (isEliza(spec)) {
        out.moduleDecls.push({ file: rel(file), line: line(node), kind: 'declare module', detail: spec })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

const files = walk(SRC)
const all = {
  staticImports: [] as Finding[],
  exportFrom: [] as Finding[],
  dynamicImports: [] as Finding[],
  typeOnlyDynamic: [] as Finding[],
  requires: [] as Finding[],
  resolves: [] as Finding[],
  moduleDecls: [] as Finding[],
  typeOnlyStatic: [] as Finding[],
}
for (const f of files) {
  const r = scan(f)
  all.staticImports.push(...r.staticImports)
  all.exportFrom.push(...r.exportFrom)
  all.dynamicImports.push(...r.dynamicImports)
  all.typeOnlyDynamic.push(...r.typeOnlyDynamic)
  all.requires.push(...r.requires)
  all.resolves.push(...r.resolves)
  all.moduleDecls.push(...r.moduleDecls)
  all.typeOnlyStatic.push(...r.typeOnlyStatic)
}

const show = (fs: Finding[], n = 3): string =>
  fs.length === 0 ? '（无）' : fs.slice(0, n).map((f) => `${f.file}:${f.line}`).join(', ') + (fs.length > n ? ` …共 ${String(fs.length)} 处` : '')

console.log(`扫描 src/ 共 ${String(files.length)} 个 .ts 文件\n`)

// ---------------------------------------------------------------------------
// A 档（W2 目标）= **运行时**依赖：代码会真的从包里拿东西
// ---------------------------------------------------------------------------
{
  /*
   * ⚠️ **唯一允许的例外**：`src/context/builder.ts` —— 旧上下文链路本体。
   *    D2 明写"旧路径**保留可读**但不再被任何入口调用" ⇒ 它必须继续 import
   *    `composePromptFromState` / `messageHandlerTemplate`（否则就不可读了）。
   *    ⇒ 断言"**恰好**只有它一个"，这样"再多一个"会被抓到。
   */
  const legacyException = 'context\\builder.ts'
  const offenders = all.staticImports.filter((f) => !f.file.endsWith(legacyException))
  const exempted = all.staticImports.filter((f) => f.file.endsWith(legacyException))
  check(
    'A1-no-runtime-value-import',
    offenders.length === 0,
    offenders.length === 0
      ? `src/ 内除旧链路本体外**没有**运行时值导入 @elizaos/*` +
        (exempted.length === 0
          ? '（旧链路本体已于 **W4** 一并退役 ⇒ 例外清单**为空**）'
          : `（例外：${exempted.map((f) => `${f.file}:${f.line}`).join(', ')} —— D2 要求它保留可读）`)
      : `仍有运行时值导入：${show(offenders)}`
  )
  check(
    'A1b-legacy-exception-is-exactly-one',
    all.staticImports.every((f) => f.file.endsWith(legacyException)),
    `旧链路例外**恰好**只有 context/builder.ts（当前 ${String(new Set(all.staticImports.map((f) => f.file)).size)} 个文件）`
  )
}
check(
  'A2-no-export-from',
  all.exportFrom.length === 0,
  all.exportFrom.length === 0 ? 'src/ 内没有 `export … from "@elizaos/*"`' : `仍有：${show(all.exportFrom)}`
)
check(
  'A3-no-dynamic-import',
  all.dynamicImports.length === 0,
  all.dynamicImports.length === 0 ? 'src/ 内没有 `import("@elizaos/*")`' : `仍有：${show(all.dynamicImports)}`
)
check(
  'A5-no-require',
  all.requires.length === 0,
  all.requires.length === 0 ? 'src/ 内没有 `require("@elizaos/*")`' : `仍有：${show(all.requires)}`
)

// ---------------------------------------------------------------------------
// B 档（W4 目标）= **类型 / 解析期**依赖 —— **如实计数**，不假装已达成
//
// ⚠️ 为什么要分档（不是"放宽判据"）：
//   `AgentRuntime` / `IAgentRuntime` / `Memory` / `State` / `UUID` / `Plugin` 这几个
//   **类型**散布在 51+ 处（adapters 20 · state/repository 11 · main 8 …）；
//   `src/types/plugins.d.ts` 的 `declare module` 是上游打包问题的**类型补丁**
//   （§5.1 说"整份可删"，但那要等包真的没了）；
//   `pglite-entry.ts` 的 `resolve('@elizaos/plugin-sql')` 是 PGlite 的**解析路径**
//   （要等 `@electric-sql/pglite` 变成直接依赖）。
//   ⇒ 一次性换掉它们是 W4 的"删依赖"工作，不该混进 W2 的"运行时替代"。
// ---------------------------------------------------------------------------
check(
  'B1-type-only-imports-counted',
  true,
  `src/ 内 type-only 导入 @elizaos/* 共 **${String(all.typeOnlyStatic.length)}** 处` +
    `（W4 目标 = 0；本门**如实计数**）：${show(all.typeOnlyStatic, 4)}`
)
check(
  'B4-type-only-dynamic-counted',
  true,
  `src/ 内 typeof import("@elizaos/*") 共 **${String(all.typeOnlyDynamic.length)}** 处` +
    `（W4 目标 = 0）：${show(all.typeOnlyDynamic, 3)}`
)
check(
  'B6-resolve-counted',
  true,
  `src/ 内 require.resolve / createRequire().resolve 指向 @elizaos/* 共 **${String(all.resolves.length)}** 处` +
    `（W4 目标 = 0；@electric-sql/pglite 变成直接依赖后可清）：${show(all.resolves)}`
)
check(
  'B7-declare-module-counted',
  true,
  `src/ 内 declare module "@elizaos/*" 共 **${String(all.moduleDecls.length)}** 处` +
    `（W4 目标 = 0；包还在时类型补丁仍需要）：${show(all.moduleDecls, 3)}`
)

// ---------------------------------------------------------------------------
// 负控：造六个违规形态 ⇒ 必须全部被抓到（证明判据有鉴别力）
// ---------------------------------------------------------------------------
{
  const samples: readonly [string, string][] = [
    ["import { AgentRuntime } from '@elizaos/core'", 'import-value'],
    ["export { x } from '@elizaos/plugin-sql'", 'export-from'],
    ["const m = await import('@elizaos/core')", 'import()'],
    ["type T = typeof import('@elizaos/core')['AgentRuntime']", 'typeof import()'],
    ["const m = require('@elizaos/core')", 'require()'],
    ["declare module '@elizaos/plugin-bootstrap' {}", 'declare module'],
  ]
  let missed = 0
  const missedKinds: string[] = []
  for (const [code, kind] of samples) {
    const tmp = join(SRC, '__m12_ast_probe__.ts')
    const { writeFileSync, unlinkSync } = await import('node:fs')
    writeFileSync(tmp, code, 'utf8')
    try {
      const r = scan(tmp)
      const caught =
        (kind === 'import-value' && r.staticImports.length > 0) ||
        (kind === 'export-from' && r.exportFrom.length > 0) ||
        (kind === 'import()' && r.dynamicImports.length > 0) ||
        (kind === 'typeof import()' && r.typeOnlyDynamic.length > 0) ||
        (kind === 'require()' && r.requires.length > 0) ||
        (kind === 'declare module' && r.moduleDecls.length > 0)
      if (!caught) {
        missed += 1
        missedKinds.push(kind)
      }
    } finally {
      unlinkSync(tmp)
    }
  }
  check(
    'N1-negative-controls',
    missed === 0,
    missed === 0
      ? `负控：${String(samples.length)} 个违规形态全部被 AST 判据抓到`
      : `漏抓 ${String(missed)} 个：${missedKinds.join(', ')}`
  )
}

const failed = checks.filter((c) => !c.ok)
console.log(`\n=== 脱依赖判据门（A 档 · W2 / B 档 · W4 计数）: ${checks.length - failed.length}/${checks.length} PASS ===`)
for (const f of failed) console.log(`FAILED: ${f.id} — ${f.detail}`)
if (failed.length > 0) process.exitCode = 1
