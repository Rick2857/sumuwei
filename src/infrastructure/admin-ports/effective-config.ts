/**
 * A1 / **WP2：`effective_config` 只读面的真端口**（缺口 `B8`：只读汇总 flags / `.env` 来源并**遮蔽密钥**）。
 *
 * ============================================================================
 *  为什么它放在 `admin-ports/` 而不是 `admin/`
 * ============================================================================
 * ```text
 * `src/infrastructure/admin/**` 被门判**依赖边界**：不许 import 数据库/drizzle/elizaos/持久层
 * （`D01`：不新建第二套真相）。端口**实现**要读真实配置，天然更靠近装配层 ⇒ 单独放这里，
 * 边界判据因此仍然成立：**HTTP/认证/契约层**不认识任何持久层，只认识端口接口。
 * ```
 *
 * 三条设计：
 * ```text
 * ① **纯函数可测**：`process.env` 与 `.env` 文本由调用方注入 ⇒ 门不需要碰真实 `.env`
 * ② **遮蔽按两个判据**：键名像密钥 **或** 值像密钥（`sk-`/`ghp_`/`Bearer `/长十六进制…）
 *    —— 宁可多遮（误遮是安全的，漏遮不是）
 * ③ **来源要说清**：`env`（进程环境，**有效**来源）> `file`（`.env` 里有但进程没有）> `default`（代码缺省）
 * ```
 */
import type { AdminReadSurfacePayload } from '../admin/query-ports.ts'

/** 行数上限（配置面是给人看的；超过就是有人在拿它当转储口） */
const MAX_ROWS = 300

/**
 * 键名像密钥？（**保守**：命中就遮）
 *
 * ⚠️ 这是"宁可多遮"的判据：`CHARACTER_ROLLUP_TOKENS` 里的 `TOKENS` **不**命中
 *    （`token` 只匹配单词形态，且这里刻意不把 `TOKENS` 当密钥 —— 它是额度，不是凭证）。
 */
export function looksSecretKey(key: string): boolean {
  const upper = key.toUpperCase()
  if (/(^|_)(API_?KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY)($|_)/.test(upper)) return true
  if (/(^|_)TOKEN(S)?($|_)/.test(upper) && !/TOKENS$/.test(upper)) return true
  if (/^(OPENAI|ARK|DEEPSEEK|TAVILY|M55_TAVILY)_.*(KEY|TOKEN|SECRET)/.test(upper)) return true
  return false
}

/** 值像密钥？（强形状：命中就遮，即使键名很无辜） */
export function looksSecretValue(value: string): boolean {
  const text = value.trim()
  if (text === '') return false
  if (/^(sk|pk|ghp|gho|github_pat|xox[baprs])[-_]/i.test(text)) return true
  if (/^Bearer\s+/i.test(text)) return true
  /* 长十六进制 / 长 base64url：凭证常见的形状（误遮是安全的） */
  if (/^[0-9a-f]{40,}$/i.test(text)) return true
  if (/^[A-Za-z0-9_-]{48,}$/.test(text)) return true
  return false
}

/** 遮蔽后的显示值（**固定形状**：不泄露长度、不泄露前几位） */
export const MASKED_VALUE = '******'

/** 单行的遮蔽判定（**纯函数**，门直接测它） */
export function maskConfigValue(key: string, value: string): { value: string; masked: boolean } {
  if (looksSecretKey(key) || looksSecretValue(value)) return { value: MASKED_VALUE, masked: true }
  return { value, masked: false }
}

/** 解析 `.env` 文本（**不**执行、不展开变量；只认 `KEY=VALUE` 与 `#` 注释） */
export function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out.set(key, value)
  }
  return out
}

export interface EffectiveConfigInput {
  /** 进程环境（**有效**来源；通常传 `process.env`） */
  readonly env: NodeJS.ProcessEnv
  /** `.env` 文本（可选；给了才产生 `file` 来源的行） */
  readonly envText?: string | undefined
  /** 代码缺省的键（可选；给了才产生 `default` 来源的行） */
  readonly defaultKeys?: readonly string[] | undefined
  /** 生成时刻（注入 ⇒ 门可确定性断言） */
  readonly now?: (() => Date) | undefined
}

/**
 * 建 `effective_config` 端口。
 *
 * ⚠️ 它**只读**：不写任何东西、不改环境、不调模型。
 */
export function createEffectiveConfigPort(input: EffectiveConfigInput): () => Promise<AdminReadSurfacePayload> {
  return async () => {
    const fileValues = parseEnvText(input.envText ?? '')
    const rows: Record<string, unknown>[] = []
    const seen = new Set<string>()

    const push = (key: string, value: string, source: 'env' | 'file' | 'default'): void => {
      if (seen.has(key)) return
      seen.add(key)
      const masked = maskConfigValue(key, value)
      rows.push({ flag: key, value: masked.value, source, masked: masked.masked })
    }

    for (const [key, value] of fileValues) {
      const fromEnv = input.env[key]
      if (typeof fromEnv === 'string' && fromEnv !== '') push(key, fromEnv, 'env')
      else push(key, value, 'file')
    }
    for (const [key, value] of Object.entries(input.env)) {
      if (typeof value === 'string' && value !== '') push(key, value, 'env')
    }
    for (const key of input.defaultKeys ?? []) push(key, '(未设置，走代码缺省)', 'default')

    rows.sort((a, b) => String(a.flag).localeCompare(String(b.flag)))
    return {
      surface: 'effective_config',
      generatedAt: (input.now ?? (() => new Date()))().toISOString(),
      items: rows.slice(0, MAX_ROWS),
    }
  }
}
