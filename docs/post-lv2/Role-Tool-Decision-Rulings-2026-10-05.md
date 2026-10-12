# 角色自选工具 · 三项裁定与执行记录（2026-10-05）

用户 2026-10-05 显式裁定（原话）：

```text
「L-RTD-16，L-RTD-17 按你推荐的选，L-RTD-18 允许访问本机所有文件。」
```

| 编号 | 裁定 | 执行 |
|---|---|---|
| `L-RTD-16` | 按推荐 = **(a) 保持现状并写明** | 不改代码；把边界写进本文 §1 |
| `L-RTD-17` | 按推荐 = **(a) 教旧沙箱写适配器读暂存引用** | 已实现（`sandbox-filesystem.ts` + 两处装配），读数见 §2 |
| `L-RTD-18` | **允许访问本机所有文件** | 已实现（新增域判定模块 + 装配/床的域与解析器），读数见 §3 |

---

## 1. `L-RTD-16`（`sandbox.file.read` 不产出当轮内容）——**保持现状，写成明确边界**

```text
今天的如实行为（与裁定前逐字相同）：
  · `sandbox.file.read` **能被选中、能执行**（`success`，账本有记录）
  · 但它**不产出 `TurnContent`**（M4.5 的适配器只有字节数与指纹那一层 evidence）
  ⇒ 决策/规划/回复都看不到正文；**要看正文请用 `local.file.read`**。
适用范围：role 档与 rules 档**行为一致**（这不是新模式引入的差异）。
若将来要补：那是给 M4.5 适配器**追加能力**（冻结面），需要新 ADR + 全套 `m4:*` 复验。
```

---

## 2. `L-RTD-17`（旧沙箱写在任务环里永远 `validation_failed`）——**已修**

**修法**（与 `local.file.write` 逐字同形）：

```text
`sandbox-filesystem.ts` 的写入适配器：
  ① 有 `payloadRef` ⇒ 从**私有暂存**取回载荷（`staging.read`），取不到**如实拒绝**
     （绝不凭引用写一个空文件）
  ② 否则回落到字面 `content` ⇒ **旧行为逐字不变**（既有调用点与全部旧断言不受影响）
装配（两处，都传**与执行环同一个**暂存实例 —— 先例 `spec_not_staged`）：
  · `src/main.ts`   `createSandboxWriteAdapter({ ...sandboxOptions, staging: this.payloadStaging })`
  · 验收床         `createSandboxWriteAdapter({ ...sandboxOptions, staging })`
```

⚠️ **没有放宽任何东西**：域仍是动作沙箱根（`options.root`）、上限仍是 `maxWriteBytes`、
风险等级 / 策略 / 目标解析一个字节都没动 —— 变的只是"**正文怎么递进来**"。

读数（`pnpm postlv2:role-tool:matrix` 的 A7）：

```text
修复前：`status: rejected` · `validation_failed` · 文件**没写成**
修复后：`status: success` · 沙箱内那份文件内容逐字 = `SANDBOX-WROTE`
```

---

## 3. `L-RTD-18`（`document.read` / `image.ocr` 的域）——**已按"允许访问本机所有文件"实现**

### 3.1 改了什么（三处，都是"域判定"，不是权限放宽）

```text
① 新增 `src/kernel/action/disk-wide-scope.ts`（纯函数）：
     `DISK_WIDE_CAPABILITY_IDS` = local.file.list / read / write + **document.read** + **image.ocr**
     `isDiskWideCapability()` —— 只回答"这个能力按哪个域判定"
② 目标解析与策略措辞：`isLocalFileCapability(c)` → **`isDiskWideCapability(c)`**
     （`main.ts` 的 `resolveTarget` 分支与 `scopeWordingFor`；验收床同步）
     ⇒ 文档/图片的目标按"已授权的本机文件域"解析，**不再**被当成沙箱外
③ 跨域路径解析器（`resolveLocalAbsolutePath`：语法院 + 重解析点守卫）的存在条件：
     从"只在本机文件读开关打开时"改成"本机读 / 文档 / 图片**任一**打开时"
     ⇒ 否则会出现"开关开了、策略也按本机全域判了，却仍然只认沙箱"的半接状态
```

### 3.2 这条扩大**是什么**、**不是什么**

```text
是  ：任意绝对路径的**文档 / 图片可以被读**（仍要过各自的能力开关、权限、目标解析与风险等级）
不是：不新增能力、不新增动作种类、不改风险等级、**不放宽任何写路径的域**
      （写侧仍是 `local.file.write` / `office.generate` / 沙箱写三件，各自域不变）
不是："网络共享 / 设备路径 / 备用数据流一律拒"那条路径闸**没有**动
      （它在 `kernel/action/local-path.ts` 的 `inspectLocalPath` 里，本批一个字节未改）
```

### 3.3 读数（A12：办公生成 + 文档读回，产物在**沙箱之外**）

```text
修复前：生成成功，**读回**被如实拒（`permission_denied`：目标在沙箱范围之外）
修复后：生成成功 + **读回成功**，且读回正文回到轮次
```

### 3.4 顺带逮到的两处"床与生产不同形"（都已修）

```text
· 床里**没有** `document.read` 的适配器 ⇒ 读回得到 `unsupported：已登记但没有适配器`
· 床里**没有** `web.search` 的适配器（只建了 fixture provider 做目标解析）⇒ 搜索同理
⇒ 两处都已按 `main.ts` 同形补上；这类缺陷的形态与 `spec_not_staged` 一致
  （床替生产做了另一套装配 ⇒ 门永远照不到生产那条路）。
```

---

## 4. 本轮随之更新/新增的读数

```text
pnpm postlv2:role-tool:matrix   A 30/30 PASS · B 32/32 PASS · C 11/11 PASS
                                未覆盖 2 项（image.ocr 无图片夹具 · browser.operate 需受控假 sidecar）
                                ⇒ overall 仍按"NOT RUN 不算过"为 NOT PASS
pnpm m4:test 259/0 · pnpm m4.5:test 146/0 · pnpm productivity:verify --only common,files 12/12
```

新增覆盖（相对上一轮 +2 例）：

```text
A14 web.read         离线夹具替换"获取"（准入 / 上限 / 正文提取仍在适配器里）⇒ success + 正文回轮次
A15 搜索后深读        搜索真的执行 ⇒ **外部证据行回传给规划器** ⇒ 规划器**从命中里抽 URL**
                      ⇒ 深读真的执行 ⇒ 正文回轮次（`DEEP-READ-OK`）
```

⚠️ A15 以前**走不通**（命中只落 `externalEvidence`，规划器看不到 URL）；本轮把**外部证据**
按与"当轮内容"同形的路径回传（**既有** `selectExternalEvidenceContext` /
`renderExternalEvidenceEntry`，独立额度、缺省 0）。这条修复落在
`task-plan.ts`（`TaskPlannerInput.evidence`）/ `task-loop.ts`（收集 + 有界选择）/
`openai-task-planner.ts`（渲染）/ 装配层（额度）。

---

## 5. 仍然待办（与裁定无关的部分）

```text
· WP3 的 2 项 NOT RUN：`image.ocr`（本门不生成图片夹具）、`browser.operate`（受控假 sidecar）
· 人审（PENDING，需要人）
· 生产激活（NOT AUTHORIZED；候选与回滚见 WP4 记录 §4）
· `L-RTD-19`（决策格式失误不重试）—— 若要加一次有界重试，那是修订 ADR-104 `D07`
```
