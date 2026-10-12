"""Exercise the installed upstream ImageData -> LG avatar conversion, without TTS or a DB."""
import base64
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(Path.home() / "postlv2-deps" / "Open-LLM-VTuber" / "src"))
from open_llm_vtuber.agent.input_types import ImageData, ImageSource
from postlv2_vtuber_runtime import avatar_image_inputs

encoded = base64.b64encode((root / "evals/image-input/one.png").read_bytes()).decode("ascii")
expected = [{"dataUrl": "data:image/png;base64," + encoded}]
assert avatar_image_inputs([ImageData(ImageSource.UPLOAD, encoded, "image/png")]) == expected
assert avatar_image_inputs([ImageData(ImageSource.CLIPBOARD, expected[0]["dataUrl"], "image/png")]) == expected
assert avatar_image_inputs([]) == []
for value in ["https://example.com/image.png", "not base64"]:
    try:
        avatar_image_inputs([ImageData(ImageSource.UPLOAD, value, "image/png")])
    except ValueError:
        pass
    else:
        raise AssertionError("Malformed input crossed the bridge")
print("PASS: installed ImageData/raw base64/data URL/clipboard/invalid input")
