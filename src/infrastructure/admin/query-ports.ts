/**
 * A1 / **WP2：只读查询面的契约**（`ADR-135` `D01`/`D07`/`D11`；`R-A1-2` 批准的"先冻结清单"）。
 *
 * ============================================================================
 *  两条不可退让的判据（`ADR-036` / 契约 §1）
 * ============================================================================
 * ```text
 * ① **不新建第二套真相**：本目录（HTTP + 认证 + 路由）**只**调下面这些端口；
 *    它**不许** import 数据库、drizzle、elizaos，也**不许**自己重算认知状态。
 *    ⇒ 于是"页面显示的是程序事实"不是一句承诺，而是**静态可判**的性质（门里有边界判据）。
 * ② **先冻结清单**：首版**只有**下面五个只读面（`R-A1-2` 逐字：认知状态 / 目标与承诺 /
 *    后台任务 / 安全与额度 / 有效配置）。加第六个面必须**显式**改清单与冻结档 —— 不许顺手加。
 * ```
 * ⚠️ 端口是**接口**，实现由装配根注入（复用既有 reader/投影/账本）。
 *    今天**没有**任何实现 ⇒ 路由如实报 `surface_not_wired`（501），**不**编造数据。
 */

/** 五个只读面（首版闭集；顺序即页面顺序） */
export type AdminReadSurfaceId =
  | 'cognition'
  | 'goals_commitments'
  | 'jobs'
  | 'safety_quota'
  | 'effective_config'
  /** **第六个面**（用户 2026-10-14 裁定「核心状态加进页面，加第六个面」；`R-A1-5`） */
  | 'core_status'

export interface AdminReadSurfaceSpec {
  readonly id: AdminReadSurfaceId
  /** HTTP 路径（`GET`） */
  readonly path: string
  /** 人读标题（页面导航用） */
  readonly title: string
  /** **返回字段的闭集**（多一个字段 = 改清单，必须显式） */
  readonly fields: readonly string[]
  /** 是否允许含**必须遮蔽**的值（`effective_config` 的密钥类字段） */
  readonly mayContainSecrets: boolean
}

/**
 * 冻结清单（`R-A1-2` 的五个面 + 用户 2026-10-14 追加的**第六个面** `core_status`）。
 *
 * ⚠️ 与 `evals/a1/read-surfaces.json` **双向核对**（门里有判据）：改一处必须两处一起改 + 更新冻结档。
 */
export const ADMIN_READ_SURFACES: readonly AdminReadSurfaceSpec[] = [
  {
    /*
     * 第六个面（用户 2026-10-14 裁定「核心状态加进页面，加第六个面」）。
     * 读数来自 `R-A1-5` 的**只读**探针（`pg_locks` 里的资格锁）；三态：
     * `presence` = online/offline/**null**（查不出来 ⇒ 界面说"未知"，**绝不**说"离线"）。
     * ⚠️ **不含密钥**（核心状态不是密钥）⇒ `mayContainSecrets: false`。
     */
    id: 'core_status',
    path: '/api/core-status',
    title: '核心状态',
    fields: ['presence', 'label', 'heldCount', 'unavailable'],
    mayContainSecrets: false,
  },
  {
    id: 'cognition',
    path: '/api/cognition',
    title: '认知状态',
    fields: ['characterId', 'affect', 'relationships', 'beliefs', 'watermarks'],
    mayContainSecrets: false,
  },
  {
    id: 'goals_commitments',
    path: '/api/goals-commitments',
    title: '目标与承诺',
    fields: ['openGoals', 'completedGoals', 'openCommitments', 'settledCommitments'],
    mayContainSecrets: false,
  },
  {
    id: 'jobs',
    path: '/api/jobs',
    title: '后台任务',
    fields: ['jobId', 'kind', 'state', 'startedAt', 'finishedAt', 'failureReason'],
    mayContainSecrets: false,
  },
  {
    id: 'safety_quota',
    path: '/api/safety-quota',
    title: '安全与额度',
    fields: ['riskCeiling', 'quotaWindow', 'quotaUsed', 'quotaLimit', 'recentDenials'],
    mayContainSecrets: false,
  },
  {
    id: 'effective_config',
    path: '/api/effective-config',
    title: '有效配置',
    fields: ['flag', 'value', 'source', 'masked'],
    mayContainSecrets: true,
  },
]

