"""Finite presentation mapping; upstream shells only execute LG's checked sentence sidecars."""
import hashlib

VERSION = "lg-expression@1"
PRESETS = {
    "natural": ("自然日常交谈，语气平稳，不夸张。", "neutral", "none"),
    "reassuring": ("温柔地安慰对方，声音柔和克制，语速自然。", "smile", "nod"),
    "playful": ("轻松俏皮地说话，带一点笑意，避免夸张表演。", "smile", "tilt"),
    "firm": ("语气坚定、沉稳，语速自然。", "neutral", "none"),
    "subdued": ("语调收敛，语速稍缓，平静地表达低落，不哭喊。", "neutral", "none"),
    "surprised": ("短暂地流露惊讶，随后恢复自然，避免尖叫。", "surprised", "none"),
}


def checked_segments(result):
    sidecar = result.get("expression")
    if not isinstance(sidecar, dict) or sidecar.get("version") != VERSION or sidecar.get("replyId") != result["replyId"]:
        raise ValueError("LG expressive sidecar is missing or belongs to another reply")
    segments = sidecar.get("segments", [])
    if not segments or "".join(item.get("text", "") for item in segments) != result["replyText"]:
        raise ValueError("LG sentence sidecar does not match checked text")
    for index, item in enumerate(segments):
        if item.get("segmentId") != f'{result["replyId"]}#{index}' or item.get("cue") not in PRESETS:
            raise ValueError("Invalid LG sentence identity or cue")
    return segments


def presentation(segment, reply_id, request_id, generation, emotion_map):
    cue = segment["cue"]
    instruct, expression, gesture = PRESETS[cue]
    fallback = None
    if expression not in emotion_map:
        cue = "natural"
        instruct, expression, gesture = PRESETS[cue]
        fallback = "missing_expression"
    return {
        "version": VERSION, "replyId": reply_id, "segmentId": segment["segmentId"],
        "requestId": request_id, "generation": generation, "cue": cue,
        "expression": expression, "gesture": gesture, "instruct": instruct,
        "text_sha256": hashlib.sha256(segment["text"].encode("utf-8")).hexdigest(),
        **({"fallback": fallback} if fallback else {}),
    }
