"""Health poller.

Health probe LÀ nguồn sự thật cho badge; PID chỉ dùng để biết gửi signal cho ai.
Nhờ vậy panel hiển thị đúng cả khi service do start_hybrid.sh chạy chứ không
phải panel chạy.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .config import Config, Service, SEVERITY, compile_rule, eval_rule, resolve_path_expr
from .supervisor import Supervisor

log = logging.getLogger("panel.health")

#: sau ngần này lần refuse liên tiếp thì giãn nhịp probe cho đỡ ồn
BACKOFF_AFTER = 5
BACKOFF_INTERVAL_S = 15.0
#: requires_file/bin kiểm lại mỗi 30s (rẻ, nhưng không cần mỗi tick)
ENV_RECHECK_S = 30.0

_DETAIL_RE = re.compile(r"\{([^}]+)\}")


@dataclass
class Fetched:
    """Kết quả một lần GET /health, dùng chung cho mọi service khai cùng URL."""
    payload: Any = None
    latency_ms: int | None = None
    error: str | None = None


@dataclass
class ServiceStatus:
    id: str
    state: str = "UNKNOWN"
    detail: list[str] = field(default_factory=list)
    latency_ms: int | None = None
    error: str | None = None
    checked_at: float = 0.0
    pid: int | None = None
    uptime_s: float | None = None
    external: bool = False
    missing: list[str] = field(default_factory=list)
    public_url: str | None = None
    raw: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id, "state": self.state, "detail": self.detail,
            "latency_ms": self.latency_ms, "error": self.error,
            "checked_at": self.checked_at, "pid": self.pid,
            "uptime_s": self.uptime_s, "external": self.external,
            "missing": self.missing, "public_url": self.public_url,
        }


class HealthPoller:
    def __init__(self, cfg: Config, sup: Supervisor, store=None, on_transition=None) -> None:
        self.cfg = cfg
        self.sup = sup
        #: SeriesStore để lưu latency thành time-series (None = không lưu)
        self.store = store
        #: gọi khi state của một service đổi: (svc_id, prev, new)
        self.on_transition = on_transition
        self.snapshot: dict[str, ServiceStatus] = {
            sid: ServiceStatus(id=sid) for sid in cfg.services
        }
        self._fails: dict[str, int] = {}
        self._next_at: dict[str, float] = {}
        self._env_checked: dict[str, float] = {}
        self._rules: dict[str, dict[str, Any]] = {}
        self._client: httpx.AsyncClient | None = None
        self._compile_rules()

    def rebind(self, cfg: Config) -> None:
        self.cfg = cfg
        for sid in cfg.services:
            self.snapshot.setdefault(sid, ServiceStatus(id=sid))
        for sid in list(self.snapshot):
            if sid not in cfg.services:
                self.snapshot.pop(sid)
        self._compile_rules()

    def _compile_rules(self) -> None:
        self._rules = {}
        for svc in self.cfg.services.values():
            if svc.health and svc.health.rules:
                self._rules[svc.id] = {
                    name: compile_rule(expr) for name, expr in svc.health.rules.items()
                }

    # -- vòng lặp ------------------------------------------------------
    async def run(self) -> None:
        self._client = httpx.AsyncClient(
            timeout=self.cfg.health_timeout_s,
            limits=httpx.Limits(max_connections=16),
        )
        try:
            while True:
                try:
                    await self.tick()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    log.exception("health tick lỗi")
                await asyncio.sleep(min(1.0, self.cfg.health_interval_s))
        finally:
            await self._client.aclose()
            self._client = None

    async def tick(self) -> None:
        now = time.time()
        due = [s for s in self.cfg.services.values()
               if s.kind != "composite" and self._next_at.get(s.id, 0) <= now]

        if due:
            # GỌI MỘT LẦN CHO MỖI URL. Nhiều service khai chung một endpoint
            # health là chuyện bình thường ở đây: cpu_inf và vllm_embed cùng
            # :8001, gpu_chat và vllm_chat cùng :8002, intent và intent_vllm
            # cùng :8088 — chúng là hai cách chạy CÙNG một thứ, chỉ khác profile.
            # Hỏi riêng từng cái là nhân đôi chi phí của endpoint đó, mà /health
            # của Intent API lại ping Postgres trên cloud mỗi lần bị hỏi.
            fetched = await self._fetch_all(due)
            results = await asyncio.gather(
                *(self._probe(s, fetched.get(self._probe_key(s))) for s in due),
                return_exceptions=True,
            )
            for svc, res in zip(due, results):
                if isinstance(res, BaseException):
                    log.debug("probe %s lỗi: %s", svc.id, res)
                    continue
                prev = self.snapshot[svc.id].state if svc.id in self.snapshot else "UNKNOWN"
                self.snapshot[svc.id] = res
                if self.on_transition is not None and prev != res.state:
                    try:
                        self.on_transition(svc.id, prev, res.state)
                    except Exception:
                        # Ghi hồ sơ sự cố mà lỗi thì cũng KHÔNG được làm chết
                        # vòng probe — badge quan trọng hơn.
                        log.exception("on_transition %s lỗi", svc.id)

        # composite: roll-up từ members
        for svc in self.cfg.services.values():
            if svc.kind == "composite":
                self.snapshot[svc.id] = self._rollup(svc)

        self.sup.poll_jobs()

    def wake(self, svc_id: str) -> None:
        """Sau khi Start/Stop → probe lại ngay, bỏ backoff."""
        self._fails[svc_id] = 0
        self._next_at[svc_id] = 0.0

    # -- probe ---------------------------------------------------------
    @staticmethod
    def _probe_key(svc: Service) -> str | None:
        return svc.health.url if svc.health else None

    async def _fetch_all(self, due: list[Service]) -> dict[str, "Fetched"]:
        """Một lần GET cho mỗi URL riêng biệt trong lứa này."""
        urls = {u for u in (self._probe_key(s) for s in due) if u}
        if not urls:
            return {}
        ordered = sorted(urls)
        got = await asyncio.gather(*(self._fetch_one(u) for u in ordered))
        return dict(zip(ordered, got))

    async def _fetch_one(self, url: str) -> "Fetched":
        if self._client is None:
            return Fetched(error="no_client")
        t0 = time.perf_counter()
        try:
            r = await self._client.get(url)
            ms = int((time.perf_counter() - t0) * 1000)
            if r.status_code >= 400:
                return Fetched(latency_ms=ms, error=f"HTTP {r.status_code}")
            try:
                return Fetched(payload=r.json(), latency_ms=ms)
            except ValueError:
                return Fetched(payload={"_text": r.text[:200]}, latency_ms=ms)
        except httpx.HTTPError as e:
            return Fetched(latency_ms=int((time.perf_counter() - t0) * 1000),
                           error=type(e).__name__)

    async def _probe(self, svc: Service, fetched: "Fetched | None" = None) -> ServiceStatus:
        now = time.time()
        st = ServiceStatus(id=svc.id, checked_at=now)

        pid_state = self.sup.state(svc.id)
        st.pid = pid_state.pid
        st.uptime_s = pid_state.uptime_s
        st.external = pid_state.external

        payload: Any = None
        if svc.health and svc.health.url:
            if fetched is None:                      # gọi lẻ (test, wake)
                fetched = await self._fetch_one(svc.health.url)
            payload = fetched.payload
            st.latency_ms = fetched.latency_ms
            st.error = fetched.error

        st.state = self._classify(svc, payload, st)

        if self.store is not None:
            # latency probe: chỉ ghi khi kết nối được, lỗi → None để đường đứt
            self.store.push(
                f"probe.{svc.id}.latency_ms",
                st.latency_ms if st.error is None and st.latency_ms is not None else None,
                now,
            )
            # Trạng thái thành time-series, để vẽ được dải timeline và xem lại
            # qua archive. Dùng ĐÚNG thang SEVERITY của config, không định nghĩa
            # thang thứ hai. Gộp bằng `max` (xem series.DEFAULT_AGG): một ô 30
            # phút có 10 giây OFFLINE thì cả ô đó phải là OFFLINE.
            self.store.push(f"state.{svc.id}", SEVERITY.get(st.state, 3), now)
            self._push_declared_series(svc, payload, now)

        if payload is not None:
            st.raw = payload if isinstance(payload, dict) else {"value": payload}
            st.detail = self._render_detail(svc, payload)
            if svc.health and svc.health.public_url_from:
                v = resolve_path_expr(svc.health.public_url_from, payload)
                st.public_url = v if isinstance(v, str) else None

        # backoff khi cứ refuse mãi
        if st.state in {"OFFLINE", "NO_ENV"}:
            self._fails[svc.id] = self._fails.get(svc.id, 0) + 1
        else:
            self._fails[svc.id] = 0
        base = (svc.health.interval_s if svc.health and svc.health.interval_s
                else self.cfg.health_interval_s)
        # backoff chỉ được LÀM THƯA hơn, không bao giờ dày hơn nhịp đã khai
        interval = (max(BACKOFF_INTERVAL_S, base)
                    if self._fails.get(svc.id, 0) >= BACKOFF_AFTER else base)
        self._next_at[svc.id] = now + interval

        return st

    def _classify(self, svc: Service, payload: Any, st: ServiceStatus) -> str:
        rules = self._rules.get(svc.id, {})

        if payload is not None:
            if "online" in rules and eval_rule(rules["online"], payload):
                return "ONLINE"
            if "starting" in rules and eval_rule(rules["starting"], payload):
                return "STARTING"
            if "degraded" in rules and eval_rule(rules["degraded"], payload):
                return "DEGRADED"
            # có trả lời mà không khớp rule nào → coi là degraded, đừng nói dối OFFLINE
            return "DEGRADED" if rules else "ONLINE"

        # Không kết nối được nhưng process CÒN SỐNG → đang khởi động.
        # Không đặt mốc thời gian: TinySpeech lần đầu phải tải Whisper large-v3
        # (~3GB) rồi mới nghe port — mốc 90s cũ làm card nhảy về OFFLINE giữa
        # chừng, trông như đã chết trong khi vẫn đang tải.
        if self.sup.state(svc.id).alive:
            return "STARTING"

        missing = self._missing(svc)
        if missing:
            st.missing = missing
            return "NO_ENV"
        return "OFFLINE"

    def _push_declared_series(self, svc: Service, payload: Any, now: float) -> None:
        """Đẩy các số đo khai báo ở `health.series` trong services.yaml."""
        if not svc.health or not svc.health.series:
            return
        for spec in svc.health.series:
            key = f"svc.{svc.id}.{spec.name}"
            if payload is None:
                self.store.push(key, None, now)
                continue
            if spec.valid_if and not resolve_path_expr(spec.valid_if, payload):
                self.store.push(key, None, now)   # bẫy số 1: unreachable → khoảng trống
                continue
            v = resolve_path_expr(spec.value, payload)
            self.store.push(key, v if isinstance(v, (int, float)) else None, now)

    def _missing(self, svc: Service) -> list[str]:
        now = time.time()
        last = self._env_checked.get(svc.id, 0)
        cached = self.snapshot.get(svc.id)
        if now - last < ENV_RECHECK_S and cached is not None:
            return cached.missing
        self._env_checked[svc.id] = now
        return self.sup.missing_requirements(svc)

    def _render_detail(self, svc: Service, payload: Any) -> list[str]:
        if not svc.health or not svc.health.detail:
            return []
        out: list[str] = []
        for tpl in svc.health.detail:
            missing = False

            def sub(m: re.Match) -> str:
                nonlocal missing
                v = resolve_path_expr(m.group(1), payload)
                if v is None:
                    missing = True
                    return ""
                return str(v)

            text = _DETAIL_RE.sub(sub, tpl).strip()
            # thiếu giá trị thì bỏ hẳn dòng, đừng hiện "— GB" hay "intents=—"
            if text and not missing:
                out.append(text)
        return out

    def _rollup(self, svc: Service) -> ServiceStatus:
        members = [self.snapshot.get(m) for m in svc.members]
        members = [m for m in members if m is not None]
        if not members:
            return ServiceStatus(id=svc.id, state="UNKNOWN")
        worst = max(members, key=lambda m: SEVERITY.get(m.state, 3))
        online = sum(1 for m in members if m.state == "ONLINE")
        st = ServiceStatus(
            id=svc.id, state=worst.state, checked_at=time.time(),
            detail=[f"{online}/{len(members)} online"],
        )
        # gộp thứ còn thiếu của member, nếu không card composite báo NO_ENV
        # mà không nói thiếu gì
        seen: list[str] = []
        for m in members:
            for x in m.missing:
                if x not in seen:
                    seen.append(x)
        st.missing = seen
        pub = next((m.public_url for m in members if m.public_url), None)
        st.public_url = pub
        return st

    # -- truy vấn ------------------------------------------------------
    def state_of(self, svc_id: str) -> str:
        s = self.snapshot.get(svc_id)
        return s.state if s else "UNKNOWN"

    def public_url(self) -> str | None:
        for s in self.snapshot.values():
            if s.public_url:
                return s.public_url
        return None

    def as_dict(self) -> dict[str, dict[str, Any]]:
        return {sid: s.to_dict() for sid, s in self.snapshot.items()}
