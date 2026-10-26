// ============================================================================
//  服务器仿真环境 · 环回转发器（2026-10-20）
// ============================================================================
//
//  它做什么
//  ============================================================================
//  在仿真主机里开若干个 **127.0.0.1** 监听，把流量转到 compose 网络上的
//  兄弟容器：
//
//    127.0.0.1:55432 → pg:5432          （PostgreSQL）
//    127.0.0.1:6701  → onebot:6701      （OneBot v11 正向 WS）
//    127.0.0.1:6101  → onebot:6101      （控制面）
//    127.0.0.1:16174 → wechat:16174     （微信桥 API）
//    127.0.0.1:18080 → model:18080      （模型端点）
//
//  ============================================================================
//  为什么不是 `network_mode: service:simhost`
//  ============================================================================
//  原设计是让四个 sidecar **共享 simhost 的网络命名空间**，那样它们天然就在
//  127.0.0.1 上。**实测在这台机器的 Docker Desktop 上它不成立**：
//
//    simhost netns: net:[4026532665]
//    pg/onebot netns: net:[4026532553]   ← 三个 sidecar 抱团在**另一个** netns
//    ⇒ simhost → 127.0.0.1:6701 = Connection refused
//    ⇒ 宿主机 → 发布的 55433 也连不上
//
//  而这个失败**极其隐蔽**：容器全在跑、健康检查全绿、日志里只有一句
//  "Failed query"，很容易被误读成"数据库配错了"。
//
//  ⇒ 换成**显式转发**：地址同形靠转发器保证，不靠命名空间的隐式语义。
//     代价是多一跳本地 TCP（< 1 ms），换来的是**可靠**。
//
//  ============================================================================
//  与服务器拓扑的对应关系
// ============================================================================
//  服务器上：宿主机 127.0.0.1:55432 → （docker 端口映射）→ PG 容器 5432
//  仿真里：仿真主机 127.0.0.1:55432 → （本转发器）→ PG 容器 5432
//  ⇒ 对**核心**而言完全同形：它只看见 127.0.0.1:55432。
// ============================================================================

import { createConnection, createServer } from 'node:net'

/** 形如 "55432=pg:5432,6701=onebot:6701" */
const SPEC = process.env.SIM_FORWARDS
  ?? '55432=pg:5432,6701=onebot:6701,6101=onebot:6101,16174=wechat:16174,18080=model:18080'

const log = (event, extra = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), component: 'serversim-forwarder', event, ...extra }))

const forwards = []
for (const piece of SPEC.split(',').map(s => s.trim()).filter(Boolean)) {
  const [listenRaw, target] = piece.split('=')
  if (listenRaw === undefined || target === undefined) continue
  const listen = Number(listenRaw)
  const [host, portRaw] = target.split(':')
  const port = Number(portRaw)
  if (!Number.isSafeInteger(listen) || host === undefined || !Number.isSafeInteger(port)) {
    log('invalid_forward', { piece })
    continue
  }
  forwards.push({ listen, host, port })
}

for (const forward of forwards) {
  const server = createServer(client => {
    const socket = createConnection({ host: forward.host, port: forward.port }, () => {
      client.pipe(socket)
      socket.pipe(client)
    })
    socket.on('error', (error) => {
      log('upstream_failed', { listen: forward.listen, target: `${forward.host}:${String(forward.port)}`, message: error.message })
      client.destroy()
    })
    client.on('error', () => { socket.destroy() })
    client.on('close', () => { socket.destroy() })
  })
  server.on('error', (error) => { log('listen_failed', { listen: forward.listen, message: error.message }) })
  /*
   * ⚠️ 必须绑 **0.0.0.0**，不能只绑 127.0.0.1。
   *    宿主机侧的端口映射（127.0.0.1:6102 → 容器 6101）是**从容器外**连进来的，
   *    连的是容器的 eth0 地址 ⇒ 只绑回环的监听器**根本收不到**。
   *    实测踩过（2026-10-20）：容器内 curl 127.0.0.1:6101 通，宿主机连 6102
   *    却"连接被意外关闭"。
   *
   *    暴露面：监听 0.0.0.0 只在**仿真自己的 compose 网络**内可达；
   *    宿主机侧仍然只发布到 127.0.0.1 ⇒ 不对局域网暴露。
   */
  server.listen(forward.listen, '0.0.0.0', () => {
    log('forwarding', { listen: forward.listen, target: `${forward.host}:${String(forward.port)}` })
  })
}

const shutdown = () => { log('stopping'); process.exit(0) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
