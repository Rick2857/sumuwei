"""Actual adapter/manager protocol with fake acoustic work; no model or database calls."""
import asyncio
import hashlib
import json
import threading
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import postlv2_vtuber_runtime as runtime
from postlv2_expression import presentation

ROOT = Path(__file__).resolve().parent.parent
runtime.configure_imports(Path.home() / "postlv2-deps")
runtime.register_adapters()
runtime.BRIDGE = SimpleNamespace(cancelled_requests=set())
from open_llm_vtuber.conversations.tts_manager import TTSTaskManager
from open_llm_vtuber.agent.output_types import DisplayText

checks = []
text = "我在这里。"
meta = presentation({"text": text, "cue": "reassuring", "segmentId": "reply#0"},
                    "reply", "request", 1, {"neutral": 0, "smile": 1, "surprised": 2})
actions = SimpleNamespace(lg_expression=meta, to_dict=lambda: {"lg_expression": meta})
display = DisplayText(text, "test", "test")


async def verify():
    sent = []
    received = asyncio.Event()
    release = threading.Event()
    drained = threading.Event()
    class AcousticWork:
        sample_rate = 24000
        def stream_expressive_audio(self, value, metadata):
            assert value == text and metadata == meta
            yield np.ones(2400, dtype=np.float32) * 0.05, 24000
            assert release.wait(5), "test did not release native work"
            yield np.ones(4800, dtype=np.float32) * 0.1, 24000
            drained.set()

    async def send(packet):
        sent.append(json.loads(packet))
        received.set()

    manager = TTSTaskManager()
    try:
        await manager.speak(text, display, actions, None, AcousticWork(), send)
        await asyncio.wait_for(received.wait(), 3)
        assert not manager.task_list[0].done()
        assert sent[0]["index"] == 0 and not sent[0]["final"]
        checks.append("first real transport packet arrives before native work completes")
        release.set()
        await asyncio.gather(*manager.task_list)
        await asyncio.wait_for(manager._payload_queue.join(), 3)
        assert [p["index"] for p in sent] == [0, 1, 2]
        assert sent[-1]["final"] and not sent[-1]["failed"]
        assert sent[0]["display_text"]["text"] == text and sent[1]["display_text"] is None
        assert all(p["actions"]["lg_expression"]["text_sha256"] == hashlib.sha256(text.encode()).hexdigest() for p in sent)
        checks.append("one subtitle and immutable LG identity across all chunks and final marker")
    finally:
        release.set()
        manager.clear()

    received.clear()
    release.clear()
    drained.clear()
    sent.clear()
    cancelled_manager = TTSTaskManager()
    try:
        await cancelled_manager.speak(text, display, actions, None, AcousticWork(), send)
        await asyncio.wait_for(received.wait(), 3)
        runtime.BRIDGE.cancelled_requests.add("request")
        cancelled_manager.task_list[0].cancel()
        await asyncio.gather(*cancelled_manager.task_list, return_exceptions=True)
        release.set()
        assert await asyncio.to_thread(drained.wait, 3)
        await asyncio.sleep(0)
        assert len(sent) == 1
        checks.append("cancel drops late native chunks while draining acoustic work")
    finally:
        release.set()
        cancelled_manager.clear()
        runtime.BRIDGE.cancelled_requests.clear()

    ordered = TTSTaskManager()
    sent.clear()
    sender = asyncio.create_task(ordered._process_payload_queue(send))
    try:
        await ordered._payload_queue.put(({"type": "later"}, 1))
        await asyncio.sleep(0)
        assert not sent
        await ordered._payload_queue.put(({"type": "first-part", "_lg_stream_final": False}, 0))
        await ordered._payload_queue.put(({"type": "first-end", "_lg_stream_final": True}, 0))
        await asyncio.wait_for(ordered._payload_queue.join(), 3)
        assert [p["type"] for p in sent] == ["first-part", "first-end", "later"]
        checks.append("later sentence waits for the earlier sentence final marker")
    finally:
        sender.cancel()
        await asyncio.gather(sender, return_exceptions=True)

    silent = runtime.LGSenseVoiceASR.__new__(runtime.LGSenseVoiceASR)
    silent.lock = threading.Lock()
    class QuietVad:
        def run(self, _, inputs):
            assert inputs["input"].shape == (1, 576)
            return np.zeros((1, 1), dtype=np.float32), inputs["state"]
    class NeverDecode:
        def create_stream(self):
            raise AssertionError("non-speech must not invoke ASR")
    silent.vad, silent.recognizer = QuietVad(), NeverDecode()
    for samples in [np.zeros(0, dtype=np.float32), np.zeros(16000, dtype=np.float32)]:
        assert silent.transcribe_np(samples) == ""
    checks.append("empty and non-speech input never invokes the acoustic recognizer")
    try:
        silent.transcribe_np(np.array([np.nan], dtype=np.float32))
        raise AssertionError("invalid audio was accepted")
    except ValueError:
        checks.append("invalid waveform rejected before inference")

asyncio.run(verify())
out = ROOT / "artifacts/post-lv2/asr-tts-selection-20261004/streaming-backend-offline.json"
out.write_text(json.dumps({"pass": len(checks), "fail": 0, "checks": checks,
                          "scope": "real adapter and queue with fake acoustic work; no model or DB"}, indent=2), encoding="utf-8")
print(json.dumps({"pass": len(checks), "fail": 0}))
