"""Check the actual Python speech consumer; --live uses a copied LG database and local CosyVoice."""
import argparse
import asyncio
import base64
import hashlib
import json
import time
from pathlib import Path
from types import SimpleNamespace

import postlv2_vtuber_runtime as runtime


async def offline(deps):
    runtime.configure_imports(deps)
    runtime.register_adapters()
    from open_llm_vtuber.agent.input_types import BatchInput, TextData, TextSource
    from open_llm_vtuber.agent.output_types import SentenceOutput
    source = BatchInput(texts=[TextData(TextSource.INPUT, "离线测试")])
    model = SimpleNamespace(emo_map={"neutral": 0, "smile": 1})
    segment = {"segmentId": "cev:char:conv:2#0", "text": "第一句。", "cue": "natural"}
    expression = {"version": "lg-expression@1", "replyId": "cev:char:conv:2", "segments": [segment]}
    for malformed in (False, True):
        client = runtime.LGBridgeClient(Path.cwd())
        release = asyncio.Event()

        async def packets(packet):
            request_id = packet["requestId"]
            yield {"kind": "SPEECH_SEGMENT", "requestId": request_id, "speech": {
                "replyId": expression["replyId"], "segmentIndex": 0, "segment": segment,
                "guardStates": [f"{name}:not_run" for name in
                    ("memory_truth", "action_truth", "evidence_truth", "search_need")]}}
            await release.wait()
            yield {"kind": "TURN_RESULT", "requestId": request_id, "outcome": "replied",
                "replyId": expression["replyId"], "replyText": "不同正文。" if malformed else segment["text"],
                "expression": expression, "streamStatus": "completed"}

        client.stream_turn = packets
        runtime.BRIDGE = client
        agent = runtime.LGBridgeAgent(model)
        consumer = agent.chat(source)
        assert (await anext(consumer))["type"] == "lg-expression-turn"
        first = await asyncio.wait_for(anext(consumer), 2)
        assert isinstance(first, SentenceOutput)
        assert not release.is_set() and client.last_reading["stream_status"] == "generating"
        release.set()
        if malformed:
            assert (await anext(consumer))["type"] == "lg-speech-stream-failed"
            try:
                await anext(consumer)
                raise AssertionError("A mismatched final reply was accepted")
            except ValueError:
                pass
            assert agent.active_request in client.cancelled_requests
        else:
            assert [item async for item in consumer] == [], "Final reply must not replay its first sentence"
            assert client.last_reading["streamed_segments"] == 1
        await consumer.aclose()

    # Closing a live consumer cleans its queue and sends a real cancellation request.
    client = runtime.LGBridgeClient(Path.cwd())
    requests = []
    blocked = asyncio.Event()

    async def request(packet):
        requests.append(packet)
        if packet["kind"] == "SUBMIT_TURN":
            client.speech_queues[packet["requestId"]].put_nowait({"kind": "SPEECH_SEGMENT"})
            await blocked.wait()
        return {"kind": "CANCEL_RESULT"}

    client.request = request
    stream = client.stream_turn({"kind": "SUBMIT_TURN", "requestId": "close-probe"})
    assert (await anext(stream))["kind"] == "SPEECH_SEGMENT"
    await stream.aclose()
    await asyncio.sleep(0)
    assert not client.speech_queues
    assert "close-probe" in client.cancelled_requests
    assert any(packet["kind"] == "CANCEL_TURN" for packet in requests)
    print("PASS: Python consumes before completion, avoids replay, rejects mismatch and cancels closed consumers")


