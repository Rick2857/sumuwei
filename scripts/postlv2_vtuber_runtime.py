"""LG adapters for the pinned Open-LLM-VTuber shell; sandbox-copy by default, explicit production entry."""
import argparse
import asyncio
import base64
import hashlib
import json
import os
import secrets
import socket
import sys
import threading
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from postlv2_expression import PRESETS, checked_segments, presentation
from postlv2_voice_control import SpeechInbox

BRIDGE = None


def avatar_image_inputs(images):
    """Reuse upstream ImageData; only explicit inline PNG/JPEG input crosses the bridge."""
    if not images:
        return []
    if len(images) > 4:
        raise ValueError("一次最多支持 4 张图片")
    result = []
    total = 0
    for item in images:
        mime = item.mime_type
        data = item.data
        if mime not in ("image/png", "image/jpeg") or not isinstance(data, str):
            raise ValueError("请使用 PNG/JPEG 图片")
        prefix = f"data:{mime};base64,"
        encoded = data[len(prefix):] if data.startswith(prefix) else data
        if len(encoded) > 4 * ((8 * 1024 * 1024 + 2) // 3):
            raise ValueError("每张图片不能超过 8 MiB")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, TypeError) as error:
            raise ValueError("图片必须是有效的内联图片数据") from error
        total += len(raw)
        if not raw or len(raw) > 8 * 1024 * 1024 or total > 16 * 1024 * 1024:
            raise ValueError("图片总大小不能超过 16 MiB")
        result.append({"dataUrl": prefix + encoded})
    return result

"""
Lv4.5 / P2：**流式 partial 的共享状态**（模块级）。

⚠️ 为什么放模块级而不是塞在 `register_adapters` 的闭包里：识别器要**在启动时**载入
   （`serve()` 里），而挂载点（包装过的音频回调）在 `register_adapters` 里。
   同一个值被两处访问 ⇒ 必须有一个不依赖闭包的存放处。
⚠️ 只共享**识别器**：每个客户端各自 `create_stream()` —— 共用一条 stream 会把
   两个客户端的音频混在一起（静默串音）。
"""
PARTIAL = {"recognizer": None, "load_ms": None, "error": None, "readings": {}}
"""
Lv4.5 / `P3`：**有来源角色输出**（有限插话）的交付读数。

⚠️ 分列 `spoken` / `dropped` / `unsupported`：把"真的播了"与"收到但没法播"
   合成一个数字，就等于把"她说了"和"她没说"记成同一件事。
"""
INTERJECTION = {"spoken": 0, "started": 0, "dropped": 0, "unsupported": 0, "revoked": 0, "last_code": None,
                "last_source": None, "last_client": None}
"""
Lv4.5 / `P3`：**有来源角色输出**（有限插话）的交付读数。

⚠️ `started` 与 `spoken` 必须**分开**（这条是批量跑出来的）：
```text
started —— 开始投递（目标连接此刻已确定）
spoken  —— 投递**收尾完成**（音频确实发完、排空结束）
```
第一版只有一个 `spoken`，而 `last_client` 是在**排空之后**才写的 —— 排空最长要等 5 秒，
于是"这一段音频早就发出去了、而归属字段还写着**上一次**的连接"。批量 20 次里就撞上一次
（第 13 轮：探针收到了 2 个音频块，而 `last_client` 还是第 12 轮的连接）。

⇒ **归属**（投给了谁）必须在**开始**时记；**完成**（说完了）才在收尾时记。
把两者写进同一个字段，就等于让"她投给了谁"这个读数**最长滞后 5 秒**。
"""
INTERJECTION_TASK = {"uid": None, "task": None}
# ---------------------------------------------------------------------------
# Lv4.5 / ADR-131 `D01`：**皮套入口的主动开口**
# ---------------------------------------------------------------------------
# ⚠️ 这几格**只有读数、没有正文**（ADR-131 `D18`：`OPPORTUNITY_RESULT` 不含正文）。
#    她真说的那句话从 `CHARACTER_OUTPUT` 出去，不在这一格。
OPPORTUNITY = {"spoken": 0, "silenced": 0, "deferred": 0, "last_code": None,
               # ⚠️ LG 侧模式是 `off`（**代码缺省**）时只提示一次，不刷屏
               "capability_absent_seen": False,
               # 退避窗口内被**跳过**的次数 —— 读它就知道下面那个机制在工作
               "skipped_after_absent": 0}
# LG 侧最后一次回答 `opening_capability_absent` 的时刻（退避窗口的锚点）。
# 初值取一个很远的过去 ⇒ 第一次调用**不会**被跳过。
LAST_ABSENT_AT = {"at": -1e9}
# 最后一次**真实用户输入**的时刻（用来报 `idleMs`）。
# ⚠️ 从来没输入过 ⇒ `at` 是 None ⇒ 报 `idleMs=0` ⇒ LG 按"不够空闲"拒 ——
#    那是**失败关闭**的正确方向（"我不知道他闲了多久"不该被当成"他闲了很久"）。
LAST_INPUT = {"at": None}
# ---------------------------------------------------------------------------
# Lv4.5 / ADR-131 `D01` —— **裁定 C**（2026-10-11）：外壳自己的空闲上报器
# ---------------------------------------------------------------------------
# ⚠️ 为什么要有它（裁定 C 的第 ② 半）：`D12` ① 原本要求"**先关掉**前端的主动搭话"，
#    而那会让这条链**没有触发器**。C 的解法是：外壳**自己**按空闲计时上报 ——
#    于是前端那个开关开着也好、关着也好，功能都在。
#    两者同时上报由 LG 的**机会键（`<dayKey>T<hour>`）+ 冷却**兜住（ADR-131 `U1` / 负控 10）。
# ⚠️ 两个常量与 LG 的策略**对齐**（不是各写一份判据）：
#    · `IDLE_REPORT_FLOOR_SEC` = LG 的 `openingMinIdleMs`（3 分钟）那一档
#    · `IDLE_REPORT_TICK_SEC` 是**探测**频率，不是上报频率
# ⚠️ 它与 `chat()` 那条分支共用**同一个** `report_opportunity()` ⇒ 拼报文只有一处。
IDLE_REPORT_FLOOR_SEC = 180
IDLE_REPORT_TICK_SEC = 30
# ⚠️ LG 侧明确说"我没这个能力"（`opening_capability_absent` = 它那边模式是 `off`）时的**退避**。
#    这不引入第二个开关：它只是"别去刷一个已经明确回答过'我没有这个能力'的核心"。
IDLE_REPORT_ABSENT_BACKOFF_SEC = 900
IDLE_REPORT_TASK = {"task": None}


async def report_opportunity():
    """把"外壳现在空闲"这件**事实**报给 LG（ADR-131 `D01`）。

    ⚠️ 它**不产出任何回复**：说不说、说什么由 LG 决定；LG 真要说时经**既有**的
    `CHARACTER_OUTPUT` 出站，外壳只负责播与回执。
    ⚠️ 失败**不重试**、**不降级**：报不上去就只是这一轮没有机会（不是"她决定不说"）。
    ⚠️ 与 `D18` 一致：**回执里没有正文**（`OPPORTUNITY_RESULT` 明文不含正文）。
    """
    if BRIDGE is None:
        return
    # ⚠️ 退避（**只跳过、不等待**）：LG 侧模式是 `off` 时，连这条也不发 ——
    #    否则**前端那条路**（`allowProactiveSpeak`）会一直敲门，每次都拿到同一个答复。
    #    ⚠️ 这里**绝不能睡**：`chat()` 会调它，睡 15 分钟会把用户那一轮卡死。
    if time.time() - LAST_ABSENT_AT["at"] < IDLE_REPORT_ABSENT_BACKOFF_SEC:
        OPPORTUNITY["skipped_after_absent"] += 1
        return
    request_id = "opening:" + str(uuid.uuid4())
    at = LAST_INPUT["at"]
    idle_ms = int(max(0.0, time.time() - at) * 1000) if at is not None else 0
    packet = {"kind": "PROACTIVE_OPPORTUNITY", "requestId": request_id,
              "entry": "avatar", "idleMs": idle_ms}
    try:
        result = await BRIDGE.request(packet)
    except Exception as error:  # 报不上去 = 这一轮没有机会
        OPPORTUNITY["last_code"] = "report_failed:" + type(error).__name__
        return
    _reading = result.get("opening") or {}
    _decision = str(_reading.get("decision") or result.get("outcome") or "")
    if _decision in OPPORTUNITY:
        OPPORTUNITY[_decision] += 1
    _code = _reading.get("code") or result.get("code")
    OPPORTUNITY["last_code"] = _code
    if _code == "opening_capability_absent":
        # ⚠️ LG 侧模式是 `off`（**代码缺省**）⇒ 只提示**一次**（不刷屏），并**开启退避窗口**。
        LAST_ABSENT_AT["at"] = time.time()
        if not OPPORTUNITY["capability_absent_seen"]:
            OPPORTUNITY["capability_absent_seen"] = True
            print("[opening] LG 侧主动开口模式是 off（代码缺省）⇒ 机会报文不被受理；本条只提示一次",
                  file=sys.stderr, flush=True)
        return
    if _decision == "spoken":
        print("[opening] LG 决定开口（正文经 CHARACTER_OUTPUT 播出）", file=sys.stderr, flush=True)
    elif _code == "opening_shadow_no_emit":
        # ⚠️ `shadow` 档：整条链（含**一次真实模型调用**）都跑过了，只是不出站。
        #    这一行是"shadow 真的在跑"的目击者（**不含正文**）。
        print("[opening] shadow：整条链已跑完，但**不出站**（拿读数用）", file=sys.stderr, flush=True)


async def _idle_report_loop():
    """裁定 C 的第 ② 半：**外壳自己的**空闲探测。

    ⚠️ 自终止：桥不活着就 `return`（不留跨桥重启的孤儿任务）。
    ⚠️ **从不输入过就不报**（`LAST_INPUT["at"] is None`）："我不知道他闲了多久"
        不该被当成"他闲了很久" —— 那是失败关闭的正确方向。
    """
    try:
        while True:
            await asyncio.sleep(IDLE_REPORT_TICK_SEC)
            if BRIDGE is None or not BRIDGE.alive:
                return
            at = LAST_INPUT["at"]
            if at is None:
                continue
            if time.time() - at < IDLE_REPORT_FLOOR_SEC:
                continue
            await report_opportunity()
    except asyncio.CancelledError:
        return


def start_idle_reporter():
    """幂等启动（重复调用只留一个任务）。"""
    existing = IDLE_REPORT_TASK["task"]
    if existing is not None and not existing.done():
        return
    IDLE_REPORT_TASK["task"] = asyncio.create_task(_idle_report_loop())
"""Lv4.5 / `P3`：**掐掉正在说的插话**的投递口（`register_adapters` 造、`serve`/测试用）。

⚠️ 它是闭包里的函数，必须显式暴露出来：否则"用户抢话优先"这条判据
   在探针与门里**根本调不到**（实测踩到：`module.revoke_interjection` 不存在）。
"""
INTERJECTION_REVOKE = {"fn": None}
"""Lv4.5 / `P3`：**当前活着的连接**（有来源短句要送到这条连接上）。

⚠️ 它只在"确实有客户端连着"时才有值；没有值时如实报
   `character_output_no_live_client`，**不**把短句丢给一个不存在的连接。
"""
LIVE_CLIENT = {"server": None, "uid": None, "websocket": None}
REMINDER_CLIENT = {"uid": None, "websocket": None}
REMINDER_RECEIPTS = {}


def bind_reminder_websockets(handler_class):
    original_connect = handler_class.handle_new_connection
    original_disconnect = handler_class.handle_disconnect

    async def connect(handler, websocket, client_uid):
        await original_connect(handler, websocket, client_uid)
        REMINDER_CLIENT.update(uid=client_uid, websocket=websocket)

    async def disconnect(handler, client_uid):
        if REMINDER_CLIENT["uid"] == client_uid:
            REMINDER_CLIENT.update(uid=None, websocket=None)
            REMINDER_RECEIPTS.clear()
        await original_disconnect(handler, client_uid)

    handler_class.handle_new_connection = connect
    handler_class.handle_disconnect = disconnect


