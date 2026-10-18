# 服务器部署 · 部署前准备工具（2026-10-16）

> **历史记录（2026-10-16）**：下文的部署前状态、测试计数和操作纪律属于准备时点。2026-10-18 服务器发行版的当前安装入口与独立复验边界见 [SERVER-EDITION.md](../../docs/SERVER-EDITION.md) 和 [PUBLIC-VERIFICATION.md](../../docs/PUBLIC-VERIFICATION.md)。旧备份工具不能仅凭源码发布视作当前生产恢复方案。
>
> **准备时状态：准备件，尚未在服务器上执行过任何一步。**
> 本文里的每条命令都**还没有**在真实服务器上跑过 —— 第一次跑请把它当"第一次跑"对待。
> 按本仓库纪律，**服务器侧任何 `.env` 变更都需要你当轮逐字授权**（先例 ADR-048/065/067/071/112）。

---

## 0. 这套东西解决哪五件事

| # | 事项 | 工具 | 状态 |
|---|---|---|---|
| ① | **Linux 适配**：工具超时清理 + Python 路径 | `kill-process-tree.ts`（产品代码）+ `pnpm deploy:verify` | ✅ 已改，门 **20/20 PASS** |
| ② | **完整打包**：资产清单 + Linux 重建 Python | `pnpm deploy:assets` / `bootstrap-linux-python.sh` | ✅ 已实测跑通 |
| ③ | **数据迁移**：一致性逻辑备份 + 恢复验证 | `pg-backup.sh` / `pg-restore-verify.sh` | ⚠️ **未对生产库执行过** |
| ④ | **远程执行接线**：SSH 反向隧道 | `tunnel-pc.ps1` | ⚠️ **未建过隧道** |
| ⑤ | **功能复验**：自动记忆失败定位 | 产品代码已加具名诊断层（同在 `deploy:verify` 内有判据） | ✅ 已改；**真实原因仍待下一次运行给出** |

### 常用命令

```bash
pnpm deploy:verify          # 部署可移植性 + 诊断层判据（本轮 27/27 PASS，EXIT 0）
pnpm deploy:pg:selftest     # 备份→恢复→读回→篡改拒收 的**端到端**自测（真实 PG 17，0 失败）
pnpm deploy:assets          # 生成部署资产清单
node scripts/deploy/asset-manifest.mjs --verify <清单>   # 服务器侧核对
```

### 复核后的修正记录（2026-10-16 · 部署前复核）

一份外部复核推翻了上一轮的几处结论。逐条照办后的状态：

| 复核发现 | 状态 |
|---|---|
| **§1 自动记忆诊断仍误标**：signal 中止发 `AbortError`，被无条件 `child.on('error')` 抢跑标成 `spawn_failed`；且被信号杀时 `code === null` 又先命中 `code !== 0` 标成 `exit_nonzero`。**上一轮那个修复其实没生效** | ✅ 两处都修；门新增 **D1–D6 真驱动 `invokeWorker`**，四种失败实测 **4/4 互不相同** |
| **§2 `query(text)` 在 PG17 不存在**，逐表对账从来没真的跑过，且错误被吞掉后照样产出元数据 | ✅ 改用 psql `\gexec`；读数缺失改为**直接失败** |
| **§2 `--manifest` 收文件路径却按目录用**，拼出 `…/manifest.json/manifest.json` | ✅ 修；自测 T4 覆盖 |
| **§2 dump 与行数不是同一快照** | ✅ manifest 标注 `rowCountsCaptured`；脚本头写清"不证明什么" |
| **§2 不校验 dump sha256**；扩展不一致只告警后照样打印通过 | ✅ 加 sha256 闸（自测 T3 验证拒收）；扩展不一致改为**失败** |
| **§3 `Register-ObjectEvent` 没有 `-SignalType`**，脚本连接前就抛 | ✅ 改用 `TreatControlCAsInput` + `KeyAvailable` |
| **§3 `-R` 只绑 loopback 取决于服务器 `GatewayPorts`**，脚本的说法太满 | ✅ 改成给出服务器侧核对命令 |
| **§4 `document-read.ts` / `office-generate.ts` 仍是分段 `join(…,'Scripts','python.exe')`，而 S5 只找单串字面量 ⇒ 假绿** | ✅ 两处补 env 覆盖口 + 按平台挑形状；S5 改成找字面量本身 |
| **§4 `bootstrap-linux-python.sh` 说 utility-skills venv"没有消费者"** —— 消费者就是这两个适配器 | ✅ 改为必须构建，并导出 env |
| **§5 门的正控夹具缺 `detached`** ⇒ Linux 上会假失败 | ✅ 夹具补上；"未命中预期分支"现在列入 `unverified` |
| **§4 `local-filesystem` 用 win32 缺省判 POSIX 路径** | ✅ 适配器层传真实平台（Windows 逐字不变） |
| **§4 arXiv 资产指纹指向 Windows `Lib/site-packages`** | ✅ 按平台解析 site-packages 根；清单里**不**含该标记的键仍按仓库相对路径解析 |

