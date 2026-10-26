#!/usr/bin/env python3
"""
参照复核辅助：按单元裁出页面区域（2026-10-23 · P2.1 第四批 · 开发工具）

⚠️ **它只做导航，不做判定**：
    裁剪位置来自 PDF 的**文本层坐标**（找得到就裁，找不到就给整页），
    但**单元内容必须由人看图确认**。文本层只能告诉你"字在哪"，
    不能替你判断"这句话是不是真的写在那里"。

⚠️ 文本层与页面图像**不是同一通道**：康熙部首兼容码位、缺空格、
    表格错列都会让"文本层里有、图上看着一样"或反过来。
    ⇒ 找不到就是找不到，**不猜**，退回整页并如实标注。

用法：
    document-reference-crops.py <reference.json> <corpus-dir> <render-dir> <out-dir>
"""
from __future__ import annotations

import json
import sys
import unicodedata
from pathlib import Path

import pdfplumber
from PIL import Image

SKIP = set('*|_`')


def norm_char(ch: str) -> str:
    """与生产匹配视图同口径的逐字符归一（NFKC + 小写 + 去空白/少量标记）。"""
    piece = unicodedata.normalize('NFKC', ch).lower()
    return ''.join(c for c in piece if not c.isspace() and c not in SKIP)


def locate(chars: list[dict], needle: str) -> tuple[int, int] | None:
    """在文本层里定位词片段（逐字符归一后连续匹配），返回字符下标区间。"""
    flat_parts: list[str] = []
    source: list[int] = []
    for index, char in enumerate(chars):
        for piece in norm_char(char.get('text', '')):
            flat_parts.append(piece)
            source.append(index)
    flat = ''.join(flat_parts)
    target = ''.join(norm_char(c) for c in needle)
    if not target:
        return None
    at = flat.find(target)
    if at < 0:
        return None
    return source[at], source[min(at + len(target) - 1, len(source) - 1)]


def locate_all(chars: list[dict], needle: str) -> list[tuple[int, int]]:
    """词片段的**全部**出现位置（表格单元常在同一页出现多次）。"""
    flat_parts: list[str] = []
    source: list[int] = []
    for index, char in enumerate(chars):
        for piece in norm_char(char.get('text', '')):
            flat_parts.append(piece)
            source.append(index)
    flat = ''.join(flat_parts)
    target = ''.join(norm_char(c) for c in needle)
    out: list[tuple[int, int]] = []
    start = 0
    while target:
        at = flat.find(target, start)
        if at < 0:
            break
        out.append((source[at], source[min(at + len(target) - 1, len(source) - 1)]))
        start = at + 1
    return out


def band_of(chars: list[dict], position: int, tolerance: float = 5.0) -> list[int]:
    """
    字符所在的**横向条带**（同一行，含上下标）。

    ⚠️ PDF 的字符**不是按位置排序**的（是内容流顺序）⇒ 必须自己按 top 聚类。
    ⚠️ 容差 5pt：表格行高约 10pt ⇒ 不会把相邻两行并进来；但能容下
        "BERT" 与下标 "LARGE"（相差约 3.4pt）。
    """
    top = float(chars[position]['top'])
    return [index for index, char in enumerate(chars) if abs(float(char['top']) - top) <= tolerance]


def band_text(chars: list[dict], band: list[int]) -> str:
    """条带内字符按 x 排序后的归一文本。"""
    ordered = sorted(band, key=lambda index: float(chars[index]['x0']))
    return ''.join(norm_char(chars[index].get('text', '')) for index in ordered)


