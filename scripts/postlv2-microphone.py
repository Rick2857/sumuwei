"""Single-utterance local microphone test; private evidence, no LG database."""

import argparse
import json
import os
import subprocess
import time
import uuid
import wave
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import sherpa_onnx
import sounddevice as sd

ROOT = Path(__file__).resolve().parent.parent
DEPS = Path(os.environ.get("POSTLV2_DEPS_ROOT", r"C:\Users\user\postlv2-deps"))
MODELS = {
    "14m": ("sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23",
            "encoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.int8.onnx", "joiner-epoch-99-avg-1.int8.onnx"),
    "2025": ("sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30",
             "encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx"),
}


def recognizer(model_id):
    name, encoder, decoder, joiner = MODELS[model_id]
    model = DEPS / "models" / name
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(model / "tokens.txt"),
        encoder=str(model / encoder),
        decoder=str(model / decoder),
        joiner=str(model / joiner),
        num_threads=2, sample_rate=16000, feature_dim=80, provider="cpu",
        enable_endpoint_detection=True,
        rule1_min_trailing_silence=2.4, rule2_min_trailing_silence=1.2,
        rule3_min_utterance_length=300,
    )


def input_device(index):
    index = int(sd.default.device[0]) if index is None else index
    if index < 0 or index >= len(sd.query_devices()):
        raise ValueError(f"麦克风编号无效：{index}，请用 --list-devices 查看")
    info = sd.query_devices(index, "input")
    rate = int(info["default_samplerate"])
    sd.check_input_settings(device=index, channels=1, samplerate=rate, dtype="float32")
    return index, info, rate


