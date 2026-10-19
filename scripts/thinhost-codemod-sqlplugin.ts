/**
 * codemod（E 簇）：把 `@elizaos/plugin-sql` 的**运行时**导入拿掉（W4 删包的前置）。
 *
 * ============================================================================
 *  为什么现在做（W2 时我说"留到 W4"）
 * ============================================================================
 * `import sqlPlugin from '@elizaos/plugin-sql'` 是**运行时**导入 ⇒ 删包那一刻
 * 这些文件会**直接起不来**。而薄宿主**根本不解释插件**（`registerPlugin` 只注册适配器）
 * ⇒ 这个值**没有对象** ⇒ 拿掉它**不改变任何行为**。
 *
 * 实测形态（143 个文件）：
 *   · 144 处 `initDatabase(X, sqlPlugin)`（第二实参）
 *   · 103 处静态 import + 26 处动态 import
 *   · 6 处 `X.registerPlugin(sqlPlugin)`
 *
 * ============================================================================
 *  ⚠️ 必须按 **AST 标识符引用**判定，不能按文本
 * ============================================================================
 * 实测有一个门用**正则字符串**数这些调用的出现次数：
 *   `mainCode.match(/ready = await initDatabase\(runtime, sqlPlugin\)/g)`
 * 那行**必须原样保留** —— 改了它，门就改成在数一个不再存在的东西（**假绿**）。
 * ⇒ 只有"**代码里的** `sqlPlugin` 标识符引用"才动；字符串/正则/注释里的一个字都不碰
 *   （AST 天然如此：那些位置不是 Identifier 节点）。
 *
 * ⚠️ 另外：有些脚本用 `as unknown as { initDatabase: (runtime, plugin: unknown) => … }`
 *   **自己声明**了必填第二参 ⇒ 少传会报 `Expected 2 arguments` ⇒ 这类**如实报告**。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CHECK_ONLY = process.argv.includes('--check')
const SKIP = new Set(
  process.argv
    .filter((a) => a.startsWith('--skip='))
    .flatMap((a) => a.slice('--skip='.length).split(','))
    .map((s) => s.trim().split('\\').join('/'))
    .filter((s) => s !== ''),
)

/** 这些文件**故意**要** plugin-sql（判据依赖旧宿主 / 对照上游） */
const EXEMPT = new Set([
  'scripts/thinhost-ddl-decoupling-measure.ts',
  'scripts/thinhost-ddl-decoupling-verify.ts',
  'scripts/thinhost-equivalence-verify.ts',
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

/**
 * 剥掉 `as X` / `satisfies` / 括号 / `.default`，看**内核**是不是 `sqlPlugin` 这个标识符。
 *
 * ⚠️ 实测有两种包裹形态，第一版都没覆盖 ⇒ 结果是 0 编辑（"没有可去掉的点"）：
 *   · `initDatabase(runtime, sqlPlugin **as never**)`  ← 实参被断言包住
 *   · `const sqlPlugin = **(await import(…)).default**` ← 初始化式是属性访问
 */
function coreIdentifierIs(node: ts.Node, name: string): boolean {
  let n: ts.Node = node
  for (;;) {
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n) || ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n)) {
      n = (n as ts.AsExpression | ts.SatisfiesExpression | ts.ParenthesizedExpression | ts.NonNullExpression).expression
      continue
    }
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'default') { n = n.expression; continue }
    if (ts.isAwaitExpression(n)) { n = n.expression; continue }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const a = n.arguments[0]
      return a !== undefined && ts.isStringLiteral(a) && a.text === '@elizaos/plugin-sql'
    }
    return ts.isIdentifier(n) && n.text === name
  }
}

const migrated: string[] = []
const skipped = new Map<string, string[]>()