⚠️ **上一轮我自己造成并修掉的一处回归**（诚实登记）：改 arXiv 指纹时把"清单键一律当 site-packages 相对"套用到了
**不含**该标记的键上（`scripts/learning-skills/arxiv-server.py` 这类仓库相对路径），
导致 2/33 条 ENOENT、`verifyArxivRuntimeSync()` 从 `true` 变 `false` —— 一个**自己造成的能力静默下线**。
已修，并在本机核对回到 `true`。

### 端到端自测抓到的两处（只读语法检查发现不了）

`pnpm deploy:pg:selftest` 在**真实 PostgreSQL 17** 上跑「造库 → 备份 → 恢复到一次性空库 → 逐表对账 →
读回真实数据 → **篡改 dump 必须被拒**」整条链。本轮 **0 失败**，并抓出：

1. **`lg_migrate` 没有 CREATEDB**，而恢复验证脚本原来用它 `createdb`
   ⇒ 在真实环境里**根本跑不起来**（`permission denied to create database`）。
   生产角色是**最小权限**的（`lg_bootstrap` 才是 superuser+createdb），这是对的；
   脚本改为**只有验证库**用 `PG_ADMIN_USER`，转储侧继续用最小权限的 `PGUSER`。
2. 清理函数用最小权限角色 `dropdb`，失败被 `|| true` **静默吞掉**，留下一库残渣。
   ⇒ 改用管理角色，并把"删不掉"**如实打印出来**而不是假装成功。

⚠️ 该自测在本机**生产 PostgreSQL 实例**里新建两个**一次性**库（`lg_deploy_selftest_src` /
`lg_restore_verify_*`），跑完即删，**从不读写 `sumuwei`**。
实测前后：`sumuwei` public 表数 **56 → 56**、容器 `StartedAt` **未变**、状态 `running/healthy`。

---

## 1. ① Linux 适配：这次改了什么（已改，重要）

### 1.1 一个会**打崩服务器核心**的缺陷

三个产品适配器（`math-calculate` / `office-generate` / `document-read`）原先各自写了一份
`killTree(pid)`，形状都是 `try { spawn('taskkill', …) } catch {}`。

⚠️ **那个 `try/catch` 是无效防护。** `child_process.spawn` 找不到可执行文件时
**不抛同步异常**，而是**异步**在子进程对象上发 `'error'` 事件；没有监听器 ⇒
Node 把它当未捕获异常 ⇒ **整个核心进程崩掉**。

在 Windows 上这个洞被"`taskkill` 恰好存在"掩盖着，所以从来没暴露。
**服务器是 Linux ⇒ 一次工具超时就可能把核心打崩。** 这正是那份部署清单第 ① 条说的
"仍使用 taskkill 的工具超时清理"，而它的真实严重度比"清理不干净"高一档。

（`arxiv.ts` 原本就是对的：它判了 `process.platform` 并挂了 `'error'`。
但它是**第二处**需要维护的同一份逻辑 ⇒ 本轮一并收进共享助手。）

### 1.2 改法

- 新增 `kill-process-tree.ts`：跨平台、**永不抛**、POSIX 上杀进程组、win32 上 `taskkill /T /F`。
- 四个适配器（`math-calculate` / `office-generate` / `document-read` / `arxiv`）改为调用它；
  `spawn` 加 `detached: process.platform !== 'win32'`
  （**只在非 win32 开** —— Windows 上 `detached: true` 会让子进程在父进程退出后继续存活，那是本机回归）。
- 顶层错误码与既有读数**逐字不变**。

### 1.3 本轮补上的第二类：写死的 Windows 解释器路径