async def deliver_local_reminder(message):
    delivery_id = message.get("requestId")
    text = message.get("reminderText")
    if not isinstance(delivery_id, str) or not isinstance(text, str) or not 1 <= len(text) <= 500:
        return
    websocket = REMINDER_CLIENT.get("websocket")
    try:
        if websocket is None:
            raise RuntimeError("reminder_no_live_client")
        for key, item in list(REMINDER_RECEIPTS.items()):
            if time.monotonic() - item["at"] > 30:
                REMINDER_RECEIPTS.pop(key, None)
        token = secrets.token_urlsafe(24)
        REMINDER_RECEIPTS[delivery_id] = {"token": token, "websocket": websocket, "at": time.monotonic()}
        await websocket.send_text(json.dumps({"type": "lg-reminder", "deliveryId": delivery_id,
                                             "text": text, "receiptToken": token}, ensure_ascii=False))
    except Exception:
        REMINDER_RECEIPTS.pop(delivery_id, None)
        await BRIDGE.report({"kind": "REPORT_REMINDER_DELIVERY", "requestId": delivery_id, "deliveryId": delivery_id,
                             "deliveryStatus": "failed_confirmed", "detail": "reminder_client_unavailable"})


async def accept_local_reminder_receipt(body):
    delivery_id = body.get("deliveryId")
    token = body.get("receiptToken")
    if not isinstance(delivery_id, str) or not isinstance(token, str):
        return {"outcome": "rejected", "code": "reminder_receipt_invalid"}
    pending = REMINDER_RECEIPTS.get(delivery_id)
    if (not pending or not secrets.compare_digest(pending["token"], token)
            or pending["websocket"] is not REMINDER_CLIENT.get("websocket")
            or time.monotonic() - pending["at"] > 30):
        return {"outcome": "rejected", "code": "reminder_receipt_unbound"}
    result = await BRIDGE.report({"kind": "REPORT_REMINDER_DELIVERY", "requestId": delivery_id, "deliveryId": delivery_id,
                                  "deliveryStatus": "api_accepted", "messageId": "avatar:" + delivery_id}, wait_ms=2000)
    if result.get("outcome") == "accepted":
        REMINDER_RECEIPTS.pop(delivery_id, None)
    return result
"""Lv4.5 / `P3`：**有来源角色输出的投递口**（`register_adapters` 造、`serve` 挂）。

⚠️ 两段式的理由：`register_adapters()` 必须早于上游 import，而 `BRIDGE` 又必须晚于它
   才能建（它要 spawn LG 进程）。所以"造"与"挂"分开，避免"谁先谁后"变成一个隐式约定。
"""
CHARACTER_OUTPUT_HOOK = None

LIVE_UTTERANCE_KEY = {"key": None}
"""Lv4.5 / `P3`（中途纠正）：**当前这次开口**的不透明键（`<clientId>:<utterance>`）。

⚠️ 它在 **VAD 边界**处被记下（在开口编号 +1 **之前**），并在 `SUBMIT_TURN` 时带给桥。
   桥据此判断"晚到的证据是不是为她正在回答的这一次开口检索的" —— 那是
   「废弃未播余句 + 给纠正段」与「只插一句提醒」的**唯一**分界。
⚠️ 打字输入没有 VAD 边界 ⇒ 这个键可能还是上一轮的值或 `None`。
   所以桥侧把它当**可选**：拿不到就没有归属判断 ⇒ 一律走提醒（不猜）。
"""


