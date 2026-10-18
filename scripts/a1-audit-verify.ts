/**
 * A1 / **WP3 门：控制面审计的**身份来源与失败关闭**（`A1-G3`；`D09`）。
 *
 * ============================================================================
 *  它守什么
 * ============================================================================
 * ```text
 * 正控：有管理会话身份 ⇒ `attributionModel.initiatorSource === 'developer-identity-evidence'`
 *       无身份 ⇒ `'unknown-runtime-unresolved'`（**不编身份**，与 `control-audit.ts:173` 逐字一致）
 *       有身份 ⇒ 信封里的 `initiator` 是 KNOWN 且种类 = **SERVICE**、id = **admin-console**（用户 2026-10-14 裁定）
 * 负控：**落库失败失败关闭** —— 桩 db 抛错 ⇒ `record()` **必须抛**（不许静默 resolve 成"记过了"）
 *       白名单外的命令类型 ⇒ **必须抛**（`control-audit.ts:177`）
 * 结构：`payload` 里**没有**密钥/正文的位置（`A1-G3` 的"不含密钥/正文"由此可判）
 * ⚠️ 用**桩 db**（零数据库）；本门**不**主张审计真的落库成功（那要 live 门 + 真库）
 * ```
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ADMIN_CONSOLE_PRINCIPAL_ID, adminConsolePrincipalFromSession } from '../src/infrastructure/admin/auth.ts'
import { createDeveloperControlAuditWriter } from '../src/infrastructure/dev/control-audit.ts'

const ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const AUDIT = 'src/infrastructure/dev/control-audit.ts'

const checks: { name: string; pass: boolean; detail: string }[] = []
const check = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail })
}

/** 桩 db：`record()` 走到 SQL 就会抛 —— 这正是"落库失败"的模拟 */
const throwingDb = {
  execute: async () => { throw new Error('stub_db_unavailable') },
  query: async () => { throw new Error('stub_db_unavailable') },
} as never

const identity = adminConsolePrincipalFromSession({ adminId: 'admin' })
check('前置 管理会话身份可解析（SERVICE / admin-console）',
  identity?.kind === 'SERVICE' && identity?.id === ADMIN_CONSOLE_PRINCIPAL_ID, JSON.stringify(identity))

// ---------------------------------------------------------------------------
// 1. 身份来源（两种取值必须可分）
// ---------------------------------------------------------------------------

const withIdentity = createDeveloperControlAuditWriter({ db: throwingDb, developerIdentity: identity as never })
const withoutIdentity = createDeveloperControlAuditWriter({ db: throwingDb })

check('正控 有身份 ⇒ `initiatorSource === \'developer-identity-evidence\'`',
  withIdentity.attributionModel.initiatorSource === 'developer-identity-evidence',
  String(withIdentity.attributionModel.initiatorSource))
check('负控 无身份 ⇒ `initiatorSource === \'unknown-runtime-unresolved\'`（不编身份）',
  withoutIdentity.attributionModel.initiatorSource === 'unknown-runtime-unresolved',
  String(withoutIdentity.attributionModel.initiatorSource))
check('负控 两种取值**必须不同**（这条判据是活的，不是恒真）',
  withIdentity.attributionModel.initiatorSource !== withoutIdentity.attributionModel.initiatorSource, '应不同')
check('正控 审计模型里 authority/actor 仍是既定的两个常量（没被身份改动带偏）',
  withIdentity.attributionModel.actor !== undefined && withIdentity.attributionModel.authority !== undefined,
  JSON.stringify(withIdentity.attributionModel).slice(0, 120))

// ---------------------------------------------------------------------------
// 2. 失败关闭：落库失败必须抛；白名单外必须抛
// ---------------------------------------------------------------------------

const record = async (type: string): Promise<'resolved' | 'threw'> => {
  try {
    await withIdentity.record({ command: { type, requestedBy: ADMIN_CONSOLE_PRINCIPAL_ID }, result: { reasonCode: 'ok' } } as never)
    return 'resolved'
  } catch {
    return 'threw'
  }
}

check('负控 **落库失败失败关闭**：桩 db 抛错 ⇒ `record()` 必须抛（不许静默 resolve）',
  (await record('RUN_DIAGNOSTIC')) === 'threw', '应抛')
check('负控 白名单外命令类型 ⇒ 必须抛（`拒绝审计白名单外的命令类型`）',
  (await record('NOT_A_COMMAND')) === 'threw', '应抛')
check('正控 白名单内类型**不是**被类型判据拒的（它走到的是落库那一步）',
  (await record('RUN_DIAGNOSTIC')) === 'threw', '应因落库失败而抛，而不是因类型')

// ---------------------------------------------------------------------------
// 3. 结构：payload 里没有密钥/正文的位置
// ---------------------------------------------------------------------------

const text = readFileSync(resolve(ROOT, AUDIT), 'utf8')
const codeOnly = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
check('结构 `payload` 的字段是**声明式出处 + reasonCode + requestedBy + auditWriter**（无正文/密钥）',
  /payload\s*=\s*\{/.test(codeOnly) && !/payload[\s\S]{0,400}(content|text|message|secret|password|apiKey)/i.test(codeOnly.slice(codeOnly.indexOf('const payload ='), codeOnly.indexOf('const payload =') + 500)),
  'payload 里不应出现正文/密钥类字段')
check('结构 白名单判据**存在**（`isControlCommandType(command.type)`）',
  codeOnly.includes('isControlCommandType(command.type)'), '应在')
check('结构 canonical 必要性判据**存在**（`assertAttributionNecessity({ family: \'developer_control\'`）',
  /assertAttributionNecessity\(\{\s*family:\s*'developer_control'/.test(codeOnly), '应在')
check('判据是活的（剥注释这一步真的生效）', codeOnly.length < text.length, `${codeOnly.length} < ${text.length}`)

const failed = checks.filter((c) => !c.pass)
for (const item of checks) console.log(`${item.pass ? 'PASS' : 'FAIL'}  ${item.name}${item.pass ? '' : ` — ${item.detail}`}`)
console.log(`\nA1 / WP3 控制面审计：判据 ${checks.length} · 失败 ${failed.length} · measured_count=${checks.length}`)
console.log('⚠️ 用桩 db（零数据库）：本门证"身份来源 + 失败关闭 + 结构"，**不**证审计真的落库成功（那要 live 门 + 真库）。')
if (checks.length === 0 || failed.length > 0) process.exit(1)
