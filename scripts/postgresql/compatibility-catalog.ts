import type pg from 'pg'

/** Same catalog fields for upstream baseline and LG migration acceptance. */
export async function compatibilityCatalog(pool: pg.Pool) {
  const names = ['agents', 'entities', 'worlds', 'rooms', 'participants', 'memories']
  const tables = []
  for (const name of names) {
    const columns = (await pool.query(`select a.attname as name, format_type(a.atttypid,a.atttypmod) as type,
      a.attnotnull as not_null, pg_get_expr(d.adbin,d.adrelid) as default
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
      where n.nspname='public' and c.relname=$1 and a.attnum>0 and not a.attisdropped order by a.attnum`, [name])).rows
    const constraints = (await pool.query(`select conname as name, pg_get_constraintdef(oid) as definition
      from pg_constraint where conrelid=$1::regclass order by conname`, [`public.${name}`])).rows
    const indexes = (await pool.query(`select indexname as name,indexdef as definition from pg_indexes
      where schemaname='public' and tablename=$1 order by indexname`, [name])).rows
    const triggers = (await pool.query(`select tgname as name, pg_get_triggerdef(oid) as definition from pg_trigger
      where tgrelid=$1::regclass and not tgisinternal order by tgname`, [`public.${name}`])).rows
    tables.push({ name, columns, constraints, indexes, triggers })
  }
  return tables
}
