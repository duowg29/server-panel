"""Tạo tải thử để biểu đồ có số liệu.

Chạy ở BACKEND chứ không phải trình duyệt vì:
  - file wav mẫu nằm trên đĩa server
  - Intent API :8088 KHÔNG bật CORS (speech :8000 thì có), fetch từ trang panel
    sẽ bị chặn preflight
  - cần đo bằng cùng đồng hồ với health.py thì mới so sánh được

Với hồ sơ `assess`, speech trả `meta.assess_ms` — thời gian TÍNH TOÁN đo từ phía
server. Kèm wall-time panel đo, hiệu số chính là upload + xếp hàng. Đây là số
đáng giá nhất mà cả stack không chỗ nào khác cho.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger("panel.loadgen")

# Trần cứng — bắn quá tay vào Whisper large-v3 có thể đẩy GPU vào OOM
MAX_N = 50
MAX_CONCURRENCY = 4
MAX_RUN_S = 180.0
REQ_TIMEOUT_S = 60.0   # assess với large-v3 có thể mất 3-10s

# `max_conc`: trần đồng thời RIÊNG của hồ sơ.
#
# intent = 2 chứ không phải 4: pipeline intent gọi sang chat GGUF trên :8001,
# mà llama-cpp-python KHÔNG an toàn đa luồng. Trước đây bắn 2 luồng làm
# cpu_inference chết thật với
#   GGML_ASSERT(i1 >= 0 && i1 < ne1) failed  (ggml-cpu/ops.cpp:5134)
# nên hồ sơ này từng bị ép về 1. Nay cpu_inference đã có threading.Lock quanh
# create_chat_completion (commit b5fbcde) nên bắn song song không làm sập nữa --
# nhưng llama.cpp vẫn phục vụ TUẦN TỰ, bắn thêm luồng chỉ làm dài hàng đợi chứ
# không nhanh hơn. Giữ 2 để thấy được hàng đợi trên biểu đồ.
PROFILES = {
    "intent":     {"svc": "intent",  "url": "http://127.0.0.1:8088/intent",
                   "max_conc": 2,
                   "warn": "Intent gọi chat GGUF — llama.cpp phục vụ tuần tự, "
                           "thêm luồng chỉ làm dài hàng đợi chứ không nhanh hơn"},
    "transcribe": {"svc": "speech",  "url": "http://127.0.0.1:8000/transcribe",
                   "max_conc": 2},
    "assess":     {"svc": "speech",  "url": "http://127.0.0.1:8000/api/speech/assess",
                   "max_conc": 2},
    "gateway":    {"svc": "gateway", "url": "http://127.0.0.1:8090/transcribe",
                   "max_conc": 2},
}


@dataclass
class LoadResult:
    t: float
    profile: str
    ok: bool
    status: int
    wall_ms: float
    server_ms: float | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "t": self.t, "profile": self.profile, "ok": self.ok, "status": self.status,
            "wall_ms": round(self.wall_ms, 1),
            "server_ms": None if self.server_ms is None else round(self.server_ms, 1),
            "error": self.error,
        }


def _pct(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
    s = sorted(vals)
    i = min(len(s) - 1, int(q * (len(s) - 1) + 0.5))
    return round(s[i], 1)


class LoadGen:
    def __init__(self, cfg, store, poller) -> None:
        self.cfg = cfg
        self.store = store
        self.poller = poller
        self.running = False
        self.task: asyncio.Task | None = None
        self.total = 0
        self.done = 0
        self.ok = 0
        self.err = 0
        self.profile = ""
        self.results: list[LoadResult] = []
        self.note: str | None = None
        self._wav_cache: dict[str, bytes] = {}
        self._lock = asyncio.Lock()

    def rebind(self, cfg) -> None:
        self.cfg = cfg

    def _wav(self, name: str = "tone_440.wav") -> bytes:
        """Đọc MỘT LẦN rồi cache — đừng đọc lại mỗi request."""
        if name not in self._wav_cache:
            root = Path(self.cfg.defaults.get("root", ""))
            p = root / "speech_service" / "fixtures" / name
            self._wav_cache[name] = p.read_bytes()
        return self._wav_cache[name]

    def status(self) -> dict[str, Any]:
        walls = [r.wall_ms for r in self.results if r.ok]
        servers = [r.server_ms for r in self.results if r.ok and r.server_ms is not None]
        return {
            "running": self.running,
            "profile": self.profile,
            "total": self.total, "done": self.done, "ok": self.ok, "err": self.err,
            "p50_ms": _pct(walls, 0.5), "p95_ms": _pct(walls, 0.95),
            "p50_server_ms": _pct(servers, 0.5),
            "note": self.note,
            "results": [r.to_dict() for r in self.results[-200:]],
        }

    async def start(self, profile: str, n: int, concurrency: int) -> dict[str, Any]:
        if profile not in PROFILES:
            raise ValueError(f"hồ sơ không hợp lệ: {profile}")
        async with self._lock:
            if self.running:
                raise RuntimeError("đang có một lần bắn khác chạy")
            spec = PROFILES[profile]
            state = self.poller.state_of(spec["svc"])
            if state != "ONLINE":
                # bắn lúc speech đang tải model 3GB sẽ timeout hàng loạt
                raise RuntimeError(f"{spec['svc']} đang {state}, chưa bắn được")
            n = max(1, min(int(n), MAX_N))
            cap = min(MAX_CONCURRENCY, int(spec.get("max_conc", MAX_CONCURRENCY)))
            asked = max(1, int(concurrency))
            concurrency = min(asked, cap)
            self.note = spec.get("warn") if asked > cap else None
            self.running = True
            self.profile = profile
            self.total, self.done, self.ok, self.err = n, 0, 0, 0
            self.results = []
            self.task = asyncio.create_task(self._run(profile, n, concurrency))
        return {"ok": True, "profile": profile, "n": n, "concurrency": concurrency,
                "note": self.note}

    def cancel(self) -> dict[str, Any]:
        if self.task and not self.task.done():
            self.task.cancel()
            return {"ok": True, "cancelled": True}
        return {"ok": True, "cancelled": False}

    async def _run(self, profile: str, n: int, concurrency: int) -> None:
        t_start = time.time()
        sem = asyncio.Semaphore(concurrency)
        try:
            async with httpx.AsyncClient(timeout=REQ_TIMEOUT_S) as client:
                async def one() -> None:
                    async with sem:
                        if time.time() - t_start > MAX_RUN_S:
                            return
                        r = await self._fire(client, profile)
                        self.results.append(r)
                        self.done += 1
                        if r.ok:
                            self.ok += 1
                        else:
                            self.err += 1
                        self.store.push(f"load.{profile}.wall_ms", r.wall_ms, r.t)
                        if r.server_ms is not None:
                            self.store.push(f"load.{profile}.server_ms", r.server_ms, r.t)

                await asyncio.gather(*(one() for _ in range(n)), return_exceptions=True)
        except asyncio.CancelledError:
            log.info("load test bị huỷ")
        except Exception:
            log.exception("load test lỗi")
        finally:
            self.running = False
            # mốc để MỌI biểu đồ vẽ vạch dọc đối chiếu
            runs = self.store.meta.setdefault("load_runs", [])
            runs.append({
                "t0": t_start, "t1": time.time(),
                "profile": profile, "n": self.done,
            })
            del runs[:-20]

    async def _fire(self, client: httpx.AsyncClient, profile: str) -> LoadResult:
        url = PROFILES[profile]["url"]
        t0 = time.perf_counter()
        ts = time.time()
        try:
            if profile == "intent":
                r = await client.post(url, json={
                    "transcript": "mở bài học tiếp theo",
                    "current_screen": "home",
                    "current_mode": "system_command",
                })
            elif profile == "assess":
                r = await client.post(url, files={
                    "audio": ("tone_440.wav", self._wav(), "audio/wav"),
                }, data={"expected_text": "hello world"})
            else:  # transcribe | gateway
                r = await client.post(url, files={
                    "audio": ("tone_440.wav", self._wav(), "audio/wav"),
                }, data={"language": "en"})

            wall = (time.perf_counter() - t0) * 1000.0
            server_ms = None
            try:
                body = r.json()
                meta = body.get("meta") if isinstance(body, dict) else None
                if isinstance(meta, dict) and isinstance(meta.get("assess_ms"), (int, float)):
                    server_ms = float(meta["assess_ms"])
            except Exception:
                pass
            return LoadResult(
                t=ts, profile=profile, ok=r.status_code < 400,
                status=r.status_code, wall_ms=wall, server_ms=server_ms,
                error=None if r.status_code < 400 else r.text[:120],
            )
        except Exception as e:
            return LoadResult(
                t=ts, profile=profile, ok=False, status=0,
                wall_ms=(time.perf_counter() - t0) * 1000.0,
                error=f"{type(e).__name__}: {e}"[:120],
            )
