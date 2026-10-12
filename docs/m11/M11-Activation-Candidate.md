# M11 Activation Candidate —— WP12 生产激活候选

- 日期：2026-10-01
- 状态：**CANDIDATE（未执行）** —— 载体：[`M11-Gate-Decision.md`](M11-Gate-Decision.md) §14 第 12 槽
- 授权边界：用户 2026-10-01 授权了 `m11:activation:verify` / `m11:activation:readback` **两条命令**；
  **生产激活本身**（改生产 `.env`、让真实首聊跑起来）是**独立裁定**，本文件只是候选。

---

## 1. 激活什么（两行 + 一个额度）

```bash
# .env（生产基线；**代码缺省保持 false / 0 不变**）
CHARACTER_REFLECTION_ENABLED=true          # 反思慢路径（触发扫描 → 候选 → 审查 → 事件）
CHARACTER_ADAPTIVE_SELF_ENABLED=true       # 行为调整与注入（可**独立**关闭）
CHARACTER_ADAPTIVE_SELF_TOKENS=300         # 注入额度（缺省 0 = 不注入；硬上限 800）
```

⚠️ **两个开关是独立的**（`D19`）：`REFLECTION=true` + `ADAPTIVE_SELF=false` 是**必须可表达**的状态
（"可审查的反思，但不改行为"）—— `m11:activation:verify` 的 B1/B2 就是这条的机器判据。

## 2. 激活前核对清单（逐条有机器判据）

```text
① 代码在 `main` 上且工作树干净（本里程碑：两棵树同步、`git status` 干净）
② `m11:gates` 只读聚合：离线 **13/13 PASS**（唯一的 FAIL 是 `wp10-smoke-live`，已登记）
③ `m11:regression:verify --set=full` = **PASS 6/6**（49 道门 · 388 s）
④ `m11:activation:verify`（**生产副本**）= **PASS 9/9**（cutover / 开关独立 / 回滚 / **源未被触碰**）
⑤ 生产库**静止**且已有一份 verified 快照（INC-01：租约 → pre-open 快照 → token）
⑥ 回滚路径已在纸面走通（见 §5）
```

## 3. 激活后的**预期**行为（可观察面）

```text
· 首次调用（开库时的慢路径追赶）⇒ `cutover_preset`：边界 = **此刻**账本最大序号（`D33`，**不回判历史**）
· 之后每个有**触发**的窗口 ⇒ **一次**模型调用（无触发 ⇒ **不调用**，`D15`）
· 合法采纳 ⇒ `REFLECTION_PROPOSED` + `REFLECTION_REVIEWED`（+ 必要时 `ADAPTIVE_SELF_REVISED`）
· 调整生效 ⇒ 上下文出现 `adaptive-self` section（至多 3 条**程序模板**，可裁，优先级 44）
· trace 出现 `adaptive_self_context` 步（入模 id **只来自最终 packet**）
· 根被忘/撤回 ⇒ **当前轮**立即不注入 + 后台补一条幂等失效事件
```

## 4. 不因激活新增的主张

```text
· **不**主张"她不会编造" / "有真实人类意识" / "反思已校准为真实心理" / "root 多就必然可靠"
· **不**主张"成长有效"：消融**没有测出增益**（`L-M11-18`），且**人审明确否证**了
  "成长因果成立 / 有后续行为迁移"（八张成长卡普遍补写未证明的历史，`R-3`）
· **不**主张 Level 2 全能力通过：本里程碑只交付反思与**有限**行为调整（三槽闭集）
· **不**主张真实链已覆盖对话请求（`L-M11-21`：`dialogueRequests = 0`）
· **不**主张格式率达标：短链**FAIL 4/5** 如实保留（`L-M11-22`）
· ⚠️ **新增（人审 R-1）**：**不**主张她"不会越界"——
  实测卡17 对"调高信任数值"回答"信任我可以调"，而信任**不在**三槽闭集内；
  按 `DR-11` 不做逐句守卫 ⇒ 该边界由**事实陈述 + 行为评审**承担，不由措辞规则承担
· ⚠️ **新增（人审 R-2）**：**不**主张"她的复述有证据支撑"——
  实测她会把程序给的**根数**讲成"内容互相印证"，也会把用户的话说成自己的话
```

## 5. 风险与回滚

```text
回滚（两步，都是"删行"）：
  · 删 `CHARACTER_ADAPTIVE_SELF_ENABLED` ⇒ 注入与调整即停（`m11:activation:verify` C1：
    额度 0 ⇒ **0 个 section**，而**事件与投影保留** —— 回滚 ≠ 删数据）
  · 删 `CHARACTER_REFLECTION_ENABLED` ⇒ 慢路径不再跑（水位行保留；重新打开后从水位继续）
风险：
  · 模型调用量：只在**有触发**的窗口发生（长链实测 200 轮里 62 次 ⇒ 约 31%）
  · 延迟：长链实测 p50 **5249 ms** / p95 **14436 ms** / max **20017 ms**（打满过 20 秒期限）
  · 格式失败率：盲测 10% / 长链 17.7%（`D30` 禁止重试 ⇒ 该候选**本 job 作废**）
```

## 6. 受控执行（激活时照此走）

```text
① `m11:activation:readback`（激活前基线，真实库只读）：记录水位/事件/投影的**当前值**
② 改 `.env` 三行（**只加行，不改既有行**）
③ 受控启动一次（INC-01 状态机：租约 → pre-open 快照 → token → 开 → 干净关闭）
④ 启动后立刻 `m11:activation:readback`：应看到 **水位行出现**（= `cutover_preset` 落地）、
   事件仍为 0（首次预置不消费）—— **FIRST-USE 仍应为 NOT OBSERVED**
⑤ 真实首聊**之后**再读一次：那时才允许把 FIRST-USE 记成 OBSERVED（**不凭配置宣布**）
⑥ 全程比源目录摘要；快照本体从不打开
```
