"""Build a small, replayable presentation patch against the source of the pinned web bundle."""
import hashlib
import json
import shutil
import subprocess
from pathlib import Path

SOURCE_COMMIT = "3d57a9a0125a0ca13e5d096f7092e4e494ed389e"
ROOT = Path(__file__).resolve().parent


def appearance_definition(model_root):
    groups = {
        "costumes": [("costume_v0000", "服装 1"), ("costume_v0052", "服装 2"), ("costume_v0101", "服装 3")],
        "effects": [("fx_1_heart", "爱心"), ("fx_2_pale2", "脸色发青"), ("fx_3_note", "音符"),
                    ("fx_4_sweat", "汗滴"), ("fx_5_sweat_2", "动态汗滴"), ("fx_6_surprised", "惊讶线"),
                    ("fx_7_question", "问号"), ("fx_8_exclamation", "感叹号"), ("fx_9_swirl", "转圈"),
                    ("fx_10_yellowline", "黄色跳线"), ("fx_11_star", "闪光"), ("fx_12_zzz", "睡眠"),
                    ("fx_13_angry", "生气符号")],
    }
    definition = {}
    for group, entries in groups.items():
        definition[group] = []
        for name, label in entries:
            path = model_root / "animation" / (name + ".exp3.json")
            parameters = json.loads(path.read_text(encoding="utf-8"))["Parameters"]
            if not parameters or any(p["Blend"] != "Add" for p in parameters):
                raise ValueError("Unreviewed appearance preset: " + name)
            definition[group].append({"id": name, "label": label, "parameters": parameters})
    return definition


