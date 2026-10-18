#!/bin/sh
# =============================================================================
#  bootstrap-linux-python.sh -- rebuild the project's Python runtimes on Linux
# =============================================================================
#
#  WHAT THIS SCRIPT IS
#  -------------------
#  A POSIX `sh` script that runs ON THE LINUX SERVER and builds the Python
#  virtual environments the app shells out to.
#
#  WHAT THIS SCRIPT IS NOT
#  -----------------------
#  It is NOT a copier. Nothing here moves a Windows virtualenv to Linux. That
#  is the single mistake this script exists to prevent (see REFUSAL below).
#
# =============================================================================
#  WHY REBUILD INSTEAD OF COPY  (the mistake being prevented)
# =============================================================================
#
#  A Windows venv contains:
#
#    venv/Scripts/python.exe            <- a Windows PE executable
#    venv/Scripts/pip.exe               <- ditto
#    venv/Lib/site-packages/*.pyd       <- Windows-native extension modules
#    venv/pyvenv.cfg -> home = C:\...\Python312
#
#  On Linux none of that is usable. The dangerous part is not that it fails --
#  it is that it *looks* like it works:
#
#    - The app resolves its interpreter by defaulting to
#      `venv/Scripts/python.exe` (src/infrastructure/action/adapters/
#      rapid-ocr-assets.ts:18 and desktop-control-assets.ts:44).
#    - Those checks are `stat`-based existence probes, deliberately, so that
#      they can run at assembly time without spawning a process.
#    - So if you `cp -r` a Windows venv onto the server, the runtime check
#      honestly reports "available", the capability shows up in the tool
#      catalogue as connected, and the first real spawn fails minutes later.
#
#  A deployment that lies about its own health is worse than no deployment.
#  Hence: build on the target, from pins read off the source.
#
# =============================================================================
#  WHY THIS SCRIPT REFUSES TO RUN UNDER MSYS / MINGW / CYGWIN
# =============================================================================
#
#  Those environments answer `uname -s` with MINGW64_NT-* / MSYS_NT-* /
#  CYGWIN_NT-*. They look like Linux to a naive check, they run POSIX shells,
#  and they can see Windows drives. That combination makes it *possible* to
#  build a venv that is then casually copied somewhere -- i.e. exactly the
#  mistake above. We stop it at the door with an explicit, loud refusal rather
#  than relying on the operator noticing the platform string.
#
# =============================================================================
#  PYTHON VERSIONS  (read off the Windows dev machine, not guessed)
# =============================================================================
#
#  Every version below was read from a real `pyvenv.cfg` / `*.dist-info` on the
#  dev machine. Where a value could NOT be read, the script says so with a
#  `# TODO(verify)` marker instead of inventing one.
#
#  1) automatic-memory  (LangMem)
#     Path : data/runtime/automatic-memory/langmem-48e3c11/.venv
#     pyvenv.cfg says:
#         implementation = CPython
#         version_info  = 3.12          <- minor version NOT recorded
#         uv = 0.12.4
#         home = ...\uv\python\cpython-3.12-windows-x86_64-none
#     => TARGET: CPython 3.12.  The exact patch level (3.12.11? 3.12.13?) is
#        NOT determinable from the repository, so this script pins the series
#        ">=3.12,<3.13" rather than a guessed patch number.
#     Consumed by: CHARACTER_MEMORY_AUTOMATIC_PYTHON, which spawns
#        scripts/automatic_memory_langmem.py (langmem-memory-extractor.ts:127).
#
#  2) document-ocr  (RapidOCR)
#     Path : artifacts/post-lv2/local/ocr-runtime/venv
#     pyvenv.cfg says: version = 3.12.13
#     install-report.json pins the four direct packages (see BASELINE below).
#     Consumed by: PROJECT_LG_RAPIDOCR_PYTHON (rapid-ocr-assets.ts:18).
#
#  3) desktop-control  -- DELIBERATELY NOT BUILT HERE.
#     Path : artifacts/post-lv2/local/desktop-runtime/venv
#     pyvenv.cfg says: version = 3.14.0
#     Upstream is windows-mcp==0.8.7 whose dependency tree contains
#     dxcam / comtypes / pywin32 -- Windows-only, no Linux equivalent.
#     => On the server, `desktop.inspect` / `desktop.operate` must stay OFF:
#        leave CHARACTER_DESKTOP_INSPECT_ENABLED and
#        CHARACTER_DESKTOP_OPERATE_ENABLED unset in .env.
#        Rebuilding this one is not a TODO, it is a "never".
#
#  4) utility-skills-preparation
#     Path: artifacts/post-lv2/local/utility-skills-preparation/python/venv
#     version = 3.12.13. It is the `home` that ocr-runtime/venv was created
#     from.
#
#     ⚠️ 2026-10-16 · **部署前复核 §4 推翻了"没有运行消费者"这个说法**。
#        第一版把这一个标成"不构建"，理由是"在 src/ 与 scripts/ 里找不到消费者"。
#        那是**检索漏了** —— 消费者就是这两个适配器的**解释器缺省值**：
#          · `document-read.ts`   DEFAULT_DOC_PYTHON     -> .../utility-skills-preparation/python/venv/Scripts/python.exe
#          · `office-generate.ts` OFFICE_PYTHON          -> 同上
#        也就是说：**不构建它，服务器上的"读文档"与"生成 Office"两个能力都起不来**，
#        而它们在能力清单里是开着的（`CHARACTER_DOCUMENT_READ_ENABLED` /
#        `CHARACTER_OFFICE_GENERATE_ENABLED`）。
#        ⇒ 现在**必须构建**它，并导出两个 env 覆盖口。
#
#     消费者清单（复核时的证据，不是猜的）：
#       document-read.ts   : scripts/utility-skills/doc-runner.py
#       office-generate.ts : scripts/productivity-skills/office-generate.py
#
# =============================================================================
#  SYSTEM PACKAGES -- THIS SCRIPT NEVER INSTALLS ANYTHING
# =============================================================================
#
#  If something is missing, the script prints the exact command and exits
#  non-zero. Silently running `apt-get install` as root from a bootstrap script
#  is how a server ends up in a state nobody can reproduce.
#
# =============================================================================
#  USAGE
# =============================================================================
#
#   sh scripts/deploy/bootstrap-linux-python.sh --dry-run
#   sh scripts/deploy/bootstrap-linux-python.sh
#   sh scripts/deploy/bootstrap-linux-python.sh --prefix /srv/project-lg/data/runtime
#
#  Options:
#   --dry-run                 print what would happen; create nothing
#   --prefix <dir>            where the venvs go (default /opt/project-lg/data/runtime)
#   --windows-venv-root <dir> repo root of the *source* checkout, used to read
#                             pinned versions out of the existing Windows venvs
#   --only <name>             build just one purpose (automatic-memory | document-ocr)
#   -h, --help                this text
#
# =============================================================================

