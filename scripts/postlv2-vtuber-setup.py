"""Install the selected avatar and register the LG adapters in the pinned external shell."""
import argparse
import hashlib
import json
import shutil
import subprocess
from pathlib import Path
from importlib.util import module_from_spec, spec_from_file_location

VTUBER_COMMIT = "992309c0aa19845960228f880013d4685fde93b5"
FRONTEND_COMMIT = "06a659b114fff788cf0daaa86e484576db4975bf"
ASR_MODEL_DIR = "sherpa-onnx-streaming-zipformer-zh-int8-2025-06-30"
ASR_ENCODER = "encoder.int8.onnx"
ASR_DECODER = "decoder.onnx"
ASR_JOINER = "joiner.int8.onnx"


def patch(path, old, new):
    text = path.read_text(encoding="utf-8")
    if new in text:
        return
    if text.count(old) != 1:
        raise ValueError(f"Pinned source differs at {path}: expected one patch location")
    path.write_text(text.replace(old, new, 1), encoding="utf-8", newline="\n")


def setup(deps, source, speech_profile="cosyvoice3"):
    if speech_profile not in ("legacy", "cosyvoice3"):
        raise ValueError("Unknown LG speech profile")
    if speech_profile == "cosyvoice3":
        overlay = deps / "cosyvoice3-venv/Lib/site-packages/speech-base.pth"
        if not overlay.is_file():
            raise FileNotFoundError(overlay)
        # Process base .pth files too: PyWin32 needs its DLL bootstrap and lib path.
        base_site = str(deps / "qwen3-tts-venv/Lib/site-packages")
        overlay.write_text("import site; site.addsitedir(" + repr(base_site) + ")\n", encoding="utf-8")
    vt = deps / "Open-LLM-VTuber"
    for root, expected in ((vt, VTUBER_COMMIT), (vt / "frontend", FRONTEND_COMMIT)):
        actual = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        if actual != expected:
            raise ValueError(f"Unreviewed upstream revision at {root}: {actual}")
    model_file = source / "ulvm2_0001.model3.json"
    model = json.loads(model_file.read_text(encoding="utf-8"))
    refs = model["FileReferences"]
    for relative in [refs["Moc"], *refs["Textures"], refs["Physics"], refs["DisplayInfo"]]:
        if not (source / relative).is_file():
            raise FileNotFoundError(relative)
    target = vt / "live2d-models" / "lg_ulvm2_0001"
    shutil.copytree(source, target, dirs_exist_ok=True)
    # Empty expression fades the previous expression out without changing clothing.
    (target / "animation" / "neutral.exp3.json").write_text(
        json.dumps({"Type": "Live2D Expression", "Parameters": []}), encoding="utf-8")
    names = ["neutral", *sorted(p.name.removesuffix(".exp3.json") for p in (source / "animation").glob("*.exp3.json"))]
    refs["Expressions"] = [{"Name": name, "File": f"animation/{name}.exp3.json"} for name in names]
    model["Groups"] = [
        {"Target": "Parameter", "Name": "EyeBlink", "Ids": ["ParamEyeLOpen", "ParamEyeROpen"]},
        {"Target": "Parameter", "Name": "LipSync", "Ids": ["ParamMouthOpenY"]},
    ]
    (target / model_file.name).write_text(json.dumps(model, ensure_ascii=False, indent=2), encoding="utf-8")
    emotion = {key: names.index(value) for key, value in {
        "neutral": "neutral", "smile": "smile", "thinking": "jitome", "sorry": "blush",
        "surprised": "surprised", "listening": "neutral", "joy": "smile",
        "anger": "angry", "sadness": "cry", "surprise": "surprised",
    }.items()}
    profile = {"name": "lg_ulvm2_0001", "description": "LG selected temporary avatar",
               "url": "/live2d-models/lg_ulvm2_0001/ulvm2_0001.model3.json", "kScale": 0.5,
               "initialXshift": 0, "initialYshift": 0, "defaultEmotion": 0,
               "idleMotionGroupName": "", "emotionMap": emotion, "tapMotions": {}}
    dictionary_path = vt / "model_dict.json"
    dictionary = json.loads(dictionary_path.read_text(encoding="utf-8"))
    dictionary = [item for item in dictionary if item["name"] != profile["name"]] + [profile]
    dictionary_path.write_text(json.dumps(dictionary, ensure_ascii=False, indent=2), encoding="utf-8")
    shutil.copy2(source / "ico_ulvm2_0001.png", vt / "avatars" / "lg_ulvm2_0001.png")

    src = vt / "src" / "open_llm_vtuber"
    patch(src / "config_manager" / "agent.py",
          '"basic_memory_agent", "mem0_agent", "hume_ai_agent", "letta_agent"',
          '"basic_memory_agent", "mem0_agent", "hume_ai_agent", "letta_agent", "lg_bridge_agent"')
    patch(src / "agent" / "agent_factory.py",
          '        if conversation_agent_choice == "basic_memory_agent":',
          '        if conversation_agent_choice == "lg_bridge_agent":\n'
          '            from postlv2_vtuber_runtime import LGBridgeAgent\n'
          '            return LGBridgeAgent(live2d_model)\n\n'
          '        if conversation_agent_choice == "basic_memory_agent":')
    patch(src / "config_manager" / "tts.py", 'class TTSConfig(I18nMixin):',
          'class LGQwenTTSConfig(I18nMixin):\n'
          '    model_dir: str\n'
          '    speaker: Literal["Ono_Anna"] = "Ono_Anna"\n\n\n'
          'class TTSConfig(I18nMixin):')
    patch(src / "config_manager" / "tts.py", '    tts_model: Literal[',
          '    lg_qwen_tts: Optional[LGQwenTTSConfig] = None\n\n    tts_model: Literal[\n        "lg_qwen_tts",')
    patch(src / "tts" / "tts_factory.py", '        if engine_type == "azure_tts":',
          '        if engine_type == "lg_qwen_tts":\n'
          '            from postlv2_vtuber_runtime import LGQwenTTS\n'
          '            return LGQwenTTS(**kwargs)\n'
          '        if engine_type == "azure_tts":')
    patch(src / "config_manager" / "tts.py", 'class LGQwenTTSConfig(I18nMixin):',
          'class LGCosyVoiceConfig(I18nMixin):\n'
          '    model_dir: str\n    reference_audio: str\n    deps_root: str\n\n\n'
          'class LGQwenTTSConfig(I18nMixin):')
    patch(src / "config_manager" / "tts.py", '    lg_qwen_tts: Optional[LGQwenTTSConfig] = None',
          '    lg_cosyvoice3: Optional[LGCosyVoiceConfig] = None\n'
          '    lg_qwen_tts: Optional[LGQwenTTSConfig] = None')
    patch(src / "config_manager" / "tts.py", '        "lg_qwen_tts",',
          '        "lg_qwen_tts",\n        "lg_cosyvoice3",')
    patch(src / "tts" / "tts_factory.py", '        if engine_type == "lg_qwen_tts":',
          '        if engine_type == "lg_cosyvoice3":\n'
          '            from postlv2_vtuber_runtime import LGCosyVoiceTTS\n'
          '            return LGCosyVoiceTTS(**kwargs)\n'
          '        if engine_type == "lg_qwen_tts":')
    patch(src / "config_manager" / "asr.py", '    asr_model: Literal[',
          '    lg_online_asr: Optional[SherpaOnnxASRConfig] = None\n\n'
          '    asr_model: Literal[\n        "lg_online_asr",')
    patch(src / "asr" / "asr_factory.py", '        if system_name == "faster_whisper":',
          '        if system_name == "lg_online_asr":\n'
          '            from postlv2_vtuber_runtime import LGOnlineASR\n'
          '            return LGOnlineASR(**kwargs)\n'
          '        if system_name == "faster_whisper":')
    patch(src / "config_manager" / "asr.py", 'class ASRConfig(I18nMixin):',
          'class LGSenseVoiceConfig(SherpaOnnxASRConfig):\n    vad_model: str\n\n\n'
          'class ASRConfig(I18nMixin):')
    patch(src / "config_manager" / "asr.py", '    lg_online_asr: Optional[SherpaOnnxASRConfig] = None',
          '    lg_sensevoice: Optional[LGSenseVoiceConfig] = None\n'
          '    lg_online_asr: Optional[SherpaOnnxASRConfig] = None')
    patch(src / "config_manager" / "asr.py", '        "lg_online_asr",',
          '        "lg_online_asr",\n        "lg_sensevoice",')
    patch(src / "asr" / "asr_factory.py", '        if system_name == "lg_online_asr":',
          '        if system_name == "lg_sensevoice":\n'
          '            from postlv2_vtuber_runtime import LGSenseVoiceASR\n'
          '            return LGSenseVoiceASR(**kwargs)\n'
          '        if system_name == "lg_online_asr":')
    patch(src / "conversations" / "single_conversation.py",
          ('and output_item.get("type") in ("tool_call_status", "lg-expression-turn")'
           if 'and output_item.get("type") in ("tool_call_status", "lg-expression-turn")' in
           (src / "conversations" / "single_conversation.py").read_text(encoding="utf-8")
           else 'and output_item.get("type") == "tool_call_status"'),
          'and output_item.get("type") in ("tool_call_status", "lg-expression-turn", "lg-speech-stream-failed")')
    patch(src / "conversations" / "single_conversation.py", '        # Create batch input',
          '        if isinstance(user_input, np.ndarray) and not input_text.strip():\n'
          '            await finalize_conversation_turn(tts_manager=tts_manager,\n'
          '                                             websocket_send=websocket_send, client_uid=client_uid)\n'
          '            return ""\n\n        # Create batch input')
    spec = spec_from_file_location("lg_expression_frontend", Path(__file__).with_name("postlv2-expression-frontend.py"))
    frontend_builder = module_from_spec(spec)
    spec.loader.exec_module(frontend_builder)
    frontend_builder.build_frontend(deps, vt / "frontend")

    from ruamel.yaml import YAML
    yaml = YAML()
    conf = yaml.load((vt / "config_templates" / "conf.ZH.default.yaml").read_text(encoding="utf-8"))
    conf["system_config"].update(host="127.0.0.1", port=12393, config_alts_dir="lg-characters", tool_prompts={})
    (vt / "lg-characters").mkdir(exist_ok=True)
    character = conf["character_config"]
    character.update(conf_name="苏沐薇 · 皮套测试", conf_uid="lg-avatar-test", live2d_model_name=profile["name"],
                     character_name="苏沐薇", avatar="lg_ulvm2_0001.png",
                     persona_prompt="LG owns identity, memory and checked replies; this shell only presents them.")
    character["agent_config"] = {"conversation_agent_choice": "lg_bridge_agent", "agent_settings": {
        "basic_memory_agent": {"llm_provider": "openai_compatible_llm", "use_mcpp": False, "mcp_enabled_servers": []}},
        "llm_configs": {}}
    asr = deps / "models" / ASR_MODEL_DIR
    for filename in ("tokens.txt", ASR_ENCODER, ASR_DECODER, ASR_JOINER):
        if not (asr / filename).is_file():
            raise FileNotFoundError(asr / filename)
    character["asr_config"] = {"asr_model": "lg_online_asr", "lg_online_asr": {
        "model_type": "transducer", "tokens": str(asr / "tokens.txt"),
        "encoder": str(asr / ASR_ENCODER),
        "decoder": str(asr / ASR_DECODER),
        "joiner": str(asr / ASR_JOINER), "num_threads": 2, "provider": "cpu"}}
    character["tts_config"] = {"tts_model": "lg_qwen_tts", "lg_qwen_tts": {
        "model_dir": str(deps / "models" / "Qwen3-TTS-12Hz-1.7B-CustomVoice"), "speaker": "Ono_Anna"}}
    reference_audio = Path(__file__).resolve().parent.parent / "artifacts/post-lv2/local/postlv2-qwen3-tts-20261003-01/Ono_Anna.wav"
    if speech_profile == "cosyvoice3":
        selected_reference = deps / "voices/Ono_Anna-reference.wav"
        if not selected_reference.exists():
            selected_reference.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(reference_audio, selected_reference)
        reference_audio = selected_reference
        if hashlib.sha256(reference_audio.read_bytes()).hexdigest() != "5d6f1575f4578b43ac1859f651d426b3a0428cb6f03d85a552c9be465d85b18e":
            raise ValueError("Ono_Anna reference differs from the selected sample")
        asr = deps / "models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17"
        vad = vt / "frontend/libs/silero_vad_v5.onnx"
        for path in (asr / "model.int8.onnx", asr / "tokens.txt", vad, reference_audio):
            if not path.is_file():
                raise FileNotFoundError(path)
        character["asr_config"] = {"asr_model": "lg_sensevoice", "lg_sensevoice": {
            "model_type": "sense_voice", "sense_voice": str(asr / "model.int8.onnx"),
            "tokens": str(asr / "tokens.txt"), "num_threads": 2, "provider": "cpu", "vad_model": str(vad)}}
        character["tts_config"] = {"tts_model": "lg_cosyvoice3", "lg_cosyvoice3": {
            "model_dir": str(deps / "models/Fun-CosyVoice3-0.5B-2512"),
            "reference_audio": str(reference_audio), "deps_root": str(deps)}}
    character["vad_config"] = {"vad_model": None}
    character["tts_preprocessor_config"]["translator_config"]["translate_audio"] = False
    # The pinned frontend always asks for the default `conf.yaml` during its
    # initial websocket handshake. Keep one generated profile there so the
    # settings panel does not probe a missing file before the selected profile
    # is loaded by the launcher.
    with (vt / "conf.yaml").open("w", encoding="utf-8") as stream:
        yaml.dump(conf, stream)
    receipt = {"avatar": profile["name"], "speaker": "Ono_Anna" if speech_profile == "legacy" else "Ono_Anna reference clone",
               "speech_profile": speech_profile, "tts_model": character["tts_config"]["tts_model"],
               "asr_model": ASR_MODEL_DIR if speech_profile == "legacy" else asr.name,
               "tts_reference_sha256": hashlib.sha256(reference_audio.read_bytes()).hexdigest() if speech_profile == "cosyvoice3" else None,
               "vtuber_commit": VTUBER_COMMIT,
               "frontend_commit": FRONTEND_COMMIT, "expression_count": len(names), "emotion_map": emotion,
               "source_files": {p.relative_to(source).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
                                for p in source.rglob("*") if p.is_file()},
               "model_config_sha256": hashlib.sha256((target / model_file.name).read_bytes()).hexdigest()}
    (vt / "lg-avatar-receipt.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps({"configured_model": str(target), "speaker": receipt["speaker"], "speech_profile": speech_profile,
                      "expressions": len(names)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deps-root", type=Path, default=Path.home() / "postlv2-deps")
    parser.add_argument("--model-root", type=Path, default=Path.home() / "Downloads/ulvm2_0001/ulvm2_0001")
    parser.add_argument("--speech-profile", choices=("legacy", "cosyvoice3"), default="cosyvoice3")
    args = parser.parse_args()
    setup(args.deps_root.resolve(), args.model_root.resolve(), args.speech_profile)
