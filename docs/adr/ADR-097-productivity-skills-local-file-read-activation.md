# ADR-097：第二批实用能力 —— **本机文件域只读档**生产激活

状态：**ACTIVATED（只做状态修订 / 只改配置）**。日期：2026-10-04。
授权：用户在本轮显式选择「两件都做（装 sidecar → 再激活只读档）」。

载体：`docs/post-lv2/Productivity-Skills-and-Local-File-Execution-Plan-2026-10-04.md` ·
验收报告 `Productivity-Skills-Acceptance-Report.md` · 局限 `Productivity-Skills-Known-Limitations.md` ·
使用与回滚 `Productivity-Skills-Usage-and-Rollback.md`。

---

## 0. 这份 ADR 只做一件事

它**不新增任何主张**、**不改任何代码语义**、**不动任何判据**。它记录一件事：

```text
.env **只追加一行**  CHARACTER_LOCAL_FILE_READ_ENABLED=true
⇒ 生产聊天里，本机文件域的**只读**两项（local.file.list / local.file.read）被授予权限并构造适配器。
⇒ 写入 / 任务自主 / 天气 / 办公 / 资讯 / 浏览器 **全部保持 off**（代码缺省本来就是 off）。
```

⚠️ **代码里的缺省仍然是 `false`** —— 与 `ADR-048`（联网搜索）、`ADR-065`（关系）、
`ADR-067`（情绪）、`ADR-069`（语义情绪）、`ADR-071`（信念）、`ADR-082`（语义召回）、
`ADR-094`（故事认知）、`ADR-095`（第一批实用能力）**同一条先例**：激活是配置层的决定，
不是代码默认值的改变。

---

## 1. 为什么只开"只读"这一档

```text
① 它风险最低：`local.file.list/read` 声明 R0/read —— 只读、不改变世界。
② 它单独就能回答这一批最要紧的那个问题：
   "她能不能读出沙箱外的文件、并把正文当真用起来"（计划书 §2.1 第 3 点的接线缺口）。
③ 写入（R1）、任务自主（多一次模型调用）、四项业务能力（出站 / 子进程 / sidecar）
   各自有独立的失败面与代价面 ⇒ **分开授权**，一次只动一档。
```

⚠️ **本档不包含** `local.file.write`：因此覆盖前恢复副本、并发修改检查这些**写入侧**
机制在生产上**还没有被走到**。它们在离线 28 组与真模型短链里有读数，但**生产首次使用
尚未发生**（§4）。

---

## 2. 生效读数（**改了 .env ≠ 生效了**）

`pnpm productivity:activation:readback`（`scripts/productivity-skills/activation-readback.ts`，
**不打开数据库**、不发起动作、输出不含任何凭据）：

```text
localFileReadEnabled     true      ← 本档唯一打开的新开关
localFileWriteEnabled    false
taskAutonomyEnabled      false
weatherEnabled           false
officeGenerateEnabled    false
newsReadEnabled          false
browserEnabled           false

turnContentTokens        3000      ← 第一批激活时就在（当轮内容额度非 0，正文才有机会入模）
localFileRecoveryRoot    data/local-file-recovery      （写入未开 ⇒ 本档用不到）
actionMaxRiskLevel       R1
旧沙箱                    actionEnabled=true · actionSandboxRoot=data/action-sandbox（**未动**）

kernel flags 一行读回：
  ON=[…, local-file-read]   OFF=[…, local-file-write, task-autonomy, weather, office-generate, news-read, browser]
```

---

## 3. 回滚

```text
删掉 .env 里那一行（或改成 false）⇒ 只读两项立即停止被授予权限与构造适配器。
· 旧 `sandbox.file.*` **原样可用**（它的权限一直在 DEFAULT_GRANTED_PERMISSIONS 里，本批一字未改）
· 已经产生的动作账本行**保留**（"她读过什么"必须留着）
· 不涉及任何删除 / 迁移 / 真实库改动
```

---

## 4. 首次使用：**NOT OBSERVED**

⚠️ 与 `ADR-069` / `ADR-071` 同一条纪律：**不凭配置宣布"运行验证通过"**。
本档生效后**第一次真实对话**才会产生：

```text
· 一条 `local.file.read` 的动作账本行（`level 1` 的"世界真的被读过"证据）
· 一条 `turn_content` trace step（"实际入模"的现实）
· 一次"她能不能按读到的正文说话"的观察
```

在这三样出现之前，本档的状态是 **ACTIVATED / FIRST-USE NOT OBSERVED**。
⚠️ 验收报告里的离线与真模型读数**不是**生产首次使用：它们跑在 `isolateDatabase()` 的副本上
（`productionDbTouched: false`）。

---

## 5. 本档**不主张**的事

```text
· 不主张"全盘文件授权已可用"：只开了**只读**两项；写入仍未授权
· 不主张"她一定读得到"：Windows ACL / 文件占用 / 非文本格式都会如实失败（L-PS-01…06）
· 不主张"她能自主完成多步任务"：任务执行环仍未打开
· 不主张"离线全绿 = 真实链路全对"：离线替换了模型服务与出站 IO 两样东西
```

---

## 6. 与其它 ADR 的关系

| ADR | 关系 |
|---|---|
| `ADR-095`（第一批实用能力激活） | **先例**：同一套"只改 `.env`、代码缺省不变、`FIRST-USE NOT OBSERVED`"的形状；本批的 `turnContentTokens=3000` 就是它留下的 |
| `ADR-048` / `ADR-065` / `ADR-067` / `ADR-069` / `ADR-071` / `ADR-082` / `ADR-094` | **同一条先例链**：激活 = 配置层决定 |
| `ADR-090`（Lv2 放行） | 本批属 post-Lv2 的第二批实用能力，风险档位由它给出的框架约束 |
| `ADR-091`（世界边界与故事来源） | 本批**不触碰**世界边界：外部正文只进当轮上下文，不进长期认知 |