set -eu

SCRIPT_NAME=$(basename "$0")

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------
PREFIX_DEFAULT='/opt/project-lg/data/runtime'
PREFIX=$PREFIX_DEFAULT
WINDOWS_VENV_ROOT_DEFAULT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
WINDOWS_VENV_ROOT=$WINDOWS_VENV_ROOT_DEFAULT
DRY_RUN=0
ONLY=''

MIN_PY_MAJOR=3
MIN_PY_MINOR=11
EXPECTED_SERIES='3.12'

# ---------------------------------------------------------------------------
# Output helpers.  ASCII only, printf only (no echo -e, no bashisms).
# ---------------------------------------------------------------------------
log()  { printf '[%s] %s\n' "$SCRIPT_NAME" "$1"; }
warn() { printf '[%s] WARNING: %s\n' "$SCRIPT_NAME" "$1"; }
die()  { printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$1" >&2; exit 1; }

usage() {
    # The file header is the documentation. Print it verbatim (minus the '# ').
    # Robust against edits to the header, unlike a hardcoded line range.
    # The shebang is dropped explicitly so `#!` is not mangled into `!`.
    sed -n '1,/^[^#]/p' "$0" | sed '1d' | sed '$d' | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run)      DRY_RUN=1; shift ;;
        --prefix)       [ $# -ge 2 ] || die '--prefix needs a value'; PREFIX=$2; shift 2 ;;
        --windows-venv-root)
                        [ $# -ge 2 ] || die '--windows-venv-root needs a value'
                        WINDOWS_VENV_ROOT=$2; shift 2 ;;
        --only)         [ $# -ge 2 ] || die '--only needs a value'; ONLY=$2; shift 2 ;;
        -h|--help)      usage; exit 0 ;;
        *)              die "unknown argument: $1 (try --help)" ;;
    esac
