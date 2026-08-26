"""Thu thập số liệu.

Không service nào có /metrics, nên panel tự lấy:
  - request: parse dòng access của uvicorn trong log file
  - wav   : đếm request trúng các path xử lý audio

VRAM KHÔNG lấy ở đây. `Sampler` đã gọi nvidia-smi mỗi 2s và lấy đủ 12 trường;
file này từng gọi thêm một lần nữa với 5 trường, tức là fork nvidia-smi hai lần
song song mãi mãi. `gpu_series()` giờ đọc lại từ SeriesStore để `/api/metrics`
không đổi hình dạng trả về.

Lưu ý về độ chính xác: dòng access của uvicorn KHÔNG có timestamp, nên event
được đóng dấu lúc panel đọc được. Sai số dưới ~1s — đủ cho dashboard, KHÔNG
dùng để đo latency.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

from .config import Config

log = logging.getLogger("panel.metrics")

LOG_INTERVAL_S = 1.0
RETENTION_S = 600.0
#: ô nhỏ hơn ngần này thì đồ thị chỉ còn là nhiễu lấy mẫu
MIN_BUCKET_S = 5.0

#: INFO:     127.0.0.1:57916 - "GET /health HTTP/1.1" 200 OK
ACCESS_RE = re.compile(
    r'(?P<ip>\d+\.\d+\.\d+\.\d+):(?P<sport>\d+)\s+-\s+"'
    r'(?P<method>[A-Z]+)\s+(?P<path>\S+)\s+HTTP/[\d.]+"\s+(?P<status>\d{3})'
)

#: probe của chính panel — loại khỏi requests/min, đếm riêng
DEFAULT_IGNORE = ("/health", "/gateway/health")


@dataclass
class RequestEvent:
    ts: float
    svc_id: str
    path: str
    status: int
    is_wav: bool
    is_probe: bool


class MetricsCollector:
    def __init__(self, cfg: Config, store=None) -> None:
        self.cfg = cfg
        #: SeriesStore — nguồn duy nhất của số liệu GPU (Sampler đẩy vào)
        self.store = store
        self.events: deque[RequestEvent] = deque(maxlen=50000)
        self.wav_total = 0
        self._offsets: dict[str, int] = {}
        self._inodes: dict[str, tuple[int, int]] = {}
        self._bufs: dict[str, bytes] = {}
        self.started_at = time.time()

    def rebind(self, cfg: Config) -> None:
        self.cfg = cfg

    @property
    def gpu_error(self) -> str | None:
        """Lỗi nvidia-smi. Sampler là nơi duy nhất thật sự gọi nvidia-smi; nó
        soi lỗi vào `store.meta` để chỗ khác đọc mà không cần tham chiếu ngược."""
        return self.store.meta.get("gpu_error") if self.store else None

    # ── Access log ────────────────────────────────────────────────────
    async def run_logs(self) -> None:
        while True:
            try:
                for svc in self.cfg.services.values():
                    if svc.log:
                        self._scan(svc.id, svc.log, svc.log_metrics)
                self._trim()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("log scan lỗi")
            await asyncio.sleep(LOG_INTERVAL_S)

    def _scan(self, svc_id: str, path: str, log_metrics: dict) -> None:
        p = Path(path)
        try:
            st = p.stat()
        except OSError:
            return

        key = (st.st_dev, st.st_ino)
        prev_inode = self._inodes.get(path)
        if prev_inode is None:
            # Lần đầu: nhảy tới CUỐI file. Access line không có timestamp nên
            # không thể backfill đúng giờ — chart bắt đầu trống rồi đầy dần.
            self._inodes[path] = key
            self._offsets[path] = st.st_size
            return
        if key != prev_inode:
            self._inodes[path] = key
            self._offsets[path] = 0
            self._bufs[path] = b""
        elif st.st_size < self._offsets.get(path, 0):
            self._offsets[path] = 0
            self._bufs[path] = b""

        offset = self._offsets.get(path, 0)
        if st.st_size <= offset:
            return
        try:
            with p.open("rb") as f:
                f.seek(offset)
                data = f.read(min(1024 * 1024, st.st_size - offset))
        except OSError:
            return
        self._offsets[path] = offset + len(data)

        buf = self._bufs.get(path, b"") + data
        *lines, rest = buf.split(b"\n")
        self._bufs[path] = rest

        wav_paths = tuple(log_metrics.get("wav_paths") or ())
        ignore = tuple(log_metrics.get("ignore_paths") or DEFAULT_IGNORE)
        custom = log_metrics.get("regex")
        rx = re.compile(custom) if custom else ACCESS_RE

        now = time.time()
        for raw in lines:
            line = raw.decode("utf-8", "replace")
            m = rx.search(line)
            if not m:
                continue
            gd = m.groupdict()
            req_path = gd.get("path", "")
            try:
                status = int(gd.get("status", 0))
            except ValueError:
                status = 0
            is_wav = bool(wav_paths) and req_path.startswith(wav_paths)
            is_probe = req_path in ignore
            if is_wav:
                self.wav_total += 1
            self.events.append(RequestEvent(
                ts=now, svc_id=svc_id, path=req_path,
                status=status, is_wav=is_wav, is_probe=is_probe,
            ))

    def _trim(self) -> None:
        cutoff = time.time() - RETENTION_S
        while self.events and self.events[0].ts < cutoff:
            self.events.popleft()

    # ── Series ────────────────────────────────────────────────────────
    def series(self, window_s: float = 300.0, buckets: int = 60) -> dict:
        now = time.time()
        start = now - window_s
        # Sàn 5s: tải thật ~0.6 req/giây, chia ô 1 giây thì mỗi ô hoặc 0 hoặc 1
        # → đồ thị nhảy 0↔120 răng cưa, trông như tải bùng nổ trong khi không có.
        bucket_s = max(window_s / buckets, MIN_BUCKET_S)
        buckets = max(2, int(round(window_s / bucket_s)))

        counts = [0] * buckets
        errors = [0] * buckets
        by_service: dict[str, int] = {}
        wav_window = 0
        probes = 0
        total = 0

        for ev in self.events:
            if ev.ts < start:
                continue
            if ev.is_probe:
                probes += 1
                continue
            idx = min(int((ev.ts - start) / bucket_s), buckets - 1)
            counts[idx] += 1
            total += 1
            if ev.status >= 500:
                errors[idx] += 1
            by_service[ev.svc_id] = by_service.get(ev.svc_id, 0) + 1
            if ev.is_wav:
                wav_window += 1

        scale = 60.0 / bucket_s
        return {
            "window_s": window_s,
            "bucket_s": bucket_s,
            "requests_per_min": [round(c * scale, 1) for c in counts],
            "errors_per_min": [round(c * scale, 1) for c in errors],
            "by_service": sorted(by_service.items(), key=lambda kv: -kv[1]),
            "total_in_window": total,
            "probes_in_window": probes,
            "wav_in_window": wav_window,
            "wav_total": self.wav_total,
            "gpu": self.gpu_series(),
            "gpu_error": self.gpu_error,
            "uptime_s": now - self.started_at,
        }

    def gpu_series(self, points: int = 60) -> list[dict]:
        """Dựng lại từ SeriesStore — giữ nguyên hình dạng cũ cho /api/metrics.

        Sampler đẩy `gpu.<i>.mem_used_mb` / `gpu.<i>.util` mỗi 2s; tổng dung
        lượng và tên card nằm ở `store.meta` vì chúng không đổi.
        """
        if self.store is None:
            return []
        idxs = sorted({
            int(n.split(".")[1])
            for n in self.store.names()
            if n.startswith("gpu.") and n.split(".")[1].isdigit()
        })
        out = []
        for idx in idxs:
            used = [v for _, v in self.store.raw(f"gpu.{idx}.mem_used_mb")[-points:]
                    if v is not None]
            util = [v for _, v in self.store.raw(f"gpu.{idx}.util")[-points:]
                    if v is not None]
            if not used:
                continue
            total = self.store.meta.get("gpu_total_mb") or 0
            out.append({
                "index": idx,
                "name": self.store.meta.get("gpu_name", "GPU"),
                "used_mb": round(used[-1]),
                "total_mb": round(total),
                "util_pct": round(util[-1]) if util else 0,
                "used_series": [round(v) for v in used],
                "util_series": [round(v) for v in util],
            })
        return out
