# QQ × Live2D 双入口共存 —— 交付判定（WP5）

日期：2026-10-06（UTC+8）。状态：**WP0–WP5 的准备面全部交付；生产切换尚未执行（需逐字授权）**。

计划：[`QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md`](QQ-Live2D-Coexistence-Execution-Plan-2026-10-06.md)。
设计：[`ADR-109`](../adr/ADR-109-qq-live2d-dual-entry-coexistence.md)（`D01`–`D09` 冻结 + `D10` 追加节 = 备用路线）。
激活候选：[`QQ-Live2D-Coexistence-Activation-Candidate.md`](QQ-Live2D-Coexistence-Activation-Candidate.md)。

---

## 0. 十个状态槽（**分列，不合成一个"安装成功"的总分**）

| # | 槽 | 状态 | 依据 |
|---|---|---|---|
| 1 | **现成方案兼容**（AstrBot + lxfight Live2D） | **不采用**（24 项矩阵：13 通过 / 3 对 LG 失败 / 8 未运行或不适用） | [`WP1`](QQ-Live2D-Coexistence-WP1-Compatibility-Trial.md) |
| 2 | **共享核心** | **PASS** | 公共生命周期只跑一次（`E-0b`）· 关系基线只建一次档（`R-9`）· 一个库持有者 |
| 3 | **文字隔离** | **PASS** | 每轮 trace 引用的对话事件**外来 0 条**（夹具档 `R-5` + 真实模型档 `L-4c`）· 回复/取消按入口归属 |
| 4 | **语义记忆** | **PASS** | 写侧一次（`R-7`）· 真实模型档**读侧**召回命中（`L-6`） |
| 5 | **媒体交付** | **协议面 PASS**（合成账 / 播放账被交付账受理 · 三态取消读数） | `postlv2:coexist:shells` `W-4`/`W-5`；**真实音频 NOT RUN**（`W-10`） |
| 6 | **异常恢复** | **PASS** | 坏 JSON / 模型失败 / 两侧断开 / 稳定重启（`S6`/`S10`/`S11`） |
| 7 | **工程回归** | **PASS** | `pnpm m4.5:ci` **EXIT 0**（见 §3） |
| 8 | **真人体验** | **外壳已在生产运行，真人体验 NOT OBSERVED** | 皮套外壳已起（`LG_AVATAR_READY http://127.0.0.1:12394`、ASR/TTS 已初始化），但**没有真人试过**；计划 §5 场景 12 |
| 9 | **生产激活** | **ACTIVATED（2026-10-06）** | 载体 [`激活记录`](QQ-Live2D-Coexistence-Activation-Record.md)；授权 = 用户当轮指令「进行生产激活」 |
| 10 | **自然首用** | **NOT OBSERVED** | 等本人第一轮真实 QQ / 皮套往返（激活记录 §6 列了四个观察项） |

⚠️ 第 5 槽**必须分列**读：**协议面 PASS**、**真实音频 NOT RUN**。把后者并进前者就是把"没跑"说成"通过"。

---

## 1. 交付物索引（计划 §7 的九项）

| 计划要求的交付 | 落点 |
|---|---|
| 采用路线与版本清单 | [`激活候选`](QQ-Live2D-Coexistence-Activation-Candidate.md) §1 |
| 追加 ADR | [`ADR-109`](../adr/ADR-109-qq-live2d-dual-entry-coexistence.md) |
| 实现及运行脚本 | `--coexist`（`src/main.ts`）· `FairTurnScheduler` · 两条外壳的**连接档** · `scripts/coexist/{readiness,supervise,stop,fingerprint}` |
| 双入口作用域表 | [`WP0 §5`](QQ-Live2D-Coexistence-WP0-Baseline.md)（共享 / 分入口逐项带代码坐标） |
| 隔离整链与回归证据 | `artifacts/post-lv2/{coexist-wp2-verify,coexist-wp4-matrix,coexist-wp4-live,coexist-wp3-shells}-*/result.json` |
| 体验 / 性能记录 | [`WP4 §2`](QQ-Live2D-Coexistence-WP4-Scenario-Matrix.md)（单入口 390ms vs 双入口 749ms，排队 336–348ms）· 体验 **NOT RUN** |
| 限制清单 | `L-COEXIST-01…10`（WP2/WP3/WP4 各册） |
| 激活候选 / 激活记录 | 候选已出；**激活记录待授权后另立**（先例 ADR-048：只做状态修订） |
| 回滚说明 | [`激活候选 §8`](QQ-Live2D-Coexistence-Activation-Candidate.md) |

