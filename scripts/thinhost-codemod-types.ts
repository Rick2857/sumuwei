/**
 * codemod（F 簇 / W4 前置）：把**类型**导入从 `@elizaos/*` 换成本地 `eliza-types.ts`。
 *
 * ⚠️ 只动 **type-only** 的 specifier / 整条 type-only import；
 *    **值**导入（`AgentRuntime` 作为构造、plugin-sql 等）本轮一律**不动**
 *    （它们在 W3 已经处理完；剩下的都是有据豁免的旧宿主门）。
 *
 * ⚠️ `--skip=` 排除别的会话在改的文件。
 * ⚠️ 有意保留从上游取**对照**的门（`thinhost-vocabulary-verify` 等）—— 见 EXEMPT。
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

/** 上游类型名 → 本地模块里的同名导出 */
const LOCAL_TYPE_MODULE = 'src/infrastructure/runtime/eliza-types.ts'
/** `UUID` 在本地叫 `UuidString` 的地方**不改名**（本仓另有自己的 `UuidString`），同名导出即可 */
const LOCAL_EXPORTS = new Set([
  'AgentRuntime',
  'IAgentRuntime',
  'UUID',
  'ChannelType',
  'Plugin',
  'Character',
  'Memory',
  'State',
  'Provider',
  'GenerateTextParams',
])

/** 有意导入上游做**对照**的门（换掉就变自证） */
const EXEMPT = new Set([
  'scripts/thinhost-vocabulary-verify.ts',
  'scripts/thinhost-reply-parser-freeze.ts',
  'scripts/thinhost-no-eliza-in-src-verify.ts',
  'scripts/verify-m5.1.1-d01-live-smoke.ts',
  'scripts/thinhost-equivalence-verify.ts',
  'scripts/thinhost-ddl-decoupling-measure.ts',
  'scripts/thinhost-ddl-decoupling-verify.ts',
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

for (const file of [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'scripts')), ...walk(join(ROOT, 'evals'))]) {
  const relPosix = relative(ROOT, file).split('\\').join('/')
  if (SKIP.has(relPosix)) { skipped.set('在 --skip 名单里（别人在改）', [...(skipped.get('在 --skip 名单里（别人在改）') ?? []), relPosix]); continue }
  if (EXEMPT.has(relPosix)) { skipped.set('有据豁免（对照门 / 依赖旧宿主的门）', [...(skipped.get('有据豁免（对照门 / 依赖旧宿主的门）') ?? []), relPosix]); continue }
  if (relPosix.endsWith('codemod-types.ts')) continue

  const src = readFileSync(file, 'utf8')
  if (!src.includes('@elizaos/')) continue
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  const edits: { start: number; end: number; text: string }[] = []
  const needLocal = new Set<string>()
  let blocker = ''

  const visit = (n: ts.Node): void => {
    if (blocker !== '') return
    if (!ts.isImportDeclaration(n) || !ts.isStringLiteral(n.moduleSpecifier)) { ts.forEachChild(n, visit); return }
    if (!n.moduleSpecifier.text.startsWith('@elizaos/')) { ts.forEachChild(n, visit); return }
    const clause = n.importClause
    if (clause === undefined) { blocker = 'side-effect import'; return }
    const named = clause.namedBindings
    if (named === undefined || !ts.isNamedImports(named)) {
      // 默认导入（plugin-sql 等）—— 不动
      ts.forEachChild(n, visit)
      return
    }
    const move: string[] = []
    const keep: string[] = []
    for (const el of named.elements) {
      const local = el.name.text
      const imported = (el.propertyName ?? el.name).text
      const isType = el.isTypeOnly || clause.isTypeOnly
      if (isType && LOCAL_EXPORTS.has(imported)) move.push(local)
      else keep.push(el.getText(sf))
    }
    if (move.length === 0) { ts.forEachChild(n, visit); return }
    for (const m of move) needLocal.add(m)
    if (keep.length === 0 && clause.name === undefined) {
      edits.push({ start: n.getStart(sf), end: n.getEnd(), text: '' })
    } else {
      const typePrefix = clause.isTypeOnly ? 'type ' : ''
      const defaultPart = clause.name !== undefined ? `${clause.name.text}, ` : ''
      edits.push({
        start: n.getStart(sf),
        end: n.getEnd(),
        text: `import ${typePrefix}{ ${defaultPart}${keep.join(', ')} } from '${n.moduleSpecifier.text}'`,
      })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)

  if (blocker !== '') { skipped.set(blocker, [...(skipped.get(blocker) ?? []), relPosix]); continue }
  if (edits.length === 0) continue

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

  if (needLocal.size > 0) {
    const stmt = `import type { ${[...needLocal].sort().join(', ')} } from '${importPathFor(file, LOCAL_TYPE_MODULE)}'`
    const sf4 = ts.createSourceFile(file, out, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const at = sf4.statements[0]!.getStart(sf4)
    out = out.slice(0, at) + stmt + '\n' + out.slice(at)
  }

  if (out === src) continue
  migrated.push(relPosix)
  if (!CHECK_ONLY) writeFileSync(file, out, 'utf8')
}

console.log(`【${CHECK_ONLY ? 'check' : '改'}】类型导入换本地 ${String(migrated.length)} 个 / 如实跳过 ${String([...skipped.values()].reduce((n, a) => n + a.length, 0))} 个`)
console.log('\n=== 如实跳过 ===')
for (const [reason, files] of [...skipped.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${reason}  (${String(files.length)} 个)`)
  for (const f of files.slice(0, 8)) console.log(`      ${f}`)
  if (files.length > 8) console.log(`      …共 ${String(files.length)} 个`)
}
