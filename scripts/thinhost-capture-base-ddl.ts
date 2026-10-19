/**
 * W1 · 从**隔离库**捕获六张基础表的 DDL，生成 TypeScript 常量。
 *
 * ⚠️ 为什么用 Node 而不是 `pg_dump | Out-File`：
 *   本仓 shell 是代码页 936，`pg_dump` 的 UTF-8 输出经 PowerShell 管道会逐字损坏
 *   （`L-QQP-03` 记录过的同型事故）。这里**全程不进 shell** ——
 *   `pg_dump` 的输出直接由 Node 以二进制接收、按 UTF-8 解码。
 *
 * 用法：`pnpm thinhost:capture:base-ddl -- <lg_test_db> [out.ts]`
 * 失败关闭：目标必须是 `lg_test_` 前缀的隔离库。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const CONTAINER = 'lg-postgresql-production'
const TABLES = ['agents', 'entities', 'memories', 'participants', 'rooms', 'worlds']

const argv = process.argv.slice(2).filter((a) => a !== '--')
const DB = argv[0] ?? ''
const OUT = resolve(argv[1] ?? 'src/infrastructure/persistence/base-tables-ddl.ts')

if (DB === '' || !DB.startsWith('lg_test_')) {
  console.error(`拒绝：目标库 "${DB}" 不带 lg_test_ 前缀`)
  process.exit(2)
}

const r = spawnSync(
  'docker',
  [
    'exec', CONTAINER, 'pg_dump', '-U', 'lg_bootstrap',
    '--schema-only', '--no-owner', '--no-privileges', '--no-comments',
    ...TABLES.flatMap((t) => ['-t', t]),
    DB,
  ],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
)

if (r.status !== 0) {
  console.error(`pg_dump 失败（exit=${String(r.status)}）：${(r.stderr ?? '').slice(0, 400)}`)
  process.exit(3)
}

const sql = String(r.stdout ?? '')

// ---------------------------------------------------------------------------
// 拆语句：pg_dump 以 ";\n\n" 结束一条语句
//
// ⚠️ **实测形状**（第一版按 `^create table` 过滤，结果 46 段全部落选、生成空文件）：
//   pg_dump 给每条语句前加一行注释，形如
//     `-- Name: agents; Type: TABLE; Schema: public; Owner: -`
//     `CREATE TABLE public.agents (`
//   ⇒ **必须先剥注释再判定**，否则一条都匹配不上。
//
// 保留四类（都是"建表所需"）：
//   ① CREATE TABLE            ② ALTER TABLE … ADD CONSTRAINT（PK / UNIQUE）
//   ③ CREATE INDEX             ④ ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY
// 丢弃：SET / SELECT pg_catalog / DROP / 扩展 / 末尾的 dump 结束标记。
// ---------------------------------------------------------------------------
const raw = sql
  .split(/;\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s !== '')

/** 剥掉 `--` 行注释（只剥整行注释，不动字符串里的 `--`） */
function stripComments(s: string): string {
  return s
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .trim()
}

// ⚠️⚠️ **正则不能带 `[\s\S]*`**（实测踩到）：`/^alter\s+table[\s\S]*\badd\s+constraint\b/`
//    会**跨段贪婪匹配**，把后面的 `CREATE INDEX` 一并吞进同一条"语句"，
//    于是 **7 个索引全部消失**（`pg_dump` 输出 46 段、索引正则本来能匹配到 7 个，
//    但生成的文件里索引为 0）。
//    ⇒ 一律用**行内**模式（`[^;]*` / `[^\n]*`），不允许跨段。
const KEEP = [
  /^create\s+table\s+/i, // ①
  /^alter\s+table\s+(?:only\s+)?\S+\s+add\s+constraint\s+/i, // ②④（不跨段）
  /^create\s+(unique\s+)?index\s+/i, // ③
]
const DROP = /^drop\s+/i

// ⚠️ **只保留外键与索引，不保留建表**（2026-10-19 用户裁定）
//
// 实测发现：迁移 0023（`lg-runtime-compatibility-tables`）**已经建了全部六张表**，
// 且列集合与本文件取证得到的**逐表相同**（agents 17 / entities 5 / memories 10 /
// participants 6 / rooms 10 / worlds 6）。
// ⇒ 0024 的真正增量只有：**12 条外键 + 7 个索引**（0023 只建了主键与唯一约束）。
// ⇒ 六条 `create table` 保留在源文件里作为**取证留痕**，但**不进入迁移 0024**
//    （它们在已建表的库上是空操作，且会掩盖"0024 到底做了什么"）。
const statements = raw
  .map(stripComments)
  .filter((s) => s !== '' && !DROP.test(s) && KEEP.some((re) => re.test(s)))
  // ① 先排除建表（它们已由 0023 负责）
  .filter((s) => !/^create\s+table\s+/i.test(s))
  // ② 再改写成幂等形式
  .map((s) => `${toIdempotent(s)};`)

/**
 * 把一条 `pg_dump` 语句改写成**幂等**形式。
 *
 * ⚠️ PostgreSQL **不支持** `ADD CONSTRAINT IF NOT EXISTS` ⇒ 约束必须包进
 *    一个按 `pg_constraint.conname` 判断的 `DO` 块。
 * ⚠️ 约束名必须**精确解析**（不能用 `regexp_replace` 拼凑 —— 第一版那么写过，
 *    拼出来的东西既不可读也不正确）。
 */
