"""Khởi động / dừng / adopt process.

Hai điểm cốt lõi:

1. `start_new_session=True` — process chạy trong session+pgid mới, KHÔNG có
   controlling terminal của panel. Nhờ vậy Ctrl-C panel hay restart panel
   không kéo theo service.

2. `reconcile()` — panel dùng chung /tmp/tinytalk-hybrid/*.{log,pid} với
   deploy/scripts/start_hybrid.sh. Bạn chạy tay bằng script rồi mở panel,
   panel vẫn nhận ra và điều khiển được.
"""

from __future__ import annotations

import contextlib
import errno
import logging
import os
import signal
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

from .config import Config, ConfigError, Service, _validate_pkill

log = logging.getLogger("panel.supervisor")

#: cmdline của chính panel — không bao giờ được match pattern pkill
_SELF_CMDLINE = " ".join(
    Path("/proc/self/cmdline").read_bytes().decode("utf-8", "replace").split("\0")
) if Path("/proc/self/cmdline").exists() else ""


@dataclass
class PidState:
    pid: int | None = None
    owned: bool = False      # panel tự spawn trong phiên này
    adopted: bool = False    # nhận từ pid file / pgrep
    external: bool = False   # health ONLINE nhưng không tìm được pid
    started_at: float | None = None

    @property
    def alive(self) -> bool:
        return self.pid is not None and _pid_alive(self.pid)

    @property
    def uptime_s(self) -> float | None:
        if self.started_at is None:
            return None
        return time.time() - self.started_at


@dataclass
class Job:
    id: str
    svc_id: str
    kind: str            # start | stop | action
    pid: int | None
    log_path: str
    started_at: float
    rc: int | None = None
    finished_at: float | None = None
    label: str = ""
    popen: subprocess.Popen | None = field(default=None, repr=False)

    @property
    def running(self) -> bool:
        return self.rc is None


class SupervisorError(Exception):
    pass


# ── tiện ích process ────────────────────────────────────────────────────
def _pid_alive(pid: int) -> bool:
    """Còn sống thật sự. Zombie KHÔNG tính là sống.

    Con do panel spawn mà chưa wait() sẽ thành zombie sau khi chết; os.kill(pid,0)
    vẫn thành công với zombie, nên chỉ dựa vào kill là báo sống nhầm.
    """
    try:
        os.kill(pid, 0)
    except OSError as e:
        if e.errno != errno.EPERM:
            return False
    return _proc_state(pid) != "Z"


def _proc_state(pid: int) -> str:
    """Ký tự trạng thái trong /proc/<pid>/stat: R/S/D/Z/T..."""
    try:
        data = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return ""
    # comm nằm trong ngoặc và có thể chứa khoảng trắng → cắt từ ')' cuối
    tail = data.rpartition(")")[2].split()
    return tail[0] if tail else ""


def _reap() -> None:
    """Thu hoạch con đã chết để không tích zombie."""
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            return
        except OSError:
            return
        if pid == 0:
            return


def _cmdline(pid: int) -> str:
    try:
        raw = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return ""
    return " ".join(raw.decode("utf-8", "replace").split("\0")).strip()


def _proc_start_time(pid: int) -> float | None:
    """Thời điểm process bắt đầu (epoch), lấy từ mtime của /proc/<pid>."""
    try:
        return Path(f"/proc/{pid}").stat().st_mtime
    except OSError:
        return None


