/**
 * 服务器仿真环境 · 建库（2026-10-20）
 *
 * ============================================================================
 *  它做什么
 * ============================================================================
 *  按**生产自己的建库流程**给仿真建一套库：
 *
 *    ① 建四个账号（lg_migrate / lg_runtime / lg_readonly / lg_test）
 *    ② 建库 `sumuwei`（owner = lg_migrate）
 *    ③ 装 pgvector 扩展（**超级用户**，`vector` 不是 trusted 扩展）
 *    ④ 重放连接权与授权
 *    ⑤ （之后才轮到）跑内核迁移
 *
 * ============================================================================
 *  ⚠️ 关键：**复用仓库自己的 SQL 文件**，不另写一套
 * ============================================================================
 *  · `scripts/postgresql/init/010-roles.sql` —— 账号分离（含 NO* 属性逐条写明）
 *  · `scripts/postgresql/create-production-db.sql` —— 建库 + 装扩展 + 重放授权
 *
 *  另写一套的后果：仿真的建库流程与生产的**悄悄分叉**，而"分叉"正是本仿真
 *  要抓的那类问题本身。自己写的脚本会成为"另一个事实源"。
 *
 * ============================================================================
 *  ⚠️ 一条**刻意的同形**与它的代价
 * ============================================================================
 *  仿真的**库名与角色名与生产逐字相同**（`sumuwei` / `lg_migrate` / …）——
 *  这正是要仿真的东西。代价是：核心的"库身份核对"（LG_PG_EXPECT_DATABASE /
 *  LG_PG_EXPECT_USER）在仿真里**与生产同形，因此不提供额外保护**。
 *
 *  真正挡住"把仿真配置误指到生产库"的是**两条**：
 *    ① **口令**：仿真用自己的一组本地口令，与生产不同 ⇒ 认证直接失败；
 *    ② **实例隔离**：仿真是独立容器 + 独立卷 + 独立端口。
 *  （另有第三条：生产库在本机是 127.0.0.1:55432，仿真在容器内才是那个地址。）
 *  这条如实记在 docs/post-lv2/Server-Simulator-2026-10-20.md。
 *
 * ============================================================================
 *  幂等：已存在的对象**不重建**，并如实打印"已存在/刚建"。
 * ============================================================================
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const COMPOSE = join(REPO, 'serversim', 'compose.yml')
const ROLES_SQL = join(REPO, 'scripts', 'postgresql', 'init', '010-roles.sql')
const PROD_DB_SQL = join(REPO, 'scripts', 'postgresql', 'create-production-db.sql')

/** 仿真的本地口令（**只在本机仿真里有效**，与生产无关） */
const PASSWORDS = {
  bootstrap: 'lg_bootstrap_local_only',
  migrate: 'lg_migrate_local_only',
  runtime: 'lg_runtime_local_only',
  readonly: 'lg_readonly_local_only',
  test: 'lg_test_local_only',
}
const DB_NAME = 'sumuwei'
const BOOTSTRAP_DB = 'lg_trial'

