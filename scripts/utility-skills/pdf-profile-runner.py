"""Authorized stdin bytes -> bounded structural JSON. No body text or filenames out."""
import io
import json
import sys

MAX_PAGES = 64


def profile(data):
    result = dict(protocol='pdf-profile@1', outcome='failed', reason='parse_failed', pages=None,
                  inspectedPages=0, textLayer='unknown', chars=None, images=None, tables=None,
                  extractionAllowed=None)
    try:
        import pdfplumber
    except ImportError:
        return dict(result, reason='runtime_missing')
    try:
        with pdfplumber.open(io.BytesIO(data)) as pdf:
            allowed = bool(pdf.doc.is_extractable)
            if not allowed:
                return dict(result, reason='extraction_disallowed', extractionAllowed=False)
            result.update(pages=len(pdf.pages), chars=0, images=0, tables=0, extractionAllowed=True)
            for page in pdf.pages[:MAX_PAGES]:
                try:
                    # Commit only a completely inspected page. A field exception is not a zero.
                    counts = (len(page.chars), len(page.images), len(page.find_tables()))
                except Exception:
                    return dict(result, outcome='partial', reason='parse_failed')
                finally:
                    page.close()
                result['inspectedPages'] += 1
                for key, number in zip(('chars', 'images', 'tables'), counts):
                    result[key] += number
            if result['inspectedPages'] != result['pages']:
                return dict(result, outcome='partial', reason='page_limit')
            return dict(result, outcome='complete', reason='none',
                        textLayer='present' if result['chars'] else 'absent')
    except Exception as error:
        reason = 'encrypted' if type(error).__name__ == 'PDFPasswordIncorrect' else 'parse_failed'
        return dict(protocol='pdf-profile@1', outcome='failed', reason=reason, pages=None,
                    inspectedPages=0, textLayer='unknown', chars=None, images=None, tables=None,
                    extractionAllowed=None)


if __name__ == '__main__':
    data = sys.stdin.buffer.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024 or not data.startswith(b'%PDF-'):
        raise SystemExit(2)  # The authorized adapter independently checks size and magic.
    print(json.dumps(dict(ok=True, markdown=json.dumps(profile(data), separators=(',', ':')))))
