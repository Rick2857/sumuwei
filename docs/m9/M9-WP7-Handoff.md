# M9 WP7 交接单 —— Context 注入面与开发者读回

- 日期：2026-09-27
- 分支：`feature/m7-relationship`
- 基线：`523b8fc`（WP6 收口）→ WP7 实现链 `3c55a9f` → `da48aca` → `c47e302` → `560e4c2` → 证据 `39c0e9c` / `3e8bdb7`
- 权威：计划 §732–742（WP7 任务）+ §9（表达范式与去重）+ §10（trace 与隐私）+ ADR-070 §7（D17 冻结值）§10.2（trace 细节）
- 门：`pnpm m9:context:verify` = **20/20 PASS**（runId `m9-wp7-context-20260927-39c0e9c40e9a-c2e1`，head 匹配）

## 1. 交付物

| 文件 | 内容 |
|---|---|
| `src/kernel/contracts/belief-renderer.ts` | 纯渲染器：冻结词形（D17）、≤4 组、≈400 token 预算、原子条目、disputed 原子组、同根去重、相关性过滤 |
| `src/kernel/context/sections.ts` | `SECTION_IDS.belief` + `createBeliefProvider`（priority 50 · droppable）+ `renderBelief` 钩子（两遍编译都接） |
| `src/kernel/app/turn-gateway.ts` | `buildBeliefSection` 构造器回调（召回后调用）+ `belief_context` trace 步（used 来自最终 packet）+ `BeliefSectionBuildResult` |
| `src/kernel/contracts/trace.ts` | `belief_context` kind（开放并集追加） |
| `src/kernel/contracts/observability.ts` | `belief_context: 'context'`（既有 context 阶段，不开新阶段） |
| `src/infrastructure/persistence/belief-store.ts` | `listBeliefsByStatus`（上下文面需要 active+disputed；终态不进上下文） |
| `src/infrastructure/runtime/adapters.ts` | `buildBeliefContextSection`（建档闸→状态列读→资格回查→同轮遮蔽→渲染）+ `renderBeliefReadback`（七要素读回） |
| `src/main.ts` | 两条编译路径（真实轮 + `--dump-prompt`）接 `flags.beliefEnabled`；`--inspect` 追加信念读回 |
| `scripts/m9-context-verify.ts` + `package.json` | WP7 门（20 项） |

## 2. 本轮定下的设计决策（WP8/WP9 要遵守）

1. **构造器回调而非预构建文本**（与 affect 的差别）：同根去重的判据 =
   本轮召回**实际选中**的 Memory 集合，那个集合只有网关内部（召回之后）才知道。
   `buildBeliefSection(info: {selectedMemoryIds})` 在召回后、编译前被调用；
   召回没跑 ⇒ 空集合 ⇒ 去重自然不生效（没有记忆可让），**不是**跳过信念。
2. **`usedBeliefIds` 只来自最终 packet**（§10.2）：section 被上下文预算裁掉时
   `used_belief_ids=''`、`outcome=dropped`——"计划选中"与"实际入模"是两个集合，
   trace 只认后者。
3. **四种结局**：`included` / `dropped`（上下文预算裁）/ `absent`（构造器跑了但
   零候选/未建档/一条放不下）/ `failed`（构造器抛错被网关 catch——失败关闭，
   读不到投影 = 没有可用判断）。开关关（构造器不在场）⇒ **无步**（trace 不变长）。
4. **去重只作用于 reported**：inferred 的内容 ≠ Memory 的内容，限定行会丢掉推断本身
   （计划 §9.3 的裁定在本轮落成机器判据 c0-05）。
5. **disputed 原子组算 1 条**：两侧 + 不确定标签同行呈现；上限 4 组按组计。
6. **量化器缺省 = 编译器缺省公式** `ceil(len/2)`（contracts/context.ts:419）：
   信念条目的预算口径必须与编译器裁剪口径**同一个数**，否则"渲染器说 400 内"
   与"编译器把它裁了"用两把尺子。装配层注入真实 tokenizer 之前不改这个缺省。