for (const file of [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'evals'))]) {
  const relPosix = relative(ROOT, file).split('\\').join('/')
  if (SKIP.has(relPosix)) { skipped.set('在 --skip 名单里（别人在改）', [...(skipped.get('在 --skip 名单里（别人在改）') ?? []), relPosix]); continue }
  if (EXEMPT.has(relPosix)) { skipped.set('有据豁免：判据**依赖旧宿主**', [...(skipped.get('有据豁免：判据**依赖旧宿主**') ?? []), relPosix]); continue }
  if (relPosix.endsWith('thinhost-codemod-sqlplugin.ts')) continue

  const src = readFileSync(file, 'utf8')
  if (!src.includes('plugin-sql')) continue
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // 该文件是否**自己声明**了必填第二参的 initDatabase 签名？
  let selfDeclaredInitDb = false
  const wType = (n: ts.Node): void => {
    if (ts.isTypeLiteralNode(n)) {
      for (const m of n.members) {
        const name = m.name && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)) ? m.name.text : ''
        if (name === 'initDatabase' && ts.isPropertySignature(m)) {
          const params = m.type && ts.isFunctionTypeNode(m.type) ? m.type.parameters : []
          if (params.length >= 2 && params[1]!.questionToken === undefined) selfDeclaredInitDb = true
        }
      }
    }
    ts.forEachChild(n, wType)
  }
  wType(sf)

  const edits: { start: number; end: number; text: string }[] = []
  let blocker = selfDeclaredInitDb ? '该文件**自己声明**了必填第二参的 initDatabase 签名（人工判）' : ''

  const visit = (n: ts.Node): void => {
    if (blocker !== '') return

    // ① `initDatabase(X, sqlPlugin)` → `initDatabase(X)`（实参可被 `as never` 包住）
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'initDatabase' && n.arguments.length === 2) {
      if (coreIdentifierIs(n.arguments[1]!, 'sqlPlugin')) {
        const first = n.arguments[0]!.getText(sf)
        edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `initDatabase(${first})` })
        return
      }
    }
    // ② `X.registerPlugin(sqlPlugin)` → `X.registerPlugin(undefined as never)`
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'registerPlugin' && n.arguments.length === 1) {
      if (coreIdentifierIs(n.arguments[0]!, 'sqlPlugin')) {
        const recv = n.expression.expression.getText(sf)
        edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `${recv}.registerPlugin(undefined as never)` })
        return
      }
    }
    // ③ 静态 import
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === '@elizaos/plugin-sql') {
      edits.push({ start: n.getStart(sf), end: n.getEnd(), text: '' })
      return
    }
    // ④ 动态 import：`const sqlPlugin = (await import('@elizaos/plugin-sql')).default`
    if (ts.isVariableStatement(n)) {
      for (const decl of n.declarationList.declarations) {
        const init = decl.initializer
        if (init === undefined) continue
        if (ts.isIdentifier(decl.name) && decl.name.text === 'sqlPlugin' && coreIdentifierIs(init, 'sqlPlugin')) {
          edits.push({ start: n.getStart(sf), end: n.getEnd(), text: '' })
        }
      }
      return
    }
    // ⑤ 其它**代码里**对 `sqlPlugin` 的引用 ⇒ 报出来（字符串/正则不算，AST 天然不匹配）
    // ⚠️⚠️ **这里不能判**（同一个坑的第三次）：本文件此刻**还没删掉导入**，
    //   所以"声明本身"一定还在 ⇒ 永远判成"还有引用" ⇒ 一处也改不了。
    //   ⇒ 改成：先按 ①②③④ 生成 edits → 应用 → 再在**结果上**数。
    //   （真实命中：`initDatabase(runtime, sqlPlugin)` 被 ① 改掉后，
    //     `const sqlPlugin = …` 才真的变成"没有被引用"。）
    ts.forEachChild(n, visit)
  }
  visit(sf)

  edits.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const e of edits) {
    if (e.start < cursor) continue
    out += src.slice(cursor, e.start) + e.text
    cursor = e.end
  }
  out += src.slice(cursor)
  out = out.replace(/\n{3,}/g, '\n\n')

  if (edits.length > 0) {
    {
      const DUMP = process.argv.find((a) => a.startsWith('--dump='))
      if (DUMP !== undefined && DUMP.slice('--dump='.length) === relPosix) {
        console.log('--- edits ---')
        for (const e of edits) {
          console.log(`  [${String(e.start)}..${String(e.end)}] ${src.slice(e.start, e.start + 46).replace(/\n/g, '|')}  =>  ${e.text.slice(0, 40).replace(/\n/g, '|')}`)
        }
        console.log('--- out lines still containing sqlPlugin ---')
        for (const [i, l] of out.split('\n').entries()) {
          if (l.includes('sqlPlugin')) console.log(`  L${String(i + 1)}: ${l.trim()}`)
        }
      }
    }
    const sfAfter = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const left: string[] = []
    const wLeft = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && n.text === 'sqlPlugin') {
        const parent = n.parent
        const inDecl = ts.isVariableDeclaration(parent) || ts.isImportDeclaration(parent.parent ?? parent)
        if (!inDecl) left.push(`L${String(n.getStart(sfAfter))}`)
      }
      ts.forEachChild(n, wLeft)
    }
    wLeft(sfAfter)
    if (left.length > 0) {
      // ⚠️ 报告**行号 + 上下文**，不要只给偏移（偏移没法定位；第一版给了偏移，定位不了）
      const details = left.slice(0, 3).map((p) => {
        const line = sfAfter.getLineAndCharacterOfPosition(Number(p.slice(1))).line + 1
        const text = sfAfter.getFullText().split('\n')[line - 1]?.trim() ?? ''
        return `${p}(L${String(line)}): ${text.slice(0, 70)}`
      }).join(' ｜ ')
      skipped.set(`删掉导入后**还有**代码引用 sqlPlugin（人工判）—— ${details}`, [
        ...(skipped.get(`删掉导入后**还有**代码引用 sqlPlugin（人工判）`) ?? []),
        relPosix,
      ])
      continue
    }
  }
  if (edits.length === 0) { skipped.set('没有可去掉的点（可能只是未使用的导入）', [...(skipped.get('没有可去掉的点（可能只是未使用的导入）') ?? []), relPosix]); continue }
  if (out === src) continue
  migrated.push(relPosix)
  if (!CHECK_ONLY) writeFileSync(file, out, 'utf8')
}

console.log(`【${CHECK_ONLY ? 'check' : '改'}】去掉 plugin-sql ${String(migrated.length)} 个 / 如实跳过 ${String([...skipped.values()].reduce((n, a) => n + a.length, 0))} 个`)
console.log('\n=== 如实跳过 ===')
for (const [reason, files] of [...skipped.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${reason}  (${String(files.length)} 个)`)
  for (const f of files.slice(0, 6)) console.log(`      ${f}`)
  if (files.length > 6) console.log(`      …共 ${String(files.length)} 个`)
}
