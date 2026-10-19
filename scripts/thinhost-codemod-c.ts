/**
 * codemod（C 簇，第二版）：把 `new AgentRuntime({...})` 换成薄宿主工厂。
 *
 * ============================================================================
 *  第一版为什么被证伪（2026-10-19，`pnpm typecheck` 抓到三类真错）
 * ============================================================================
 * ① 硬编码了接收者名 `runtime` ⇒ 那批文件的变量叫 `agentRuntime` ⇒ `Cannot find name`
 * ② 补 `import type { AgentRuntime }` 时**没看文件里已有没有** ⇒ `Duplicate identifier`
 * ③ 完全没考虑**惰性**用法（脚本把 runtime 包成 thunk 再传）⇒ 真实语义差异
 *
 * ⇒ 第二版：**每一处都用 AST 里读到的真实文本**，不硬编码任何标识符。
 * ③ 无法判定的形态一律**跳过并如实报告**（不猜）。
 *
 * ============================================================================
 *  配套的收敛循环（**这是"改完怎么证明没弄坏"的答案**）
 * ============================================================================
 *   改 → `pnpm typecheck` → 把**报错文件**回滚 → 再 typecheck → 重复直到零错。
 *   ⇒ 最后留在盘上的文件，**每一个都被 typecheck 验过**。
 *   ⚠️ typecheck 只证明"类型对"，不证明"行为对" ⇒ 还要跑门（见 `--verify` 说明）。
 *
 * ⚠️ 纪律：
 *   · 只改 `import` 与构造表达式的**文本范围**，其余**逐字节不动**
 *   · `--skip=` 排除**别的会话在改的文件**（那是别人的活）
 *   · 不碰 `composeState` / `messageHandlerTemplate` / `composePromptFromState`
 *     （薄宿主对它们**失败关闭**）
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

/** 剥掉 `as X` / `satisfies X` / 括号，返回内层表达式（第二版漏了 `as never` 那批） */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node
  while (true) {
    if (ts.isAsExpression(n) || ts.isSatisfiesExpression(n)) { n = n.expression; continue }
    if (ts.isParenthesizedExpression(n)) { n = n.expression; continue }
    if (ts.isNonNullExpression(n)) { n = n.expression; continue }
    return n
  }
}

const ALLOWED_KEYS = new Set(['character', 'plugins', 'settings', 'conversationLength'])
const BLOCKERS = ['composeState', 'messageHandlerTemplate', 'composePromptFromState']

/**
 * ⚠️ **有据豁免**：这些文件**故意**用旧宿主，迁移会让它们**失去意义**。
 *
 * `thinhost-ddl-decoupling-*` 是"薄宿主启动**不跑** DDL"的门，手段是
 * **给 `runtime.runPluginMigrations` 装计数器**再数调用次数。
 * 而薄宿主对 `runPluginMigrations()` **失败关闭**（它不解释插件 ⇒ 没有 DDL 可跑）
 * ⇒ 迁过去等于"把一把没有子弹的枪装上计数器"，门会**假绿**。
 *
 * ⇒ 它们**必须留在旧宿主上**，直到 W4 决定退役。
 * ⚠️ 这不是"忘了改"，是**判据依赖旧宿主**；已如实登记。
 */
const EXEMPT = new Set([
  'scripts/thinhost-ddl-decoupling-measure.ts',
  'scripts/thinhost-ddl-decoupling-verify.ts',
  'scripts/thinhost-equivalence-verify.ts', // 故意**同时**造两个宿主做对照
])

function propKeyAndValue(prop: ts.ObjectLiteralElementLike, sf: ts.SourceFile): { key: string; value: string } | undefined {
  if (ts.isPropertyAssignment(prop)) {
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : ''
    return { key, value: prop.initializer.getText(sf) }
  }
  if (ts.isShorthandPropertyAssignment(prop)) return { key: prop.name.text, value: prop.name.text }
  return undefined
}

const migrated: string[] = []
const skipped = new Map<string, string[]>()