done

# ---------------------------------------------------------------------------
# STEP 1 -- Refuse Windows-like environments.
# ---------------------------------------------------------------------------
check_not_windows() {
    kernel=$(uname -s 2>/dev/null || printf 'unknown')
    log "step 1/7: checking that this is a real Linux host (uname -s = ${kernel})"

    case "$kernel" in
        Linux) ;;
        MINGW*|MSYS*|CYGWIN*|Windows_NT*)
            die "refusing to run under '${kernel}'.
    This is a Windows-POSIX emulation layer (MSYS/MinGW/Cygwin). It answers
    uname -s like Linux and can see Windows drives, which is precisely how a
    Windows venv gets built here and then copied somewhere it will silently
    fail. Run this script on the Linux server itself, or in a container."
            ;;
        Darwin)
            die "'${kernel}' is macOS, not the Linux target (Ubuntu 24.04).
    A macOS venv is as non-portable to Linux as a Windows one."
            ;;
        *)
            die "unsupported platform '${kernel}'. This script targets Linux."
            ;;
    esac
    log "        platform OK: ${kernel}"
}

# ---------------------------------------------------------------------------
# STEP 2 -- Find a usable Python.
# ---------------------------------------------------------------------------
py_version_string() {
    # "$1" = interpreter path. Prints "X.Y.Z" or nothing if unreadable.
    "$1" -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])' 2>/dev/null || printf ''
}

py_version_ok() {
    # "$1" = "X.Y.Z". Succeeds when >= 3.11.
    [ -n "$1" ] || return 1
    _maj=$(printf '%s' "$1" | cut -d. -f1)
    _min=$(printf '%s' "$1" | cut -d. -f2)
    [ -n "$_maj" ] && [ -n "$_min" ] || return 1
    [ "$_maj" -gt "$MIN_PY_MAJOR" ] 2>/dev/null && return 0
    [ "$_maj" -eq "$MIN_PY_MAJOR" ] 2>/dev/null || return 1
    [ "$_min" -ge "$MIN_PY_MINOR" ]
}

find_python() {
    log "step 2/7: locating a CPython >= ${MIN_PY_MAJOR}.${MIN_PY_MINOR}"

    for candidate in python3.13 python3.12 python3.11 python3 python; do
        command -v "$candidate" >/dev/null 2>&1 || continue
        ver=$(py_version_string "$candidate")
        if py_version_ok "$ver"; then
            FOUND_PYTHON=$(command -v "$candidate")
            FOUND_PYTHON_VERSION=$ver
            log "        using ${FOUND_PYTHON} (${FOUND_PYTHON_VERSION})"

            case "$FOUND_PYTHON_VERSION" in
                "$EXPECTED_SERIES".*) : ;;
                *)
                    warn "found ${FOUND_PYTHON_VERSION}; the Windows environments were built on ${EXPECTED_SERIES}."
                    warn "A different minor version is not automatically wrong, but it IS a deviation"
                    warn "from the versions these pins were observed on. Record it if you keep it."
                    ;;
            esac
            return 0
        fi
    done

    die "no CPython >= ${MIN_PY_MAJOR}.${MIN_PY_MINOR} found (tried python3.13, python3.12, python3.11, python3, python).
    This script will NOT install one for you. On Ubuntu 24.04 run exactly:
        sudo apt-get update && sudo apt-get install -y python3 python3-venv python3-pip
    then re-run this script."
}

check_venv_module() {
    log "step 3/7: checking that the venv module is available to ${FOUND_PYTHON}"
    if "${FOUND_PYTHON}" -c 'import venv' >/dev/null 2>&1; then
        log "        venv module OK"
        return 0
    fi
    die "'${FOUND_PYTHON} -m venv' is unavailable (Debian/Ubuntu ship venv in a separate package).
    This script will NOT apt-get install it for you. Run exactly:
        sudo apt-get update && sudo apt-get install -y python3-venv python3-pip
    then re-run this script.
    If that still fails, your python3 is probably a deadsnakes/conda build; point --prefix
    at a venv you create by hand, or install a distro python3 first."
}