`arxiv.ts` 原来硬编码 `join(ARXIV_RUNTIME, 'Scripts', 'python.exe')` 且**没有任何覆盖口**
⇒ 在 Linux 上 `arxiv` 一调必失败。而 `rapid-ocr` / `desktop` 早就有 `PROJECT_LG_*_PYTHON` 覆盖口。
这是"同一类缺陷只漏了一处"的形状。

已补：`PROJECT_LG_ARXIV_RUNTIME` / `PROJECT_LG_ARXIV_PYTHON` 两个覆盖口，
并让三处缺省值都按平台挑形状（`bin/python` vs `Scripts/python.exe`）。
**不设环境变量时，Windows 上的路径与今天逐字相同。**

⚠️ **还有一处没修，刻意登记**：`desktop-control-assets.ts:109` 的
`join(python, '..', '..', 'Lib', 'site-packages')` 是 **Windows 布局**
（Linux 是 `lib/python3.X/site-packages`）⇒ `verifyDesktopRuntime*()` 在 Linux 上会报"桌面运行时不可用"。
**这在服务器上无害**（桌面控制本就该关着），但**意味着那个判据在 Linux 上没有效力**——
它分不清"没装"和"路径算法在 Linux 上不成立"。

### 1.4 机器判据（`pnpm deploy:verify`，20/20 PASS）

| 组 | 断言 |
|---|---|
| S1/S1b | AST 判据：产品代码里调用 `spawn('taskkill')` 的地方**恰好 1 处**（共享助手里的平台分支） |
| S2/S3 | 三个适配器都调用共享助手；助手文件存在 |
| S4 | 三个 Python 入口**全部**有 env 覆盖口 |
| S5 | 产品代码里不再有写死的 `Scripts/python.exe` 常量 |
| B1/B2 | **正控**：真起一棵"父→孙"进程树，`killProcessTree()` 后**父子都得死** |
| B3 | **负控**：在隔离子进程里跑**旧写法**，断言它**非零退出** ⇒ 证明这不是装饰性修复 |
| B4 | **恢复**：门自己在杀完树之后**还活着** |
| C1–C10 | `composeJobError` 三条性质；7 个 worker 失败原因映射；**隐私**：未知异常 ⇒ `'unknown'`，原文不外泄 |
| **D1–D6** | **真驱动 `invokeWorker`**：把 worker 真的逼到超时 / 被取消 / 起不来 / 非零退出 / 正常输出，断言五种结果**互相可分**（4/4） |

⚠️ **门自己被复核抓到的洞**（已补）：D 组是后加的。之前 C5 只测**手工构造**的
`LangMemWorkerFailure` 映射表，**从没驱动过 `invokeWorker` 本身** ⇒
它给出的"映射全对"完全不能证明分类逻辑正确，事实上真跑起来第一版就错了两处。
**教训**：改了分类逻辑，就必须有**真的把那几种情况跑出来**的门。

⚠️ **判据纪律**：S1 第一版用正则按文本找 `spawn('taskkill'`，
结果**被我自己写在新注释里的那句话判成命中**（`L-QQP-09` 记过的坑，本轮第四次撞上）。
⇒ 已改用 **TypeScript AST**，注释与字符串在结构上不可能命中。

⚠️ **平台诚实**：本门在 Windows 上跑，**实测的是 win32_taskkill 路径**；
**POSIX 进程组分支在本平台上 `not_verified`** —— 必须在服务器上补跑一次。

---

## 2. ② 可复现打包

### 2.1 资产清单（`pnpm deploy:assets`，已实测 EXIT 0）

产出 `artifacts/deploy/local/asset-manifest.json`（**已加进 `.gitignore`**），逐类给出
`model` / `resource` / `config` / `rebuild` / `secret`，每项带 sha256 与字节数。

**本机实测读数**：

| 类 | 项数 | 体积 |
|---|---:|---|
| `model` | 10 | **149.4 MiB** |
| `resource` | 3 | 2.6 KiB |
| `config` | 3 | 5.6 KiB |
| `rebuild` | 8 | （**永不复制**） |
| `secret` | 2 | 只记存在性，**从不记值** |

`rebuild` 里那 8 项就是**最容易被人手工拷过去**的东西：
`node_modules`、四个 venv（desktop / langmem / **ocr** / **utility-skills**）、
`data/pglite`、`data/snapshots`、`data/qq-private`。

