# 皮套入口主动开口 · WP5b-0 交接单（机会状态 · 接线前置）

```text
WP     : WP5b-0 —— 接线的**前置**：三个闸要的状态（冷却 / 日额度 / 幂等键）此前**不存在**
日期   : 2026-10-11
上游   : ADR-131 · WP5a（桥侧接缝）
结论   : 状态端口 + 内存实现 + 日界计数已实现并自证（10 项）；
         **接线本身（`src/main.ts`）仍未做**，且被一个需要用户批准的决定挡着（见 §5）
```

---

## 1. ★ 先更正 WP0 的一处判断

WP0 基线 §"去重键"写的是：

> 冷却键 `lastOpeningAt`（**存在投递登记里，不新建表**）

**这条当时判断错了。** WP5b 侦察实测：

```text
`lastOpeningAt` / `handledOpportunityKeys` / `openingsUsedToday`
在全仓库**只出现在我自己的契约文件里**（作为预检的入参形状）——
现有的"投递登记"（`reminder-scheduling.ts` 的通道 registry + generation、
`notification_intents` / `notification_occurrences`）**没有任何一格能放它们**。
```

⇒ 所以三个闸的状态**必须新建**。本文件是那条判断的更正。

---

## 2. 交付物

| 文件 | 内容 |
|---|---|
| `src/kernel/app/bridge/proactive-opening-state.ts` | **新增**：`OpeningStatePort`（端口）· `createInMemoryOpeningState()`（内存实现）· `countOpeningsToday()`（日界计数，纯函数）· `openingPrecheckInputs()`（拼预检入参）· `IN_MEMORY_OPENING_STATE_LIMITATION`（机器可读的局限标识） |
| `artifacts/…/local/avatar-opening-state-probe.ts` | **新增（gitignored）**：10 项判据 |

---

## 3. 两处刻意的设计

### 3.1 日界用**时区**日，不用 UTC 日 —— 而且被机器量到了

`countOpeningsToday` 用 `dayKeyOf(ts, tz)`，与 `careOpportunityKey` 是**同一个日键函数**
（否则"每天"会有两处定义）。探针专门构造了一对**同属 UTC 日、但上海分属两天**的时刻：

```text
上海 10-11 23:30  ⇒ 不算进 10-12 那一天（跨日=0）
上海 10-12 00:30  ⇒ 算（当日=1）
两个时刻在同一 UTC 日内 ⇒ 证明用的**不是** UTC 日
机会键也跟着走：2026-10-11T23 vs 2026-10-12T00
```

### 3.2 `allUsedToday` **不由本端口提供**

它是"全类主动消息"（含 care 与提醒），那些账在**通知那一侧**。
⇒ 由调用方读了传进来（`openingPrecheckInputs` 只把它透传），本端口**只管开口自己那一份**。

---

## 4. 读数

| 项 | 读数 | 退出码 |
|---|---|---|
| `pnpm typecheck` | **0 错** | **0** ✓ |
| **WP5b-0 探针** | **PASS · 10 项 · 失败 0** | **0** ✓ |
| `pnpm kernel:test` | **27 通过 / 0 失败** | **0** ✓ |
| `pnpm kernel:verify` | **25 通过 / 0 失败** | **0** ✓ |
| `pnpm postlv2:bridge:verify` | **PASS · measured_count 290** | **0** ✓ |

### 4.1 ★ 把"已知局限"变成**读数**

内存实现的可读局限（文件里的常量）：

```text
in_memory_opening_state_resets_on_restart:
  重启后冷却/日额度/机会键幂等全部归零 ⇒ 重启可绕过限流
```

而探针**实测**了它，不是只写在文档里：

```text
同一个机会键、同一个 now：
  实例 A（记过一次）  ⇒ `opening_opportunity_already_handled`
  实例 B（全新实例）  ⇒ **ELIGIBLE（重启绕过了）**
```

⇒ 这条局限**有读数、有标识**，可以直接登记进 Known-Limitations。

---

## 5. ★★ 需要你批准的决定：状态放哪儿

```text
选项 A（= 现状）：内存
  · 代价：重启绕过冷却与日额度、同一小时的机会会重来一次
  · 好处：零迁移、立刻能接线
  · 已做：局限有机器可读标识 + 实测读数

选项 B：落库（真正的不变量级限流）
  · 代价：**要一条迁移**（`0018`），而按本仓库纪律，**迁移必须由你单独批准**
          （先例：`0014` / `0015` / `0016` / `0017` 各自单独批准过）
  · 好处：重启不绕过；与 `notification_*` 那几张表同族，可对账
  · 需要的形状（草案）：一张 `opening_occurrences`（`occurrence_key` 主键唯一占用
    ＝ 幂等；`opened_at` ＝ 冷却与日额度），与 `0014` 的"发送幂等靠主键唯一占用"同一手法
```

⚠️ **本 WP 不替你做这个决定**：迁移在这个仓库里从来不是顺手做的（每条都有独立的批准与读数）。
⇒ 在 A 或 B 定下来之前，**WP5b 的接线不往下走** —— 因为在 A 下接线，等于把一个
"重启就能绕过限流"的限流器接进装配根；那是应当由你知情的取舍。

---

## 6. 本 WP **没有**做的事

```text
· ❌ **`src/main.ts` 仍未改**（装配根一个字未动）
· ❌ `turn-bridge-transport.ts` 未改（`options.openingOpportunity` 那根注入线还没接）
· ❌ 外壳未改 ⇒ **没有任何东西会发这条报文**
· ❌ 没有真实模型调用、没有落账 / trace / 交付读数
· ❌ 没有迁移（`0018` 不存在）
· ❌ 没动 `.env`、没动 `TD-19`
```

---

## 7. 下一步（取决于 §5 的决定）

```text
若 A：立刻做 WP5b（main.ts 接线 + 外壳发报文 + 读数 + trace），
      并把这局限登记进 Known-Limitations（它已经有读数了）
若 B：先出 `0018` 的设计 + 迁移草案给你批；批了再做 WP5b
```
