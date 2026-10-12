# ADR-063 — B② 槽位限定更正兜底（correction-fallback@2）

- 状态：`ACCEPTED / DESIGN FROZEN`（2026-09-25）
- 裁定：用户当轮选定「B② 槽位限定抽取兜底」（备选 = 接受为已知局限 / 改目标解析器登记表，均被否）
- 前置：ADR-058（B① 目标层兜底，`correction-fallback@1`）
- 影响面：`src/kernel/app/memory/correction-fallback.ts` · `src/kernel/app/memory/explicit-service.ts`

## 0. 问题（实测缺口，引文级留痕）

候选 `59493d58e9ef` 四轮（2026-09-25，第七条 + point-match v2 + 传输重试三合一）发现
SRP-C-05 的更正**四轮全不落库**——活体记忆永远只有旧值
（`education.status = undergraduate`），成功轮全靠对话近因答对。全链确定性复现：

```text
「更正一下，我读研究生了。」
  ① 意图检测：句首「更正一下」⇒ correct ✓
  ② 主路径目标解析：「我读研究生了」与旧值「本科生」零词面重叠 ⇒ not_found
     （与 ADR-058 §0 的 SRP-C-04/C-09 同型）
  ③ B① 兜底：目标 = 会话内唯一槽位 education.status ✓；
     但取值靠冻结闭集转换标记「换成/转到/改成/改为」（D-58c）——
     C-04「转到历史学了」✓ · C-09「换成 Mac 了」✓ · C-05「读研究生了」**无标记** ⇒ undefined
  ④ ⇒ 诚实失败（不写不撤）——失败方向安全，但更正永远落不了
```

离线抽取审计能抽出 `graduate`（`via: 'extractor'`）是因为审计只测**内容抽取器**
（「研究生」→ education.status=graduate 规则在）；活体 `correct()` 先解析目标，
走不到抽取器。审计与活体的分叉是**设计内**的（审计量的是抽取能力，不是写入结果）。

同批附带定性（不属本 ADR 修复范围）：
- A-10/C-10（学号）无槽位 = 设计内（量具按对话近因判，依据桶「不适用(对话近因)」）；
  她的「没存上」是诚实保守，非缺陷。
- C-01~C-04 / C-06~C-09 的更正**全部落库正确**（新旧并存 = M4 语义）。

## 1. 决策（D-63a）

B① 标记取值失败**不是终点**：追加 **B② 槽位限定抽取闸**——用本服务绑定的抽取器
（生产 = 规则抽取器，确定性）跑一遍更正句，**仅当**抽出的内容是
「claim ∧ predicate === 目标槽位」才采用其值走同一替换序列。

```text
correctViaRecentWrite（B① 闸门全部继承：intent=correct ∧ not_found ∧ 端口接线 ∧ 恰一槽位）
  ├─ B① extractCorrectionValue（标记取值 + 四道守卫）—— 逐字不变，仍先试
  ├─ B① 失败 ⇒ B②：extractor.extract(更正句) → slotRestrictedCorrectionValue(抽取结果, 目标)
  │    · claim ∧ predicate === 目标槽位 ∧ 值非空 ⇒ 采用（basis 标 B② 路径 + 槽位，不含取值正文）
  │    · episode / 别的槽位 / undefined / 抛错 ⇒ 一律 undefined
  └─ 仍 undefined ⇒ 维持诚实失败（不猜、不写、不撤；D-58e 不撤语义继承）
```

## 2. 为什么这样是安全的

- **槽位闸就是全部语义**：目标槽位已由 B① 选靶确定（会话内恰好一个）；
  B② 只接受"抽取器也认为这句话在说**那个槽位**"的读数。
  「更正一下，我把闹钟换成七点了。」对 device.primary 抽不出任何 claim
  （闹钟/七点不在任何规则表）⇒ 照旧诚实失败。
- **不经过全局写入**：抽取结果只贡献"值"，槽位仍来自目标记录（与 B① 同构）；
  落库仍走唯一写入路径（放行口 → 领域事件 → 投影折叠）。
- **负向守卫继承**：抽取器自己的 negativeGuards（「不吃辣」⇒ 回避辣）在
  `extract()` 里已跑过，B② 不重复也不绕过。
- **失败方向安全**：抽取抛错 / 无结果 / 槽位不匹配 ⇒ 一律回到诚实失败。
  B② 让"落库"多了一条窄路，没有让"不落库"变窄。

## 3. 误伤面与负控（neg-b2-slot-mismatch）

前置 `device.primary = Windows 笔记本` 时说「更正一下，我读研究生了。」：
抽取器抽出 `education.status = graduate`——**别的槽位** ⇒ 闸拒绝 ⇒ `target_not_found`，
不写。这条负控进服务层复现器（`m6.1-update-turn-service-repro@3`），
与 ADR-058 §3 的四条误伤负控同列。

## 4. 版本与证据

- `CORRECTION_FALLBACK_VERSION`：`correction-fallback@1` → **`@2`**（解析知识变更，按纪律升版本；
  落库仍记 `explicit-memory@1`，D-58g 不变）。
- 纯函数锁：`kernel-tests-memory.ts` 新增 B② 正控（C-05 形状）+ 负控
  （undefined / episode / 槽位不匹配 / 空值）；B① 全部行为锁逐字保留。
- 服务层复现：`m6.1-update-turn-service-repro@3` verdict = **FIXED**
  （冻结三条 C-04/C-09/**C-05** 全部"新值 active ∧ 旧值 superseded"；
  负控 8/8；恢复 PASS；真实库树摘要未变）。
- 门：typecheck 0 · m4:test 258/0 · m4:verify 0 · m4:mutation-safety:verify 20/0 ·
  m6.1:test 284/0 · kernel:test 26/0 · Live Smoke（见提交证据）。

## 5. 不主张什么

- 不主张"所有无标记更正都能落"：抽取器没有规则的值（如「我换工作了」——
  occupation 无槽位）仍诚实失败；扩规则表 = `CONTENT_RULE_VERSION` 升版，另行裁定。
- 不主张 WP5 因此通过：效果由下一次新候选判定轮测量（C-05 的活体记忆应出现
  `graduate`；读数不得回填）。
- 不改 B① 的任何行为；不改审计件（`m6.1-extraction-audit` 的 via 标签是信息性的，
  基分类不变，不重开量具面）。
- RCE-02（「你说过的又不止一件」虚构复数性）按同轮用户裁定**接受为已知局限**
  （DR-11：措辞层无启发式守卫；#6/#7 双点名后仍生成），不在本 ADR 射程内。