⚠️ 模型不止语义编码器：还有 **RapidOCR PP-OCRv4 的三个 ONNX**（det / cls / rec）。

### 2.2 🔴 `@huggingface/transformers`：不只是"没声明"，还有**版本分歧**

```
package.json 声明   : 否   <== 部署阻塞
evals 清单钉的版本 : 4.2.0
node_modules 链接  : 无            ← 连软链都没有
.pnpm 孤儿副本      : 4.3.0        ← 实际能解析到的那个
```

⇒ 三件事要定：(a) 声明进 `package.json`；(b) **先裁定 4.2.0 还是 4.3.0**；
(c) 服务器上 `pnpm install` 之后它必须真的在 `node_modules` 里。
⚠️ 现在它**只**靠扫 `node_modules/.pnpm` 解析（`encoder-worker-entry.ts:76-104`），
找不到就抛，核心**起不来**。

### 2.3 🟡 `LAB_MODEL_ROOT` **没有环境变量**

硬编码相对常量 `artifacts/m9.5/local/embedding-lab/models`，按 `process.cwd()` 解析
（`src/main.ts:8701`、`encoder-worker-entry.ts:69`）。
⇒ **cwd 错了没法用 `.env` 救**，只能靠 systemd 的 `WorkingDirectory=` 精确指向仓库根。

### 2.4 Linux 上重建 Python（`bootstrap-linux-python.sh`）

`sh -n` 通过、**纯 ASCII**、且**在 Windows 上真的会拒绝运行**（已实测退出码 1）。
它从两个真实 venv 的 dist-info 里**提取已装版本**并固定，不猜。

⚠️ 它**明确不重建 desktop-control**（上游 `windows-mcp==0.8.7` 依赖 `dxcam`/`comtypes`/`pywin32`，
没有 Linux 对应物）—— 这是**刻意的"永不"**，不是待办。

---

## 2. ③ 数据迁移：两条红线

### 2.1 红线一：**绝不复制 PGDATA**

2026-10-14 事故的根因就是违反了这条：两个 PG 进程并发挂载同一个卷 → checkpoint 校验和失效 →
原生产卷损坏。本目录下的脚本**只走 `pg_dump`**（一致性快照），不提供任何拷数据目录的路径。

`pg-backup.sh` 会把容器**实际挂载的卷名打印出来**，让人能一眼核对 ——
事故的教训正是"项目名隔离被误当成物理卷隔离"。

### 2.2 红线二：**备份不算数，验证才算**

```sh
# 服务器（或本机容器）上
sh scripts/deploy/pg-backup.sh --out ./out
sh scripts/deploy/pg-restore-verify.sh --manifest ./out/manifest.json
```

`pg-restore-verify.sh` 会把 dump 灌进一个**全新空库**、**逐表对行数**、**逐条对扩展版本**，
脚本**拒绝**把目标写成生产库名，且用完即删。

⚠️ **恢复验证之后还有一件事没做完**：把事故文档
[`experiments/omni-realtime/INCIDENT-20261014.md`](../../experiments/omni-realtime/INCIDENT-20261014.md)
的结论回写。它现在写着"**未执行生产恢复**"，而实测当前容器挂的是新卷
`lg-postgresql-production-20261014` 且健康 —— **文档与现实已经不一致**，
下一轮审计还会读到错误结论。

### 2.3 保持"一个权威人格核心"

- 核心持有 **session 级 advisory lock**（单认知执行者资格，ADR-132 `D05`）。
  ⇒ **服务器与本机不能同时持有生产库**。切换当天必须先在本机**有序停服**再起服务器。
- 本机从切换日起**不再是第二个权威**，只是开发/验收机。
- 人格、长期记忆、信念、关系、情绪、目标**本来就跨入口共享**
  （ADR-109 `D04`；`memory_records` 表没有 entry 列）—— 所以"同一个人"不需要额外工程。

---

## 3. ④ 远程执行接线：隧道 + 四个缺口

### 3.1 隧道（本目录）

```powershell
# 一次性：生成专用密钥（不要复用你其它地方的密钥）
ssh-keygen -t ed25519 -N '""' -C 'lg-pc-executor' -f "$env:USERPROFILE\.ssh\lg_tunnel_ed25519"
# 把 .pub 加到服务器的 ~/.ssh/authorized_keys

# 常驻
powershell -ExecutionPolicy Bypass -File scripts\deploy\tunnel-pc.ps1 `
    -Server lg@<服务器IP> -ServerPort 8765 -PcPort 8765
