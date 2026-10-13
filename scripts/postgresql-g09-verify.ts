/**
 * PG-G09 量具有效性（WP4）—— **规范化比较器**的三段式。
 *
 * ============================================================================
 *  为什么这道门单独存在
 * ============================================================================
 *  迁移的完整性结论**全靠这个比较器**。比较器本身不可信 ⇒ 后面所有"一致"都不算数。
 *  所以验收契约 §3 的 `PG-G09` 要求它自己先过**三段式**：
 *
 * ```text
 *   正控：两份**应当一致**的数据 ⇒ 判一致
 *   负控：每条**只改一处** ⇒ 必须失败，且失败原因**互不相同**（具名）
 *   恢复：把改动还原 ⇒ 又一致
 * ```
 *
 * ---------------------------------------------------------------------------
 *  这道门的两层
 * ---------------------------------------------------------------------------
 *  ① **纯函数层**（不需要实例）：归一化与摘要的判据本身。
 *     含一条关键负控 —— **"按 JS 形状归一"会造出假相等**：
 *     `bigint 5` 与 `text "5"` 必须判**不同**（所以归一化要**按列类型**做）。
 *
 *  ② **真跨驱动层**（需要 PGlite 快照副本 + 真 PG 实例）：
 *     从真实快照里读一张真表（`character_schema_migrations`，18 行），
 *     插进真 PG，然后**跨两个驱动**比较。
 *     ⚠️ 这一层才是"量具真的在量东西"的证据：同一份逻辑数据经
 *        PGlite 与真 PostgreSQL 两个驱动到达 JS 时**形状不同**
 *        （最典型：`bigint` 在 pg 驱动下是**字符串**）。
 *
 * 跑法：pnpm postgresql:g09:verify
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  PG_CONTAINER,
  PG_CREDENTIALS_FILE,
  PG_HOST_PORT,
  loadPgCredentials,
  missingCredentialKeys,
} from './postgresql/credentials.ts'

import {
  canonicalNumber,
  compareTables,
  normalizeByType,
  tableDigest,
  type ColumnSpec,
} from './postgresql/row-digest.ts'
import { readPgliteTable } from './postgresql/pglite-reader.ts'

// ===========================================================================
// 配置
// ===========================================================================
// ⚠️ 凭据读取走**共用模块**（理由见 `scripts/postgresql/credentials.ts` 的文件头）。
const CONTAINER = PG_CONTAINER
const HOST_PORT = PG_HOST_PORT
/** 默认用 WP0 读过的那个 verified 快照（它是"合格来源"） */
const SOURCE_SNAPSHOT =
  process.env.LG_PG_SOURCE_SNAPSHOT ??
  'data/snapshots/desktop-actions-activation-20261009/pglite-2026-10-13T12-02-14-409Z-90cae4d22dcd'
/** 跨驱动比较用的真表：小（18 行）、有主键、**含一个 bigint 列**（正是编码差异所在） */
const REAL_TABLE = 'character_schema_migrations'

const credentials = loadPgCredentials()
const missingKeys = missingCredentialKeys(credentials)

// ===========================================================================
// 报告骨架
// ===========================================================================
const checks: { name: string; pass: boolean; detail?: string }[] = []
const notRun: { id: string; what: string; why: string }[] = []