def build_frontend(deps, frontend):
    source = deps / "Open-LLM-VTuber-Web-source"
    if not source.exists():
        subprocess.run(["git", "clone", "--filter=blob:none", "--no-checkout",
                        "https://github.com/Open-LLM-VTuber/Open-LLM-VTuber-Web.git", str(source)], check=True)
        subprocess.run(["git", "-C", str(source), "checkout", "--detach", SOURCE_COMMIT], check=True)
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if actual != SOURCE_COMMIT:
        raise ValueError("Unreviewed frontend source revision: " + actual)
    modified = []

    def edit(relative, changes, prefix=""):
        path = source / relative
        # Rebuild our managed files from the reviewed commit, never from a possibly repeated patch.
        original = subprocess.check_output(["git", "-C", str(source), "show", f"{SOURCE_COMMIT}:{relative}"]).decode("utf-8")
        text = original
        for old, new in changes:
            if text.count(old) != 1:
                raise ValueError("Expected one frontend patch anchor: " + relative + " / " + old[:60])
            text = text.replace(old, new, 1)
        path.write_text(prefix + text, encoding="utf-8", newline="\n")
        modified.append({"path": relative, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})

    module_import = ("import { expressionPlayback } from '@/utils/postlv2-expression';\n"
                     "import { speechPlayback } from '@/utils/postlv2-speech';\n")
    edit("src/renderer/src/hooks/utils/use-audio-task.ts", [
        ("  forwarded?: boolean", "  lg_expression?: any\n  lg_stream?: boolean\n  forwarded?: boolean"),
        ("    // Skip if already interrupted", "    if (options.lg_expression && !expressionPlayback.canPlay(options.lg_expression)) { resolve(); return; }\n\n    // Skip if already interrupted"),
        ("        const cleanup = () => {", "        audio.addEventListener('playing', () => {\n          if (options.lg_expression) expressionPlayback.start(options.lg_expression, audio);\n        });\n        const cleanup = () => {\n          if (options.lg_expression) expressionPlayback.finish(options.lg_expression.segmentId, audio.error ? 'failed' : 'ended');"),
        ('            console.error("Audio play error:", err);', '            if (options.lg_expression) expressionPlayback.finish(options.lg_expression.segmentId, "failed");\n            console.error("Audio play error:", err);'),
        ("        if (LAppDefine && LAppDefine.PriorityNormal)", "        if (!options.lg_expression && LAppDefine && LAppDefine.PriorityNormal)"),
        ("    // Update display text", "    if (options.lg_stream) {\n"
         "      speechPlayback.play(options.lg_expression, () => {\n"
         "        if (displayText) {\n"
         "          appendText(displayText.text); appendAI(displayText.text, displayText.name, displayText.avatar);\n"
         "          updateSubtitle(displayText.text);\n"
         "          sendMessage({ type: 'audio-play-start', display_text: displayText, forwarded: true });\n"
         "        }\n"
         "      }, (audio: any, model: any) => {\n"
         "        audioManager.setCurrentAudio(audio, model);\n"
         "        return () => audioManager.clearCurrentAudio(audio);\n"
         "      }).then(resolve).catch(resolve);\n"
         "      return;\n    }\n\n    // Update display text"),
    ], prefix=module_import)
    edit("src/renderer/src/services/websocket-handler.tsx", [
        ("    case 'audio':", "    case 'lg-reminder':\n      void showReminder(message as any);\n      break;\n    case 'lg-expression-turn':\n"
         "      expressionPlayback.begin((message as any).generation);\n      speechPlayback.stop('superseded');\n      break;\n"
         "    case 'lg-speech-stream-failed':\n"
         "      if ((message as any).generation === expressionPlayback.reading().generation) {\n"
         "        expressionPlayback.stop('failed');\n        speechPlayback.stop('failed');\n      }\n      break;\n"
         "    case 'lg-audio-chunk': {\n"
         "      const packet = message as any;\n"
         "      /*\n"
         "       * Lv4.5 / P3：**插话要在用户还在说的时候也播出来** —— 那正是它存在的意义。\n"
         "       *\n"
         "       * ⚠️ 原来这里是「listening 就丢弃」。对**回复**是对的（她不该压着用户说），\n"
         "       *    但对**有来源的短插话**恰好相反：呼唤（\"苏沐薇\"）本来就发生在用户还在说的时候，\n"
         "       *    于是一条都不会被播 —— 实测：服务端两次投递 '我在。'，页面**一行读数都没有**\n"
         "       *    （既没播、也没回报），因为每一块都在这里被 `break` 掉了。\n"
         "       * ⚠️ 判据看**包的来源**（requestId = 'interjection'），不是看时间窗口：\n"
         "       *    只有程序既定的那条短句被放行，正式回复照旧被丢弃。\n"
         "       * ⚠️ `interrupted` 仍然一律丢弃：用户**明确打断**时什么都不该播（用户优先）。\n"
         "       */\n"
         "      const isInterjection = packet.actions?.lg_expression?.requestId === 'interjection';\n"
         "      if (aiState === 'interrupted') break;\n"
         "      if (aiState === 'listening' && !isInterjection) break;\n"
         "      if (speechPlayback.feed(packet) && packet.index === 0) {\n"
         "        addAudioTask({ audioBase64: '', volumes: [], sliceLength: 0,\n"
         "          displayText: packet.display_text, lg_expression: packet.actions.lg_expression, lg_stream: true });\n"
         "      }\n      break;\n    }\n    case 'audio':"),
        ("            expressions: message.actions?.expressions || null,", "            expressions: message.actions?.expressions || null,\n            lg_expression: (message.actions as any)?.lg_expression,"),
    ], prefix=module_import + "import { showReminder } from '@/utils/postlv2-reminder';\n")
    edit("src/renderer/src/utils/audio-manager.ts", [
        ("  stopCurrentAudioAndLipSync() {", "  stopCurrentAudioAndLipSync() {\n    speechPlayback.interrupt('interrupted');\n    expressionPlayback.stop('interrupted');"),
    ], prefix=module_import)
    # -------------------------------------------------------------------------
    # Lv4.5 / P1：**提交锚** —— 计划 §3 要的"端到端"读数从哪一刻算起
    # -------------------------------------------------------------------------
    #
    # ⚠️ 为什么必须接在这里：没有它，浏览器侧只能以"第一块音频到达"为锚 ⇒
    #    量到的是**播放排程延迟**（实测 406–516 ms），而端到端是 **11 s 量级**；
    #    两个数基线不同，混着读会得出"她 0.4 秒就说话了"这种**反的结论**。
    # ⚠️ 两个锚分开记（见 `postlv2_speech_client.js` 的 `reportTurnTiming`），
    #    在没提交事件时**如实退化**，不拿包到达冒名顶替。
    edit("src/renderer/src/hooks/footer/use-text-input.tsx", [
        ("  const [inputText, setInputText] = useState('');", "  const [inputText, setInputText] = useState('');\n  const imageUpload = useImageUpload();"),
        ("    if (!inputText.trim() || !wsContext) return;", "    if ((!inputText.trim() && !imageUpload.images.length) || imageUpload.reading || !wsContext) return;"),
        ("    const images = await captureAllMedia();", "    const images = [...imageUpload.images, ...await captureAllMedia()];\n    const text = inputText.trim() || '[用户发送了图片]';"),
        ("    appendHumanMessage(inputText.trim());", "    appendHumanMessage(text);"),
        ("      text: inputText.trim(),", "      text,"),
        ("    setInputText('');", "    setInputText('');\n    imageUpload.clear();"),
        ("    inputText,\n    setInputText:", "    inputText,\n    imageUpload,\n    setInputText:"),
        (
            "    appendHumanMessage(text);\n    wsContext.sendMessage({",
            "    appendHumanMessage(text);\n"
            "    /* Lv4.5 / P1：**提交锚** —— 计划 §3 的端到端读数从这一刻算起 */\n"
            "    speechPlayback.markSubmit();\n"
            "    wsContext.sendMessage({",
        ),
    ], prefix=module_import + "import { useImageUpload } from '@/utils/postlv2-image-upload';\n")
    edit("src/renderer/src/hooks/footer/use-footer.ts", [
        ("    inputText: inputValue,", "    inputText: inputValue,\n    imageUpload,"),
        ("    inputValue,", "    inputValue,\n    imageUpload,"),
    ])
    edit("src/renderer/src/components/footer/footer.tsx", [
        ("import { memo } from 'react';", "import { memo, useRef } from 'react';"),
        ("interface MessageInputProps {", "interface MessageInputProps {\n  imageUpload: any"),
        ("}: MessageInputProps) => {", "  imageUpload,\n}: MessageInputProps) => {"),
        ("  const { t } = useTranslation();", "  const { t } = useTranslation();\n  const imagePicker = useRef<HTMLInputElement>(null);"),
        ('          aria-label="Attach file"', '          aria-label="Attach file"\n          onClick={() => imagePicker.current?.click()}\n          disabled={imageUpload.reading}'),
        ("        <Textarea", '        <input ref={imagePicker} type="file" accept="image/png,image/jpeg" multiple hidden onChange={imageUpload.onChange} />\n        <Textarea'),
        ("      </Box>\n    </InputGroup>", '        {imageUpload.reading && <Box role="status">正在读取图片…</Box>}\n'
         '        {imageUpload.images.length > 0 && <Box role="status">已选 {imageUpload.images.length} 张图片，按回车发送。'
         '<button type="button" onClick={imageUpload.clear}>移除图片</button></Box>}\n'
         '        {imageUpload.error && <Box role="alert">{imageUpload.error}</Box>}\n      </Box>\n    </InputGroup>'),
        ("    inputValue,", "    inputValue,\n    imageUpload,"),
        ("            value={inputValue}", "            value={inputValue}\n            imageUpload={imageUpload}"),
    ])
    target = source / "src/renderer/src/utils/postlv2-image-upload.js"
    shutil.copy2(ROOT / "postlv2_image_upload.js", target)
    target.with_suffix(".d.ts").write_text("export function useImageUpload(): any;\n", encoding="utf-8")
    modified.append({"path": target.relative_to(source).as_posix(), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
    edit("src/renderer/src/hooks/utils/use-send-audio.tsx", [
        (
            '      const images = await captureAllMedia();\n      sendMessage({ type: "mic-audio-end", images });',
            '      const images = await captureAllMedia();\n'
            "      /* Lv4.5 / P1：**提交锚**（VAD 边界 = 用户说完了） */\n"
            "      speechPlayback.markSubmit();\n"
            '      sendMessage({ type: "mic-audio-end", images });',
        ),
    ], prefix=module_import)
    edit("src/renderer/src/services/websocket-service.tsx", [
        ("      this.ws.onclose = () => {", "      this.ws.onclose = () => {\n        expressionPlayback.disconnect();\n        speechPlayback.stop('disconnected');"),
        ("      this.ws.onerror = () => {", "      this.ws.onerror = () => {\n        expressionPlayback.stop('failed');\n        speechPlayback.stop('failed');"),
    ], prefix=module_import)
    # Each local page is bound to its own server; ignore saved upstream connection overrides.
    edit("src/renderer/src/context/websocket-context.tsx", [
        ("const DEFAULT_WS_URL = 'ws://127.0.0.1:12393/client-ws';", "const DEFAULT_WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/client-ws`;"),
        ("const DEFAULT_BASE_URL = 'http://127.0.0.1:12393';", "const DEFAULT_BASE_URL = window.location.origin;"),
        ("import { useLocalStorage } from '@/hooks/utils/use-local-storage';\n", ""),
        ("  const [wsUrl, setWsUrl] = useLocalStorage('wsUrl', DEFAULT_WS_URL);", "  const wsUrl = DEFAULT_WS_URL;"),
        ("  const [baseUrl, setBaseUrl] = useLocalStorage('baseUrl', DEFAULT_BASE_URL);", "  const baseUrl = DEFAULT_BASE_URL;\n  const setBaseUrl = (_url: string) => {};"),
        ("    setWsUrl(url);\n    wsService.connect(url);\n  }, [setWsUrl]);", "    wsService.connect(DEFAULT_WS_URL);\n  }, []);"),
    ])
    target = source / "src/renderer/src/utils/postlv2-expression.js"
    shutil.copy2(ROOT / "postlv2_expression_client.js", target)
    target.with_suffix(".d.ts").write_text("export const expressionPlayback: any;\n", encoding="utf-8")
    modified.append({"path": target.relative_to(source).as_posix(), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
    target = source / "src/renderer/src/utils/postlv2-speech.js"
    target.write_text((ROOT / "postlv2_speech_client.js").read_text(encoding="utf-8").replace(
        "'./postlv2_expression_client.js'", "'./postlv2-expression.js'"), encoding="utf-8", newline="\n")
    target.with_suffix(".d.ts").write_text("export const speechPlayback: any;\n", encoding="utf-8")
    modified.append({"path": target.relative_to(source).as_posix(), "sha256": hashlib.sha256(target.read_bytes()).hexdigest()})
    edit("src/renderer/src/App.tsx", [
        ('      {/* Conditional Rendering of Pet Mode UI */}', '      <AppearancePanel />\n      <MemoryModePanel />\n\n      {/* Conditional Rendering of Pet Mode UI */}'),
    ], prefix="import { AppearancePanel } from '@/components/postlv2-appearance-panel';\nimport { MemoryModePanel } from '@/components/postlv2-memory-mode-panel';\n")
    for relative, local, declaration in [
        ("src/renderer/src/utils/postlv2-reminder.js", "postlv2_reminder_client.js", "export function showReminder(...args: any[]): Promise<boolean>;\n"),
        ("src/renderer/src/utils/postlv2-appearance.js", "postlv2_appearance_client.js", "export function createAppearanceController(...args: any[]): any;\n"),
        ("src/renderer/src/components/postlv2-appearance-panel.jsx", "postlv2_appearance_panel.jsx", "export function AppearancePanel(): any;\n"),
        ("src/renderer/src/components/postlv2-memory-mode-panel.jsx", "postlv2_memory_mode_panel.jsx", "export function MemoryModePanel(): any;\n"),
    ]:
        path = source / relative
        shutil.copy2(ROOT / local, path)
        path.with_suffix(".d.ts").write_text(declaration, encoding="utf-8")
        modified.append({"path": relative, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    definition_path = source / "src/renderer/src/utils/postlv2-appearance.json"
    definition_path.write_text(json.dumps(appearance_definition(frontend.parent / "live2d-models/lg_ulvm2_0001"),
                                           ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    modified.append({"path": definition_path.relative_to(source).as_posix(), "sha256": hashlib.sha256(definition_path.read_bytes()).hexdigest()})
    fingerprint = hashlib.sha256(json.dumps(modified, sort_keys=True).encode()).hexdigest()
    receipt_path = frontend.parent / "lg-expression-frontend.json"
    previous = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    index_path = frontend / "index.html"
    if (previous.get("patch_sha256") == fingerprint and index_path.is_file()
            and previous.get("index_sha256") == hashlib.sha256(index_path.read_bytes()).hexdigest()):
        return
    if not (source / "node_modules/.bin/vite.cmd").is_file():
        # Use the reviewed lockfile. Skip Electron installers: only the browser renderer is needed.
        subprocess.run(["cmd", "/d", "/c", "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=source, check=True)
    subprocess.run(["cmd", "/d", "/c", "npm", "run", "build:web"], cwd=source, check=True)
    shutil.copytree(source / "dist/web", frontend, dirs_exist_ok=True)
    receipt = {"source_commit": SOURCE_COMMIT, "patch_sha256": fingerprint, "patched_files": modified,
               "index_sha256": hashlib.sha256((frontend / "index.html").read_bytes()).hexdigest()}
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    deps = Path.home() / "postlv2-deps"
    build_frontend(deps, deps / "Open-LLM-VTuber/frontend")