```

隧道建立后：**服务器 `127.0.0.1:8765` ⇒ 你的电脑 `127.0.0.1:8765`**。

这条路的价值在于：**两端都落在 `127.0.0.1`**，所以审计里那两条"必须改代码"的阻塞项
（核心只绑 loopback `src/main.ts:6597`、皮套连接档拒绝非 loopback
`tools/avatar-3d/shell-connected.py:14-15`）**一个字都不用改**。加密由 SSH 提供。

脚本里三个参数是有理由的，不是抄来的：
`ExitOnForwardFailure=yes`（端口被占用就**明确失败**，不静默不转发）·
`ServerAliveInterval=30` + `ServerAliveCountMax=3`（断链检测）·
反向绑定**不带** `0.0.0.0`（服务器以外的主机连不上，这是安全属性）。

### 3.2 ⚠️ 隧道解决不了的四项（**必须补，本轮未做**）

| # | 缺口 | 为什么隧道解决不了 | 现状 |
|---|---|---|---|
| 1 | **工具协议** | 隧道只搬字节。核心今天用 `spawn` 起一个一次性 Python worker（`desktop-control.ts:359-366`），**协议是行分隔 JSON over stdio**。跨机需要一个"发 header、收 RESULT 行"的请求-响应层。 | ❌ 未实现 |
| 2 | **应用层鉴权** | SSH 只认"这条连接是不是你"。**持隧道的那台服务器上的任何进程**都能调你的桌面。需要执行端自己再验一个**独立随机令牌**。⚠️ 现有 token 比对是普通 `!==`（`src/main.ts:6364`），**不适用于跨机器**，必须 timing-safe。 | ❌ 未实现 |
| 3 | **重连** | 隧道断了、执行端死了、她正在点东西 —— 三种情况要能分辨，且**如实**报告"本机能力当前不可用"，**不得**回落成本地 spawn 或任何"凑合能用"的路径。 | ❌ 未实现 |
| 4 | **取消** | 一次 `desktop.operate` 跨机往返，轮次被取消时正在执行的鼠标动作**要不要停、能不能停**，没有定义。 | ❌ 未实现 |

⚠️ **电脑关机/休眠 ⇒ 隧道断 ⇒ 服务器侧必须如实显示"本机能力不可用"。**
这是**预期行为**，不是故障。QQ 与人格内核继续工作。

### 3.3 保留现有 worker（R1），不换成原生 Windows-MCP 服务

已核对：你 venv 里那个包就是 [`CursorTouch/Windows-MCP`](https://github.com/CursorTouch/Windows-MCP)
（dist-info 的 `Project-URL` 直接指向它），0.8.7 **已自带** `streamable-http` + constant-time 令牌。

**仍然保留现有 worker 的理由**：它在动作前**重新取快照**并逐条核对
「索引 → 控件名 → 所属窗口 → 前台窗口」，不成立就失败关闭
（`stale_reference` / `window_mismatch` / `focus_changed` / `not_actionable`）。
Tailscale / 隧道解决的是**连接权限**，替代不了这些**动作检查**。

⚠️ **不要升 `windows-mcp` 版本**：0.8.8 线才有"人类接管"控制闸，而它带已知 bug
（[issue #465](https://github.com/CursorTouch/Windows-MCP/issues/465) 心跳过期会 fail open；
报告者给的绕过逐字就是 "pin `windows-mcp==0.8.7`"）。你正在这个版本上。
⚠️ **UAC / Secure Desktop 对用户态进程不可见**（[#236](https://github.com/CursorTouch/Windows-MCP/issues/236) 未实现）
⇒ 装软件、写 HKLM、启停服务这类**触发提权**的动作会把她卡住，与选哪条路线无关。

---

## 4. ⑤ 自动记忆失败：定位到了"为什么定位不了"，真实原因仍待下一次运行

### 4.1 已确认的诊断结论

容量测试（`artifacts/post-lv2/local/server-capacity-20261016/`）报了 2 个
`automatic_memory_extraction_or_commit_failed`，且**当时定位不了**。

**定位不了不是数据不够，是信息在抛出点就被销毁了 —— 三层叠加**：

| 层 | 位置 | 问题 |
|---|---|---|
| ① | `langmem-memory-extractor.ts` `invokeWorker` | 把**四种不同**的失败压成同一个错误串（超时 / 被取消 / 非零退出 / 输出超预算），且 `signal.aborted` **分不清** 40s 超时与外部取消 |
| ② | 同上 | python 的 **stderr 被主动丢弃**（隐私决定，**该保留**）⇒ 连异常类型都没有 |
| ③ | `automatic-memory.ts` | **`catch {}`** 把 ① 的结果也丢了 |

⇒ 一次"超时"和一次"Python 崩溃"在账上**长得一模一样**。

### 4.2 已做的修复（产品代码）

- `invokeWorker` 现在给**闭集具名原因**：`spawn_failed` / `timeout` / `cancelled` /
  `exit_nonzero` / `output_over_budget` / `stdin_failed` / `aborted`；超时与取消**分开拿信号**。
- `automaticMemoryFailureCauseOf()` 把异常映射成**闭集具名码**；`catch (error)` 不再丢弃。
- `finishJob` 新增**可选** `cause`，拼进 `last_error`；**不传 ⇒ 写入值逐字不变**。
- 纪律：**只记具名码与退出码，不记 stderr / stdout / 用户原话 / 模型回复**。

### 4.3 ⚠️ 还没有下结论的部分

**头号嫌疑**是 40 秒硬期限在 2 核满载下被打满（容量测试里"连续对话与轮间后台任务"CPU 峰值 100.0%）。
**但这只是嫌疑，不是结论。** 修复的目的就是让**下一次**运行给出证据。

⇒ **下一步**：在服务器上重跑一次容量测试，读 `last_error` 的 `:cause` 后缀。
在那之前，不要把"超时"写进任何结论。

---

## 5. 顺序（第一次跑请照这个顺序）

```text
① 本机：pnpm typecheck                                        # 本轮已 EXIT 0
② 本机：提交/打包工作树（523 条变更，其中 src/ 91 个）        # ⚠️ 见 Server-Deployment-And-Unified-Identity-Audit §2.1
③ 本机：补 @huggingface/transformers 依赖（不在 package.json）
④ 本机：node scripts/deploy/asset-manifest.mjs                # 产出资产清单
⑤ 本机：把模型 / 资料库 / 清单按资产清单传到服务器
⑥ 服务器：sh scripts/deploy/bootstrap-linux-python.sh --dry-run   # 先看它要干什么
⑦ 服务器：sh scripts/deploy/bootstrap-linux-python.sh             # 重建 venv（**不复制 Windows 的**）
⑧ 本机：sh scripts/deploy/pg-backup.sh --out ./out                # ⚠️ 首次需要你授权
⑨ 本机：sh scripts/deploy/pg-restore-verify.sh --manifest ./out/manifest.json
⑩ 服务器：node scripts/deploy/asset-manifest.mjs --verify <清单>
⑪ PC  ：建立 SSH 隧道（§3.1）
⑫ 服务器：重跑容量测试，**读自动记忆的 cause 后缀**（§4.3）
⑬ 服务器：真实 QQ 收发 + 拟部署模型验收
```

---

## 6. 本轮**不**主张的事

- 不主张任何一条脚本**在服务器上跑过**。`pg-selftest` 只在本机 PostgreSQL 实例上跑过。
- 不主张 Linux 上超时路径**实测过**（缺一条"故意超时"的负控）。
- 不主张 `killProcessTree` 的 **POSIX 进程组分支**已验 —— 本轮平台不具备，
  门会把它如实列进 `unverified`，**必须**在服务器上补跑。
- 不主张自动记忆失败的**真实原因**已知（只修好了"定位不了"这件事本身）。
- 不主张**对生产库 `sumuwei`** 做过备份或恢复 —— 自测全程只碰一次性临时库。
- 不主张隧道**建过**，或远程执行**任何一项可用**（§3.2 四项全未实现）。
- 不主张 `bootstrap-linux-python.sh` 在 Linux 上跑过（本轮它在 Windows 上**正确拒绝**）。
  ⚠️ 它的 `utility-skills` baseline 里那几个包名是**用途推定**，不是读出来的（文件内已标注 TODO）。
- 不主张这次改动等于任何生产激活。
