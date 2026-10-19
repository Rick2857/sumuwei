/**
 * codemod（D 簇）：把 `await import('@elizaos/core')` **动态**导入按符号拆到本地模块。
 *
 * ============================================================================
 *  为什么单独一个 codemod（而不是并进 C 簇那个）
 * ============================================================================
 * 那 17 个文件把宿主放在"**碰数据库之前**"动态导入（注释写明），
 * 所以静态 import 那套处理不到它们。
 *
 * ⚠️ 第三版试过自动改写，被 typecheck 抓到 13 个错，两类：
 * ① 补的静态 import 与动态绑定**同名撞车**（TS2440）
 * ② 把 module specifier 整个换掉 ⇒ **误伤同一个解构里的其它符号**
 *    实测根因：有 3 个文件写的是
 *      `const { AgentRuntime, stringToUuid } = await import('@elizaos/core')`
 *    而**上游也导出 `stringToUuid`** ⇒ 整条换过去就少了它
 *    （`Property 'stringToUuid' does not exist on …thin-host-factory`）
 *
 * ⇒ 正确做法：**按符号拆**。每个符号去它自己的本地模块，
 *   一个都不留在 `@elizaos/core` 上。
 *
 * ============================================================================
 *  拆分表
 * ============================================================================
 * | 上游符号 | 本地模块 |
 * | --- | --- |
 * | `AgentRuntime` | `src/infrastructure/runtime/thin-host-factory.ts` 的 `createThinHostRuntime`（**改名**） |
 * | `stringToUuid` | `src/kernel/contracts/uuid.ts` |
 *
 * ⚠️ **有意不动的**：
 *  · 薄宿主门（`thinhost-*`）—— 它们**故意**动态导入上游做**对照**，
 *    换掉就等于把"与上游比"的判据改成"与自己比"（自证）。
 *  · `verify-m5.1.1-d01-live-smoke.ts` —— 同上（门里对上游取值）。
 *  · `test-persist-write.ts` —— `(await import('@elizaos/core')).stringToUuid(…)`
 *    是**属性访问**而不是解构，形态不同 ⇒ 如实报告。
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

/** 符号 → [本地模块相对路径, 本地导出名] */
const LOCAL: Record<string, [string, string]> = {
  stringToUuid: ['src/kernel/contracts/uuid.ts', 'stringToUuid'],
  AgentRuntime: ['src/infrastructure/runtime/thin-host-factory.ts', 'createThinHostRuntime'],
}

