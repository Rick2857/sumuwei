# QQ 主动联系 —— **激活候选**（WP7）

- **日期**：2026-10-06
- **状态**：`CANDIDATE / NOT ACTIVATED`（**生产激活需独立授权**，先例 ADR-048/065/067/071）
- **设计**：[`ADR-110`](../adr/ADR-110-qq-proactive-messaging.md)（`ACCEPTED / DESIGN FROZEN`，`D01`–`D14`）
  + [`ADR-111`](../adr/ADR-111-proactive-care-source-set.md)（`ACCEPTED / DESIGN FROZEN`，`S01`–`S07`，依据面）
- **计划**：[`QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md`](QQ-Proactive-Messaging-Execution-Plan-2026-10-06.md)
- **记录**：`WP0-Baseline` · `WP1-Croner-Probe` · `WP2-Record` · `WP3-Record` · `WP4-Decision-Record` ·
  [`WP5-Record`](QQ-Proactive-Messaging-WP5-Record.md)（本批全部工程读数都在这一份里）

---

## 0. 一句话

```text
她**没有新入站消息**时也能主动联系本人。两类能力同等优先：
  · 明确单次提醒（本人要求过的那一条到点了）—— **整链已证**（真核心 + 真协议 + 模拟 OneBot）
  · 自主关心（她自己想说点什么）—— **执行核心已证**，但**没有真模型读数、没有真 QQ 读数**
⇒ 按计划 §8「两类均通过才进入正式交付」，本候选**尚不满足正式交付条件**（见 §3 的空槽）。
```

---

## 1. 激活会改什么（**只有一处**）

```text
.env 追加（**代码缺省仍 off**）：
  CHARACTER_QQ_PROACTIVE_MODE=shadow     ← 建议**先 shadow**（完整产生选择与审计，但零外发）
  或
  CHARACTER_QQ_PROACTIVE_MODE=on         ← 真发（仍受安静时段 / 额度 / 暂停 / 撤销版本约束）

前置（**已**由 2026-10-06 的共存激活满足）：
  CHARACTER_ENTRY_SCOPED_CONVERSATIONS=true   ← 主动功能**要求**它为 true；关着 ⇒ 拒绝启动主动调度
```

⚠️ **它不会**改：全局风险上限（仍是 R1；`R2` 只由装配根给那**一项**操作、只对那一次调用生效）·
既有能力登记 · 迁移（`0014`/`0015`/`0016` 已在隔离库与真实库演练路径上过闸，**真实库尚未应用**）。

## 2. 回滚

```text
① 把 `CHARACTER_QQ_PROACTIVE_MODE` 改回 `off`（或删掉那一行）⇒ 立刻：不排期、不评估、不外发
   ⚠️ 代码缺省**就是** off ⇒ "删掉那一行"是最短的止损路径
② 已落库的意图 / 实例行 / 暂停控制**全部保留**（不删数据）：
   回滚只停行为，不改历史 —— 与 ADR-048/065/067/069/071 的既有纪律一致
③ 迁移 `0014`–`0016` **不回滚**：它们只是加表/加列（`if not exists`），
   留在库里对 `off` 档没有任何行为影响
```

---

## 3. 状态槽**必须分列**（不许合成一个总分）

