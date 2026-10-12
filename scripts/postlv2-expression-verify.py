"""Exercise the actual Qwen adapter with a fake acoustic model; no GPU/model download."""
import hashlib
import json
import tempfile
import threading
import asyncio
import time
from pathlib import Path
from types import SimpleNamespace
import numpy as np
import postlv2_vtuber_runtime as runtime
from postlv2_expression import PRESETS, checked_segments, presentation

runtime.configure_imports(Path.home() / 'postlv2-deps')
runtime.register_adapters()
runtime.BRIDGE = SimpleNamespace(cancelled_requests=set())
observed = []

class AcousticStub:
    def generate_custom_voice(self, **kwargs):
        observed.append(kwargs)
        return [np.ones(2400, dtype=np.float32) * 0.05], 24000

engine = runtime.LGQwenTTS.__new__(runtime.LGQwenTTS)
engine.speaker = 'Ono_Anna'
engine.lock = threading.Lock()
engine.model = AcousticStub()
engine.attention_implementation = 'sdpa'
checks = []
with tempfile.TemporaryDirectory(prefix='lg-expression-audio-') as cache:
    engine.generate_cache_file_name = lambda stem: str(Path(cache) / (stem + '.wav'))
    for cue in PRESETS:
        text = '你好。'
        segment = {'text': text, 'cue': cue, 'segmentId': 'reply#0'}
        meta = presentation(segment, 'reply', 'request', 1, {'neutral': 0, 'smile': 1, 'surprised': 2})
        path = engine.generate_expressive_audio(text, meta)
        assert Path(path).is_file()
        assert observed[-1]['instruct'] == PRESETS[cue][0]
        assert observed[-1]['text'] == text and observed[-1]['speaker'] == 'Ono_Anna'
        assert engine.last_reading['text_sha256'] == meta['text_sha256']
        checks.append('actual adapter preserves text and uses cue: ' + cue)
    assert len({item['instruct'] for item in observed}) == 6
    async def verify_queue():
        from open_llm_vtuber.conversations.tts_manager import TTSTaskManager
        from open_llm_vtuber.agent.output_types import DisplayText
        manager = TTSTaskManager()
        jobs = []
        for index, cue in enumerate(['reassuring', 'firm']):
            text = f'第{index}句话。'
            item = presentation({'text': text, 'cue': cue, 'segmentId': f'reply#{index}'}, 'reply', 'queued', 1,
                                {'neutral': 0, 'smile': 1, 'surprised': 2})
            actions = SimpleNamespace(lg_expression=item, to_dict=lambda data=item: {'lg_expression': data})
            jobs.append(manager._process_tts(text, DisplayText(text), actions, None, engine, index))
        await asyncio.gather(*jobs)
        packets = [await manager._payload_queue.get() for _ in jobs]
        for packet, index in packets:
            assert packet['actions']['lg_expression']['segmentId'] == f'reply#{index}'
            assert packet['actions']['lg_expression']['cue'] == ['reassuring', 'firm'][index]
            assert packet['display_text']['text'] == f'第{index}句话。'
            assert packet['audio']
        checks.append('actual upstream queue preserves independent per-sentence cues across concurrent tasks')

        started = threading.Event()
        class SlowAcousticStub(AcousticStub):
            def generate_custom_voice(self, **kwargs):
                started.set()
                time.sleep(0.08)
                return super().generate_custom_voice(**kwargs)
        engine.model = SlowAcousticStub()
        item = presentation({'text': '取消测试。', 'cue': 'playful', 'segmentId': 'cancel#0'}, 'cancel', 'cancel', 2,
                            {'neutral': 0, 'smile': 1, 'surprised': 2})
        actions = SimpleNamespace(lg_expression=item, to_dict=lambda: {'lg_expression': item})
        before = set(Path(cache).glob('*.wav'))
        task = asyncio.create_task(manager._process_tts('取消测试。', DisplayText('取消测试。'), actions, None, engine, 2))
        while not started.is_set(): await asyncio.sleep(0.005)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0.15)
        assert manager._payload_queue.empty()
        assert set(Path(cache).glob('*.wav')) == before
        checks.append('cancelled native worker emits no late payload and disposes its late audio file')
        engine.model = AcousticStub()
    asyncio.run(verify_queue())
    meta['text_sha256'] = 'wrong'
    try:
        engine.generate_expressive_audio('不同的正文。', meta)
        raise AssertionError('Mismatch must reject')
    except ValueError:
        checks.append('checked sentence hash mismatch rejects before inference')
    meta = presentation({'text': '你好。', 'cue': 'reassuring', 'segmentId': 'reply#0'}, 'reply', 'request', 1, {'neutral': 0})
    assert meta['cue'] == 'natural' and meta['gesture'] == 'none' and meta['fallback'] == 'missing_expression'
    checks.append('missing facial resource falls back to natural and no gesture')
    good = {'replyId': 'reply', 'replyText': '你好。', 'expression': {'version': 'lg-expression@1', 'replyId': 'reply',
        'segments': [{'segmentId': 'reply#0', 'text': '你好。', 'cue': 'natural'}]}}
    checked_segments(good)
    good['replyText'] = '另一句话。'
    try:
        checked_segments(good)
        raise AssertionError('Sidecar must reject')
    except ValueError:
        checks.append('bridge sidecar cannot replace checked speech')

out = Path(__file__).resolve().parent.parent / 'artifacts/post-lv2/expression-integration-20261004'
out.mkdir(parents=True, exist_ok=True)
(out / 'adapter-offline.json').write_text(json.dumps({'scope': 'actual adapter with acoustic stub; no GPU inference', 'checks': checks, 'passed': len(checks)}, indent=2) + '\n', encoding='utf-8', newline='\n')
print(f'Expression adapter checks PASS {len(checks)}/{len(checks)}')