def locate_unit(chars: list[dict], unit: dict) -> tuple[tuple[int, int] | None, str | None]:
    """
    定位一个单元。

    ⚠️ **表格单元必须锚到"同一行里含全部锚点"的那次出现**：
        同一个标签（例如 "BERTLARGE"）在一页里可能出现多次（正文、表头、别的表），
        锚到错误的那次 ⇒ 裁出来的图**看不到锚点**，复核者会误判标注有误。
    """
    needles = list(unit['needles'])
    for needle in needles:
        hits = locate_all(chars, needle)
        if not hits:
            continue
        if unit.get('kind') == 'row':
            for hit in hits:
                text = band_text(chars, band_of(chars, hit[0]))
                if all(''.join(norm_char(c) for c in other) in text for other in needles):
                    return hit, needle
        return hits[0], needle
    # 整句定位不到时，退到**最长的词**（只要一个锚点）⇒ 人仍能在一行里核对。
    best: tuple[tuple[int, int], str] | None = None
    for needle in needles:
        for word in sorted(needle.split(' '), key=len, reverse=True):
            if len(word) < 4:
                continue
            hit = locate(chars, word)
            if hit is not None and (best is None or len(word) > len(best[1])):
                best = (hit, word + '（整句定位不到，退到单词锚点）')
    return (best[0], best[1]) if best is not None else (None, None)


def band(chars: list[dict], first: int, last: int, pad: float = 6.0) -> tuple[float, float, float, float]:
    """命中字符的外接框；表格行再按 y 方向扩成整条行带。"""
    picked = [chars[index] for index in range(first, last + 1) if index < len(chars)]
    if not picked:
        return (0.0, 0.0, 0.0, 0.0)
    top = min(float(c['top']) for c in picked)
    bottom = max(float(c['bottom']) for c in picked)
    left = min(float(c['x0']) for c in picked)
    right = max(float(c['x1']) for c in picked)
    line = [c for c in chars if abs(float(c['top']) - top) <= pad]
    if line:
        left = min(left, min(float(c['x0']) for c in line))
        right = max(right, max(float(c['x1']) for c in line))
        bottom = max(bottom, max(float(c['bottom']) for c in line))
    return (left, top, right, bottom)


def main() -> int:
    reference = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    corpus = Path(sys.argv[2])
    renders = Path(sys.argv[3])
    out = Path(sys.argv[4])
    out.mkdir(parents=True, exist_ok=True)
    index: list[dict] = []
    for document in reference['documents']:
        pdf_path = corpus / document['file']
        with pdfplumber.open(str(pdf_path)) as pdf:
            for unit in document['units']:
                page_number = int(unit['page'])
                page = pdf.pages[page_number - 1]
                chars = page.chars
                found = None
                used_needle = None
                found, used_needle = locate_unit(chars, unit)
                render_name = next((r['file'] for r in document.get('renders', []) if r['file'].endswith(f'p{page_number}.png')), None)
                if render_name is None:
                    render_name = f"{document['id']}-p{page_number}.png"
                render_path = renders / render_name
                image = Image.open(render_path)
                scale_x = image.width / float(page.width)
                scale_y = image.height / float(page.height)
                entry = {
                    'document': document['id'], 'unit': unit['id'], 'page': page_number,
                    'region': unit['region'], 'kind': unit['kind'], 'needles': list(unit['needles']),
                    'render': render_name, 'located': found is not None, 'locatedNeedle': used_needle,
                    'crop': None,
                }
                if found is not None:
                    left, top, right, bottom = band(chars, found[0], found[1])
                    margin_x = max(18.0, (right - left) * 0.04)
                    margin_y = max(14.0, (bottom - top) * 0.9)
                    box = (
                        max(0, int((left - margin_x) * scale_x)),
                        max(0, int((top - margin_y) * scale_y)),
                        min(image.width, int((right + margin_x) * scale_x)),
                        min(image.height, int((bottom + margin_y) * scale_y)),
                    )
                    if box[2] - box[0] >= 40 and box[3] - box[1] >= 24:
                        crop = image.crop(box)
                        crop = crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS)
                        name = f"{document['id']}-{unit['id']}.png"
                        crop.save(out / name)
                        entry['crop'] = name
                else:
                    name = f"{document['id']}-{unit['id']}-page.png"
                    image.save(out / name)
                    entry['crop'] = name
                index.append(entry)
    (out / 'crop-index.json').write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding='utf-8')
    located = sum(1 for entry in index if entry['located'])
    print(f"units={len(index)} located={located} fallback={len(index) - located}")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
