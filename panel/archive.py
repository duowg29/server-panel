"""Lưu time-series xuống đĩa, để câu hỏi "chiều nay lúc 3h vì sao chậm" trả lời được.

`SeriesStore` cố ý chỉ giữ 10 phút trong RAM: nó phục vụ biểu đồ đang chạy, nhịp
2s, và phải rẻ. Nhưng đúng lúc cần nhất — sau khi sự cố đã xảy ra — thì dữ liệu
lại vừa trôi mất, và restart panel là mất sạch.

Nên tách làm hai tầng, đừng cố nhét cả hai vào một chỗ:

  RAM  (SeriesStore)  2s/mẫu, 10 phút   — biểu đồ thời gian thực
  ĐĨA  (SeriesArchive) 30s/ô, nhiều ngày — xem lại chuyện đã rồi

Ô 30s là chỗ đứng giữa: đủ mịn để thấy một spike kéo dài nửa phút, mà 72 giờ ×
300 series vẫn chỉ khoảng vài chục MB.

Gộp bằng ĐÚNG hàm mà `series.agg_for` chọn cho tên đó — probe latency lấy max
(spike mới đáng chú ý), CPU lấy mean. Lưu sẵn bằng mean hết là làm phẳng mất
đúng thứ đang đi tìm.
"""

from __future__ import annotations

import logging
import math
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from .series import AGGS, SeriesStore, agg_for

log = logging.getLogger("panel.archive")

#: độ mịn khi lưu xuống đĩa
BUCKET_S = 30.0
#: giữ bao lâu
RETENTION_S = 72 * 3600.0
#: dọn rác mỗi giờ
VACUUM_EVERY_S = 3600.0


