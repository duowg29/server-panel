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
from panel.archive import SeriesArchive  # noqa: E402
from panel.health import HealthPoller  # noqa: E402
from panel.metrics import MetricsCollector  # noqa: E402
from panel.sampler import Sampler  # noqa: E402
from panel.series import SeriesStore  # noqa: E402
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
    store = SeriesStore()
    mc = MetricsCollector(cfg, store)
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

    # nvidia-smi CHỈ được gọi ở Sampler — metrics đọc lại từ store. Trước đây
    # cả hai cùng gọi, tức là fork nvidia-smi hai lần song song mãi mãi.
    sup = Supervisor(cfg)
    sampler = Sampler(cfg, sup, store, mc)
    await sampler._sample_gpu(time.time())
    if shutil.which("nvidia-smi"):
        g = mc.gpu_series()
        check("đọc nvidia-smi qua Sampler", bool(g) and g[0]["total_mb"] > 0,
              f"{g[0]['name']} {g[0]['used_mb']}/{g[0]['total_mb']}MiB" if g else "trống")
        check("metrics đọc GPU từ store, không tự gọi smi",
              not hasattr(mc, "_sample_gpu"))
    else:
        check("nvidia-smi vắng → không crash", mc.gpu_error is not None, str(mc.gpu_error))


def test_parity() -> None:
    """Panel phải chạy ĐÚNG lệnh mà start_hybrid.sh của server dùng.

    Server phải chạy độc lập được: `bash deploy/scripts/start_hybrid.sh` không
    cần panel. Nếu panel dùng interpreter khác (vd. một venv riêng do panel tự
    nghĩ ra) thì hai đường sẽ lệch — chạy tay hỏng, chạy panel được, hoặc ngược
    lại. Test này khoá điều đó lại.
    """
    print("\n== parity với start_hybrid.sh ==")
    here = Path(__file__).resolve().parent
    cfg_path = here / "services.yaml"
    if not cfg_path.exists():
        check("có services.yaml", False)
        return
    cfg = cfgmod.load(cfg_path)

    script = Path(cfg.defaults["root"]) / "deploy/scripts/start_hybrid.sh"
    if not script.exists():
        print("     (bỏ qua — không thấy start_hybrid.sh)")
        return
    body = script.read_text(encoding="utf-8")

    # (service, đoạn phải xuất hiện trong CẢ start_hybrid.sh lẫn lệnh của panel)
    cases = [
        ("speech", "python3 speech_service_local.py"),
        ("cpu_inf", ".venv-cpu-inf/bin/python"),
        ("cpu_inf", "cpu_inference.server"),
        ("intent", ".venv-tinytalk/bin/python"),
        ("intent", "uvicorn app.main:app"),
        ("gateway", ".venv-tinytalk/bin/python"),
        ("gateway", "cpu_inference.hybrid_gateway"),
    ]
    for svc_id, frag in cases:
        svc = cfg.services.get(svc_id)
        if svc is None or svc.start is None:
            check(f"{svc_id}: có cấu hình start", False)
            continue
        panel_cmd = " ".join(svc.start.argv) if svc.start.argv else (svc.start.shell or "")
        in_script = frag in body
        in_panel = frag in panel_cmd
        check(
            f"{svc_id}: dùng {frag!r} giống server",
            in_script and in_panel,
            "" if (in_script and in_panel)
            else f"script={in_script} panel={in_panel}",
        )


