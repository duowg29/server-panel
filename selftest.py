#!/usr/bin/env python3
"""Self-test không cần FastAPI — chạy được ngay cả khi chưa bootstrap.

    python3 selftest.py

Kiểm thật (không mock): spawn process detached, adopt lại bằng pid file,
stop bằng pkill, tail log qua rotate/truncate, parse access log, đọc nvidia-smi.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
import tempfile
import textwrap
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from panel import config as cfgmod  # noqa: E402
from panel.logs import LogTailer, backfill  # noqa: E402
from panel.metrics import MetricsCollector  # noqa: E402
from panel.supervisor import Supervisor, _pid_alive  # noqa: E402

PASS, FAIL = "\033[32m  ok \033[0m", "\033[31mFAIL \033[0m"
_fails = 0


def check(name: str, cond: bool, extra: str = "") -> None:
    global _fails
    print((PASS if cond else FAIL) + name + (f"  — {extra}" if extra else ""))
    if not cond:
        _fails += 1


def make_config(tmp: Path) -> Path:
    """Config giả: một service HTTP thật bằng http.server của stdlib."""
    scripts = tmp / "scripts"
    scripts.mkdir(parents=True, exist_ok=True)
    (scripts / "hello.sh").write_text("#!/bin/bash\necho 'job chạy xong'\nexit 0\n")

    body = textwrap.dedent(f"""
    version: 1
    defaults:
      root: {tmp}
      log_dir: {tmp}/logs
      health_interval_s: 1
      health_timeout_s: 1
    groups:
      - {{ id: test, label: TEST }}
    services:
      - id: dummy_http
        name: Dummy HTTP
        group: test
        kind: process
        port: 8791
        log: "{{log_dir}}/dummy.log"
        pid_file: "{{log_dir}}/dummy.pid"
        start:
          mode: process
          cwd: "{{root}}"
          argv: ["python3", "-u", "-m", "http.server", "8791", "--bind", "127.0.0.1"]
        stop:
          mode: pkill
          pattern: "http.server 8791"
          grace_s: 3
        health:
          url: http://127.0.0.1:8791/
          rules:
            online: "true == true"
      - id: jobby
        name: Job Runner
        group: test
        kind: process
        log: "{{log_dir}}/jobby.log"
        start:
          mode: script
          script: "{{root}}/scripts/hello.sh"
          job_log: "{{log_dir}}/jobby.log"
        stop:
          mode: none
    """)
    p = tmp / "services.test.yaml"
    p.write_text(body)
    return p


def test_config(tmp: Path) -> cfgmod.Config:
    print("\n== config ==")
    cfg = cfgmod.load(make_config(tmp))
    check("load config", len(cfg.services) == 2)
    check("expand {log_dir}", cfg.services["dummy_http"].log == f"{tmp}/logs/dummy.log",
          cfg.services["dummy_http"].log)

    # pattern pkill nguy hiểm phải bị chặn
    bad = tmp / "bad.yaml"
    bad.write_text(textwrap.dedent(f"""
    version: 1
    defaults: {{ root: {tmp}, log_dir: {tmp}/logs }}
    groups: [{{ id: t, label: T }}]
    services:
      - id: x
        name: X
        group: t
        stop: {{ mode: pkill, pattern: "python" }}
    """))
    try:
        cfgmod.load(bad)
        check("chặn pkill pattern 'python'", False, "load thành công — sai")
    except cfgmod.ConfigError as e:
        check("chặn pkill pattern 'python'", True, str(e)[:44])

    # rule chứa code injection phải bị chặn lúc load
    bad2 = tmp / "bad2.yaml"
    bad2.write_text(textwrap.dedent(f"""
    version: 1
    defaults: {{ root: {tmp}, log_dir: {tmp}/logs }}
    groups: [{{ id: t, label: T }}]
    services:
      - id: x
        name: X
        group: t
        health:
          url: http://127.0.0.1:1/
          rules: {{ online: "__import__('os').system('id')" }}
    """))
    try:
        cfgmod.load(bad2)
        check("chặn code injection trong health rule", False)
    except cfgmod.ConfigError:
        check("chặn code injection trong health rule", True)

    return cfg


def test_supervisor(cfg: cfgmod.Config) -> None:
    print("\n== supervisor ==")
    cfg.log_dir.mkdir(parents=True, exist_ok=True)
    sup = Supervisor(cfg)

    res = sup.start("dummy_http")
    pid = res.get("pid")
    check("start spawn được pid", bool(pid), f"pid={pid}")
    time.sleep(1.2)
    check("process còn sống", _pid_alive(pid))

    # detached: phải khác process group của panel
    check("detached (pgid riêng)", os.getpgid(pid) != os.getpgid(0),
          f"pgid={os.getpgid(pid)} panel={os.getpgid(0)}")

    check("ghi pid file", Path(cfg.services["dummy_http"].pid_file).exists())

    # phục vụ HTTP thật
    import urllib.request
    try:
        with urllib.request.urlopen("http://127.0.0.1:8791/", timeout=3) as r:
            ok = r.status == 200
    except Exception as e:
        ok = False
        print("     ", e)
    check("service trả lời HTTP", ok)

    # reconcile bằng Supervisor MỚI — mô phỏng panel restart
    sup2 = Supervisor(cfg)
    sup2.reconcile()
    st = sup2.state("dummy_http")
    check("panel restart vẫn adopt được", st.pid == pid and st.adopted,
          f"pid={st.pid} adopted={st.adopted}")

    # job one-shot
    job_res = sup2.start("jobby")
    check("job one-shot chạy", "job_id" in job_res)
    time.sleep(1.0)
    sup2.poll_jobs()
    job = sup2.jobs[job_res["job_id"]]
    check("job xong rc=0", job.rc == 0, f"rc={job.rc}")
    check("job ghi log", "job chạy xong" in "\n".join(backfill(job.log_path, 20)))

    stop_res = sup2.stop("dummy_http")
    time.sleep(0.8)
    check("stop giết được process", not _pid_alive(pid), f"killed={stop_res.get('killed')}")
    check("stop xoá pid file", not Path(cfg.services["dummy_http"].pid_file).exists())


async def test_logs(tmp: Path) -> None:
    print("\n== logs ==")
    log = tmp / "logs" / "tail.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text("dòng cũ 1\ndòng cũ 2\n")

    check("backfill đọc dòng cũ", backfill(log, 10) == ["dòng cũ 1", "dòng cũ 2"])

    tailer = LogTailer(log)
    q = tailer.subscribe()
    await asyncio.sleep(0.4)

    with log.open("a") as f:
        f.write("dòng mới\n")
    got = await asyncio.wait_for(q.get(), timeout=3)
    check("tail bắt được dòng mới", got == "dòng mới", got)

    # ANSI + redaction
    with log.open("a") as f:
        f.write("\x1b[32mmàu xanh\x1b[0m authtoken: 2abcdefghijklmnop\n")
    got = await asyncio.wait_for(q.get(), timeout=3)
    check("strip ANSI", "\x1b" not in got, repr(got[:30]))
    check("che secret", "2abcdefghijklmnop" not in got and "redacted" in got, got)

    # truncate (start_hybrid_ngrok.sh làm `: > log`)
    with log.open("w"):
        pass
    with log.open("a") as f:
        f.write("sau truncate\n")
    lines = []
    for _ in range(3):
        try:
            lines.append(await asyncio.wait_for(q.get(), timeout=3))
        except asyncio.TimeoutError:
            break
    check("phát hiện truncate", any("truncated" in x for x in lines), str(lines))
    check("đọc tiếp sau truncate", any("sau truncate" in x for x in lines), str(lines))

    # rotate
    log.rename(tmp / "logs" / "tail.log.1")
    (tmp / "logs" / "tail.log").write_text("sau rotate\n")
    lines = []
    for _ in range(3):
        try:
            lines.append(await asyncio.wait_for(q.get(), timeout=3))
        except asyncio.TimeoutError:
            break
    check("phát hiện rotate", any("rotated" in x for x in lines), str(lines))
    check("đọc tiếp sau rotate", any("sau rotate" in x for x in lines), str(lines))

    tailer.unsubscribe(q)

    # file chưa tồn tại vẫn chờ được
    later = tmp / "logs" / "chua-co.log"
    t2 = LogTailer(later)
    q2 = t2.subscribe()
    await asyncio.sleep(0.4)
    later.write_text("xuất hiện sau\n")
    try:
        got = await asyncio.wait_for(q2.get(), timeout=3)
        ok = got == "xuất hiện sau"
    except asyncio.TimeoutError:
        ok = False
        got = "(timeout)"
    check("mở pane trước khi file tồn tại", ok, got)
    t2.unsubscribe(q2)


async def test_metrics(tmp: Path, cfg: cfgmod.Config) -> None:
    print("\n== metrics ==")
    mc = MetricsCollector(cfg)
    log = Path(cfg.services["dummy_http"].log)
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text("")

    lm = {"wav_paths": ["/transcribe"], "ignore_paths": ["/health"]}
    mc._scan("dummy_http", str(log), lm)  # lần đầu: seek tới cuối

    with log.open("a") as f:
        f.write('INFO:     127.0.0.1:57916 - "GET /health HTTP/1.1" 200 OK\n')
        f.write('INFO:     127.0.0.1:57917 - "POST /transcribe HTTP/1.1" 200 OK\n')
        f.write('INFO:     127.0.0.1:57918 - "POST /intent HTTP/1.1" 500 Internal Server Error\n')
        f.write("dòng không phải access log\n")
    mc._scan("dummy_http", str(log), lm)

    s = mc.series(window_s=60, buckets=12)
    check("parse access log", s["total_in_window"] == 2, str(s["total_in_window"]))
    check("loại probe /health", s["probes_in_window"] == 1, str(s["probes_in_window"]))
    check("đếm wav", s["wav_total"] == 1 and s["wav_in_window"] == 1)
    check("đếm lỗi 5xx", sum(s["errors_per_min"]) > 0)
    check("by_service", s["by_service"] and s["by_service"][0][0] == "dummy_http")

    await mc._sample_gpu()
    if shutil.which("nvidia-smi"):
        g = mc.gpu_series()
        check("đọc nvidia-smi", bool(g) and g[0]["total_mb"] > 0,
              f"{g[0]['name']} {g[0]['used_mb']}/{g[0]['total_mb']}MiB" if g else "trống")
    else:
        check("nvidia-smi vắng → không crash", mc.gpu_error is not None, str(mc.gpu_error))


async def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="panel-selftest-"))
    print(f"tmp: {tmp}")
    try:
        cfg = test_config(tmp)
        test_supervisor(cfg)
        await test_logs(tmp)
        await test_metrics(tmp, cfg)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print()
    if _fails:
        print(f"\033[31m{_fails} test FAIL\033[0m")
    else:
        print("\033[32mtất cả test pass\033[0m")
    return 1 if _fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