class LGBridgeClient:
    """LG 桥客户端：**两种传输**，一套协议。

    ============================================================================
      post-Lv2 / ADR-109 `D01`：从"自己起一个 LG 子进程"到"连到共享核心"
    ============================================================================
    ```text
      connect is None  ⇒ spawn 一个 `--bridge` 子进程（**旧形态**：每入口一个库持有者）
      connect is {...} ⇒ TCP 连到 `--coexist` 的**这条入口的监听**（一个核心、多条入口）
    ```
    ⚠️ 两条路的**协议完全一样**（NDJSON + `turn-bridge.ts` 的受控登记表）——
      差别只在传输层。因此"外壳换一种连法"**不改任何语义**。
    ⚠️ 连过去时先发一句**传输层握手** `LG_ENTRY <token>`：入口身份由**监听端口**绑定，
      载荷里没有字段能选入口（`D02`）。
    ⚠️ `close()` 在连接档只关**这一条连接**：核心与另一条入口都不受影响（`D07`）。
    """

    def __init__(self, repo, mode="sandbox-copy", connect=None):
        self.repo = repo
        if mode not in ("sandbox-copy", "production"):
            raise ValueError("Unknown LG memory mode")
        self.mode = mode
        # post-Lv2 / ADR-109：连接档（`{"host","port","token"}`）或 None（spawn 档）
        self.connect = connect
        self.process = None
        self.socket_reader = None
        self.socket_writer = None
        self.entry_hello = None
        self._transport_closed = False
        self.ready = False
        self.pending = {}
        self.speech_queues = {}
        self.cancel_tasks = {}
        self.last_reading = None
        self.generation = 0
        self.cancelled_requests = set()
        # Lv4.5 / P3：**出站**有来源角色输出的投递口（由 `register_adapters` 装上）。
        # ⚠️ 缺省 None ⇒ 收到也如实记 `character_output_hook_absent`，**不**假装播过。
        self.on_character_output = None
        # Lv4.5 / P1：交付事实回报的**只读诊断计数**（不进任何判据、不含正文）
        self.report_reading = {"synthesized": 0, "playing": 0, "played": 0, "cancelled": 0, "unknown": 0,
                               "accepted": 0, "rejected": 0, "unsupported": 0, "last_code": None}
        # 合成账的判决（按 segmentId）：RL 的迁移表要求"先有合成事实才受理播放"，
        # 而这条合成账是**端点替客户端补的** ⇒ 它的判决必须留痕，否则"补失败"看不出来。
        self.synthesis_verdicts = {}
        self._last_synthesis_segment = None
        # Lv4.5 / P1：**取消的诚实读数**（用户抢话那条路径）。
        # ⚠️ 为什么单独记：取消是"协作式"的 —— 记下意图（requested）不等于真的停下了
        #    （stoppedBeforeModel）或已经提交（alreadyCommitted）。这三者混成一个布尔
        #    正是要避免的形态。
        self.cancel_reading = {"requested": 0, "stopped_before_model": 0, "already_committed": 0,
                               "not_requested": 0, "unsupported": 0, "last_request_id": None}
        # Lv4.5 / P2：**只读准备的诚实读数**（"发出去了"≠"LG 真的准备了"）
        self.prepare_reading = {"prepared": 0, "rejected": 0, "failed": 0, "other": 0, "last_code": None}

    async def start(self):
        if self.connect is None:
            await self._spawn_child()
        else:
            await self._connect_core()
        self.reader = asyncio.create_task(self.read_results())
        try:
            # A rejected unknown message proves transport readiness without submitting a chat turn.
            reading = await self.request({"kind": "LG_STARTUP_PROBE", "requestId": "lg-startup-probe"})
            if reading.get("outcome") != "rejected" or reading.get("code") != "bridge_unknown_message_kind":
                raise RuntimeError("LG bridge did not confirm readiness")
            self.ready = True
        except BaseException:
            await self.close()
            raise

    async def _spawn_child(self):
        """旧形态：**自己起一个** LG 子进程（每入口一个库持有者）。"""
        entry = "postlv2-bridge-production.ts" if self.mode == "production" else "postlv2-bridge-sandbox.ts"
        self.process = await asyncio.create_subprocess_exec(
            "node", str(self.repo / "node_modules/tsx/dist/cli.mjs"),
            str(self.repo / "scripts" / entry), cwd=self.repo,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)

    async def _connect_core(self):
        """连接档：连到 `--coexist` 的**这条入口的监听**，先做传输层握手。"""
        host = str(self.connect["host"])
        port = int(self.connect["port"])
        token = str(self.connect["token"])
        if not token:
            raise RuntimeError("连接档必须带 token：共享核心拒绝无鉴权的入口")
        self.socket_reader, self.socket_writer = await asyncio.open_connection(host, port)
        # 入口握手要带协议版本（ADR-146 D07）：缺版本 => 核心回
        # "protocol_version_unsupported" 并拒绝连接。
        # ⚠️ Python 侧读不到 TS 的常量，这里与 ENTRY_PROTOCOL_VERSION 同值（1）；
        #    改版本时两处必须一起改（src/infrastructure/qq/entry-handshake.ts）。
        self.socket_writer.write(("LG_ENTRY " + token + " v1\n").encode("utf-8"))
        await self.socket_writer.drain()
        hello = await self.socket_reader.readline()
        text = hello.decode("utf-8", errors="replace").strip()
        if not text.startswith("LG_ENTRY_READY"):
            raise RuntimeError("共享核心拒绝了这条入口：" + text[:160])
        self.entry_hello = text

    @property
    def alive(self):
        """传输还活着吗（两条路各自的判据；**不猜**）。"""
        if self.connect is None:
            return self.process is not None and self.process.returncode is None
        return self.socket_writer is not None and not self._transport_closed

    async def _read_line(self):
        """读一行（返回 `bytes`；EOF/断开返回 `b""`）。"""
        if self.connect is None:
            return await self.process.stdout.readline()
        try:
            return await self.socket_reader.readline()
        except (ConnectionResetError, OSError):
            return b""

    async def _send_line(self, text):
        """写一行（两条路各自的写侧）。"""
        payload = text.encode("utf-8")
        if self.connect is None:
            self.process.stdin.write(payload)
            await self.process.stdin.drain()
        else:
            self.socket_writer.write(payload)
            await self.socket_writer.drain()

    async def read_results(self):
        while line := await self._read_line():
            try:
                result = json.loads(line.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                if not self.ready:
                    print(line.decode("utf-8", errors="replace").rstrip(), file=sys.stderr, flush=True)
                continue
            if not isinstance(result, dict) or result.get("kind") not in (
                    "TURN_RESULT", "CANCEL_RESULT", "SYNTHESIS_RESULT", "PLAYBACK_RESULT", "PREPARE_RESULT",
                    # Lv4.5 / P3：**出站**的有来源角色输出（不是对某条请求的回答 ⇒ 不查 pending）
                    "CHARACTER_OUTPUT", "SPEECH_SEGMENT", "DELIVER_REMINDER_TEXT",
                    # Lv4.5 / ADR-131 `D18`：机会报文的响应（**不含正文**）
                    "OPPORTUNITY_RESULT"):
                # main.ts also logs startup/close failures on stdout; keep those visible in the console.
                if not self.ready:
                    print(line.decode("utf-8", errors="replace").rstrip(), file=sys.stderr, flush=True)
                continue
            if result.get("kind") == "DELIVER_REMINDER_TEXT" and result.get("outcome") == "generated":
                asyncio.create_task(deliver_local_reminder(result))
                continue
            if result.get("kind") == "CHARACTER_OUTPUT":
                # ⚠️ 它**没有** requestId（不是回答），因此绝不能走下面那条 pending 查表：
                #    查表会把 `('CHARACTER_OUTPUT','')` 当成某个等待者，而它谁都不属于。
                hook = self.on_character_output
                if hook is not None:
                    asyncio.create_task(hook(result))
                else:
                    INTERJECTION["dropped"] += 1
                    INTERJECTION["last_code"] = "character_output_hook_absent"
                continue
            if result.get("kind") == "SPEECH_SEGMENT":
                queue = self.speech_queues.get(result.get("requestId"))
                if queue is not None and not queue.put_nowait(result):
                    asyncio.create_task(self.interrupt(result["requestId"], "speech_backlog"))
                continue
            key = (result.get("kind"), result.get("requestId"))
            future = self.pending.pop(key, None)
            if result.get("kind") == "CANCEL_RESULT":
                # Lv4.5 / P1：取消的读数也先归档再交给等待者（与判决同一条纪律）
                self._record_cancel_verdict(result)
            if result.get("kind") == "PREPARE_RESULT":
                # Lv4.5 / P2：只读准备的判决（"发出去了"≠"LG 真的准备了"）
                self._record_prepare_verdict(result)
            if result.get("kind") == "OPPORTUNITY_RESULT":
                # Lv4.5 / ADR-131 `D18`：只归档"说不说 + 具名理由"，**正文不在这里**
                # （她真说的那句话从 `CHARACTER_OUTPUT` 出去）。
                _reading = result.get("opening") or {}
                _decision = str(_reading.get("decision") or result.get("outcome") or "")
                if _decision in OPPORTUNITY:
                    OPPORTUNITY[_decision] += 1
                OPPORTUNITY["last_code"] = _reading.get("code") or result.get("code")
            if result.get("kind") in ("SYNTHESIS_RESULT", "PLAYBACK_RESULT"):
                # ⚠️ 判决**先**归档，再交给等待者。
                # 第一版只在"没人等"时记（写在 `continue` 之后）—— 于是**被等到的**那条
                # 判决永远不进诊断面：实测 counters 里 accepted 恒为 0，而端点明明返回了
                # `outcome=accepted`。**同一件事两处看起来不一样**，正是本模块要防的形态。
                self._record_verdict(result)
            if future is not None and not future.done():
                future.set_result(result)
        self.ready = False
        for future in self.pending.values():
            if not future.done():
                future.set_exception(RuntimeError("LG bridge exited; no fallback agent is allowed"))

    def _record_prepare_verdict(self, result):
        """只读准备的判决（Lv4.5 / P2）：`prepared` / `rejected` / `failed` 分开记。

        ⚠️ 为什么必须记：`prepared` 计数只说明"我们发出去了"。若 LG 那边因为
        形状非法、没有能力或召回端口未接而**拒收**，只看发送次数会与成功一模一样 ——
        那正是本模块反复要防的"计数掩盖真相"。
        """
        try:
            outcome = str(result.get("outcome") or "unknown")
            self.prepare_reading[outcome if outcome in self.prepare_reading else "other"] += 1
            if outcome == "prepared" and isinstance(result.get("prepare"), dict):
                recall = result["prepare"].get("recall") or {}
                status = str(recall.get("status") or "unknown")
                self.prepare_reading["recall_" + status] = self.prepare_reading.get("recall_" + status, 0) + 1
            if outcome != "prepared":
                self.prepare_reading["last_code"] = result.get("code") or outcome
            # -----------------------------------------------------------------
            # Lv4.5 / P3（选项 B）：**提前检索的结局**随协议回来（`PREPARE_RESULT.lookup`）。
            #
            # ⚠️ 为什么必须走协议、不能靠桥的日志：桥的 **stdout 就是协议通道**，
            #    而本文件的 reader 在 ready 之后**丢弃**任何非协议行
            #    （见 read_results 里两处 `if not self.ready`）。于是桥里 `logger.info`
            #    写的诊断在生产里**读不到** —— 实测我据此误判"那个分支根本没跑"。
            # ⇒ 结局分列记：`lookup_found` / `lookup_not_found` / `lookup_rejected` / `lookup_failed`。
            #    缺这条字段 = **这次准备没发起检索**（与"发起了但没查到"分得开）。
            lookup = result.get("lookup")
            if isinstance(lookup, dict):
                status = str(lookup.get("status") or "unknown")
                self.prepare_reading["lookup_" + status] = self.prepare_reading.get("lookup_" + status, 0) + 1
                if status != "found":
                    self.prepare_reading["lookup_last_code"] = lookup.get("code") or status
                    if lookup.get("detail"):
                        self.prepare_reading["lookup_last_detail"] = str(lookup["detail"])[:200]
            # -----------------------------------------------------------------
            # Lv4.5 / P3（中途纠正）：**用户更正**那条路的读数（`PREPARE_RESULT.correction`）。
            #
            # ⚠️ 为什么 `superseded` 必须记：验收行要的是"**旧余句失效**"，
            #    而那是一个**可数的**事实（作废了几段）。只看得见"她说了纠正段"
            #    说明不了余句真的失效了 —— 那正是"计数掩盖真相"的反面用法：
            #    这里要的是**能反证**的读数（0 = 当时没有未播余句）。
            # -----------------------------------------------------------------
            correction = result.get("correction")
            if isinstance(correction, dict):
                self.prepare_reading["correction_count"] = self.prepare_reading.get("correction_count", 0) + 1
                superseded = correction.get("superseded")
                self.prepare_reading["correction_last_superseded"] = superseded if isinstance(superseded, int) else None
        except Exception as error:
            self.prepare_reading["last_code"] = "prepare_read_error:" + type(error).__name__

    def _record_cancel_verdict(self, result):
        """把桥返回的**取消读数**分列记进诊断面（三个布尔绝不合并成一个）。"""
        try:
            payload = result.get("cancel")
            if not isinstance(payload, dict):
                if result.get("code") == "cancel_capability_absent":
                    self.cancel_reading["unsupported"] += 1
                return
            self.cancel_reading["last_request_id"] = str(result.get("requestId") or "")[-12:]
            if payload.get("requested"):
                self.cancel_reading["requested"] += 1
            else:
                self.cancel_reading["not_requested"] += 1
            if payload.get("stoppedBeforeModel"):
                self.cancel_reading["stopped_before_model"] += 1
            if payload.get("alreadyCommitted"):
                self.cancel_reading["already_committed"] += 1
        except Exception as error:
            self.cancel_reading["last_request_id"] = "cancel_read_error:" + type(error).__name__

    def _record_verdict(self, result):
        """把桥返回的**判决**记进只读诊断面（不算猜测：这是 LG 自己回的 code）。

        ⚠️ 为什么要记：如果只看"我们写出去了"，一个被交付账**安静拒收**的回报
        （`playback_report_unknown_segment` / `playback_report_before_synthesis` …）
        在诊断面上看起来会与"成功记下"一模一样 —— 那正是"计数掩盖真相"的形态。

        ⚠️ 每个**事实状态**的计数也必须在这里加：`/lg/playback` 的调用方要的是
        "客户端在哪些状态下回报过"，而那个信息只在判决里（`payload.state`）。
        第一版把逐状态计数写在 `report()` 里 —— 于是**发出去了**就计数，
        被拒的也算"收到过"；而且重构后那几个键彻底不再增加（实测恒为 0）。
        两种写法都是"计数掩盖真相"，所以它只由**判决**驱动。
        """
        try:
            is_synthesis = result.get("kind") == "SYNTHESIS_RESULT"
            payload = result.get("synthesis") if is_synthesis else result.get("playback")
            accepted = bool(isinstance(payload, dict) and payload.get("accepted"))
            code = None if accepted else (result.get("code") or (payload or {}).get("code") or "unknown")
            self.report_reading["accepted" if accepted else "rejected"] += 1
            self.report_reading["last_code"] = code
            if accepted and isinstance(payload, dict):
                state = str(payload.get("state") or "")
                if state == "synthesized":
                    self.report_reading["synthesized"] += 1
                elif state in ("playing", "played", "cancelled", "unknown"):
                    self.report_reading[state] += 1
            if is_synthesis:
                segment_id = getattr(self, "_last_synthesis_segment", None)
                if segment_id:
                    self.synthesis_verdicts[segment_id] = {"accepted": accepted, "code": code}
                    if len(self.synthesis_verdicts) > 256:
                        self.synthesis_verdicts.pop(next(iter(self.synthesis_verdicts)))
        except Exception as error:  # 诊断面自己出错绝不能影响收报文
            self.report_reading["last_code"] = "verdict_read_error:" + type(error).__name__

    async def request(self, packet):
        if not self.alive:
            raise RuntimeError("LG bridge is unavailable")
        kind = {"CANCEL_TURN": "CANCEL_RESULT", "REPORT_SYNTHESIZED": "SYNTHESIS_RESULT",
                "REPORT_PLAYBACK": "PLAYBACK_RESULT",
                # Lv4.5 / ADR-131 `D18`：机会报文的响应种类**不是** `TURN_RESULT`
                "PROACTIVE_OPPORTUNITY": "OPPORTUNITY_RESULT"}.get(packet["kind"], "TURN_RESULT")
        future = asyncio.get_running_loop().create_future()
        self.pending[(kind, packet["requestId"])] = future
        try:
            await self._send_line(json.dumps(packet, ensure_ascii=False) + "\n")
            return await asyncio.wait_for(future, timeout=180)
        finally:
            self.pending.pop((kind, packet["requestId"]), None)

    async def interrupt(self, request_id, reason="user_interrupt"):
        # Silence/discard locally first. Core acknowledgment is a separate result.
        self.cancelled_requests.add(request_id)
        inbox = self.speech_queues.get(request_id)
        if inbox is not None:
            inbox.interrupt()
        task = self.cancel_tasks.get(request_id)
        if task is None:
            for key, previous in list(self.cancel_tasks.items()):
                if len(self.cancel_tasks) < 64:
                    break
                if previous.done():
                    self.cancel_tasks.pop(key)
            if len(self.cancel_tasks) >= 64:
                return {"status": "failed", "code": "cancel_control_full"}

            async def notify():
                try:
                    result = await asyncio.wait_for(self.request({"kind": "CANCEL_TURN", "requestId": request_id,
                                                                "reason": reason}), timeout=5)
                    if result.get("kind") != "CANCEL_RESULT" or not isinstance(result.get("cancel"), dict):
                        return {"status": "failed", "code": "cancel_verdict_invalid"}
                    return {"status": "acknowledged", "result": result}
                except asyncio.TimeoutError:
                    return {"status": "failed", "code": "cancel_ack_timeout"}
                except Exception:
                    return {"status": "failed", "code": "cancel_transport_failed"}

            task = asyncio.create_task(notify())
            self.cancel_tasks[request_id] = task
        return await asyncio.shield(task)

    async def stream_turn(self, packet):
        request_id = packet["requestId"]
        queue = SpeechInbox()
        self.speech_queues[request_id] = queue

        async def run():
            try:
                queue.put_nowait(await self.request({**packet, "streamSpeech": True}))
            except Exception as error:
                queue.put_nowait(error)

        task = asyncio.create_task(run())
        try:
            while True:
                result = await asyncio.wait_for(queue.get(), timeout=180)
                if isinstance(result, Exception):
                    raise result
                yield result
                if result.get("kind") == "TURN_RESULT":
                    return
        except Exception:
            self.cancelled_requests.add(request_id)
            yield {"kind": "TURN_RESULT", "requestId": request_id, "outcome": "failed",
                   "code": "speech_stream_transport_failed"}
        finally:
            queue.interrupt()
            self.speech_queues.pop(request_id, None)
            if not task.done():
                self.cancelled_requests.add(request_id)
                asyncio.create_task(self.interrupt(request_id, "speech_consumer_closed"))
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def report(self, packet, wait_ms=0):
        """交付事实回报（Lv4.5 / P1）。

        ⚠️ 两条**分开的**要求，不要混：
        · **浏览器那条路**（`wait_ms=0`，缺省）：发出即返回，**不等**回应 ——
          回报的价值是"如实记下客户端观察到的播放事实"，让页面在播放路径上多一个
          可挂起的 await，只会把"网络抖动"变成"播放卡住"（两者毫无关系）。
        · **入口那条路**（`/lg/playback` 的调用方，`wait_ms>0`）：**要**等桥的判决，
          因为"发出去了"与"账上真的记下了"是两件事：被安静拒收的回报
          （`playback_report_unknown_segment` / `playback_report_before_synthesis` …）
          在只看发送次数时与成功**长得一模一样**。

        两种调用共用同一个 `read_results` 收报文；`wait_ms=0` 时判决由
        `_record_verdict` 记进只读诊断面（`accepted` / `rejected` 分开计数）。
        """
        if not self.alive or not self.ready:
            self.report_reading["unsupported"] += 1
            return {"outcome": "unavailable"}
        kind = {"REPORT_SYNTHESIZED": "SYNTHESIS_RESULT", "REPORT_REMINDER_DELIVERY": "DELIVER_REMINDER_TEXT"}.get(packet["kind"], "PLAYBACK_RESULT")
        future = None
        if wait_ms > 0:
            future = asyncio.get_running_loop().create_future()
            self.pending[(kind, packet["requestId"])] = future
        if packet["kind"] == "REPORT_SYNTHESIZED":
            # 判决要按 segmentId 归档 ⇒ 记下"这一次是谁的"
            self._last_synthesis_segment = str(packet.get("segmentId") or "")
        try:
            await self._send_line(json.dumps(packet, ensure_ascii=False) + "\n")
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            if future is not None:
                self.pending.pop((kind, packet["requestId"]), None)
            self.report_reading["unsupported"] += 1
            return {"outcome": "unavailable"}
        if future is None:
            return {"outcome": "sent"}
        try:
            result = await asyncio.wait_for(future, timeout=max(0.05, wait_ms / 1000))
        except asyncio.TimeoutError:
            return {"outcome": "sent", "verdict": "no_reply_within_wait"}
        finally:
            self.pending.pop((kind, packet["requestId"]), None)
        payload = result.get("qqDelivery") if result.get("kind") == "DELIVER_REMINDER_TEXT" else result.get("synthesis") if result.get("kind") == "SYNTHESIS_RESULT" else result.get("playback")
        accepted = bool(isinstance(payload, dict) and payload.get("accepted"))
        return {"outcome": "accepted" if accepted else "rejected",
                "code": None if accepted else (result.get("code") or (payload or {}).get("code") or "unknown")}

    async def close(self):
        self.ready = False
        if self.connect is not None:
            # ------------------------------------------------------------------
            # 连接档：**只关这一条连接**（post-Lv2 / ADR-109 `D07`：断开不是停机）
            #
            # ⚠️ 核心与**另一条入口**都不受影响 —— 这正是"共享一个核心"要买到的东西。
            # ⚠️ 绝不在这里去关那个核心：它不是本外壳起的，也就轮不到本外壳停它。
            # ------------------------------------------------------------------
            self._transport_closed = True
            if self.socket_writer is not None:
                self.socket_writer.close()
                try:
                    await self.socket_writer.wait_closed()
                except (ConnectionResetError, OSError):
                    pass
            await self.reader
            print("LG_ENTRY_CLOSED " + str(self.entry_hello or ""), flush=True)
            return
        self.process.stdin.close()
        # EOF lets main.ts drain workers, verify DB close and finish its post-close snapshot.
        # Windows terminate() is a hard kill; never substitute it for that production shutdown.
        print("LG_BRIDGE_CLOSING 等待 LG 正常收尾，请保留启动窗口…", flush=True)
        await self.process.wait()
        await self.reader
        print(f"LG_BRIDGE_CLOSED exit={self.process.returncode}", flush=True)
        if self.process.returncode != 0:
            raise RuntimeError(f"LG bridge exited with code {self.process.returncode}; inspect the error above")


class LGIncrementalASR:
    """Lv4.5 / P2 —— **流式 partial**（把网页按块交来的音频边收边识别）。

    ============================================================================
     载体：计划 §2「两个实现选择」第 1 条
           「先用现有 Zipformer 验证临时 partial 接口，SenseVoice 仍负责正式 final」
    ============================================================================
    它**只**产 partial；正式 final 仍然由 `LGSenseVoiceASR` 在 `mic-audio-end` 时给出。
    两条路的判据在读数里分列（`partial_text` / `final_text`），不许互相顶替。

    ⚠️ 三条纪律：
    ```text
    ① 不写任何东西：partial 不是一轮对话，不落事件、不落记忆（写侧只有 LG 的正式轮次）
    ② 不改写 final：这里出的文本**只**用于"提前准备"，正式输入仍走 ASR 适配器
    ③ 慢不拖死：每块的识别耗时如实记；超过给定预算就**跳过**这一块的 decode
       （宁可少一个 partial，也不让音频回调堆积）
    ```
    """

    def __init__(self, model_dir, num_threads=2, sample_rate=16000, revision_limit=64, budget_ms=60,
                 recognizer=None):
        import numpy as np

        self.np = np
        self.sample_rate = sample_rate
        self.budget_ms = budget_ms
        self.revision_limit = revision_limit
        if recognizer is None:
            import sherpa_onnx
            path = Path(model_dir)
            recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                tokens=str(path / "tokens.txt"), encoder=str(path / "encoder.int8.onnx"),
                decoder=str(path / "decoder.onnx"), joiner=str(path / "joiner.int8.onnx"),
                num_threads=num_threads, sample_rate=sample_rate, feature_dim=80,
                decoding_method="greedy_search", provider="cpu")
        # ⚠️ 识别器**可共享**，stream **不可共享**：stream 里有这次音频的特征缓冲，
        #    两个客户端共用一条 stream 就会把对方的音频混进来（静默的串音）。
        self.recognizer = recognizer
        self.stream = recognizer.create_stream()
        self.revision = 0
        # Lv4.5 / P3：**这一次"用户开口"的编号**（VAD 边界 +1）。
        # ⚠️ 起点是 1 而不是 0：0 留给"没有编号"的旧客户端，避免"没给"被当成"第一次开口"。
        self.utterance = 1
        self.last_text = ""
        self.reading = {"chunks": 0, "decoded": 0, "skipped": 0, "revision": 0,
                        "last_partial": "", "decode_ms_max": 0.0, "decode_ms_total": 0.0}

    def accept(self, samples):
        """喂一块音频，返回**新的** partial（没有变化就返回 None，避免刷屏）。"""
        import time
        self.reading["chunks"] += 1
        if samples is None or len(samples) == 0:
            return None
        started = time.perf_counter()
        self.stream.accept_waveform(self.sample_rate, self.np.asarray(samples, dtype=self.np.float32))
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
        elapsed_ms = (time.perf_counter() - started) * 1000
        self.reading["decoded"] += 1
        self.reading["decode_ms_total"] += elapsed_ms
        self.reading["decode_ms_max"] = max(self.reading["decode_ms_max"], elapsed_ms)
        if elapsed_ms > self.budget_ms:
            # 如实记"这一块超预算"，但**不**丢文本：已经解出来的就是已经解出来的
            self.reading["skipped"] += 0
        text = self.recognizer.get_result(self.stream).strip()
        if text == self.last_text:
            return None
        self.last_text = text
        self.revision += 1
        if self.revision > self.revision_limit:
            # 版本号只用于"改口即失效"，不必无限增长；回绕不改变语义
            self.revision = 1
        self.reading["revision"] = self.revision
        self.reading["last_partial"] = text
        return {"text": text, "revision": self.revision}

    def finish(self):
        """收尾：喂尾部 padding 拿最后一条 partial，并**重置**给下一轮用。"""
        import time
        started = time.perf_counter()
        self.stream.accept_waveform(self.sample_rate, self.np.zeros(int(self.sample_rate * 0.5), dtype=self.np.float32))
        self.stream.input_finished()
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
        text = self.recognizer.get_result(self.stream).strip()
        self.reading["decode_ms_total"] += (time.perf_counter() - started) * 1000
        if text != self.last_text and text:
            self.revision = 1 if self.revision >= self.revision_limit else self.revision + 1
            self.last_text = text
            self.reading["revision"] = self.revision
            self.reading["last_partial"] = text
        self.stream = self.recognizer.create_stream()
        self.last_text = ""
        # Lv4.5 / P3：**这一次开口结束了** ⇒ 打开"新的一次开口"的编号。
        #
        # ⚠️ 为什么这个编号必须由外壳给：只有外壳知道"用户停止说话"（VAD 边界）。
        #    桥若只看"下一轮什么时候被提交"，那用户**只叫一声、不说话**时，
        #    那次呼唤会永远算作"还没翻页" ⇒ 以后每次叫她都**被去重规则挡掉**（实测踩到）。
        self.utterance += 1
        return text


