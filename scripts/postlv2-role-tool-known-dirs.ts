/**
 * 角色自选工具 · **真实已知目录探测**（WP2 的真实读数；只读、不出站）。
 *
 * ============================================================================
 *  为什么它单独一支（不在离线门里）
 * ============================================================================
 * ```text
 * 离线门（`postlv2:role-tool:path`）必须**确定、可复现**：它用夹具 stdout 照的是
 * "解析与渲染对不对"。
 * 本支照的是**这台机器上真的查到了什么** —— 它依赖环境（有 PowerShell、桌面被
 * 重定向到哪、目录在不在），因此读数必须**分开报**，不许混进离线门的绿。
 * ```
 * ⚠️ 它**只读**：跑一次 PowerShell 已知文件夹 API + 若干次 `existsSync`，
 *    不写任何目录、不打开数据库、不出站。
 *
 * ```bash
 * pnpm postlv2:role-tool:known-dirs
 * ```
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  describeKnownDirectories,
  renderKnownDirectoriesForModel,
  type KnownDirectoryFact,
} from '../src/kernel/action/known-directories.ts'
import { readKnownDesktopDirectories } from '../src/infrastructure/action/known-folders.ts'

const REPO_ROOT = resolve(process.cwd())
const EVIDENCE_PARENT = 'artifacts/post-lv2/role-tool-decision'

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
}

async function main(): Promise<number> {
  const startedAt = new Date().toISOString()
  const facts: readonly KnownDirectoryFact[] = await readKnownDesktopDirectories()

  process.stdout.write(`[role-tool:known-dirs] 探测读数：${describeKnownDirectories(facts)}\n`)
  process.stdout.write(`${renderKnownDirectoriesForModel(facts)}\n`)

  const probed = facts.filter((fact) => fact.source === 'probe')
  const missing = facts.filter((fact) => fact.source === 'probe_missing')
  const failed = facts.filter((fact) => fact.source === 'probe_failed')
  const absent = facts.filter((fact) => fact.source === 'probe_absent')

  /*
   * 判定口径（**两档都写清楚**，不许把"没探测"读成"探测成功"）：
   * ```text
   * 非 Windows         ⇒ 本轮 NOT RUN（`probe_absent` 是如实结果，不是失败）
   * Windows + 至少一项 `probe` ⇒ PASS（这一项**真的**查到了且目录在）
   * 其余                ⇒ FAIL（探测在这一台机器上没给出可用事实）
   * ```
   */
  const isWindows = process.platform === 'win32'
  const verdict = !isWindows ? 'NOT RUN' : probed.length > 0 ? 'PASS' : 'FAIL'

  const runId = `role-tool-known-dirs-${stamp()}`
  const runDir = join(REPO_ROOT, EVIDENCE_PARENT, runId)
  mkdirSync(runDir, { recursive: true })
  writeFileSync(
    join(runDir, 'known-directories.json'),
    `${JSON.stringify(
      {
        schemaVersion: 'role-tool-known-dirs@1',
        runId,
        platform: process.platform,
        startedAt,
        endedAt: new Date().toISOString(),
        /** ⚠️ 本支**只读**：不写目录、不开库、不出站 */
        readOnly: true,
        verdict,
        counts: {
          probed: probed.length,
          missing: missing.length,
          failed: failed.length,
          absent: absent.length,
        },
        facts,
        rendered: renderKnownDirectoriesForModel(facts),
        summary: describeKnownDirectories(facts),
        /** 判据的机器形态：**没有一条**事实是"猜出来的路径"（本探测器只认系统 API） */
        guessed: false,
        probeScriptConstant: true,
        evidencePathExists: existsSync(runDir),
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  process.stdout.write(`[role-tool:known-dirs] verdict = ${verdict}\n`)
  process.stdout.write(`[role-tool:known-dirs] 证据 = ${EVIDENCE_PARENT}/${runId}/known-directories.json\n`)
  return verdict === 'FAIL' ? 1 : 0
}

process.exit(await main())
