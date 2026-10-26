#!/usr/bin/env python3
"""诊断：某个单元的锚点到底落在页面哪里（开发工具，不做判定）。"""
from __future__ import annotations

import sys
import unicodedata
from pathlib import Path

import pdfplumber

SKIP = set('*|_`')


def norm_char(ch: str) -> str:
    piece = unicodedata.normalize('NFKC', ch).lower()
    return ''.join(c for c in piece if not c.isspace() and c not in SKIP)


def hits(chars: list[dict], needle: str) -> list[tuple[float, float, float, float]]:
    flat_parts: list[str] = []
    source: list[int] = []
    for index, char in enumerate(chars):
        for piece in norm_char(char.get('text', '')):
            flat_parts.append(piece)
            source.append(index)
    flat = ''.join(flat_parts)
    target = ''.join(norm_char(c) for c in needle)
    out: list[tuple[float, float, float, float]] = []
    start = 0
    while True:
        at = flat.find(target, start)
        if at < 0:
            break
        first, last = source[at], source[min(at + len(target) - 1, len(source) - 1)]
        picked = [chars[i] for i in range(first, last + 1)]
        out.append((min(float(c['top']) for c in picked), max(float(c['bottom']) for c in picked),
                    min(float(c['x0']) for c in picked), max(float(c['x1']) for c in picked)))
        start = at + 1
    return out


def main() -> int:
    pdf_path = Path(sys.argv[1])
    page_number = int(sys.argv[2])
    needles = sys.argv[3:]
    with pdfplumber.open(str(pdf_path)) as pdf:
        page = pdf.pages[page_number - 1]
        chars = page.chars
        print(f'page {page_number} size {page.width}x{page.height} chars={len(chars)}')
        for needle in needles:
            found = hits(chars, needle)
            print(f'  needle {needle!r}: {len(found)} hit(s)')
            for top, bottom, left, right in found:
                print(f'    top={top:.1f} bottom={bottom:.1f} left={left:.1f} right={right:.1f}')
        words = page.extract_words()
        print('  --- lines containing 86. or BERTLARGE ---')
        seen: set[tuple[float, float]] = set()
        for word in words:
            text = word['text']
            if ('86.' in text or 'BERT' in text.upper()) and abs(word['top'] - word['bottom']) >= 0:
                key = (round(word['top']), round(word['x0']))
                if key in seen:
                    continue
                seen.add(key)
        rows: dict[tuple[int, int], list[str]] = {}
        for word in words:
            rows.setdefault((round(word['top'] / 3), 0), []).append(word)
        for key in sorted(rows):
            line = sorted(rows[key], key=lambda w: w['x0'])
            text = ' '.join(w['text'] for w in line)
            if '86.' in text or 'BERT' in text.upper() or 'Swag' in text or 'SWAG' in text:
                print(f'    y~{key[0]*3:5d}  {text[:150]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