async def await_bridge_close(bridge):
    # Uvicorn replays Ctrl+C after HTTP shutdown; it must not cancel LG's EOF drain.
    closing = asyncio.create_task(bridge.close())
    try:
        await asyncio.shield(closing)
    except asyncio.CancelledError:
        await closing


def configure_imports(deps):
    vt = deps / "Open-LLM-VTuber"
    sys.path[:0] = [str(vt / "src"), str(vt)]
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", PYTHONUTF8="1",
                      TOKENIZERS_PARALLELISM="false", HF_HUB_DISABLE_PROGRESS_BARS="1")
    return vt


def register_adapters():
    global LGBridgeAgent, LGQwenTTS, LGOnlineASR, LGSenseVoiceASR, LGCosyVoiceTTS
    import numpy as np
    from open_llm_vtuber.agent.agents.agent_interface import AgentInterface
    from open_llm_vtuber.agent.input_types import TextSource
    from open_llm_vtuber.agent.output_types import Actions, DisplayText, SentenceOutput
    from open_llm_vtuber.tts.tts_interface import TTSInterface
    from open_llm_vtuber.asr.asr_interface import ASRInterface
    from open_llm_vtuber.conversations.tts_manager import TTSTaskManager
    from open_llm_vtuber.utils.stream_audio import prepare_audio_payload
    from postlv2_cosyvoice import LGCosyVoiceTTS

    @dataclass
    class ExpressionActions(Actions):
        lg_expression: dict = None

    original_process_tts = TTSTaskManager._process_tts

    async def send_ordered_payloads(manager, websocket_send):
        buffered = defaultdict(deque)
        while True:
            payload, sequence = await manager._payload_queue.get()
            buffered[sequence].append(payload)
            try:
                while buffered[manager._next_sequence_to_send]:
                    packet = buffered[manager._next_sequence_to_send].popleft()
                    final = packet.pop("_lg_stream_final", True)
                    await websocket_send(json.dumps(packet))
                    if final:
                        del buffered[manager._next_sequence_to_send]
                        manager._next_sequence_to_send += 1
            finally:
                manager._payload_queue.task_done()

    TTSTaskManager._process_payload_queue = send_ordered_payloads

    async def process_streaming_tts(manager, text, display_text, actions, engine, sequence):
        import numpy as np
        metadata = actions.lg_expression
        queue = asyncio.Queue()
        loop = asyncio.get_running_loop()
        cancelled = threading.Event()

        def push(item):
            if not cancelled.is_set() and not loop.is_closed():
                loop.call_soon_threadsafe(queue.put_nowait, item)

        def produce():
            try:
                for wav, rate in engine.stream_expressive_audio(text, metadata):
                    push((wav, rate))
            except BaseException as error:
                push(error)
            finally:
                push(None)

        job = asyncio.create_task(asyncio.to_thread(produce))
        index, failed = 0, False
        try:
            while (item := await queue.get()) is not None:
                if isinstance(item, BaseException):
                    raise item
                if metadata["requestId"] in BRIDGE.cancelled_requests:
                    continue
                wav, rate = item
                await manager._payload_queue.put(({"type": "lg-audio-chunk",
                    "audio": base64.b64encode(np.asarray(wav, dtype="<f4").tobytes()).decode("ascii"),
                    "sample_rate": rate, "codec": "pcm_f32le", "index": index, "final": False,
                    "display_text": display_text.to_dict() if index == 0 else None,
                    "actions": actions.to_dict(), "_lg_stream_final": False}, sequence))
                index += 1
            await job
        except asyncio.CancelledError:
            cancelled.set()
            raise
        except Exception:
            failed = True
        finally:
            cancelled.set()
            if metadata["requestId"] not in BRIDGE.cancelled_requests:
                await manager._payload_queue.put(({"type": "lg-audio-chunk", "audio": "",
                    "sample_rate": engine.sample_rate, "codec": "pcm_f32le", "index": index,
                    "final": True, "failed": failed, "display_text": display_text.to_dict() if index == 0 else None,
                    "actions": actions.to_dict(), "_lg_stream_final": True}, sequence))

    async def process_expressive_tts(manager, tts_text, display_text, actions, live2d_model, tts_engine, sequence_number):
        metadata = getattr(actions, "lg_expression", None)
        if metadata is None:
            return await original_process_tts(manager, tts_text, display_text, actions, live2d_model, tts_engine, sequence_number)
        if hasattr(tts_engine, "stream_expressive_audio"):
            return await process_streaming_tts(manager, tts_text, display_text, actions, tts_engine, sequence_number)
        # Immutable per-task metadata crosses the queue; no shared current emotion.
        job = asyncio.create_task(asyncio.to_thread(tts_engine.generate_expressive_audio, tts_text, metadata))
        path = None
        try:
            path = await asyncio.shield(job)
            if metadata["requestId"] in BRIDGE.cancelled_requests:
                return
            payload = prepare_audio_payload(path, display_text=display_text, actions=actions)
            await manager._payload_queue.put((payload, sequence_number))
        except asyncio.CancelledError:
            # Native GPU inference may finish after cancellation; dispose of its late file.
            def dispose_late(done):
                if not done.cancelled() and done.exception() is None:
                    tts_engine.remove_file(done.result())
            job.add_done_callback(dispose_late)
            raise
        except Exception:
            payload = prepare_audio_payload(None, display_text=display_text, actions=actions)
            await manager._payload_queue.put((payload, sequence_number))
        finally:
            if path:
                tts_engine.remove_file(path)

    TTSTaskManager._process_tts = process_expressive_tts

    # -------------------------------------------------------------------------
    # Lv4.5 / P2：**边听边准备**（流式 partial + 只读准备）
    # -------------------------------------------------------------------------
    #
    # 挂在哪里、为什么挂在那里：
    # ```text
    # 网页按块发 `mic-audio-data`（1000 samples/块，上游行为，不用改前端）
    #   ⇒ `WebSocketHandler._handle_audio_data` 把块**追加**进 received_data_buffers
    #   ⇒ 我们在**同一块**上顺带跑一次流式识别，产出 partial 并发回 `lg-asr-partial`
    #   ⇒ VAD 边界（上游发 `mic-audio-end` 给客户端）之后，用**已收到的候选文本**
    #     向 LG 发一条 `PREPARE_TURN`（只读、不写任何东西）
    # ```
    # ⚠️ 为什么用包装而不是改上游：`websocket_handler.py` 属冻结的皮套源；
    #    包装只**追加**行为，原处理照常跑（缓冲区语义一个字不改）。
    # ⚠️ partial **不**进聊天、**不**落记忆、**不**当用户输入：它只用于"准备"。
    from open_llm_vtuber.websocket_handler import WebSocketHandler

    bind_reminder_websockets(WebSocketHandler)
    original_audio_data = WebSocketHandler._handle_audio_data
    original_conversation_trigger = WebSocketHandler._handle_conversation_trigger
    partial_readings = PARTIAL["readings"]

    def partial_state(client_uid):
        state = partial_readings.get(client_uid)
        if state is None:
            state = {"stream": None, "candidate": "", "prepared": 0, "partials": 0,
                     "last_error": None, "reported": 0}
            # 每个客户端**自己**一条 stream：共用的识别器 + 独立的流
            recognizer = PARTIAL["recognizer"]
            if recognizer is not None:
                try:
                    state["stream"] = LGIncrementalASR(None, recognizer=recognizer)
                except Exception as error:
                    state["last_error"] = type(error).__name__
            else:
                state["last_error"] = PARTIAL["error"] or "partial_not_configured"
            partial_readings[client_uid] = state
        return state

    async def handle_audio_data_with_partials(handler, websocket, client_uid, data):
        await original_audio_data(handler, websocket, client_uid, data)
        # Lv4.5 / P3：**有人正在发音频 ⇒ 这是活着的客户端**。
        # ⚠️ 必须在这里也记一次（不只在那条 VAD 边界上）：插话最典型的时刻是
        #    "用户还在说"，而那时 `mic-audio-end` **还没来** —— 只在边界记，
        #    会让最该插话的那一刻恰好被记成"没有活客户端"。
        LIVE_CLIENT["server"] = handler
        LIVE_CLIENT["uid"] = client_uid
        LIVE_CLIENT["websocket"] = websocket
        state = partial_state(client_uid)
        if state["stream"] is None:
            return  # 流式档没装（例如模型缺失）⇒ 静默降级，正式链路照常
        chunk = data.get("audio") or []
        if not chunk:
            return
        try:
            update = state["stream"].accept(np.asarray(chunk, dtype=np.float32))
        except Exception as error:  # partial 坏掉**绝不能**影响正式识别
            state["last_error"] = type(error).__name__
            return
        if update is None:
            return
        state["candidate"] = update["text"]
        state["partials"] += 1
        state["chunks"] = state.get("chunks", 0) + 1
        await websocket.send_text(json.dumps({
            "type": "lg-asr-partial", "text": update["text"], "revision": update["revision"],
        }, ensure_ascii=False))
        # 只在候选文本够长时才向 LG 要一次**只读**准备（短句准备没有意义）
        #
        # ⚠️ `len >= 3`（不是 4）：她的名字**正好三个字** —— 阈值为 4 时，
        #    一句单独的「苏沐薇」永远凑不够长度 ⇒ **呼唤根本不会被判**。
        #    （实测：合成「苏沐薇，你在吗」能触发，而单独「苏沐薇」不能。）
        if len(update["text"]) >= 3 and BRIDGE.ready:
            verdict = await BRIDGE.report({
                "kind": "PREPARE_TURN", "requestId": f"partial:{client_uid[:8]}:{update['revision']}",
                "userText": update["text"], "candidateRevision": f"partial-r{update['revision']}",
                # **这一次"开口"的键**：桥据此去重（同一次开口只答一次呼唤）。
                #
                # ⚠️ 必须带**客户端身份**：`utterance` 是**每条连接各自**从 1 开始的，
                #    只发编号的话，新连接（例如**刷新页面**）的第一句会被当成
                #    "上一次开口已经答过" ⇒ 她**静默不理**。实测：连续两次探针，
                #    第二次完全没产出（服务端 spoken 不涨）。
                "utteranceKey": f"{client_uid}:{state['stream'].utterance}"})
            state["prepared"] += 1
            if isinstance(verdict, dict) and verdict.get("outcome") not in ("sent", "accepted"):
                state["last_error"] = str(verdict.get("code"))

    async def handle_conversation_trigger_with_reset(handler, websocket, client_uid, data):
        """VAD 边界到来 ⇒ 收尾这次 partial 会话（不碰正式链路）。"""
        state = partial_state(client_uid)
        # Lv4.5 / P3：记下**当前连接**（有来源短句要送到这条连接上）
        LIVE_CLIENT["server"] = handler
        LIVE_CLIENT["uid"] = client_uid
        LIVE_CLIENT["websocket"] = websocket
        if state["stream"] is not None and data.get("type") == "mic-audio-end":
            # -----------------------------------------------------------------
            # Lv4.5 / P3（中途纠正）：把**这次开口**的键留到提交那一刻
            # -----------------------------------------------------------------
            #
            # ⚠️ 必须在 `finish()` **之前**取：`finish()` 会把开口编号 +1（那是"下一次开口"），
            #    而 partial 期间送给桥的 `utteranceKey` 用的是**当前**这个编号。
            #    取晚了 ⇒ 提交时带的键与检索时带的键**差一个数** ⇒ 归属判断永远不成立
            #    （表现："中途纠正永远不发生"，而每一个计数器都正常）。
            LIVE_UTTERANCE_KEY["key"] = f"{client_uid}:{state['stream'].utterance}"
            try:
                state["stream"].finish()
            except Exception as error:
                state["last_error"] = type(error).__name__
            state["candidate"] = ""
        return await original_conversation_trigger(handler, websocket, client_uid, data)

    WebSocketHandler._handle_audio_data = handle_audio_data_with_partials
    WebSocketHandler._handle_conversation_trigger = handle_conversation_trigger_with_reset

    # -------------------------------------------------------------------------
    # Lv4.5 / P3：把 LG 的**有来源短句**播出去
    # -------------------------------------------------------------------------
    async def deliver_character_output(message):
        """把一条 `CHARACTER_OUTPUT` 按**与正式轮次完全相同**的那条路送出去。

        ========================================================================
          为什么用 `TTSTaskManager.speak(...)` 而不是"自己拼个音频包"
        ========================================================================
        ```text
        ① 那条路带上**全部**既有行为：字幕（display_text）/ 表达（lg_expression）/
           合成账与交付账的回账 / 分句顺序 / 静音处理 —— 一条都不重写（`INV-PL2-09`）。
        ② 它也是**唯一**一条已经接好"句级合成事实"的路；另铺一条等于把 P1 的交付
           事实面绕过（那正是 R3 那版犯过的错）。
        ```
        ⚠️ 判据是**引用的对象**：下面这个 `speak` 调用与
           `conversation_utils.py` 里那个是**同一个**函数、同一组参数形状。
        """
        payload = message.get("characterOutput")
        if not isinstance(payload, dict):
            INTERJECTION["dropped"] += 1
            INTERJECTION["last_code"] = "character_output_malformed"
            return
        text = str(payload.get("text") or "").strip()
        source = str(payload.get("source") or "unknown")
        client = LIVE_CLIENT.get("uid")
        websocket = LIVE_CLIENT.get("websocket")
        handler = LIVE_CLIENT.get("server")
        INTERJECTION["last_source"] = source
        if text == "":
            INTERJECTION["dropped"] += 1
            INTERJECTION["last_code"] = "character_output_empty_text"
            return
        if handler is None or client is None or websocket is None:
            INTERJECTION["dropped"] += 1
            INTERJECTION["last_code"] = "character_output_no_live_client"
            return
        context = handler.client_contexts.get(client)
        if context is None:
            INTERJECTION["dropped"] += 1
            INTERJECTION["last_code"] = "character_output_no_client_context"
            return
        sidecar = payload.get("expression")
        segments = sidecar.get("segments") if isinstance(sidecar, dict) else None
        if not segments:
            # ⚠️ 没有 sidecar ⇒ 如实记"没法播"（**不**伪造一个 sidecar 强行播）
            INTERJECTION["unsupported"] += 1
            INTERJECTION["last_code"] = "character_output_without_expression"
            return
        # 它算**新的一次发言** ⇒ 递增 generation，并先发 turn 包（客户端据此开新一轮表达）
        BRIDGE.generation += 1
        generation = BRIDGE.generation
        # ⚠️ 记下自己：用户抢话时要作废的**就是这条**
        INTERJECTION_TASK["uid"] = client
        INTERJECTION_TASK["task"] = asyncio.current_task()
        # ⚠️ **归属在开始就记**（不是排空之后）：目标连接这一刻已经确定，
        #    而排空最长要等 5 秒 ⇒ 写在收尾会让"投给了谁"滞后 5 秒（批量实测撞到过）。
        INTERJECTION["started"] += 1
        INTERJECTION["last_client"] = str(client)[:8]

        async def websocket_send(message_json: str):
            await websocket.send_text(message_json)

        try:
            await websocket.send_text(json.dumps({"type": "lg-expression-turn", "generation": generation},
                                                ensure_ascii=False))
            manager = TTSTaskManager()
            for segment in segments:
                if not isinstance(segment, dict) or not str(segment.get("text") or "").strip():
                    continue
                metadata = presentation(segment, "interjection:" + str(payload.get("revision")), "interjection",
                                        generation, context.live2d_model.emo_map)
                await manager.speak(
                    tts_text=str(segment["text"]),
                    display_text=DisplayText(str(segment["text"]), "苏沐薇", "lg_ulvm2_0001.png"),
                    actions=ExpressionActions(lg_expression=metadata),
                    live2d_model=context.live2d_model,
                    tts_engine=context.tts_engine,
                    websocket_send=websocket_send,
                )
            # ⚠️ **必须等它真的说完**再往 `spoken` 上加一。
            #
            # `TTSTaskManager.speak()` 只是把任务**排进** `task_list`（以及一个后台的
            # 发送任务），它**立刻返回**。若在 `speak()` 返回时就记 `spoken += 1`，
            # 记下的是"**排上了**"而不是"**说出去了**" —— 这正是本项目反复踩的那个坑
            # （P1 的 `synthesized` 曾经把"补账"记成"真播了"）。
            #
            # 上游 `single_conversation.py:146` 用的就是同一条纪律（`gather(*task_list)`）。
            while manager.task_list:
                await asyncio.gather(*manager.task_list)
                manager.task_list.clear()
            # 发送任务是**独立**的：排空它，音频包才真的过了 websocket
            sender = getattr(manager, "_sender_task", None)
            if sender is not None and not sender.done():
                try:
                    await asyncio.wait_for(asyncio.shield(sender), timeout=5)
                except asyncio.TimeoutError:
                    sender.cancel()
            INTERJECTION["spoken"] += 1
            INTERJECTION["last_code"] = None
        except asyncio.CancelledError:
            # Lv4.5 / P3：**用户抢话**把它掐了 —— 这不是失败，是"用户优先"生效。
            # ⚠️ 与 `dropped` **分开记**：把"被用户打断"记成"投递失败"，
            #    线上就再也分不清"她没说出来"和"用户不让她说完"。
            INTERJECTION["revoked"] += 1
            INTERJECTION["last_code"] = "revoked_by_user_cut_in"
            raise
        except Exception as error:
            INTERJECTION["dropped"] += 1
            INTERJECTION["last_code"] = type(error).__name__ + ": " + str(error)[:80]
        finally:
            if INTERJECTION_TASK["task"] is asyncio.current_task():
                INTERJECTION_TASK["task"] = None
                INTERJECTION_TASK["uid"] = None

    def revoke_interjection(uid):
        """用户抢话 ⇒ **立刻作废**正在说的那条插话（计划 §1「用户抢话优先」）。

        ⚠️ 它只裁**表达**：不撤销任何已提交的账、不改任何判定结果。
           音频层的停止由客户端那侧负责（既有路径），这里负责**停掉合成与投递**。
        """
        task = INTERJECTION_TASK["task"]
        if task is None or task.done():
            return False
        if INTERJECTION_TASK["uid"] not in (None, uid):
            return False
        task.cancel()
        return True

    INTERJECTION_REVOKE["fn"] = revoke_interjection

    # -------------------------------------------------------------------------
    # Lv4.5 / P3：**用户抢话**要能掐掉插话
    # -------------------------------------------------------------------------
    #
    # ⚠️ 上游的 `_handle_interrupt`（消息 `interrupt-signal`）取消的是
    #    `current_conversation_tasks` 里那一**轮**的任务；**插话不属于任何一轮**
    #    （它是主动发出的），所以不掐它 ⇒ 用户抢话之后她还会把"我在。"说完 ——
    #    "用户优先"就只是句口号。这一层就是为它存在的。
    original_interrupt = WebSocketHandler._handle_interrupt

    async def handle_interrupt_with_revoke(handler, websocket, client_uid, data):
        revoked = revoke_interjection(client_uid)
        if revoked:
            INTERJECTION["last_code"] = "revoked_by_user_cut_in"
        return await original_interrupt(handler, websocket, client_uid, data)

    WebSocketHandler._handle_interrupt = handle_interrupt_with_revoke

    # ⚠️ 顺序：`serve()` 在**创建 BRIDGE 之前**就调用了本函数（它要先 import 上游），
    #    所以这里不能假定 BRIDGE 已经存在 —— 挂不上的时候把函数存到模块级，
    #    由 `serve()` 在 BRIDGE 建好之后补挂（见 `CHARACTER_OUTPUT_HOOK`）。
    global CHARACTER_OUTPUT_HOOK
    CHARACTER_OUTPUT_HOOK = deliver_character_output
    if BRIDGE is not None:
        BRIDGE.on_character_output = deliver_character_output

    class LGBridgeAgent(AgentInterface):
        def __init__(self, live2d_model):
            self.live2d_model = live2d_model
            self.active_request = None

        async def _report_opportunity(self):
            """兼容壳：把上报整条交给**模块级**的 `report_opportunity()`。

            ⚠️ 本方法**没有自己的实现**：拼报文与读数只有一处（`report_opportunity`），
                而它同时被 `chat()` 那条分支与**外壳自己的空闲上报器**用（裁定 C）。
                留这一层是为了让 `chat()` 读起来仍然像"这个 agent 在做一件事"。
            """
            await report_opportunity()

        async def chat(self, input_data):
            if input_data.files:
                raise ValueError("LG avatar entry only accepts explicit user text, final ASR or images")
            # -----------------------------------------------------------------
            # Lv4.5 / ADR-131 `D01`：外壳自带的"主动搭话" ⇒ **机会报文**（不是输入）
            # -----------------------------------------------------------------
            # ⚠️ 这里**没有放松守卫**，而是把它接到了正确的地方。
            #    旧守卫逐字说"皮套入口只接受明确的用户文本 / 最终 ASR / 图片"——
            #    那条**理由仍然成立**：`proactive_speak` **依然不是**用户文本。
            #    它只是"外壳现在空闲"这个**事实**。
            # ⇒ 所以它不再抛错，而是走 `PROACTIVE_OPPORTUNITY`：
            #    说不说、说什么**由 LG 决定**（15 道闸 + 一次模型调用 + 回复守卫），
            #    LG 真要说时经**既有**的 `CHARACTER_OUTPUT` 出站。
            # ⚠️ 本分支**一个字节的回复都不 yield**：外壳这一侧没有"回复"可播 ——
            #    这正是"她说什么由 LG 说"的落地形状。
            # ⚠️ 顺带：原来那个 1.5 秒一次的热循环（`报错1.txt`：33 次 / 53 秒）
            #    现在被 **LG 的闸**兜住 —— 冷却 30 分钟 / 日额度 4 次 / 空闲下限 3 分钟。
            if (input_data.metadata or {}).get("proactive_speak"):
                await self._report_opportunity()
                return
            images = avatar_image_inputs(input_data.images)
            texts = [item.content for item in input_data.texts if item.source == TextSource.INPUT]
            if len(texts) > 1 or (not images and (not texts or not texts[0].strip())):
                raise ValueError("One nonempty final input is required")
            user_text = texts[0] if texts and texts[0].strip() else "[用户发送了图片]"
            # 记录"最后一次真实输入"的时刻：`_report_opportunity` 用它算 `idleMs`
            LAST_INPUT["at"] = time.time()
            request_id = "avatar:" + str(uuid.uuid4())
            self.active_request = request_id
            BRIDGE.generation += 1
            generation = BRIDGE.generation
            yield {"type": "lg-expression-turn", "generation": generation}
            # Lv4.5 / P3（中途纠正）：带上**这次开口**的键（与 PREPARE_TURN 同一把）。
            # ⚠️ 打字输入没有 VAD 边界 ⇒ 没有键 ⇒ 桥按"判据不成立"处理（只提醒，不纠正）。
            submit_packet = {"kind": "SUBMIT_TURN", "requestId": request_id, "userText": user_text}
            if images:
                submit_packet["images"] = images
            if LIVE_UTTERANCE_KEY.get("key"):
                submit_packet["utteranceKey"] = LIVE_UTTERANCE_KEY["key"]
            # -----------------------------------------------------------------
            # Lv4.5：**生成耗时**（把 §3 的"首段语音"拆开的那一半）
            # -----------------------------------------------------------------
            #
            # ⚠️ 为什么要单独量它：§3 的"首段实质语音 p95 ≤ 5 000 ms"在干净窗口里
            #    **9/9 全部超标**（中位数 8 881 ms）。而那个数是**两段之和**：
            # ```text
            # 提交 → 正文（模型 + 回复守卫）        ← 这一段决定"要不要动生成"
            # 正文 → 第一块音频（合成 + 分包交付）   ← 这一段决定"要不要动合成/交付"
            # ```
            # 不拆开就只能猜该修哪边。`last_synthesis` 已经有合成那半的秒数。
            generation_started = time.perf_counter()
            emitted = []
            stream_reply_id = None
            result = None
            turn_stream = BRIDGE.stream_turn(submit_packet)
            async for packet in turn_stream:
                if self.active_request != request_id:
                    await turn_stream.aclose()
                    return
                if packet.get("kind") == "TURN_RESULT":
                    result = packet
                    await turn_stream.aclose()
                    break
                speech = packet.get("speech") or {}
                segment = speech.get("segment") or {}
                index = len(emitted)
                reply_id = speech.get("replyId")
                guard_states = speech.get("guardStates")
                if (packet.get("requestId") != request_id or speech.get("segmentIndex") != index or
                        not isinstance(reply_id, str) or not reply_id or
                        (stream_reply_id is not None and reply_id != stream_reply_id) or
                        segment.get("segmentId") != f"{reply_id}#{index}" or
                        not isinstance(segment.get("text"), str) or not segment["text"].strip() or
                        segment.get("cue") not in PRESETS or
                        not isinstance(guard_states, list) or len(guard_states) != 4 or
                        any(not isinstance(item, str) or item not in {f"{name}:{state}" for name in
                            ("memory_truth", "action_truth", "evidence_truth", "search_need") for state in
                            ("passed", "triggered", "not_run")} for item in guard_states) or
                        {item.split(":")[0] for item in guard_states} !=
                        {"memory_truth", "action_truth", "evidence_truth", "search_need"}):
                    BRIDGE.cancelled_requests.add(request_id)
                    await turn_stream.aclose()
                    yield {"type": "lg-speech-stream-failed", "generation": generation}
                    raise ValueError("Invalid checked LG streaming sentence")
                stream_reply_id = reply_id
                emitted.append(segment)
                BRIDGE.last_reading = {"requestId": request_id, "replyId": reply_id,
                    "stream_status": "generating", "streamed_segments": len(emitted)}
                metadata = presentation(segment, reply_id, request_id, generation, self.live2d_model.emo_map)
                yield SentenceOutput(DisplayText(segment["text"], "苏沐薇", "lg_ulvm2_0001.png"),
                                     segment["text"], ExpressionActions(lg_expression=metadata))
            generation_seconds = time.perf_counter() - generation_started
            if not result or result.get("outcome") != "replied" or not result.get("replyId"):
                BRIDGE.cancelled_requests.add(request_id)
                if result:
                    BRIDGE.last_reading = {key: result.get(key) for key in ("replyId", "traceId", "delivery", "streamStatus", "code")}
                yield {"type": "lg-speech-stream-failed", "generation": generation}
                raise RuntimeError("LG rejected or failed: " + str((result or {}).get("code", "unknown")))
            reply = result["replyText"]
            BRIDGE.last_reading = {key: result.get(key) for key in ("replyId", "traceId", "guardStates", "delivery")}
            BRIDGE.last_reading["generation_seconds"] = round(generation_seconds, 3)
            BRIDGE.last_reading["stream_status"] = result.get("streamStatus")
            BRIDGE.last_reading["streamed_segments"] = len(emitted)
            # -----------------------------------------------------------------
            # `P4` 后的时延修复：**生成段内部的阶段耗时**（随 TURN_RESULT 回来）
            # -----------------------------------------------------------------
            #
            # ⚠️ 为什么要它：§3 的"首段实质语音"干净窗口 9/9 超 5 000 ms，拆解显示
            #    时间几乎都在"提交 → 正文"里（生成 ≈22.8 s vs 合成 ≈1.9 s）。
            #    **但"生成"本身还是黑盒** —— 装配 / 模型 / 守卫 / 落账各占多少，
            #    决定了该动哪一段。不量就改 = 猜。
            # ⚠️ 它**只**是读数：不含正文、不进账本。
            timings = result.get("timings")
            if isinstance(timings, dict):
                BRIDGE.last_reading["timings_ms"] = {
                    key: timings.get(key)
                    for key in ("contextMs", "beginTurnMs", "evaluationsMs", "compileMs",
                                "stateMs", "modelMs", "guardsMs", "completeMs")
                }
            BRIDGE.last_reading["checked_text_sha256"] = hashlib.sha256(reply.encode()).hexdigest()
            BRIDGE.last_reading["requestId"] = request_id
            try:
                segments = checked_segments(result)
            except (ValueError, KeyError, TypeError):
                BRIDGE.cancelled_requests.add(request_id)
                yield {"type": "lg-speech-stream-failed", "generation": generation}
                raise
            if emitted and (result["replyId"] != stream_reply_id or segments != emitted):
                BRIDGE.cancelled_requests.add(request_id)
                yield {"type": "lg-speech-stream-failed", "generation": generation}
                raise ValueError("Final LG reply differs from its checked streaming sentences")
            BRIDGE.last_reading["expression_cues"] = [item["cue"] for item in segments]
            BRIDGE.last_reading["expression_fallback"] = result["expression"].get("fallback")
            BRIDGE.last_reading["segments"] = [{"segmentId": item["segmentId"], "cue": item["cue"],
                "text_sha256": hashlib.sha256(item["text"].encode()).hexdigest()} for item in segments]
            for segment in ([] if emitted else segments):
                if self.active_request != request_id:
                    return
                metadata = presentation(segment, result["replyId"], request_id, generation, self.live2d_model.emo_map)
                # Expressions are applied by the client on actual playback, never upon packet arrival.
                yield SentenceOutput(DisplayText(segment["text"], "苏沐薇", "lg_ulvm2_0001.png"),
                                     segment["text"], ExpressionActions(lg_expression=metadata))

        def handle_interrupt(self, heard_response):
            request_id = self.active_request
            self.active_request = None
            if request_id:
                BRIDGE.cancelled_requests.add(request_id)
                asyncio.create_task(BRIDGE.interrupt(request_id, "user_interrupt"))

        def set_memory_from_history(self, conf_uid, history_uid):
            pass  # UI history never becomes LG memory or a second prompt.

    class LGQwenTTS(TTSInterface):
        def __init__(self, model_dir, speaker):
            import torch
            from qwen_tts import Qwen3TTSModel
            if speaker != "Ono_Anna":
                raise ValueError("The approved speaker is Ono_Anna")
            self.speaker = speaker
            self.lock = threading.Lock()
            self.last_reading = None
            # Local Ono_Anna measurements favor SDPA; see the 2026-10-04 installation record.
            self.attention_implementation = "sdpa"
            self.model = Qwen3TTSModel.from_pretrained(model_dir, device_map="cuda:0", dtype=torch.bfloat16,
                                                      attn_implementation=self.attention_implementation, local_files_only=True)

        def generate_audio(self, text, file_name_no_ext=None):
            return self.generate_expressive_audio(text, None)

        def generate_expressive_audio(self, text, metadata):
            import numpy as np
            import soundfile as sf
            with self.lock:
                if metadata and metadata["requestId"] in BRIDGE.cancelled_requests:
                    raise asyncio.CancelledError("Obsolete synthesis was cancelled before GPU work")
                cue = metadata["cue"] if metadata else "natural"
                instruct = PRESETS[cue][0] if metadata else ""
                if metadata and hashlib.sha256(text.encode()).hexdigest() != metadata["text_sha256"]:
                    raise ValueError("TTS input differs from LG checked sentence")
                start = time.perf_counter()
                wavs, rate = self.model.generate_custom_voice(text=text, language="Chinese", speaker=self.speaker,
                                                             instruct=instruct, non_streaming_mode=True, max_new_tokens=1024)
                wav = np.asarray(wavs[0], dtype=np.float32)
                if not wav.size or not np.isfinite(wav).all() or not np.any(wav):
                    raise ValueError("Qwen produced invalid audio")
                path = self.generate_cache_file_name("lg-" + str(uuid.uuid4()))
                sf.write(path, wav, rate, subtype="PCM_16")
                self.last_reading = {"speaker": self.speaker, "sample_rate": rate, "frames": len(wav),
                                     "attention_implementation": self.attention_implementation,
                                     "synthesis_seconds": time.perf_counter() - start,
                                     "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
                                     "cue": cue, "instruct": instruct,
                                     **({"replyId": metadata["replyId"], "segmentId": metadata["segmentId"],
                                         "generation": metadata["generation"]} if metadata else {})}
                return path

    class LGOnlineASR(ASRInterface):
        def __init__(self, encoder, decoder, joiner, tokens, num_threads=2, **kwargs):
            import sherpa_onnx
            self.recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                encoder=encoder, decoder=decoder, joiner=joiner, tokens=tokens,
                num_threads=num_threads, sample_rate=16000, feature_dim=80, provider="cpu")
            self.lock = threading.Lock()

        def transcribe_np(self, audio):
            import numpy as np
            with self.lock:
                stream = self.recognizer.create_stream()
                stream.accept_waveform(16000, np.concatenate([np.asarray(audio, dtype=np.float32), np.zeros(4800, dtype=np.float32)]))
                stream.input_finished()
                while self.recognizer.is_ready(stream):
                    self.recognizer.decode_stream(stream)
                return self.recognizer.get_result(stream)

    class LGSenseVoiceASR(ASRInterface):
        def __init__(self, sense_voice, tokens, vad_model, num_threads=2, **kwargs):
            import sherpa_onnx
            import onnxruntime as ort
            self.recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
                model=sense_voice, tokens=tokens, num_threads=num_threads,
                provider="cpu", language="zh", use_itn=True)
            options = ort.SessionOptions()
            options.intra_op_num_threads = num_threads
            options.inter_op_num_threads = 1
            self.vad = ort.InferenceSession(vad_model, sess_options=options, providers=["CPUExecutionProvider"])
            self.lock = threading.Lock()
            self.last_reading = None

        def transcribe_np(self, audio):
            import numpy as np
            samples = np.asarray(audio, dtype=np.float32)
            if samples.ndim != 1 or not np.isfinite(samples).all():
                raise ValueError("ASR expects finite mono audio at 16 kHz")
            with self.lock:
                start = time.perf_counter()
                state = np.zeros((2, 1, 128), dtype=np.float32)
                context = np.zeros((1, 64), dtype=np.float32)
                peak = 0.0
                for offset in range(0, len(samples), 512):
                    window = samples[offset:offset + 512]
                    if len(window) < 512:
                        window = np.pad(window, (0, 512 - len(window)))
                    frame = np.concatenate([context, window.reshape(1, -1)], axis=1)
                    probability, state = self.vad.run(None, {"input": frame, "state": state,
                                                            "sr": np.array(16000, dtype=np.int64)})
                    context = frame[:, -64:]
                    peak = max(peak, float(probability[0, 0]))
                vad_seconds = time.perf_counter() - start
                text = ""
                if peak >= 0.5:
                    stream = self.recognizer.create_stream()
                    stream.accept_waveform(16000, np.concatenate([samples, np.zeros(4800, dtype=np.float32)]))
                    self.recognizer.decode_stream(stream)
                    text = stream.result.text.strip()
                self.last_reading = {"model": "SenseVoiceSmall INT8 CPU", "speech_detected": peak >= 0.5,
                    "vad_max_probability": peak, "vad_seconds": vad_seconds,
                    "total_seconds": time.perf_counter() - start,
                    "final_text_sha256": hashlib.sha256(text.encode()).hexdigest(), "final_empty": not bool(text)}
                return text