/** 故意动态导入上游做**对照**的门 —— 换掉就变成自证 */
const UPSTREAM_COMPARISON = new Set([
  'scripts/thinhost-vocabulary-verify.ts',
  'scripts/thinhost-reply-parser-freeze.ts',
  'scripts/thinhost-no-eliza-in-src-verify.ts',
  'scripts/verify-m5.1.1-d01-live-smoke.ts',
])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}
function importPathFor(file: string, target: string): string {
  const rel = relative(dirname(file), join(ROOT, target)).split('\\').join('/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

const migrated: string[] = []
const skipped = new Map<string, string[]>()

for (const file of [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'evals'))]) {
  const relPosix = relative(ROOT, file).split('\\').join('/')
  if (SKIP.has(relPosix)) { skipped.set('在 --skip 名单里（别人在改）', [...(skipped.get('在 --skip 名单里（别人在改）') ?? []), relPosix]); continue }
  if (UPSTREAM_COMPARISON.has(relPosix)) { skipped.set('有意导入上游做**对照**（换掉就变自证）', [...(skipped.get('有意导入上游做**对照**（换掉就变自证）') ?? []), relPosix]); continue }
  if (relPosix === 'scripts/thinhost-codemod-dynamic.ts' || relPosix === 'scripts/thinhost-codemod-c.ts') continue

  const src = readFileSync(file, 'utf8')
  if (!src.includes("import('@elizaos/core')") && !src.includes('import("@elizaos/core")')) continue
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const edits: { start: number; end: number; text: string }[] = []
  let blocker = ''

  const visit = (n: ts.Node): void => {
    if (blocker !== '') return
    if (!ts.isVariableStatement(n)) { ts.forEachChild(n, visit); return }
    for (const decl of n.declarationList.declarations) {
      const init = decl.initializer
      if (init === undefined || !ts.isAwaitExpression(init)) continue
      const call = init.expression
      if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) continue
      const spec = call.arguments[0]
      if (spec === undefined || !ts.isStringLiteral(spec) || spec.text !== '@elizaos/core') continue

      if (!ts.isObjectBindingPattern(decl.name)) {
        blocker = `动态导入的解构形态未识别：${decl.name.getText(sf).slice(0, 30)}`
        return
      }
      // 按符号分组
      //
      // ⚠️⚠️ **重命名必须用 `:` 形式，不能用 `as`**（第三版的真错）：
      //   `as` 只存在于 **import/export 子句**；
      //   **对象解构**的重命名语法是 `{ 原名: 新名 }`。
      //   我曾输出 `const { createThinHostRuntime as AgentRuntime } = …`
      //   ⇒ **非法语法** ⇒ 30 个文件 TS1005（Node 自己也报 ERR_INVALID_TYPESCRIPT_SYNTAX）。
      //   ⚠️ 一度误以为是"这台机器的 tsc 坏了" ⇒ 在仓库外用 Node 写的
      //      无 BOM 最小样例复现，才定位到是**我自己的错**。
      const byModule = new Map<string, string[]>()
      for (const el of decl.name.elements) {
        if (!ts.isIdentifier(el.name)) { blocker = '解构元素不是标识符'; return }
        const local = el.name.text
        const target = LOCAL[local]
        if (target === undefined) { blocker = `符号没有本地对应物：${local}`; return }
        const arr = byModule.get(target[0]) ?? []
        // ⚠️ **推的是本地导出名**（`target[1]`），不是上游名。
        //   `AgentRuntime` → 本地叫 `createThinHostRuntime`；
        //   推 `local`（= `AgentRuntime`）会得到
        //   `Property 'AgentRuntime' does not exist on type 'thin-host-factory'`（实测）。
        arr.push(target[1])
        byModule.set(target[0], arr)
      }
      const lines = [...byModule.entries()].map(
        ([mod, names]) => `const { ${names.sort().join(', ')} } = await import('${importPathFor(file, mod)}')`,
      )
      edits.push({ start: n.getStart(sf), end: n.getEnd(), text: lines.join('\n  ') })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)

  // ---- 第二处改写：`new AgentRuntime({…})` → `createThinHostRuntime({…})` ----
  // ⚠️ 与 C 簇同一套语义：**丢 `plugins`**（薄宿主不解释插件）· 保留
  //   `character` / `settings` / `conversationLength` · **不传 `agentId`**（工厂推导）。
  // ⚠️ 构造实参常被写成 `{…} as never` ⇒ 必须解包。
  let blocker2 = ''
  const visit2 = (n: ts.Node): void => {
    if (blocker2 !== '') return
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'AgentRuntime') {
      if (n.arguments === undefined || n.arguments.length !== 1) { blocker2 = '构造参数不是恰好一个'; return }
      let arg: ts.Expression = n.arguments[0]!
      while (ts.isAsExpression(arg) || ts.isSatisfiesExpression(arg) || ts.isParenthesizedExpression(arg)) {
        arg = arg.expression
      }
      if (!ts.isObjectLiteralExpression(arg)) { blocker2 = '构造参数不是对象字面量'; return }
      let characterExpr: string | undefined
      let settingsExpr = '{}'
      let convLength: string | undefined
      for (const prop of arg.properties) {
        let key = ''
        let value = ''
        if (ts.isPropertyAssignment(prop)) {
          key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : ''
          value = prop.initializer.getText(sf)
        } else if (ts.isShorthandPropertyAssignment(prop)) {
          key = prop.name.text
          value = prop.name.text
        } else { blocker2 = `构造属性形态未识别：${prop.getText(sf).slice(0, 20)}`; return }
        if (key === 'character') {
          characterExpr = /^([A-Za-z_$][\w$]*)\s+as\s+.+$/.test(value) ? value.match(/^([A-Za-z_$][\w$]*)\s+as\s+/)![1]! : value
        } else if (key === 'settings') settingsExpr = value
        else if (key === 'conversationLength') convLength = value
        else if (key !== 'plugins') { blocker2 = `构造属性超出已知集合：${key}`; return }
      }
      if (characterExpr === undefined) { blocker2 = '取不到 character 表达式'; return }
      const fields = [`character: ${characterExpr},`, `settings: ${settingsExpr},`]
      if (convLength !== undefined) fields.push(`conversationLength: ${convLength},`)
      edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `createThinHostRuntime({\n      ${fields.join('\n      ')}\n    })` })
    }
    ts.forEachChild(n, visit2)
  }
  visit2(sf)

  if (blocker2 !== '') { skipped.set(blocker2, [...(skipped.get(blocker2) ?? []), relPosix]); continue }

  if (blocker !== '') { skipped.set(blocker, [...(skipped.get(blocker) ?? []), relPosix]); continue }
  if (edits.length === 0) { skipped.set('没有可拆的解构', [...(skipped.get('没有可拆的解构') ?? []), relPosix]); continue }

  edits.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const e of edits) {
    if (e.start < cursor) continue
    out += src.slice(cursor, e.start) + e.text
    cursor = e.end
  }
  out += src.slice(cursor)
  if (out === src) continue
  migrated.push(relPosix)
  if (!CHECK_ONLY) writeFileSync(file, out, 'utf8')
}

console.log(`【${CHECK_ONLY ? 'check' : '改'}】动态导入拆分 ${String(migrated.length)} 个 / 如实跳过 ${String([...skipped.values()].reduce((n, a) => n + a.length, 0))} 个`)
for (const m of migrated) console.log(`  M ${m}`)
console.log('\n=== 如实跳过 ===')
for (const [reason, files] of [...skipped.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${reason}  (${String(files.length)} 个)`)
  for (const f of files.slice(0, 5)) console.log(`      ${f}`)
  if (files.length > 5) console.log(`      …共 ${String(files.length)} 个`)
}