/** 一条只读面的返回形状（**字段闭集**由 `spec.fields` 定；这里只约束外壳） */
export interface AdminReadSurfacePayload {
  readonly surface: AdminReadSurfaceId
  /** 读数的生成时刻（**程序事实**，不是页面渲染时刻） */
  readonly generatedAt: string
  readonly items: readonly Record<string, unknown>[]
  /**
   * **这一面里今天拿不到的字段名**（可选）。
   *
   * ⚠️ 它的存在是为了**不许用 0 冒充"没有"**：读不到就如实列出来，
   *    行里对应字段给 `null`，并把名字放进这里（页面据此显示"未接线/不可用"）。
   */
  readonly unavailable?: readonly string[] | undefined
  /**
   * 下一页的游标（可选；`D12` 的分页判据 / 缺口 `B9`）。
   *
   * ⚠️ 它是**不透明**串：页面只负责原样回传，**不许**解释它（解释权在端口实现）。
   * ⚠️ 缺席 = 没有下一页（**不**用 `null` 与"空页"混在一起）。
   */
  readonly nextCursor?: string | undefined
}

/**
 * 端口侧的**客户端错误**（服务端据此回 400，而不是把它当成 500 的服务端故障）。
 *
 * ⚠️ 这是刻意的分工：`bad_cursor` 是**调用方**给错了东西，回 500 会把"你传错了"
 *    伪装成"我们坏了"，运维会去查一个不存在的故障。
 */
export class AdminQueryError extends Error {
  constructor(readonly code: 'bad_cursor', message: string) {
    super(message)
    this.name = 'AdminQueryError'
  }
}

/** 游标形状（不透明 base64url，1–120 字符；**只**校验形状，不解释内容） */
export function cursorShapeProblem(cursor: string | undefined): string | undefined {
  if (cursor === undefined || cursor === '') return undefined
  return /^[A-Za-z0-9_-]{1,120}$/.test(cursor) ? undefined : 'bad_cursor'
}