def lan_ipv4():
    """取本机在**默认路由**上的 IPv4。UDP `connect` 不发包，只是问一次路由表。"""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("8.8.8.8", 80))
            return probe.getsockname()[0]
    except OSError:
        return None


def print_bind_notice(bind_host, port):
    """`--bind-host` 不是回环时的**暴露面**提示（两种 mode 都打）。

    ⚠️ 只有非回环才打 ⇒ 缺省档的启动输出逐字不变（探针/门脚本按行读它）。
    ⚠️ 这是"监听在哪"的事实，**不是**"对方一定连得上"的保证：防火墙入站规则
       与手机热点的客户端隔离仍可能拦住，那是**另一台机器**上的读数。
    """
    if bind_host in ("127.0.0.1", "localhost", "::1"):
        return
    address = (lan_ipv4() or "<本机IPv4>") if bind_host in ("0.0.0.0", "::") else bind_host
    print(f"⚠️ 本次监听 {bind_host}:{port} —— **同网段设备可达**："
          f"在对方机器上打开 http://{address}:{port}/", flush=True)
    print("   这条路把她的入口开放给了整个网段；只想本机用就别带 --bind-host。", flush=True)


def print_launch_banner(mode, port):
    """启动横幅：**由 Python 打印，不由 `.cmd` 里 echo**（2026-10-05 事故后搬家）。

    ⚠️ 为什么要搬：批处理文件里出现中文、又在**同一个文件**里中途 `chcp 65001` 时，
       cmd 的批处理读取器会**偶发错位** —— 实测到过把一行中文的**后半截**当成命令
       执行（`'成后打开' is not recognized as an internal or external command`）。
       同一段文字放在 Python 侧（`-X utf8`）是稳定输出。

    ⚠️ 只有正式入口有横幅：皮套测试入口今天没有，本次不擅自给它加。
    ⚠️ 端口由调用方给（`serve()` 自己的 `port`）⇒ 横幅**不会**与真实端口不一致。
    """
    if mode != "production":
        return
    print("正式聊天：聊天进入正式记忆库。请先关闭其它正式聊天窗口和皮套测试服务。", flush=True)
    print(f"启动完成后打开 http://127.0.0.1:{port}/", flush=True)
    print("退出时按 Ctrl+C，等 LG_BRIDGE_CLOSED 后再关闭窗口。", flush=True)


