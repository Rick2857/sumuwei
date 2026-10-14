"""Import the user-provided Aoba 1.4 archive locally; never change or publish the archive."""
import copy
import hashlib
import json
import struct
import sys
import zipfile
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parent
source = Path(sys.argv[1]).resolve()
archive = source.read_bytes()
archive_sha = "bec6ed060537693b3a8b8ab683d9411423e29548e551a1dedff9be6379c9c7cd"
if hashlib.sha256(archive).hexdigest() != archive_sha:
    raise ValueError("Archive SHA-256 differs from the inspected Aoba 1.4 archive; no files written")
expected = [
    ("aoba.ver1.4/vrm/vrm_aoba.vrm", "aoba.vrm", "蒼葉 aoba · 戴帽", "1604c1ba6286578f64ee1e1585a8f0b4e934f8946889978279a56f897f344c0b"),
    ("aoba.ver1.4/vrm/vrm_aoba(hat less).vrm", "aoba-hatless.vrm", "蒼葉 aoba · 无帽", "22dd3c2aa6995b34684bbdbf810b6b9fa5ae4dddd6bc25ef5189154c9bd315d5"),
]
assets = []
receipt = {"sourceZipSha256": archive_sha, "sourceZipBytes": len(archive), "assets": []}
with zipfile.ZipFile(source) as zipped:
    for name, filename, label, sha in expected:
        original = zipped.getinfo(name)
        # This inspected ZIP has stale central-directory offsets. Find its exact local header.
        positions, offset = [], 0
        while True:
            offset = archive.find(b"PK\x03\x04", offset)
            if offset < 0:
                break
            length = struct.unpack_from("<H", archive, offset + 26)[0]
            if archive[offset + 30:offset + 30 + length] == name.encode():
                positions.append(offset)
            offset += 4
        if len(positions) != 1:
            raise ValueError("Expected exactly one matching local file header")
        fixed = copy.copy(original)
        fixed.header_offset = positions[0]
        model = zipped.read(fixed)  # Standard zipfile checks the original CRC32.
        if hashlib.sha256(model).hexdigest() != sha:
            raise ValueError("Model SHA-256 mismatch; no files written")
        assets.append((filename, label, model))
        receipt["assets"].append({"archiveEntry": name, "localFile": filename, "sha256": sha,
                                  "bytes": len(model), "crcVerified": True,
                                  "offsetCorrection": positions[0] - original.header_offset})
(root / "public/models").mkdir(parents=True, exist_ok=True)
for filename, label, model in assets:
    (root / "public/models" / filename).write_bytes(model)
(root / "public/models/local.json").write_text(json.dumps(
    [{"file": filename, "label": label} for filename, label, model in assets], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
receipt["sourceUnchanged"] = hashlib.sha256(source.read_bytes()).hexdigest() == archive_sha
destination = root / "evidence/local" / ("aoba-import-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".json")
destination.parent.mkdir(parents=True, exist_ok=True)
destination.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
print(json.dumps({"imported": [a[0] for a in assets], "sourceUnchanged": receipt["sourceUnchanged"]}))
