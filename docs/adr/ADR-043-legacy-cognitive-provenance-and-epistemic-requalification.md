# ADR-043 — 重定向

```text
状态      : **REDIRECT**（本文件不承载任何判据）
ADR-043 的**唯一权威** = docs/adr/ADR-043-epistemic-requalification.md
                        （状态 `ACCEPTED / DESIGN FROZEN`）
产生原因  : 2026-09-19 ADR-043 批准落地时，**两个文件名**同时承载了同一份 ADR。
            本仓库明令禁止"同一概念两处权威"（两套方言），因此收敛为一个：
            保留短 slug（与 `ADR-042-attribution-model.md` 的命名一致），
            把长标题的这一份改为**重定向**。
```

**唯一权威**：[`ADR-043-epistemic-requalification.md`](ADR-043-epistemic-requalification.md)

```text
它包含      Context（Q1/Q2/Q3 三分与 D01 的根因）
            12 条已批准裁定 DR-1…DR-12 + 用户批准记录（A-1…A-5）
            Inspect 实测读数（代码面 / 语料面 / **尚未测量**的爆炸半径）
            Design（MemoryQualification · 派生函数 · 九行效果矩阵 · 与 INV-CI-01…05 的关系）
            Landing（`4-preflight` / `4a` / `4b` · 正控负控恢复三段式 · 激活与回滚）
            Consequences · Limits（L-1…L-8）· Alternatives（ALT-1…ALT-12，逐条否决理由）
```

**当前状态**（与权威文件 §8 一致）：

```text
ADR-043        ACCEPTED / DESIGN FROZEN
Phase 4        NOT RUN（当前仅授权**只读**的 `4-preflight`；`4a` / `4b` 待用户另行放行）
M5.1-D01       **P1 OPEN**（ADR 批准 ≠ 关闭；关闭需 4a + 4b + Live Smoke 观察 + 用户批准）
M5.1.1 Final   **BLOCKED**
```

**落地顺序（`DR-8`）**：`4-preflight`（只读，出精确影响清单 + 夹具改造方案 + 量具有效性证据，
完成后 **STOP**）→ `4a`（形成期）→ `4b`（存量与行为）。
`4-preflight` 不得改 `src/**`、不得改测试判据、不得打开或修改真实库。
