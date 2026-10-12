"""Lv4.5 / `P3` —— **有来源短句真的被外壳念出来**（离线探针，不开 GPU、不连网）。

============================================================================
 它证明什么
============================================================================
```text
① `CHARACTER_OUTPUT` 到达 shell ⇒ 走的是**与正式轮次完全相同**的那条路：
   `TTSTaskManager.speak(...)` ⇒ `_process_tts`（被包装过的那一支）⇒ 分块音频包
② 先发 `lg-expression-turn`（客户端据此开新一轮表达），再发音频块
③ **没有 sidecar** 时不硬播：如实记 `character_output_without_expression`
④ **没有活着的客户端**时不乱播：如实记 `character_output_no_live_client`
```
⚠️ 它**不**证明：真模型真的产出了这样一条短句（当前**没有**生产者 —— 见报告里的边界）。
    它证明的是"LG 交出来之后，外壳那一半确实会念"。

用法： `python scripts/postlv2-interjection-probe.py`
"""

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEPS = Path(r"C:\Users\user\postlv2-deps")


def load_runtime():
    spec = importlib.util.spec_from_file_location("lg_runtime", REPO / "scripts" / "postlv2_vtuber_runtime.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules["lg_runtime"] = module
    spec.loader.exec_module(module)
    return module


class FakeWebSocket:
    def __init__(self):
        self.sent = []

    async def send_text(self, text):
        self.sent.append(text)


class FakeTTSEngine:
    """只产出**两块** sin 波，用来证明"真的走了合成分块那条路"。"""
    sample_rate = 24000

    def __init__(self):
        self.calls = []

    def stream_expressive_audio(self, text, metadata):
        import numpy as np
        self.calls.append({"text": text, "segmentId": metadata.get("segmentId")})
        for index in range(2):
            yield np.zeros(240, dtype="float32"), self.sample_rate


class SlowTTSEngine(FakeTTSEngine):
    """故意**慢**的引擎：让"用户抢话"能落在合成**进行中**，而不是事后。

    ⚠️ 它还数**自己产出了几块** —— 那才是"作废让生产停下来了吗"的直接读数。
    """
    total_planned = 20

    def __init__(self):
        super().__init__()
        self.yielded = 0

    def stream_expressive_audio(self, text, metadata):
        import time as _time
        import numpy as np
        self.calls.append({"text": text, "segmentId": metadata.get("segmentId")})
        for index in range(self.total_planned):
            _time.sleep(0.05)
            self.yielded += 1
            yield np.zeros(240, dtype="float32"), self.sample_rate


class FakeLive2D:
    emo_map = {}


class FakeContext:
    def __init__(self, engine):
        self.tts_engine = engine
        self.live2d_model = FakeLive2D()


class FakeHandler:
    def __init__(self, context, uid):
        self.client_contexts = {uid: context}


def make_message(with_expression=True, text="我在。", source="wake_response"):
    payload = {"revision": 9, "source": source, "sourceRefs": ["ev:wake:1"], "text": text, "yieldFloor": True}
    if with_expression:
        payload["expression"] = {
            "replyId": "interjection:9",
            "checkedTextSha256": "0" * 64,
            "fallback": "ok",
            "segments": [{"segmentId": "interjection:9#0", "text": text, "cue": "firm",
                          "expression": "neutral", "gesture": "none"}],
        }
    return {"kind": "CHARACTER_OUTPUT", "requestId": "", "outcome": "spoken", "characterOutput": payload}


async def run():
    module = load_runtime()
    # ⚠️ 必须**先**把这些准备好：`register_adapters()` 直接写 `BRIDGE.on_character_output`，
    #    而它假定 BRIDGE 已经存在（生产里是 `serve()` 先建的）。
    #    探针不拉起 LG 进程 —— 这里只建一个**空壳客户端**，用来挂投递口。
    module.configure_imports(DEPS)
    module.BRIDGE = module.LGBridgeClient(REPO, "sandbox-copy")
    module.register_adapters()

    results = {}

    def reading():
        return dict(module.INTERJECTION)

    # ---- ① 没有活着的客户端 ⇒ 不乱播 ------------------------------------
    module.LIVE_CLIENT.update({"server": None, "uid": None, "websocket": None})
    await module.BRIDGE.on_character_output(make_message())
    results["noLiveClient"] = reading()["last_code"]

    # ---- ② 有客户端但没有 sidecar ⇒ 如实报"没法播" ----------------------
    uid = "probe-client-0001"
    websocket = FakeWebSocket()
    engine = FakeTTSEngine()
    handler = FakeHandler(FakeContext(engine), uid)
    module.LIVE_CLIENT.update({"server": handler, "uid": uid, "websocket": websocket})
    await module.BRIDGE.on_character_output(make_message(with_expression=False))
    results["withoutExpression"] = reading()["last_code"]
    results["payloadsWithoutExpression"] = len(websocket.sent)

    # ---- ③ 完整的一条 ⇒ 先 turn 包、再音频块 ----------------------------
    before = reading()["spoken"]
    await module.BRIDGE.on_character_output(make_message())
    results["spokenDelta"] = reading()["spoken"] - before
    results["lastCode"] = reading()["last_code"]
    results["lastSource"] = reading()["last_source"]
    packets = []
    for raw in websocket.sent:
        try:
            packets.append(json.loads(raw))
        except ValueError:
            packets.append({"type": "unparsed"})
    results["packetTypes"] = [item.get("type") for item in packets]
    results["firstPacketGeneration"] = packets[0].get("generation") if packets else None
    audio = [item for item in packets if item.get("type") == "lg-audio-chunk"]
    results["audioChunks"] = len(audio)
    results["hasExpressionMeta"] = bool(audio and (audio[0].get("actions") or {}).get("lg_expression"))
    results["engineCalls"] = [call["text"] for call in engine.calls]
    results["displayTextPresent"] = bool(audio and audio[0].get("display_text"))

    # ---- ④ 用户抢话 ⇒ **正在说的那条必须被掐掉** ------------------------
    #
    # ⚠️ 这一条与"播放层的 stop"是两件事：上游取消的是**那一轮**的任务，而插话
    #    **不属于任何一轮**（它是主动发出的）⇒ 不掐它，用户抢话之后她还会说完。
    slow_engine = SlowTTSEngine()
    slow_ws = FakeWebSocket()
    slow_context = FakeContext(slow_engine)
    slow_handler = FakeHandler(slow_context, uid)
    module.LIVE_CLIENT.update({"server": slow_handler, "uid": uid, "websocket": slow_ws})
    speaking = asyncio.create_task(module.BRIDGE.on_character_output(make_message()))
    await asyncio.sleep(0.05)  # 让它真的开始合成
    results["revokeRequested"] = module.INTERJECTION_REVOKE["fn"](uid)
    results["revokeOfOtherClient"] = module.INTERJECTION_REVOKE["fn"]("someone-else")
    try:
        await asyncio.wait_for(speaking, timeout=2)
        results["speakingTaskOutcome"] = "finished"
    except asyncio.CancelledError:
        results["speakingTaskOutcome"] = "cancelled"
    except asyncio.TimeoutError:
        results["speakingTaskOutcome"] = "timed out"
    results["revokedCount"] = reading()["revoked"]
    # ⚠️ 判据是"**抢话之后不再有声音**"，不是"一个包都不再发"。
    #
    # 实测：作废之后仍可能收到一条 **空音频** 的 `final` 包 —— 那是**客户端收尾
    # 信号**（告诉它这一段结束了、别再等），不是声音。把两者混成一个数字，会让
    # "用户已经让她闭嘴、但客户端还在等"这种真问题看起来和"收尾信号"一样。
    slow_packets = []
    for raw in slow_ws.sent:
        try:
            item = json.loads(raw)
        except ValueError:
            continue
        if item.get("type") != "lg-audio-chunk":
            slow_packets.append({"type": item.get("type"), "audioBytes": 0})
            continue
        slow_packets.append({
            "type": "lg-audio-chunk",
            "audioBytes": len(item.get("audio") or ""),
            "final": bool(item.get("final")),
        })
    results["slowPackets"] = slow_packets
    results["audioBytesAfterRevoke"] = sum(item["audioBytes"] for item in slow_packets)
    results["slowEngineYielded"] = slow_engine.yielded
    results["slowEnginePlanned"] = slow_engine.total_planned
    # 抢话之后再要一条 ⇒ 必须还能说（作废的是**那一条**，不是这个能力）
    module.LIVE_CLIENT.update({"server": handler, "uid": uid, "websocket": websocket})
    spoken_before_second = reading()["spoken"]
    await module.BRIDGE.on_character_output(make_message())
    results["spokenAfterRevoke"] = reading()["spoken"] - spoken_before_second

    checks = {
        "无活客户端时如实拒绝": results["noLiveClient"] == "character_output_no_live_client",
        "没有 sidecar 时不硬播": results["withoutExpression"] == "character_output_without_expression",
        "没有 sidecar 时一个音频包都不发": results["payloadsWithoutExpression"] == 0,
        "完整的短句真的被念了": results["spokenDelta"] == 1 and results["lastCode"] is None,
        "先发 turn 包（客户端据此开新表达）": results["packetTypes"][:1] == ["lg-expression-turn"],
        "turn 包带 generation": isinstance(results["firstPacketGeneration"], int),
        "音频分块真的产出": results["audioChunks"] >= 2,
        "音频包带表达元数据": results["hasExpressionMeta"],
        "音频包带字幕文本": results["displayTextPresent"],
        "合成分块走的就是被包装的那条路": results["engineCalls"] == ["我在。"],
        "用户抢话能掐掉正在说的插话": results["revokeRequested"] is True and results["speakingTaskOutcome"] == "cancelled",
        "抢话作废**单独计数**（不是投递失败）": results["revokedCount"] >= 1,
        "抢话让**生产**真的停下来（20 块只出了极少）": results["slowEngineYielded"] <= 2,
        "抢话之后**没有新的**声音块（在途的那块不算）":
            len([item for item in results["slowPackets"] if item.get("audioBytes")]) <= 1,
        "别的客户端的抢话掐不到这一条": results["revokeOfOtherClient"] is False,
        "抢话之后这个能力仍然可用": results["spokenAfterRevoke"] == 1,
    }
    verdict = "PASS" if all(checks.values()) else "FAIL"
    print(json.dumps({
        "probe": "Lv4.5 P3 interjection reaches the shell's own TTS path",
        "checks": checks,
        "readings": results,
        "verdict": verdict,
        "notClaimed": [
            "不证明真模型真的产出过这样一条短句：当前**没有**生产者调用 emitCharacterOutput",
            "不开 GPU、不连网、不碰真实库：假 TTS 引擎只产出零样本",
            "不与真实浏览器联测：前端表达/播放那一半仍是同一套既有链路",
        ],
    }, ensure_ascii=False, indent=2))
    return 0 if verdict == "PASS" else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
