# ADR-037：观测后端边界（Langfuse / OpenLIT / Phoenix）

- 状态：**已采纳**（M5.1 WP6，2026-09-17）
- 里程碑：M5.1（OSS Integration Audit）
- 相关：ADR-005（内部 trace 契约）、ADR-036（观测端口边界）、
  `docs/m5.1/M5.1-OSS-Audit.md` §1、`artifacts/m5.1/oss-spike-otlp.json`
- 裁定：**Langfuse = ADAPT** · **OpenLIT = REFERENCE** · **Phoenix = ADOPT（保持现状）**

---

## 1. 背景与实测

我们的观测出口是唯一的 `TelemetryPort`（noop / phoenix 两个 adapter，手写 OTLP/protobuf，
零第三方 SDK —— 见 ADR-005 / ADR-036）。

AT6.1 要评估 Langfuse / OpenLIT。**协议级 spike 已跑**（`pnpm m5.1:spike:otlp` → PASS）：

```
一个只认 OTLP 规范的本地接收端（不认识 Phoenix、也不认识我们）
  ← 真实导出路径（createPhoenixTelemetry + 真 fetch）
  验收：POST /v1/traces · application/x-protobuf · trace_id 16B · span_id 8B ·
        service.name + session.id · name · start_time_unix_nano(fixed64)
  两种编码：protobuf ✅ / JSON ✅
  量具自检：错 Content-Type → 415 · 截断 protobuf → 400
```

一手文档事实：Langfuse OSS 核心 **MIT**、自托管同镜像（Docker/Helm）、
**原生 OTLP**（`/api/public/otel`，自托管 ≥ v3.22.0）、部分企业特性需 License Key；
OpenLIT 核心 **Apache-2.0**、无限自托管、OpenTelemetry-native
（`OTEL_EXPORTER_OTLP_ENDPOINT`，默认 4318）。来源见审计 §1.3。

---

## 2. 五项解释

### Landing Target
**`TelemetryPort` 之后的"另一个 OTLP 目标"**，而不是一个新模块。
今天是 `CHARACTER_TELEMETRY_ENDPOINT` + `PHOENIX_API_KEY` 两个配置项；
指向 Langfuse 时改的是 endpoint 与 Authorization 头（Langfuse 用 `Basic <base64(pk:sk)>`）。
**不需要写代码**。

### Authority Boundary
- **观测不是权威**：`CharacterRunTrace` + `character_traces` 是业务真相，导出丢了不影响任何判断（ADR-005）。
- 第三方**不许**反向定义业务结构：`src/kernel/**` 不认识 Langfuse，也不认识 OTLP（由 `kernel:test` 的依赖方向锁守着）。
- M5.1 新增的规范分类法（`OBSERVABILITY_STAGE_FACTS`）是**我们的**词汇表；把它换成某个后端的面板约定就是 G-01 的"第二套真相"。

### Replacement Strategy
换后端 = 换 `TelemetryConfig.adapter` / `endpoint`。**替换成本**：
- 协议层：**零**（spike 已证）
- 语义层：**一张映射表** —— Langfuse 按自己的约定呈现 generation / span（我们的
  `openinference.span.kind` 是另一套约定）。缺了它，trace 会进去，但 LLM 详情视图不完整。

### Failure Isolation
`TelemetryPort` 的所有导出都是 **fire-and-forget 且永不抛**（既有纪律，`eval:telemetry`
守着"Phoenix 离线不影响角色"）。换成 Langfuse 之后这条**不变**：
后端不可用时只允许出现 `Telemetry unavailable`，绝不允许 `Character unavailable`。
超时由 `config.timeoutMs` + `AbortController` 兜住。

### Future Milestone
**M5.5 或独立里程碑**。准入判据（写在这里以免被简化成"HTTP 200"）：
1. 本机 docker 起 Langfuse，把 endpoint 指过去，跑**一轮真实对话**；
2. 判据是**面板里真的看到了那条 trace，且 `selectedMemoryIds` 与账本一致**；
3. 若做 LLM 语义映射，映射表必须与 `OBSERVABILITY_STAGE_FACTS` 对齐（**不许**新造阶段名）。

---

## 3. 备选与否决理由

| 备选 | 否决理由 |
|---|---|
| 引入 Langfuse/OpenLIT 的 SDK 作为运行时依赖 | 与 ADR-005 的决定冲突（手写 OTLP 就是为了零 SDK 依赖）；协议已经对得上，没有收益 |
| 同时接 Langfuse **和** OpenLIT | 两个同类接收端 = 两份面板、两套属性约定；收益为零、维护成本翻倍。**选一个（Langfuse），另一个记为 REFERENCE** |
| 让 Langfuse 成为 trace 的事实源 | 违反 ADR-005：后端挂了、换了，业务类型一个字都不该动 |
| 把 Langfuse 的企业特性（RBAC / 审计日志 / 服务端脱敏）当成我们的权限与脱敏 | 那三条**我们已经有**（四道闸 / 幂等审计 / AT1.4 + AT4.5）。重复拥有 = 两套判据 |

---

## 4. 后果

- **不动任何代码**（本轮 G-06），只留下一个**已验证的协议结论**与一条准入判据。
- Phoenix 仍是默认 adapter；`eval:otlp` / `eval:telemetry` 继续守它。
- 新增一条**不变更**的负债：Langfuse 的 LLM 语义映射表**今天不存在**，
  因此"接上 Langfuse"这句话现在只能说到"trace 进得去"，不能说到"面板看得懂"。