## 2. 运行时命令（本里程碑新增，全部**缺省不动生产**）

```bash
pnpm postlv2:coexist:verify    # WP2/WP3 整链（33 PASS + 3 观察；量具三段式）
pnpm postlv2:coexist:matrix    # WP4：计划 §5 的 12 场景 + 性能
pnpm with-test-model pnpm postlv2:coexist:live   # WP4：真实模型档（语义写入 + 跨入口召回读侧）
pnpm postlv2:coexist:shells    # WP3：**两条真外壳**用连接档连共享核心（14 PASS + 2 NOT RUN）

pnpm coexist:prepare           # WP5：生成入口令牌（gitignore）
pnpm coexist:check             # WP5：只读就绪判据（当前如实报"不就绪"）
pnpm coexist:start             # WP5：正式切换（**需逐字授权**；实测无授权 ⇒ 退出码 2）
pnpm coexist:stop              # WP5：有序停机（写停机哨兵）
node scripts/coexist/fingerprint.mjs   # WP5：激活候选的源码指纹
```

## 3. 工程回归读数

| 门 | 结果 |
|---|---|
| `pnpm typecheck` | **EXIT 0** |
| `pnpm m4.5:ci` | **EXIT 0**（`artifacts/post-lv2/local/coexistence-wp4/m4.5-ci-final.log`） |
| `pnpm postlv2:transport:verify` | **PASS**（78 项；连接档改动之后复跑） |
| `pnpm postlv2:expression:verify` | **PASS**（11/11） |
| `pnpm qq:verify` | **PASS**（旧形态未受影响） |
| `pnpm m5.1.1:wp6.1:verify` | **119 通过 / 2 失败** —— 两处失败与本次无关（schema v9 / 迁移 1..9 的断言不适用于当前 v13；QQ 接入时已是同一读数） |

## 4. 生产库

**从未被打开**：整轮所有试验的树摘要 `268af1eb8d8fb81db4e1b0ec7616df4e677fc190142f6a121220ad6288e40e25`
（1250 文件）**逐字相同**。生产 QQ 入口在这期间一直按**旧形态**运行（本里程碑没有重启它）。

## 5. 下一步（**都需要人**）

```text
① 真人体验（计划 §5 场景 12）：外壳**已经起来了**（12394 入口 + ASR/TTS 已初始化），
   现在只差你说一句 —— 读数补进 [`激活记录 §6`](QQ-Live2D-Coexistence-Activation-Record.md)。
② 生产切换 —— **已于 2026-10-06 执行**（用户指令「进行生产激活」）：
     · `.env` 追加了 `CHARACTER_ENTRY_SCOPED_CONVERSATIONS=true`（**代码缺省仍是 false**）
     · 旧 QQ 入口已**有序停掉**（Ctrl+C 路径 ⇒ post-close verified 快照在案）
     · 共存核心 + 两条外壳已起（`COEXIST_READY` · QQ OneBot 已连 · 皮套 12394 就绪）
     · **单持有负控**：核心持有期间再要租约被拒（`production_db_in_use`）
   回滚 = `pnpm coexist:stop` → `pnpm qq:start`；或删 `.env` 那一行再起旧入口。
```

## 6. 激活之后**立刻**变的四件事（已发生）

```text
① QQ 的近期窗口现在是 `dm-sumuwei-b8ec0760-qq`、皮套是 `…-avatar`（各自从零开始）
② 旧混合历史 `dm-sumuwei-b8ec0760` 仍在账本里（`--history` 看得到），但**不复制**到两条新会话
③ 生产 QQ 入口从"自己持有一个库"变成"连到共享核心"（127.0.0.1:6751）
④ 皮套外壳也从"自己起 LG 子进程"变成"连到共享核心"（127.0.0.1:6752）
```

⚠️ 真实库的**非易失内容一个字节都没变**：激活前（旧入口 post-close 快照）与
激活后（核心 pre-open 快照）的非易失树摘要**逐字相同**
（`1c0490ab4c09888d8803f8220c58c0188c4d436c1341ec5bc9c56bb17f82cc87`，1249 文件）。
变的只有被摘要排除的 `postmaster.pid`。
