/**
 * 服务器仿真环境 · 生命周期控制（2026-10-20）
 *
 * ============================================================================
 *  给 agent 用的入口（一个命令一件事，别让 agent 记 docker 参数）
 * ============================================================================
 *  ```bash
 *  pnpm serversim:up        # 起仿真（先 prepare 配置，再 build，再 up，最后等就绪）
 *  pnpm serversim:down      # 停仿真（**默认保留数据库卷**）
 *  pnpm serversim:down -- --volumes   # 连仿真数据库卷一起删（会丢灌进去的数据）
 *  pnpm serversim:status    # 五个容器的状态 + supervisor 心跳
 *  pnpm serversim:build     # 只重建镜像（改了源码之后用）
 *  pnpm serversim:logs      # 跟日志（可加服务名：pnpm serversim:logs -- simhost）
 *  pnpm serversim:shell     # 进仿真主机（bash）
 *  ```
 *
 * ============================================================================
 *  ⚠️ 三条纪律
 * ============================================================================
 *  1. **永远不碰本机的生产容器**：本脚本只操作 compose 项目 `lg-serversim`。
 *     仿真用的卷叫 `lg-serversim-pgdata`，与生产的卷**不同名、不同物理卷**。
 *  2. `down` **不删卷**（数据是灌进去的，删了要重灌）。要删必须显式 `--volumes`。
 *  3. `up` 会先跑 `prepare`（重新生成配置）—— 所以 `up` 之后配置一定是最新的。
 * ============================================================================
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const COMPOSE = join(REPO, 'serversim', 'compose.yml')
const STATE_DIR = join(REPO, 'artifacts', 'serversim', 'local', 'state')
const args = process.argv.slice(2)
const command = args[0] ?? 'status'

function compose (composeArgs: string[], options: { input?: string } = {}): string {
  return execFileSync('docker', ['compose', '-f', COMPOSE, ...composeArgs], {
    cwd: REPO,
    encoding: 'utf8',
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  })
}

function run (label: string, commandArgs: string[]): void {
  console.log(`\n▸ ${label}`)
  /*
   * ⚠️ 这里**刻意不用** `shell: true`。
   *    仓库路径含空格（`…\Desktop\project LG\…`），shell 会把未加引号的
   *    `-f <compose.yml>` 拆成两个参数 ⇒ docker 收到
   *    `compose LG\serversim\compose.yml` ⇒ "unknown docker command"。
   *    实测踩过（2026-10-20）。改用 `shell: false` + 显式可执行文件。
   *
   * ⚠️ `pnpm` 在 Windows 上是 `pnpm.cmd`（批处理）：Node 自 CVE-2024-27980
   *    修复起**禁止**在 `shell: false` 下直接 spawn `.cmd`/`.bat`
   *    （抛 `EINVAL`）。实测踩过（2026-10-20）。
   *    ⇒ pnpm 走 `cmd.exe /d /c pnpm …`；参数都是简单形态，不会被 cmd 拆坏。
   */
  const [executable, ...rest] = commandArgs
  const useCmd = process.platform === 'win32' && executable === 'pnpm'
  const file = useCmd ? (process.env.ComSpec ?? 'cmd.exe') : executable
  const args = useCmd ? ['/d', '/c', 'pnpm', ...rest] : rest
  const result = spawnSync(file!, args, { cwd: REPO, stdio: 'inherit', shell: false })
  if (result.error !== undefined) {
    console.error(`\n❌ ${label} 失败：${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`\n❌ ${label} 失败（退出码 ${String(result.status)}）`)
    process.exit(result.status ?? 1)
  }
}

/**
 * 服务器口径的 schema 版本。
 * ⚠️ **从 `server-spec.json` 读**，不在这里写第二份。
 *    第一版这里硬编码了 `22`，而仓库当时已经到 23 —— 后果是
 *    "schema 已经是 22 时就跳过迁移，留下 1 条待应用"，而核心的迁移闸
 *    会因此拒绝启动（实测暴露于 2026-10-20 冷启动日志：
 *    「仿真库 schema = v0，落后于当前 **v22** ⇒ 补齐」——那句话本身就打错了）。
 */
function expectedSchemaVersion (): number {
  try {
    const spec = JSON.parse(readFileSync(join(REPO, 'serversim', 'server-spec.json'), 'utf8')) as {
      services?: { postgresql?: { schemaVersion?: number } }
    }
    const value = spec.services?.postgresql?.schemaVersion
    return typeof value === 'number' ? value : 0
  } catch {
    return 0
  }
}

/** 仿真库当前的 schema 版本（读不到 ⇒ 0，并**大声说明**） */
function currentSchemaVersion (): number {
  try {
    /*
     * ⚠️ 必须带 `-e PGPASSWORD=…`，且用**应用角色** `lg_migrate`：
     *    它走 TCP 连接要口令。
     *    第一版写的是 `-U lg_simu`（早期设计的角色，早已不存在）+ 没给口令
     *    ⇒ psql 认证失败 ⇒ 被 `catch` 吞成 `0`
     *    ⇒ 表现为"明明已是 v23，`up` 却报 v0 并重跑迁移"（实测 2026-10-20）。
     */
    const out = compose(['exec', '-T', '-e', 'PGPASSWORD=lg_migrate_local_only', 'pg', 'psql',
      '-h', '127.0.0.1', '-p', '5432', '-U', 'lg_migrate', '-d', 'sumuwei', '-tAc',
      'select coalesce(max(version),0) from character_schema_migrations']).trim()
    const value = Number(out)
    return Number.isFinite(value) ? value : 0
  } catch (error) {
    // 读不到就是读不到：不猜、不把"读不到"当成"库是新的"
    console.error(`⚠️ 读不到仿真库的 schema 版本：${(error as Error).message.slice(0, 160)}`)
    return 0
  }
}

/**
 * 运维序列：**停核心 → 迁移 → 起核心**（与服务器上同形）。
 *
 * ⚠️ 为什么要停：核心持有 PGlite 的**租约**（同一时刻只允许一个访问者），
 *    迁移要在同一个目录上拿租约 ⇒ 核心必须先**有序退出**（SIGINT）放掉租约。
 *    supervisor 默认 10 秒后会把核心拉回来 ⇒ 用**暂停哨兵**挡住。
 */
function migrateSequence (): void {
  const inHost = (script: string): string => compose(['exec', '-T', 'simhost', 'bash', '-lc', script])
  inHost('mkdir -p /opt/serversim/state && touch /opt/serversim/state/pause')
  console.log('\n▸ 已请求暂停（监督器会给整个进程组发 SIGINT 有序停机）')
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    /*
     * ⚠️ 必须等**核心**（`src/main.ts`）真的退出，**不能**只看外壳。
     *    持 PGlite 租约的是**核心**（外壳不开库）；外壳先退出、核心还在收尾时，
     *    迁移会拿到 `production_db_in_use` —— 实测踩过（2026-10-20）。
     */
    const remaining = inHost('pgrep -f "[s]rc/main.ts" | wc -l').trim()
    const shellAlive = inHost('pgrep -f "[s]cripts/qq/chat.ts" | wc -l').trim()
    if (remaining === '0' && shellAlive === '0') break
    execFileSync(process.platform === 'win32' ? 'powershell' : 'sleep', process.platform === 'win32' ? ['-Command', 'Start-Sleep -Seconds 2'] : ['2'], { stdio: 'ignore' })
  }
  const leftover = inHost('pgrep -f "[s]rc/main.ts" | wc -l').trim()
  if (leftover !== '0') {
    /*
     * ⚠️ 兜底：如果核心在 180 秒后仍在，**强制**清掉它再迁移。
     *
     * 什么时候会发生（实测 2026-10-20）：暂停信号正好落在核心**启动中**
     * （runtime 还没建完）⇒ 它的有序收尾路径本身也在等自己 ⇒ 拖过 180 秒。
     * 这时它**通常还没拿到 PGlite 租约**，所以迁移往往仍能成功；
     * 但"往往"不是判据 ⇒ 这里显式清场，让迁移确定性成立。
     *
     * ⚠️ 这是**最后手段**：正常路径是 SIGINT 有序停机（与服务器上的
     *    `KillSignal=SIGINT` 同义）。SIGKILL 会跳过收尾 —— 只在超时后用。
     */
    console.log(`▸ 核心在 180s 后仍在运行（${leftover} 个）—— 强制清场（SIGKILL 进程组）`)
    /*
     * ⚠️ 用 `[s]rc/main.ts` 而不是 `src/main.ts`：
     *    `pkill -f` 会匹配**执行它的那个 shell 自己**的命令行
     *    （`bash -lc pkill -KILL -f "src/main.ts"` 里就含这串字符）
     *    ⇒ pkill 自杀 ⇒ exec 返回 137。
     *    实测踩过（2026-10-20）。方括号让命令行里的字面量不再匹配该正则。
     */
    inHost('pkill -KILL -f "[s]rc/main.ts" || true; pkill -KILL -f "[s]cripts/qq/chat.ts" || true')
    execFileSync(process.platform === 'win32' ? 'powershell' : 'sleep', process.platform === 'win32' ? ['-Command', 'Start-Sleep -Seconds 3'] : ['3'], { stdio: 'ignore' })
  }
  console.log('▸ 外壳与核心都已退出，租约已放掉')
  try {
    run('在仿真库上应用迁移', ['docker', 'compose', '-f', COMPOSE, 'exec', '-T', 'simhost', 'bash', '-lc', 'pnpm migrate:apply'])
  } finally {
    inHost('rm -f /opt/serversim/state/pause')
    console.log('▸ 已解除暂停（监督器会把核心拉回来）')
  }
}

switch (command) {
  case 'up': {
    run('准备服务器形状的配置', ['pnpm', 'serversim:prepare'])
    run('构建仿真主机镜像', ['docker', 'compose', '-f', COMPOSE, 'build', 'simhost'])
    run('启动仿真栈', ['docker', 'compose', '-f', COMPOSE, 'up', '-d'])
    console.log('\n▸ 等待容器就绪（最多 180 秒）…')
    const deadline = Date.now() + 180_000
    let ready = false
    while (Date.now() < deadline) {
      try {
        /*
         * ⚠️ `docker compose ps --format json` 在 Compose v5 里是**逐行一个 JSON 对象**
         *    （不是 JSON 数组）。实测踩过（2026-10-20）：按数组解析会抛，
         *    而异常被 catch 吞掉 ⇒ 就绪判据永远不成立 ⇒ 白等 180 秒。
         *    ⇒ 两种形状都认。
         */
        const ps = compose(['ps', '--format', 'json']).trim()
        let services: Array<{ Service?: string; State?: string; Health?: string }> = []
        if (ps.startsWith('[')) {
          services = JSON.parse(ps) as typeof services
        } else {
          services = ps.split(/\r?\n/).filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line) as { Service?: string; State?: string; Health?: string })
        }
        const running = services.filter(s => s.State === 'running')
        const unhealthy = services.filter(s => s.Health === 'unhealthy')
        if (running.length >= 5 && unhealthy.length === 0) { ready = true; break }
      } catch (error) {
        console.log(`  （就绪判据暂时读不到：${(error as Error).message.slice(0, 80)}）`)
      }
      execFileSync(process.platform === 'win32' ? 'powershell' : 'sleep', process.platform === 'win32' ? ['-Command', 'Start-Sleep -Seconds 3'] : ['3'], { stdio: 'ignore' })
    }
    if (!ready) {
      console.error('\n⚠️ 180 秒内没有全部就绪 —— 如实报告，不假装成功。')
      console.error('   看日志：pnpm serversim:logs')
      process.exit(1)
    }
    console.log('\n✅ 仿真栈已就绪')
    console.log('   · PostgreSQL   127.0.0.1:55433  （仿真内 127.0.0.1:55432，与服务器同址）')
    console.log('   · 假 OneBot    127.0.0.1:6702   （仿真内 127.0.0.1:6701）')
    console.log('   · 控制面       127.0.0.1:6102   （注入消息 / 读回回复）')
    console.log('   · 假微信桥     127.0.0.1:16175')
    console.log('   · 假模型端点   127.0.0.1:18080')
    // schema 落后就补齐：核心有**迁移闸**（10-15 §6.3）⇒ 不补就起不来。
    // ① 建库（第一次才有活；已有则只读回）
    run('按生产流程建库', ['pnpm', 'serversim:dbinit'])
    // ② schema 落后就补齐：核心有**迁移闸**（10-15 §6.3）⇒ 不补就起不来。
    const schema = currentSchemaVersion()
    const expected = expectedSchemaVersion()
    if (expected === 0) {
      console.error('⚠️ 读不到 serversim/server-spec.json 里的 schemaVersion —— 跳过自动补齐（不猜）')
    } else if (schema < expected) {
      console.log(`\n▸ 仿真库 schema = v${String(schema)}，落后于服务器口径 v${String(expected)} ⇒ 补齐`)
      migrateSequence()
    } else {
      console.log(`\n   仿真库 schema 已是 v${String(schema)}（服务器口径 v${String(expected)}）`)
    }
    console.log('\n   下一步：pnpm serversim:preflight   （核对仿真与服务器画像是否同形）')
    break
  }

  case 'down': {
    const withVolumes = args.includes('--volumes')
    run('停止仿真栈', ['docker', 'compose', '-f', COMPOSE, 'down', ...(withVolumes ? ['--volumes'] : [])])
    console.log(withVolumes
      ? '\n⚠️ 仿真数据库卷已删除 —— 灌进去的数据没了（要重来：pnpm serversim:seed）。'
      : '\n✅ 仿真栈已停（数据库卷保留）。')
    break
  }

  case 'build': {
    run('重建仿真主机镜像', ['docker', 'compose', '-f', COMPOSE, 'build', 'simhost'])
    console.log('\n提示：重建后要重启才生效：pnpm serversim:down && pnpm serversim:up')
    break
  }

  case 'status': {
    try {
      console.log(compose(['ps']))
    } catch (error) {
      console.error(`读不到状态：${(error as Error).message}`)
      process.exit(1)
    }
    const heartbeatPath = '/opt/serversim/state/heartbeat.json'
    try {
      const hb = compose(['exec', '-T', 'simhost', 'bash', '-lc', `cat ${heartbeatPath} 2>/dev/null || echo MISSING`]).trim()
      console.log(`\nsupervisor 心跳：${hb}`)
    } catch {
      console.log('\nsupervisor 心跳：读不到（容器可能没起来）')
    }
    const statePath = join(STATE_DIR, 'production-baseline.json')
    if (existsSync(statePath)) {
      console.log(`生产容器基线：${readFileSync(statePath, 'utf8').replace(/\s+/g, ' ')}`)
    }
    break
  }

  case 'logs': {
    const service = args[1]
    run('跟随日志', ['docker', 'compose', '-f', COMPOSE, 'logs', '-f', '--tail', '100', ...(service === undefined ? [] : [service])])
    break
  }

  case 'shell': {
    run('进入仿真主机', ['docker', 'compose', '-f', COMPOSE, 'exec', 'simhost', 'bash'])
    break
  }

  case 'dbinit': {
    run('按生产流程建库（复用仓库的 010-roles.sql 与 create-production-db.sql）',
      ['pnpm', 'serversim:dbinit'])
    break
  }

  case 'migrate': {
    /*
     * 在仿真里把 schema 建起来。
     *
     * ⚠️ 为什么必须有这一条：核心启动前会检查"有没有待应用的迁移"，
     *    有就**拒绝启动**并提示跑 `pnpm migrate`（10-15 §6.3）。
     *    仿真库是空的 ⇒ 必然有 23 条待应用 ⇒ 核心起不来。
     *    ⇒ 这不是绕开保护，这是**按保护要求的形状**把 schema 补齐。
     */
    migrateSequence()
    console.log('\n✅ 仿真库 schema 已到当前版本。')
    break
  }

  case 'gates': {
    /*
     * 在**仿真里**跑仓库自己的门。
     *
     * ⚠️ 为什么要专门有这一条：仓库里很多门是在 Windows 上跑绿的，
     *    而"本机过了服务器炸"正是本仿真要拦的那类问题。
     *    同一道门在 Linux 容器里再跑一次，是最直接的对照。
     *
     * ⚠️ **默认钉 PGlite 后端**（`--pg` 才用 PG）。理由不是偏好，是仓库自己的约定：
     *    门的 `isolateDatabase()` 只能隔离 **PGlite 的数据目录**；对 PostgreSQL
     *    它**失败关闭**（`postgres_isolation_not_provided`）。而仿真的 `.env` 是
     *    `CHARACTER_DB_BACKEND=postgres` ⇒ 直接跑会撞上这条，**与本机撞的是同一条**
     *    （实测 2026-10-20：仿真与本机都在 `verify-phase-c.ts` 上
     *    `postgres_isolation_not_provided`；仓库已把它登记为**既有基线**，
     *    见 docs/Tech-Debt-Register.md:2600 与 docs/post-lv2/Lv25-Retirement-2026-10-20.md:32）。
     *
     * ⚠️ **`DOTENV_CONFIG_PATH` 也不够**：`src/db/index.ts` 会在开库前
     *    **自己重读 `<cwd>/.env`**（仓库注释里明写过这件事）。
     *    ⇒ 真正的"无 `.env` 的 cwd"只能**把文件挪开**。
     *    这里用 `trap … EXIT` 保证一定挪回来；就算进程被杀，
     *    entrypoint 每次容器启动都会从只读挂载重新拷贝 `.env`，会自愈。
     */
    const usePg = args.includes('--pg')
    const gate = args.slice(1).filter(a => a !== '--pg').join(' ') || 'typecheck'
    const command = usePg
      ? `pnpm ${gate}`
      : [
          'set -e',
          'cd /opt/project-lg',
          'restore() { [ -f .env.serversim-hidden ] && mv -f .env.serversim-hidden .env; }',
          'trap restore EXIT',
          'mv -f .env .env.serversim-hidden',
          `env -u POSTGRES_URL -u DATABASE_URL -u LG_PG_EXPECT_DATABASE -u LG_PG_EXPECT_USER -u LG_PG_CONTAINER -u LG_PG_EXPECT_DATABASE_PREFIX -u LG_PG_EXPECT_USER_PREFIX -u PGLITE_SNAPSHOT_DIR CHARACTER_DB_BACKEND=pglite pnpm ${gate}`,
        ].join(' && ')
    run(`在仿真里跑 ${gate}${usePg ? '（PG 后端）' : '（PGlite 隔离，仓库约定）'}`,
      ['docker', 'compose', '-f', COMPOSE, 'exec', '-T', 'simhost', 'bash', '-lc', command])
    break
  }

  default:
    console.error(`未知命令：${command}`)
    console.error('可用：up / down / build / status / logs / shell')
    process.exit(2)
}