def _pgrep(pattern: str) -> list[int]:
    try:
        out = subprocess.run(
            ["pgrep", "-f", "--", pattern],
            capture_output=True, text=True, timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    pids = []
    for line in out.stdout.split():
        with contextlib.suppress(ValueError):
            pid = int(line)
            if pid != os.getpid():
                pids.append(pid)
    return pids


def _assert_pattern_safe(pattern: str, svc_id: str) -> None:
    """Kiểm lại lúc gọi, không chỉ lúc load config."""
    _validate_pkill(svc_id, pattern)
    if _SELF_CMDLINE and pattern in _SELF_CMDLINE:
        raise SupervisorError(
            f"[{svc_id}] pkill pattern {pattern!r} khớp chính panel — từ chối"
        )


# ── Supervisor ──────────────────────────────────────────────────────────
class Supervisor:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.pids: dict[str, PidState] = {}
        self.jobs: dict[str, Job] = {}
        self._job_seq = 0
        self._log_handles: dict[str, object] = {}

    # -- config hot-reload --------------------------------------------
    def rebind(self, cfg: Config) -> None:
        self.cfg = cfg

    # -- trạng thái ----------------------------------------------------
    def state(self, svc_id: str) -> PidState:
        st = self.pids.get(svc_id)
        if st and st.pid and not _pid_alive(st.pid):
            st = PidState()
            self.pids[svc_id] = st
        return st or PidState()

    def reconcile(self) -> dict[str, PidState]:
        """Nhận diện process đã chạy sẵn (do script hoặc phiên panel trước)."""
        for svc in self.cfg.services.values():
            if svc.kind == "composite":
                continue
            cur = self.pids.get(svc.id)
            if cur and cur.owned and cur.alive:
                continue  # đang sở hữu, không đụng
            self.pids[svc.id] = self._discover(svc)
        return self.pids

    def _discover(self, svc: Service) -> PidState:
        pattern = svc.stop.pattern if svc.stop and svc.stop.mode == "pkill" else None

        # 1. pid file + xác thực cmdline (chống PID reuse)
        if svc.pid_file:
            p = Path(svc.pid_file)
            if p.exists():
                try:
                    pid = int(p.read_text().strip())
                except (ValueError, OSError):
                    pid = 0
                if pid and _pid_alive(pid):
                    cl = _cmdline(pid)
                    if not pattern or pattern in cl:
                        return PidState(pid=pid, adopted=True,
                                        started_at=_proc_start_time(pid))

        # 2. pgrep theo pattern
        if pattern:
            for pid in _pgrep(pattern):
                return PidState(pid=pid, adopted=True, started_at=_proc_start_time(pid))

        return PidState()

    def mark_external(self, svc_id: str) -> None:
        """Health ONLINE nhưng không có PID → do người/thứ khác chạy."""
        st = self.pids.get(svc_id) or PidState()
        if not st.alive:
            self.pids[svc_id] = PidState(external=True)

    # -- start ---------------------------------------------------------
    def start(self, svc_id: str) -> dict:
        svc = self.cfg.get(svc_id)
        if svc.start is None:
            raise SupervisorError(f"[{svc_id}] không có cấu hình start")

        missing = self.missing_requirements(svc)
        if missing:
            raise SupervisorError(f"[{svc_id}] thiếu môi trường: {', '.join(missing)}")

        if svc.start.mode == "script":
            job = self._spawn_job(svc, svc.start.script, svc.start.job_log or svc.log,
                                  kind="start", label=f"start {svc.name}")
            return {"ok": True, "job_id": job.id}

        st = self.state(svc_id)
        if st.alive:
            return {"ok": True, "already_running": True, "pid": st.pid}

        pid = self._spawn_process(svc)
        self.pids[svc_id] = PidState(pid=pid, owned=True, started_at=time.time())
        return {"ok": True, "pid": pid}

    def _spawn_process(self, svc: Service) -> int:
        spec = svc.start
        assert spec is not None
        log_path = Path(svc.log) if svc.log else self.cfg.log_dir / f"{svc.id}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)

        # 'ab' — append, KHÔNG BAO GIỜ truncate: log này dùng chung với start_hybrid.sh
        logf = open(log_path, "ab", buffering=0)
        try:
            env = {**os.environ, **spec.env}
            if spec.argv:
                argv: list[str] = list(spec.argv)
            else:
                argv = ["bash", "-c", spec.shell or "true"]

            banner = (
                f"\n=== [server-panel] start {svc.id} @ "
                f"{time.strftime('%Y-%m-%d %H:%M:%S')} ===\n"
            ).encode()
            logf.write(banner)

            popen = subprocess.Popen(
                argv,
                cwd=spec.cwd or None,
                env=env,
                stdout=logf,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                start_new_session=True,   # ← sống sót qua restart panel
                close_fds=True,
            )
        finally:
            logf.close()

        if svc.pid_file:
            try:
                Path(svc.pid_file).parent.mkdir(parents=True, exist_ok=True)
                Path(svc.pid_file).write_text(str(popen.pid))
            except OSError as e:
                log.warning("không ghi được pid file %s: %s", svc.pid_file, e)

        log.info("started %s pid=%s", svc.id, popen.pid)
        return popen.pid

    # -- stop ----------------------------------------------------------
    def stop(self, svc_id: str) -> dict:
        svc = self.cfg.get(svc_id)
        if svc.stop is None or svc.stop.mode == "none":
            raise SupervisorError(f"[{svc_id}] không có cấu hình stop")

        if svc.stop.mode == "script":
            job = self._spawn_job(svc, svc.stop.script,
                                  self.cfg.log_dir / f"_job_{svc.id}_stop.log",
                                  kind="stop", label=f"stop {svc.name}")
            return {"ok": True, "job_id": job.id}

        pattern = svc.stop.pattern or ""
        _assert_pattern_safe(pattern, svc_id)

        killed: list[int] = []
        st = self.state(svc_id)

        # Ưu tiên giết theo process group của pid đã biết — hẹp hơn pkill -f
        if st.pid and _pid_alive(st.pid):
            with contextlib.suppress(OSError):
                os.killpg(os.getpgid(st.pid), signal.SIGTERM)
                killed.append(st.pid)

        for pid in _pgrep(pattern):
            if pid in killed:
                continue
            with contextlib.suppress(OSError):
                os.kill(pid, signal.SIGTERM)
                killed.append(pid)

        # chờ grace rồi SIGKILL phần còn sống
        deadline = time.time() + svc.stop.grace_s
        while time.time() < deadline:
            _reap()
            if not any(_pid_alive(p) for p in killed):
                break
            time.sleep(0.2)
        for pid in killed:
            if _pid_alive(pid):
                with contextlib.suppress(OSError):
                    os.killpg(os.getpgid(pid), signal.SIGKILL)
        time.sleep(0.15)
        _reap()

        if svc.pid_file:
            with contextlib.suppress(OSError):
                Path(svc.pid_file).unlink()
        self.pids[svc_id] = PidState()
        return {"ok": True, "killed": killed}

    def restart(self, svc_id: str) -> dict:
        svc = self.cfg.get(svc_id)
        if svc.stop and svc.stop.mode != "none":
            self.stop(svc_id)
            deadline = time.time() + (svc.stop.grace_s + 2)
            while time.time() < deadline and self.state(svc_id).alive:
                time.sleep(0.2)
        return self.start(svc_id)

    # -- job one-shot --------------------------------------------------
    def _spawn_job(self, svc: Service, script: str | None, log_path: str | Path | None,
                   kind: str, label: str) -> Job:
        if not script:
            raise SupervisorError(f"[{svc.id}] job thiếu script")
        script_p = Path(script)
        if not script_p.exists():
            raise SupervisorError(f"[{svc.id}] không tìm thấy script: {script}")

        log_path = Path(log_path or self.cfg.log_dir / f"_job_{svc.id}.log")
        log_path.parent.mkdir(parents=True, exist_ok=True)

        self._job_seq += 1
        job_id = f"{svc.id}-{kind}-{self._job_seq}"

        logf = open(log_path, "ab", buffering=0)
        try:
            logf.write(
                f"\n=== [server-panel] {label} @ "
                f"{time.strftime('%Y-%m-%d %H:%M:%S')} ===\n".encode()
            )
            popen = subprocess.Popen(
                ["bash", str(script_p)],
                cwd=str(script_p.parent),
                env=dict(os.environ),
                stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                start_new_session=True,
                close_fds=True,
            )
        finally:
            logf.close()

        job = Job(id=job_id, svc_id=svc.id, kind=kind, pid=popen.pid,
                  log_path=str(log_path), started_at=time.time(),
                  label=label, popen=popen)
        self.jobs[job_id] = job
        log.info("job %s pid=%s (%s)", job_id, popen.pid, script)
        return job

    def run_action(self, svc_id: str, action_id: str) -> dict:
        svc = self.cfg.get(svc_id)
        action = next((a for a in svc.actions if a.id == action_id), None)
        if action is None:
            raise SupervisorError(f"[{svc_id}] không có action {action_id!r}")
        if action.type == "url":
            return {"ok": True, "type": "url", "url": action.url}

        log_path = self.cfg.log_dir / f"_action_{svc.id}_{action.id}.log"
        if action.type == "script":
            job = self._spawn_job(svc, action.script, log_path,
                                  kind="action", label=action.label)
        else:  # shell
            log_path.parent.mkdir(parents=True, exist_ok=True)
            logf = open(log_path, "ab", buffering=0)
            try:
                popen = subprocess.Popen(
                    ["bash", "-c", action.shell or "true"],
                    cwd=action.cwd or self.cfg.defaults.get("root") or None,
                    env=dict(os.environ),
                    stdout=logf, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                    start_new_session=True, close_fds=True,
                )
            finally:
                logf.close()
            self._job_seq += 1
            job = Job(id=f"{svc.id}-action-{self._job_seq}", svc_id=svc.id, kind="action",
                      pid=popen.pid, log_path=str(log_path), started_at=time.time(),
                      label=action.label, popen=popen)
            self.jobs[job.id] = job

        return {"ok": True, "job_id": job.id, "log": job.log_path,
                "show_output": action.show_output}

    def new_job(self, svc_id: str, kind: str, log_path: str | Path, label: str) -> Job:
        """Job không gắn với process nào — panel tự điều phối (composite members).

        pid/popen đều None nên poll_jobs() không đụng tới; người tạo tự set rc.
        """
        self._job_seq += 1
        job = Job(
            id=f"{svc_id}-{kind}-{self._job_seq}", svc_id=svc_id, kind=kind,
            pid=None, log_path=str(log_path), started_at=time.time(), label=label,
        )
        self.jobs[job.id] = job
        return job

    def poll_jobs(self) -> list[Job]:
        """Thu hoạch job đã xong. Trả về danh sách job vừa kết thúc phiên này."""
        _reap()
        finished: list[Job] = []
        for job in self.jobs.values():
            if job.rc is not None:
                continue
            if job.popen is not None:
                rc = job.popen.poll()
                if rc is not None:
                    job.rc = rc
                    job.finished_at = time.time()
                    finished.append(job)
            elif job.pid and not _pid_alive(job.pid):
                job.rc = -1
                job.finished_at = time.time()
                finished.append(job)
        # dọn job cũ (giữ 50 cái gần nhất)
        if len(self.jobs) > 50:
            old = sorted(self.jobs.values(), key=lambda j: j.started_at)[:-50]
            for j in old:
                if not j.running:
                    self.jobs.pop(j.id, None)
        return finished

    # -- môi trường ----------------------------------------------------
    def missing_requirements(self, svc: Service) -> list[str]:
        """Trả về danh sách file/binary còn thiếu → trạng thái NO_ENV."""
        if svc.start is None:
            return []
        missing: list[str] = []
        for f in svc.start.requires_file:
            if not Path(os.path.expanduser(f)).exists():
                missing.append(f)
        for b in svc.start.requires_bin:
            import shutil as _sh
            if _sh.which(b) is None:
                missing.append(f"{b} (binary)")
        if svc.start.mode == "script" and svc.start.script:
            if not Path(svc.start.script).exists():
                missing.append(svc.start.script)
        return missing

    def shutdown(self) -> None:
        """Panel tắt — KHÔNG kill service nào. Chúng chạy detached có chủ đích."""
        log.info("panel shutdown; %d service vẫn chạy tiếp", sum(
            1 for s in self.pids.values() if s.alive))


__all__ = ["Supervisor", "SupervisorError", "PidState", "Job", "ConfigError"]
