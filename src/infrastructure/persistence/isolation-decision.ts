/**
 * 隔离目标判定 —— **后端无关**的一层（M12 · W0a）。
 *
 * ============================================================================
 *  它补的是哪一个洞（实测，不是推测）
 * ============================================================================
 * [src/db/index.ts:234-243] 的 `assertDatabaseAccessAllowed` 里，"已隔离"的判据是：
 *
 * ```ts
 * const dir = process.env.PGLITE_DATA_DIR
 * isolated: dir !== undefined && !isProductionDir(dir)
 *   && process.env.PROJECT_LG_SANDBOX !== undefined
 *   && resolve(process.env.PROJECT_LG_SANDBOX) === resolve(dir)
 * ```
 *
 * ⚠️ 四个条件**全部依赖 `PGLITE_DATA_DIR`** ⇒ 在 PostgreSQL 后端下 `dir` 是
 * `undefined` ⇒ `isolated` 恒为 `false` ⇒ 隔离库也必须靠
 * `PROJECT_LG_ALLOW_PRODUCTION_DB=1` 才能开。
 *
 * 那个旗标的语义是"**我承认我要开生产库**"。用它来开隔离库 ⇒
 * 隔离与生产走**同一个开关** ⇒ 一旦某次实验忘了给 `lg_test_` 前缀，
 * 闸不会拦（它只认旗标）。这就是 INC-01 那一类"看起来隔离了"的形状，
 * 在 PG 后端上原样复现。
 *
 * ============================================================================
 *  做法：不改既有语义，只**补一条**后端无关的隔离判据
 * ============================================================================
 * · **PGlite 分支逐字不动** —— 目录闸 / 租约 / pre-open token 属 INC-01 既有裁量，
 *   一个字都不改。
 * · **PostgreSQL 分支**：`isolateDatabase()` 早已是后端无关的（判据是
 *   "目标是测试库"，见 [src/dev/sandbox.ts:141-159](src/dev/sandbox.ts:141)）。
 *   本模块把**同一个判据**抽成纯函数，让 `assertDatabaseAccessAllowed`
 *   在 PG 后端下**也能**判隔离 —— 而不是靠生产旗标。
 *
 * ⚠️ 为什么是"后端无关"而不是"再加一个 PG 判据"：
 *   两套判据迟早会漂移（其中一个被改，另一个没改）。
 *   统一成"**目标身份**"这一个概念后，PGlite 侧多出来的目录/租约/token
 *   是**附加**要求，不是替代。
 */

import { DEFAULT_TEST_DATABASE_PREFIX } from './database-backend.ts'

/** ⚠️ 前缀常量**复用** `database-backend` 的那一份，不在此重复定义 ——
 * 两份常量迟早漂移（ADR-132 D03）。 */
export { DEFAULT_TEST_DATABASE_PREFIX }

/** PostgreSQL 目标身份（读回值与期望值的形状，与 database-backend 一致） */
export interface PgTargetIdentity {
  database?: string
  user?: string
  host?: string
  port?: string
}

/** 隔离判据的输入（全部可选 —— 缺什么就少一条依据） */
export interface IsolationDecisionInput {
  /** 已解析的后端（`resolveDatabaseBackend(...).backend`） */
  backend: 'pglite' | 'postgres'
  /** PostgreSQL 目标（后端为 postgres 时必需） */
  pgTarget?: PgTargetIdentity
  /** 期望身份（来自 `LG_PG_EXPECT_*`，后端为 postgres 时必需） */
  pgExpectation?: { database?: string; users?: readonly string[] }
  /** 测试库名前缀（`LG_TEST_DATABASE_PREFIX`，缺省 `lg_test_`） */
  testDatabasePrefix?: string
  /** PGlite 侧既有判据（目录闸的结论），逐字沿用，不在本模块重新判定 */
  pgliteIsolated?: boolean
}

export type IsolationDenialCode =
  | 'isolation_pg_target_missing'
  | 'isolation_pg_expectation_missing'
  | 'isolation_pg_database_not_test'
  | 'isolation_pg_user_not_expected'
  | 'isolation_pg_identity_unverified'

export interface IsolationDecision {
  allowed: boolean
  /** 拒绝的**具名**原因（缺失时 undefined） */
  denial?: IsolationDenialCode
  /** 人读理由（缺失时 undefined） */
  reason?: string
}

