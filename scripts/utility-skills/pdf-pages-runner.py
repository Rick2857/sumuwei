"""One bounded page request header + authorized PDF bytes. No network or filesystem reads."""
import io
import json
import sys
import unicodedata


def main():
    header = json.loads(sys.stdin.buffer.readline(1024))
    first, last, prefix = header['firstPage'], header['lastPage'], header['prefixChars']
    if not (type(first) is int and type(last) is int and 1 <= first <= last < first + 4):
        raise ValueError('invalid range')
    if prefix is not None and not (type(prefix) is int and 1 <= prefix <= 1200):
        raise ValueError('invalid prefix')
    if header['reader'] not in ('pdfplumber', 'pdfminer'):
        raise ValueError('invalid reader')
    data = sys.stdin.buffer.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024 or not data.startswith(b'%PDF-'):
        raise ValueError('invalid bytes')
    import pdfplumber
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        if not pdf.doc.is_extractable or last > len(pdf.pages):
            raise ValueError('unreadable range')
        pages, remaining = [], 1200
        for number in range(first, last + 1):
            if header['reader'] == 'pdfminer':
                from pdfminer.high_level import extract_text
                text = extract_text(io.BytesIO(data), page_numbers=[number - 1])
            else:
                text = pdf.pages[number - 1].extract_text() or ''
            text = unicodedata.normalize('NFKC', text).replace('\r\n', '\n').strip()
            selected = text[:min(remaining, prefix if prefix is not None else len(text))]
            # JS string lengths are UTF-16 units. Slice conservatively before reporting that measure.
            while len(selected.encode('utf-16-le')) // 2 > min(remaining, prefix if prefix is not None else remaining):
                selected = selected[:-1]
            total = len(text.encode('utf-16-le')) // 2
            included = len(selected.encode('utf-16-le')) // 2
            pages.append(dict(page=number, text=selected, totalChars=total))
            remaining -= included
        return pages


if __name__ == '__main__':
    try:
        pages = main()
        print(json.dumps(dict(ok=True, markdown=json.dumps(pages, ensure_ascii=True))))
    except Exception:
        print(json.dumps(dict(ok=False, errorType='page_read_failed', error='PDF page read failed')))
        raise SystemExit(1)
