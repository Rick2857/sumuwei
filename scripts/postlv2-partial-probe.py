"""后 Lv2 · Lv4.5 P2 前置探针 —— **两遍识别**的读数（不是"把整段录音切几片"）。

============================================================================
 载体：`docs/post-lv2/Lv4.5-Lean-Execution-Plan-2026-10-04.md` §2「两个实现选择」第 1 条
       「先用现有 Zipformer 验证临时 partial 接口，SenseVoice 仍负责正式 final；
         这是增加计算支路的探针，鉴于用户要求两遍识别作备用，**不默认启用为正式配置**。」
============================================================================

它回答三个**可判定的**问题（不是"流式能不能用"这种没边界的问题）：

```text
① partial 到底有没有用？
   喂到第 t 毫秒时，识别文本已经稳定到接近 final 了吗？
   ⇒ 读数：firstNonEmptyMs · stableAtMs（此后不再变化）· stableFraction（占音频比例）
② 两遍识别是不是重复劳动？
   Zipformer 的 final 与 SenseVoice 的 final 在**同一段音频**上差多少字？
   ⇒ 读数：逐字相似度 + 编辑距离（归一化：去标点与空白）
③ 代价面：这一支路让每轮多花多少时间？
   ⇒ 读数：两条链的墙钟耗时（**不**含模型加载，加载单列）
```

⚠️ 本探针**不主张**任何准确率结论：
   · 输入是**合成音**（`voice-samples/*.wav`，为声音克隆准备的同域样本）+ 厂商测试音频
     —— 不是真人麦克风，也不构成"普遍准确率"；真人读数仍 `NOT RUN`。
   · 结果只用于"要不要按这条路线继续做 P2"的判断，不写进任何验收主张。

用法：
    python postlv2-partial-probe.py <wav> [--out <summary.json>] [--timeline <timeline.jsonl>]
"""

from __future__ import annotations

import argparse
import json
import time
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort
import sherpa_onnx

DEPS = Path(r"C:\Users\user\postlv2-deps")
"""
⚠️ 用**生产在用的那一档**（`conf.yaml` 的 `lg_sensevoice` 配套流式档：
`sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30`），不是旧的 14M 2023 档 ——
拿旧档测出来的 partial 行为**不能**代表现网可用的那一档。
"""
ZIPFORMER = DEPS / "models" / "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"
ZIPFORMER_FILES = ("encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx")
SENSEVOICE = DEPS / "models" / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
VAD_MODEL = DEPS / "Open-LLM-VTuber" / "frontend" / "libs" / "silero_vad_v5.onnx"

SAMPLE_RATE = 16000
CHUNK_MS = 100
VAD_THRESHOLD = 0.5
NUM_THREADS = 2


def read_wav_16k_mono(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        rate = handle.getframerate()
        width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise SystemExit(f"探针只处理 16-bit PCM，收到 width={width}")
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels == 2:
        samples = samples.reshape(-1, 2).mean(axis=1)
    if rate != SAMPLE_RATE:
        raise SystemExit(f"探针只处理 {SAMPLE_RATE} Hz，收到 {rate} Hz")
    return samples


def normalize(text: str) -> str:
    """比对用归一化：去空白与中英标点（**只**用于比对，不改写识别原文）。"""
    dropped = set(" \t\r\n，。！？、；：“”‘’（）《》…—,.!?;:\"'()<>-")
    return "".join(ch for ch in text if ch not in dropped).lower()


def edit_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def similarity(a: str, b: str) -> float:
    longest = max(len(a), len(b))
    if longest == 0:
        return 1.0
    return round(1.0 - edit_distance(a, b) / longest, 4)


def build_zipformer():
    started = time.perf_counter()
    encoder, decoder, joiner = ZIPFORMER_FILES
    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(ZIPFORMER / "tokens.txt"),
        encoder=str(ZIPFORMER / encoder),
        decoder=str(ZIPFORMER / decoder),
        joiner=str(ZIPFORMER / joiner),
        num_threads=NUM_THREADS,
        sample_rate=SAMPLE_RATE,
        feature_dim=80,
        decoding_method="greedy_search",
        provider="cpu",
    )
    return recognizer, int((time.perf_counter() - started) * 1000)