def test_series_archive(tmp: Path) -> None:
    """Kho số liệu: gộp phải giữ được thứ đang đi tìm, cache không được nói dối."""
    print("\n== series + archive ==")
    now = time.time()

    store = SeriesStore()
    # Trạng thái: một ô chứa cả ONLINE (0) lẫn OFFLINE (4) thì phải ra OFFLINE.
    # Lấy trung bình sẽ ra 2 = DEGRADED — sai, và đúng loại sai làm mất dấu sự cố.
    for i in range(10):
        store.push("state.svc", 4.0 if i == 5 else 0.0, now - 10 + i)
    out = store.resample(["state.svc"], window_s=20, buckets=2, now=now)
    check("state.* gộp bằng XẤU NHẤT", max(v for v in out["series"]["state.svc"] if v is not None) == 4,
          str(out["series"]["state.svc"]))

    # Trần series: bỏ thì phải đếm và kêu, không được im lặng
    small = SeriesStore()
    from panel import series as series_mod
    keep = series_mod.MAX_SERIES
    series_mod.MAX_SERIES = 2
    try:
        for i in range(5):
            small.push(f"x{i}", 1.0, now)
    finally:
        series_mod.MAX_SERIES = keep
    check("chạm trần series thì đếm được, không im lặng",
          small.stats()["dropped"] == 3, str(small.stats()))

    # Archive: ô đã đóng ghi xuống đĩa, đọc lại ra đúng số
    arc = SeriesArchive(tmp / "series.db", bucket_s=30.0, retention_s=3600.0)
    src = SeriesStore()
    base = (now // 30) * 30 - 300
    for i in range(20):
        src.push("probe.x.latency_ms", 100.0 + i, base + i * 10)
    arc.flush(src, now=now)
    got = arc.resample(["probe.x.latency_ms"], window_s=600, buckets=20, now=now)
    vals = [v for v in got["series"].get("probe.x.latency_ms", []) if v is not None]
    check("archive ghi rồi đọc lại được", bool(vals), str(vals[:4]))
    # probe.* gộp bằng max — spike mới là thứ đáng chú ý
    check("archive gộp probe.* bằng max", max(vals) == 119.0 if vals else False,
          str(max(vals) if vals else None))

    # Cache: lần hai phải là CÙNG một object (không quét lại bảng)…
    a = arc.resample(["probe.x.latency_ms"], window_s=600, buckets=20, now=now)
    b = arc.resample(["probe.x.latency_ms"], window_s=600, buckets=20, now=now)
    check("resample có cache (lần hai không truy vấn lại)", a is b)
    # …nhưng flush ô mới thì cache phải hết hiệu lực, không được trả số cũ
    src.push("probe.x.latency_ms", 999.0, now - 1)
    arc.flush(src, now=now + 60)
    c = arc.resample(["probe.x.latency_ms"], window_s=600, buckets=20, now=now)
    check("flush xoá cache (không trả số cũ)", c is not a)

    st = arc.stats(now=now)
    check("archive.stats đếm được điểm", st["ok"] and st["points"] > 0, str(st.get("points")))
    check("archive.stats có cache", arc.stats(now=now + 1) is st)
    check("archive.names lọc theo mốc", "probe.x.latency_ms" in arc.names(now - 3600))
    arc.close()


async def test_health_dedup(tmp: Path) -> None:
    """Hai chỗ tốn tài nguyên Supabase, cả hai đều phải khoá lại bằng test.

    1. Nhiều service khai CÙNG một health.url thì chỉ được GET một lần.
    2. `health.interval_s` phải ghi đè nhịp mặc định.

    /health của Intent API ping Postgres trên cloud mỗi lần bị hỏi, nên hai lỗi
    này cộng lại từng bắn ~57.600 query/ngày ra internet chỉ để tô một badge.
    """
    print("\n== health: gộp probe + nhịp riêng ==")
    cfg_p = tmp / "dedup.yaml"
    cfg_p.write_text(textwrap.dedent(f"""
    version: 1
    defaults: {{ root: {tmp}, log_dir: {tmp}/logs, health_interval_s: 3 }}
    groups: [{{ id: t, label: T }}, {{ id: h, label: H, hidden: true }}]
    services:
      - id: a
        name: A
        group: t
        health: {{ url: "http://127.0.0.1:9/health", interval_s: 30 }}
      - id: a_alt
        name: A alt
        group: h
        health: {{ url: "http://127.0.0.1:9/health", interval_s: 30, timeout_s: 5 }}
      - id: b
        name: B
        group: t
        health: {{ url: "http://127.0.0.1:10/health" }}
    """))
    cfg = cfgmod.load(cfg_p)
    check("parse được health.interval_s", cfg.services["a"].health.interval_s == 30.0,
          str(cfg.services["a"].health.interval_s))

    poller = HealthPoller(cfg, Supervisor(cfg))
    calls: list[str] = []
    timeouts: dict[str, float | None] = {}

    async def fake_fetch(url: str, timeout_s: float | None = None):
        calls.append(url)
        timeouts[url] = timeout_s
        from panel.health import Fetched
        return Fetched(payload={"status": "ok"}, latency_ms=5)

    poller._fetch_one = fake_fetch          # type: ignore[assignment]
    await poller.tick()

    # a và a_alt dùng chung URL -> đúng MỘT lần gọi cho URL đó
    check("cùng URL chỉ GET một lần", calls.count("http://127.0.0.1:9/health") == 1,
          f"gọi {calls.count('http://127.0.0.1:9/health')} lần")
    check("URL khác vẫn được gọi riêng", "http://127.0.0.1:10/health" in calls)
    check("chung URL: chờ theo timeout_s dài nhất",
          timeouts.get("http://127.0.0.1:9/health") == 5.0,
          str(timeouts.get("http://127.0.0.1:9/health")))
    check("không khai timeout_s thì dùng mặc định",
          timeouts.get("http://127.0.0.1:10/health") == cfg.health_timeout_s,
          str(timeouts.get("http://127.0.0.1:10/health")))
    check("cả hai service dùng chung kết quả đều có trạng thái",
          poller.state_of("a") != "UNKNOWN" and poller.state_of("a_alt") != "UNKNOWN",
          f"a={poller.state_of('a')} a_alt={poller.state_of('a_alt')}")

    # nhịp: a chờ 30s, b chờ 3s
    now = time.time()
    wait_a = poller._next_at["a"] - now
    wait_b = poller._next_at["b"] - now
    check("interval_s riêng được tôn trọng", 29 <= wait_a <= 31, f"{wait_a:.1f}s")
    check("service khác vẫn dùng nhịp mặc định", 2 <= wait_b <= 4, f"{wait_b:.1f}s")

    # tick lại ngay: không service nào tới hạn -> không GET thêm
    calls.clear()
    await poller.tick()
    check("chưa tới hạn thì không gọi lại", calls == [], str(calls))


def test_hidden_group_no_incidents(tmp: Path) -> None:
    """Nhóm ẩn (vllm) chung port với hybrid: health chập chờn của nó từng bắn
    hàng chục toast "Intent API (vLLM): ONLINE → OFFLINE" dù không có card nào."""
    print("\n== nhóm ẩn không bắn sự cố ==")
    from panel.main import is_hidden_service
    cfg_p = tmp / "hidden.yaml"
    cfg_p.write_text(textwrap.dedent(f"""
    version: 1
    defaults: {{ root: {tmp}, log_dir: {tmp}/logs }}
    groups: [{{ id: t, label: T }}, {{ id: h, label: H, hidden: true }}]
    services:
      - {{ id: shown, name: Shown, group: t, health: {{ url: "http://127.0.0.1:9/health" }} }}
      - {{ id: ghost, name: Ghost, group: h, health: {{ url: "http://127.0.0.1:9/health" }} }}
    """))
    cfg = cfgmod.load(cfg_p)
    check("service nhóm ẩn bị tắt sự cố", is_hidden_service(cfg, "ghost"))
    check("service hiện vẫn ghi sự cố", not is_hidden_service(cfg, "shown"))
    check("id lạ không bị coi là ẩn", not is_hidden_service(cfg, "nope"))


def test_member_death_signal(tmp: Path) -> None:
    """Service `mode: script` KHÔNG được coi là chết chỉ vì panel không giữ PID.

    ngrok chạy bằng script nên panel chỉ có job, `alive` luôn False. Điều kiện
    cũ ("OFFLINE và không alive") biến mọi lần probe đầu tiên — 2 giây sau khi
    chạy, lúc ngrok chưa đăng ký tunnel nào — thành "process đã chết", làm gãy
    cả chuỗi khởi động composite trong khi ngrok vẫn sống.
    """
    print("\n== tín hiệu 'member đã chết' ==")
    from panel.main import _member_really_dead
    from panel.supervisor import Job

    cfg = cfgmod.load(make_config(tmp))
    sup = Supervisor(cfg)

    # mode: script — job đang chạy, chưa lên health: CHƯA phải chết
    sup.jobs["j1"] = Job(id="j1", svc_id="ngrok", kind="start", pid=1,
                         log_path=str(tmp / "j.log"), started_at=time.time(),
                         label="start ngrok")
    sup.jobs["j1"].rc = None
    check("job còn chạy → chưa kết luận chết", not _member_really_dead(sup, "ngrok", "j1"))

    # job xong rc=0 — script đã làm xong việc, service lên chậm là chuyện khác
    sup.jobs["j1"].rc = 0
    check("job xong rc=0 → chưa phải chết", not _member_really_dead(sup, "ngrok", "j1"))

    # job xong rc!=0 — đây mới là chết thật
    sup.jobs["j1"].rc = 1
    check("job rc!=0 → chết thật", _member_really_dead(sup, "ngrok", "j1"))

    # mode: process — không có job, `alive` mới là bằng chứng
    check("mode process không chạy → chết", _member_really_dead(sup, "dummy_http", None))



def test_series_end_ts(tmp: Path) -> None:
    """Xem lại được QUÁ KHỨ, không chỉ khoảng kết thúc ở hiện tại.

    Archive giữ 72 giờ, nhưng nếu mọi cửa sổ đều kết thúc ở "bây giờ" thì chỉ
    xem được 24 giờ gần nhất — 2/3 dữ liệu trên đĩa không chạm tới được, và đúng
    câu hỏi archive sinh ra để trả lời ("chiều qua lúc 3h") lại không trả lời
    được.

    Ghi thẳng vào sqlite chứ không qua flush(): flush chỉ ghi các ô VỪA ĐÓNG, và
    SeriesStore có trần 1200 điểm/series — không đường nào nhét 60 giờ vào RAM.
    Ở đây cần mô phỏng cái đĩa của một panel đã chạy nhiều ngày.
    """
    print("\n== xem lại quá khứ (end_ts) ==")
    now = time.time()
    arc = SeriesArchive(tmp / "hist.db", bucket_s=30.0, retention_s=72 * 3600.0)
    rows = []
    for k in range(60 * 120):                      # 60 giờ, ô 30s
        ts = int(now - 60 * 3600 + k * 30)
        rows.append(("host.cpu_pct", ts, (now - ts) / 3600.0))   # giá trị = số giờ trước
    arc.db.executemany("INSERT OR REPLACE INTO points VALUES (?,?,?)", rows)
    arc.db.commit()

    for hours in (2, 24, 50):
        end = now - hours * 3600
        out = arc.resample(["host.cpu_pct"], window_s=1800, buckets=30, now=end)
        vals = [v for v in out["series"].get("host.cpu_pct", []) if v is not None]
        mid = vals[len(vals) // 2] if vals else -1
        check(f"đọc được cửa sổ lùi {hours}h", bool(vals) and abs(mid - hours) < 1.5,
              f"giữa cửa sổ = {mid:.1f}, kỳ vọng ≈ {hours}")

    # hai mốc khác nhau phải cho hai kết quả khác nhau — nếu end_ts bị bỏ qua thì
    # cả hai sẽ trả về y hệt phần mới nhất
    a = arc.resample(["host.cpu_pct"], window_s=1800, buckets=30, now=now - 2 * 3600)
    b = arc.resample(["host.cpu_pct"], window_s=1800, buckets=30, now=now - 40 * 3600)
    check("mốc khác nhau cho dữ liệu khác nhau",
          a["t0"] != b["t0"] and a["series"] != b["series"])
    arc.close()


def test_vram_warning(tmp: Path) -> None:
    """Cảnh báo VRAM: kêu khi sắp hết, im khi còn nhiều, không kêu lặp."""
    print("\n== cảnh báo VRAM ==")
    from panel import sampler as sm

    alerts: list[tuple] = []
    cfg = cfgmod.load(make_config(tmp))
    sp = Sampler(cfg, Supervisor(cfg), SeriesStore(),
                 on_alert=lambda source, name, text: alerts.append((source, name, text)))

    total = 16380.0
    sp._check_vram(0, total - 5000, total)          # còn 4.9 GB
    check("còn nhiều thì im", not alerts, str(alerts))

    sp._check_vram(0, total - 800, total)           # còn 0.78 GB
    check("sắp hết thì kêu", len(alerts) == 1, str(alerts[-1][1:] if alerts else None))

    sp._check_vram(0, total - 700, total)           # vẫn thiếu
    check("không kêu lặp khi vẫn thiếu", len(alerts) == 1, f"{len(alerts)} lần")

    sp._check_vram(0, total - 5000, total)          # đã dọn xong
    sp._check_vram(0, total - 800, total)           # thiếu lại
    check("dọn xong rồi thiếu lại thì kêu tiếp", len(alerts) == 2, f"{len(alerts)} lần")



async def main() -> int:
    tmp = Path(tempfile.mkdtemp(prefix="panel-selftest-"))
    print(f"tmp: {tmp}")
    try:
        cfg = test_config(tmp)
        test_supervisor(cfg)
        await test_logs(tmp)
        await test_metrics(tmp, cfg)
        test_series_archive(tmp)
        await test_health_dedup(tmp)
        test_hidden_group_no_incidents(tmp)
        test_member_death_signal(tmp)
        test_series_end_ts(tmp)
        test_vram_warning(tmp)
        test_parity()
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
