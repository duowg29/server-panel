"""Thu thập số liệu cho tab biểu đồ.

Một task duy nhất, nhịp gốc 2s, chia tần suất bằng đếm tick — tránh mỗi loại
một task riêng rồi lệch nhịp nhau.

PID lấy từ Supervisor chứ không pgrep riêng: service restart là tự đúng.

Sampler LUÔN chạy kể cả tab biểu đồ đang đóng (trừ nhánh ngrok-requests), nếu
không thì mở tab ra sẽ thấy 10 phút trống — hỏng hẳn mục đích "xem lại lúc nãy
vì sao chậm".
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import deque
from pathlib import Path
from typing import Any

import httpx

from .config import Config
from .series import SeriesStore
from .supervisor import Supervisor

log = logging.getLogger("panel.sampler")

TICK_S = 2.0
#: mỗi bao nhiêu tick thì làm việc chậm
EVERY_FD = 3          # 6s  — opendir đắt hơn read nhiều
EVERY_GPU_PROC = 3    # 6s  — VRAM theo process gần như tĩnh
EVERY_NGROK = 5       # 10s — rate1 là trung bình 1 phút
EVERY_TRIM = 5        # 10s
EVERY_DISK = 15       # 30s — statvfs rẻ nhưng dung lượng đĩa đâu có nhảy từng giây
NGROK_REQ_TICKS = 2   # 4s  — chỉ khi tab mở; buffer ngrok chỉ ~50 request
#: bao nhiêu id request nhớ để chống đếm trùng
NGROK_SEEN_MAX = 2000

#: dưới ngần này GB trống thì kêu. Một lần tải large-v3 là ~3GB, nên 10 là sát.
DISK_WARN_GB = float(os.environ.get("PANEL_DISK_WARN_GB", "10"))
#: chỉ hết cảnh báo khi đã dọn được kha khá, tránh kêu đi kêu lại quanh ngưỡng
DISK_CLEAR_GB = DISK_WARN_GB * 1.5

#: dưới ngần này GB VRAM trống thì kêu. Speech giữ ~7 GB, chat GPU ~5.7 GB trên
#: card 16 GB — còn khoảng 3 GB. Hết VRAM thì Whisper OOM giữa lúc chấm điểm,
#: mà lỗi đó hiện ra dưới dạng "assess trả 500", rất khó lần ngược về nguyên nhân.
VRAM_WARN_GB = float(os.environ.get("PANEL_VRAM_WARN_GB", "1.5"))
VRAM_CLEAR_GB = VRAM_WARN_GB * 1.6

CLK_TCK = os.sysconf("SC_CLK_TCK") or 100

GPU_FIELDS = [
    "index", "name", "memory.used", "memory.total", "memory.reserved",
    "utilization.gpu", "utilization.memory", "temperature.gpu",
    "power.draw", "power.limit", "clocks.sm", "clocks.mem",
]


def _num(s: str) -> float | None:
    """Parse một ô. `N/A`, `[N/A]`, rỗng → None.

    Parser cũ dùng `except ValueError: continue` nên bỏ CẢ DÒNG khi một cột lỗi.
    Với 12 cột thì một `[N/A]` xoá sạch mẫu GPU.
    """
    s = s.strip()
    if not s or s.startswith("[") or s in {"N/A", "n/a", "-"}:
        return None
    try:
        return float(s)
    except ValueError:
        return None


class Sampler:
    def __init__(self, cfg: Config, sup: Supervisor, store: SeriesStore,
                 metrics=None, on_alert=None) -> None:
        self.cfg = cfg
        self.sup = sup
        self.store = store
        #: MetricsCollector — nguồn event từ access log, để dẫn sang store
        self.metrics = metrics
        #: gọi khi có thứ đáng báo động: (source, name, text)
        self.on_alert = on_alert
        #: phân vùng nào đang trong trạng thái kêu thiếu chỗ
        self._disk_warned: set[str] = set()
        #: GPU nào đang trong trạng thái kêu thiếu VRAM
        self._vram_warned: set[int] = set()
        self.gpu_error: str | None = None
        #: tab biểu đồ còn mở tới lúc nào (mỗi lần /api/series được gọi thì gia hạn)
        self.detail_until = 0.0
        self._tick = 0
        self._client: httpx.AsyncClient | None = None

        # trạng thái cho phép tính delta
        self._cpu_prev: dict[str, tuple[float, float, int]] = {}   # svc -> (ts, jiffies, pid)
        self._io_prev: dict[str, tuple[float, float, float, int]] = {}
        self._ctx_prev: dict[str, tuple[float, float, int]] = {}
        self._host_cpu_prev: tuple[float, float] | None = None      # (busy, total)
        self._ngrok_count_prev: float | None = None
        #: request qua ngrok đã thấy, dedup theo id.
        #: deque + set đi đôi: set để hỏi nhanh, deque để biết id nào cũ nhất mà
        #: bỏ. Bản cũ dựng lại set từ `items` đang có — buffer ngrok chỉ ~50
        #: request nên id vừa bị bỏ sẽ được đếm lại lần sau.
        self.ngrok_requests: list[dict[str, Any]] = []
        self._ngrok_seen: set[str] = set()
        self._ngrok_seen_order: deque[str] = deque()

        self._read_static()

    def rebind(self, cfg: Config) -> None:
        self.cfg = cfg

    def note_detail_interest(self) -> None:
        """Tab biểu đồ vừa fetch → bật nhánh tốn kém trong 15s tới."""
        self.detail_until = time.time() + 15.0

    # ── hằng số máy, đọc một lần ──────────────────────────────────────
    def _read_static(self) -> None:
        try:
            self.store.meta["nproc"] = os.cpu_count() or 1
        except Exception:
            self.store.meta["nproc"] = 1
        try:
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemTotal:"):
                    self.store.meta["mem_total_mb"] = int(line.split()[1]) // 1024
                    break
        except OSError:
            pass
        self.store.meta.setdefault("load_runs", [])

    # ── vòng lặp ──────────────────────────────────────────────────────
    async def run(self) -> None:
        self._client = httpx.AsyncClient(timeout=3.0)
        try:
            while True:
                t0 = time.perf_counter()
                try:
                    await self.tick()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("sampler tick lỗi")
                took = time.perf_counter() - t0
                if took > 0.5:
                    log.warning("sampler tick chậm: %.0fms", took * 1000)
                await asyncio.sleep(max(0.1, TICK_S - took))
        finally:
            await self._client.aclose()
            self._client = None

    async def tick(self) -> None:
        self._tick += 1
        now = time.time()
        detail = now < self.detail_until

        self._sample_host(now)
        self._sample_procs(now, with_fd=self._tick % EVERY_FD == 0)
        self._sample_requests(now)
        await self._sample_gpu(now)

        if self._tick % EVERY_GPU_PROC == 0:
            await self._sample_gpu_procs(now)
        if self._tick % EVERY_NGROK == 0:
            await self._sample_ngrok(now)
        if detail and self._tick % NGROK_REQ_TICKS == 0:
            await self._sample_ngrok_requests(now)
        if self._tick % EVERY_DISK == 1:
            self._sample_disk(now)
        if self._tick % EVERY_TRIM == 0:
            self.store.trim(now)

    # ── toàn máy ──────────────────────────────────────────────────────
    def _sample_host(self, now: float) -> None:
        try:
            first = Path("/proc/stat").read_text().split("\n", 1)[0].split()
            vals = [float(x) for x in first[1:]]
            idle = vals[3] + (vals[4] if len(vals) > 4 else 0.0)   # idle + iowait
            total = sum(vals)
            busy = total - idle
            if self._host_cpu_prev is not None:
                db = busy - self._host_cpu_prev[0]
                dt = total - self._host_cpu_prev[1]
                self.store.push("host.cpu_pct", 100.0 * db / dt if dt > 0 else None, now)
            else:
                self.store.push("host.cpu_pct", None, now)
            self._host_cpu_prev = (busy, total)
        except (OSError, ValueError, IndexError):
            pass

        try:
            la = Path("/proc/loadavg").read_text().split()
            self.store.push_many({
                "host.load1": float(la[0]),
                "host.load5": float(la[1]),
                "host.load15": float(la[2]),
            }, now)
        except (OSError, ValueError, IndexError):
            pass

        try:
            total_kb = avail_kb = None
            for line in Path("/proc/meminfo").read_text().splitlines():
                if line.startswith("MemTotal:"):
                    total_kb = int(line.split()[1])
                elif line.startswith("MemAvailable:"):
                    avail_kb = int(line.split()[1])
                if total_kb is not None and avail_kb is not None:
                    break
            if total_kb and avail_kb is not None:
                self.store.push_many({
                    "host.mem_used_mb": (total_kb - avail_kb) / 1024.0,
                    "host.mem_avail_mb": avail_kb / 1024.0,
                }, now)
        except (OSError, ValueError, IndexError):
            pass

    def _sample_disk(self, now: float) -> None:
        """Dung lượng trống của phân vùng chứa {root} và {log_dir}.

        Models vài GB mỗi cái, log Whisper phình đều. Đĩa đầy thì giết cả stack
        — mà trước đây panel không hề đo, nên không có cách nào cảnh báo trước.
        """
        seen: dict[int, str] = {}
        targets = {"root": self.cfg.defaults.get("root"), "logs": str(self.cfg.log_dir)}
        for name, path in targets.items():
            if not path:
                continue
            try:
                st = os.statvfs(path)
            except OSError:
                self.store.push(f"host.disk_{name}_free_gb", None, now)
                continue
            # Cùng một phân vùng thì đừng vẽ hai đường y hệt nhau.
            key = st.f_fsid or hash((st.f_blocks, st.f_bsize))
            if key in seen:
                continue
            seen[key] = name
            free = st.f_bavail * st.f_frsize
            total = st.f_blocks * st.f_frsize
            free_gb = free / 1024**3
            self.store.push_many({
                f"host.disk_{name}_free_gb": free_gb,
                f"host.disk_{name}_used_pct": 100.0 * (1 - free / total) if total else None,
            }, now)
            self._check_disk(name, path, free_gb)

    def _check_disk(self, name: str, path: str, free_gb: float) -> None:
        if self.on_alert is None:
            return
        if free_gb < DISK_WARN_GB and name not in self._disk_warned:
            self._disk_warned.add(name)
            self.on_alert(
                "host",
                f"Đĩa ({name})",
                f"chỉ còn {free_gb:.1f} GB trống ở {path} — tải thêm model là hết chỗ",
            )
        elif free_gb > DISK_CLEAR_GB:
            self._disk_warned.discard(name)

    def _check_vram(self, gpu: int, used_mb: float, total_mb: float) -> None:
        """Cảnh báo VRAM sắp hết — cùng khuôn với _check_disk.

        Có hai model trên một card thì đây không còn là chuyện lý thuyết.
        """
        if self.on_alert is None or not total_mb:
            return
        free_gb = (total_mb - used_mb) / 1024.0
        if free_gb < VRAM_WARN_GB and gpu not in self._vram_warned:
            self._vram_warned.add(gpu)
            self.on_alert(
                "host",
                f"VRAM (GPU {gpu})",
                f"chỉ còn {free_gb:.1f} GB trống / {total_mb / 1024:.1f} GB — "
                f"thêm tải lên GPU là OOM",
            )
        elif free_gb > VRAM_CLEAR_GB:
            self._vram_warned.discard(gpu)

    # ── từng tiến trình ───────────────────────────────────────────────
    def _sample_procs(self, now: float, with_fd: bool) -> None:
        pid_of: dict[str, int] = {}
        # Bỏ nhóm ẩn: intent_vllm và intent trỏ CÙNG một tiến trình, lấy cả hai
        # sẽ ra series trùng lặp làm nhiễu chart (và stacked area cộng đôi).
        hidden = {g.id for g in self.cfg.groups if g.hidden}
        for svc in self.cfg.services.values():
            if svc.kind == "composite" or svc.group in hidden:
                continue
            pid = self.sup.state(svc.id).pid
            if not pid:
                # service tắt → đẩy None để đường đứt, đừng để 0 (0 = "đang rảnh")
                for m in ("cpu_pct", "rss_mb", "threads", "fds",
                          "io_read_bps", "io_write_bps"):
                    self.store.push(f"proc.{svc.id}.{m}", None, now)
                self._cpu_prev.pop(svc.id, None)
                self._io_prev.pop(svc.id, None)
                continue
            pid_of[svc.id] = pid
            self._sample_one_proc(svc.id, pid, now, with_fd)
        self.store.meta["pid_of"] = pid_of

    def _sample_one_proc(self, sid: str, pid: int, now: float, with_fd: bool) -> None:
        base = Path(f"/proc/{pid}")

        # try/except TỪNG FILE — một pid chết không được làm hỏng cả vòng
        try:
            raw = (base / "stat").read_text()
            tail = raw.rpartition(")")[2].split()
            utime, stime = float(tail[11]), float(tail[12])
            threads = int(tail[17])
            jiffies = utime + stime
            prev = self._cpu_prev.get(sid)
            if prev and prev[2] == pid and now > prev[0]:
                dj = jiffies - prev[1]
                dt = now - prev[0]
                # % của MỘT core, giống top — có thể >100% khi đa luồng
                self.store.push(f"proc.{sid}.cpu_pct", max(0.0, 100.0 * dj / CLK_TCK / dt), now)
            else:
                self.store.push(f"proc.{sid}.cpu_pct", None, now)
            self._cpu_prev[sid] = (now, jiffies, pid)
            self.store.push(f"proc.{sid}.threads", threads, now)
            # starttime (field 22) tính bằng jiffies kể từ lúc máy khởi động
            boot = time.time() - float(Path("/proc/uptime").read_text().split()[0])
            self.store.push(f"proc.{sid}.uptime_s",
                            max(0.0, now - (boot + float(tail[19]) / CLK_TCK)), now)
        except (OSError, ValueError, IndexError):
            pass

        try:
            for line in (base / "status").read_text().splitlines():
                if line.startswith("nonvoluntary_ctxt_switches:"):
                    v = float(line.split()[1])
                    prev = self._ctx_prev.get(sid)
                    if prev and prev[2] == pid and now > prev[0]:
                        # bị hệ điều hành cướp CPU — cao nghĩa là đang tranh CPU
                        self.store.push(f"proc.{sid}.ctxsw_forced_ps",
                                        max(0.0, (v - prev[1]) / (now - prev[0])), now)
                    else:
                        self.store.push(f"proc.{sid}.ctxsw_forced_ps", None, now)
                    self._ctx_prev[sid] = (now, v, pid)
                    break
        except (OSError, ValueError, IndexError):
            pass

        try:
            for line in (base / "status").read_text().splitlines():
                if line.startswith("VmRSS:"):
                    self.store.push(f"proc.{sid}.rss_mb", int(line.split()[1]) / 1024.0, now)
                    break
        except (OSError, ValueError, IndexError):
            pass

        try:
            rchar = wchar = 0.0
            for line in (base / "io").read_text().splitlines():
                # rchar/wchar chứ không phải read_bytes: read_bytes hay =0 do page cache
                if line.startswith("rchar:"):
                    rchar = float(line.split()[1])
                elif line.startswith("wchar:"):
                    wchar = float(line.split()[1])
            prev = self._io_prev.get(sid)
            if prev and prev[3] == pid and now > prev[0]:
                dt = now - prev[0]
                self.store.push_many({
                    f"proc.{sid}.io_read_bps": max(0.0, (rchar - prev[1]) / dt),
                    f"proc.{sid}.io_write_bps": max(0.0, (wchar - prev[2]) / dt),
                }, now)
            else:
                self.store.push(f"proc.{sid}.io_read_bps", None, now)
                self.store.push(f"proc.{sid}.io_write_bps", None, now)
            self._io_prev[sid] = (now, rchar, wchar, pid)
        except (OSError, ValueError, IndexError):
            pass

        if with_fd:
            try:
                self.store.push(f"proc.{sid}.fds", len(os.listdir(base / "fd")), now)
            except OSError:
                pass

    # ── request từ access log ─────────────────────────────────────────
    def _sample_requests(self, now: float) -> None:
        """Dẫn event của MetricsCollector sang store, tính theo cửa sổ TICK_S.

        Đếm trong đúng một tick rồi quy ra req/phút — không dùng series() vì
        cái đó gộp theo cửa sổ lớn, ở đây cần độ phân giải bằng nhịp sampler.
        """
        if self.metrics is None:
            return
        lo = now - TICK_S
        total = errs = err4 = 0
        per_svc: dict[str, int] = {}
        for ev in reversed(self.metrics.events):
            if ev.ts < lo:
                break
            if ev.is_probe:
                continue
            total += 1
            per_svc[ev.svc_id] = per_svc.get(ev.svc_id, 0) + 1
            if ev.status >= 500:
                errs += 1
            elif ev.status >= 400:
                err4 += 1
        scale = 60.0 / TICK_S
        self.store.push_many({
            "req.rpm": total * scale,
            "req.err_rpm": errs * scale,
            "req.err4xx_rpm": err4 * scale,
        }, now)
        for sid, c in per_svc.items():
            self.store.push(f"req.{sid}.rpm", c * scale, now)

    def top_paths(self, window_s: float = 300.0, n: int = 10) -> list[list]:
        """Endpoint được gọi nhiều nhất — đọc trực tiếp từ event, không lưu series
        (mỗi path một series sẽ phình vô hạn khi app gọi URL có tham số)."""
        if self.metrics is None:
            return []
        lo = time.time() - window_s
        counts: dict[str, int] = {}
        for ev in reversed(self.metrics.events):
            if ev.ts < lo:
                break
            if ev.is_probe:
                continue
            key = f"{ev.svc_id}{ev.path}"[:60]
            counts[key] = counts.get(key, 0) + 1
        return [[k, v] for k, v in sorted(counts.items(), key=lambda kv: -kv[1])[:n]]

    # ── GPU ───────────────────────────────────────────────────────────
    async def _sample_gpu(self, now: float) -> None:
        out = await self._run_smi([
            f"--query-gpu={','.join(GPU_FIELDS)}",
            "--format=csv,noheader,nounits",
        ])
        if out is None:
            return
        for line in out.splitlines():
            cols = line.split(",")
            if len(cols) < len(GPU_FIELDS):
                continue
            idx = _num(cols[0])
            if idx is None:
                continue
            g = int(idx)
            self.store.meta.setdefault("gpu_name", cols[1].strip())
            total = _num(cols[3])
            limit = _num(cols[9])
            if total:
                self.store.meta["gpu_total_mb"] = total
            if limit:
                self.store.meta["gpu_power_limit_w"] = limit
            used = _num(cols[2])
            if used is not None and total:
                self._check_vram(g, used, total)
            self.store.push_many({
                f"gpu.{g}.mem_used_mb": used,
                f"gpu.{g}.mem_reserved_mb": _num(cols[4]),
                f"gpu.{g}.util": _num(cols[5]),
                f"gpu.{g}.util_mem": _num(cols[6]),
                f"gpu.{g}.temp": _num(cols[7]),
                f"gpu.{g}.power_w": _num(cols[8]),
                f"gpu.{g}.clock_sm": _num(cols[10]),
                f"gpu.{g}.clock_mem": _num(cols[11]),
            }, now)

    async def _sample_gpu_procs(self, now: float) -> None:
        out = await self._run_smi([
            "--query-compute-apps=pid,process_name,used_gpu_memory",
            "--format=csv,noheader,nounits",
        ])
        if out is None:
            return
        pid_of: dict[str, int] = self.store.meta.get("pid_of", {})
        by_pid = {pid: sid for sid, pid in pid_of.items()}
        seen: set[str] = set()
        other = 0.0
        for line in out.splitlines():
            cols = line.split(",")
            if len(cols) < 3:
                continue
            pid = _num(cols[0])
            mb = _num(cols[2])
            if pid is None or mb is None:
                continue
            sid = by_pid.get(int(pid))
            if sid:
                self.store.push(f"gpuproc.{sid}.vram_mb", mb, now)
                seen.add(sid)
            else:
                other += mb
        for sid in pid_of:
            if sid not in seen:
                self.store.push(f"gpuproc.{sid}.vram_mb", 0.0, now)
        self.store.push("gpuproc._other.vram_mb", other, now)

    def _set_gpu_error(self, err: str | None) -> None:
        """Soi lỗi sang store.meta để MetricsCollector / API đọc được mà không
        phải giữ tham chiếu ngược tới Sampler."""
        self.gpu_error = err
        self.store.meta["gpu_error"] = err

    async def _run_smi(self, args: list[str]) -> str | None:
        try:
            proc = await asyncio.create_subprocess_exec(
                "nvidia-smi", *args,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            )
            out, err = await asyncio.wait_for(proc.communicate(), timeout=3.0)
        except FileNotFoundError:
            self._set_gpu_error("nvidia-smi không có")
            return None
        except (asyncio.TimeoutError, OSError) as e:
            self._set_gpu_error(f"nvidia-smi: {type(e).__name__}")
            return None
        if proc.returncode != 0:
            self._set_gpu_error(
                (err.decode("utf-8", "replace").strip() or "nvidia-smi lỗi")[:120])
            return None
        self._set_gpu_error(None)
        return out.decode("utf-8", "replace")

    # ── ngrok ─────────────────────────────────────────────────────────
    async def _sample_ngrok(self, now: float) -> None:
        if self._client is None:
            return
        try:
            r = await self._client.get("http://127.0.0.1:4040/api/tunnels")
            data = r.json()
        except Exception:
            for k in ("rate1", "p50_ms", "p90_ms", "p95_ms", "p99_ms", "conns", "rpm"):
                self.store.push(f"ngrok.{k}", None, now)
            self._ngrok_count_prev = None
            return

        tunnels = data.get("tunnels") or []
        if not tunnels:
            return
        m = (tunnels[0].get("metrics") or {})
        http = m.get("http") or {}
        conns = m.get("conns") or {}

        # p* của ngrok tính bằng NANOGIÂY
        ns = lambda v: (float(v) / 1e6) if isinstance(v, (int, float)) and v else None
        self.store.push_many({
            "ngrok.p50_ms": ns(http.get("p50")),
            "ngrok.p90_ms": ns(http.get("p90")),
            "ngrok.p95_ms": ns(http.get("p95")),
            "ngrok.p99_ms": ns(http.get("p99")),
            "ngrok.rate1": http.get("rate1"),
            "ngrok.conns": conns.get("gauge"),
        }, now)

        count = http.get("count")
        if isinstance(count, (int, float)):
            prev = self._ngrok_count_prev
            # ngrok restart → counter về 0; delta âm là vô nghĩa, đẩy None
            if prev is not None and count >= prev:
                self.store.push("ngrok.rpm", (count - prev) * 60.0 / (TICK_S * EVERY_NGROK), now)
            else:
                self.store.push("ngrok.rpm", None, now)
            self._ngrok_count_prev = float(count)

    async def _sample_ngrok_requests(self, now: float) -> None:
        if self._client is None:
            return
        try:
            r = await self._client.get("http://127.0.0.1:4040/api/requests/http")
            items = r.json().get("requests") or []
        except Exception:
            return
        from datetime import datetime
        for it in items:
            rid = it.get("id")
            if not rid or rid in self._ngrok_seen:
                continue
            self._ngrok_seen.add(rid)
            self._ngrok_seen_order.append(rid)
            try:
                # Python 3.10: fromisoformat KHÔNG nhận hậu tố Z
                start = it.get("start", "").replace("Z", "+00:00")
                ts = datetime.fromisoformat(start).timestamp()
            except (ValueError, TypeError):
                ts = now
            resp = it.get("response") or {}
            req = it.get("request") or {}
            length = (resp.get("headers") or {}).get("Content-Length") or ["0"]
            try:
                nbytes = int(length[0])
            except (ValueError, TypeError, IndexError):
                nbytes = 0
            self.ngrok_requests.append({
                "t": ts,
                "dur_ms": round(float(it.get("duration") or 0) / 1e6, 2),
                "status": resp.get("status_code") or 0,
                "method": req.get("method") or "",
                "uri": (req.get("uri") or "")[:80],
                "bytes": nbytes,
            })
        # giữ theo cửa sổ retention
        cutoff = now - self.store.retention_s
        self.ngrok_requests = [x for x in self.ngrok_requests if x["t"] >= cutoff][-500:]
        while len(self._ngrok_seen_order) > NGROK_SEEN_MAX:
            self._ngrok_seen.discard(self._ngrok_seen_order.popleft())