def build_sensevoice():
    started = time.perf_counter()
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(SENSEVOICE / "model.int8.onnx"),
        tokens=str(SENSEVOICE / "tokens.txt"),
        num_threads=NUM_THREADS,
        provider="cpu",
        language="zh",
        use_itn=True,
    )
    options = ort.SessionOptions()
    options.intra_op_num_threads = NUM_THREADS
    options.inter_op_num_threads = 1
    vad = ort.InferenceSession(str(VAD_MODEL), sess_options=options, providers=["CPUExecutionProvider"])
    return recognizer, vad, int((time.perf_counter() - started) * 1000)


def vad_peak(vad, samples: np.ndarray) -> tuple[float, int]:
    """与生产适配器同一套：逐 512 帧推进，取最大语音概率。"""
    started = time.perf_counter()
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, 64), dtype=np.float32)
    peak = 0.0
    for offset in range(0, len(samples), 512):
        window = samples[offset : offset + 512]
        if len(window) < 512:
            window = np.pad(window, (0, 512 - len(window)))
        frame = np.concatenate([context, window.reshape(1, -1)], axis=1)
        probability, state = vad.run(None, {"input": frame, "state": state, "sr": np.array(SAMPLE_RATE, dtype=np.int64)})
        context = frame[:, -64:]
        peak = max(peak, float(probability[0, 0]))
    return peak, int((time.perf_counter() - started) * 1000)


def run_zipformer_stream(recognizer, samples: np.ndarray):
    """按块喂，逐块记录**当前**识别文本（partial 就是这么产生的）。"""
    chunk_size = int(SAMPLE_RATE * CHUNK_MS / 1000)
    stream = recognizer.create_stream()
    timeline: list[dict] = []
    started = time.perf_counter()
    for index, offset in enumerate(range(0, len(samples), chunk_size)):
        stream.accept_waveform(SAMPLE_RATE, samples[offset : offset + chunk_size])
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        timeline.append(
            {
                "chunk": index,
                "elapsedMs": int((time.perf_counter() - started) * 1000),
                "audioMs": int((min(offset + chunk_size, len(samples)) / SAMPLE_RATE) * 1000),
                "text": recognizer.get_result(stream),
            }
        )
    tail = np.zeros(int(SAMPLE_RATE * 0.5), dtype=np.float32)
    stream.accept_waveform(SAMPLE_RATE, tail)
    stream.input_finished()
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    stream_ms = int((time.perf_counter() - started) * 1000)
    return timeline, recognizer.get_result(stream), stream_ms


def probe_one(wav: Path, zipformer, sensevoice, vad, output: dict | None = None) -> dict:
    """跑一份音频，返回一份读数（**不**加载模型：模型由调用方复用）。"""
    samples = read_wav_16k_mono(wav)
    duration_s = len(samples) / SAMPLE_RATE

    timeline, zipformer_final, zipformer_ms = run_zipformer_stream(zipformer, samples)
    if output is not None:
        output["timeline"] = timeline

    vad_started = time.perf_counter()
    peak, vad_ms = vad_peak(vad, samples)
    speech_detected = peak >= VAD_THRESHOLD
    sensevoice_text = ""
    decode_ms = 0
    if speech_detected:
        decode_started = time.perf_counter()
        stream = sensevoice.create_stream()
        stream.accept_waveform(
            SAMPLE_RATE, np.concatenate([samples, np.zeros(4800, dtype=np.float32)])
        )
        sensevoice.decode_stream(stream)
        sensevoice_text = stream.result.text.strip()
        decode_ms = int((time.perf_counter() - decode_started) * 1000)
    sensevoice_ms = int((time.perf_counter() - vad_started) * 1000)
    if output is not None:
        output["streamingWallMs"] = zipformer_ms
        output["offlineWallMs"] = sensevoice_ms

    nonempty = [item for item in timeline if item["text"].strip() != ""]
    # "稳定点"：此后到收尾之前**再没有**变化的那一块
    stable_at_ms = None
    if nonempty:
        last_change = nonempty[0]
        previous = ""
        for item in nonempty:
            if item["text"] != previous:
                last_change = item
                previous = item["text"]
        stable_at_ms = last_change["audioMs"]

    changes = 0
    previous_text = ""
    for item in nonempty:
        if item["text"] != previous_text:
            changes += 1
            previous_text = item["text"]

    zip_norm = normalize(zipformer_final)
    sense_norm = normalize(sensevoice_text)
    return {
        "wav": wav.name,
        "audioSeconds": round(duration_s, 3),
        "chunkMs": CHUNK_MS,
        "chunks": len(timeline),
        "streaming": {
            "model": ZIPFORMER.name,
            "wallMs": zipformer_ms,
            "realtimeFactor": round((zipformer_ms / 1000) / duration_s, 3),
            "partialChanges": changes,
            "nonEmptyPartials": len(nonempty),
            "firstNonEmptyMs": nonempty[0]["audioMs"] if nonempty else None,
            "firstNonEmptyText": nonempty[0]["text"] if nonempty else "",
            "lastPartialText": nonempty[-1]["text"] if nonempty else "",
            "stableAtMs": stable_at_ms,
            "stableFractionOfAudio": round(stable_at_ms / (duration_s * 1000), 3) if stable_at_ms else None,
            "final": zipformer_final,
            "finalEqualsLastPartial": zipformer_final == (nonempty[-1]["text"] if nonempty else ""),
        },
        "offline": {
            "model": SENSEVOICE.name,
            "vadModel": VAD_MODEL.name,
            "vadPeakProbability": round(peak, 4),
            "speechDetected": speech_detected,
            "vadMs": vad_ms,
            "decodeMs": decode_ms,
            "wallMs": sensevoice_ms,
            "final": sensevoice_text,
        },
        "agreement": {
            "normalizedZipformer": zip_norm,
            "normalizedSensevoice": sense_norm,
            "characterSimilarity": similarity(zip_norm, sense_norm),
            "editDistance": edit_distance(zip_norm, sense_norm),
            "lengthZipformer": len(zip_norm),
            "lengthSensevoice": len(sense_norm),
        },
        "cost": {
            "streamingWallMs": zipformer_ms,
            "offlineWallMs": sensevoice_ms,
            "extraMsIfBothRun": zipformer_ms + sensevoice_ms,
            "note": "两条链都在 CPU 上跑；模型加载单列，不计入每轮代价",
        },
    }