@contextmanager
def audio_source(args):
    if args.wav:
        with wave.open(str(args.wav), "rb") as audio:
            if audio.getsampwidth() != 2 or audio.getnchannels() != 1:
                raise ValueError("文件验证只接受单声道 PCM16 WAV")
            rate = audio.getframerate()

            def chunks():
                while data := audio.readframes(rate // 10):
                    yield np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768, False

            yield rate, {"source": "test_file", "file": str(args.wav)}, chunks()
    else:
        index, info, rate = input_device(args.device)
        print(f"麦克风：[{index}] {info['name']} ({rate} Hz)")
        input("按回车开始录音。请说一句中文，停顿约 2 秒结束；最长 15 秒。Ctrl+C 取消。\n")
        with sd.InputStream(device=index, channels=1, dtype="float32", samplerate=rate) as audio:

            def chunks():
                for _ in range(150):
                    samples, overflow = audio.read(rate // 10)
                    yield samples[:, 0], overflow

            print("正在录音，请说话……", flush=True)
            yield rate, {"source": "microphone", "device": index, "deviceName": info["name"]}, chunks()


def main():
    parser = argparse.ArgumentParser(description="中文流式麦克风测试（不写聊天或记忆）")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--list-devices", action="store_true", help="列出输入设备，不录音")
    mode.add_argument("--check", action="store_true", help="检查模型并采集 0.3 秒，验证设备可打开")
    mode.add_argument("--wav", type=Path, help="用 WAV 验证识别程序；不算真人麦克风证据")
    parser.add_argument("--device", type=int, help="麦克风编号；缺省使用 Windows 默认输入")
    parser.add_argument("--model", choices=MODELS, default="2025", help="2025 为当前默认方案；14m 为旧版回退对照")
    args = parser.parse_args()

    if args.list_devices:
        for index, info in enumerate(sd.query_devices()):
            if info["max_input_channels"] > 0:
                print(f"[{index}] {info['name']} / {sd.query_hostapis(info['hostapi'])['name']}")
        return 0

    engine = recognizer(args.model)
    if args.check:
        index, info, rate = input_device(args.device)
        with sd.InputStream(device=index, channels=1, dtype="float32", samplerate=rate) as audio:
            samples, overflow = audio.read(int(rate * 0.3))
        if overflow or samples.size == 0 or not np.isfinite(samples).all() or not audio.closed:
            raise RuntimeError("麦克风采集或关闭检查失败")
        print(json.dumps({
            "status": "DEVICE_READY", "device": index, "deviceName": info["name"],
            "sampleRate": rate, "capturedFrames": len(samples), "streamClosed": audio.closed,
            "sherpaOnnxVersion": sherpa_onnx.__version__, "sounddeviceVersion": sd.__version__,
            "asrModel": MODELS[args.model][0],
            "humanTranscription": "NOT RUN",
        }, ensure_ascii=False, indent=2))
        return 0

    print(f"识别模型：{MODELS[args.model][0]}", flush=True)
    run_id = "microphone-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    directory = ROOT / "artifacts" / "post-lv2" / "local" / run_id
    subprocess.run(["git", "check-ignore", "-q", str(directory / "events.jsonl")], cwd=ROOT, check=True)
    directory.mkdir(parents=True)
    stream = engine.create_stream()
    changes = frames = overflows = 0
    last_text = ""
    peak = 0.0
    cancelled = False
    with audio_source(args) as (rate, source, chunks):
        started = time.monotonic()
        with wave.open(str(directory / "input.wav"), "wb") as recording, (directory / "events.jsonl").open("w", encoding="utf-8") as events:
            recording.setparams((1, 2, rate, 0, "NONE", "not compressed"))
            try:
                for samples, overflow in chunks:
                    if not np.isfinite(samples).all():
                        raise RuntimeError("输入包含非有限音频值")
                    frames += len(samples)
                    overflows += int(overflow)
                    peak = max(peak, float(np.max(np.abs(samples))))
                    recording.writeframesraw((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())
                    stream.accept_waveform(rate, samples)
                    while engine.is_ready(stream):
                        engine.decode_stream(stream)
                    text = engine.get_result(stream)
                    if text != last_text:
                        changes += 1
                        last_text = text
                        events.write(json.dumps({"kind": "partial", "utteranceId": run_id, "revision": changes, "elapsedMs": round((time.monotonic() - started) * 1000), "text": text}, ensure_ascii=False) + "\n")
                        events.flush()
                        print(f"识别中：{text}", flush=True)
                    if engine.is_endpoint(stream) and text:
                        break
            except KeyboardInterrupt:
                cancelled = True
        elapsed_ms = round((time.monotonic() - started) * 1000)

    final = ""
    if not cancelled:
        stream.accept_waveform(rate, np.zeros(int(rate * 0.5), dtype=np.float32))
        stream.input_finished()
        while engine.is_ready(stream):
            engine.decode_stream(stream)
        final = engine.get_result(stream)
    status = "CANCELLED" if cancelled else "AUDIO_OVERFLOW" if overflows else "TRANSCRIBED" if final.strip() else "NO_SPEECH"
    with (directory / "events.jsonl").open("a", encoding="utf-8") as events:
        events.write(json.dumps({"kind": "cancelled" if cancelled else "final", "utteranceId": run_id, "revision": changes + 1, "text": final}, ensure_ascii=False) + "\n")
    (directory / "transcript.txt").write_text(final + "\n", encoding="utf-8")
    (directory / "summary.json").write_text(json.dumps({
        "runId": run_id, **source, "status": status, "sampleRate": rate,
        "asrModel": MODELS[args.model][0], "decodingMethod": "greedy_search",
        "capturedFrames": frames, "audioSeconds": round(frames / rate, 3),
        "elapsedMs": elapsed_ms, "partialChanges": changes, "inputOverflows": overflows,
        "peak": round(peak, 6), "finalNonEmpty": bool(final.strip()),
        "humanAccuracy": "NOT RUN", "lgConversationIntegration": "NOT RUN",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n最终识别：{final or '（没有识别到语音）'}\n状态：{status}\n本地证据：{directory}")
    return 0 if status == "TRANSCRIBED" else 130 if cancelled else 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n已取消，麦克风已关闭。")
        raise SystemExit(130)
    except (ValueError, RuntimeError, OSError, subprocess.CalledProcessError, sd.PortAudioError) as error:
        print(f"测试失败：{error}")
        raise SystemExit(1)