7. **最小 trace 面**：WP7 只加 `belief_context` 一步。计划 §10.2 提到的
   belief_evidence/proposal/validation/apply 管线步是**建议面**，属调度侧
   （WP6 已有 job/watermark 可观测），不是 WP7 的强制面——WP8/WP9 若需要
   再按需追加，不在本交接单欠账。
8. **section 的 sourceRefs = usedBeliefIds**（模型可见文本里没有任何 id）。

## 3. 门读数（20/20）

- §0 纯渲染器 8 项：冻结基线逐字节（c0-01）· 4 组上限（c0-02）·
  原子预算三条判据：完整行成对出现 / used∪dropped=全体 / 一条放不下⇒undefined（c0-03）·
  零预算/零候选（c0-04）· 去重限定行 + inferred 不去重（c0-05）·
  disputed 原子组（c0-06）· 相关性（c0-07）· 确定性（c0-08）
- §1 装配 + trace 6 项：FORMED 前置（真调度链）· section 在最终 packet
  （id/kind/priority 50）· belief_context 的 used = 最终 packet sectionRefs ·
  开关关 = 无 section 无步 · 未建档 = absent · 上下文预算裁 = dropped + 空 used
- §2 三域矩阵 3 项：三 section 并存 · 裁剪顺序**存在性扫描**
  （belief@1365 先裁 · affect 先于 relationship@1360 · 无反例；
  `droppedSectionIds` 是字母序，比不出先后——这是本轮量具修正）·
  INV-M9-05 读侧独立（affect 内容变化不改 belief 文本）
- §3 读回 1 项：origin/cutover · 信念行（状态/类别/根/依赖）· 事件流计数 · 双流 job+水位
- §4 隐私 2 项：trace 属性无命题正文 · section 文本无内部 id

## 4. 已知边界（如实列出，不假装没有）

1. **装配级同根去重未在门里端到端**：门的网关轮没接召回端口（selectedMemoryIds
   恒空），去重的**逻辑**由 c0-05 纯判据覆盖，"召回真选出 Memory ⇒ 限定行"
   的端到端链留给 WP8 e2e（需要完整召回栈）。
2. **§9.4 的领域态组合场景**（高亲密+错误归纳等五个冻结场景）是 WP8/WP9 的
   行为面；WP7 的矩阵是**优先级与预算**的机器判据（stub 渲染 + 真编译器）。
3. **`--belief-status` 没有单独 CLI**：读回挂在 `--inspect`（与 M7/M8 读回同位）。
   计划任务 4 说"用现有 query API 读回"——现有入口就是 `--inspect`，没有新开命令。
4. **BELIEF_INFERRED_SCOPE 在渲染器里未消费**（词形由谓词映射表给出）：
   留着它是为了 WP8 的 B-INFERRED 独立子开关判据；lint 不报未用导入。
5. **belief section 的 token 预算没有独立配置面**：D17 冻结 400 写在渲染器常量，
   `tokenBudget` 参数留给装配层覆盖（今天没有任何调用方覆盖）。

## 5. WP8 输入（e2e 的起点）

- 夹具链已验证：建档 → 3 合格根（2 会话）→ FORMED → 网关轮 → section + trace。
  `scripts/m9-context-verify.ts` 的 §1 段就是最小 e2e 骨架。
- WP8 要补的：B01–B48 场景 · 1×500 长轨迹 · 规模档 · **B-INFERRED 独立子开关
  在装配层的强制**（渲染器不读开关——装配层不传 inferred 候选即关）·
  召回栈在场的去重端到端 · `m9:e2e:verify` / `m9:long:verify` / `m9:scale:verify`。
- 逐改动门批次（kernel / m3.5+evals / m4+m4.5 / m9:measurement）读数见
  WP7 收口记录；最终 `m4.5:ci` EXIT 0 后还原 6 个白名单历史证据文件。
