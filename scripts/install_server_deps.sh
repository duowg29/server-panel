#!/usr/bin/env bash
# Cài phụ thuộc cho tinytalk-intent-service — ĐÚNG THEO cách repo đó tự quy định.
#
# KHÔNG sửa file nào trong repo server. Sau khi chạy script này, chạy tay
# `bash deploy/scripts/start_hybrid.sh` cũng lên bình thường, không cần panel.
#
# Repo dùng python nào cho service nào (đọc từ deploy/scripts/start_hybrid.sh):
#     speech  :8000  → python3 HỆ THỐNG        (dòng 29)
#     cpu_inf :8001  → .venv-cpu-inf           (dòng 67)
#     intent  :8088  → .venv-tinytalk          (dòng 83)
#     gateway :8090  → .venv-tinytalk          (dòng 112)
#
# .venv-tinytalk đã có deploy/scripts/bootstrap_env.sh của repo lo.
# Script này lo 2 thứ còn lại — repo gọi tới nhưng không có gì tạo ra chúng.
#
# Chạy:  bash scripts/install_server_deps.sh [speech|cpu-inf|all]
set -euo pipefail

ROOT="${INTENT_ROOT:-/home/nguyenhaiduong/Duong/Dev/tinytalk-intent-service}"
WHAT="${1:-all}"

[[ -d "$ROOT" ]] || { echo "[LỖI] không thấy repo: $ROOT" >&2; exit 1; }
cd "$ROOT"

hr() { echo "------------------------------------------------------------"; }

# ── speech: cài vào python3 HỆ THỐNG ────────────────────────────────────
# start_hybrid.sh:29 gọi `python3` trần, nên deps phải nằm ở đó thì chạy tay
# mới lên. Dùng --user để không đụng vào site-packages của hệ thống.
install_speech() {
  hr; echo "speech → python3 hệ thống ($(python3 --version 2>&1))"; hr

  if python3 -c 'import fastapi, faster_whisper, torch' 2>/dev/null; then
    echo "Đã đủ deps, bỏ qua."
    return 0
  fi

  python3 -m pip install --user --upgrade pip
  python3 -m pip install --user --retries 10 -r speech_service/requirements.txt

  python3 - <<'PY'
import torch, faster_whisper, fastapi
print(f"torch          {torch.__version__} (cuda={torch.cuda.is_available()})")
if torch.cuda.is_available():
    print(f"gpu            {torch.cuda.get_device_name(0)}")
print(f"faster_whisper ok")
print(f"fastapi        {fastapi.__version__}")
PY
}

# ── cpu_inf: .venv-cpu-inf ──────────────────────────────────────────────
# Repo gọi .venv-cpu-inf/bin/python ở start_hybrid.sh:67 và
# cpu_inference/server.py, nhưng bootstrap_env.sh chỉ tạo .venv-tinytalk và
# ~/tinytalk-vllm-venv. Dựng theo đúng layer của
# deploy/docker/hybrid/Dockerfile.intent.
install_cpu_inf() {
  local venv="${ROOT}/.venv-cpu-inf"
  hr; echo "cpu_inference → ${venv}"; hr

  if [[ -x "${venv}/bin/python" ]] && \
     "${venv}/bin/python" -c 'import torch, llama_cpp, sentence_transformers' 2>/dev/null; then
    echo "Đã đủ deps, bỏ qua."
    return 0
  fi

  local py=""
  for c in python3.12 python3; do
    if command -v "$c" >/dev/null 2>&1 && \
       "$c" -c 'import sys; raise SystemExit(0 if (3,12) <= sys.version_info[:2] < (3,14) else 1)' 2>/dev/null; then
      py="$(command -v "$c")"; break
    fi
  done
  [[ -n "$py" ]] || {
    echo "[LỖI] cần Python 3.12 — sudo add-apt-repository ppa:deadsnakes/ppa" >&2
    exit 1
  }

  [[ -x "${venv}/bin/python" ]] || "$py" -m venv "$venv"
  local pip="${venv}/bin/pip"
  "$pip" install --upgrade pip

  # từng layer riêng: đứt mạng giữa chừng chạy lại không phải tải lại torch
  "$pip" install --retries 10 \
    "fastapi>=0.115.0" "uvicorn[standard]>=0.32.0" "httpx>=0.28.0" "pydantic>=2.0"
  "$pip" install --retries 10 --index-url https://download.pytorch.org/whl/cpu torch
  CMAKE_ARGS="-DGGML_CUDA=OFF" "$pip" install --retries 10 "llama-cpp-python>=0.3.0"
  "$pip" install --retries 10 -r deploy/docker/hybrid/requirements-cpu-inf.txt

  "${venv}/bin/python" - <<'PY'
import torch, llama_cpp, sentence_transformers
print(f"torch                 {torch.__version__} (cuda={torch.cuda.is_available()})")
print(f"llama_cpp             ok")
print(f"sentence_transformers {sentence_transformers.__version__}")
PY
}

case "$WHAT" in
  speech)  install_speech ;;
  cpu-inf) install_cpu_inf ;;
  all)     install_cpu_inf; install_speech ;;
  *) echo "Dùng: $0 [speech|cpu-inf|all]" >&2; exit 1 ;;
esac

hr
echo "Xong. Kiểm tra chạy độc lập (không cần panel):"
echo "    cd ${ROOT} && bash deploy/scripts/start_hybrid.sh"