function toIdempotent(s: string): string {
  // ① CREATE TABLE public.x (...)  ⇒  create table if not exists
  if (/^create\s+table\s+/i.test(s)) {
    return s.replace(/^(create\s+table\s+(?:if\s+not\s+exists\s+)?)/i, 'create table if not exists ')
  }

  // ② CREATE [UNIQUE] INDEX x ON t (...)  ⇒  create [unique] index if not exists
  //
  // ⚠️⚠️ **不能用捕获组做前缀替换**（实测踩到）：写成
  //     `s.replace(/^(create\s+(unique\s+)?index\s+)/i, 'create $1index if not exists ')`
  //    会产出 `create CREATE INDEX index if not exists …` —— 捕获组 1 **已含**
  //    整个 `CREATE [UNIQUE] INDEX ` 前缀，外面再加 `create`/`index` 就重复了。
  //    ⇒ 改成**只捕获 unique 部分**，其余原样保留。
  if (/^create\s+(unique\s+)?index\s+/i.test(s)) {
    return s.replace(/^create\s+(unique\s+)?index\s+/i, (_m, unique: string | undefined) =>
      `create ${unique ?? ''}index if not exists `
    )
  }

  // ③ ALTER TABLE [ONLY] t ADD CONSTRAINT name <rest>
  //    ⇒ do $$ begin if not exists (select 1 from pg_constraint where conname = 'name') then
  //          alter table t add constraint name <rest>; end if; end $$;
  const m = /^alter\s+table\s+(?:only\s+)?([^\s]+)\s+add\s+constraint\s+(\S+)\s+([^;]+)$/i.exec(s)
  if (m !== null) {
    const [, table, conName, rest] = m
    const con = conName!.replace(/'/g, "''")
    const tbl = table!.replace(/'/g, "''")
    return (
      `do $$ begin\n` +
      `  if not exists (select 1 from pg_constraint where conname = '${con}') then\n` +
      `    alter table ${tbl} add constraint ${conName} ${rest!.trim()};\n` +
      `  end if;\n` +
      `end $$;`
    )
  }

  // ④ 没识别出来的形状 ⇒ **不静默放过**，原样返回但计数，
  //    由调用方核对（漏一条约束的后果是"约束悄悄没了"）。
  return s
}

if (statements.length === 0) {
  // ⚠️ 诊断输出：只打每段的前 90 字符，足够看出形状，且不把整份 dump 灌进终端
  console.error(`拒绝：过滤后没有语句（原始 ${String(raw.length)} 段）。各段开头：`)
  for (const [i, s] of raw.entries()) {
    console.error(`  [${String(i)}] ${s.replace(/\s+/g, ' ').slice(0, 90)}`)
  }
  process.exit(4)
}

const body = statements
  .map((s) => {
    const escaped = s
      .replace(/\\/g, '\\\\')
      .replace(/`/g, '\\`')
      .replace(/\$\{/g, '\\${')
    return `    \`${escaped}\`,`
  })
  .join('\n')

const file = `/**
 * 六张**基础表**的**增量** DDL —— M12 · 迁移 0024（\`elizaos-base-tables\`）。
 *
 * ============================================================================
 *  ⚠️ 这份文件**只含外键与索引**，不含建表
 * ============================================================================
 * 实测发现：迁移 0023（\`lg-runtime-compatibility-tables\`）**已经建了全部六张表**
 * （agents / entities / memories / participants / rooms / worlds），
 * 且列集合与本文件取证得到的**逐表相同**：
 *   agents 17 · entities 5 · memories 10 · participants 6 · rooms 10 · worlds 6
 *
 * 0023 只建了**主键与唯一约束**，缺的是：
 *   · **12 条外键**（FK 链：\`agents ← entities ← memories\`、\`rooms → participants\`）
 *   · **7 个索引**（含 \`idx_memories_*\` / \`idx_participants_*\`）
 * ⇒ 这就是 0024 的全部内容。建表**不在**这里。
 *
 * ============================================================================
 *  来源与边界（如实记录）
 * ============================================================================
 * · **来源**：隔离库 \`${DB}\` 上由**旧宿主**（plugin-sql 1.7.2）从零建出后，
 *   用 \`pg_dump --schema-only\` 捕获，**再剔除建表语句**。
 *   **不是**手写的。· 捕获时间：2026-10-19（M12 W0b/W1）。
 * · 这六张表承载 \`messages\` 镜像等既有功能 —— 本阶段**只接管维护权，不删表结构**。
 * ⚠️ **只增不改**：已发布的迁移内容不许再改；需要改就加新的版本号。
 * ⚠️ 全部语句为**幂等 DDL**（约束包在 \`DO\` 块里按 \`pg_constraint.conname\` 判存在性）。
 *
 * 生成方式：\`pnpm thinhost:base-ddl:capture -- <lg_test_db>\`
 * （⚠️ 全程不进 shell —— 代码页 936 会损坏 UTF-8 输出，见 \`L-QQP-03\`。）
 */

/** 基础表的增量 DDL：12 条外键 + 7 个索引 */
export const BASE_TABLE_DDL: readonly string[] = [
${body}
]
`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, file, 'utf8')
console.log(
  JSON.stringify({
    ok: true,
    db: DB,
    out: OUT,
    statements: statements.length,
    tables: statements.filter((s) => /^create\s+table/i.test(s)).length,
    constraints: statements.filter((s) => /^do\s+\$\$/i.test(s)).length,
    indexes: statements.filter((s) => /^create\s+(unique\s+)?index\s+if\s+not\s+exists/i.test(s)).length,
    bytes: file.length,
  })
)
