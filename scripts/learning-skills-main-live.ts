/** Real main.ts + test model + fresh database. Never opens or copies production DB. */
import 'dotenv/config'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
if (process.env.DSH_TEST_MODEL_WRAPPER !== '1') throw new Error('Run through pnpm with-test-model; production model is forbidden')
const work = mkdtempSync(join(tmpdir(), 'lg-learning-main-'))
const local = resolve('artifacts/post-lv2/local/low-cost-skills', `main-live-${Date.now()}`)
mkdirSync(local, { recursive: true })
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.startsWith('CHARACTER_') && key.endsWith('_ENABLED')) env[key] = 'false'
Object.assign(env, {
  PGLITE_DATA_DIR: join(work, 'pglite'), PROJECT_LG_SANDBOX: join(work, 'pglite'),
  ACTION_SANDBOX_ROOT: join(work, 'actions'), CHARACTER_ACTION_ENABLED: 'true',
  CHARACTER_CONTEXT_COMPILER_V1: 'true', CHARACTER_TOOL_DECISION_MODE: 'role',
  CHARACTER_TASK_AUTONOMY_ENABLED: 'true', CHARACTER_TURN_CONTENT_TOKENS: '1800',
  CHARACTER_WORKFLOW_SKILLS_ENABLED: 'true', CHARACTER_PERSONAL_LIBRARY_ENABLED: 'true',
  CHARACTER_ARXIV_RESEARCH_ENABLED: 'true', CHARACTER_TASK_PLANNER_MAX_ROUNDS: '3',
})
async function main(args: string[], label: string): Promise<{ exit: number; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [join('node_modules', 'tsx', 'dist', 'cli.mjs'), 'src/main.ts', ...args], { env, cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => {
      if (child.pid) spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
    }, 180_000)
    child.stdout.on('data', b => { stdout += String(b) })
    child.stderr.on('data', b => { stderr += String(b) })
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      writeFileSync(join(local, `${label}.log`), stdout + '\n' + stderr, 'utf8')
      resolveRun({ exit: code ?? 1, stdout })
    })
  })
}
const cases = [
  { id: 'library', capability: 'library.search', text: '请用专用个人资料夹检索工具 library.search 检索“邻里协作”，告诉我有没有命中。不要搜索互联网。' },
  { id: 'writing', capability: 'workflow.skill', text: '请先加载 writing-collaboration 写作流程（workflow.skill），再帮我写一段不超过150字的读书会邀请，读者是同学，时间地点待定。直接把初稿发在聊天里，不保存文件。' },
  { id: 'arxiv', capability: 'research.arxiv', text: '请通过 research.arxiv 精准搜索标题 Attention Is All You Need，query 为 ti:"Attention Is All You Need"，limit设为1，给出查到的论文ID。只检索元数据，不下载正文。' },
]
const checks: { id: string; exit: number; successCount: number; pass: boolean }[] = []
for (const item of cases) {
  console.log(`main live: ${item.id}`)
  const chat = await main([item.text], item.id)
  const rows = await main(['--action-list', '--capability', item.capability, '--status', 'success'], `${item.id}-ledger`)
  const successCount = Number(/共\s*(\d+)\s*条/.exec(rows.stdout)?.[1] ?? 0)
  const pass = chat.exit === 0 && rows.exit === 0 && successCount > 0 && (item.id !== 'arxiv' || chat.stdout.includes('1706.03762'))
  checks.push({ id: item.id, exit: chat.exit, successCount, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${item.id}, successful actions=${successCount}`)
}
const destination = resolve('artifacts/post-lv2/learning-skills', `main-live-${Date.now()}`)
mkdirSync(destination, { recursive: true })
writeFileSync(join(destination, 'acceptance.json'), JSON.stringify({ measured_count: checks.length, passed: checks.filter(c => c.pass).length, checks, isolation: 'fresh database; production never opened or copied', mainSourceHash: createHash('sha256').update(readFileSync('src/main.ts')).digest('hex'), localLogs: local }, null, 2) + '\n')
console.log(`evidence: ${destination}`)
process.exitCode = checks.every(c => c.pass) ? 0 : 1
