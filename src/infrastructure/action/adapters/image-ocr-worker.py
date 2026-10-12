"""Fixed RapidOCR / PP-OCRv4 CPU worker: JSON header + authorized image bytes."""
import hashlib
import importlib.metadata as metadata
import io
import json
from pathlib import Path
import socket
import sys
import time
import urllib.request

network_attempts = 0

def deny_network(*args, **kwargs):
    global network_attempts
    network_attempts += 1
    raise RuntimeError('IMAGE_OCR_OFFLINE_GUARD')

socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
socket.socket.sendto = deny_network
socket.create_connection = deny_network
socket.getaddrinfo = deny_network
urllib.request.urlopen = deny_network

def emit(result, code=0):
    result['networkAttempts'] = network_attempts
    print('IMAGE_OCR_RESULT=' + json.dumps(result, ensure_ascii=False), flush=True)
    raise SystemExit(code)

def fail(reason, message, code=5):
    emit({'ok': False, 'code': reason, 'message': message}, code)

def main():
    header_line = sys.stdin.buffer.readline(64 * 1024)
    try:
        header = json.loads(header_line)
    except (ValueError, UnicodeError):
        fail('protocol_error', 'OCR 输入头不合法', 2)
    raw = sys.stdin.buffer.read(16 * 1024 * 1024 + 1)
    if header.get('protocol') != 'image-ocr/1' or header.get('imageBytes') != len(raw) or len(raw) > 16 * 1024 * 1024:
        fail('protocol_error', 'OCR 输入字节数不符或超限', 2)

    models = {}
    for asset in header.get('assets', []):
        try:
            data = Path(asset['path']).read_bytes()
            if len(data) != asset['bytes'] or hashlib.sha256(data).hexdigest() != asset['sha256']:
                fail('assets_missing', '本地 OCR 模型指纹不符', 3)
            models[asset['component']] = asset['path']
        except (OSError, KeyError, TypeError):
            fail('assets_missing', '本地 OCR 模型资产不可用', 3)
    if set(models) != {'Det', 'Cls', 'Rec'}:
        fail('assets_missing', '本地 OCR 模型资产不完整', 3)
    versions = {'rapidocr': '3.9.2', 'onnxruntime': '1.20.1', 'numpy': '1.26.4', 'opencv-python': '4.11.0.86'}
    try:
        if any(metadata.version(name) != version for name, version in versions.items()):
            fail('assets_missing', '本地 OCR 依赖版本与固定版本不一致', 3)
    except metadata.PackageNotFoundError:
        fail('assets_missing', '本地 OCR 依赖未安装', 3)

    import requests
    requests.sessions.Session.request = deny_network
    from PIL import Image
    from rapidocr import RapidOCR, OCRVersion, ModelType
    # Decode bytes only; file paths and URLs are not accepted as image input.
    with Image.open(io.BytesIO(raw)) as image:
        if image.width * image.height > 20_000_000 or image.format not in ('PNG', 'JPEG'):
            fail('validation_failed', 'OCR 图片格式或像素数不合法')
        image.verify()
    params = {f'{kind}.model_path': path for kind, path in models.items()}
    params['Global.log_level'] = 'error'
    for kind in ('Det', 'Rec'):
        params[f'{kind}.ocr_version'] = OCRVersion.PPOCRV4
        params[f'{kind}.model_type'] = ModelType.MOBILE
    started = time.perf_counter()
    engine = RapidOCR(params=params)
    setup_ms = (time.perf_counter() - started) * 1000
    recognized = time.perf_counter()
    result = engine(raw)
    scores = list(result.scores or [])
    emit({
        'ok': True, 'text': '\n'.join(result.txts or []),
        'confidence': sum(scores) / len(scores) * 100 if scores else 0,
        'languages': ['chi_sim', 'eng'], 'setupMs': setup_ms,
        'recognizeMs': (time.perf_counter() - recognized) * 1000,
        'engineVersion': 'RapidOCR 3.9.2 / ONNX Runtime 1.20.1 / PP-OCRv4 mobile',
        'released': True,
    })

try:
    main()
except Exception as error:
    fail('execution_failed', f'OCR 执行失败（{type(error).__name__}）')
