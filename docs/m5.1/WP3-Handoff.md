# WP3 Handoff — Developer Control API

> 计划书要求的交接单。**下次 execution（WP4）先读这份**，再读
> [`WP2-Handoff.md`](./WP2-Handoff.md)（只读面暴露的接口）、
> [`M5.1-Authority-Map.md`](./M5.1-Authority-Map.md)（Control 行与禁止方向）、
> [`M5.1-Repository-Map.md`](./M5.1-Repository-Map.md)（§5 F-4 / F-11）。
> **不要重新探索仓库。**

```text
Completed WP: WP3 — Developer Control API（结论 PASS；WP3 HARD GATE = 执行结果与权威状态一致）

Changed:
  src/infrastructure/dev/control-service.ts        （新增：白名单注册表的执行壳 + 幂等端口 +
                                                     两个只读 handler + 五档的真实生产者）
  src/infrastructure/dev/http-server.ts            （改：路由表加 method / 三种 kind /
                                                     POST 体读取（64KB 上限）/ 两条控制路由；
                                                     未注入控制面时控制路由**不存在**）
  src/kernel/contracts/developer-control.ts        （改：**一处有原则的补强** ——
                                                     ControlResult.commandType: CommandType → string，
                                                     且白名单校验只对非 rejected 生效。
                                                     理由见下"Interfaces"第一条）
  scripts/kernel-tests-dev-plane.ts                （改：**追加**一条契约测试锁住上面那条补强）
  scripts/verify-m5.1-control.ts                   （新增：五档 + HARD GATE + 量具自检 + 幂等 + 四类负控）
  src/main.ts                                      （改：装配控制面并打印两条控制路由）
  package.json                                     （改：只新增 "m5.1:control:verify"）
  docs/苏沐薇-使用说明.txt                          （改：`--dev-server` 说明补上两条只读命令；已 doc:sync）
  artifacts/m5.1/control-execution-truth.json      （新增：五档快照 + 领域表前后摘要 + 交叉核对 + 量具自检）
  docs/m5.1/WP3-Handoff.md                         （本文件）
  docs/architecture/README.md                      （改：登记 m5.1:control:verify 与 WP3 文档）

Tests（全部 exit 0）:
  pnpm m5.1:control:verify → **41 通过 / 0 失败**（五档全部走真实 HTTP）
  pnpm m5.1:test           → 51 通过 / 0 失败（含新增的被拒绝结果那条）
  pnpm m5.1:query:verify   → 56 通过 / 0 失败（HTTP 层改造后 WP2 的门仍然全绿）
  pnpm kernel:test 26 · m3.5:test 30 · m4:test 243 · m4.5:test · m5:test 30 · typecheck · doc:check

Evidence: artifacts/m5.1/control-execution-truth.json
  hardGateVerdict = PASS
  五档（真实 HTTP 状态码 / 阶梯 / fingerprint 两两不同）:
    rejected                      400  rejected/none/not_attempted        reason=command_not_allowed
    accepted（dryRun）            200  accepted/none/not_attempted        handler 未被调用
    attempted（handler 抛错）     200  attempted/failed/not_attempted     error=execution_failed
    executed（核验不通过）        200  executed/succeeded/failed
    verified                      200  verified/succeeded/verified
  HARD GATE：9 张领域表前后**逐字段相同**；5 项交叉核对（执行主张 × 2 + 权威读数 × 3）**零不一致**
  量具自检：伪造"重放却声称本次执行过" → 检测器报出（detectorResponded=true）
  幂等：第一次 handler 跑了 / 重放**没跑** / 两次 fingerprint **逐字相同** / replayed=true
  禁止命令：7 个全部被拒且理由码是 command_forbidden

Known issues（四条）:
  1. **控制命令今天没有持久账本**，而且这是**有理由的**，不是遗漏：
     `character_traces.input_event_id` 是 **NOT NULL** 且语义上指向"触发这一轮的真实对话事件"
     （`migrations.ts:205`）。给一条开发者命令编一个假 input_event_id，会造出
     **指向不存在的行**的 trace —— 那正是 D-7 那次事故的形状。
     因此 `ControlResult.traceId` 今天**恒为缺省**；审计线索只有 HTTP 响应与幂等记录。
     持久账本需要一条新迁移（F-11：M5.1 不做）。
  2. **幂等存储是进程内的**（`createInMemoryControlIdempotencyStore`）。重启后同一个 key
     会再次执行。对两个**只读**命令，这意味着"多跑一次诊断"，不产生领域副作用；
     但它**不是**一条可以拿去做"重放安全"承诺的机制。端口（`ControlIdempotencyStore`）
     已经留好，持久化实现只差一条迁移。
  3. **AT3.4 今天不适用**（这是一个结论，不是省略）：两个白名单命令都是只读的，
     没有"暴露既有 mutation command"这件事。一旦有命令会改变领域状态，
     它**必须**在 `ControlCommandHandler` 里调 `ActionGateway`
     （Validation → Policy → Domain Command → Gateway → Event Ledger），
     而不是在这里写一条新的写路径（G-02 / STOP 条件 14）。
  4. **`RUN_AUDIT` 的执行账本分页如实回 `hasMore=false`**（WP2 的 Known Issue 3 在这里同样成立）。
     命令的 `execution_count` 因此是"前 100 条"的意思，而不是"总数" —— 这一点写在
     handler 的指标名里（`execution_page_has_more`）。

Interfaces exposed to next WP（WP4 直接消费）:
  · `createDeveloperControlService(options): DeveloperControlService`
      options = { characterId, handlers, idempotency?, now?, onHandlerRun? }
      → `{ listCommands(), execute(raw): Promise<ControlExecution>, idempotencySize() }`
      `ControlExecution = { result: ControlResult; report?: ControlCommandReport; replayed: boolean }`
  · `createDiagnosticControlHandler(query)` / `createAuditControlHandler(query)`
      —— 两个只读命令的实现**就是**"把 Query 面跑一遍并回报"，因此控制面没有任何自己的读取逻辑
  · `ControlCommandHandler` / `ControlCommandHandlerResult` / `ControlVerificationOutcome`
      —— 注入点：故障注入、以及未来的 mutating 命令都从这里进
  · `ControlIdempotencyStore` / `createInMemoryControlIdempotencyStore()`
      —— 幂等端口（定义在基础设施层，先例 = `MemoryStorePort`）
  · HTTP：`executeControlRequest` / `developerControlRoutePatterns` / `readBody` /
      `MAX_CONTROL_BODY_BYTES`；路由表现在有 `method` 与三种 `kind`（page / lookup / control）
  · **契约补强**：`ControlResult.commandType` 现在是 `string`，
      且 `assertControlResult` 只对**非 rejected** 的结果做白名单校验 ——
      这样"有人试图执行 RESET_KERNEL"这件事才**表达得出来**，
      而 AT3.5 的全部意义正是让那次尝试被记下来。

Do not modify（WP4–WP9 只消费，不重定义）:
  · `FORBIDDEN_CONTROL_COMMANDS` 是**禁止**清单，不是"还没实现"清单
  · `CONTROL_COMMAND_FACTS[*].mutatesDomain === false`（两个命令都是只读）
  · 五档（rejected / accepted / attempted / executed / verified）与
      `controlLadderBooleansOf` 这**唯一**的阶梯→布尔映射
  · `verification` 的四态，以及"核验失败 ≠ 没核验"
  · "**HTTP 200 ≠ executed**"这条语义（状态码由阶梯决定：rejected→400，其余→200）
  · `dryRun` 不进入执行路径、也不产出报告
  · 幂等重放**引用第一次的结论**（不改结论，只改 `evidenceOf`）
  · `allowedQueryParams` 白名单与四道闸
  · 冻结区：`contracts/{memory,trace,recall}.ts` / `migrations.ts` / `kernel/app/memory/**` /
    `memory-validator.ts` / `memory-store.ts` reducer 语义 / `infrastructure/telemetry/**` /
    `src/character/苏沐薇.ts` / prompt 基线
  · **不要为了让控制命令持久化而顺手加一条迁移**（F-11 / STOP 信号）

Next WP prerequisites（WP4 Observability / OTel Integration）:
  1. `ObservabilityStage` 里已经有 `developer_control`，而且它的 `reasonCodes`
     **就是** `CONTROL_REASON_CODES`（WP1 已接好）。WP4 要做的第一件事是
     把 `ControlResult` 映射成 span —— **不要**另造一套理由码。
  2. `ControlResult.traceId` 今天恒为缺省（Known Issue 1）。因此 AT4.3 的
     `controlCommandId` 关联**今天只能关联到命令自己的 id**，关联不到 trace。
     要么在 ADR 里如实写下这条边界，要么先解决 1（需要迁移 → 属独立里程碑）。
  3. `TelemetryPort` 已存在，`OBSERVABILITY_STAGE_FACTS` 的 4 个阶段今天
     `reasonCodes` 为空（turn / context / model / response）—— 要 emit 先回来登记。
  4. **AT4.5 的泄漏扫描要扫"导出的负载"**：本 WP 的四道负控（命令参数、
     记忆正文）证明的是 **HTTP 响应**干净；导出那条路径（OTLP）还没被扫过。
  5. 门请照本 WP 的形状写：真实 HTTP + **前后逐字段快照** + **量具自检**
     （故意注入一个假的"已执行/已核验"必须被检测器报出来）。
```
