# 皮套入口主动开口 · WP6 交接单（正式门已登记）

```text
WP     : WP6 —— 把四个探针转成**正式门**：`scripts/` + `package.json` + 门表 + affected-map + 清单重生成
日期   : 2026-10-11
上游   : ADR-131 · WP0…WP5b-3 · 裁定 C（2026-10-11）
结论   : 门已登记并跑通（**measured_count = 83 · PASS · EXIT 0**）；
         两个前置都清了（裁定 C 已下、用户确认无人在改 ⇒ 清单已重生成）
```

---

## 1. 交付物

| 文件 | 改动 |
|---|---|
| `scripts/postlv2-avatar-opening-verify.ts` | **新增**：五段门（§1 预检 / §2 生成侧 / §3 编排 / §4 机会状态 / §5 接线） |
| `scripts/gates/manifest.ts` | `PL2_CONTROL_GATES` **+1 条**（⇒ 进 `postlv2-controls` lane，并被清单算作**已登记门**） |
| `package.json` | **+1 条**：`postlv2:avatar-opening:verify` |
| `scripts/gates/affected-map.ts` | **+2 处**：`语音与皮套线` 与 `CLI / 入口`（后者的理由是端口本体内联在 `src/main.ts`） |
| `docs/architecture/Scripts-Catalog.md` | **重生成**（602 条） |

---

## 2. 门的结构

```text
§1 机会预检     15 条具名拒绝 + 判据**顺序** + 幂等 + 机会键日界
§2 生成侧       提示词（上限从契约派生）/ 严格解析 / 候选 / 表达信封
                —— 且**真的**经过两个**既有**消费者（`arbitrateCharacterOutput` + `decodeExpressiveSpeech`）
§3 编排         调用**计数**（空依据 ⇒ 零调用 / 失败 ⇒ 只调一次）/ 回复守卫**真的在链上** /
                发送前双次复核（S04）/ 长度·话权·版本交给既有仲裁
§4 机会状态     时区日界 / 占额 / 幂等键有界 / **内存实现的已知局限是读数**（重启绕过）
§5 接线         优先**结构判据**
```

**每一段都跑三段式**：正控 → **量具有效性（把期望反向 ⇒ 必须报红）** → 恢复。

### 2.1 ★ §5 的判据纪律（`L-QQP-09` 的教训）

本仓库的静态判据被"**全文按词找**"打败过三次，每次都是被**我自己的注释**打败。所以：

```text
**优先结构判据** —— 把真东西 import 进来**调用它**：
  · `BRIDGE_MESSAGE_KINDS.includes('PROACTIVE_OPPORTUNITY')`
  · `isBridgeControlMessageKind('PROACTIVE_OPPORTUNITY') === false`   ← 调用，不是搜字
  · 正控：PREPARE/QQ回执/CANCEL 仍在控制类里、SUBMIT 不在（**没把分类改坏**）
  · `NON_URGENT_CHARACTER_OUTPUT_SOURCES` 含 `proactive_opening`
⇒ 只有**确实无法 import** 的两处才退回**窄范围**文本判据，并在读数里**写明**：
  · `src/main.ts` 的端口本体（内联在装配根）
  · `scripts/postlv2_vtuber_runtime.py`（Python 外壳）
  锚的都是**很有辨识度的片段**（如 `host.openingOpportunity = async`），不做全文按词找。
```

---

## 3. 读数

| 项 | 读数 | 退出码 |
|---|---|---|
| `pnpm typecheck` | **0 错** | **0** ✓ |
| `pnpm postlv2:avatar-opening:verify` | **PASS · 断言 83 项 · 失败 0 · measured_count=83** | **0** ✓ |
| `pnpm scripts:catalog` | 已写出（**602 条**） | **0** ✓ |
| `pnpm scripts:catalog:verify` | **与 package.json / manifest 一致（602 条）** | **0** ✓ |
| `pnpm postlv2:affected:verify` | 全 `pass: true` | **0** ✓ |
| `pnpm postlv2:bridge:verify` | **PASS · measured_count 290** | **0** ✓ |

### 3.1 ★ 登记生效的两条独立证据

```text
① 清单里它被算成**已登记门**：`docs/architecture/Scripts-Catalog.md` 的
   「**已登记门（32）**」那一行含 `postlv2:avatar-opening:verify`
② `scripts:catalog:verify` EXIT 0 ⇒ 清单与 `package.json` / `manifest.ts` **一致**
```

⇒ 这两条一起证明：**门不是"写了个脚本"，它已经在受控登记表里了**。

### 3.2 量具有效性（四段都能报红）

```text
§1 反向 ⇒ 20 项失败    §2 反向 ⇒ 28 项失败
§3 反向 ⇒ 18 项失败    §4 反向 ⇒  9 项失败
总：四个段都能报红 = true ⇒ "全绿"**不是**因为判据恒真
```

---

## 4. 本 WP **没有**做的事

```text
· ❌ 没有跑 `postlv2-controls` **整条 lane**（含 12 道别人的门，含 `s8:daily:e2e` 那种要起 main.ts 的）
     —— 只逐条核了与本 WP 相关的那几道（`affected` / `bridge` / 新门）
· ❌ 没有跑 `pnpm fast`（它是"按改动选门"，本轮的改动面已由 affected:verify 自证）
· ❌ 没有跑 `m4.5:ci`（混合树纪律）
· ❌ **没有真实链路读数** ⇒ 见 `L-APO-10`（整条链一次都没真跑过）
```

---

## 5. 下一步：WP7（真链路 smoke）

| 需要什么 | 现状 |
|---|---|
| 真外壳重启（裁定 C 的两半 + `idleSecondsToSpeak` 调整） | **等你操作** |
| 触发一次机会 | 两条路：等 3 分钟（外壳上报器）或 **`POST /lg/opportunity`**（本轮新加的诊断入口，立刻触发） |
| 读回执 | `GET /lg/status` 的 `opportunity` 一格（计数 + 理由码 + 上报器状态 + `lastInputAgoSeconds`） |
| 内核侧真模型 | 走 `OPENAI_API_KEY`（生产端点）；**不得**把离线门的假端口读数当真实读数 |

⚠️ WP7 要的读数**一条都还没有**。离线门 83 项 + 探针只能证明"判据层按设计工作"。