# ---------------------------------------------------------------------------
# STEP 4 -- Read pins out of the source checkout, if it is reachable.
# ---------------------------------------------------------------------------
# dist-info directory names look like  rapidocr-3.9.2  or  typing_extensions-4.16.0
# or  opencv_python-4.11.0.86.  We split on the LAST hyphen; a version never
# contains one, and a package name may. This is the same technique the repo
# already used to backfill artifacts/post-lv2/local/ocr-runtime/install-report.json.
split_dist_info() {
    _di=$1
    _tail=${_di##*-}
    _name=${_di%-*}
    printf '%s %s' "$_name" "$_tail"
}

# normalise a dist-info name into a PyPI project name
normalize_project_name() {
    printf '%s' "$1" | tr '_' '-' | tr 'A-Z' 'a-z'
}

# is_project_pinned <normalized-name>  -> 0 if it is in the pin list below
# The pin lists are the DIRECT dependencies, read off the Windows venvs.
# Pinning all ~48 transitive packages would make the Linux build fail for
# reasons that have nothing to do with this app, and would silently freeze
# security patches of libraries we do not own.
is_direct_dependency() {
    case "$1" in
        # --- automatic-memory (LangMem) : read from
        #     data/runtime/automatic-memory/langmem-48e3c11/.venv/Lib/site-packages/*.dist-info
        langmem|langchain|langchain-core|langchain-openai|langchain-anthropic|\
        langgraph|langsmith|openai|anthropic|tiktoken|pydantic) return 0 ;;
        # --- document-ocr (RapidOCR) : corroborated by
        #     artifacts/post-lv2/local/ocr-runtime/install-report.json (version 1)
        rapidocr|onnxruntime|opencv-python|numpy) return 0 ;;
        *) return 1 ;;
    esac
}

# is_windows_only <normalized-name> -> 0 if it must NOT be installed on Linux.
# These were present in the Windows site-packages. They are Windows console
# helpers that a Linux build pulls in at most harmlessly; installing them is
# noise, and pyreadline3 in particular has no business on a server.
#
# TODO(verify): if `rapidocr` ever grows a code path that imports colorama on
#   POSIX, move it back into the install list. Not observed on the dev machine.
is_windows_only() {
    case "$1" in
        pyreadline3|colorama) return 0 ;;
        *) return 1 ;;
    esac
}