/** 分页输入（`D12` / 缺口 `B9`）：游标**不透明**，`limit` 由端口再夹紧 */
export interface AdminPageInput {
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/**
 * 只读端口（由装配根注入）。
 *
 * ⚠️ 每个方法**只**读：实现方不得在读取路径上写库、调模型或产生外部副作用。
 * ⚠️ `effective_config` 的密钥类值必须由**实现方**遮蔽（返回 `masked: true`），
 *    服务端**不**做"猜哪个字段是密钥"这种事（猜错就是泄露）。
 * ⚠️ 每个方法都接受**可选**的分页输入（今天只有 `jobs` 用它；其余实现忽略即可）。
 */
export interface AdminQueryPorts {
  cognition(input?: AdminPageInput): Promise<AdminReadSurfacePayload>
  goalsCommitments(input?: AdminPageInput): Promise<AdminReadSurfacePayload>
  jobs(input?: AdminPageInput): Promise<AdminReadSurfacePayload>
  safetyQuota(input?: AdminPageInput): Promise<AdminReadSurfacePayload>
  effectiveConfig(input?: AdminPageInput): Promise<AdminReadSurfacePayload>
  /** 第六个面（用户 2026-10-14 裁定；`R-A1-5`） */
  coreStatus(input?: AdminPageInput): Promise<AdminReadSurfacePayload>
}

/** 端口方法名（与 `AdminQueryPorts` 的键一一对应；路由用它取实现） */
export const ADMIN_PORT_METHOD: Readonly<Record<AdminReadSurfaceId, keyof AdminQueryPorts>> = {
  cognition: 'cognition',
  goals_commitments: 'goalsCommitments',
  jobs: 'jobs',
  safety_quota: 'safetyQuota',
  effective_config: 'effectiveConfig',
  core_status: 'coreStatus',
}

/** 按路径找面（找不到 ⇒ `undefined`；**不**做模糊匹配） */
export function surfaceByPath(path: string): AdminReadSurfaceSpec | undefined {
  return ADMIN_READ_SURFACES.find((surface) => surface.path === path)
}

/**
 * **核心停机时可离线读**的面（用户 2026-10-14 裁定，闭集）。
 *
 * ```text
 * 为什么它们能：A1 管理服务是**独立进程**，`--with-db` 时**自己直读库/配置**（不经过核心）
 *   ⇒ 核心停不影响这四个面。
 * ⚠️ `safety_quota` **不在**这个集合里：它的**账本侧**（`quotaUsed` / `recentDenials`）在
 *    读不到时**如实进 `unavailable`**（配置侧仍可读）—— 裁定逐字如此。
 * ⚠️ **写操作一律如实拒绝**：首版**一个写面都没有**（见 `ADMIN_WRITE_SURFACES`），
 *    所以"拒绝"不是一句承诺，而是**结构上不存在写路由**。
 * ```
 */
export const ADMIN_OFFLINE_READABLE_SURFACES: readonly AdminReadSurfaceId[] = [
  'effective_config', 'jobs', 'goals_commitments', 'cognition',
  /* 第六个面**离线可读**：它正是"报离线"的那一面（判据靠只读查 `pg_locks`，不需要核心在场） */
  'core_status',
]

/** 是否属于"可离线读"的闭集（**不**猜：不在集合里就是不在） */
export function isOfflineReadable(surface: AdminReadSurfaceId): boolean {
  return ADMIN_OFFLINE_READABLE_SURFACES.includes(surface)
}

/**
 * 写面（**受控**，用户 2026-10-14 裁定「按这个设计做」）。
 *
 * ```text
 * 首版**只有一个**写面：`jobs.admit` —— 登记一个后台任务。
 * · 为什么是它：WP4 的 `admin-jobs-store.admit()` 本来就有"执行前原子登记"
 *   （同键同参数 ⇒ replay；同键不同参数 ⇒ 明确拒绝），而**幂等需要入口**；今天没有。
 * · 它**不改领域数据**：只往 `admin_jobs` 写一行任务登记（v20 的表已就位）。
 * · 它是 WP3 的**前置**：经管理控制台产生的动作**必然带已认证的管理会话**
 *   ⇒ 审计 initiator 可以是 `SERVICE/admin-console`（用户同日裁定），而不是 Unknown。
 * ⚠️ 三条硬约束（实现与门都照此守）：
 *   ① 幂等键 + 参数指纹由**程序**算（键排序 + sha256）；同键不同参数 ⇒ 明确拒绝，不静默新建
 *   ② 每次成功登记**必须**记一条审计（initiator=admin-console）；审计写不进 ⇒ 登记**失败关闭**
 *   ③ 受理 ≠ 执行成功：登记后状态是 `pending`（"已提交（尚未执行）"），界面不许说"完成"
 * ⚠️ 明确**不做**：任何改领域数据的控制命令；任务执行器本体（今天没有谁去跑 `admin_jobs`
 *   ⇒ `pending` 会停着，这是**如实**状态，不是故障）。
 * ⚠️ 将来再加写面，必须先有裁定 + 契约 + 门；**不许**悄悄加一条 POST 路由。
 * ```
 */
export const ADMIN_WRITE_SURFACES: readonly string[] = ['jobs.admit']

/**
 * 受控写端口（首版**一个**：`jobsAdmit`）。
 *
 * ```text
 * ⚠️ `adminId` 是**已认证**的管理会话身份（服务端从会话里取，**不**从请求体取）
 *    ⇒ 审计的 initiator 因此有据可依（WP3 的最后一格就靠它）。
 * ⚠️ 端口**必须**自己保证"审计写不进 ⇒ 登记失败关闭"（服务端只看到抛错 ⇒ 500 `write_failed`）。
 * ⚠️ `admission: 'replayed'` 表示**幂等命中**（返回原任务），**不是**第二次执行。
 * ```
 */
export interface AdminWritePorts {
  jobsAdmit(input: { readonly idempotencyKey: string; readonly params: unknown; readonly adminId: string }): Promise<{
    readonly admission: 'created' | 'replayed'
    readonly jobId: string
    readonly state: string
  }>
}

// ---------------------------------------------------------------------------
// R-A1-5（用户 2026-10-14 裁定「可以」）：核心在线/离线 = 资格锁是否被持有
// ---------------------------------------------------------------------------

/**
 * **核心存在性**三态（`R-A1-5`）。
 *
 * ```text
 * 判据 = 单认知执行者资格锁是否被持有（`single-core-qualification.ts`；
 *        advisory lock id 由纯函数 `singleCoreLockId(characterId)` 给出）
 * ⚠️ **三态**，不是两态：查不出来（无库 / 权限不足 / 行形状不对）⇒ `null` ⇒ 界面说"未知"，
 *    **绝不**把它报成"离线"（本仓库铁律：不知道就说不知道）。
 * ⚠️ 探针**只读**（查 `pg_locks`），**不**去抢锁 —— 抢锁会真的占住资格，那是副作用。
 * ```
 */
export type CorePresence = 'online' | 'offline' | null

/**
 * 由"匹配到的资格锁行数"映射成三态（**纯函数**，门直接穷举）。
 *
 * ⚠️ 输入是**行数**（`select count(*) … where locktype='advisory' and granted and ((classid::bigint << 32) | objid::bigint) = <id>`）：
 *    单键 `pg_try_advisory_lock(bigint)` 在 `pg_locks` 里拆成 `classid`（高 32 位）+ `objid`（低 32 位），
 *    **不要**拿整键去比 `objid`（"看起来对"的经典错法）。
 */
export function corePresenceFromLockCount(count: number | undefined | null): CorePresence {
  if (count === undefined || count === null) return null
  if (!Number.isSafeInteger(count) || count < 0) return null
  return count > 0 ? 'online' : 'offline'
}

/** 界面文案（**三态各说各的**；`null` 说"未知"，不说"离线"） */
export function corePresenceLabel(presence: CorePresence): string {
  if (presence === 'online') return '核心在线'
  if (presence === 'offline') return '核心离线'
  return '核心状态未知（读不到资格锁）'
}

/**
 * 纵深防御：**不该含密钥**的面上，字段名像密钥 ⇒ 丢掉。
 *
 * ⚠️ 这不是主要防线（主要防线是"实现方遮蔽" + "字段闭集"），而是**兜底**：
 *    万一有人把 `apiKey` 这类名字加进某个非密钥面的字段闭集里，服务端仍会把它丢掉并计数。
 * ⚠️ 它**只**看字段名（不看值）：按值猜密钥会误伤正常内容，而"猜错就泄露"的代价更高。
 */
export function shouldDropSecretShapedField(surface: AdminReadSurfaceSpec, field: string): boolean {
  if (surface.mayContainSecrets) return false
  return /(secret|password|token|api[_-]?key|credential)/i.test(field)
}

/** 清单自检（门用；返回具名问题，空数组 = 合法） */
export function adminReadSurfaceProblems(): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  const paths = new Set<string>()
  for (const surface of ADMIN_READ_SURFACES) {
    if (ids.has(surface.id)) problems.push(`重复的面 id：${surface.id}`)
    if (paths.has(surface.path)) problems.push(`重复的路径：${surface.path}`)
    ids.add(surface.id)
    paths.add(surface.path)
    if (!surface.path.startsWith('/api/')) problems.push(`${surface.id} 的路径不在 /api/ 下：${surface.path}`)
    if (surface.fields.length === 0) problems.push(`${surface.id} 的字段闭集为空`)
    if (new Set(surface.fields).size !== surface.fields.length) problems.push(`${surface.id} 的字段有重复`)
    if (surface.id !== 'effective_config' && surface.mayContainSecrets) {
      problems.push(`${surface.id} 不该允许含密钥字段`)
    }
  }
  return problems
}
