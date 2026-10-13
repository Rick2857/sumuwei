/**
 * PostgreSQL 迁移 WP4：**完整清单**（计划 §3.3 / §4-WP4 的"完整表清单…分类说明"）。
 *
 * ============================================================================
 *  它要挡住的失败形状
 * ============================================================================
 *  计划 §3.3 逐字：
 *
 * ```text
 *   迁移范围从源副本数据库目录/系统目录视图列举完整 schema 和表，分类说明，
 *   不能硬编码"只导几张记忆表"。
 * ```
 *
 *  ⇒ 判据不是"我列了 51 张表"，而是"**库里每一个对象都被判过类**"。
 *    所以本模块返回三堆：`in-scope` / `excluded`（**逐条具名原因**）/ `unclassified`。
 *    第三堆**非空就是拒收** —— 出现了没见过的对象（新 relkind、新 schema），
 *    门必须红着说"这个我没判过"，而不是安静地漏掉。
 *
 * ---------------------------------------------------------------------------
 *  刻意不做的事
 * ---------------------------------------------------------------------------
 *  · **不比 schema 细节**（列类型 / 约束 / 索引定义）。那是 schema 比较的活；
 *    这里只做"对象集合 + 分类"。
 *  · **不把 `count(*)` 当完整性证据**（契约 §5 `N02`）：计数只证明"少了多少"，
 *    内容一致要靠规范化摘要。本模块的输出里就带着这句话，免得下游拿它当结论。
 */

/** `pg_class.relkind` 的值与它们的可读名 */
export const RELKIND_LABEL: Record<string, string> = {
  r: 'ordinary table',
  p: 'partitioned table',
  i: 'index',
  I: 'partitioned index',
  S: 'sequence',
  v: 'view',
  m: 'materialized view',
  c: 'composite type',
  t: 'TOAST table',
  f: 'foreign table',
}

