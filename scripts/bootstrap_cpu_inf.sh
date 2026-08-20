#!/usr/bin/env bash
# Tạo .venv-cpu-inf cho tinytalk-intent-service.
#
# VÌ SAO CẦN FILE NÀY: deploy/scripts/start_hybrid.sh và cpu_inference/server.py
# đều gọi `.venv-cpu-inf/bin/python`, nhưng deploy/scripts/bootstrap_env.sh chỉ
# tạo .venv-tinytalk và ~/tinytalk-vllm-venv — không script nào trong repo đó tạo
# .venv-cpu-inf. Đây là bản bù, dựng theo đúng layer của
# deploy/docker/hybrid/Dockerfile.intent.
#
# Chạy:  bash scripts/bootstrap_cpu_inf.sh
set -euo pipefail

ROOT="${INTENT_ROOT:-/home/nguyenhaiduong/Duong/Dev/tinytalk-intent-service}"
VENV="${ROOT}/.venv-cpu-inf"

echo "============================================================"
echo "bootstrap .venv-cpu-inf — repo: ${ROOT}"
echo "============================================================"

[[ -d "$ROOT" ]] || { echo "[LỖI] không thấy repo: $ROOT" >&2; exit 1; }

# --- chọn Python 3.12 (torch/llama-cpp build cho 3.12; khớp .venv-tinytalk) ---
PY=""
for cand in python3.12 python3; do
  if command -v "$cand" >/dev/null 2>&1; then
    if "$cand" -c 'import sys; raise SystemExit(0 if (3,12) <= sys.version_info[:2] < (3,14) else 1)' 2>/dev/null; then
      PY="$(command -v "$cand")"
      break
    fi
  fi
done

if [[ -z "$PY" ]]; then
  cat <<'EOF' >&2

[LỖI] Không tìm thấy Python 3.12.x.

Ubuntu 22.04 không có sẵn python3.12 — thêm PPA deadsnakes:

    sudo add-apt-repository -y ppa:deadsnakes/ppa
    sudo apt update
    sudo apt install -y python3.12 python3.12-venv python3.12-dev

Rồi chạy lại script này.
EOF
  exit 1
fi

echo "Dùng: $PY ($("$PY" --version 2>&1))"

if [[ -x "${VENV}/bin/python" ]] && ! "${VENV}/bin/python" \
     -c 'import sys; raise SystemExit(0 if (3,12) <= sys.version_info[:2] < (3,14) else 1)' 2>/dev/null; then
  echo "-- venv cũ sai phiên bản Python, tạo lại"
  rm -rf "$VENV"
fi

if [[ ! -x "${VENV}/bin/python" ]]; then
  echo "-- tạo venv: $VENV"
  "$PY" -m venv "$VENV"
else
  echo "-- venv đã có: $VENV"
fi

PIP="${VENV}/bin/pip"
"$PIP" install --upgrade pip

# Cài theo TỪNG LAYER giống Dockerfile.intent: nếu đứt mạng giữa chừng thì
# chạy lại không phải tải lại torch (~200MB) từ đầu.

echo
echo "-- [1/4] FastAPI + uvicorn + httpx"
"$PIP" install --retries 10 "fastapi>=0.115.0" "uvicorn[standard]>=0.32.0" "httpx>=0.28.0" \
  "pydantic>=2.0" "python-multipart>=0.0.12"

echo
echo "-- [2/4] torch (bản CPU — KHÔNG dùng bản CUDA, GPU để dành cho TinySpeech)"
"$PIP" install --retries 10 --index-url https://download.pytorch.org/whl/cpu torch

echo
echo "-- [3/4] llama-cpp-python (build CPU, tắt CUDA)"
CMAKE_ARGS="-DGGML_CUDA=OFF" "$PIP" install --retries 10 "llama-cpp-python>=0.3.0"

echo
echo "-- [4/4] sentence-transformers"
"$PIP" install --retries 10 -r "${ROOT}/deploy/docker/hybrid/requirements-cpu-inf.txt"

echo
echo "-- kiểm tra"
"${VENV}/bin/python" - <<'PYEOF'
import torch, llama_cpp, sentence_transformers, fastapi
print(f"torch                 {torch.__version__} (cuda={torch.cuda.is_available()})")
print(f"llama_cpp             ok")
print(f"sentence_transformers {sentence_transformers.__version__}")
print(f"fastapi               {fastapi.__version__}")
PYEOF

cat <<EOF

Xong: ${VENV}

Bước tiếp — cpu_inference cần 2 model:
  cd ${ROOT}
  bash scripts/download_models.sh                          # embed 0.6B
  .venv-cpu-inf/bin/python scripts/download_chat_gguf.py   # chat GGUF

Rồi bấm Start ở card "Embed + CPU Chat" trên panel.
EOF
