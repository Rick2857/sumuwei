/**
 * 诊断：把 `scripts/` + `evals/` 里对 `@elizaos/*` 的依赖**按耦合簇**分类（M12 · W3）。
 *
 * ⚠️ **不靠印象、不靠 grep 计数** —— 用 AST 判定"这个文件到底从包里拿了什么"：
 *   · **值**（会真的从包里拿东西）⇒ 需要替换
 *   · **类型**（只在编译期存在）⇒ 删包后会编译失败，但运行时不需要
 *   · 两者都要**按簇**处理，因为"一个文件要同时处理值与类型"与"只处理类型"
 *     的改法完全不同。
 *
 * 输出：每个簇的文件数 + 涉及的符号 + 代表文件。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

interface Usage {
  file: string
  /** 从 @elizaos/* 取到的**值**符号 */
  values: Set<string>
  /** 从 @elizaos/* 取到的**类型**符号 */
  types: Set<string>
  /** 其它形态：动态 import / require / declare module / typeof import() */
  otherForms: string[]
}

const usages: Usage[] = []

for (const file of [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'evals'))]) {
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const u: Usage = { file: relative(ROOT, file), values: new Set(), types: new Set(), otherForms: [] }

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text
      if (!spec.startsWith('@elizaos/')) { ts.forEachChild(node, visit); return }
      const clause = node.importClause
      if (clause === undefined) { ts.forEachChild(node, visit); return }
      if (clause.name !== undefined && clause.isTypeOnly !== true) u.values.add('default')
      const named = clause.namedBindings
      if (named !== undefined && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          const name = (el.propertyName ?? el.name).text
          const typeOnly = el.isTypeOnly || clause.isTypeOnly
          if (typeOnly) u.types.add(name)
          else u.values.add(name)
        }
      }
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text.startsWith('@elizaos/')) u.otherForms.push('export-from')
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = node.arguments[0]
      if (a !== undefined && ts.isStringLiteral(a) && a.text.startsWith('@elizaos/')) {
        u.otherForms.push(`import(${a.text})`)
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') {
      const a = node.arguments[0]
      if (a !== undefined && ts.isStringLiteral(a) && a.text.startsWith('@elizaos/')) {
        u.otherForms.push(`require(${a.text})`)
      }
    }
    if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith('@elizaos/')) {
      u.otherForms.push('declare module')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)

  if (u.values.size > 0 || u.types.size > 0 || u.otherForms.length > 0) usages.push(u)
}

// ---------------------------------------------------------------------------
// 分簇
// ---------------------------------------------------------------------------
const allValues = new Set<string>()
const allTypes = new Set<string>()
for (const u of usages) {
  for (const v of u.values) allValues.add(v)
  for (const t of u.types) allTypes.add(t)
}

const valueOnly = usages.filter((u) => u.values.size === 0)
const hasValue = usages.filter((u) => u.values.size > 0)

console.log(`scanned scripts/ + evals/  ⇒ ${usages.length} 个文件引用 @elizaos/*\n`)
console.log(`=== 符号清单 ===`)
console.log(`值（需替换）: ${[...allValues].sort().join(', ')}`)
console.log(`类型（删包后编译失败）: ${[...allTypes].sort().join(', ')}\n`)

console.log(`=== 簇 1 · 只用类型（${valueOnly.length} 个文件）===\n`)
console.log(`  这些文件删包后会**编译失败**，但**运行时不需要**上游`)
console.log(`  ⇒ 改法：把类型从 @elizaos/core 换成本地等价类型（B 档 · W4）\n`)

console.log(`=== 簇 2 · 用了值（${hasValue.length} 个文件）===\n`)
const byValue = new Map<string, Usage[]>()
for (const u of hasValue) {
  for (const v of u.values) {
    const arr = byValue.get(v) ?? []
    arr.push(u)
    byValue.set(v, arr)
  }
}
for (const [v, arr] of [...byValue.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${v}  (${String(arr.length)} 个文件)`)
  for (const u of arr.slice(0, 3)) console.log(`      ${u.file}`)
  if (arr.length > 3) console.log(`      …共 ${String(arr.length)} 个`)
}

console.log(`\n=== 其它形态（动态 import / require / declare module）===`)
for (const u of usages) {
  if (u.otherForms.length > 0) console.log(`  ${u.file}: ${u.otherForms.join(', ')}`)
}
