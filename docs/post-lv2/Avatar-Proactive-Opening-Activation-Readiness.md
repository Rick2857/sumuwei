# 皮套入口主动开口 · 生产激活就绪评估

```text
问题   : 现在能不能生产激活？
日期   : 2026-10-11
结论   : **不能**（按本仓库的激活纪律），而且 ——
         ⚠️ **比"不能"更要紧的是：它现在没有开关，一重启外壳就自己上线了。**
```

---

## 0. ⏩ 2026-10-11 修订：§1 那个缺口**已补上**（开关已实现并在真链上验证）

| 项 | 变化 |
|---|---|
| §1 的缺口（"没有开关 ⇒ 重启就等于激活"） | ✅ **已关闭** |
| 新开关 | `CHARACTER_AVATAR_OPENING_MODE` = `off`（**代码缺省**）/ `shadow` / `on`；**非法值 ⇒ off + 告警**（与 `qqProactiveMode` 同一条失败关闭） |
| 三处消费 | ① `flags.ts` 解析 ② `main.ts`：`off` ⇒ **端口不注入**；`shadow` ⇒ 整条链照跑但**不出站**（具名码 `opening_shadow_no_emit`）③ 外壳：收到 `opening_capability_absent` ⇒ 提示一次 + **退避 900 秒** |
| ⇒ **重启外壳还危险吗** | **不危险了。** 现在重启是**安全**的：缺省 `off` ⇒ 端口不注入 |
| 真链读数 | 整链门新增**档二**：`avatarOpeningMode=off` ⇒ `opening_capability_absent`（`outcome=rejected`）+ **零模型调用**（`calls 4 → 4`）· **`CHAIN EXIT=0`** |
| 离线门 | **85 项**（+2：开关解析的**结构判据**（把 `readKernelFlags` import 进来调用它）+ `main.ts` 真的消费它的窄范围锚） |
| **仍然缺的** | 下面 §2 表里那些 `NOT RUN` —— **一条都没变**：真模型 / `spoken` 端到端 / `opening_no_live_client` / 幂等 / 首用 / 人审 |

⇒ §3 的**第一步已完成**。现在的激活路径是：`.env` 加 `CHARACTER_AVATAR_OPENING_MODE=shadow`（取真读数）或 `=on`（真的开口）；**回滚 = 删那一行**。

---


ADR-131 §9 的批准记录 ② 逐字写着「不动 `.env`（本 ADR **不含任何生产开关**）」。
我在实现阶段把这一条当成了**优点**（少一个开关就少一处漂移）。**现在看它是缺口。**

逐处核对"到底有没有东西拦着它"：

```text
LG 侧   ：`src/main.ts` 里 `if (spec.entry === 'avatar') host.openingOpportunity = …`
          ⇒ **无任何开关判断**
外壳侧  ：`scripts/postlv2_vtuber_runtime.py` 里 `await BRIDGE.start()` 之后
          `start_idle_reporter()` ⇒ **无任何开关判断**
前端侧  ：`allowProactiveSpeak: true`（你取回的读数）⇒ 那条路也开着
出站口  ：`CHARACTER_QQ_PROACTIVE_MODE=on`（`.env` 现状）⇒ 出站口绑得上
```

⇒ **四道都与"有没有被授权激活"无关。** 后果：

```text
你**重启皮套外壳**的那一刻，这个功能就上线了。
此后：你空闲满 3 分钟 ⇒ 一次**真模型调用** ⇒ 她可能对你说一句 ≤60 字的话。
```

**边界**（这些是真的，逐条来自策略与判据）：

| 闸 | 值 |
|---|---|
| 活跃时段 | **9:00–22:00**（`DEFAULT_ACTIVE_WINDOW`）⇒ 半夜不会开口 |
| 空闲下限 | 180 秒 |
| 冷却 | 30 分钟 |
| 本通道日额度 | 4 次 |
| 共享总闸 | 10 次（含关心与提醒） |
| 长度 | 2 句 / 60 字（超限 `output_too_long`，程序**不截断**） |
| 用户/她正在说 | 让位或拒 |

⇒ 它不是危险的功能，但它是**一个未经激活授权、会真的调模型并真的说话的功能**。
这与本仓库所有的先例（`ADR-048` / `065` / `067` / `071` / `082` / `105` …）相反 ——
那些都是「**代码缺省 off** + `.env` 显式打开 + 回滚 = 删那一行」。

