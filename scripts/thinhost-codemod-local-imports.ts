/**
 * codemod：把 `scripts/` + `evals/` 里从 `@elizaos/core` 导入的
 * **已有本地等价物**的符号，换成本地模块（M12 · W3 · B 簇）。
 *
 * ============================================================================
 *  换的是哪四个
 * ============================================================================
 * | 上游符号 | 本地位置 | 本地是**同一个东西**吗？ |
 * | --- | --- | --- |
 * | `stringToUuid` | `src/kernel/contracts/uuid.ts` | ✅ LG 自己的实现（W0b 冻结过行为） |
 * | `ModelType` | `src/infrastructure/runtime/eliza-vocabulary.ts` | ✅ 值**逐字**抄自上游 |
 * | `ChannelType` | 同上 | ✅ 值**逐字**抄自上游（类型仍借用上游） |
 * | `logger` | `src/infrastructure/telemetry/logger.ts` | ✅ 同形实现（去向上游同形） |
 *
 * ⚠️ 这四个的替换是**零行为变化**的（不是"顺手改一下"，是逐字等价的值）。
 *   真正需要判断的是 C 簇（`new AgentRuntime(...)`），那个**不在本 codemod 的范围**。
 *
 * ============================================================================
 *  为什么用 codemod 而不是手改 56 个文件
 * ============================================================================
 * 手改 56 处 ⇒ 漏一处就**静默**（那个文件继续依赖上游，删包时才炸）。
 * codemod ⇒ **可重复、可验证**：跑完再跑一遍应该 0 改动。
 *
 * ⚠️ 纪律：
 *   · 只改 `import` 语句的**文本范围**，其余**逐字节不动**
 *     （⚠️ 绝不走 PowerShell 的 `Get-Content`/`Set-Content` —— 代码页 936 会损坏 CJK，L-QQP-03）
 *   · 失败关闭：改完若有任何文件仍引用这四个符号 ⇒ 退出码非零
 *   · `--check` 模式只报告不改
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CHECK_ONLY = process.argv.includes('--check')
/**
 * 要**跳过**的文件（`--skip=a.ts,b.ts`，相对仓库根，用 `/` 或 `\`）。
 *
 * ⚠️ 为什么要这个：**别的会话正在同一工作区改文件**。
 *   动它们 ⇒ 对方提交时冲突 ⇒ 那是**给别人制造麻烦**。
 *   ⇒ 本批只碰**干净**的文件；不干净的留给那一批（它们只是测试脚本，不阻塞）。
 */
const SKIP = new Set(
  process.argv
    .filter((a) => a.startsWith('--skip='))
    .flatMap((a) => a.slice('--skip='.length).split(','))
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => s.split('\\').join('/')),
)

/** 上游符号 → 本地模块（相对仓库根） */
const LOCAL_MODULES: Record<string, string> = {
  stringToUuid: 'src/kernel/contracts/uuid.ts',
  ModelType: 'src/infrastructure/runtime/eliza-vocabulary.ts',
  ChannelType: 'src/infrastructure/runtime/eliza-vocabulary.ts',
  logger: 'src/infrastructure/telemetry/logger.ts',
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** 从 `scripts/` 或 `evals/` 里的文件到仓库根下某模块的相对 import 路径 */
function importPathFor(file: string, target: string): string {
  const rel = relative(dirname(file), join(ROOT, target)).split('\\').join('/')
  return rel.startsWith('.') ? rel : `./${rel}`
}

interface Change {
  file: string
  moved: string[]
}

const changes: Change[] = []
const files = [
  ...walk(join(ROOT, 'scripts')),
  ...walk(join(ROOT, 'evals')),
]

for (const file of files) {
  const relPosix = relative(ROOT, file).split('\\').join('/')
  if (SKIP.has(relPosix)) continue
  const src = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  // 找 @elizaos/core 的静态 import，且**只**挑出 named bindings 里那四个
  const edits: { start: number; end: number; text: string }[] = []
  const moved = new Map<string, string>()

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
    if (stmt.moduleSpecifier.text !== '@elizaos/core') continue
    const clause = stmt.importClause
    if (clause === undefined || clause.namedBindings === undefined) continue
    const named = clause.namedBindings
    if (!ts.isNamedImports(named)) continue

    const keep: string[] = []
    /** 迁移的对：[导入名, 本地名]（⚠️ 别名导入时两者不同） */
    const move: [string, string][] = []
    for (const el of named.elements) {
      const local = el.name.text
      const imported = (el.propertyName ?? el.name).text
      if (Object.prototype.hasOwnProperty.call(LOCAL_MODULES, imported) && el.isTypeOnly !== true) {
        move.push([imported, local])
      } else {
        keep.push(el.getText(sf))
      }
    }
    if (move.length === 0) continue

    const specStart = stmt.moduleSpecifier.getStart(sf)
    const specEnd = stmt.moduleSpecifier.getEnd()

    // ① 先把上游 import 里那几项去掉
    if (keep.length === 0) {
      // 整个 import 语句删掉
      edits.push({ start: stmt.getStart(sf), end: stmt.getEnd(), text: '' })
    } else {
      // 保留其余 specifier
      const keptText = keep.join(', ')
      const typePrefix = clause.isTypeOnly ? 'type ' : ''
      const defaultPart = clause.name !== undefined ? `${clause.name.text}, ` : ''
      edits.push({
        start: stmt.getStart(sf),
        end: stmt.getEnd(),
        text: `import ${typePrefix}{ ${defaultPart}${keptText} } from '@elizaos/core'`,
      })
    }
    void specStart
    void specEnd
    for (const [imported, local] of move) moved.set(imported, local)
  }

  if (moved.size === 0) continue

  // ② 按本地模块分组，生成新的 import 语句
  //    ⚠️ 保留**别名**（`imported as local`）—— 第一版只按本地名查表，
  //    遇到别名导入就崩（dry-run 抓到的）。
  const byModule = new Map<string, string[]>()
  for (const [imported, local] of moved) {
    const mod = LOCAL_MODULES[imported]!
    const arr = byModule.get(mod) ?? []
    arr.push(imported === local ? imported : `${imported} as ${local}`)
    byModule.set(mod, arr)
  }
  const newImports = [...byModule.entries()]
    .map(([mod, names]) => `import { ${names.sort().join(', ')} } from '${importPathFor(file, mod)}'`)
    .join('\n')

  // ③ 拼接：把新 import 插在**第一个**被改的 import 之前
  const first = edits[0]!
  const pieces: string[] = []
  let cursor = 0
  pieces.push(src.slice(cursor, first.start))
  pieces.push(newImports + '\n')
  cursor = first.start
  for (const e of edits) {
    pieces.push(src.slice(cursor, e.start))
    pieces.push(e.text)
    cursor = e.end
  }
  pieces.push(src.slice(cursor))
  const out = pieces.join('')

  if (out === src) continue
  changes.push({ file: relative(ROOT, file), moved: [...moved.keys()].sort() })
  if (!CHECK_ONLY) writeFileSync(file, out, 'utf8')
}