| 槽 | 读数 | 依据 |
|---|---|---|
| design approval | **批准** | ADR-110 `D01`–`D14` + ADR-111 `S01`–`S07`，均 `ACCEPTED / DESIGN FROZEN` |
| implementation | **COMPLETE**（判据层 / 持久层 / 装配层 / 能力登记 / 协议 / 外壳侧） | WP1–WP5 记录 + §16–§33 |
| hard gates | **PASS**（离线）`postlv2:qq-proactive:verify` **212/0** | 见 §4 |
| 整链（**提醒**那一类） | **PASS（一次）** `postlv2:qq-proactive:chain` **11/0/1 NOT RUN** | 真核心 + 真协议 + **模拟** OneBot，全程无入站 |
| 整链（**关心**那一类） | ⚠️ **NOT RUN**（整链门跑不到那一拍：关心间隔下限 **5 分钟**，是生产防护） | — |
| 关心的**执行核心**端到端 | **PASS**（§33：`sent` + 正文交外壳 + 实例行 `dispatching`） | 真 store / 真解析 / 真复核；**模型脚本化、socket 桁接** |
| 真模型档 | ✅ **PASS 3/3**（`pnpm with-test-model pnpm postlv2:qq-proactive:live`） | ark / `deepseek-v4.1-flash`；**send 3 · silence 0 · defer 0**；越界引用 0；空依据集 ⇒ 拒（`proactive_without_source`）。三句正文见 WP5 记录 §4t |
| measurement validity（正控/负控/**差分正控**） | ✅ **PASS**（新增独立门 `postlv2:qq-proactive:measurement:verify` **15/0**）：① 正控 ② 十种负控 ③ **差分正控**（每条只改一个字段）④ 恢复档 ⑤ `measured_count=15`。**十条拒绝码互不相同**（10/10） | 覆盖关心的十条预检判据；其它链路的差分正控仍是分散的结构判据 |
| 量具有效性（本批专属） | ✅ **已成独立门**（见上一行） | 仍待办：把 §29/§30/§31/§32/§33 也收进"只改一个字段"的统一形式 |
| semantic evaluation | ⚠️ **NOT RUN**（主动联系的措辞好不好，一次都没评过） | ⚠️ 但验收材料**已就绪**：三句真模型正文见 WP5 §4t |
| live smoke（真 NapCat + 真手机） | ⚠️ **NOT RUN** | 生产外壳自带 `assertProductionAvatarEnvironment`，**那道闸不许放宽** |
| human review | ✅ **PASS**（*2026-10-06 声明式裁定*：用户就真模型档的三句正文声明「三句话看了没问题」） | ⚠️ 主张的是"这三句读起来没问题"，**不是**"措辞已过评测"。按 M8/M10.1 先例：**原机器读数 `PENDING` 不回写** |
| **production activation** | **NOT ACTIVATED** | 需独立授权 |
| 自然首用（真实环境第一次真的发生） | **NOT OBSERVED** | — |

---

## 4. 机械证据（可复跑）

```text
pnpm postlv2:qq-proactive:verify      212 通过 / 0 失败
pnpm postlv2:qq-proactive:chain       11 通过 / 0 失败 / 1 未运行（关心那一类）
pnpm kernel:test 27/0 · kernel:verify 25/0 · m3:migrate-gate 17/0 · m4:test 262/0 · m3.5:test 30/0
pnpm typecheck                        EXIT 0
真实库树摘要在本批全部试验前后**逐字相同**（`data/` 被 gitignore ⇒ 只能比摘要，不能用 git）
```

⚠️ **`pnpm m4.5:ci` 本批未跑**（**故意**）：它的 G14 会对**生产库做热复制**，而
`QQ-Live2D-Coexistence-Activation-Record.md` §5.1 要求"复制前先停服务" ——
而共存激活现在**正连着**（QQ 6751 / 皮套 6752 两条外壳）。
⇒ 按既有纪律，完整 CI 留到**下一次核心停机窗口**；替代门（上表）已全绿。
**这一条不是"忘了跑"，是"按规矩不跑"。**

---

## 5. 已知边界（本候选**不主张**什么）

```text
· **不**主张"关心已经在真 QQ 上发出过消息"：它的执行核心证了，socket 那一半**没有**
· **不**主张"措辞自然"：措辞层**没有**启发式守卫（`DR-11` 的既有立场），且一次都没评过
· **不**主张"她不会打扰你"：安静时段 / 额度 / 暂停是**闸**，不是"判断你是否想被打扰"
· **不**主张"提醒不会迟到"：`L-QQP-06` —— 单次触发的火点在**秒首**（实测早 200–862ms）
· **不**主张"候选一定被她选中"：模型可能 `silence` / `defer`（那是**合法结局**，不是失败）
· **不**主张 WP6 的矩阵：全矩阵 / 三槽量具有效性 / 逐案语义评测**都没做**
```

---

## 6. 激活前必须补的（建议顺序）

```text
① **真模型档**：`with-test-model` 下跑一次主动联系（提醒 + 关心各一条），
   看 `send` / `silence` / `defer` 三种结局在真模型下各出现几次、措辞像不像她
   ✅ **2026-10-06 已做**（`postlv2:qq-proactive:live` PASS 3/3，三句正文见 WP5 §4t）
② **人审**：把①里她真的说出口的句子拿给你看（这是本批**唯一**无法由机器替代的一步）
   ⏳ **材料已就绪** —— 三句都在 WP5 记录 §4t 里
③ **WP6 矩阵**：离线全矩阵 + 量具有效性（正控/负控/**差分正控**三件套）
④ **真 NapCat + 真手机**：在一个**你愿意被主动联系**的时间窗里做一次（并先记下你希望的安静时段）
⑤ 才轮到"要不要 `on`"这个裁定
```

⚠️ **①②③ 我可以做；④ 需要你在场；⑤ 必须你签字。**
⚠️ ① 的一个**真发现**（`L-QQP-10`）：给足依据时模型 **3/3 都选 send**，`silence`/`defer` 一次没出现
⇒ "她会不会忍住不说"**不能**靠模型自律，真正兜着的是**程序闸**（安静时段 / 额度 / 冷却 / 暂停 /
无人回应）—— 那些判据都有独立负控。**3 个样本不是比率。**
