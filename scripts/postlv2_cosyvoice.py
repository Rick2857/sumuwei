"""Local CosyVoice3 execution of LG's checked text and finite presentation cues."""
import asyncio
import hashlib
import sys
import threading
import time
import uuid
from pathlib import Path

from open_llm_vtuber.tts.tts_interface import TTSInterface
from postlv2_expression import PRESETS

REFERENCE_SHA256 = "5d6f1575f4578b43ac1859f651d426b3a0428cb6f03d85a552c9be465d85b18e"


def cosy_instruction(cue):
    return ("You are a helpful assistant. " + PRESETS[cue][0] +
            "逐字朗读给定文本，保持每个字和句尾语气词，不做改写。<|endofprompt|>")


class LGCosyVoiceTTS(TTSInterface):
    def __init__(self, model_dir, reference_audio, deps_root):
        import soundfile as sf
        import torch
        import torchaudio
        deps = Path(deps_root)
        reference = Path(reference_audio)
        if hashlib.sha256(reference.read_bytes()).hexdigest() != REFERENCE_SHA256:
            raise ValueError("CosyVoice reference differs from the selected Ono_Anna sample")
        sys.path[:0] = [str(deps / "CosyVoice"), str(deps / "CosyVoice/third_party/Matcha-TTS")]
        from cosyvoice.cli.cosyvoice import AutoModel
        from cosyvoice.cli import frontend

        # PCM reference decoding avoids TorchCodec's FFmpeg DLL requirement.
        def read_reference(path, target_sr, min_sr=16000):
            samples, sr = sf.read(path, dtype="float32", always_2d=True)
            speech = torch.from_numpy(samples.T.copy()).mean(dim=0, keepdim=True)
            if sr != target_sr:
                if sr < min_sr:
                    raise ValueError("Reference sample rate is too low")
                speech = torchaudio.transforms.Resample(sr, target_sr)(speech)
            return speech

        frontend.load_wav = read_reference
        torch.set_num_threads(2)
        self.model = AutoModel(model_dir=model_dir, fp16=True)
        self.sample_rate = self.model.sample_rate
        if self.sample_rate != 24000:
            raise ValueError("Unreviewed CosyVoice sample rate")
        self.reference = str(reference)
        self.lock = threading.Lock()
        self.speaker = "Ono_Anna reference clone"
        self.last_reading = None
        for cue in PRESETS:
            self.model.add_zero_shot_spk(cosy_instruction(cue), self.reference, cue)
        start = time.perf_counter()
        # Model warmup never creates an LG turn or a playback packet.
        for _ in self.stream_expressive_audio("你好。", None):
            pass
        self.warmup_seconds = time.perf_counter() - start
        self.last_reading = None

    def stream_expressive_audio(self, text, metadata):
        import numpy as np
        from postlv2_vtuber_runtime import BRIDGE
        if metadata and hashlib.sha256(text.encode()).hexdigest() != metadata["text_sha256"]:
            raise ValueError("TTS input differs from LG checked sentence")
        cue = metadata["cue"] if metadata else "natural"
        with self.lock:
            if metadata and metadata["requestId"] in BRIDGE.cancelled_requests:
                raise asyncio.CancelledError("Obsolete synthesis cancelled before GPU work")
            # Upstream grows this field while streaming; reset under our serial lock.
            self.model.model.token_hop_len = 25
            start = time.perf_counter()
            frames, chunks, first = 0, 0, None
            for result in self.model.inference_instruct2(text, cosy_instruction(cue), self.reference,
                    zero_shot_spk_id=cue, stream=True, text_frontend=False):
                wav = result["tts_speech"].squeeze().detach().cpu().numpy().astype(np.float32)
                if wav.ndim != 1 or not wav.size or not np.isfinite(wav).all():
                    raise ValueError("CosyVoice produced invalid audio")
                first = first if first is not None else time.perf_counter() - start
                frames += len(wav)
                chunks += 1
                # Drain native inference after an interrupt so its thread/caches close.
                if not metadata or metadata["requestId"] not in BRIDGE.cancelled_requests:
                    yield wav, self.sample_rate
            if not frames:
                raise ValueError("CosyVoice produced no audio")
            self.last_reading = {"model": "CosyVoice3", "speaker": self.speaker, "cue": cue,
                "sample_rate": self.sample_rate, "frames": frames, "chunks": chunks,
                "first_chunk_seconds": first, "synthesis_seconds": time.perf_counter() - start,
                "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
                **({key: metadata[key] for key in ("replyId", "segmentId", "generation")} if metadata else {})}

    def generate_audio(self, text, file_name_no_ext=None):
        return self.generate_expressive_audio(text, None)

    def generate_expressive_audio(self, text, metadata):
        import numpy as np
        import soundfile as sf
        chunks = list(self.stream_expressive_audio(text, metadata))
        if not chunks:
            raise asyncio.CancelledError("Obsolete synthesis discarded")
        path = self.generate_cache_file_name("lg-cosy-" + str(uuid.uuid4()))
        sf.write(path, np.concatenate([wav for wav, _ in chunks]), chunks[0][1], subtype="PCM_16")
        return path
