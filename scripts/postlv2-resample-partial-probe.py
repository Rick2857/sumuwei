"""Lv4.5 · P2 前置读数 2 —— **从麦克风采样率重采样到 16 kHz 再流式识别**。

============================================================================
 为什么需要这一份（第一份探针漏掉的前提）
============================================================================
`postlv2-partial-probe.py` 喂的是模型自带的 16 kHz 测试音频。但皮套网页拿到的
麦克风音频**不是** 16 kHz —— 浏览器 `AudioContext` 的默认采样率通常是 48000（有时 44100）。
`LGSenseVoiceASR` 现在直接把浏览器交来的那段音频按 16 kHz 交给识别器；
而流式 Zipformer **只接受 16 kHz**。

⇒ 在把流式识别接进网页之前，必须先回答：

```text
① 48000 → 16000 重采样之后，识别结果还对不对？（不是"能不能跑"，是"字对不对"）
② 重采样的代价是多少毫秒？（它要加在每一块的实时路径上）
③ 不做重采样（按 48k 硬喂给 16k 模型）会错成什么样？（这是**负控**：
   如果那样也能过，说明我量的东西根本没有区分力）
```

⚠️ 输入是**合成音**（`voice-samples/`，16 kHz）**上采样到 48 kHz** 再降回来 ——
   这是可控的往返对照，**不是**真人麦克风证据。
   真人麦克风读数仍 `NOT RUN`（计划 §4.6：需要排时段）。

用法：
    python postlv2-resample-partial-probe.py <wav16k> [more...] --out <summary.json>
"""

from __future__ import annotations

import argparse
import json
import time
import wave
from pathlib import Path

import numpy as np
import sherpa_onnx

DEPS = Path(r"C:\Users\user\postlv2-deps")
ZIPFORMER = DEPS / "models" / "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"
SENSEVOICE = DEPS / "models" / "sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"

MIC_RATE = 48000
MODEL_RATE = 16000
CHUNK_MS = 100


def read_wav(path: Path, expect_rate: int) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        channels, rate, width, frames = (
            handle.getnchannels(),
            handle.getframerate(),
            handle.getsampwidth(),
            handle.readframes(handle.getnframes()),
        )
    if width != 2:
        raise SystemExit(f"只处理 16-bit PCM，收到 width={width}")
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels == 2:
        samples = samples.reshape(-1, 2).mean(axis=1)
    if rate != expect_rate:
        raise SystemExit(f"{path.name} 期望 {expect_rate} Hz，收到 {rate} Hz")
    return samples


def resample_linear(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    """与浏览器侧同构的最简做法：线性插值。

    ⚠️ 刻意**不**用高阶重采样：网页端能用的最便宜、最可预测的那一档就是线性。
       如果线性插值不够好，那"在网页里重采样"这条路线本身就要重新评估。
    """
    if source_rate == target_rate:
        return samples
    duration = len(samples) / source_rate
    target_count = int(round(duration * target_rate))
    source_positions = np.arange(target_count, dtype=np.float64) * (source_rate / target_rate)
    left = np.floor(source_positions).astype(np.int64)
    right = np.minimum(left + 1, len(samples) - 1)
    weight = (source_positions - left).astype(np.float32)
    return (samples[left] * (1.0 - weight) + samples[right] * weight).astype(np.float32)


def build_zipformer():
    started = time.perf_counter()
    recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(ZIPFORMER / "tokens.txt"),
        encoder=str(ZIPFORMER / "encoder.int8.onnx"),
        decoder=str(ZIPFORMER / "decoder.onnx"),
        joiner=str(ZIPFORMER / "joiner.int8.onnx"),
        num_threads=2,
        sample_rate=MODEL_RATE,
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
        num_threads=2,
        provider="cpu",
        language="zh",
        use_itn=True,
    )
    return recognizer, int((time.perf_counter() - started) * 1000)


def normalize(text: str) -> str:
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
    return 1.0 if longest == 0 else round(1.0 - edit_distance(a, b) / longest, 4)


