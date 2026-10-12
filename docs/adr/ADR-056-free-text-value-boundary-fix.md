# ADR-056 — 自由文本槽位取值的**边界规则**（机构名被截成单字）修正

状态：**ACCEPTED / IMPLEMENTED**（用户已授权"只修这一条确定性规则"，且实施与门证据已落地）。
⚠️ 与 ADR-055 同一条纪律：**本文件正文不再改写**；后续若要再动取值边界，**新开 ADR**。

授权：**用户 2026-09-24 逐字裁定**——

> 「extractor（university-name → 「书/了」）= deterministic error，fix the rule only，offline repro first,
> honor frozen-zone discipline（scope change, ADR, version, related gates），
> no expansion into automatic-extraction upgrades」
> 「专业/设备 update-extraction failures are a **separate, named** problem group」

日期：2026-09-24。归属：**M6.1 / WP5**（产品发现② 的**范围内**修复）。
上游：[`M6.1-WP5-Product-Findings.md`](../m6.1/M6.1-WP5-Product-Findings.md) ·
[`M6.1-WP5-Failure-Attribution.md`](../m6.1/M6.1-WP5-Failure-Attribution.md) §4.1/§4.2 · 冻结额度 [`ADR-055`](./ADR-055-m6.1-wp4-explicit-memory-correction-and-context-facts.md) §4.1。
触发它的读数：[`WP5-Handoff.md`](../m6.1/WP5-Handoff.md) §5.4（round 1 = FAIL）。

---

## 1. 问题（一句话链，全部有实测）