for (const file of [...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'evals'))]) {
  const relPosix = relative(ROOT, file).split('\\').join('/')
  if (SKIP.has(relPosix)) { skipped.set('在 --skip 名单里（别人在改）', [...(skipped.get('在 --skip 名单里（别人在改）') ?? []), relPosix]); continue }
  if (EXEMPT.has(relPosix)) { skipped.set('有据豁免：判据**依赖旧宿主**（见 EXEMPT 的说明）', [...(skipped.get('有据豁免：判据**依赖旧宿主**（见 EXEMPT 的说明）') ?? []), relPosix]); continue }
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // 入口：AST 里真有 `new AgentRuntime(` 吗？（不是字符串里出现）
  let hasReal = false
  const w0 = (n: ts.Node): void => {
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'AgentRuntime') hasReal = true
    ts.forEachChild(n, w0)
  }
  w0(sf)
  if (!hasReal) continue

  // 前置判据
  let blocker = ''
  const check = (n: ts.Node): void => {
    if (blocker !== '') return
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      if (BLOCKERS.includes(n.expression.name.text)) blocker = `调了薄宿主失败关闭的 ${n.expression.name.text}()`
    }
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'AgentRuntime') {
      if (n.arguments === undefined || n.arguments.length !== 1) { blocker = '构造参数不是恰好一个'; return }
      // ⚠️ ⚠️ **必须解包**：那 17 个文件写的是 `new AgentRuntime({ … } as never)`
      //    —— 第二版没解包 ⇒ 报"构造参数不是对象字面量"⇒ 白白放过 17 个文件。
      const arg = unwrap(n.arguments[0]!)
      if (!ts.isObjectLiteralExpression(arg)) { blocker = '构造参数不是对象字面量'; return }
      for (const prop of arg.properties) {
        const kv = propKeyAndValue(prop, sf)
        if (kv === undefined) { blocker = `构造属性形态未识别：${prop.getText(sf).slice(0, 20)}`; return }
        if (!ALLOWED_KEYS.has(kv.key)) { blocker = `构造属性超出已知集合：${kv.key}`; return }
      }
    }
    // ⚠️ `AgentRuntime` 来自 **动态 import** 的，一律**不改**（如实报告）。
    //   第三版试过自动改写那 17 处 ⇒ typecheck 抓到 13 个错，两类：
    //   ① 补的静态 import 与动态绑定**同名撞车**（TS2440
    //      `Import declaration conflicts with local declaration of 'createThinHostRuntime'`）
    //   ② 改写 module specifier 时**误伤同一模块**的另一个取值
    //      （`Property 'stringToUuid' does not exist on …thin-host-factory`）
    //   ⇒ 这批要**人工逐个判**：它们刻意把宿主放在"碰数据库之前"动态导入。
    if (ts.isVariableStatement(n)) {
      for (const decl of n.declarationList.declarations) {
        const init = decl.initializer
        if (init === undefined || !ts.isAwaitExpression(init)) continue
        const call = init.expression
        if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) continue
        const arg0 = call.arguments[0]
        if (arg0 === undefined || !ts.isStringLiteral(arg0) || arg0.text !== '@elizaos/core') continue
        if (!ts.isObjectBindingPattern(decl.name)) continue
        if (decl.name.elements.some((e) => ts.isIdentifier(e.name) && e.name.text === 'AgentRuntime')) {
          blocker = '`AgentRuntime` 来自**动态 import**（人工判：刻意放在"碰数据库之前"）'
          return
        }
      }
    }
    ts.forEachChild(n, check)
  }
  check(sf)
  if (blocker !== '') { skipped.set(blocker, [...(skipped.get(blocker) ?? []), relPosix]); continue }

  // 收集：每处构造 + 每处替换（**接收者一律用 AST 读到的真实文本**）
  const edits: { start: number; end: number; text: string }[] = []
  let characterExpr: string | undefined
  let settingsExpr = '{}'
  let convLength: string | undefined
  let needDbApi = false

  const w1 = (n: ts.Node): void => {
    // 构造（⚠️ 解包 `as never` 之后才是对象字面量）
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'AgentRuntime') {
      const arg = unwrap(n.arguments![0]!) as ts.ObjectLiteralExpression
      for (const prop of arg.properties) {
        const kv = propKeyAndValue(prop, sf)
        if (!kv) continue
        if (kv.key === 'character') {
          characterExpr = /^([A-Za-z_$][\w$]*)\s+as\s+.+$/.test(kv.value)
            ? kv.value.match(/^([A-Za-z_$][\w$]*)\s+as\s+/)![1]!
            : kv.value
        } else if (kv.key === 'settings') settingsExpr = kv.value
        else if (kv.key === 'conversationLength') convLength = kv.value
      }
      const fields = [`character: ${characterExpr},`, `settings: ${settingsExpr},`]
      if (convLength !== undefined) fields.push(`conversationLength: ${convLength},`)
      edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `createThinHostRuntime({\n    ${fields.join('\n    ')}\n  })` })
    }
    // ⚠️ **不改** `initDatabase(X, sqlPlugin)` —— 第二版踩过：
    //   某些脚本用 `as unknown as { initDatabase: (runtime, plugin: unknown) => … }`
    //   **自己声明**了一个两参数签名 ⇒ 少传第二个参数会报
    //   `Expected 2 arguments, but got 1`。保留第二个实参对可选形参无害，
    //   而那份 `sqlPlugin` 导入留到 W4 一起清（W4 是"删包"，本步不预支）。
    // X.runPluginMigrations() → await __applyKernelMigrations(__getRawDb(X))
    //    ⚠️ 第一版硬编码了 `runtime` ⇒ 这里用 AST 读到的**真实**接收者
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'runPluginMigrations' && n.arguments.length === 0) {
      const recv = n.expression.expression.getText(sf)
      edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `await __applyKernelMigrations(__getRawDb(${recv}))` })
      needDbApi = true
    }
    // X.registerPlugin(sqlPlugin) → X.registerPlugin(undefined as never)
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'registerPlugin' && n.arguments.length === 1) {
      if (/sqlPlugin/.test(n.arguments[0]!.getText(sf))) {
        const recv = n.expression.expression.getText(sf)
        edits.push({ start: n.getStart(sf), end: n.getEnd(), text: `${recv}.registerPlugin(undefined as never)` })
      }
    }
    // ⚠️⚠️ **第三版试过自动改写动态 import，被 typecheck 证伪，已删除**：
    //   `const { AgentRuntime } = await import('@elizaos/core')` → 工厂模块
    //   抓到两类错：① 静态 import 与动态绑定**同名撞车**（TS2440）
    //             ② 改 specifier 时**误伤同模块的 `stringToUuid`** 取值
    //   ⇒ 那 17 个文件现在被 `check` 阶段的 blocker **如实报告**，人工逐个判。
    // ⚠️ "是否已存在 AgentRuntime 导入"**不在这里判** —— 第二版在这里判（对原文），
    //    而那条导入正是**马上要剥掉的** ⇒ 永远判成"已存在" ⇒ 永远不补 type 导入
    //    ⇒ 16 个文件 `Cannot find name 'AgentRuntime'`。现在改在**剥完之后**的文本上数。
    ts.forEachChild(n, w1)
  }
  w1(sf)

  if (characterExpr === undefined) { skipped.set('取不到 character 表达式', [...(skipped.get('取不到 character 表达式') ?? []), relPosix]); continue }
  if (edits.length === 0) { skipped.set('没有可自动替换的点', [...(skipped.get('没有可自动替换的点') ?? []), relPosix]); continue }

  edits.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const e of edits) {
    if (e.start < cursor) continue
    out += src.slice(cursor, e.start) + e.text
    cursor = e.end
  }
  out += src.slice(cursor)

  // ---- import 处理 ----
  const sf2 = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const importEdits: { start: number; end: number; text: string }[] = []
  let keepTypeImport = false

  const w2 = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const mod = n.moduleSpecifier.text
      if (mod === '@elizaos/plugin-sql' || mod === '@elizaos/plugin-bootstrap' || mod === '@elizaos/plugin-openai') {
        const binding = n.importClause?.name?.text
        // ⚠️ 只在**确实不再被引用**时才删（第二版修了"只判单行"的粗糙做法）
        if (binding && (out.match(new RegExp(`\\b${binding}\\b`, 'g')) ?? []).length <= 1) {
          importEdits.push({ start: n.getStart(sf2), end: n.getEnd(), text: '' })
        }
        return
      }
      if (mod === '@elizaos/core') {
        const clause = n.importClause
        const named = clause?.namedBindings
        if (named !== undefined && ts.isNamedImports(named) && clause) {
          const keep = named.elements.filter((el) => (el.propertyName ?? el.name).text !== 'AgentRuntime').map((el) => el.getText(sf2))
          if (keep.length === 0 && clause.name === undefined) {
            importEdits.push({ start: n.getStart(sf2), end: n.getEnd(), text: '' })
          } else if (keep.length !== named.elements.length) {
            const typePrefix = clause.isTypeOnly ? 'type ' : ''
            const defaultPart = clause.name !== undefined ? `${clause.name.text}, ` : ''
            importEdits.push({ start: n.getStart(sf2), end: n.getEnd(), text: `import ${typePrefix}{ ${defaultPart}${keep.join(', ')} } from '@elizaos/core'` })
          }
          keepTypeImport = true
        }
      }
    }
    ts.forEachChild(n, w2)
  }
  w2(sf2)

  let final = out
  if (importEdits.length > 0) {
    importEdits.sort((a, b) => a.start - b.start)
    let acc = ''
    let cur = 0
    for (const e of importEdits) {
      if (e.start < cur) continue
      acc += final.slice(cur, e.start) + e.text
      cur = e.end
    }
    acc += final.slice(cur)
    final = acc
  }

  // ⚠️⚠️ **顺序是这里的关键**（第二版在这里栽了两次）：
  //   "还剩几条 AgentRuntime 导入"必须数在**剥完之后**的文本上。
  //   第一次数在**原文**上 ⇒ 把"正要剥掉的那条"算成"已存在"；
  //   第二次数在**剥之前**的文本（`out`）上 ⇒ **同一个错**（它还没被剥）⇒
  //   16 个文件 `Cannot find name 'AgentRuntime'`。
  //   ⇒ 现在：先剥（上面的 splice）→ 再数 → 最后才决定补不补。
  if (keepTypeImport) {
    const sfStripped = ts.createSourceFile(file, final, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    let agentImportsLeft = 0
    let agentIdentifierCount = 0
    const count = (n: ts.Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.moduleSpecifier.text === '@elizaos/core') {
        const named = n.importClause?.namedBindings
        if (named !== undefined && ts.isNamedImports(named)) {
          for (const el of named.elements) {
            if ((el.propertyName ?? el.name).text === 'AgentRuntime') agentImportsLeft++
          }
        }
      }
      if (ts.isIdentifier(n) && n.text === 'AgentRuntime') agentIdentifierCount++
      ts.forEachChild(n, count)
    }
    count(sfStripped)
    if (agentIdentifierCount > 0 && agentImportsLeft === 0) {
      const sfX = ts.createSourceFile(file, final, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
      const at = sfX.statements[0]!.getStart(sfX)
      final = final.slice(0, at) + `import type { AgentRuntime } from '@elizaos/core'\n` + final.slice(at)
    }
  }
  const adds: string[] = []
  if (final.includes('createThinHostRuntime(')) adds.push(`import { createThinHostRuntime } from '${importPathFor(file, 'src/infrastructure/runtime/thin-host-factory.ts')}'`)
  if (needDbApi) adds.push(`import { applyKernelMigrations as __applyKernelMigrations, getRawDb as __getRawDb } from '${importPathFor(file, 'src/infrastructure/persistence/db.ts')}'`)
  if (adds.length > 0) {
    const sf4 = ts.createSourceFile(file, final, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const at = sf4.statements[0]!.getStart(sf4)
    final = final.slice(0, at) + adds.join('\n') + '\n' + final.slice(at)
  }

  if (final === src) continue
  migrated.push(relPosix)
  if (!CHECK_ONLY) writeFileSync(file, final, 'utf8')
}

console.log(`【${CHECK_ONLY ? 'check' : '改'}】迁移 ${String(migrated.length)} 个 / 如实跳过 ${String([...skipped.values()].reduce((n, a) => n + a.length, 0))} 个`)
for (const m of migrated) console.log(`  M ${m}`)
console.log('\n=== 如实跳过（**没改**）===')
for (const [reason, files] of [...skipped.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${reason}  (${String(files.length)} 个)`)
  for (const f of files.slice(0, 6)) console.log(`      ${f}`)
  if (files.length > 6) console.log(`      …共 ${String(files.length)} 个`)
}
