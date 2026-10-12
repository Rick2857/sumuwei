/**
 * 角色自选工具 · **生产激活的回读**（只读；不打开数据库、不出站、不调模型）。
 *
 * ============================================================================
 *  载体
 * ============================================================================
 * [`ADR-105`](../../docs/adr/ADR-105-role-tool-decision-activation.md)（生产激活，**只做状态修订**）·
 * [`WP4 记录`](../../docs/post-lv2/Role-Tool-Decision-WP4-Record.md) §4（候选与前置条件）。
 *
 * ```bash
 * pnpm postlv2:role-tool:activation:readback
 * ```
 *
 * ============================================================================
 *  它回答四件事（每条都有机器判据，不是"看配置说改了"）
 * ============================================================================
 * ```text
 * ① 生效读数：`.env` 解析出来的 `toolDecisionMode` 到底是什么
 * ② 缺省不变：**代码缺省**（空 env）仍然是 `rules` —— 激活只改配置，不改代码
 * ③ 前置条件：`CHARACTER_TASK_AUTONOMY_ENABLED` 必须为 true（否则决策会被跳过）
 * ④ 消费锁：`src/main.ts` 的**代码**里真的出现"按模式构造决策端口"那段
 *    （去注释后查；只写 flag 没消费者就是惰性开关 —— 先例 D3）
 * ```
 *
 * ⚠️ **必须 `import 'dotenv/config'`**（第一版漏了它）：不然 `readKernelFlags()` 读的是
 *    一个**没有加载 `.env`** 的 `process.env` ⇒ 本门会把"配置文件没被读"报成
 *    "开关没打开"（`task-autonomy=false` 那种假读数）。这是"量错对象"的又一形态。
 */

import 'dotenv/config'

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describeKernelFlags, readKernelFlags } from '../src/kernel/app/flags.ts'
import { createOpenAiToolDecisionPort } from '../src/infrastructure/model/openai-tool-decision.ts'

const REPO_ROOT = resolve(process.cwd())
const EVIDENCE_PARENT = 'artifacts/post-lv2/role-tool-decision'

function git(args: readonly string[]): string {
  try {
    return execFileSync('git', [...args], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function main(): number {
  const current = readKernelFlags()
  const codeDefaults = readKernelFlags({})

  /* ④ 消费锁：去注释之后仍然看得到那段接线（正控：同一次扫描必须还能看到 `toolDecision`） */
  const mainRaw = readFileSync(join(REPO_ROOT, 'src', 'main.ts'), 'utf8')
  const mainCode = mainRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const wiresDecisionPort =
    mainCode.includes("this.flags.toolDecisionMode === 'role'") &&
    mainCode.includes('createOpenAiToolDecisionPort')

  /*
   * 端口能否构造（**只报可达性，不发请求**）：缺省端点/模型名在测试 env 下会不同，
   * 因此这里只报 endpointHost，不打印任何凭证。
   */
  const port = createOpenAiToolDecisionPort()

  const checks: { readonly id: string; readonly ok: boolean; readonly detail: string }[] = [
    {
      id: 'env-mode-is-role',
      ok: current.toolDecisionMode === 'role',
      detail: `toolDecisionMode=${current.toolDecisionMode}`,
    },
    {
      id: 'code-default-is-still-rules',
      ok: codeDefaults.toolDecisionMode === 'rules',
      detail: `缺省 toolDecisionMode=${codeDefaults.toolDecisionMode}（激活只改配置）`,
    },
    {
      id: 'task-autonomy-precondition',
      ok: current.taskAutonomyEnabled === true,
      detail: `taskAutonomyEnabled=${String(current.taskAutonomyEnabled)}（缺它决策会被跳过）`,
    },
    {
      id: 'main-consumes-the-flag',
      ok: wiresDecisionPort,
      detail: wiresDecisionPort ? 'main.ts 的代码里有按模式构造决策端口那段' : '**没有**消费者（惰性开关）',
    },
    {
      id: 'decision-port-constructible',
      ok: port.endpointHost !== '',
      detail: `决策端点 host=${port.endpointHost}（不打印凭证）`,
    },
  ]

  const failed = checks.filter((check) => !check.ok)
  process.stdout.write(
    `[role-tool:readback] toolDecisionMode=${current.toolDecisionMode} · ` +
      `taskAutonomy=${String(current.taskAutonomyEnabled)} · ` +
      `timeout=${String(current.toolDecisionTimeoutMs)}ms · ` +
      `turnContentTokens=${String(current.turnContentTokens)} · ` +
      `webSearchEvidenceTokens=${String(current.webSearchEvidenceTokens)}\n`
  )
  process.stdout.write(`[role-tool:readback] ${describeKernelFlags(current)}\n`)
  for (const check of checks) {
    process.stdout.write(
      `[role-tool:readback]   ${check.ok ? '·' : '×'} ${check.id} —— ${check.detail}\n`
    )
  }

  const runId = `role-tool-activation-${new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')}-${git(['rev-parse', '--short=8', 'HEAD']) || 'unknown'}`
  const runDir = join(REPO_ROOT, EVIDENCE_PARENT, runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'activation-readback.json'),
    `${JSON.stringify(
      {
        schemaVersion: 'role-tool-decision-activation-readback@1',
        runId,
        head: git(['rev-parse', 'HEAD']),
        at: new Date().toISOString(),
        /** ⚠️ 只读：不打开数据库、不出站、不调模型 */
        readOnly: true,
        modelCalls: 0,
        current: {
          toolDecisionMode: current.toolDecisionMode,
          taskAutonomyEnabled: current.taskAutonomyEnabled,
          toolDecisionTimeoutMs: current.toolDecisionTimeoutMs,
          turnContentTokens: current.turnContentTokens,
          webSearchEvidenceTokens: current.webSearchEvidenceTokens,
        },
        codeDefaults: { toolDecisionMode: codeDefaults.toolDecisionMode },
        decisionEndpointHost: port.endpointHost,
        checks,
        verdict: failed.length === 0 ? 'PASS' : 'NOT PASS',
        fingerprint: createHash('sha256')
          .update(JSON.stringify(checks.map((check) => check.ok)))
          .digest('hex')
          .slice(0, 16),
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  process.stdout.write(`[role-tool:readback] 证据 = ${EVIDENCE_PARENT}/${runId}/activation-readback.json\n`)
  process.stdout.write(`[role-tool:readback] overall = ${failed.length === 0 ? 'PASS' : 'NOT PASS'}\n`)
  return failed.length === 0 ? 0 : 1
}

process.exit(main())