NOT_CLAIMED = [
    "输入是合成音（voice-samples）或厂商测试音频，**不是**真人麦克风 ⇒ 不构成准确率结论",
    "不主张任何阈值；本探针只回答 partial 是否有用、两遍是否重复、代价多少",
    "真人麦克风与浏览器实际 partial/final 仍需联合测试（计划 §3 第一步的 ASR 行）",
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path, nargs="+", help="一份或多份 wav（多份 = 模型只加载一次）")
    parser.add_argument("--out", type=Path, help="单份时的 summary.json")
    parser.add_argument("--timeline", type=Path, help="单份时的逐块时间线 jsonl")
    parser.add_argument("--batch-out", type=Path, help="多份时的汇总 json")
    args = parser.parse_args()

    zipformer, zipformer_load_ms = build_zipformer()
    sensevoice, vad, sensevoice_load_ms = build_sensevoice()

    if len(args.wav) == 1:
        output: dict = {}
        reading = probe_one(args.wav[0], zipformer, sensevoice, vad, output)
        report = {
            "probe": "Lv4.5 P2 two-pass ASR prerequisite",
            "modelLoadMs": {
                "zipformerStreaming": zipformer_load_ms,
                "sensevoicePlusVad": sensevoice_load_ms,
            },
            **reading,
            "notClaimed": NOT_CLAIMED,
        }
        text = json.dumps(report, ensure_ascii=False, indent=2)
        if args.out:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(text + "\n", encoding="utf-8")
        if args.timeline:
            args.timeline.parent.mkdir(parents=True, exist_ok=True)
            args.timeline.write_text(
                "\n".join(json.dumps(item, ensure_ascii=False) for item in output.get("timeline", [])) + "\n",
                encoding="utf-8",
            )
        print(text)
        return 0

    samples = []
    for wav in args.wav:
        output = {}
        reading = probe_one(wav, zipformer, sensevoice, vad, output)
        reading["path"] = str(wav)
        samples.append(reading)
    batch = {
        "probe": "Lv4.5 P2 two-pass ASR prerequisite (batch)",
        "modelLoadMs": {
            "zipformerStreaming": zipformer_load_ms,
            "sensevoicePlusVad": sensevoice_load_ms,
        },
        "samples": samples,
        "notClaimed": NOT_CLAIMED,
    }
    text = json.dumps(batch, ensure_ascii=False, indent=2)
    if args.batch_out:
        args.batch_out.parent.mkdir(parents=True, exist_ok=True)
        args.batch_out.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
