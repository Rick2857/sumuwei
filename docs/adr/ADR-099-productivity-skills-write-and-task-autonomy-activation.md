# ADR-099：第二批实用能力 —— **写入 + 任务自主档**生产激活

> ⚠️ **编号说明**：本 ADR 原本写作 `ADR-098`，但同一工作树上的另一个会话在同一时间段
> 也提交了一份 `ADR-098`（`pre-turn-lookup-attribution-exemption`）。
> 按"已提交者优先"的惯例，**本份改为 `ADR-099`**，正文一字未改；
> 引用它的三份文档（验收报告 / 局限册 / 使用与回滚）已同步改号。

状态：**ACTIVATED（只做状态修订 / 只改配置）**。日期：2026-10-04。
授权：用户 2026-10-04 显式指示「写入档或任务自主档继续」。
前置：[`ADR-097`](ADR-097-productivity-skills-local-file-read-activation.md)（只读档，同日）。

---

## 0. 这次追加了什么

`.env` **只追加两行**：

```text
CHARACTER_TASK_AUTONOMY_ENABLED=true
CHARACTER_LOCAL_FILE_WRITE_ENABLED=true
```

⇒ 生产聊天里，**任务形的发言**会签发一份内存任务授权，由有限规划器给出计划、程序校验后
分步执行；其中写文件的步骤会真的改本机文件（覆盖前留恢复副本）。

⚠️ **代码里的缺省仍然是 `false`**（与 `ADR-048`/`ADR-065`/`ADR-067`/`ADR-069`/`ADR-071`/
`ADR-082`/`ADR-094`/`ADR-095`/`ADR-097` 同一条先例）。

---

## 1. 为什么这两项**必须一起**开（这是本 ADR 唯一的实质内容）

```text
`local.file.write` 的请求**只由任务执行环产生** —— 代码里**没有**写意图检测器。
```

这是 `src/kernel/action/local-file-intent.ts` 文件头第 3 条**刻意的**设计：
单动作路径不产生写请求，因为"她说'写一下'就把某个文件改掉"这条路的代价不对称。
实证（不是推断）：

```text
scripts/productivity-skills/groups-files.ts 里**每一处**写场景传的都是
  switches: { localFileWrite: true, taskAutonomy: true }
⇒ 只开 CHARACTER_LOCAL_FILE_WRITE_ENABLED 的后果是：
   权限被授予、适配器被构造，但**没有任何代码路径会产生一次写请求** ⇒ 完全静默。
⇒ 那样的"激活"在读数上与"没激活"**无法区分**（AGENTS.md §6.9 的同型陷阱）。
```

---

## 2. 生效读数

`pnpm productivity:activation:readback`（不打开数据库、不发起动作、不含凭据）：

```text
localFileReadEnabled     true      ← ADR-097
localFileWriteEnabled    true      ← 本 ADR
taskAutonomyEnabled      true      ← 本 ADR
weatherEnabled           false
officeGenerateEnabled    false
newsReadEnabled          false
browserEnabled           false

turnContentTokens        3000
localFileRecoveryRoot    data/local-file-recovery     ← 写入开了 ⇒ 本档**开始用得到**
taskMaxActions/Plans    30 / 6     deadline 600000ms
actionMaxRiskLevel       R1        ← **逐字未改**（R2 只在浏览器档且仅任务级）
旧沙箱                    actionEnabled=true · actionSandboxRoot=data/action-sandbox（未动）

kernel flags：ON=[…, local-file-read, local-file-write, task-autonomy]
             OFF=[…, weather, office-generate, news-read, browser]
```

---

## 3. 这一档真的会做什么（代价面，逐条）

```text
① 一句话任务 ⇒ **多一次模型调用**（规划器）。它有 45s 超时与 8000 token 输出上限。
② 它会**真的改本机文件**：覆盖前写恢复副本到 data/local-file-recovery；账本里只留
   引用 + 指纹 + 字节数（正文永不进账本）。
③ 预算是硬的：30 次行动 / 6 次规划 / 10 分钟。超限即停，**不续跑**，"没做完"如实说。
④ 授权是**内存**的：进程重启即消失。
⑤ **不新增删除 / 移动 / 重命名**；写入是整文件替换；> 10 MiB 被拒。
⑥ R1 上限未动 ⇒ `browser.operate` 这类 R2 操作**仍然被策略拒绝**。
```

⚠️ 本档**不含**办公生成 / 资讯 / 天气：她能读本机文件、能写本机文件，
但**不能**生成 Office 文件、不能读订阅源、不能查天气（四道独立开关都还是 off）。

---

## 4. 回滚

```text
删掉这两行（或改成 false）⇒ 任务环与写权限立即停止。
· 已经写下去的产物**保留**（那是用户的文件，不是我们的缓存）
· 恢复副本**保留**（删了就没得退）
· 动作账本行**保留**（"她做过什么"必须留着）
· 旧 `sandbox.file.*` 原样可用
```

---

## 5. 首次使用：**NOT OBSERVED**（两档都是）

与前一份 ADR 同一条纪律。生效后**第一次真实对话**才会产生：

```text
· 一条 `local.file.write` 的动作账本行 + 一条恢复副本（"世界真的被改过"的证据）
· 一条 `task` 的规划/执行读数（`[task] 任务执行读数：…`）
· 一次"她有没有如实说自己做了/没做成"的观察
```

在此之前，`ADR-097` 与 `ADR-099` 两档的状态都是 **ACTIVATED / FIRST-USE NOT OBSERVED**。

---

## 6. 本档**不主张**的事

```text
· 不主张"她能自主完成任意多步任务"：预算 30/6/10min；任务是内存授权
· 不主张"写入一定安全"：恢复副本只覆盖**明确目标**，不是备份系统（L-PS-04/05）
· 不主张"模型会给出好计划"：计划质量不在本批判据内（离线用的是脚本化规划器）
· 不主张"离线/真模型读数 = 生产首次使用"：那些跑在 isolateDatabase() 副本上
```

---

## 7. 同轮顺带修掉的一个真缺陷（不是本 ADR 的授权内容，记在这里便于追溯）

读真实 sidecar 源码时发现：官方 MCP Streamable HTTP 传输要求**每一个 POST**
都带 `Accept: application/json, text/event-stream`，否则 **406**；
而 `browser.ts` 的 `notifications/initialized` 只发了 `Content-Type`。
受控假 sidecar 什么都收 ⇒ 离线三组照不到；真首连时会表现成
"连接看起来建立了、工具调用却拿不到东西"。**已修**，并且顺手给夹具复刻了
官方那两条闸（406 / 415）⇒ 这类缺陷以后离线就能照到。
