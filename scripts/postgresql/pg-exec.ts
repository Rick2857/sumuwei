/**
 * PostgreSQL 迁移：**在试验容器里执行 SQL / pg_dump 的唯一一处**。
 *
 * ============================================================================
 *  为什么要有这个模块
 * ============================================================================
 *  `PG-G02` / `PG-G03` / `PG-G09` 各自抄了一份 `psql()`。抄第二遍的时候它还是无害的，
 *  但 `PG-G07`（在线备份）需要**更多**的东西：`pg_dump`（输出 11 MB，**不能走内存缓冲**）、
 *  把 11 MB 的 SQL **灌进** `psql`、读容器里的对象清单。再抄一遍就会出现
 *  "某一处漏了 `ON_ERROR_STOP`"这种**只有出事那天才发现**的偏差 ——
 *  本仓库对这种形状的既有处置是**收在一处**。
 *
 *  ⚠️ 本模块**只新增**：`PG-G02/G03/G09` 那三份**本轮一字未动**（它们是绿的，动它们要有理由）。
 *     三处重复已作为 `L-PGW4-07` 登记在册，交下一轮或维护线收敛。
 *
 * ---------------------------------------------------------------------------
 *  四条刻意的设计
 * ---------------------------------------------------------------------------
 *  ① **凭据走 `credentials.ts`**（剥 BOM + 不给 key 兜底），本模块不做任何凭据解析。
 *  ② **pg_dump 直接写文件描述符**：`spawnSync` 的默认 `maxBuffer` 是 1 MiB，
 *     11 MB 的 dump 会**失败或截断**；重定向到 fd 则完全不经过内存。
 *  ③ **恢复走 stdin**（`psqlFromStdin`）：11 MB 的 SQL 从宿主进程喂进 `psql`。
 *     ⚠️ 实测过：**容器里没有仓库的 `artifacts/`** —— compose 的 `.:/opt/lg:ro`
 *     里那个 `.` 是**compose 文件所在目录**（即 `scripts/postgresql/`），
 *     不是仓库根。所以"把 dump 放本地再由容器 `-f` 读"这条路**不存在**；
 *     同时也解释了为什么各门的脚本路径是 `/opt/lg/create-test-db.sql`
 *     而**不是** `/opt/lg/scripts/postgresql/create-test-db.sql`。
 *  ④ 每个函数都返回 `{ rc, out, err }` —— 调用方**必须自己看 rc**。
 *     本模块**不**"失败就抛"，因为门的判据要的是"如实记下退出码"，
 *     抛异常会把退出码变成一句错误消息（就丢掉了判据的形状）。
 */

import { spawnSync, type SpawnSyncOptions } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'

/** 逐条命令的结果形状（门的 §2⑤ 要的 "commands + exit codes"） */
export interface ExecResult {
  rc: number
  out: string
  err: string
  /** 实际执行的命令（**已脱敏**：不含密码；密码只经环境变量） */
  command: string
}

/** 一次性 SQL 执行（`-tAc`，`ON_ERROR_STOP=1`）。适合小结果集。 */
export function psql(options: {
  container: string
  user: string
  password: string
  database: string
  sql: string
  timeoutMs?: number
}): ExecResult {
  const args = [
    'exec', '-e', 'PGPASSWORD', options.container,
    'psql', '-h', '127.0.0.1', '-U', options.user, '-d', options.database,
    '-v', 'ON_ERROR_STOP=1', '-tAc', options.sql,
  ]
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: options.password },
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    rc: result.status ?? -1,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
    command: `docker exec -e PGPASSWORD <redacted> ${options.container} psql -h 127.0.0.1 -U ${options.user} -d ${options.database} -v ON_ERROR_STOP=1 -tAc ${JSON.stringify(options.sql.slice(0, 160))}`,
  }
}

/**
 * 把一段 SQL **从 stdin** 灌进 `psql` 执行（整库恢复用这条）。
 *
 * ⚠️ 用 stdin 而不是"把文件放进容器"：容器里只挂了 `scripts/postgresql/`（见文件头 ③），
 *    而备份文件含私人历史，**不该**进源码树。
 */
export function psqlFromStdin(options: {
  container: string
  user: string
  password: string
  database: string
  sql: string
  timeoutMs?: number
  /** 覆盖尾部的 psql 参数（缺省 `['-q']`）。例如测量会话要 `['-tA']` 才看得到 `\timing` 输出。 */
  psqlArgs?: string[]
}): ExecResult {
  const tail = options.psqlArgs ?? ['-q']
  const result = spawnSync(
    'docker',
    [
      'exec', '-i', '-e', 'PGPASSWORD', options.container,
      'psql', '-h', '127.0.0.1', '-U', options.user, '-d', options.database,
      '-v', 'ON_ERROR_STOP=1', ...tail,
    ],
    {
      input: options.sql,
      encoding: 'utf8',
      env: { ...process.env, PGPASSWORD: options.password },
      timeout: options.timeoutMs ?? 900_000,
      maxBuffer: 256 * 1024 * 1024,
    }
  )
  return {
    rc: result.status ?? -1,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
    command: `docker exec -i -e PGPASSWORD <redacted> ${options.container} psql -h 127.0.0.1 -U ${options.user} -d ${options.database} -v ON_ERROR_STOP=1 ${tail.join(' ')} < ${options.sql.length} 字节的 SQL`,
  }
}

