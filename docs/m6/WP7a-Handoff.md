# WP7a Handoff —— A–E 自然语言剧情 + 摘要/召回跨模块

```text
Completed WP:            WP7a（M6 / Lv1 Hardening）
Commit / branch:         <见提交后的 git log> / feature/m6-lv1-hardening（= main）
Changed files:
  scripts/verify-m6-wp7a.ts                          新增：WP7a 门（A–E 五类剧情 12 项断言 + 4 条必跑子门 + Z1）
  scripts/m6-evidence.ts                             登记 `wp7a-e2e`（必选门；`m6:gates` 变 9 道）
  artifacts/m6/m6-wp7a-20260921-421e2081066f/e2e.json 新增（本门证据；**本次未重生成任何历史证据**）
  docs/m6/WP7a-Handoff.md                            本文件

User-owned dirty files preserved: **原样未动、未提交**
  artifacts/incidents/inc-01/wp1-lease.json
  （本门**不跑** WP1 的门，因此该文件一个字节都没被碰过；SHA-256 仍为
    BB08C5BE9FE13FC6B739D67D00D29ED4921CB2E4D8FCD9D1B5D7F12184BA42B6）

Commands + exact exit codes:
  pnpm typecheck                                    → EXIT 0
  pnpm exec tsx scripts/verify-m6-wp7a.ts           → EXIT 0（**17/17**；子门 4/4 EXIT 0；约 150s）
  子门（逐条独立进程，本门逐条记录退出码）:
    pnpm m4:nl-mutation:verify   → 0（21s）  记住/纠正/忘掉的 NL 覆盖（含"香菜"中英键映射）
    pnpm m4.5:nl-action:verify   → 0（22s）  重复动作 · 目标含糊拒绝 · 沙箱文件写后实际读回
    pnpm m5.5:e2e:verify         → 0（18s）  搜索成功/空结果/超时 · 显式禁止联网 · 私人对象 · 来源附录
    verify-dry-run-silence.ts    → 0（3s）   干跑（`--test`）不写任何东西
  pnpm m6:gates                                     → EXIT 0（**Hard Gates = PASS**；必选门 **9** 个，未运行 0，未通过 0）
  pnpm inc-01:gates                                 → EXIT 0（**PASS 11/11**，L1/L2 + G1–G7 + L1/L2 全绿）

Evidence produced:
  artifacts/m6/m6-wp7a-20260921-421e2081066f/e2e.json
    （schemaVersion `m6-wp7a-e2e@1`：A–E 五类剧情的读数 · 4 条子门退出码 ·
       **itemCoverage 映射表**（计划书 §WP7 的每条附加要求各由哪条读数承载）·
       真实库前后摘要 · 顶层 `passed/failed/measurementInvalid`）
  场景全部跑在 `isolateDatabase()` 的**合成隔离库**上；用户侧是**真的自然语言**
  （生产显式记忆轮次端口 `createExplicitMemoryTurnPort` + 真 `TurnGateway` + 规则抽取器），
  不是"内部 API 假装用户说话"。

Real data/pglite digest before / after:
  8307173d8b8f12df818008e05356e2ad6df4a56e598347d039650919f39aa4d4（1205 文件 / 31,584,799 字节）
  ⇒ 本门运行前后**逐字相同**（Z1）；与 WP0 基线的关系按"漂移有据"判
  （共用 `scripts/inc-01-real-db-drift.ts`：verified 快照 11 份、cleanClose 的 owner record 1 条、
   孤儿 manifest 0 份）。**本门没有打开真实库**。

Measurements and measured_count:
  真实库 measured_count = 1205（> 0）
  摘要读数：A `rollupBytes=634`、E `rollupBytes=275`、D 那一轮 sections 含 `external-evidence` + `rolling-summary`
  机制读数：A/E 的 `rollup_rejected_invalidated = 1`（**选择阶段**因"根记忆已非 active"拒掉的源条数）
  零命中自检：A2 同时要求"新声明**在**块里"（正控）与"旧声明**不在**"（负控），
  单靠"永远不摘要"过不了这一条（`rollupBytes > 0` 是硬前提）

Positive / negative / recovery controls:
  A 一周式变化：告知（written，active 0→1）→ 两轮闲聊间隔 → 撤回旧值 + 记新值（written）
      正控：新值活跃（`food.preference.cilantro=like`）
      负控：旧值**不在**活跃集合里，但**仍在历史里**（`memories=2 / active=1 / retracted=1`）
      机制：摘要块含"记住，我吃香菜"原声明、**不含**"记住，我不吃香菜"原声明，
            且 `invalidated_by_memory_state = 1`（旧源是被**拒**的，不是没被扫到）
  B 错误与修正：受支持陈述 ⇒ 真的写入（active +1，不是只回一句"好的"）；
      不可解析陈述 ⇒ **具名拒绝** `not_written/content_unresolved`，active 不变（写入与拒绝可区分）
  C 假设与虚构：`假如我住在东京` ⇒ `no_intent`、active 不变（假设不形成事实）；
      **Assistant Fact Firewall**：先生成"我去过东京、住了半年呢"的回复，再查库 ——
      memories 0→0、记忆里查不到"住了半年"
  D 污染与来源：显式搜索那一轮**真的执行**（动作表 0→1 行，且该轮 sections 里有 `external-evidence`）；
      **外部证据不落库**（`memory_records` 表摘要逐字节相同 + 记忆里查不到哨兵正文）；
      隔几轮再问 ⇒ 当轮上下文里**没有**那条证据（它只活在被执行的那一轮）
  E 遗忘：记住 → 忘掉 ⇒ 不再是活跃记忆（`active=0`、`retracted=1`）、
      摘要不再选它（声明原文不在块里，且 `invalidated_by_memory_state = 1`）、
      **边界单列**：原始用户事件仍在账本（可审计，遗忘 ≠ 抹掉账本）
  Z1 真实库只读摘要前后逐字不变 + `measured_count > 0`

Deviations or NOT RUN items:
  1. **判据按"实际存储形状"写，而不是按中文原句写**（本门第一次跑红的三条，都是这个原因）：
     `activeValues()` 给出的是 `predicate=value`（`food.preference.cilantro=dislike`、
     `education.institution=上学`），**不是**用户原话。第一版断言用
     `includes('示例工程科技大学')` / `includes('不吃香菜')` 去测它 ⇒ 假红。
     改成对**结构化值**断言（`cilantro=like` / `education.institution=`）。
  2. **"摘要里没有旧值"这句话，不能用 Chinese 子串测**（本门第二次跑红的原因）：
     **忘掉那句指令本身**（`忘掉我不吃香菜这件事`）也是一条**无记忆挂载**的用户事件，
     按 `classifyRollupSource` 的规则它**合法地**进摘要（`rootMemoryStatuses` 为空 ⇒
     失效闸不触发 —— 这是设计，不是缺陷）。于是 `includes('我不吃香菜')` 为真，
     但为真的原因是**指令**，不是被撤回的**声明**。
     修正后判据取"那条声明的原文"（`记住，我不吃香菜`，与指令文本不同形），
     并加了一条机制级读数 `rollup_rejected_invalidated ≥ 1`（见 `AGENTS.md` §6.2）。
  3. **`m6:gates` 的 `rollup_no_positive_example` 假红（证据形状错位）**：
     `readLandedEvidence` 只读**顶层** `passed` / `failed` / `measurementInvalid`，
     而 WP6b/WP7a 把它们放在 `measurements` / `checks` 里 ⇒ 汇总读成 `passed = 0`
     并打出"一条正控都没过，却声称有结论"。这是**假红**（同型教训见 `AGENTS.md` §6.9：
     数字对 ≠ 数字描述的是你以为的那个东西）。两个门的写出口都补上了顶层计数；
     WP7a 证据已按新形状重生成（`passed=17`），WP6b 在本次一并重跑刷新。
  4. **夹具必须落在规则抽取器支持的范围之内**（计划书 §WP7 明文要求）。实测支持的写法
     （逐条跑过临时探针）：`记住，我不吃香菜` / `记住，我吃香菜` / `记住，我是大学生` /
     `记住，我在示例工程科技大学上学` / `记住，我不吃辣`；
     反向操作：`忘掉我不吃香菜这件事` / `忘掉我在示例工程科技大学上学这件事`；
     不支持：`我最近开始学 Rust 了`（`no_intent`）、`记住，我可能会搬到成都`（`content_unresolved`）、
     `记住，我平时主要用 VS Code`、`记住，我养过一只鹦鹉`、`记住，我住在成都`（均 `content_unresolved`）。
     ⇒ "修正"用受支持的两步表达：**先撤回旧值、再记新值**。
     ⚠️ 同一谓词换值**不会**自动 supersede（`我吃香菜` / `我不吃香菜` 是两条不同 claim）——
     这正是 A 场景要显式测的东西。
  5. **被重新生成的历史证据按白名单还原**（只还原本门子门会重写的那几个路径）：
     `artifacts/m4.1/nl-mutation.json`、`artifacts/m4.5/nl-action.json`。
     **未**对 `artifacts/` 做无差别 checkout。
  6. **NOT RUN（本门未覆盖，留给 WP7b/WP8+）**：
     跨午夜 · 同轮"记忆 + 搜索 + 摘要"预算竞争 · 本地评审包（`review-packet.json`）·
     1k→10k 规模与检索上界 · 50/100/500 轮 · Live · 发布与盲审。
     证据里的 `itemCoverage` 逐条写明每条要求由**哪条读数**承载，避免"两套判据互相冒充"。

Root-cause status: 与 INC-01 无关（本门不碰真实库的写路径）；INC-01 根因仍是 `PARTIAL`。
```

---

## 下一步（不自动开工）

`WP7b — 跨午夜 + 同轮预算竞争 + 本地评审包`：喂一条跨越 `00:00` 的会话（真实时钟注入，
不假装"等了一天"）· 在同一轮里让**记忆 + 搜索 + 摘要**争同一份额度并如实记录谁被裁 ·
产出 `review-packet.json`（给本地人工评审的只读包：每例的输入、回复、读数与理由码）。
