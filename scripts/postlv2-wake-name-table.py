"""Lv4.5 / `P2`+`P3` —— 从**模型自带的词典**生成"她的名字"的同音类表（冻结进内核）。

============================================================================
 为什么要有这一步（用户提出的现实难题）
============================================================================
"苏沐薇"这三个字，语音识别**不保证**认对。实测（2026-10-04）：
用系统中文语音念「苏沐薇，你在吗」，生产在用的那一档流式识别器给出
`苏` → `苏慕` → `苏慕微` —— **沐被听成慕、薇被听成微**。字面量匹配因此在真实链路上
**一次都没触发**。

手写同音字表不行：漏一个字就等于漏一种真实读法，而且没人说得清"手写的表覆盖了多少"。
所以这里改成**从词典生成**：
```text
来源：sherpa VITS 模型自带的 lexicon.txt（本机已有，不需要联网、不需要新依赖）
规则：忽略声调后的**音素序列完全相同** ⇒ 同音类
     （苏 = s u1 ⇒ 同音类 s u；薇 = ^ uei1 ⇒ 零声母记作 ^）
```
生成结果**冻结**成 `src/kernel/app/bridge/wake-name-table.ts`（纯数据，内核零依赖）。

⚠️ **近似（近音）另列**：同音类之外，只允许**一个**音节落在"有据可依的混淆"里：
```text
s ↔ sh（平翘舌）· m ↔ n · 零声母 ↔ h（w- 与 h- 相混）
```
**最多一个**音节可以这样偏 —— 三个音节各自都能偏，会把「舒服」这类词拉进来。

用法： `python scripts/postlv2-wake-name-table.py`（幂等；改词典才需要重跑）
"""

import hashlib
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LEXICON = Path(r"C:\Users\user\postlv2-deps\models\vits-icefall-zh-aishell3\lexicon.txt")
TARGET = REPO / "src" / "kernel" / "app" / "bridge" / "wake-name-table.ts"

# 她的名字的音素（**忽略声调**）。零声母在 lexicon 里记作 `^`。
SYLLABLES = {"su": ("s", "u"), "mu": ("m", "u"), "uei": ("^", "uei")}
# 有据可依的近音混淆：目标音节 → 允许与之相混的音节
#
# ⚠️ 每一条都**来自实测**，不是推演出来的音韵学：
# ```text
# sh u —— 平翘舌（s↔sh），中文 ASR 最常见的混淆之一
# n  u —— m↔n
# h uei —— 零声母与 h- 相混（w- / h- 在快速语流里常被混）
# f  u —— 【2026-10-04 用户真实语音】用户喊她的名字，生产识别器给出「**服木喂**」：
#          苏(s u) 被听成 服(f u)。这是**用户真声**产生的读数 —— 它此前**一次都没命中**，
#          所以判据漏掉了这条真实读法。（此前的语料是机器合成的，合成音没有这个混淆。）
# ```
NEAR = {"su": ("sh", "u"), "mu": ("n", "u"), "uei": ("h", "uei")}
# 额外的、按**实测**追加的近音音节（同一个"至多一个音节可偏"的纪律）
EXTRA_NEAR = {"su": [("f", "u")], "mu": [], "uei": []}


def load_lexicon(path):
    entries = {}
    if not path.is_file():
        raise SystemExit(f"找不到词典：{path}")
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split(" ")
        if len(parts) < 3 or len(parts[0]) != 1:
            continue
        key = tuple(re.sub(r"\d$", "", item) for item in parts[1:-1] if not item.startswith("#"))
        entries.setdefault(key, []).append(parts[0])
    return entries


def main():
    entries = load_lexicon(LEXICON)
    digest = hashlib.sha256(LEXICON.read_bytes()).hexdigest()
    exact, near = {}, {}
    for name, phones in SYLLABLES.items():
        exact[name] = entries.get(phones, [])
        # 近音类 = 有据可依的那个混淆 + 实测追加的那几条（都并进同一类）
        chars = list(entries.get(NEAR[name], []))
        for extra in EXTRA_NEAR.get(name, []):
            chars.extend(entries.get(extra, []))
        # 去重且保序（同音类里同一个字不该出现两次）
        near[name] = list(dict.fromkeys(chars))
    empty = [name for name, chars in {**exact, **near}.items() if not chars]
    if empty:
        # ⚠️ 空集必须**当场失败**：一个空的同音类会让"名字永远匹配不上"，
        #    而那种失败看起来像"用户没叫她"，不像"表坏了"。
        raise SystemExit(f"这些音节在词典里是空的，生成中止：{empty}")

    def joined(chars):
        return "".join(chars)

    body = f'''/**
 * Lv4.5 / `P2`+`P3` —— **她的名字的同音类表**（生成物，**不要手改**）。
 *
 * ============================================================================
 *  来源与规则（可复现）
 * ============================================================================
 * ```text
 * 生成器：scripts/postlv2-wake-name-table.py
 * 词典  ：vits-icefall-zh-aishell3/lexicon.txt
 *         sha256 = {digest}
 *         条目 {len(entries)} 个音素序列 / {sum(len(v) for v in entries.values())} 个字
 * 规则  ：忽略声调后**音素序列完全相同** ⇒ 同音类（零声母记作 ^）
 *         苏 = s u1 ⇒ `s u` · 沐 = m u4 ⇒ `m u` · 薇 = ^ uei1 ⇒ `^ uei`
 * ```
 *
 * ⚠️ 为什么是生成物而不是手写表：手写会**漏**，而漏一个字就等于漏一种真实读法；
 *    生成物的覆盖率是**算得出来**的（每类的字数就在下面）。
 * ⚠️ 为什么冻结进内核：内核不许 import 文件系统/模型；这张表是**纯数据**。
 *
 * ⚠️ 近音类（`NEAR`）**最多只能有一个音节**落在里面 —— 三个音节各自都能偏，
 *    会把「舒服」这类词拉进来（实测：`舒` = sh u 与目标首音节只差一个混淆）。
 */

/** 词典来源与指纹（门与排错读它，判据本身不用） */
export const WAKE_NAME_TABLE_PROVENANCE = {{
  lexicon: 'vits-icefall-zh-aishell3/lexicon.txt',
  sha256: '{digest}',
  phonemeSequences: {len(entries)},
  characters: {sum(len(v) for v in entries.values())},
  rule: '忽略声调后音素序列完全相同（零声母记作 ^）',
}} as const

/** 同音类：键是**音素序列**，值是这一类的全部汉字（含冷僻字，因为识别器也可能吐出来） */
export const WAKE_NAME_EXACT: Readonly<Record<string, string>> = {{
  su: '{joined(exact["su"])}',
  mu: '{joined(exact["mu"])}',
  uei: '{joined(exact["uei"])}',
}}

/**
 * 近音类（有据可依的混淆）：`s↔sh` · `m↔n` · `零声母↔h`。
 *
 * ⚠️ 判定时**至多**用一个：三个音节都能偏会让精度塌掉。
 */
export const WAKE_NAME_NEAR: Readonly<Record<string, string>> = {{
  su: '{joined(near["su"])}',
  mu: '{joined(near["mu"])}',
  uei: '{joined(near["uei"])}',
}}
'''
    TARGET.write_text(body, encoding="utf-8", newline="\n")
    print(f"wrote {TARGET.relative_to(REPO)}")
    print(f"  exact: su={len(exact['su'])} mu={len(exact['mu'])} uei={len(exact['uei'])}")
    print(f"  near : su={len(near['su'])} mu={len(near['mu'])} uei={len(near['uei'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
