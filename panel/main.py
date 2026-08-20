"""Server Panel — FastAPI app.

BẢO MẬT — đọc kỹ trước khi sửa:
  * Bind 127.0.0.1 (xem run.sh). KHÔNG đổi thành 0.0.0.0.
  * Endpoint thực thi chỉ nhận ID. Không có đường nào để chuỗi từ request body
    chạm tới Popen/bash -c/pkill. Lệnh luôn tra từ services.yaml theo id.
  * Endpoint sửa config CHỈ ghi file, không bao giờ execute thứ vừa nhận.
  * Middleware chặn Origin lạ (DNS-rebinding: loopback không tự bảo vệ khỏi
    một trang web độc POST tới 127.0.0.1:9199).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config as cfgmod
from .config import Config, ConfigError, mask_env
from .health import HealthPoller
from .logs import LogRegistry, backfill
from .metrics import MetricsCollector
from .supervisor import Supervisor, SupervisorError, _pgrep

logging.basicConfig(
    level=os.environ.get("PANEL_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("panel")

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
PORT = int(os.environ.get("PANEL_PORT", "9199"))

ALLOWED_ORIGINS = {
    f"http://127.0.0.1:{PORT}",
    f"http://localhost:{PORT}",
    f"http://[::1]:{PORT}",
}


def _config_path() -> Path:
    override = os.environ.get("PANEL_CONFIG")
    if override:
        return Path(override)
    local = HERE.parent / "services.local.yaml"
    return local if local.exists() else HERE.parent / "services.yaml"


# ── Lifespan ────────────────────────────────────────────────────────────
@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    path = _config_path()
    log.info("config: %s", path)
    cfg = cfgmod.load(path)

    sup = Supervisor(cfg)
    poller = HealthPoller(cfg, sup)
    metrics = MetricsCollector(cfg)

    cfg.log_dir.mkdir(parents=True, exist_ok=True)
    sup.reconcile()

    app.state.cfg = cfg
    app.state.sup = sup
    app.state.poller = poller
    app.state.metrics = metrics
    app.state.logs = LogRegistry()
    app.state.status_subs = set()

    tasks = [
        asyncio.create_task(poller.run(), name="health"),
        asyncio.create_task(metrics.run_gpu(), name="gpu"),
        asyncio.create_task(metrics.run_logs(), name="logscan"),
        asyncio.create_task(_broadcast_loop(app), name="broadcast"),
        asyncio.create_task(_job_watch_loop(app), name="jobwatch"),
    ]
    log.info("panel sẵn sàng: http://127.0.0.1:%s", PORT)
    try:
        yield
    finally:
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        app.state.logs.shutdown()
        sup.shutdown()


app = FastAPI(title="TinyTalk Server Panel", lifespan=lifespan, docs_url=None, redoc_url=None)


# ── Middleware chống DNS-rebinding ──────────────────────────────────────
@app.middleware("http")
async def origin_guard(request: Request, call_next):
    origin = request.headers.get("origin")
    if origin and origin not in ALLOWED_ORIGINS:
        return JSONResponse({"error": "origin bị từ chối"}, status_code=403)
    if request.method not in ("GET", "HEAD", "OPTIONS") and not origin:
        referer = request.headers.get("referer", "")
        if referer and not any(referer.startswith(o) for o in ALLOWED_ORIGINS):
            return JSONResponse({"error": "referer bị từ chối"}, status_code=403)
    return await call_next(request)


def _ws_origin_ok(ws: WebSocket) -> bool:
    origin = ws.headers.get("origin")
    return origin is None or origin in ALLOWED_ORIGINS


# ── Vòng lặp đẩy dữ liệu ────────────────────────────────────────────────
async def _broadcast_loop(app: FastAPI) -> None:
    while True:
        await asyncio.sleep(2.0)
        subs = app.state.status_subs
        if not subs:
            continue
        payload = json.dumps(_status_payload(app), ensure_ascii=False)
        for ws in list(subs):
            try:
                await ws.send_text(payload)
            except Exception:
                subs.discard(ws)


async def _job_watch_loop(app: FastAPI) -> None:
    """Job `mode: script` xong → reconcile ngay.

    start_hybrid.sh tự pkill/restart vài service, nên pid file của panel có thể
    cũ giữa chừng. Reconcile ngay sau job là cách duy nhất để bám kịp.
    """
    while True:
        await asyncio.sleep(1.5)
        finished = app.state.sup.poll_jobs()
        if finished:
            app.state.sup.reconcile()
            for job in finished:
                app.state.poller.wake(job.svc_id)
                log.info("job %s xong rc=%s", job.id, job.rc)


# ── Payload ─────────────────────────────────────────────────────────────
def _status_payload(app: FastAPI) -> dict[str, Any]:
    poller: HealthPoller = app.state.poller
    metrics: MetricsCollector = app.state.metrics
    sup: Supervisor = app.state.sup
    services = poller.as_dict()
    # UI dùng chung kết luận này thay vì tự suy từ state (state không phân biệt
    # được hai service dùng chung port)
    for sid, entry in services.items():
        svc = app.state.cfg.services.get(sid)
        entry["blocked_by"] = _blocked_by(app, svc) if svc else []
    return {
        "type": "status",
        "ts": time.time(),
        "services": services,
        "public_url": poller.public_url(),
        "metrics": metrics.series(window_s=300.0),
        "jobs": [
            {"id": j.id, "svc_id": j.svc_id, "kind": j.kind, "label": j.label,
             "running": j.running, "rc": j.rc, "log": j.log_path,
             "started_at": j.started_at}
            for j in sorted(sup.jobs.values(), key=lambda j: -j.started_at)[:20]
        ],
    }


def _config_payload(app: FastAPI) -> dict[str, Any]:
    cfg: Config = app.state.cfg
    return {
        "config_path": str(cfg.path),
        "readonly": cfgmod.readonly(),
        "log_dir": str(cfg.log_dir),
        "root": cfg.defaults.get("root"),
        "groups": [{"id": g.id, "label": g.label} for g in cfg.groups],
        "services": [
            {
                "id": s.id, "name": s.name, "group": s.group, "kind": s.kind,
                "port": s.port, "log": s.log, "emphasis": s.emphasis,
                "note": s.note, "warn_on_start": s.warn_on_start,
                "members": s.members, "depends_on": s.depends_on,
                "conflicts_with": s.conflicts_with,
                "can_start": s.start is not None,
                "can_stop": s.stop is not None and s.stop.mode != "none",
                "start_mode": s.start.mode if s.start else None,
                "env": mask_env(s.start.env) if s.start else {},
                "actions": [
                    {"id": a.id, "label": a.label, "type": a.type, "url": a.url,
                     "confirm": a.confirm, "show_output": a.show_output}
                    for a in s.actions
                ],
            }
            for s in cfg.services.values()
        ],
    }


# ── Trang ───────────────────────────────────────────────────────────────
@app.get("/")
async def index() -> FileResponse:
    return FileResponse(STATIC / "index.html")


@app.get("/popout")
async def popout() -> FileResponse:
    return FileResponse(STATIC / "popout.html")


app.mount("/static", StaticFiles(directory=str(STATIC)), name="static")


# ── API: config ─────────────────────────────────────────────────────────
@app.get("/api/config")
async def api_config(request: Request):
    return _config_payload(request.app)


@app.get("/api/config/services/{svc_id}/yaml")
async def api_service_yaml(request: Request, svc_id: str):
    """Trả node YAML gốc của một service — cho nút Sửa."""
    import yaml as _yaml
    cfg: Config = request.app.state.cfg
    node = next((s for s in cfg.raw.get("services", []) if s.get("id") == svc_id), None)
    if node is None:
        raise HTTPException(404, f"không có service {svc_id!r}")
    return {"yaml": _yaml.safe_dump(node, sort_keys=False, allow_unicode=True, width=100)}


@app.post("/api/config/reload")
async def api_config_reload(request: Request):
    app_ = request.app
    try:
        cfg = cfgmod.load(_config_path())
    except ConfigError as e:
        raise HTTPException(400, str(e)) from None
    app_.state.cfg = cfg
    app_.state.sup.rebind(cfg)
    app_.state.poller.rebind(cfg)
    app_.state.metrics.rebind(cfg)
    app_.state.sup.reconcile()
    return {"ok": True, "services": len(cfg.services)}


# ── API: trạng thái ─────────────────────────────────────────────────────
@app.get("/api/status")
async def api_status(request: Request):
    return _status_payload(request.app)


@app.get("/api/metrics")
async def api_metrics(request: Request, window_s: float = Query(300.0, ge=15, le=600)):
    return request.app.state.metrics.series(window_s=window_s)


# ── API: điều khiển (CHỈ nhận id, không nhận command) ────────────────────
def _svc_or_404(request: Request, svc_id: str):
    cfg: Config = request.app.state.cfg
    if svc_id not in cfg.services:
        raise HTTPException(404, f"không có service {svc_id!r}")
    return cfg.services[svc_id]


def _really_running(app_: FastAPI, svc_id: str) -> bool:
    """Service này CÓ THẬT đang chạy không.

    Chỉ nhìn health là không đủ: hybrid và vLLM dùng chung port 8001/8002/8088,
    nên cpu_inf ONLINE làm health của vllm_embed cũng 200 và panel tưởng cả
    stack vLLM đang chạy. Phải xác nhận có process thật.
    """
    poller: HealthPoller = app_.state.poller
    sup: Supervisor = app_.state.sup
    if poller.state_of(svc_id) not in {"ONLINE", "DEGRADED", "STARTING"}:
        return False
    if sup.state(svc_id).alive:
        return True
    svc = app_.state.cfg.services.get(svc_id)
    if svc and svc.stop and svc.stop.mode == "pkill" and svc.stop.pattern:
        return bool(_pgrep(svc.stop.pattern))
    # không có cách xác minh process → tin health
    return True


def _blocked_by(app_: FastAPI, svc) -> list[str]:
    return [c for c in svc.conflicts_with if _really_running(app_, c)]


def _seq_log(job_log: Path, text: str) -> None:
    job_log.parent.mkdir(parents=True, exist_ok=True)
    with job_log.open("a", encoding="utf-8") as f:
        f.write(f"[{time.strftime('%H:%M:%S')}] {text}\n")


async def _run_member_sequence(app_: FastAPI, svc, job) -> None:
    """Khởi động lần lượt từng member, chờ health từng cái.

    Thay cho start_hybrid.sh: script đó bỏ qua service đang tắt dở (race sau
    Stop) và có lần không khởi động nổi gateway mà không để lại dòng log nào.
    Ở đây mỗi bước đều ghi rõ, và hỏng ở đâu thì dừng ở đó.
    """
    cfg: Config = app_.state.cfg
    sup: Supervisor = app_.state.sup
    poller: HealthPoller = app_.state.poller
    log_path = Path(job.log_path)

    _seq_log(log_path, f"=== {svc.name}: khởi động {len(svc.members)} service ===")
    rc = 0
    try:
        for mid in svc.members:
            member = cfg.services[mid]
            state = poller.state_of(mid)

            if state == "ONLINE":
                _seq_log(log_path, f"[{mid}] đã ONLINE — bỏ qua")
                continue
            if state == "NO_ENV":
                miss = ", ".join(poller.snapshot[mid].missing)
                _seq_log(log_path, f"[{mid}] THIẾU MÔI TRƯỜNG: {miss}")
                rc = 1
                break

            _seq_log(log_path, f"[{mid}] đang khởi động ...")
            try:
                res = await asyncio.to_thread(sup.start, mid)
            except SupervisorError as e:
                _seq_log(log_path, f"[{mid}] LỖI: {e}")
                rc = 1
                break
            poller.wake(mid)
            if res.get("pid"):
                _seq_log(log_path, f"[{mid}] pid={res['pid']}, chờ health ...")

            deadline = time.time() + member.startup_timeout_s
            last = ""
            while time.time() < deadline:
                await asyncio.sleep(2.0)
                st = poller.snapshot.get(mid)
                if st is None:
                    continue
                if st.state == "ONLINE":
                    break
                if st.state != last:
                    last = st.state
                    _seq_log(log_path, f"[{mid}]   ... {st.state}")
                # process chết hẳn thì đừng chờ hết timeout
                if st.state == "OFFLINE" and not sup.state(mid).alive:
                    _seq_log(
                        log_path,
                        f"[{mid}] process đã chết — xem {member.log or 'log'}",
                    )
                    rc = 1
                    break
            else:
                _seq_log(
                    log_path,
                    f"[{mid}] QUÁ HẠN sau {member.startup_timeout_s}s "
                    f"(trạng thái: {poller.state_of(mid)})",
                )
                rc = 1

            if rc:
                break
            if poller.state_of(mid) != "ONLINE":
                rc = 1
                break
            _seq_log(log_path, f"[{mid}] ONLINE ✔")

        if rc == 0:
            _seq_log(log_path, "=== TẤT CẢ ONLINE ===")
            url = poller.public_url()
            if url:
                _seq_log(log_path, f"ngrok: {url}")
                _seq_log(log_path, f"SPEECH_SERVICE_URL={url}")
                _seq_log(log_path, f"INTENT_SERVICE_URL={url}/otg")
        else:
            _seq_log(log_path, "=== DỪNG: có service không lên được ===")
    except asyncio.CancelledError:
        _seq_log(log_path, "=== BỊ HUỶ ===")
        rc = 130
        raise
    except Exception as e:  # noqa: BLE001
        _seq_log(log_path, f"=== LỖI PANEL: {type(e).__name__}: {e} ===")
        rc = 1
    finally:
        job.rc = rc
        job.finished_at = time.time()


@app.post("/api/services/{svc_id}/start")
async def api_start(request: Request, svc_id: str):
    svc = _svc_or_404(request, svc_id)
    poller: HealthPoller = request.app.state.poller

    # chặn khi stack đối lập đang chạy (2 stack đụng port 8001/8002/8088)
    conflicts = _blocked_by(request.app, svc)
    if conflicts:
        raise HTTPException(
            409,
            "đang chạy stack xung đột: " + ", ".join(conflicts) + " — dừng trước đã",
        )
    unmet = [d for d in svc.depends_on if poller.state_of(d) != "ONLINE"]
    if unmet:
        raise HTTPException(409, "cần ONLINE trước: " + ", ".join(unmet))

    # composite do panel tự điều phối
    if svc.start and svc.start.mode == "members":
        sup: Supervisor = request.app.state.sup
        running = [j for j in sup.jobs.values() if j.svc_id == svc_id and j.running]
        if running:
            return {"ok": True, "job_id": running[0].id, "already_running": True}
        log_path = Path(svc.start.job_log or (request.app.state.cfg.log_dir
                                              / f"_job_{svc_id}.log"))
        job = sup.new_job(svc_id, "start", log_path, f"start {svc.name}")
        asyncio.create_task(_run_member_sequence(request.app, svc, job))
        return {"ok": True, "job_id": job.id}

    try:
        res = await asyncio.to_thread(request.app.state.sup.start, svc_id)
    except SupervisorError as e:
        raise HTTPException(400, str(e)) from None
    poller.wake(svc_id)
    return res


@app.post("/api/services/{svc_id}/stop")
async def api_stop(request: Request, svc_id: str):
    _svc_or_404(request, svc_id)
    try:
        res = await asyncio.to_thread(request.app.state.sup.stop, svc_id)
    except SupervisorError as e:
        raise HTTPException(400, str(e)) from None
    request.app.state.poller.wake(svc_id)
    return res


@app.post("/api/services/{svc_id}/restart")
async def api_restart(request: Request, svc_id: str):
    _svc_or_404(request, svc_id)
    try:
        res = await asyncio.to_thread(request.app.state.sup.restart, svc_id)
    except SupervisorError as e:
        raise HTTPException(400, str(e)) from None
    request.app.state.poller.wake(svc_id)
    return res


@app.post("/api/services/{svc_id}/actions/{action_id}")
async def api_action(request: Request, svc_id: str, action_id: str):
    _svc_or_404(request, svc_id)
    try:
        return await asyncio.to_thread(request.app.state.sup.run_action, svc_id, action_id)
    except SupervisorError as e:
        raise HTTPException(400, str(e)) from None


@app.post("/api/services/{svc_id}/truncate-log")
async def api_truncate(request: Request, svc_id: str):
    svc = _svc_or_404(request, svc_id)
    if not svc.log:
        raise HTTPException(400, "service không có log")
    try:
        with open(svc.log, "w"):
            pass
    except OSError as e:
        raise HTTPException(400, str(e)) from None
    return {"ok": True}


# ── API: log ────────────────────────────────────────────────────────────
def _log_path(request: Request, key: str) -> Path:
    cfg: Config = request.app.state.cfg
    sup: Supervisor = request.app.state.sup
    if key in cfg.services and cfg.services[key].log:
        return Path(cfg.services[key].log)
    job = sup.jobs.get(key)
    if job:
        return Path(job.log_path)
    # job log của composite (đường dẫn khai trong start.job_log)
    for svc in cfg.services.values():
        if svc.start and svc.start.job_log and svc.id == key:
            return Path(svc.start.job_log)
    raise HTTPException(404, f"không có log cho {key!r}")


@app.get("/api/services/{key}/log")
async def api_log(request: Request, key: str, lines: int = Query(500, ge=1, le=5000)):
    path = _log_path(request, key)
    return {"path": str(path), "lines": backfill(path, lines)}


@app.get("/api/jobs")
async def api_jobs(request: Request):
    sup: Supervisor = request.app.state.sup
    return [
        {"id": j.id, "svc_id": j.svc_id, "kind": j.kind, "label": j.label,
         "running": j.running, "rc": j.rc, "log": j.log_path,
         "started_at": j.started_at, "finished_at": j.finished_at}
        for j in sorted(sup.jobs.values(), key=lambda j: -j.started_at)
    ]


# ── WebSocket ───────────────────────────────────────────────────────────
@app.websocket("/ws/status")
async def ws_status(ws: WebSocket):
    if not _ws_origin_ok(ws):
        await ws.close(code=4403)
        return
    await ws.accept()
    ws.app.state.status_subs.add(ws)
    try:
        await ws.send_text(json.dumps(_status_payload(ws.app), ensure_ascii=False))
        while True:
            await ws.receive_text()  # giữ kết nối; client không cần gửi gì
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        ws.app.state.status_subs.discard(ws)


@app.websocket("/ws/logs/{key}")
async def ws_logs(ws: WebSocket, key: str):
    if not _ws_origin_ok(ws):
        await ws.close(code=4403)
        return
    await ws.accept()

    cfg: Config = ws.app.state.cfg
    sup: Supervisor = ws.app.state.sup
    path: Path | None = None
    if key in cfg.services:
        svc = cfg.services[key]
        path = Path(svc.log) if svc.log else (
            Path(svc.start.job_log) if svc.start and svc.start.job_log else None
        )
    elif key in sup.jobs:
        path = Path(sup.jobs[key].log_path)

    if path is None:
        await ws.send_text(json.dumps({"type": "error", "text": f"không có log cho {key}"}))
        await ws.close()
        return

    registry: LogRegistry = ws.app.state.logs
    tailer = registry.tailer(path)
    queue = tailer.subscribe()

    async def pump() -> None:
        while True:
            line = await queue.get()
            await ws.send_text(json.dumps({"type": "line", "text": line}, ensure_ascii=False))

    pump_task = asyncio.create_task(pump())
    try:
        await ws.send_text(json.dumps({"type": "open", "path": str(path)}))
        while True:
            # client có thể gửi {"op":"pause"} / {"op":"resume"}; lọc grep làm ở client
            await ws.receive_text()
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        pump_task.cancel()
        tailer.unsubscribe(queue)


# ── API: sửa config ("+ Lệnh" / "Sửa" / "Xóa") ──────────────────────────
# Các endpoint này CHỈ ghi file. Muốn chạy vẫn phải gọi /actions/{id} theo id.
def _guard_write() -> None:
    if cfgmod.readonly():
        raise HTTPException(403, "PANEL_READONLY_CONFIG=1 — config đang khoá")


def _reload_into(app_: FastAPI) -> None:
    cfg = cfgmod.load(_config_path())
    app_.state.cfg = cfg
    app_.state.sup.rebind(cfg)
    app_.state.poller.rebind(cfg)
    app_.state.metrics.rebind(cfg)


@app.post("/api/config/services/{svc_id}/actions")
async def api_add_action(request: Request, svc_id: str):
    _guard_write()
    body = await request.json()
    cfg: Config = request.app.state.cfg
    raw = dict(cfg.raw)
    entry = next((s for s in raw.get("services", []) if s.get("id") == svc_id), None)
    if entry is None:
        raise HTTPException(404, f"không có service {svc_id!r}")

    allowed = {"id", "label", "type", "url", "script", "shell", "cwd", "confirm", "show_output"}
    unknown = set(body) - allowed
    if unknown:
        raise HTTPException(400, f"khoá không hợp lệ: {', '.join(sorted(unknown))}")
    if not body.get("id") or not body.get("label"):
        raise HTTPException(400, "cần `id` và `label`")

    entry.setdefault("actions", []).append(body)
    _try_save(request.app, raw)
    return {"ok": True}


@app.put("/api/config/services/{svc_id}")
async def api_edit_service(request: Request, svc_id: str):
    _guard_write()
    body = await request.json()
    node = body.get("yaml")
    if not isinstance(node, str):
        raise HTTPException(400, "cần trường `yaml` dạng chuỗi")
    import yaml as _yaml
    try:
        parsed = _yaml.safe_load(node)
    except _yaml.YAMLError as e:
        raise HTTPException(400, f"YAML sai: {e}") from None
    if not isinstance(parsed, dict) or parsed.get("id") != svc_id:
        raise HTTPException(400, "node phải là dict và giữ nguyên `id`")

    cfg: Config = request.app.state.cfg
    raw = dict(cfg.raw)
    services = raw.get("services", [])
    for i, s in enumerate(services):
        if s.get("id") == svc_id:
            services[i] = parsed
            break
    else:
        raise HTTPException(404, f"không có service {svc_id!r}")
    _try_save(request.app, raw)
    return {"ok": True}


@app.delete("/api/config/services/{svc_id}")
async def api_delete_service(request: Request, svc_id: str):
    _guard_write()
    cfg: Config = request.app.state.cfg
    raw = dict(cfg.raw)
    before = len(raw.get("services", []))
    raw["services"] = [s for s in raw.get("services", []) if s.get("id") != svc_id]
    if len(raw["services"]) == before:
        raise HTTPException(404, f"không có service {svc_id!r}")
    _try_save(request.app, raw)
    return {"ok": True}


def _try_save(app_: FastAPI, raw: dict) -> None:
    """Ghi rồi reload. Config mới hỏng → rollback, không để panel chết."""
    cfg: Config = app_.state.cfg
    backup = cfgmod.save(cfg.path, raw)
    try:
        _reload_into(app_)
    except ConfigError as e:
        import shutil
        shutil.copy2(backup, cfg.path)
        _reload_into(app_)
        raise HTTPException(400, f"config mới không hợp lệ, đã rollback: {e}") from None
