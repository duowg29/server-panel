#!/usr/bin/env bash
# Tạo .venv-speech cho TinySpeech (Whisper + GOP align).
#
# VÌ SAO CẦN FILE NÀY: deploy/scripts/start_hybrid.sh:29 chạy speech bằng
# `python3` TRẦN của hệ thống, tức repo giả định python hệ thống đã có sẵn
# fastapi + faster-whisper + torch CUDA. Trên máy sạch điều đó không đúng và
# speech chết ngay với ModuleNotFoundError. Dựng venv riêng, giống cách
# .venv-tinytalk và .venv-cpu-inf đang làm.
#
# Chạy:  bash scripts/bootstrap_speech.sh
set -euo pipefail

ROOT="${INTENT_ROOT:-/home/nguyenhaiduong/Duong/Dev/tinytalk-intent-service}"
VENV="${ROOT}/.venv-speech"

echo "============================================================"
echo "bootstrap .venv-speech — repo: ${ROOT}"
echo "============================================================"

[[ -d "$ROOT" ]] || { echo "[LỖI] không thấy repo: $ROOT" >&2; exit 1; }

PY=""
for cand in python3.12 python3; do
  if command -v "$cand" >/dev/null 2>&1 && \
     "$cand" -c 'import sys; raise SystemExit(0 if (3,12) <= sys.version_info[:2] < (3,14) else 1)' 2>/dev/null; then
    PY="$(command -v "$cand")"
    break
  fi
done

if [[ -z "$PY" ]]; then
  echo "[LỖI] cần Python 3.12.x — sudo add-apt-repository ppa:deadsnakes/ppa" >&2
  exit 1
fi
echo "Dùng: $PY ($("$PY" --version 2>&1))"

if [[ ! -x "${VENV}/bin/python" ]]; then
  echo "-- tạo venv: $VENV"
  "$PY" -m venv "$VENV"
else
  echo "-- venv đã có: $VENV"
fi

PIP="${VENV}/bin/pip"
"$PIP" install --upgrade pip

# Cài theo layer: đứt mạng giữa chừng chạy lại không phải tải lại torch.
echo
echo "-- [1/3] web stack"
"$PIP" install --retries 10 \
  "fastapi>=0.110.0" "uvicorn[standard]>=0.27.0" "python-multipart>=0.0.9" "numpy>=1.24.0"

echo
echo "-- [2/3] torch + torchaudio (CUDA — speech LÀ service dùng GPU)"
"$PIP" install --retries 10 "torch>=2.1.0" "torchaudio>=2.1.0"

echo
echo "-- [3/3] faster-whisper + CUDA 12 runtime cho CTranslate2"
# CTranslate2 cần cuBLAS/cuDNN của CUDA 12 kể cả khi torch build trên cu13
"$PIP" install --retries 10 \
  "faster-whisper>=1.0.0" \
  "nvidia-cublas-cu12>=12.0.0" "nvidia-cuda-runtime-cu12>=12.0.0" "nvidia-cudnn-cu12>=9.0.0"

echo
echo "-- kiểm tra"
"${VENV}/bin/python" - <<'PYEOF'
import torch, faster_whisper, fastapi
print(f"torch          {torch.__version__} (cuda={torch.cuda.is_available()})")
if torch.cuda.is_available():
    print(f"gpu            {torch.cuda.get_device_name(0)}")
print(f"faster_whisper ok")
print(f"fastapi        {fastapi.__version__}")
PYEOF

cat <<EOF

Xong: ${VENV}

Lần Start đầu tiên, TinySpeech sẽ tải Whisper large-v3 (~3GB) về
~/.cache/huggingface — chờ hơi lâu, xem tiến trình ở khung log speech.
EOF