class SeriesArchive:
    def __init__(
        self,
        path: Path,
        bucket_s: float = BUCKET_S,
        retention_s: float = RETENTION_S,
    ) -> None:
        self.path = path
        self.bucket_s = bucket_s
        self.retention_s = retention_s
        self._last_flush = 0.0
        self._last_vacuum = 0.0
        # Sampler chạy trong event loop, còn sqlite thì blocking. Giữ một
        # connection + lock thay vì mở/đóng liên tục; ghi 30s/lần nên rẻ.
        self._lock = threading.Lock()
        self.db: sqlite3.Connection | None = None
        self.error: str | None = None
        self._open()

    def _open(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.db = sqlite3.connect(self.path, check_same_thread=False)
            self.db.execute("PRAGMA journal_mode=WAL")
            # Mất vài giây cuối khi mất điện là chấp nhận được; đổi lại không
            # fsync mỗi lần ghi.
            self.db.execute("PRAGMA synchronous=NORMAL")
            self.db.execute(
                "CREATE TABLE IF NOT EXISTS points ("
                " name TEXT NOT NULL, ts INTEGER NOT NULL, value REAL,"
                " PRIMARY KEY (name, ts)) WITHOUT ROWID"
            )
            self.db.execute("CREATE INDEX IF NOT EXISTS points_ts ON points (ts)")
            self.db.commit()
        except sqlite3.Error as e:
            self.error = str(e)
            self.db = None
            log.warning("không mở được %s: %s — chỉ còn dữ liệu trong RAM", self.path, e)

    # ── ghi ───────────────────────────────────────────────────────────
    def flush(self, store: SeriesStore, now: float | None = None) -> int:
        """Gộp phần RAM chưa lưu thành ô 30s rồi ghi xuống. Trả về số ô đã ghi."""
        if self.db is None:
            return 0
        now = time.time() if now is None else now

        # Chỉ ghi những ô đã ĐÓNG. Ô đang chạy dở mà ghi thì lần sau phải ghi
        # đè bằng số khác — đúng nhưng tốn, và làm meta "điểm cuối" nhấp nháy.
        end = math.floor(now / self.bucket_s) * self.bucket_s
        start = self._last_flush or (end - self.bucket_s * 4)
        if end <= start:
            return 0

        rows: list[tuple[str, int, float | None]] = []
        for name in store.names():
            fn = AGGS.get(agg_for(name), AGGS["last"])
            slots: dict[int, list[float]] = {}
            for ts, v in store.raw(name):
                if v is None or ts < start or ts >= end:
                    continue
                slots.setdefault(int(ts // self.bucket_s), []).append(v)
            for bucket, values in slots.items():
                rows.append((name, bucket * int(self.bucket_s), round(fn(values), 4)))

        if not rows:
            self._last_flush = end
            return 0

        try:
            with self._lock:
                self.db.executemany(
                    "INSERT OR REPLACE INTO points (name, ts, value) VALUES (?, ?, ?)", rows
                )
                self.db.commit()
        except sqlite3.Error as e:
            self.error = str(e)
            log.warning("ghi archive lỗi: %s", e)
            return 0

        self._last_flush = end
        return len(rows)

    def vacuum(self, now: float | None = None) -> int:
        if self.db is None:
            return 0
        now = time.time() if now is None else now
        if now - self._last_vacuum < VACUUM_EVERY_S:
            return 0
        self._last_vacuum = now
        try:
            with self._lock:
                cur = self.db.execute(
                    "DELETE FROM points WHERE ts < ?", (int(now - self.retention_s),)
                )
                self.db.commit()
            return cur.rowcount or 0
        except sqlite3.Error as e:
            log.warning("dọn archive lỗi: %s", e)
            return 0

    # ── đọc ───────────────────────────────────────────────────────────
    def resample(
        self,
        names: Iterable[str] | None = None,
        window_s: float = 3600.0,
        buckets: int = 120,
        now: float | None = None,
    ) -> dict[str, Any]:
        """Cùng khuôn trả về với SeriesStore.resample để UI không phải phân biệt."""
        now = time.time() if now is None else now
        buckets = max(2, min(int(buckets), 600))
        bucket_s = max(window_s / buckets, self.bucket_s)
        end = math.floor(now / bucket_s) * bucket_s
        t0 = end - bucket_s * (buckets - 1)
        empty = {"t0": t0, "bucket_s": bucket_s, "n": buckets, "series": {}}
        if self.db is None:
            return empty

        wanted = list(names) if names is not None else None
        try:
            with self._lock:
                if wanted:
                    marks = ",".join("?" * len(wanted))
                    cur = self.db.execute(
                        f"SELECT name, ts, value FROM points WHERE ts >= ? AND name IN ({marks})",
                        (int(t0), *wanted),
                    )
                else:
                    cur = self.db.execute(
                        "SELECT name, ts, value FROM points WHERE ts >= ?", (int(t0),)
                    )
                fetched = cur.fetchall()
        except sqlite3.Error as e:
            log.warning("đọc archive lỗi: %s", e)
            return empty

        slots: dict[str, list[list[float]]] = {}
        for name, ts, value in fetched:
            if value is None:
                continue
            idx = int((ts - t0) / bucket_s)
            if not 0 <= idx < buckets:
                continue
            arr = slots.get(name)
            if arr is None:
                arr = slots[name] = [[] for _ in range(buckets)]
            arr[idx].append(value)

        out: dict[str, list[float | None]] = {}
        for name, arr in slots.items():
            fn = AGGS.get(agg_for(name), AGGS["last"])
            out[name] = [round(fn(s), 3) if s else None for s in arr]

        return {"t0": t0, "bucket_s": bucket_s, "n": buckets, "series": out}

    def stats(self) -> dict[str, Any]:
        if self.db is None:
            return {"ok": False, "error": self.error}
        try:
            with self._lock:
                rows = self.db.execute(
                    "SELECT COUNT(*), COUNT(DISTINCT name), MIN(ts), MAX(ts) FROM points"
                ).fetchone()
            size = self.path.stat().st_size if self.path.exists() else 0
        except (sqlite3.Error, OSError) as e:
            return {"ok": False, "error": str(e)}
        points, series, first, last = rows
        return {
            "ok": True,
            "points": points or 0,
            "series": series or 0,
            "from": first,
            "to": last,
            "bucket_s": self.bucket_s,
            "retention_h": round(self.retention_s / 3600),
            "db_mb": round(size / 1024**2, 2),
            "path": str(self.path),
        }

    def close(self) -> None:
        if self.db is not None:
            with self._lock:
                self.db.close()
            self.db = None
