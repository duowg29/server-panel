"""Thu thập số liệu.

Không service nào có /metrics, nên panel tự lấy:
  - VRAM  : nvidia-smi mỗi 2s
  - request: parse dòng access của uvicorn trong log file
  - wav   : đếm request trúng các path xử lý audio

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

GPU_INTERVAL_S = 2.0
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
class GpuSample:
    ts: float
    index: int
    name: str
    used_mb: int
    total_mb: int
    util_pct: int


@dataclass
class RequestEvent:
    ts: float
    svc_id: str
    path: str
    status: int
    is_wav: bool
    is_probe: bool


class MetricsCollector:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.gpu: deque[GpuSample] = deque(maxlen=2000)
        self.events: deque[RequestEvent] = deque(maxlen=50000)
        self.gpu_error: str | None = None
        self.wav_total = 0
        self._offsets: dict[str, int] = {}
        self._inodes: dict[str, tuple[int, int]] = {}
        self._bufs: dict[str, bytes] = {}
        self.started_at = time.time()

    def rebind(self, cfg: Config) -> None:
        self.cfg = cfg

    # ── GPU ───────────────────────────────────────────────────────────
    async def run_gpu(self) -> None:
        while True:
            try:
                await self._sample_gpu()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("gpu sample lỗi")
            await asyncio.sleep(GPU_INTERVAL_S)

    async def _sample_gpu(self) -> None:
        try:
            proc = await asyncio.create_subprocess_exec(
                "nvidia-smi",
                "--query-gpu=index,name,memory.used,memory.total,utilization.gpu",
                "--format=csv,noheader,nounits",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            out, err = await asyncio.wait_for(proc.communicate(), timeout=3.0)
        except FileNotFoundError:
            self.gpu_error = "nvidia-smi không có"
            return
        except (asyncio.TimeoutError, OSError) as e:
            self.gpu_error = f"nvidia-smi: {type(e).__name__}"
            return

        if proc.returncode != 0:
            self.gpu_error = (err.decode("utf-8", "replace").strip() or "nvidia-smi lỗi")[:120]
            return

        self.gpu_error = None
        now = time.time()
        for line in out.decode("utf-8", "replace").splitlines():
            parts = [p.strip() for p in line.split(",")]
            if len(parts) < 5:
                continue
            try:
                self.gpu.append(GpuSample(
                    ts=now, index=int(parts[0]), name=parts[1],
                    used_mb=int(parts[2]), total_mb=int(parts[3]), util_pct=int(parts[4]),
                ))
            except ValueError:
                continue
        self._trim()

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
        while self.gpu and self.gpu[0].ts < cutoff:
            self.gpu.popleft()
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
        by_idx: dict[int, list[GpuSample]] = {}
        for s in self.gpu:
            by_idx.setdefault(s.index, []).append(s)
        out = []
        for idx, samples in sorted(by_idx.items()):
            tail = samples[-points:]
            last = tail[-1]
            out.append({
                "index": idx,
                "name": last.name,
                "used_mb": last.used_mb,
                "total_mb": last.total_mb,
                "util_pct": last.util_pct,
                "used_series": [s.used_mb for s in tail],
                "util_series": [s.util_pct for s in tail],
            })
        return out