/** 执行容器内**已挂载**的脚本（`-f`）。挂载点是只读的 `/opt/lg`（= `scripts/postgresql/`）。 */
export function psqlFile(options: {
  container: string
  user: string
  password: string
  database: string
  /** 容器内路径，例如 `/opt/lg/create-test-db.sql`（注意：**不含** `scripts/postgresql/`） */
  file: string
  variables?: Record<string, string>
  timeoutMs?: number
}): ExecResult {
  const args = ['exec', '-e', 'PGPASSWORD']
  for (const [key, value] of Object.entries(options.variables ?? {})) args.push('-e', `${key}=${value}`)
  args.push(
    options.container,
    'psql', '-h', '127.0.0.1', '-U', options.user, '-d', options.database,
    '-v', 'ON_ERROR_STOP=1', '-f', options.file
  )
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: options.password },
    timeout: options.timeoutMs ?? 300_000,
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    rc: result.status ?? -1,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
    command: `docker exec -e PGPASSWORD <redacted> ${options.container} psql -h 127.0.0.1 -U ${options.user} -d ${options.database} -v ON_ERROR_STOP=1 -f ${options.file}`,
  }
}

/**
 * `pg_dump` 到文件（**同步**）。
 *
 * ⚠️ **stdout 直接接文件描述符**（见文件头 ②）：11 MB 的 dump 走 `maxBuffer` 会在
 *    1 MiB 处**失败**，而"失败"与"导出成功但被截断"在判据上必须能分开 ——
 *    唯一稳的做法是不经内存。stderr 仍然收（要看 ERROR / WARNING）。
 *
 * ⚠️ "在线"备份（备份期间要并发观察）不能用这个同步版本 —— 见门里的异步分支。
 */
export function pgDumpToFile(options: {
  container: string
  user: string
  password: string
  database: string
  outFile: string
  args?: string[]
  timeoutMs?: number
}): ExecResult {
  const dumpArgs = options.args ?? []
  const fd = openSync(options.outFile, 'w')
  let result
  try {
    result = spawnSync(
      'docker',
      [
        'exec', '-e', 'PGPASSWORD', options.container,
        'pg_dump', '-h', '127.0.0.1', '-U', options.user, '-d', options.database,
        ...dumpArgs,
      ],
      {
        env: { ...process.env, PGPASSWORD: options.password },
        stdio: ['ignore', fd, 'pipe'],
        encoding: 'utf8',
        timeout: options.timeoutMs ?? 900_000,
      } as SpawnSyncOptions
    )
  } finally {
    closeSync(fd)
  }
  return {
    rc: result.status ?? -1,
    out: '',
    err: typeof result.stderr === 'string' ? result.stderr.trim() : '',
    command: `docker exec -e PGPASSWORD <redacted> ${options.container} pg_dump -h 127.0.0.1 -U ${options.user} -d ${options.database} ${dumpArgs.join(' ')} > ${options.outFile}`,
  }
}

/** 容器内命令（不连数据库；用于 `pg_dump --version` 之类只读探测） */
export function dockerExec(options: {
  container: string
  argv: string[]
  timeoutMs?: number
}): ExecResult {
  const result = spawnSync('docker', ['exec', options.container, ...options.argv], {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    rc: result.status ?? -1,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
    command: `docker exec ${options.container} ${options.argv.join(' ')}`,
  }
}

/** 源/目标身份读数（**连接后读回来的**，不是配置声明的 —— 契约 §5 `N04`） */
export interface PgIdentity {
  database: string
  user: string
  host: string
  port: string
  serverVersion: string
  vectorVersion: string | null
}

export function readIdentity(options: {
  container: string
  user: string
  password: string
  database: string
}): PgIdentity | undefined {
  const r = psql({
    ...options,
    sql:
      "select current_database()||'|'||current_user||'|'||coalesce(inet_server_addr()::text,'local')||'|'" +
      "||inet_server_port()::text||'|'||current_setting('server_version')||'|'" +
      "||coalesce((select extversion from pg_extension where extname='vector'),'(none)')",
  })
  if (r.rc !== 0) return undefined
  const [database, user, host, port, serverVersion, vectorVersion] = r.out.split('|')
  return { database, user, host, port, serverVersion, vectorVersion: vectorVersion === '(none)' ? null : vectorVersion }
}
