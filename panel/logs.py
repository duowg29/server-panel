"""Đọc log: backfill N dòng cuối + tail -F async.

Viết bằng Python thay vì spawn `tail -F` để cancel gọn và không rò process.
Một LogTailer cho mỗi FILE, dùng chung cho mọi subscriber (pane trong trang +
cửa sổ pop-out = một reader duy nhất).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from pathlib import Path

log = logging.getLogger("panel.logs")

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07")
#: token lỡ echo vào log thì không đẩy ra trình duyệt
SECRET_RE = re.compile(
    r"(?i)((?:authtoken|api[-_ ]?key|token|secret|password|bearer)\s*[:=]\s*)(\S{6,})"
)

POLL_MS = 250
CHUNK = 256 * 1024
QUEUE_MAX = 2000


def clean(line: str) -> str:
    line = ANSI_RE.sub("", line)
    line = SECRET_RE.sub(r"\1••••redacted••••", line)
    return line.rstrip("\r\n")


def backfill(path: str | Path, lines: int = 500) -> list[str]:
    """Đọc ngược N dòng cuối bằng seek theo khối — chịu được file rất lớn."""
    p = Path(path)
    if not p.exists():
        return []
    try:
        size = p.stat().st_size
        with p.open("rb") as f:
            block = 64 * 1024
            data = b""
            pos = size
            while pos > 0 and data.count(b"\n") <= lines:
                step = min(block, pos)
                pos -= step
                f.seek(pos)
                data = f.read(step) + data
        text = data.decode("utf-8", "replace")
        out = text.splitlines()[-lines:]
        return [clean(x) for x in out]
    except OSError as e:
        return [f"[panel] không đọc được {p}: {e}"]


class LogTailer:
    """Theo dõi một file, fan-out cho nhiều subscriber."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._subs: set[asyncio.Queue[str]] = set()
        self._task: asyncio.Task | None = None

    def subscribe(self) -> asyncio.Queue[str]:
        q: asyncio.Queue[str] = asyncio.Queue(maxsize=QUEUE_MAX)
        self._subs.add(q)
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())
        return q

    def unsubscribe(self, q: asyncio.Queue[str]) -> None:
        self._subs.discard(q)
        if not self._subs and self._task is not None:
            self._task.cancel()
            self._task = None

    def _emit(self, line: str) -> None:
        for q in list(self._subs):
            if q.full():
                # bỏ dòng cũ nhất, báo cho client biết đã mất dòng
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait("--- panel: log quá nhanh, đã bỏ bớt dòng cũ ---")
                except asyncio.QueueFull:
                    continue
            try:
                q.put_nowait(line)
            except asyncio.QueueFull:
                pass

    async def _run(self) -> None:
        offset = 0
        inode: tuple[int, int] | None = None
        buf = b""
        #: chỉ lần stat ĐẦU TIÊN mới được nhảy tới cuối (phần cũ do backfill lo).
        #: File xuất hiện muộn hơn phải đọc từ đầu, nếu không sẽ mất sạch nội dung.
        first_stat = True

        while True:
            try:
                st = os.stat(self.path)
            except FileNotFoundError:
                # File chưa tồn tại: cứ chờ. Cho phép mở pane TRƯỚC khi start service.
                first_stat = False
                await asyncio.sleep(POLL_MS / 1000)
                inode, offset, buf = None, 0, b""
                continue
            except OSError as e:
                self._emit(f"--- panel: stat lỗi: {e} ---")
                await asyncio.sleep(1.0)
                continue

            key = (st.st_dev, st.st_ino)
            if inode is None:
                inode = key
                offset = st.st_size if first_stat else 0
                first_stat = False
            elif key != inode:
                self._emit("--- log rotated ---")
                inode, offset, buf = key, 0, b""
            elif st.st_size < offset:
                # bị truncate (start_hybrid_ngrok.sh làm `: > log`)
                self._emit("--- log truncated ---")
                offset, buf = 0, b""

            if st.st_size > offset:
                try:
                    with self.path.open("rb") as f:
                        f.seek(offset)
                        data = f.read(min(CHUNK, st.st_size - offset))
                    offset += len(data)
                    buf += data
                    *complete, buf = buf.split(b"\n")
                    for raw in complete:
                        self._emit(clean(raw.decode("utf-8", "replace")))
                except OSError as e:
                    self._emit(f"--- panel: đọc lỗi: {e} ---")

            await asyncio.sleep(POLL_MS / 1000)


class LogRegistry:
    """Giữ một LogTailer cho mỗi đường dẫn."""

    def __init__(self) -> None:
        self._tailers: dict[str, LogTailer] = {}

    def tailer(self, path: str | Path) -> LogTailer:
        key = str(Path(path))
        t = self._tailers.get(key)
        if t is None:
            t = LogTailer(key)
            self._tailers[key] = t
        return t

    def shutdown(self) -> None:
        for t in self._tailers.values():
            if t._task is not None:
                t._task.cancel()
        self._tailers.clear()
