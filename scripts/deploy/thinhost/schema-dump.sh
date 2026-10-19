#!/bin/bash
# 只读：dump Eliza 相关表的完整列定义（catalog 查询，不读业务数据）。
set -u
C=lg-postgresql-production
for T in agents entities rooms participants memories; do
  echo "=== $T ==="
  docker exec "$C" psql -U lg_bootstrap -d sumuwei -tAc "
    SELECT column_name||' | '||data_type||
           CASE WHEN is_nullable='NO' THEN ' | NOT NULL' ELSE '' END||
           CASE WHEN column_default IS NOT NULL THEN ' | def='||column_default ELSE '' END
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='$T'
    ORDER BY ordinal_position;"
done
echo "=== FK constraints pointing out of these tables ==="
docker exec "$C" psql -U lg_bootstrap -d sumuwei -tAc "
  SELECT conrelid::regclass::text||'.'||conname||' -> '||confrelid::regclass::text
  FROM pg_constraint
  WHERE contype='f' AND connamespace='public'::regnamespace
    AND (conrelid::regclass::text IN ('agents','entities','rooms','participants','memories'));"