async def live(deps, output, case):
    from open_llm_vtuber.agent.input_types import BatchInput, TextData, TextSource
    from open_llm_vtuber.agent.output_types import SentenceOutput
    from open_llm_vtuber.conversations.tts_manager import TTSTaskManager
    import numpy as np
    repo = Path(__file__).resolve().parent.parent
    runtime.BRIDGE = runtime.LGBridgeClient(repo, "sandbox-copy")
    manager = TTSTaskManager()
    chunks = []
    first_sentence = None
    first_tts_start = None
    final_turn = None
    started = None
    await runtime.BRIDGE.start()
    try:
        engine = runtime.LGCosyVoiceTTS(str(deps / "models/Fun-CosyVoice3-0.5B-2512"),
            str(deps / "voices/Ono_Anna-reference.wav"), str(deps))
        synthesize = engine.stream_expressive_audio

        def observed_synthesis(text, metadata):
            nonlocal first_tts_start
            if first_tts_start is None:
                first_tts_start = round((time.perf_counter() - started) * 1000)
            yield from synthesize(text, metadata)

        engine.stream_expressive_audio = observed_synthesis
        model = SimpleNamespace(emo_map=json.loads((deps / "Open-LLM-VTuber/model_dict.json").read_text(encoding="utf-8"))[0]["emotionMap"])
        agent = runtime.LGBridgeAgent(model)

        async def send(payload):
            packet = json.loads(payload)
            if packet.get("type") == "lg-audio-chunk" and packet.get("audio"):
                audio = base64.b64decode(packet["audio"])
                assert np.isfinite(np.frombuffer(audio, dtype="<f4")).all()
                chunks.append({"ms": round((time.perf_counter() - started) * 1000),
                    "segmentId": packet["actions"]["lg_expression"]["segmentId"],
                    "bytes": len(audio), "sha256": hashlib.sha256(audio).hexdigest(),
                    "generation_status": runtime.BRIDGE.last_reading.get("stream_status")})

        started = time.perf_counter()
        prompt = ("请讲一个温暖的虚构故事：傍晚散步时遇见一只小猫。开头一句话短一点，"
                  "然后慢慢讲完，多说一些细节，篇幅五百字左右。" if case == "long" else
                  "请用八个完整的短句解释为什么散步会让人放松，每句话十五到二十个字。")
        async for item in agent.chat(BatchInput(texts=[TextData(TextSource.INPUT, prompt)])):
            if isinstance(item, SentenceOutput):
                first_sentence = first_sentence if first_sentence is not None else round((time.perf_counter() - started) * 1000)
                await manager.speak(item.tts_text, item.display_text, item.actions, model, engine, send)
        final_turn = round((time.perf_counter() - started) * 1000)
        await asyncio.gather(*manager.task_list)
        await manager._payload_queue.join()
        assert chunks, "No real audio was delivered"
        reading = {"scope": "sandbox-copy / real test model / real CosyVoice / in-process transport sink",
            "first_sentence_ms": first_sentence, "first_audio_ms": chunks[0]["ms"],
            "first_tts_start_ms": first_tts_start, "tts_before_final_turn": first_tts_start < final_turn,
            "final_turn_ms": final_turn, "audio_before_final_turn": chunks[0]["ms"] < final_turn,
            "model_generating_at_first_audio": chunks[0]["generation_status"] == "generating",
            "chunks": len(chunks), "last_turn": runtime.BRIDGE.last_reading,
            "browser_playback": "NOT RUN", "input": f"synthetic {case} multi-sentence request"}
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(reading, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({key: value for key, value in reading.items() if key != "last_turn"}, ensure_ascii=False))
        assert reading["tts_before_final_turn"], "Actual TTS started only after the complete reply"
    finally:
        if manager._sender_task:
            manager._sender_task.cancel()
            await asyncio.gather(manager._sender_task, return_exceptions=True)
        await runtime.BRIDGE.close()


async def main(args):
    await offline(args.deps_root)
    if args.live:
        await live(args.deps_root, args.output, args.case)
    if args.cancel_live:
        repo = Path(__file__).resolve().parent.parent
        client = runtime.LGBridgeClient(repo, "sandbox-copy")
        await client.start()
        stream = client.stream_turn({"kind": "SUBMIT_TURN", "requestId": "stream-cancel-live",
            "userText": "请用八个完整的短句解释为什么散步会让人放松，每句话十五到二十个字。"})
        packets = []
        try:
            first = await anext(stream)
            assert first["kind"] == "SPEECH_SEGMENT"
            packets.append(first)
            cancellation = await client.request({"kind": "CANCEL_TURN", "requestId": "stream-cancel-live",
                "reason": "isolated streaming cancellation probe"})
            packets.extend([packet async for packet in stream])
            terminal = packets[-1]
            reading = {"scope": "real test model / sandbox-copy / cancel after first checked sentence",
                "cancel": cancellation.get("cancel"), "outcome": terminal.get("outcome"),
                "streamStatus": terminal.get("streamStatus"), "code": terminal.get("code"),
                "replyId": terminal.get("replyId"), "traceId": terminal.get("traceId"),
                "speech_packets": len([packet for packet in packets if packet["kind"] == "SPEECH_SEGMENT"]),
                "persisted_prefix_sha256": hashlib.sha256(terminal.get("replyText", "").encode()).hexdigest(),
                "final_segment_count": len((terminal.get("expression") or {}).get("segments", []))}
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(reading, indent=2), encoding="utf-8")
            print(json.dumps(reading))
            assert terminal.get("streamStatus") == "cancelled" and terminal.get("outcome") == "failed"
            assert terminal.get("replyId") == first["speech"]["replyId"]
            assert terminal.get("replyText", "").startswith(first["speech"]["segment"]["text"])
        finally:
            await stream.aclose()
            await client.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deps-root", type=Path, default=Path.home() / "postlv2-deps")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--cancel-live", action="store_true")
    parser.add_argument("--case", choices=("short", "long"), default="short")
    parser.add_argument("--output", type=Path, default=Path("artifacts/post-lv2/text-stream-20261005/live.json"))
    asyncio.run(main(parser.parse_args()))
