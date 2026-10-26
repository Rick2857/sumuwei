# Copyright 2023-2025 BenderBlog Rodriguez and contributors.
# Copyright 2025 Traintime PDA authors; 2026 Project LG contributors.
# SPDX-License-Identifier: MIT
# Offset matching adapted from traintime_pda slider_captcha_client.dart,
# commit e780e4d01ea740c979ff5c31b9db439dbc586864. See NOTICE.md.
import base64
import io
import json
import sys
from PIL import Image


def solve(puzzle, piece):
    Image.MAX_IMAGE_PIXELS = 1024 * 1024
    with Image.open(io.BytesIO(puzzle)) as original:
        bg = original.convert('RGBA')
    with Image.open(io.BytesIO(piece)) as original:
        fg = original.convert('RGBA')
    if bg.width > 1024 or bg.height > 512 or fg.width > bg.width or fg.height != bg.height:
        raise ValueError('dimensions')
    alpha = fg.getchannel('A')
    opaque = alpha.point(lambda x: 255 if x == 255 else 0).getbbox()
    if not opaque:
        raise ValueError('piece')
    left, top, right, bottom = opaque
    left, top, right, bottom = left + 24, top + 24, right - 24, bottom - 24
    if right <= left or bottom <= top:
        raise ValueError('piece')
    # Same luminance coefficients and NCC score as upstream; no remote OCR service.
    def luminance(pixel):
        return .299 * pixel[0] + .587 * pixel[1] + .114 * pixel[2]
    template = [luminance(fg.getpixel((x, y))) for y in range(top, bottom) for x in range(left, right)]
    mean = sum(template) / len(template)
    template = [v - mean for v in template]
    best, offset = float('-inf'), 0
    for shift in range(bg.width - fg.width + 1):
        window = [luminance(bg.getpixel((x + shift, y))) for y in range(top, bottom) for x in range(left, right)]
        mean = sum(window) / len(window)
        window = [v - mean for v in window]
        score = sum(a * b for a, b in zip(window, template)) / (.000001 + sum(v * v for v in window))
        if score > best:
            best, offset = score, shift
    if best <= 0:
        raise ValueError('match')
    return round(offset / bg.width * 280)


if __name__ == '__main__':
    try:
        raw = sys.stdin.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise ValueError('size')
        data = json.loads(raw)
        print(json.dumps({'offset': solve(base64.b64decode(data['bigImage'], validate=True), base64.b64decode(data['smallImage'], validate=True))}))
    except Exception:
        print('{"error":"captcha_match_failed"}')
        sys.exit(1)