function compose (args: string[], input?: string, env?: string[]): string {
  return execFileSync('docker', ['compose', '-f', COMPOSE, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    input,
    env: env === undefined ? process.env : { ...process.env, ...Object.fromEntries(env.map(e => e.split('=') as [string, string])) },
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
}

/** 以 bootstrap 超级用户在某个库里跑一条 SQL */
function psql (database: string, sql: string): string {
  return compose(['exec', '-T', 'pg', 'psql', '-h', '127.0.0.1', '-p', '5432',
    '-U', 'lg_bootstrap', '-d', database, '-tAc', sql]).trim()
}

function psqlFile (database: string, path: string, env: Record<string, string>): void {
  const sql = readFileSync(path, 'utf8')
  const envArgs = Object.entries(env).map(([key, value]) => '-e').flatMap((flag, index) => {
    const entry = Object.entries(env)[index]
    return entry === undefined ? [] : [flag, `${entry[0]}=${entry[1]}`]
  })
  compose(['exec', '-T', ...envArgs, 'pg', 'psql', '-h', '127.0.0.1', '-p', '5432',
    '-U', 'lg_bootstrap', '-d', database, '-v', 'ON_ERROR_STOP=1', '-q'], sql)
}

// ---------------------------------------------------------------------------
//  ① 账号
// ---------------------------------------------------------------------------
const roleCount = Number(psql(BOOTSTRAP_DB, "select count(*) from pg_roles where rolname in ('lg_migrate','lg_runtime','lg_readonly','lg_test')"))
if (roleCount === 4) {
  console.log(`▸ 四个账号已存在（lg_migrate / lg_runtime / lg_readonly / lg_test）—— 不重建`)
} else {
  console.log(`▸ 建四个账号（复用 scripts/postgresql/init/010-roles.sql）…`)
  psqlFile(BOOTSTRAP_DB, ROLES_SQL, {
    LG_PG_MIGRATE_PASSWORD: PASSWORDS.migrate,
    LG_PG_RUNTIME_PASSWORD: PASSWORDS.runtime,
    LG_PG_READONLY_PASSWORD: PASSWORDS.readonly,
    LG_PG_TEST_PASSWORD: PASSWORDS.test,
    POSTGRES_DB: BOOTSTRAP_DB,
  })
  const after = Number(psql(BOOTSTRAP_DB, "select count(*) from pg_roles where rolname in ('lg_migrate','lg_runtime','lg_readonly','lg_test')"))
  if (after !== 4) { console.error(`❌ 账号没建齐（${String(after)}/4）`); process.exit(1) }
  console.log('  ✅ 账号分离完成')
}

// ---------------------------------------------------------------------------
//  ② 库
// ---------------------------------------------------------------------------
const dbExists = psql(BOOTSTRAP_DB, `select count(*) from pg_database where datname = '${DB_NAME}'`) === '1'
if (dbExists) {
  console.log(`▸ 库 ${DB_NAME} 已存在 —— 不重建`)
} else {
  console.log(`▸ 建库 ${DB_NAME}（复用 scripts/postgresql/create-production-db.sql）…`)
  psqlFile(BOOTSTRAP_DB, PROD_DB_SQL, {
    LG_PROD_DB_NAME: DB_NAME,
    LG_PG_MIGRATE_USER: 'lg_migrate',
  })
  console.log('  ✅ 库已建（owner=lg_migrate，pgvector 已装，授权已重放）')
}

// ---------------------------------------------------------------------------
//  ③ 扩展
// ---------------------------------------------------------------------------
/*
 * ⚠️ 生产实际有**三个**扩展，而仓库的 `create-production-db.sql` 只装 `vector`。
 *    另外两个是**从生产 dump 里读出来的**（dump 里有
 *    `DROP EXTENSION IF EXISTS pgcrypto;` / `fuzzystrmatch`）：
 *      · `pgcrypto`      —— `gen_random_uuid()` 之类
 *      · `fuzzystrmatch` —— ElizaOS plugin-sql 的相似度函数
 *
 *    ⇒ 仿真必须与生产同形，否则"灌进来的 dump 跑不起来"或"核心缺函数"。
 *    ⚠️ 这是一条**偏离于仓库脚本**的补齐，已登记在
 *       docs/post-lv2/Server-Simulator-2026-10-20.md。
 *    ⚠️ 扩展**不是 trusted** ⇒ 只有超级用户能装 ⇒ 由 lg_bootstrap 装。
 */
const EXTENSIONS = ['vector', 'pgcrypto', 'fuzzystrmatch'] as const
for (const extension of EXTENSIONS) {
  const present = psql(DB_NAME, `select count(*) from pg_extension where extname='${extension}'`)
  if (present === '1') continue
  psql(DB_NAME, `create extension if not exists ${extension}`)
  console.log(`  装扩展：${extension}`)
}

// ---------------------------------------------------------------------------
//  ④ 读回：扩展 / 授权 / 角色属性
// ---------------------------------------------------------------------------
const vector = psql(DB_NAME, "select coalesce((select extversion from pg_extension where extname='vector'), 'MISSING')")
const extensionList = psql(DB_NAME, "select string_agg(extname, ',' order by extname) from pg_extension where extname in ('vector','pgcrypto','fuzzystrmatch')")
const appRole = psql(DB_NAME, "select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls from pg_roles where rolname='lg_migrate'")
const connectRights = psql(DB_NAME, `select has_database_privilege('lg_migrate','${DB_NAME}','CONNECT')`)
const schemaCreate = psql(DB_NAME, "select has_schema_privilege('lg_migrate','public','CREATE')")

console.log('\n▸ 建库读回')
console.log(`  pgvector 版本   : ${vector}`)
console.log(`  扩展            : ${extensionList}`)
console.log(`  lg_migrate 属性 : super=${appRole.split('|')[0]} createdb=${appRole.split('|')[1]} createrole=${appRole.split('|')[2]} bypassrls=${appRole.split('|')[3]}`)
console.log(`  CONNECT 权      : ${connectRights}`)
console.log(`  public CREATE   : ${schemaCreate}`)

const problems: string[] = []
if (vector === 'MISSING') problems.push('pgvector 扩展没装上 ⇒ 迁移 10 的 vector(384) 列建不出来')
if (extensionList !== 'fuzzystrmatch,pgcrypto,vector') problems.push(`扩展集合与生产不一致（读到 ${extensionList}，生产是 fuzzystrmatch,pgcrypto,vector）`)
if (appRole !== 'f|f|f|f') problems.push(`lg_migrate 的 NO* 属性与生产不一致（读到 ${appRole}）`)
if (connectRights !== 't') problems.push('lg_migrate 没有 CONNECT 权')
if (schemaCreate !== 't') problems.push('lg_migrate 没有 public schema 的 CREATE 权（启动期 DDL 会失败）')
if (problems.length > 0) {
  console.error('\n❌ 建库不满足生产形状：')
  for (const problem of problems) console.error(`   · ${problem}`)
  process.exit(1)
}
console.log('\n✅ 仿真库已就绪，形状与生产一致。')