/**
 * 判定"当前目标是不是一个隔离的测试库"。
 *
 * ⚠️ **失败关闭**：任何一条依据缺失都**拒绝**（返回 `allowed: false` + 具名码）。
 *   宁可拒绝一次合法运行，也不要放过一次指向生产的运行。
 *
 * · `backend === 'pglite'` ⇒ 逐字交给 `pgliteIsolated`（既有目录闸的结论）。
 * · `backend === 'postgres'` ⇒ 用**目标身份**判定，与目录无关。
 */
export function isolationDecisionFor(
  input: IsolationDecisionInput
): IsolationDecision {
  // -------------------------------------------------------------------------
  // ① PGlite：语义逐字不变（目录闸在调用方算好）
  // -------------------------------------------------------------------------
  if (input.backend === 'pglite') {
    return input.pgliteIsolated === true
      ? { allowed: true }
      : {
          allowed: false,
          denial: 'isolation_pg_identity_unverified',
          reason:
            'PGlite 隔离未成立（目录闸未放行）。既有目录闸语义不变，本模块不重新判定。',
        }
  }

  // -------------------------------------------------------------------------
  // ② PostgreSQL：目标身份判定
  //
  // ⚠️⚠️ **两条必须同时成立**（v1 实测踩到的洞，见 thinhost-isolation-verify 的 C 项）：
  //   ① 期望库名与读回库名**逐字相同**
  //   ② 该库名**本身就是测试库**（带 `lg_test_` 前缀）
  // 只做 ① 时，把 `expectation.database` 写成 `sumuwei` 就能打开生产库 ——
  // 那时"隔离成立"只取决于**调用方自己写了什么**，等于没有闸。
  // ⇒ ② 是不可省的**独立**条件。
  // -------------------------------------------------------------------------
  const target = input.pgTarget
  if (target === undefined || (target.database ?? '') === '') {
    return {
      allowed: false,
      denial: 'isolation_pg_target_missing',
      reason: 'PG 后端下没有可核对的数据库名（读回身份为空）。',
    }
  }

  const expectation = input.pgExpectation
  if (
    expectation === undefined ||
    ((expectation.database ?? '') === '' && (expectation.users?.length ?? 0) === 0)
  ) {
    return {
      allowed: false,
      denial: 'isolation_pg_expectation_missing',
      reason:
        'PG 后端下没有期望身份（LG_PG_EXPECT_DATABASE / LG_PG_EXPECT_USER）。' +
        '没有可核对的对象就不算隔离。',
    }
  }

  // 条件 ①：期望库名（给了就必须逐字相同）
  const expectedDatabase = (expectation.database ?? '').trim()
  if (expectedDatabase !== '' && expectedDatabase !== target.database) {
    return {
      allowed: false,
      denial: 'isolation_pg_database_not_test',
      reason: `数据库身份不符：期望 "${expectedDatabase}"，实际 "${target.database}"。`,
    }
  }

  // 条件 ②：**无条件**要求目标是测试库（无论有没有给期望库名）
  const prefix = (input.testDatabasePrefix ?? DEFAULT_TEST_DATABASE_PREFIX).trim()
  if (prefix === '' || !(target.database ?? '').startsWith(prefix)) {
    return {
      allowed: false,
      denial: 'isolation_pg_database_not_test',
      reason: `目标库 "${target.database}" 不是测试库（不以 "${prefix}" 开头）。`,
    }
  }

  // 期望用户时逐字核对
  const expectedUsers = (expectation.users ?? []).map((u) => u.trim()).filter((u) => u !== '')
  if (expectedUsers.length > 0 && !(target.user ?? '').trim()) {
    return {
      allowed: false,
      denial: 'isolation_pg_user_not_expected',
      reason: `期望用户 [${expectedUsers.join(', ')}]，但实际用户读不到。`,
    }
  }
  if (
    expectedUsers.length > 0 &&
    !expectedUsers.includes((target.user ?? '').trim())
  ) {
    return {
      allowed: false,
      denial: 'isolation_pg_user_not_expected',
      reason: `用户身份不符：期望 [${expectedUsers.join(', ')}]，实际 "${target.user}"。`,
    }
  }

  return { allowed: true }
}