```text
① 冻结条文 `evals/m6.1/control/*.jsonl` 里逐字的两句话，在生产规则抽取器下**取值错**：
     「记住：我在江城大学读书。」        ⇒ education.institution = 「书」（应为「江城大学」）
     「更正一下，我转学到明德大学了。」  ⇒ education.institution = 「了」（应为「明德大学」）
② 机制（`content-extractor.ts: extractFreeTextValue`）：**统一的**"先往后、再往前"顺序，
   把线索词「大学」**后面那一句的动词**（读书 / 了）当成了取值；
   再经 `normalizeValuePhrase` 剥掉前导系词表里的「读」⇒ 剩一个「书」。
③ 症状形态是本仓库反复登记的那一种：**不报错、长度合理、看起来像个正常的字符串**
   ⇒ 只有"值内容对不对"能发现，绝不能靠"有没有报错"。
④ 后果（可查）：`SRP-A-01` / `SRP-C-03` / `EWP-01` 三条的记忆里**没有校名**；
   其中 `EWP-01` 直接让"写入正控"程序面 9/10（期望落库值「江城大学」不在记忆列表里）。
```

## 2. 决定

| # | 决定 | 落点 |
|---|---|---|
| **D-56a** | **只修"取值边界"这一个确定性错误。** 线索词表**一个字不加**（`转学到` 不进入线索表）、槽位登记表不改、不接 LLM 回退、不动 `priority` | `src/kernel/app/memory/content-extractor.ts` |
| **D-56b** | 把"线索词是否通常是**取值的一部分**"变成**数据**（`PredicateRule.cueInValue`）。`education.institution` 置 `true` ⇒ **先试"往前"**（值 + 线索词），"往后"只作兜底；其它规则缺省不变（仍是先往后） | 同上；理由：`大学` 是名字的一部分，而 `专业`/`用的是` 是引导词 —— 这个区别来自中文语序，不是约定 |
| **D-56c** | "往前"这一支**只在它看起来像名字时**才被接受（前缀不以 `的/地/得/了/上/是/在/到/从/把/被/所/中` 收尾）。否则落到"往后"（那里通常是系词：「大学**是**示例工程科技大学」） | 同上；这条取代了"按最后一个字切"的写法 |
| **D-56d** | 取值前缀按**词组**匹配引导成分（`我在` / `转学到` / `我不在` / `毕业于` …），**不按单字** —— 单字边界会把「**上**海交通大学」的「上」当成分界，值变成「海交通大学」 | 同上（`VALUE_PREFIX_GUIDES`） |
| **D-56e** | **与"更新轮压根没抽出"分开**：`SRP-C-04`（`education.major` 的更正轮）/`SRP-C-09`（`device.primary` 的更正轮）是**线索词表未命中**（`更正一下，我转到历史学了` / `我换成 Mac 了`），**本次不修**，登记为**独立问题组** | 见 §5；归因表 §4.1 |
| **D-56f** | **版本**：新增 `CONTENT_RULE_VERSION = 'content-rules@2'`，并写进抽取结果的 `basis`（进 trace 与审计读数）。**不改** `processorVersion`（显式记忆落库仍记 `explicit-memory@1`）—— 改它会改变**已落库记录**的来源字段语义，属更大的改动，本次刻意不做 | `content-extractor.ts`；理由写在常量注释里 |
| **D-56g** | **判据**：①新增**三段式离线复现器** `pnpm m6.1:extractor:repro`（正控 7 句 / 负控①旧逻辑仍复现冻结错值 / 负控②故意写错的期望必须被判失败 / 恢复）②L1 新增**两条回归锁**（机构名取值 + `basis` 带版本）③**防顺手改坏**：复现器里放 `education.major` 与 `device.primary` 的用例 | `scripts/m6.1-extractor-repro.ts`、`scripts/kernel-tests-memory.ts` |
| **D-56h** | **冻结区纪律**：本改动落在 `src/kernel/app/memory/**` ⇒ 新 ADR（本文件）+ 版本 + 全套 `m4:*`，读数见 §4 | §4 |

## 3. 落点（逐文件）

```text
src/kernel/app/memory/content-extractor.ts
  · export const CONTENT_RULE_VERSION = 'content-rules@2'（含"为什么不改 processorVersion"的理由）
  · PredicateRule.cueInValue?: boolean（含实测缺陷原文：书 / 了）
  · PREDICATE_RULES 的 education.institution 置 cueInValue: true
  · VALUE_PREFIX_GUIDES（词组级引导成分，含"别用单字边界"的理由）
  · VALUE_PREFIX_REJECT_TAIL（"看起来不像名字"的收尾字符）
  · beforeCueValue() 抽出为一个函数（返回 value + looksLikeName，由调用方决定接受与否）
  · extractFreeTextValue(text, cue, cueInValue) —— 顺序由 cueInValue 决定
  · basis 里带上规则版本
scripts/m6.1-extractor-repro.ts       新增（三段式自证；零模型调用；不打开数据库）
scripts/kernel-tests-memory.ts         新增 2 条回归锁
```

## 4. 证据

### 4.1 离线复现（**改之前**先复现 —— 用户裁定）

```text
pnpm m6.1:extractor:repro   修复前：正控 5/7  ⇒ exit 1（关于**被测对象**的读数）
  记住：我在江城大学读书。        ⇒ 值 =「书」（期望「江城大学」）
  更正一下，我转学到明德大学了。  ⇒ 值 =「了」（期望「明德大学」）
  负控① 旧逻辑（legacyFreeTextValue）仍复现这两个**冻结 fixture** 错值 ⇒ 用例有分辨力
  负控② 故意写错的期望值 7/7 被判失败 ⇒ 比对真的在比
  恢复 PASS
pnpm m6.1:extractor:repro   修复后：正控 7/7  ⇒ exit 0
```

### 4.2 相关门（改冻结区必跑）

```text
pnpm typecheck                    EXIT 0
pnpm m4:test                      248 通过 / 0 失败（**+2** 条新回归锁；原 246）
pnpm m4:verify                    —— 见本 ADR 附的落地记录（`docs/m6.1/WP5-Handoff.md` §5.5）
pnpm m4:mutation-safety:verify    —— 同上
pnpm m4:nl-mutation:verify        —— 同上
pnpm eval:m4                      —— 同上
```

### 4.3 不回归面（复现器里逐条钉住）

```text
「记住：我在示例工程科技大学」              ⇒ 示例工程科技大学（M4 既有断言）
「记住，我现在上的大学是示例工程科技大学」    ⇒ 示例工程科技大学（取值在**线索词之后**+系词）
「记住：我在上海交通大学读书。」            ⇒ 上海交通大学（防单字边界吃掉「上」）
「记住：我的专业是汉语言文学。」            ⇒ 汉语言文学（`education.major`，先往后那一支不变）
「我学的是计算机」                        ⇒ 计算机
「记住：我平时用的是 Windows 笔记本。」      ⇒ Windows 笔记本（`device.primary` 不变）
```

## 5. 本次**不做**（边界）

```text
✗ 不碰线索词表：`转`/`换成`/`Mac` 这些**未命中**的说法仍然抽不出来（D-56e 的独立问题组）。
  ⇒ 真要做，是"抽取知识覆盖面"的独立决定（并且要考虑"规则未命中时走模型/后台"的既有立场）。
✗ 不做"线索词未命中 ⇒ 走 LLM 抽取"：`CHARACTER_MEMORY_LLM_EXTRACTOR_ENABLED` 缺省 off 是
  M4.1 的既有决定（AGENTS §3 的"被刻意关掉的开关不要顺手打开"）。
✗ 不改 `processorVersion`（D-56f 的理由）。
✗ 不动提示、不动回复守卫、不动召回/资格/排序。
✗ 不改任何冻结条文（`evals/m6.1/control/**`）—— 判据是冻结的，改的是实现。
✗ 不用本 ADR 的主张去说"发现② 已解决、WP5 可以过"：它只让**这三条**的记忆里有校名；
  round 1 的 FAIL（成功 7 < 27 · 反例违规 4）**不因此改变**，翻绿只能靠新候选从 round 1 重跑。
```

## 6. 这份 ADR 不主张什么

```text
· 不主张"中文取值边界被完整覆盖"：引导成分表与线索表一样**不完整**，且不完整是被设计允许的
  （未命中时留下一个带引导词的取值 —— 可审计、难看，而不是静默丢事实）。
· 不主张"机构名抽取从此正确"：它证明的是**这 7 句 + 2 条 M4 既有断言**符合期望。
· 不主张任何关于"她会不会编造"的性质（那是产品发现① 与回复层的事）。
· 不主张量具有效性（WP2 的事）。
```
