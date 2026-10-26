"""Local bytes -> PDF text. Uses the existing document environment, no network/plugins."""
import io
import json
import sys

def main():
    try:
        from pdfminer.high_level import extract_text
        data = sys.stdin.buffer.read(10 * 1024 * 1024 + 1)
        if len(data) > 10 * 1024 * 1024 or not data.startswith(b"%PDF-"):
            raise ValueError("invalid_pdf_input")
        text = extract_text(io.BytesIO(data))
        print(json.dumps({"ok": True, "markdown": text}, ensure_ascii=True))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "errorType": type(error).__name__, "error": "pdf_text_extraction_failed"}))
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