def stream_text(recognizer, samples: np.ndarray, rate: int) -> tuple[str, int, int]:
    """按块喂并收尾，返回 (final, 毫秒, partial 变化次数)。"""
    chunk = int(rate * CHUNK_MS / 1000)
    stream = recognizer.create_stream()
    started = time.perf_counter()
    changes = 0
    previous = ""
    for offset in range(0, len(samples), chunk):
        stream.accept_waveform(rate, samples[offset : offset + chunk])
        while recognizer.is_ready(stream):
            recognizer.decode_stream(stream)
        text = recognizer.get_result(stream)
        if text != previous:
            changes += 1
            previous = text
    stream.accept_waveform(rate, np.zeros(int(rate * 0.5), dtype=np.float32))
    stream.input_finished()
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    return recognizer.get_result(stream), int((time.perf_counter() - started) * 1000), changes


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path, nargs="+")
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()

    zipformer, zipformer_load_ms = build_zipformer()
    sensevoice, sensevoice_load_ms = build_sensevoice()

    samples_by_file = []
    for path in args.wav:
        samples_by_file.append((path, read_wav(path, MODEL_RATE)))

    readings = []
    for path, samples16 in samples_by_file:
        upsample_started = time.perf_counter()
        simulated_mic = resample_linear(samples16, MODEL_RATE, MIC_RATE)
        upsample_ms = (time.perf_counter() - upsample_started) * 1000
        downsample_started = time.perf_counter()
        back_to_16k = resample_linear(simulated_mic, MIC_RATE, MODEL_RATE)
        downsample_ms = (time.perf_counter() - downsample_started) * 1000

        # ① 正控：网页形态（48k 麦克风 → 线性重采样到 16k → 流式识别）
        round_trip_text, round_trip_ms, round_trip_changes = stream_text(zipformer, back_to_16k, MODEL_RATE)
        # ② 参照：直接喂 16k 原始（第一份探针的形态）
        direct_text, direct_ms, _ = stream_text(zipformer, samples16, MODEL_RATE)
        # ③ 负控：把 48k 硬当 16k 喂（不做重采样）—— 应当明显更差，否则本判据没有区分力
        naive_text, naive_ms, _ = stream_text(zipformer, simulated_mic, MODEL_RATE)

        # 正式 final（离线 SenseVoice）作为参照文本
        sense_stream = sensevoice.create_stream()
        sense_stream.accept_waveform(
            MODEL_RATE, np.concatenate([samples16, np.zeros(4800, dtype=np.float32)])
        )
        sensevoice.decode_stream(sense_stream)
        reference = sense_stream.result.text.strip()

        readings.append(
            {
                "wav": path.name,
                "audioSeconds": round(len(samples16) / MODEL_RATE, 3),
                "resampleMs": {
                    "upTo48k": round(upsample_ms, 3),
                    "downTo16k": round(downsample_ms, 3),
                    "perSecondDownMs": round(downsample_ms / (len(samples16) / MODEL_RATE), 3),
                },
                "roundTrip": {
                    "final": round_trip_text,
                    "wallMs": round_trip_ms,
                    "partialChanges": round_trip_changes,
                    "similarityToDirect": similarity(normalize(round_trip_text), normalize(direct_text)),
                },
                "direct16k": {"final": direct_text, "wallMs": direct_ms},
                "naive48kAsWide16k": {
                    "final": naive_text,
                    "wallMs": naive_ms,
                    "similarityToDirect": similarity(normalize(naive_text), normalize(direct_text)),
                },
                "offlineReference": reference,
                "roundTripSimilarityToReference": similarity(normalize(round_trip_text), normalize(reference)),
            }
        )

    batch = {
        "probe": "Lv4.5 P2 prerequisite 2: microphone-rate resampling into the streaming recognizer",
        "modelLoadMs": {"zipformerStreaming": zipformer_load_ms, "sensevoice": sensevoice_load_ms},
        "micRate": MIC_RATE,
        "modelRate": MODEL_RATE,
        "resampler": "linear interpolation (the cheapest option a web page can use predictably)",
        "samples": readings,
        "notClaimed": [
            "输入是合成音上采样到 48k 再降回来：可控的往返对照，不是真人麦克风证据",
            "不主张任何阈值；本探针只回答重采样后字对不对、代价多少、以及不做重采样是否会明显变差",
            "浏览器里真正的采样率（48000 或 44100）与实际音频链路仍未测",
        ],
    }
    text = json.dumps(batch, ensure_ascii=False, indent=2)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
