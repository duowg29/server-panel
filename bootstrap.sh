#!/usr/bin/env bash
# Tạo .venv cho server-panel và cài dependencies.
# Chạy: bash bootstrap.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"
PY="${PANEL_PYTHON:-python3}"

echo "== server-panel bootstrap =="
echo "python: $("$PY" --version 2>&1)"

# venv module có mặt không?
if ! "$PY" -c 'import venv' 2>/dev/null; then
  cat <<'EOF' >&2

[LỖI] Python thiếu module `venv`.
Chạy một lần rồi bootstrap lại:

    sudo apt install -y python3.10-venv python3-pip

EOF
  exit 1
fi

if [[ ! -d "$VENV" ]]; then
  echo "-- tạo venv: $VENV"
  # --system-site-packages để thừa hưởng pyyaml của hệ thống nếu pip không cài được
  "$PY" -m venv --system-site-packages "$VENV" || {
    cat <<'EOF' >&2

[LỖI] `python3 -m venv` thất bại — thường do thiếu ensurepip.
Chạy một lần rồi bootstrap lại:

    sudo apt install -y python3.10-venv python3-pip

EOF
    exit 1
  }
fi

if [[ ! -x "$VENV/bin/pip" ]]; then
  echo "-- venv chưa có pip, thử ensurepip"
  "$VENV/bin/python" -m ensurepip --upgrade 2>/dev/null || {
    cat <<'EOF' >&2

[LỖI] venv không có pip và ensurepip không dùng được.
    sudo apt install -y python3.10-venv python3-pip

EOF
    exit 1
  }
fi

echo "-- cài dependencies"
"$VENV/bin/pip" install --upgrade pip >/dev/null
"$VENV/bin/pip" install -r "$HERE/requirements.txt"

echo "-- kiểm tra"
"$VENV/bin/python" -c "import fastapi, uvicorn, yaml, httpx; print('OK: fastapi', fastapi.__version__)"

cat <<EOF

Xong. Chạy panel:

    bash $HERE/run.sh

Rồi mở http://127.0.0.1:9199
EOF