async def serve(args):
    global BRIDGE
    port = 12394 if args.mode == "production" else 12393
    print_launch_banner(args.mode, port)
    print_bind_notice(args.bind_host, port)
    vt = configure_imports(args.deps_root)
    register_adapters()
    os.chdir(vt)
    from open_llm_vtuber.config_manager import read_yaml, validate_config
    from open_llm_vtuber.server import WebSocketServer
    import uvicorn
    # Refuse an occupied port before even attempting to open the database.
    with socket.socket() as probe:
        if os.name == "nt":
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        probe.bind((args.bind_host, port))
    BRIDGE = LGBridgeClient(args.repo_root, args.mode,
                            connect=None if args.connect_host is None else {
                                "host": args.connect_host, "port": args.connect_port,
                                "token": args.connect_token})
    # Lv4.5 / P3：BRIDGE 建好之后补挂**有来源角色输出**的投递口
    BRIDGE.on_character_output = CHARACTER_OUTPUT_HOOK
    await BRIDGE.start()
    # -------------------------------------------------------------------------
    # Lv4.5 / ADR-131 `D01` —— **裁定 C** 的第 ② 半：外壳自己的空闲上报器
    # -------------------------------------------------------------------------
    # ⚠️ 起点在 `BRIDGE.start()` **之后**：桥连上之前没有"报给谁"这回事。
    # ⚠️ 它是**幂等**启动且**自终止**（桥不活了就 return）⇒ 不留孤儿任务。
    start_idle_reporter()
    server = None
    try:
        conf = read_yaml("conf.yaml")
        conf["system_config"]["port"] = port
        conf["character_config"].update(
            conf_name="苏沐薇 · 正式聊天" if args.mode == "production" else "苏沐薇 · 皮套测试",
            conf_uid="lg-avatar-production" if args.mode == "production" else "lg-avatar-test")
        server = WebSocketServer(validate_config(conf))
        await server.initialize()
        # ---------------------------------------------------------------------
        # Lv4.5 / P2：把**流式 partial**接进启动（失败则如实降级，不拖垮正式链路）
        # ---------------------------------------------------------------------
        #
        # ⚠️ 为什么"失败也要继续"：partial 只服务"提前准备"；它装不上时正确行为是
        #    **没有 partial**（正式 SenseVoice 链路照常），而不是让整个皮套起不来。
        # ⚠️ 载入耗时（实测约 3.4 s）单列在 `/lg/status` 里 —— 它属冷启动，不混进热轮次。
        partial_model = Path(args.deps_root) / "models" / "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"
        partial_recognizer = None
        partial_error = None
        partial_load_ms = None
        if partial_model.is_dir():
            try:
                import time as _time
                import sherpa_onnx as _sherpa
                _started = _time.perf_counter()
                partial_recognizer = _sherpa.OnlineRecognizer.from_transducer(
                    tokens=str(partial_model / "tokens.txt"),
                    encoder=str(partial_model / "encoder.int8.onnx"),
                    decoder=str(partial_model / "decoder.onnx"),
                    joiner=str(partial_model / "joiner.int8.onnx"),
                    num_threads=2, sample_rate=16000, feature_dim=80,
                    decoding_method="greedy_search", provider="cpu")
                partial_load_ms = round((_time.perf_counter() - _started) * 1000, 1)
            except Exception as error:  # 缺模型/缺依赖/坏文件都走这里
                partial_error = type(error).__name__ + ": " + str(error)[:120]
        else:
            partial_error = "model_dir_missing"
        PARTIAL["recognizer"] = partial_recognizer
        PARTIAL["load_ms"] = partial_load_ms
        PARTIAL["error"] = partial_error
        print(f"LG_PARTIAL_ASR loadMs={partial_load_ms} error={partial_error}", flush=True)
        # Diagnostics contain ids and measurements, never prompt or dialogue contents.
        from fastapi import APIRouter
        router = APIRouter()

        @router.get("/lg/status")
        async def status():
            tts = server.default_context_cache.tts_engine
            asr = server.default_context_cache.asr_engine
            return {"mode": args.mode, "avatar": "lg_ulvm2_0001", "speaker": getattr(tts, "speaker", None),
                    "tts_model": conf["character_config"]["tts_config"]["tts_model"],
                    "asr_model": conf["character_config"]["asr_config"]["asr_model"],
                    "tts_attention": getattr(tts, "attention_implementation", "upstream SDPA"),
                    "tts_warmup_seconds": getattr(tts, "warmup_seconds", None),
                    "last_recognition": getattr(asr, "last_reading", None),
                    "lg_process_alive": BRIDGE.ready and BRIDGE.alive, "last_turn": BRIDGE.last_reading,
                    # Lv4.5 / P1：交付事实回报的计数（**只有计数与最后一个理由码**，不含正文）
                    "playback_reports": dict(BRIDGE.report_reading),
                    # Lv4.5 / P1：**取消的诚实读数**（"记下了意图"≠"停止发生了"）
                    "cancel_requests": dict(BRIDGE.cancel_reading),
                    # Lv4.5 / P3：**有来源角色输出的投递读数**（分列：真的播了 / 丢弃 / 没 sidecar）
                    "interjection": dict(INTERJECTION),
                    # -----------------------------------------------------------------
                    # Lv4.5 / ADR-131 `D18`（裁定 C）：**主动开口的读数**
                    # -----------------------------------------------------------------
                    # ⚠️ 与 `interjection` 并列、**不合并**：插话是"她说了一句"，开口是
                    #    "她**决定**说不说" —— 合成的总数会让"她被闸拦住了"这件事消失。
                    # ⚠️ 只有计数与具名理由码，**不含正文**（`D18`：正文只从 `CHARACTER_OUTPUT` 出去）。
                    "opportunity": {
                        "counters": dict(OPPORTUNITY),
                        # 外壳自己的空闲上报器（**裁定 C 的第 ② 半**）的可观测面。
                        # ⚠️ 没有这一格就无法回答"链到底有没有被触发过" —— WP7 要它。
                        "reporter": {
                            "running": (IDLE_REPORT_TASK["task"] is not None
                                        and not IDLE_REPORT_TASK["task"].done()),
                            "floorSeconds": IDLE_REPORT_FLOOR_SEC,
                            "tickSeconds": IDLE_REPORT_TICK_SEC,
                            # 距最后一次真实输入多久；`None` = 从来没输入过
                            # ⇒ 上报器**不会**报（"我不知道他闲了多久" ≠ "他闲了很久"）
                            "lastInputAgoSeconds": (None if LAST_INPUT["at"] is None
                                                    else round(time.time() - LAST_INPUT["at"], 1)),
                        },
                    },
                    # Lv4.5 / P2：**流式 partial 的读数**（按客户端；只放计数与最后一条文本）
                    "partial": {
                        "loadMs": PARTIAL["load_ms"],
                        "error": PARTIAL["error"],
                        # Lv4.5 / P2：只读准备的**判决**（发出去了 ≠ 真的准备了）
                        "prepare": dict(BRIDGE.prepare_reading),
                        "clients": {
                            uid: {
                                "partials": state.get("partials", 0),
                                "prepared": state.get("prepared", 0),
                                "lastPartial": state.get("stream").reading.get("last_partial") if state.get("stream") else None,
                                "chunks": state.get("stream").reading.get("chunks") if state.get("stream") else 0,
                                "decodeMsMax": state.get("stream").reading.get("decode_ms_max") if state.get("stream") else None,
                                "error": state.get("last_error"),
                            }
                            for uid, state in list(PARTIAL["readings"].items())[-4:]
                        },
                    },
                    # 合成账的**逐段判决**（只留最近 256 条；只有 segmentId 与判决码）
                    "synthesis_verdicts": dict(list(BRIDGE.synthesis_verdicts.items())[-8:]),
                    "last_synthesis": getattr(tts, "last_reading", None)}


        # Lv4.5 / P1：**播放事实入口**（浏览器 → 本服务 → LG 交付账）。
        #
        # ⚠️ 为什么要有它：只有浏览器知道"声音真的从声卡出来了"。服务端**不能**
        #    从"音频包发出去了"推断播出（媒体交付契约 §1 第一条禁令）。
        # ⚠️ 为什么走 HTTP 而不复用上游的 WebSocket 入站处理器：那条路属于上游外壳
        #    （改它要动冻结的 patch 锚点），而这条回报是**单向、幂等、不需要回复**的。
        # ⚠️ 失败一律如实返回，**不影响**播放：客户端本来就 `keepalive` 后不管结果。
        #
        # ⚠️ 本入口**等**桥的判决（`wait_ms`）并原样返回它：这是给**验收/诊断**用的，
        #    不是给浏览器的（浏览器 POST 完就不管）。"发出去了"与"账上真的记下了"
        #    是两件事 —— 把被安静拒收的回报显示成成功，正是计数掩盖真相的形态。
        PLAYBACK_STATES = ("synthesized", "queued", "playing", "played", "cancelled", "unknown")

        # ---------------------------------------------------------------------
        # Lv4.5 / ADR-131 `D18`：**机会报文的诊断触发入口**（本地回环、只读语义）
        # ---------------------------------------------------------------------
        # ⚠️ 它**不新增任何权威**：调的就是空闲上报器调的那个 `report_opportunity()` ——
        #    说不说、说什么仍然全由 LG 的 15 道闸 + 一次模型调用 + 回复守卫决定。
        #    它最坏能让 LG **评估一次**，而评估本身有冷却（30 分钟）与日额度（4 次）兜着。
        # ⚠️ 为什么要它：没有它，"链到底通没通"只能靠**等 3 分钟**
        #    （`IDLE_REPORT_FLOOR_SEC`）或靠翻日志 —— WP7 的真链路 smoke 需要一个人能
        #    **立刻**触发一次并**立刻**读回执。返回里只有计数与理由码（无正文，`D18`）。
        @router.post("/lg/opportunity")
        async def opportunity(body: dict):
            if BRIDGE is None or not BRIDGE.alive:
                return {"outcome": "rejected", "code": "opening_bridge_not_alive"}
            before = dict(OPPORTUNITY)
            await report_opportunity()
            after = dict(OPPORTUNITY)
            return {"outcome": "reported", "reading": after,
                    # 这一次调用**有没有改变读数**：全等 ⇒ 报文没送到（或结果不明）
                    "changed": before != after}

        @router.post("/lg/interrupt")
        async def interrupt(body: dict):
            request_ids = body.get("requestIds")
            if (not isinstance(request_ids, list) or not 1 <= len(request_ids) <= 16
                    or any(not isinstance(value, str) or not value or len(value) > 160 for value in request_ids)):
                return {"status": "failed", "code": "interrupt_bad_request"}
            results = await asyncio.gather(*(BRIDGE.interrupt(value) for value in dict.fromkeys(request_ids)))
            return {"status": "acknowledged" if all(item["status"] == "acknowledged" for item in results) else "failed",
                    "results": results}

        @router.post("/lg/reminder-receipt")
        async def reminder_receipt(body: dict):
            return await accept_local_reminder_receipt(body)

        @router.post("/lg/playback")
        async def playback(body: dict):
            segment_id = str(body.get("segmentId") or "").strip()
            state = str(body.get("state") or "").strip()
            if not segment_id or state not in PLAYBACK_STATES:
                return {"outcome": "rejected", "code": "playback_report_bad_request"}
            request_id = str(body.get("requestId") or "")[:120]
            if state == "synthesized":
                return await BRIDGE.report({"kind": "REPORT_SYNTHESIZED", "requestId": request_id,
                                            "segmentId": segment_id, "audioId": str(body.get("audioId") or "")[:200]},
                                           wait_ms=2000)
            # 交付账的迁移表不允许从 generated 直接跳到交付态：先如实补一条合成账。
            # 它由**本端点**替客户端补，因此也要等判决（`_record_verdict` 按 segmentId 归档）。
            await BRIDGE.report({"kind": "REPORT_SYNTHESIZED", "requestId": request_id, "segmentId": segment_id,
                                 "audioId": str(body.get("audioId") or f"{segment_id}@client-observed")[:200]})
            packet = {"kind": "REPORT_PLAYBACK", "requestId": request_id, "segmentId": segment_id, "playbackState": state}
            for key in ("playedFrom", "playedTo"):
                if isinstance(body.get(key), (int, float)) and not isinstance(body.get(key), bool):
                    packet[key] = float(body[key])
            if body.get("detail"):
                packet["detail"] = str(body["detail"])[:200]
            return await BRIDGE.report(packet, wait_ms=2000)

        # Lv4.5 / P1 计时：**同钟事件时间线**（写在 gitignore 的本地目录里）。
        #
        # ⚠️ 为什么要有它：计划 §3 要求"浏览器同钟记录最终输入提交、首次可感知反馈、
        #    首段实质语音实际播放、有效停止确认、停播及对应控制响应"。那些时刻**只**在
        #    浏览器里能取到 —— 而浏览器 DOM 我读不到。因此让客户端在**事件发生的当下**
        #    把读数发过来（`lg-client-timing`），服务端**只存读数、不存任何正文**。
        # ⚠️ 落盘位置在 `artifacts/post-lv2/local/`（gitignore，计划 §3 私有材料那一档）。
        CLIENT_TIMING_PATH = Path(args.repo_root) / "artifacts" / "post-lv2" / "local" / "client-timeline.jsonl"

        @router.post("/lg/client-timing")
        async def client_timing(body: dict):
            fields = body.get("fields")
            if not isinstance(fields, dict):
                return {"outcome": "rejected", "code": "timing_without_fields"}
            # 只留白名单里的**数字**读数：任何正文/文本字段一律丢弃（隐私边界）
            allowed = (
                "turnIndex", "generation", "submitMs", "firstFeedbackMs", "firstSpeechStartMs",
                "stopSignalMs", "stopAckMs", "stopObservedMs", "segmentCount", "playedCount",
                "cancelledCount", "sampleRate", "chunkCount", "vadMs",
            )
            safe = {key: body["fields"][key] for key in allowed
                    if key in fields and isinstance(fields[key], (int, float)) and not isinstance(fields[key], bool)}
            record = {"receivedAtMs": int(time.time() * 1000), **safe}
            try:
                CLIENT_TIMING_PATH.parent.mkdir(parents=True, exist_ok=True)
                with CLIENT_TIMING_PATH.open("a", encoding="utf-8") as handle:
                    handle.write(json.dumps(record, ensure_ascii=False) + "\n")
            except OSError as error:
                return {"outcome": "failed", "code": "timing_write_failed", "detail": type(error).__name__}
            return {"outcome": "stored", "fields": sorted(safe.keys())}

        # Must precede the upstream catch-all static mount.
        server.app.router.routes[0:0] = router.routes
        # 这行是**给机器读的**就绪标记（探针按 `http://127.0.0.1:<port>` 连本机），
        # 因此**刻意恒为回环**，不跟着 `--bind-host` 变；局域网地址另由 print_bind_notice 打。
        print(f"LG_AVATAR_READY http://127.0.0.1:{port} ({args.mode}; {server.default_context_cache.tts_engine.speaker})", flush=True)
        await uvicorn.Server(uvicorn.Config(server.app, host=args.bind_host, port=port, log_level="warning")).serve()
    finally:
        try:
            if server is not None:
                await server.default_context_cache.close()
        finally:
            await await_bridge_close(BRIDGE)