// ---------------------------------------------------------------------------
// 失败关闭：改完（或报告完）仍有文件引用这四个符号 ⇒ 退出码非零
// ---------------------------------------------------------------------------
const leftover: string[] = []
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  for (const sym of Object.keys(LOCAL_MODULES)) {
    const re = new RegExp(`from\\s+['"]@elizaos/core['"]`)
    if (!re.test(src)) continue
    // 只在还 import 了这个符号时才算漏
    if (new RegExp(`\\b${sym}\\b`).test(src) && new RegExp(`import[^;]*\\b${sym}\\b[^;]*from\\s+['"]@elizaos/core['"]`).test(src)) {
      leftover.push(`${relative(ROOT, file)} 仍从上游导入 ${sym}`)
    }
  }
}

console.log(`${CHECK_ONLY ? '【check】' : '【改】'} ${String(changes.length)} 个文件`)
for (const c of changes) console.log(`  ${c.file}  ← ${c.moved.join(', ')}`)

if (CHECK_ONLY) {
  // ⚠️ --check 模式**不跑** leftover 检查：文件根本没改，检查必然报满屏
  //   （第一版就踩了这个 ⇒ dry-run 看起来像失败）。
  console.log(`\n（--check 模式：未改文件，故不跑 leftover 检查）`)
  // ⚠️ **不要** `process.exit(0)` —— 它会**截断 stdout**（列表会看不见）。
  process.exitCode = 0
} else {
// ---------------------------------------------------------------------------
// 失败关闭：改完仍有文件从上游导入这四个符号 ⇒ 退出码非零
//
// ⚠️ **必须用 AST 判定，不能用正则**（第一版用了正则 ⇒ **假阳性**）：
//   正则 `import[^;]*\bstringToUuid\b[^;]*from '@elizaos/core'` 假设两条 import
//   之间有分号 —— 而 **TypeScript 的 import 不需要分号** ⇒ `[^;]*` 贪婪地
//   跨过了第一条 import 的 `from`，把第二条（合法的）当成了违规。
//   ⇒ 复用**上面同一套 AST 检测**，一处实现、两处使用。
// ---------------------------------------------------------------------------
{
  const leftover: string[] = []
  for (const file of files) {
    const relPosix = relative(ROOT, file).split('\\').join('/')
    if (SKIP.has(relPosix)) continue
    const src = readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    for (const stmt of sf.statements) {
      if (!ts.isImportDeclaration(stmt)) continue
      if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue
      if (stmt.moduleSpecifier.text !== '@elizaos/core') continue
      const clause = stmt.importClause
      if (clause === undefined || clause.namedBindings === undefined) continue
      const named = clause.namedBindings
      if (!ts.isNamedImports(named)) continue
      for (const el of named.elements) {
        const imported = (el.propertyName ?? el.name).text
        if (Object.prototype.hasOwnProperty.call(LOCAL_MODULES, imported) && el.isTypeOnly !== true) {
          leftover.push(`${relPosix} 仍从上游导入 ${imported}`)
        }
      }
    }
  }
  if (leftover.length > 0) {
    console.log(`\n❌ 仍有 ${String(leftover.length)} 处未改：`)
    for (const l of leftover) console.log(`  ${l}`)
    process.exitCode = 1
  } else {
    console.log(`\n✅ 上游 import 里已无这四个符号（跳过 ${String(SKIP.size)} 个别人在改的文件）`)
  }
}
}
