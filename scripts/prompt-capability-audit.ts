import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const root = process.cwd()
const directory = process.argv.includes('--baseline') ? 'baseline' : 'current'
const out = join(root, 'artifacts/post-lv2/reminder-context-repair', directory)
const candidates: { file: string; line: number; text: string; stale: boolean }[] = []
let files = 0
let literals = 0
const restriction = /(没有|不具备|不支持|不能|无法|尚未|不存在|只能|用不了).*(能力|工具|提醒|定时|主动|联网|浏览|文件|桌面|发消息|发邮件|执行|操作|日程)|(?:cannot|can't|no access|unable).*(?:tool|browse|internet|remind|execute)/i
const stale = /本产品只有目标域|没有.{0,25}(?:定时|主动|联网|浏览器|文件|桌面).{0,12}能力|不能.{0,6}替用户执行外部动作|目录里没有的能力（|没有列出来的能力（|不具备.{0,20}(?:联网|提醒|主动|浏览器|桌面).{0,8}能力|(?:无法|不能).{0,8}主动(?:提醒|联系|发消息)|不存在\s*(?:fill|任意.*脚本操作)/
assert.ok(stale.test('没有联网能力'))
assert.ok(!stale.test('本轮工具目录未授权，请依据实际结果说明'))
function visit(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { visit(path); continue }
    if (!/\.(?:ts|json|yaml|txt|py)$/.test(path)) continue
    files += 1
    const content = readFileSync(path, 'utf8')
    const file = relative(root, path).replaceAll('\\', '/')
    const inspect = (text: string, line: number): void => {
      literals += 1
      if (restriction.test(text) || stale.test(text)) candidates.push({ file, line, text, stale: stale.test(text) })
    }
    if (path.endsWith('.ts')) {
      const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true)
      function walk(node: ts.Node): void {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
          inspect(node.text, ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1)
        }
        ts.forEachChild(node, walk)
      }
      walk(ast)
    } else content.split('\n').forEach((line, index) => inspect(line, index + 1))
  }
}
visit(join(root, 'src'))
visit(join(root, 'evals/fixtures'))
const violations = candidates.filter(candidate => candidate.stale)
mkdirSync(out, { recursive: true })
const runtimeDir = join(root, 'artifacts/post-lv2/reminder-context-repair')
const runtimeRun = readdirSync(runtimeDir).filter(name => /^main-current-\d+$/.test(name)).sort().at(-1)
const runtimeCalls = runtimeRun === undefined ? [] : (JSON.parse(readFileSync(join(runtimeDir, runtimeRun, 'evidence.json'), 'utf8')) as { calls: { instruction: string }[] }).calls
const runtimeStatus = runtimeRun === undefined ? 'NOT RUN' : 'MEASURED'
const runtimeViolations = runtimeCalls.filter(call => stale.test(call.instruction)).map((_, index) => index)
writeFileSync(join(out, 'capability-audit.json'), JSON.stringify({ files, literals, candidates, violations, runtimeRun, runtimeStatus, runtimePrompts: runtimeCalls.length, runtimeViolations }, null, 2))
console.log(JSON.stringify({ files, literals, candidates: candidates.length, violations, runtimeStatus, runtimePrompts: runtimeCalls.length, runtimeViolations }))
if (!process.argv.includes('--baseline') && (violations.length > 0 || runtimeViolations.length > 0)) process.exitCode = 1