async def bridge_only(args):
    """post-Lv2 / ADR-109 WP3：**只跑 LG 桥客户端**（不装 VTuber 上游、不碰 ASR/TTS/音频）。

    ============================================================================
      它存在的理由
    ============================================================================
    WP3 剩下的那一半是"**外壳怎么连到共享核心**"，而那件事与"模型怎么渲染、
    声音怎么播"无关。把两者分开，才能在没有音频设备、没有上游依赖的环境里
    也**真的**验一次："外壳用**连接档**连上了，协议照样通，关掉它核心还在"。

    ⚠️ 它**不**是第二条聊天链路：用的还是同一个 `LGBridgeClient` 与同一张受控消息表。
    ⚠️ 读数打成**一行 JSON**（前缀 `BRIDGE_ONLY_READING`）给验收门解析。
    """
    global BRIDGE
    BRIDGE = LGBridgeClient(args.repo_root, args.mode, connect={
        "host": args.connect_host, "port": args.connect_port, "token": args.connect_token})
    reading = {"connect": args.connect_host + ":" + str(args.connect_port)}
    try:
        await BRIDGE.start()
        reading["entryHello"] = BRIDGE.entry_hello
        result = await BRIDGE.request({"kind": "SUBMIT_TURN", "requestId": args.probe_request_id,
                                       "userText": args.probe_text})
        reading["turn"] = {"outcome": result.get("outcome"), "code": result.get("code"),
                           "replyText": result.get("replyText"), "replyId": result.get("replyId"),
                           "traceId": result.get("traceId")}
        reply_id = str(result.get("replyId") or "")
        if reply_id:
            segment = reply_id + "#0"
            reading["synthesis"] = await BRIDGE.report(
                {"kind": "REPORT_SYNTHESIZED", "requestId": "probe-synth",
                 "segmentId": segment, "audioId": "probe-audio"}, wait_ms=5000)
            reading["playback"] = await BRIDGE.report(
                {"kind": "REPORT_PLAYBACK", "requestId": "probe-play",
                 "segmentId": segment, "playbackState": "played"}, wait_ms=5000)
        reading["cancel"] = await BRIDGE.request(
            {"kind": "CANCEL_TURN", "requestId": args.probe_request_id, "reason": "probe"})
        reading["reportReading"] = dict(BRIDGE.report_reading)
        reading["cancelReading"] = dict(BRIDGE.cancel_reading)
    finally:
        await BRIDGE.close()
    print("BRIDGE_ONLY_READING " + json.dumps(reading, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    sys.modules["postlv2_vtuber_runtime"] = sys.modules[__name__]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--deps-root", type=Path, default=Path.home() / "postlv2-deps")
    parser.add_argument("--mode", choices=("sandbox-copy", "production"), default="sandbox-copy")
    # ------------------------------------------------------------------------
    # post-Lv2 / ADR-109：**连接档**（连到 `--coexist` 的这条入口的监听）
    # ------------------------------------------------------------------------
    parser.add_argument("--connect-host", default=None,
                        help="共享核心的监听地址（给了它就**不**自己起 LG 子进程）")
    parser.add_argument("--connect-port", type=int, default=None)
    parser.add_argument("--connect-token", default=None)
    # ------------------------------------------------------------------------
    # 局域网访问（2026-10-08）：**缺省仍只绑回环**。要让同网段的别的机器连进来，
    # 必须**显式**给 `--bind-host 0.0.0.0`，并在防火墙放行入站 TCP 端口。
    # 不带这个参数时，监听地址与启动输出**逐字不变**。
    # ------------------------------------------------------------------------
    parser.add_argument("--bind-host", default="127.0.0.1",
                        help="HTTP/WS 监听地址；缺省 127.0.0.1（只本机可连）。"
                             "0.0.0.0 = 同网段可达（暴露面变大，用完请关掉窗口）")
    parser.add_argument("--bridge-only", action="store_true",
                        help="只跑 LG 桥客户端（不装 VTuber 上游 / 不碰 ASR/TTS）—— 给验收门用")
    parser.add_argument("--probe-text", default="probe")
    parser.add_argument("--probe-request-id", default="probe-1")
    args = parser.parse_args()
    if args.bridge_only:
        if not (args.connect_host and args.connect_port and args.connect_token):
            parser.error("--bridge-only 需要 --connect-host / --connect-port / --connect-token")
        try:
            asyncio.run(bridge_only(args))
        except KeyboardInterrupt:
            pass
        sys.exit(0)
    try:
        asyncio.run(serve(args))
    except KeyboardInterrupt:
        pass  # Ctrl+C is a normal user exit; serve() still awaits the bridge in finally.