**⚠️ 现在这一刻它还没上线**：外壳没在跑（端口空闲），而我的外壳改动要**重启**才生效。

---

## 2. 按激活纪律逐槽盘点（照 `*-Activation-Candidate.md` 的分列格式）

| 槽 | 状态 | 依据 |
|---|---|---|
| 设计 | ✅ `ACCEPTED / DESIGN FROZEN` | `ADR-131` + 裁定 C（2026-10-11） |
| 实现 | ✅ COMPLETE | WP0…WP6，六份交接单 |
| 离线硬门 | ✅ **PASS · 83 项断言 · 失败 0** | `pnpm postlv2:avatar-opening:verify` |
| 量具有效性 | ✅ **三段式 PASS**（四段反向分别报 20/28/18/9 项失败） | 同上 |
| 登记 | ✅ 在 `PL2_CONTROL_GATES`；清单一致（603 条） | `scripts:catalog:verify` EXIT 0 |
| **真链路（真 socket + 真核心）** | ⚠️ **PARTIAL** | 本轮整链门：真握手 + 协议 + `opening_without_evidence` + **零模型调用** = **真读数**；**`spoken` 那条路 NOT RUN** |
| **真模型** | ❌ **NOT RUN** | 适配器 `openai-proactive-opening.ts` **从未被调过**（全程假端口 / 离线 XML 夹具） |
| **`spoken` 端到端** | ❌ **NOT RUN** | 生成 → 守卫 → 仲裁 → `emitCharacterOutput` → `CHARACTER_OUTPUT` → 播放，**一次都没连起来跑过** |
| **`opening_no_live_client`** | ❌ **NOT RUN** | 它在判据顺序里晚于"依据集"，隔离空库走不到 |
| 幂等（真链） | ❌ **NOT RUN** | 幂等在**记额之前**；空库从没记过额 |
| **首用读数** | ❌ **NOT OBSERVED** | 真实对话里她主动开口过没有 —— 没有读数 |
| **人审** | ❌ **PENDING** | 没有可审的材料（她一句话都没真说过） |
| **激活载体** | ❌ **不存在** | ⚠️ **没有开关**（§1）⇒ 无法"激活"，也无法"回滚" |
| **回滚** | ❌ **无配置级回滚** | 只能回滚代码（`git revert` 那一批） |

---

## 3. 结论：两件事，按顺序

### 第一步（**必须先做**）：加一个开关

形状照关心那条线的先例（`CHARACTER_QQ_PROACTIVE_MODE`）：

```text
CHARACTER_AVATAR_OPENING_MODE = off | shadow | on       缺省 **off**
  off    ⇒ 端口**不注入**（桥如实报 `opening_capability_absent`）+ 外壳**不启动**上报器
  shadow ⇒ 整条链照跑（预检 ⇒ 依据 ⇒ 模型 ⇒ 守卫 ⇒ 仲裁）但**不出站**
           ★ 它正好用来取"`spoken` 那条路"的真读数，而**不对你说第一句**
  on     ⇒ 真的出站
激活 = `.env` 加一行 `=on`；回滚 = **删那一行**（代码缺省仍是 off）
```

⚠️ 这需要**你的裁定**：`ADR-131` §9 明说"不含任何生产开关" ⇒ 加它是对**冻结裁定**的修订，
按本仓库纪律要**独立裁定**（先例：`ADR-113` 修订 `ADR-110 D14`）。

### 第二步（开关有了之后）：按纪律走完

```text
① `shadow` 档真链路（真模型）⇒ 取"`spoken` 那条路"的真读数（不出站）
② 整链门补上"非空依据"那一档 ⇒ 让 `spoken` / 幂等 / `opening_no_live_client` 有真读数
③ Activation-Candidate（逐槽填）⇒ 你的授权 ⇒ `.env` 加 `=on`
④ Activation-Record + 首用读回（`FIRST-USE = OBSERVED / NOT OBSERVED`）
⑤ 人审（她说的话给你看）
```

---

## 4. 本文件**不主张**什么

```text
· **不**主张"它坏了"：离线 83 项 + 真链协议段都是绿的，判据层按设计工作
· **不**主张"激活了会出问题"：边界（时段/冷却/额度/长度）都是真的
· **不**主张现在就该激活：恰恰相反，**第一步没做之前不该重启外壳**
· **不**主张 §1 那个缺口是别人的错：`ADR-131` §9 当时是我按你的批准写下的，
  "不含生产开关"是我的判断 —— 现在如实更正
```
