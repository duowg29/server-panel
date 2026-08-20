#!/usr/bin/env bash
# Chạy Server Panel.
#
# BẢO MẬT: bind 127.0.0.1 — KHÔNG đổi thành 0.0.0.0.
# Panel chạy shell tuỳ ý theo services.yaml; mở port này ra mạng
# tương đương phát remote shell không mật khẩu.
# Muốn truy cập từ máy khác: ssh -L 9199:127.0.0.1:9199 <host>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${PANEL_PORT:-9199}"

if [[ ! -x "$HERE/.venv/bin/python" ]]; then
  echo "[LỖI] Chưa có .venv — chạy: bash $HERE/bootstrap.sh" >&2
  exit 1
fi

# Báo rõ khi port đã có người giữ — uvicorn chỉ ném Errno 98 khó đọc
if ss -tln 2>/dev/null | grep -q "127.0.0.1:${PORT}\b"; then
  owner="$(ss -tlnp 2>/dev/null | grep "127.0.0.1:${PORT}\b" | grep -oP 'pid=\K[0-9]+' | head -1)"
  echo "[!] Panel đã chạy sẵn ở http://127.0.0.1:${PORT}${owner:+ (pid ${owner})}"
  echo "    Mở trình duyệt là dùng được luôn."
  echo "    Muốn chạy lại trong terminal này thì dừng cái cũ trước:"
  echo "        kill ${owner:-<pid>}"
  exit 1
fi

cd "$HERE"
exec .venv/bin/python -m uvicorn panel.main:app \
  --host 127.0.0.1 --port "$PORT" \
  --log-level info --no-access-log
