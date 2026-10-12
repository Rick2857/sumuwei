"""Fresh LG bridge and test endpoint; copy database, no TTS/GPU/browser playback."""
import asyncio
import hashlib
import json
import time
from pathlib import Path
from postlv2_vtuber_runtime import LGBridgeClient


async def main():
    repo = Path(__file__).resolve().parent.parent
    bridge = LGBridgeClient(repo, "sandbox-copy")
    rows = []
    await bridge.start()
    try:
        for index, text in enumerate([
            "今天有点疲惫，想安静说两句。",
            "请记下一个目标：今天写完一份报告提纲。",
            "我刚才说的那份报告提纲已经写完了。",
        ]):
            started = time.perf_counter()
            segments = []
            first_ms = None
            terminal = None
            async for packet in bridge.stream_turn({"kind": "SUBMIT_TURN", "requestId": f"latency-readback:{index}", "userText": text}):
                if packet.get("kind") == "SPEECH_SEGMENT":
                    if first_ms is None:
                        first_ms = round((time.perf_counter() - started) * 1000)
                    segments.append(packet["speech"]["segment"])
                elif packet.get("kind") == "TURN_RESULT":
                    terminal = packet
            assert terminal is not None
            rows.append({"case": index, "outcome": terminal.get("outcome"), "first_checked_sentence_ms": first_ms,
                         "final_turn_ms": round((time.perf_counter() - started) * 1000),
                         "first_sentence_codepoints": len(segments[0]["text"]) if segments else None,
                         "segments": len(segments), "timings_ms": terminal.get("timings"),
                         "replyId": terminal.get("replyId"), "streamStatus": terminal.get("streamStatus"),
                         "checked_text_sha256": hashlib.sha256(terminal.get("replyText", "").encode()).hexdigest(),
                         "complete_reply_matches_segments": "".join(segment["text"] for segment in segments) == terminal.get("replyText", "")})
            print(json.dumps(rows[-1], ensure_ascii=False), flush=True)
    finally:
        # EOF drains the owned bridge normally; never kills an existing service.
        await bridge.close()
    directory = repo / "artifacts/post-lv2" / ("latency-readback-" + str(time.time_ns()))
    directory.mkdir(parents=True)
    reading = {"scope": "Fresh sandbox-copy / test endpoint / actual ChatSession / checked sentences; no TTS or playback; no paired production speed claim",
               "rows": rows, "graceful_bridge_exit_code": bridge.process.returncode}
    (directory / "reading.json").write_text(json.dumps(reading, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({"directory": str(directory), **reading}, ensure_ascii=False), flush=True)
    assert bridge.process.returncode == 0
    assert all(row["outcome"] == "replied" and row["segments"] > 0 and row["complete_reply_matches_segments"] for row in rows)


if __name__ == "__main__":
    asyncio.run(main())
