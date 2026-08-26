"""Kho time-series trong RAM cho tab biểu đồ.

Ba quyết định định hình file này:

1. **Lưu mẫu thô kèm timestamp, gộp bucket lúc ĐỌC.** Mỗi nguồn có nhịp riêng
   (/proc 2s, nvidia-smi compute-apps 6s, ngrok 10s, health probe có backoff
   15s, load test bất định). Gộp lúc ghi là quyết định quá sớm — không đổi được
   cửa sổ thời gian ở UI nữa.

2. **`None` là KHÔNG CÓ DỮ LIỆU, khác hẳn 0.** Service unreachable mà đẩy 0 là
   nói dối: 0ms latency nghĩa là "nhanh vô hạn". Đường trên chart phải ĐỨT
   quãng ở đó.

3. **Bucket căn theo mốc tuyệt đối**, không phải `now - window`. Để trôi tự do
   thì mỗi lần fetch (2s) toàn bộ chart trượt ngang một chút → nhìn rung.
"""

from __future__ import annotations

import logging
import math
import time
from collections import deque
from typing import Any, Iterable

log = logging.getLogger("panel.series")

#: giữ 10 phút
RETENTION_S = 600.0
#: trần điểm mỗi series (2s/mẫu × 600s = 300; để dư cho nguồn nhanh hơn)
MAX_POINTS = 1200
#: chặn series rác phình vô hạn
MAX_SERIES = 300

Point = tuple[float, float | None]


def _p(values: list[float], q: float) -> float:
    """Phân vị theo nội suy tuyến tính."""
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    pos = q * (len(s) - 1)
    lo = math.floor(pos)
    hi = math.ceil(pos)
    if lo == hi:
        return s[lo]
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


#: cách gộp nhiều mẫu trong cùng một bucket
AGGS = {
    "last": lambda v: v[-1],
    "first": lambda v: v[0],
    "mean": lambda v: sum(v) / len(v),
    "max": lambda v: max(v),
    "min": lambda v: min(v),
    "sum": lambda v: sum(v),
    "p95": lambda v: _p(v, 0.95),
    "p50": lambda v: _p(v, 0.50),
}

#: agg mặc định suy từ tiền tố tên — khớp dài nhất thắng
DEFAULT_AGG = {
    "host.cpu": "mean",
    "proc.": "mean",
    "gpu.": "mean",
    "gpuproc.": "last",
    "probe.": "max",      # spike latency mới đáng chú ý, đừng làm mượt mất
    "svc.": "max",
    "ngrok.p": "max",
    "ngrok.": "last",
    "load.": "p95",
    # mỗi mẫu req.* ĐÃ LÀ tốc độ (lần/phút) → gộp bằng trung bình.
    # "sum" sẽ nhân đôi khi một ô chứa nhiều mẫu.
    "req.": "mean",
    # state.* là mã severity (xem config.SEVERITY): gộp phải lấy XẤU NHẤT.
    # Một ô 30 phút có 10 giây OFFLINE thì cả ô đó là OFFLINE — lấy trung bình
    # sẽ làm phẳng mất đúng thứ đang đi tìm.
    "state.": "max",
}


def agg_for(name: str) -> str:
    best = ""
    for prefix in DEFAULT_AGG:
        if name.startswith(prefix) and len(prefix) > len(best):
            best = prefix
    return DEFAULT_AGG.get(best, "last")


class SeriesStore:
    def __init__(self, retention_s: float = RETENTION_S) -> None:
        self.retention_s = retention_s
        self._data: dict[str, deque[Point]] = {}
        #: số series bị từ chối vì chạm MAX_SERIES — im lặng bỏ là mất dữ liệu
        #: mà không ai biết, nên phải đếm và nói ra
        self.dropped: set[str] = set()
        #: thứ KHÔNG phải series: tên GPU, nproc, MemTotal, pid theo service,
        #: mốc các lần bắn tải…
        self.meta: dict[str, Any] = {}

    # ── ghi ───────────────────────────────────────────────────────────
    def push(self, name: str, value: float | None, ts: float | None = None) -> None:
        ts = time.time() if ts is None else ts
        dq = self._data.get(name)
        if dq is None:
            if len(self._data) >= MAX_SERIES:
                if name not in self.dropped:
                    self.dropped.add(name)
                    log.warning(
                        "chạm trần %d series — BỎ %r và mọi series mới sau đó. "
                        "Thêm service thì nâng MAX_SERIES.", MAX_SERIES, name,
                    )
                return
            dq = self._data[name] = deque(maxlen=MAX_POINTS)
        dq.append((ts, None if value is None else float(value)))

    def push_many(self, mapping: dict[str, float | None], ts: float | None = None) -> None:
        ts = time.time() if ts is None else ts
        for k, v in mapping.items():
            self.push(k, v, ts)

    # ── đọc ───────────────────────────────────────────────────────────
    def names(self) -> list[str]:
        return sorted(self._data)

    def last(self, name: str) -> float | None:
        dq = self._data.get(name)
        if not dq:
            return None
        for ts, v in reversed(dq):
            if v is not None:
                return v
        return None

    def last_at(self, name: str) -> float | None:
        dq = self._data.get(name)
        return dq[-1][0] if dq else None

    def raw(self, name: str) -> list[Point]:
        """Mẫu thô của một series. Dùng khi cần tự gộp kiểu khác (xem archive.py)."""
        dq = self._data.get(name)
        return list(dq) if dq else []

    def resample(
        self,
        names: Iterable[str] | None = None,
        window_s: float = 600.0,
        buckets: int = 120,
        agg: str | None = None,
        now: float | None = None,
    ) -> dict[str, Any]:
        """Gộp về `buckets` ô đều nhau. Ô không có mẫu → None (khoảng trống)."""
        now = time.time() if now is None else now
        buckets = max(2, min(int(buckets), 600))
        bucket_s = max(window_s / buckets, 0.5)
        # căn mốc tuyệt đối — nếu không chart sẽ trượt ngang mỗi lần fetch
        end = math.floor(now / bucket_s) * bucket_s
        t0 = end - bucket_s * (buckets - 1)

        wanted = list(self._data) if names is None else [n for n in names if n in self._data]
        out: dict[str, list[float | None]] = {}

        for name in wanted:
            fn = AGGS.get(agg or agg_for(name), AGGS["last"])
            slots: list[list[float]] = [[] for _ in range(buckets)]
            for ts, v in self._data[name]:
                if v is None or ts < t0:
                    continue
                idx = int((ts - t0) / bucket_s)
                if 0 <= idx < buckets:
                    slots[idx].append(v)
            out[name] = [round(fn(s), 3) if s else None for s in slots]

        return {"t0": t0, "bucket_s": bucket_s, "n": buckets, "series": out}

    # ── dọn ───────────────────────────────────────────────────────────
    def trim(self, now: float | None = None) -> int:
        """Bỏ điểm quá hạn và xoá HẲN series đã chết. Trả về số series đã xoá."""
        now = time.time() if now is None else now
        cutoff = now - self.retention_s
        dead = []
        for name, dq in self._data.items():
            while dq and dq[0][0] < cutoff:
                dq.popleft()
            if not dq:
                dead.append(name)
        for name in dead:
            del self._data[name]
        return len(dead)

    def stats(self) -> dict[str, int]:
        return {
            "series": len(self._data),
            "points": sum(len(d) for d in self._data.values()),
            "max_series": MAX_SERIES,
            "dropped": len(self.dropped),
        }