# emit_pins_from_dist_info <site-packages-dir> <requirements-file>
emit_pins_from_dist_info() {
    _sp=$1
    _out=$2
    [ -d "$_sp" ] || return 1
    _found=0
    for _di in "$_sp"/*.dist-info; do
        [ -d "$_di" ] || continue
        _base=$(basename "$_di")
        _base=${_base%.dist-info}
        set -- $(split_dist_info "$_base")
        _rawname=$1
        _version=$2
        [ -n "$_version" ] || continue
        _name=$(normalize_project_name "$_rawname")

        if is_windows_only "$_name"; then
            printf '# skipped (Windows-only on the dev machine): %s==%s\n' "$_name" "$_version" >> "$_out"
            continue
        fi
        if is_direct_dependency "$_name"; then
            printf '%s==%s\n' "$_name" "$_version" >> "$_out"
            _found=$(( _found + 1 ))
        else
            printf '# transitive, let the resolver choose: %s (was %s on Windows)\n' "$_name" "$_version" >> "$_out"
        fi
    done
    [ "$_found" -gt 0 ] || return 1
    return 0
}

# ---------------------------------------------------------------------------
# STEP 5 -- Per-purpose venv construction.
# ---------------------------------------------------------------------------
make_venv() {
    _purpose=$1
    _venv_dir="$PREFIX/$_purpose"
    _req_file="$_venv_dir/requirements.txt"

    log "step 5/7: building the '$_purpose' runtime at ${_venv_dir}"
    log "        interpreter will be ${_venv_dir}/bin/python  (NOT .../Scripts/python.exe)"

    if [ -d "$_venv_dir" ] && [ -x "$_venv_dir/bin/python" ]; then
        if [ "$_purpose" = utility-skills ] && ! "$_venv_dir/bin/python" -c 'import importlib.util; assert all(importlib.util.find_spec(name) for name in ("markitdown", "pdfminer", "mammoth", "pandas", "docx", "pptx", "openpyxl"))'; then
            die "utility-skills runtime is incomplete; install markitdown[pdf,docx,pptx,xlsx]==0.1.8 and the Office dependencies before reusing it."
        fi
        log "        already present and runnable -- leaving it alone (delete it by hand to force a rebuild)"
        return 0
    fi

    # --- 5a. write the requirements file next to the venv ---
    if [ "$DRY_RUN" -eq 1 ]; then
        log "        [dry-run] would create ${_venv_dir}"
        log "        [dry-run] would write ${_req_file} from ${_purpose}"
        log "        [dry-run] would run: ${FOUND_PYTHON} -m venv ${_venv_dir}"
        log "        [dry-run] would run: ${_venv_dir}/bin/pip install --upgrade pip"
        log "        [dry-run] would run: ${_venv_dir}/bin/pip install -r ${_req_file}"
        return 0
    fi

    mkdir -p "$PREFIX"

    # 5a-i: try to read real pins from the source checkout
    _src_sp=''
    case "$_purpose" in
        automatic-memory) _src_sp="$WINDOWS_VENV_ROOT/data/runtime/automatic-memory/langmem-48e3c11/.venv/Lib/site-packages" ;;
        document-ocr)     _src_sp="$WINDOWS_VENV_ROOT/artifacts/post-lv2/local/ocr-runtime/venv/Lib/site-packages" ;;
        utility-skills)   _src_sp="$WINDOWS_VENV_ROOT/artifacts/post-lv2/local/utility-skills-preparation/python/venv/Lib/site-packages" ;;
    esac

    mkdir -p "$_venv_dir"
    : > "$_req_file"

    log "        writing ${_req_file}"
    if [ -n "$_src_sp" ] && emit_pins_from_dist_info "$_src_sp" "$_req_file"; then
        log "        pins read from the source checkout: ${_src_sp}"
    else
        log "        source checkout not readable at '${_src_sp}' -- falling back to the recorded baseline."
        log "        (the baseline below was read off that venv on the dev machine; re-read it and pin properly)"
        case "$_purpose" in
            automatic-memory) write_baseline_automatic_memory "$_req_file" ;;
            document-ocr)     write_baseline_document_ocr "$_req_file" ;;
            utility-skills)   write_baseline_utility_skills "$_req_file" ;;
            *) die "no baseline for purpose '$_purpose'" ;;
        esac
    fi

    if ! grep -q '^[^#]' "$_req_file" 2>/dev/null; then
        die "the generated ${_req_file} has no installable pins. Refusing to create an empty venv."
    fi

    # --- 5b. create the venv ---
    log "        creating venv: ${FOUND_PYTHON} -m venv ${_venv_dir}"
    if ! "${FOUND_PYTHON}" -m venv "$_venv_dir"; then
        die "python -m venv failed for ${_venv_dir}.
    On Debian/Ubuntu this almost always means python3-venv is missing:
        sudo apt-get update && sudo apt-get install -y python3-venv python3-pip
    (This script will not install it for you.)"
    fi

    # --- 5c. upgrade pip ---
    log "        upgrading pip inside the venv"
    "${_venv_dir}/bin/pip" install --upgrade pip

    # --- 5d. install the pins ---
    log "        installing pins from ${_req_file}"
    "${_venv_dir}/bin/pip" install -r "$_req_file"

    log "        built OK: $("${_venv_dir}/bin/python" --version 2>&1)"
}

# ---------------------------------------------------------------------------
# Recorded baselines.
#
# Every `==` value below was READ OFF a real *.dist-info on the Windows dev
# machine, not guessed. Anything we could not determine carries a
# TODO(verify) marker instead of an invented value.
# ---------------------------------------------------------------------------
write_baseline_automatic_memory() {
    _out=$1
    cat >> "$_out" <<'REQ_EOF'
# ------------------------------------------------------------------
# automatic-memory (LangMem) -- recorded baseline
#
# Source of truth when this file was written:
#   data/runtime/automatic-memory/langmem-48e3c11/.venv/Lib/site-packages/*.dist-info
#   pyvenv.cfg: implementation=CPython  version_info=3.12  uv=0.12.4
#
# Interpreter:
#   TARGET CPython 3.12.  The exact patch release is NOT recorded anywhere in
#   the repository (pyvenv.cfg only carries `version_info = 3.12`), so this
#   script pins the series rather than guessing a patch number.
#   TODO(verify): record the dev machine's exact `python_full_version` for
#   this venv if byte-level parity with dev matters.
#   Observed sibling environments on the same machine are 3.12.13, so 3.12.13
#   is the most likely patch -- but "most likely" is not a measurement.
# ------------------------------------------------------------------

langmem==0.0.30
langchain==1.4.0
langchain-core==1.6.1
langchain-openai==1.6.0
langchain-anthropic==1.7.1
langgraph==1.2.11
langsmith==0.12.1
openai==3.8.0
anthropic==1.3.0
tiktoken==0.14.0
pydantic==2.13.5

# --- observations deliberately NOT encoded as pins -----------------------
#
# Observed in the Windows venv but NOT installed here:
#   dydantic==0.0.8        A typo/placeholder distribution (not "pydantic").
#                          Almost certainly an accident of the upstream
#                          resolver. TODO(verify) whether anything imports it.
#   httpcore2==2.12.0      and httpx2==2.12.0
#   httpcore==1.0.9              Same packages installed twice under two
#   httpx==0.28.1                names. Which tree LangMem actually imports
#                               at runtime is NOT determinable from the
#                               repository. TODO(verify) before assuming
#                               these are dead weight.
#
# Everything else in that site-packages (requests, urllib3, certifi,
# packaging, pydantic_core, typing_extensions, ...) is transitive and is left
# to the resolver on purpose.
# ------------------------------------------------------------------

# TODO(verify): confirm which of the two httpx/httpcore trees is live.
# TODO(verify): langchain_protocol==0.0.19 and langgraph_sdk==0.4.4 were
#   present. They look like transitive deps of langchain/langgraph, but if
#   LangMem imports them directly they must be pinned explicitly.
REQ_EOF
}

write_baseline_utility_skills() {
    _out="$1"
    cat >> "$_out" <<'REQ_EOF'
# ------------------------------------------------------------------
# utility-skills -- recorded baseline (2026-10-16, 复核 §4 要求补上)
#
# 这个 venv 是 **document.read** 与 **office.generate** 两个能力的解释器：
#   document-read.ts   DEFAULT_DOC_PYTHON
#   office-generate.ts OFFICE_PYTHON
# ⇒ 不构建它，服务器上"读文档"和"生成 Office"两个**已开启**的能力都起不来。
#
# MarkItDown 的固定版本来自开发机 requirements.lock.txt；其余三项保留既有解析策略。
# ⚠️ **其余版本是"用途推定"，不是"读出来的"** —— 与上面两个 baseline 不同。
#    本脚本无法从开发机读到该 venv 的 dist-info（见 emit_pins_from_dist_info 的
#    回退分支），所以这里只写**由消费者反推的最小集合**，
#    其余依赖（docx/pptx/xlsx/pdf 解析链）留给 pip 解析。
#    TODO(verify): 在有该 venv 的机器上跑一次
#      pip freeze  > <venv>/Lib/site-packages 的 dist-info 对照表
#    把真实 pin 补进来，再删掉本段说明。
# ------------------------------------------------------------------

# doc / office 生成与读取（消费者 scripts/utility-skills/doc-runner.py、
# scripts/productivity-skills/office-generate.py 需要的直接依赖）
markitdown[pdf,docx,pptx,xlsx]==0.1.8
python-docx
python-pptx
openpyxl

# ⚠️ 其余版本**不固定**：这里没有任何读数支撑具体版本号，
#    写死一个猜出来的 pin 比不写更危险（它会伪装成"已验证"）。
#    首次在服务器上构建成功后，请把 pip freeze 的结果回填到这里并重跑本脚本。

REQ_EOF
}

write_baseline_document_ocr() {
    _out=$1
    cat >> "$_out" <<'REQ_EOF'
# ------------------------------------------------------------------
# document-ocr (RapidOCR) -- recorded baseline
#
# Two independent sources agree on these four pins:
#   1. artifacts/post-lv2/local/ocr-runtime/install-report.json  (version 1)
#   2. artifacts/post-lv2/local/ocr-runtime/venv/Lib/site-packages/*.dist-info
#   pyvenv.cfg: version = 3.12.13   (exact, unlike the automatic-memory one)
#
# The ONNX model files themselves are NOT a pip concern -- they are copied
# as assets and hash-verified by scripts/deploy/asset-manifest.mjs against the
# constants hardcoded in src/infrastructure/action/adapters/rapid-ocr-assets.ts.
# ------------------------------------------------------------------

rapidocr==3.9.2
onnxruntime==1.20.1
opencv-python==4.11.0.86
numpy==1.26.4

# --- observed on the dev machine, deliberately NOT installed here --------
#   pyreadline3==3.5.6   Windows console helper (via humanfriendly).
#                        TODO(verify): the `humanfriendly`/`colorlog` tree
#                          exists only because rapidocr pulled the
#                          humanfriendly CLI extras in on Windows. If a
#                          non-TTY server install needs them, add them.
#   colorama==0.4.6      Same story -- a Windows-only console shim.
#                        TODO(verify): confirm no import path needs it on POSIX.
#
# The remaining site-packages entries (shapely, pyclipper, sympy, pillow,
# protobuf, tqdm, antlr4_python3_runtime, ...) are transitive; leaving them
# to the resolver keeps the pin set reviewable.
# ------------------------------------------------------------------
REQ_EOF
}

# ---------------------------------------------------------------------------
# STEP 6 -- Report what was built.
# ---------------------------------------------------------------------------
report() {
    log "step 6/7: built runtimes"
    if [ "$DRY_RUN" -eq 1 ]; then
        log "        (dry-run: nothing was actually created)"
    else
        for _p in automatic-memory document-ocr utility-skills; do
            if [ -x "$PREFIX/$_p/bin/python" ]; then
                log "        $_p -> $("$PREFIX/$_p/bin/python" --version 2>&1)"
            else
                log "        $_p -> (not built)"
            fi
        done
    fi
}

# ---------------------------------------------------------------------------
# STEP 7 -- Tell the operator exactly what to put in .env.
# ---------------------------------------------------------------------------
print_env_instructions() {
    printf '\n'
    printf '================================================================\n'
    printf ' STEP 7: environment variables the operator must set in .env\n'
    printf '================================================================\n'
    printf '\n'

    printf -- '-- automatic memory (LangMem) ------------------------------------\n'
    printf -- 'CHARACTER_MEMORY_AUTOMATIC_PYTHON=%s/automatic-memory/bin/python\n' "$PREFIX"
    printf '  Windows dev machine had:\n'
    printf '    <repo>/data/runtime/automatic-memory/langmem-48e3c11/.venv/Scripts/python.exe\n'
    printf '  Linux server must have:\n'
    printf '    %s/automatic-memory/bin/python\n' "$PREFIX"
    printf '  Note: app/main throws if this is unset while automatic memory is on\n'
    printf '        (src/main.ts:3886 "CHARACTER_MEMORY_AUTOMATIC_PYTHON is required").\n'
    printf '\n'

    printf -- '-- OCR / document read (RapidOCR) --------------------------------\n'
    printf -- 'PROJECT_LG_RAPIDOCR_PYTHON=%s/document-ocr/bin/python\n' "$PREFIX"
    printf -- 'PROJECT_LG_RAPIDOCR_MODEL_DIR=%s/artifacts/post-lv2/local/ocr-runtime/models\n' "$WINDOWS_VENV_ROOT"
    printf -- 'PROJECT_LG_OCR_BACKEND=rapidocr\n'
    printf '  Windows dev machine had:\n'
    printf '    <repo>/artifacts/post-lv2/local/ocr-runtime/venv/Scripts/python.exe\n'
    printf '  Linux server must have:\n'
    printf '    %s/document-ocr/bin/python\n' "$PREFIX"
    printf '  The model dir is an ASSET, not a pip package: copy it and confirm with\n'
    printf '    node scripts/deploy/asset-manifest.mjs --verify <manifest>\n'
    printf '  The three ONNX files must match the byte counts + sha256 constants in\n'
    printf '  src/infrastructure/action/adapters/rapid-ocr-assets.ts:7-11.\n'
    printf '\n'

    printf -- '-- document read + Office generate (utility-skills venv) ----------\n'
    printf -- 'PROJECT_LG_DOC_PYTHON=%s/utility-skills/bin/python\n' "$PREFIX"
    printf -- 'PROJECT_LG_OFFICE_PYTHON=%s/utility-skills/bin/python\n' "$PREFIX"
    printf '  Consumers (2026-10-16 review section 4):\n'
    printf '    document-read.ts   DEFAULT_DOC_PYTHON  -> doc-runner.py\n'
    printf '    office-generate.ts OFFICE_PYTHON       -> office-generate.py\n'
    printf '  Both capabilities are ON by default, so this venv is REQUIRED --\n'
    printf '  without it they fail silently on the server.\n'
    printf -- 'PROJECT_LG_ARXIV_RUNTIME=%s/arxiv\n' "$PREFIX"
    printf -- 'PROJECT_LG_ARXIV_PYTHON=%s/arxiv/bin/python\n' "$PREFIX"
    printf '  (arXiv has its own venv; NOT built by this script -- TODO(verify))\n'
    printf '\n'

    printf -- '-- desktop control: LEAVE THESE UNSET ----------------------------\n'
    printf '  Do NOT set CHARACTER_DESKTOP_INSPECT_ENABLED or\n'
    printf '  Do NOT set CHARACTER_DESKTOP_OPERATE_ENABLED.\n'
    printf '  Upstream windows-mcp==0.8.7 depends on dxcam / comtypes / pywin32,\n'
    printf '  which have no Linux equivalent. There is no Linux venv to point at;\n'
    printf '  the capability stays off. This is a deliberate "never", not a TODO.\n'
    printf '\n'

    printf -- '-- embedding model path: NO ENV VAR EXISTS ------------------------\n'
    printf '  LAB_MODEL_ROOT is a hardcoded relative constant resolved against\n'
    printf '  process.cwd() (src/main.ts:8701, and\n'
    printf '  src/infrastructure/semantic/encoder-worker-entry.ts:69):\n'
    printf '      artifacts/m9.5/local/embedding-lab/models\n'
    printf '  => You CANNOT fix a wrong working directory with .env.\n'
    printf '  => Start the core FROM THE REPO ROOT (systemd WorkingDirectory=).\n'
    printf '  => The 134 MiB model must be copied there; git clone will not bring it\n'
    printf '     (artifacts/m9.5/local/ is gitignored at .gitignore:164).\n'
    printf '\n'

    printf -- '@huggingface/transformers ----------------------------------------\n'
    printf '  It is NOT declared in package.json; it exists only as an orphan under\n'
    printf '  node_modules/.pnpm. The Linux box will not have it after `pnpm install`.\n'
    printf '  Declaring it is a separate, deliberately-not-automatic change.\n'
    printf '\n'

    printf 'Verify afterwards:\n'
    printf '  node scripts/deploy/asset-manifest.mjs --verify <manifest>\n'
    printf '  %s/document-ocr/bin/python -c "import rapidocr, onnxruntime; print(1)"\n' "$PREFIX"
    printf '  %s/automatic-memory/bin/python -c "import langmem; print(1)"\n' "$PREFIX"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
    log "starting. prefix=${PREFIX}  dry-run=${DRY_RUN}"
    check_not_windows
    find_python
    check_venv_module

    if [ -n "$ONLY" ]; then
        case "$ONLY" in
            automatic-memory|document-ocr|utility-skills) ;;
            *) die "--only accepts 'automatic-memory', 'document-ocr' or 'utility-skills'" ;;
        esac
        log "building only: ${ONLY}"
        make_venv "$ONLY"
    else
        make_venv automatic-memory
        make_venv document-ocr
        # ⚠️ 2026-10-16 · 复核 §4：这一条**必须建**。
        #    document.read 与 office.generate 的解释器缺省值都指向这个 venv；
        #    少建它 ⇒ 服务器上这两个**已开启**的能力静默不可用。
        make_venv utility-skills
    fi

    report
    print_env_instructions

    if [ "$DRY_RUN" -eq 1 ]; then
        log "dry-run complete. Nothing was created."
    else
        log "done. Now apply the variables printed above to the server .env."
    fi
}

main "$@"