function check(name: string, fn: () => void): void {
  try {
    fn()
    checks.push({ name, pass: true })
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

// ===========================================================================
// §1 归一化：纯函数层
// ===========================================================================
check('G09.1a bigint：number 5 与字符串 "5"（pg 驱动的默认形状）归一成同一个', () => {
  // ⚠️ 断言的是**等价性**（三者归一成同一个），不是**具体编码** ——
  //    编码是实现细节（现在带类型家族标签），不该被测试钉死。
  const fromNumber = normalizeByType(5, 'bigint')
  assert.equal(normalizeByType('5', 'bigint'), fromNumber)
  assert.equal(normalizeByType(5n, 'bigint'), fromNumber)
  assert.notEqual(normalizeByType(6, 'bigint'), fromNumber, '不同的整数不该归一成同一个')
  // 大整数不能被 number 精度压扁
  assert.notEqual(
    normalizeByType('9007199254740993', 'bigint'),
    normalizeByType('9007199254740992', 'bigint'),
    '超出 number 精度的两个大整数被压成同一个 ⇒ 精度丢失'
  )
})

check('G09.1b ★ **按列类型**归一：bigint 5 与 text "5" 必须判**不同**（否则是假相等）', () => {
  // 这是"只按 JS 形状归一"会踩的坑：两者都归一成 "5" ⇒ 一个 bigint 5 与一个 text "5"
  // 会被判成"相同"，而它们根本不是同一个值。
  //
  // ⚠️ 本轮实测：**第一版确实踩了这个坑**，是这条负控把它抓出来的
  //    （`FAIL bigint 5 与 text "5" 归一成了同一个（5）`）⇒ 修法是给归一化加**类型家族标签**。
  const asBigint = normalizeByType(5, 'bigint')
  const asText = normalizeByType('5', 'text')
  assert.notEqual(
    asBigint,
    asText,
    `bigint 5 与 text "5" 归一成了同一个（${asBigint}）⇒ 比较器会造出假相等`
  )
  // 同一个家族内部仍然等价（否则标签就"矫枉过正"了）
  assert.equal(normalizeByType(5, 'integer'), normalizeByType('5', 'int4'))
})

check('G09.1c jsonb：键序不同必须归一（jsonb 在 PG 里不保留键序）', () => {
  const a = normalizeByType({ b: 1, a: 2 }, 'jsonb')
  const b = normalizeByType({ a: 2, b: 1 }, 'jsonb')
  assert.equal(a, b)
  // 驱动给成字符串也要收
  assert.equal(normalizeByType('{"a":2,"b":1}', 'jsonb'), a)
})

check('G09.1d numeric：1.50 与 1.5 归一（去尾随零）', () => {
  assert.equal(canonicalNumber('1.50'), canonicalNumber('1.5'))
  assert.equal(canonicalNumber(5), canonicalNumber('5.0'))
  assert.equal(normalizeByType('1.50', 'numeric'), normalizeByType(1.5, 'numeric'))
})

check('G09.1e boolean：PG 的 t/f 与 JS 的 true/false 归一', () => {
  // 同样断言**等价性**而非具体编码
  const truthy = normalizeByType(true, 'boolean')
  assert.equal(normalizeByType('t', 'boolean'), truthy)
  assert.equal(normalizeByType('true', 'boolean'), truthy)
  assert.notEqual(normalizeByType(false, 'boolean'), truthy, 'true 与 false 不该归一成同一个')
  assert.notEqual(normalizeByType('f', 'boolean'), truthy)
})

check('G09.1f null 与 undefined 归一成同一个（都表示 SQL NULL）', () => {
  assert.equal(normalizeByType(null, 'text'), normalizeByType(undefined, 'text'))
})

check('G09.1g 时间：Date 与 ISO 字符串归一', () => {
  const iso = '2026-10-13T00:00:00.000Z'
  assert.equal(normalizeByType(new Date(iso), 'timestamp with time zone'), normalizeByType(iso, 'timestamp with time zone'))
})

// ===========================================================================
// §2 摘要与比较：纯函数层
// ===========================================================================
const COLS: ColumnSpec[] = [
  { name: 'version', dataType: 'integer' },
  { name: 'name', dataType: 'text' },
  { name: 'applied_at', dataType: 'bigint' },
]
const ROWS: Record<string, unknown>[] = [
  { version: 1, name: 'm1-a', applied_at: 100 },
  { version: 2, name: 'm2-b', applied_at: 200 },
  { version: 3, name: 'm3-c', applied_at: 300 },
]
const digestOf = (rows: Record<string, unknown>[], pk: string[] = ['version']): ReturnType<typeof tableDigest> =>
  tableDigest({ table: 't', rows, columns: COLS, primaryKey: pk })

check('G09.2-正控 两份相同数据 ⇒ 判一致', () => {
  const r = compareTables([{ source: digestOf(ROWS), target: digestOf(ROWS) }])
  assert.equal(r.allMatch, true, JSON.stringify(r.mismatched))
})

check('G09.2a-负控 删一行 ⇒ row_count_differs', () => {
  const r = compareTables([{ source: digestOf(ROWS), target: digestOf(ROWS.slice(1)) }])
  assert.equal(r.allMatch, false)
  assert.equal(r.comparisons[0].reason, 'row_count_differs')
})

check('G09.2b-负控 改主键值（行数不变）⇒ primary_key_set_differs', () => {
  const changed = ROWS.map((row) => (row.version === 2 ? { ...row, version: 99 } : row))
  const r = compareTables([{ source: digestOf(ROWS), target: digestOf(changed) }])
  assert.equal(r.allMatch, false)
  assert.equal(r.comparisons[0].reason, 'primary_key_set_differs')
})

check('G09.2c-负控 改非主键值（主键不变）⇒ content_digest_differs', () => {
  const changed = ROWS.map((row) => (row.version === 2 ? { ...row, name: 'm2-CHANGED' } : row))
  const r = compareTables([{ source: digestOf(ROWS), target: digestOf(changed) }])
  assert.equal(r.allMatch, false)
  assert.equal(r.comparisons[0].reason, 'content_digest_differs')
})

check('G09.2d-负控 改一个 bigint 值（差 1）⇒ content_digest_differs（不能被"看起来差不多"糊过去）', () => {
  const changed = ROWS.map((row) => (row.version === 3 ? { ...row, applied_at: 301 } : row))
  const r = compareTables([{ source: digestOf(ROWS), target: digestOf(changed) }])
  assert.equal(r.allMatch, false)
  assert.equal(r.comparisons[0].reason, 'content_digest_differs')
})

check('G09.2e ★ 无主键表：**删一行加一行**（总数不变）⇒ multiset_differs', () => {
  // 这条正是计划 §6.6 逐字要求"不只比总数"的原因：总数一样，内容不一样。
  const source = digestOf(ROWS, [])
  const target = digestOf([...ROWS.slice(0, 2), { version: 3, name: 'm3-DIFFERENT', applied_at: 300 }], [])
  assert.equal(source.rowCount, target.rowCount, '总数必须相同，否则这条负控量错了东西')
  assert.equal(source.strategy, 'multiset')
  const r = compareTables([{ source, target }])
  assert.equal(r.allMatch, false)
  assert.equal(r.comparisons[0].reason, 'multiset_differs')
})

check('G09.2f 恢复：把改动还原 ⇒ 又一致', () => {
  const changed = ROWS.map((row) => (row.version === 2 ? { ...row, name: 'X' } : row))
  const broken = compareTables([{ source: digestOf(ROWS), target: digestOf(changed) }])
  assert.equal(broken.allMatch, false, '前置：改动应当被判不一致')
  const restored = compareTables([{ source: digestOf(ROWS), target: digestOf(ROWS) }])
  assert.equal(restored.allMatch, true)
})

// ===========================================================================
// §3 真跨驱动：从真快照读真表 → 插进真 PG → 比较
// ===========================================================================
interface PsqlResult {
  rc: number
  out: string
  err: string
}

function psql(user: string, password: string, database: string, sql: string): PsqlResult {
  const result = spawnSync(
    'docker',
    ['exec', '-e', 'PGPASSWORD', CONTAINER, 'psql', '-h', '127.0.0.1', '-U', user, '-d', database, '-v', 'ON_ERROR_STOP=1', '-tAc', sql],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: password }, timeout: 60_000 }
  )
  return { rc: result.status ?? -1, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

function manageTestDb(script: 'create-test-db.sql' | 'drop-test-db.sql', dbName: string): PsqlResult {
  const result = spawnSync(
    'docker',
    [
      'exec', '-e', 'PGPASSWORD', '-e', `LG_TEST_DB_NAME=${dbName}`, '-e', 'LG_PG_MIGRATE_USER=lg_migrate',
      CONTAINER, 'psql', '-h', '127.0.0.1', '-U', credentials?.LG_PG_BOOTSTRAP_USER ?? 'lg_bootstrap',
      '-d', credentials?.LG_PG_BOOTSTRAP_DB ?? 'lg_trial', '-v', 'ON_ERROR_STOP=1', '-f', `/opt/lg/${script}`,
    ],
    { encoding: 'utf8', env: { ...process.env, PGPASSWORD: credentials?.LG_PG_BOOTSTRAP_PASSWORD ?? '' }, timeout: 120_000 }
  )
  return { rc: result.status ?? -1, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

const instanceUp = ((): boolean => {
  if (credentials === undefined) return false
  const probe = psql(
    credentials.LG_PG_BOOTSTRAP_USER ?? 'lg_bootstrap',
    credentials.LG_PG_BOOTSTRAP_PASSWORD ?? '',
    'postgres',
    'select 1 as ok'
  )
  return probe.rc === 0 && probe.out.includes('1')
})()

const snapshotExists = existsSync(resolve(SOURCE_SNAPSHOT, 'PG_VERSION'))

if (credentials === undefined) {
  notRun.push({ id: 'real-cross-driver', what: '真跨驱动比较（PGlite 快照 → 真 PG）', why: `凭据文件不存在：${PG_CREDENTIALS_FILE}` })
} else if (missingKeys.length > 0) {
  notRun.push({
    id: 'real-cross-driver',
    what: '真跨驱动比较（PGlite 快照 → 真 PG）',
    why: `凭据文件缺这些 key：${missingKeys.join(', ')}（文件：${PG_CREDENTIALS_FILE}）`,
  })
} else if (!instanceUp) {
  notRun.push({ id: 'real-cross-driver', what: '真跨驱动比较（PGlite 快照 → 真 PG）', why: `容器 ${CONTAINER} 不可达` })
} else if (!snapshotExists) {
  notRun.push({
    id: 'real-cross-driver',
    what: '真跨驱动比较（PGlite 快照 → 真 PG）',
    why: `来源快照不存在：${SOURCE_SNAPSHOT}（可用 LG_PG_SOURCE_SNAPSHOT 指定）`,
  })
}

if (credentials !== undefined && instanceUp && snapshotExists) {
  const testDb = 'lg_test_g09'
  manageTestDb('drop-test-db.sql', testDb)
  const created = manageTestDb('create-test-db.sql', testDb)
  check('G09.3a 前置：本门的测试库已从零建立', () => {
    assert.equal(created.rc, 0, created.err)
  })

  // -------------------------------------------------------------------------
  // 读真快照里的真表
  // -------------------------------------------------------------------------
  let source: Awaited<ReturnType<typeof readPgliteTable>> | undefined
  let readError: string | undefined
  try {
    source = await readPgliteTable({ sourceDir: SOURCE_SNAPSHOT, table: REAL_TABLE })
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error)
  }

  check('G09.3b 从真快照副本读出真表（且源目录逐字未动）', () => {
    assert.ok(source !== undefined, `读取失败：${readError ?? ''}`)
    assert.equal(source.sourceUnchanged, true, '源目录在读取前后不同 ⇒ 我们动了不该动的东西')
    assert.equal(source.copyMatchesSource, true, '副本与源不一致')
    assert.equal(source.closedClean, true)
    assert.ok(source.rows.length > 0, '读出来是空表 ⇒ 这条比较没有内容可量')
  })

  if (source !== undefined && source.rows.length > 0) {
    // -----------------------------------------------------------------------
    // 把同一批行插进真 PG（**逐值原样**，不做任何"顺手归一"）
    // -----------------------------------------------------------------------
    const escape = (value: unknown): string => {
      if (value === null || value === undefined) return 'null'
      if (typeof value === 'number' || typeof value === 'bigint') return String(value)
      if (typeof value === 'boolean') return value ? 'true' : 'false'
      return `'${String(value).replace(/'/g, "''")}'`
    }
    const columnList = source.columns.map((c) => `"${c.name}"`).join(', ')
    const values = source.rows
      .map((row) => `(${source!.columns.map((c) => escape(row[c.name])).join(',')})`)
      .join(',')
    const insert = await psql(
      'lg_migrate',
      credentials.LG_PG_MIGRATE_PASSWORD ?? '',
      testDb,
      `drop table if exists ${REAL_TABLE}; create table ${REAL_TABLE} (version integer primary key, name text not null, applied_at bigint not null); insert into ${REAL_TABLE} (${columnList}) values ${values}`
    )
    check('G09.3c 同一批行已插进真 PG', () => {
      assert.equal(insert.rc, 0, insert.err)
    })

    /** 从真 PG 读回整表（用 psql 的 JSON 聚合，避免再引入一个驱动） */
    const readTarget = (): Record<string, unknown>[] | undefined => {
      const r = psql(
        'lg_migrate',
        credentials.LG_PG_MIGRATE_PASSWORD ?? '',
        testDb,
        `select coalesce(json_agg(row_to_json(t)), '[]'::json) from (select * from ${REAL_TABLE}) t`
      )
      if (r.rc !== 0) return undefined
      try {
        return JSON.parse(r.out) as Record<string, unknown>[]
      } catch {
        return undefined
      }
    }

    const targetColumns: ColumnSpec[] = [
      { name: 'version', dataType: 'integer' },
      { name: 'name', dataType: 'text' },
      { name: 'applied_at', dataType: 'bigint' },
    ]
    const targetRows = readTarget()
    check('G09.3d 从真 PG 读回整表', () => {
      assert.ok(targetRows !== undefined, 'psql 读回失败或 JSON 解析失败')
      assert.equal(targetRows.length, source!.rows.length)
    })

    // -----------------------------------------------------------------------
    // ★ 正控：跨两个驱动比较 —— 必须判一致
    // -----------------------------------------------------------------------
    // ⚠️ 这一条是整道门的关键：同一份逻辑数据经 PGlite 与真 PostgreSQL 到达 JS 时
    //    **形状不同**（bigint 在 pg 驱动下是字符串、jsonb 键序可能不同…）。
    //    比较器若不做归一化，这里会**假不等**。
    check('G09.3e ★ 正控：跨驱动（PGlite → 真 PG）比较 ⇒ 判**一致**', () => {
      assert.ok(targetRows !== undefined, '没有读回目标')
      const sourceDigest = tableDigest({
        table: REAL_TABLE,
        rows: source!.rows,
        columns: targetColumns,
        primaryKey: ['version'],
      })
      const targetDigest = tableDigest({
        table: REAL_TABLE,
        rows: targetRows,
        columns: targetColumns,
        primaryKey: ['version'],
      })
      const r = compareTables([{ source: sourceDigest, target: targetDigest }])
      assert.equal(
        r.allMatch,
        true,
        `跨驱动比较判成不一致（${r.mismatched.join(',')}）⇒ 归一化没有覆盖真实的编码差异`
      )
    })

    // -----------------------------------------------------------------------
    // 负控（每条只改一处，原因必须互不相同）
    // -----------------------------------------------------------------------
    check('G09.3f-负控 目标里删一行 ⇒ row_count_differs', () => {
      const mutate = psql(
        'lg_migrate',
        credentials.LG_PG_MIGRATE_PASSWORD ?? '',
        testDb,
        `delete from ${REAL_TABLE} where version = (select min(version) from ${REAL_TABLE})`
      )
      assert.equal(mutate.rc, 0, mutate.err)
      const after = readTarget()
      assert.ok(after !== undefined)
      const r = compareTables([
        {
          source: tableDigest({ table: REAL_TABLE, rows: source!.rows, columns: targetColumns, primaryKey: ['version'] }),
          target: tableDigest({ table: REAL_TABLE, rows: after, columns: targetColumns, primaryKey: ['version'] }),
        },
      ])
      assert.equal(r.allMatch, false)
      assert.equal(r.comparisons[0].reason, 'row_count_differs')
    })

    check('G09.3g-负控 目标里改一个**非主键**值 ⇒ content_digest_differs', () => {
      const mutate = psql(
        'lg_migrate',
        credentials.LG_PG_MIGRATE_PASSWORD ?? '',
        testDb,
        `update ${REAL_TABLE} set name = name || '-tampered' where version = (select max(version) from ${REAL_TABLE})`
      )
      assert.equal(mutate.rc, 0, mutate.err)
      const after = readTarget()
      assert.ok(after !== undefined)
      // ⚠️ 注意这里源也少了一行（上一条负控删过），所以两边**先对齐行数**再比内容 ——
      //    否则量到的是 row_count_differs，不是 content_digest_differs。
      const alignedSource = source!.rows.filter((row) => row.version !== Math.min(...source!.rows.map((r) => Number(r.version))))
      const r = compareTables([
        {
          source: tableDigest({ table: REAL_TABLE, rows: alignedSource, columns: targetColumns, primaryKey: ['version'] }),
          target: tableDigest({ table: REAL_TABLE, rows: after, columns: targetColumns, primaryKey: ['version'] }),
        },
      ])
      assert.equal(r.allMatch, false)
      assert.equal(r.comparisons[0].reason, 'content_digest_differs')
    })

    // -----------------------------------------------------------------------
    // 恢复：重建目标 ⇒ 又一致
    // -----------------------------------------------------------------------
    check('G09.3h 恢复：重建目标后**又一致**', () => {
      const rebuild = psql(
        'lg_migrate',
        credentials.LG_PG_MIGRATE_PASSWORD ?? '',
        testDb,
        `drop table if exists ${REAL_TABLE}; create table ${REAL_TABLE} (version integer primary key, name text not null, applied_at bigint not null); insert into ${REAL_TABLE} (${columnList}) values ${values}`
      )
      assert.equal(rebuild.rc, 0, rebuild.err)
      const after = readTarget()
      assert.ok(after !== undefined)
      const r = compareTables([
        {
          source: tableDigest({ table: REAL_TABLE, rows: source!.rows, columns: targetColumns, primaryKey: ['version'] }),
          target: tableDigest({ table: REAL_TABLE, rows: after, columns: targetColumns, primaryKey: ['version'] }),
        },
      ])
      assert.equal(r.allMatch, true, `恢复后仍不一致：${r.mismatched.join(',')}`)
    })
  }

  const dropped = manageTestDb('drop-test-db.sql', testDb)
  check('G09.4 本门自建的测试库已清理', () => {
    assert.equal(dropped.rc, 0, dropped.err)
  })
}

// ===========================================================================
// 报告
// ===========================================================================
const passed = checks.filter((c) => c.pass).length
const failed = checks.length - passed
const measured = checks.length

console.log('')
console.log('PG-G09 量具有效性（规范化比较器 · 三段式）')
console.log('─'.repeat(72))
console.log(
  `  实例：${CONTAINER} · 可达=${instanceUp} · 快照=${snapshotExists ? '在' : '缺'} · 凭据文件=${credentials === undefined ? '缺失' : '在'}`
)
console.log('─'.repeat(72))
for (const c of checks) {
  console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`)
  if (!c.pass && c.detail !== undefined) console.log(`        └─ ${c.detail}`)
}
console.log('─'.repeat(72))
console.log(`  断言        : ${passed}/${checks.length}`)
console.log(`  未运行      : ${notRun.length}`)
for (const n of notRun) console.log(`      · ${n.id} —— ${n.what}（${n.why}）`)
console.log(`  measured_count = ${measured}`)
console.log(`  失败总数 = ${failed}`)
console.log('')

/*
 * ⚠️ **落盘证据**（2026-10-13 补，`F-WP5-20`）：本门原来**一个字节都不落盘** ——
 *    而只读聚合器（`PG-G10` 切换就绪）要"读已落盘的证据"来审查它 ⇒ 那道门对 G09
 *    只能报"找不到证据档"。计划逐字："缺证据…均拒收" ⇒ 不落盘的门在审查面上等于不存在。
 *    ⇒ 与其他门同形：`counts{measured,passed,failed,notRun}` + `sourceSnapshot` + `head`。
 */
const evidenceDir = resolve(
  `artifacts/post-lv2/postgresql-migration/pg-migration-g09-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`
)
mkdirSync(evidenceDir, { recursive: true })
writeFileSync(
  resolve(evidenceDir, 'g09-evidence.json'),
  JSON.stringify(
    {
      gate: 'postgresql:g09:verify',
      scope: 'PG-G09 量具有效性（规范化比较器 · 三段式：正控/负控/恢复）',
      atUtc: new Date().toISOString(),
      atUtc8: `${new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')} (UTC+8)`,
      head: (spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim(),
      container: CONTAINER,
      sourceSnapshot: SOURCE_SNAPSHOT,
      checks,
      notRun,
      counts: { measured, passed, failed, notRun: notRun.length },
    },
    null,
    2
  ),
  'utf8'
)
// 自证：写完之后**必须能解析**（与 `F-WP4` 那次的教训一致）
JSON.parse(readFileSync(resolve(evidenceDir, 'g09-evidence.json'), 'utf8'))
console.log(`  证据        : ${evidenceDir}`)

if (measured === 0) {
  console.error('measured_count = 0 ⇒ INVALID（不得当绿用）')
  process.exitCode = 1
} else if (failed > 0) {
  process.exitCode = 1
} else if (notRun.length > 0) {
  console.error(
    `\n${notRun.length} 项未运行 ⇒ 本门**不报 PASS**（关键断言缺证据 ⇒ 拒收）。\n` +
      '  这不是"通过"，也不是"失败"—— 它是"没量到"。要取得读数，先让前置条件成立。'
  )
  process.exitCode = 1
}