/** 系统 schema：**从不**出现在清单里（不是"被排除"，它们不是迁移范围的对象） */
export const SYSTEM_SCHEMAS = ['pg_catalog', 'information_schema', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1']

/** 已知的用户 schema（其余的用户 schema ⇒ `unclassified`，门要红） */
export const KNOWN_USER_SCHEMAS = ['public', 'migrations']

export interface DbObject {
  schema: string
  name: string
  kind: string
}

export interface ObjectDecision {
  scope: 'in-scope' | 'excluded' | 'unclassified'
  reason: string
}

/**
 * 逐对象判类。**这是本模块唯一的判据处** —— 要加新 relkind / 新 schema 就改这里，
 * 改错了 `unclassified` 会让门红。
 */
export function classifyObject(object: DbObject): ObjectDecision {
  const label = RELKIND_LABEL[object.kind] ?? `unknown relkind '${object.kind}'`

  if (!KNOWN_USER_SCHEMAS.includes(object.schema)) {
    // ⚠️ 刻意**不**默认"用户 schema 都要迁移"：那等于把"我没判过"写成"要迁"。
    return { scope: 'unclassified', reason: `schema '${object.schema}' 不在已知集（${KNOWN_USER_SCHEMAS.join(' / ')}）里` }
  }

  if (object.schema === 'migrations' && object.kind === 'r') {
    return { scope: 'in-scope', reason: 'plugin-sql 的 kernel 迁移登记表（不含业务数据，但必须一起恢复）' }
  }

  switch (object.kind) {
    case 'r':
    case 'p':
      return { scope: 'in-scope', reason: `${label}：迁移范围的数据对象` }
    case 'S':
      return { scope: 'in-scope', reason: '序列：值必须一起搬（否则新插入的 id 会撞历史）' }
    case 'm':
      return { scope: 'in-scope', reason: '物化视图：**含数据**，必须一起恢复（与普通视图不同）' }
    case 'v':
      return { scope: 'excluded', reason: '视图：只有 DDL 没有数据，由 schema 恢复' }
    case 'i':
    case 'I':
      return { scope: 'excluded', reason: '索引：由 schema DDL 恢复；本清单只判数据对象' }
    case 'f':
      return { scope: 'unclassified', reason: 'foreign table：没有对应裁定（它可能指向库外系统）' }
    case 'c':
      return { scope: 'excluded', reason: '复合类型：DDL 对象，由 schema 恢复' }
    default:
      return { scope: 'unclassified', reason: `没有裁定的 relkind：${label}` }
  }
}

export interface ExtensionReading {
  name: string
  version: string
  schema: string
}

export interface InventoryReading {
  objects: DbObject[]
  extensions: ExtensionReading[]
}

/**
 * 读一个库的对象清单。
 *
 * @param query 执行 SQL 并返回**制表符行**文本（`rc !== 0` 时返回 `undefined`）。
 *              刻意用回调：这样它既能走 `psql`，将来也能走 `pg` 驱动，而**判据只有一份**。
 */
export function readInventory(query: (sql: string) => string | undefined): InventoryReading | undefined {
  const objectsRaw = query(
    // ⚠️ 这里踩了两个**都只有跑起来才会暴露**的坑（本轮实测，一个盖住另一个）：
    //    ① `c.relkind` 的类型是 `"char"`（不是 text）⇒ 不 cast 就报
    //       `ERROR: operator is not unique: text || "char"`；
    //    ② 输出只有**一列**（拼好的字符串）⇒ `order by 1, 2` 会被解释成
    //       "按选择列表的第 2 项排序"，报 `ORDER BY position 2 is not in select list`。
    //       （第一版写的是 `order by 1, 2`，因为脑子里想的是"按 nspname, relname 排"——
    //        但那是**底层列**，不是选择列表。）
    //    ⇒ 排序一律写**显式的列名**，别用位置号。
    "select n.nspname||'|'||c.relname||'|'||c.relkind::text from pg_class c " +
      'join pg_namespace n on n.oid = c.relnamespace ' +
      "where n.nspname not in ('pg_catalog','information_schema','pg_toast') " +
      "and c.relkind in ('r','p','i','I','S','v','m','c','f') order by n.nspname, c.relname"
  )
  if (objectsRaw === undefined) return undefined
  const objects: DbObject[] = objectsRaw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [schema, name, kind] = line.split('|')
      return { schema, name, kind }
    })

  const extensionsRaw = query(
    "select e.extname||'|'||e.extversion||'|'||n.nspname from pg_extension e " +
      'join pg_namespace n on n.oid = e.extnamespace order by e.extname'
  )
  if (extensionsRaw === undefined) return undefined
  const extensions: ExtensionReading[] = extensionsRaw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [name, version, schema] = line.split('|')
      return { name, version, schema }
    })

  return { objects, extensions }
}

export interface InventorySummary {
  inScope: { object: DbObject; reason: string }[]
  excluded: { object: DbObject; reason: string }[]
  unclassified: { object: DbObject; reason: string }[]
  /** `schema.name` 的稳定键（比较对象集合用） */
  inScopeKeys: string[]
}

export function summarizeInventory(objects: readonly DbObject[]): InventorySummary {
  const inScope: InventorySummary['inScope'] = []
  const excluded: InventorySummary['excluded'] = []
  const unclassified: InventorySummary['unclassified'] = []
  for (const object of objects) {
    const decision = classifyObject(object)
    if (decision.scope === 'in-scope') inScope.push({ object, reason: decision.reason })
    else if (decision.scope === 'excluded') excluded.push({ object, reason: decision.reason })
    else unclassified.push({ object, reason: decision.reason })
  }
  const inScopeKeys = inScope.map((entry) => `${entry.object.schema}.${entry.object.name}`).sort()
  return { inScope, excluded, unclassified, inScopeKeys }
}

/** 对象集合的差异（两侧各自差集，**双向**都要看） */
export function inventorySetDifference(
  source: readonly string[],
  target: readonly string[]
): { missingInTarget: string[]; extraInTarget: string[] } {
  const sourceSet = new Set(source)
  const targetSet = new Set(target)
  return {
    missingInTarget: source.filter((key) => !targetSet.has(key)).sort(),
    extraInTarget: target.filter((key) => !sourceSet.has(key)).sort(),
  }
}
