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
    def __init__(self, cfg: Config, sup: Supervisor) -> None:
        self.cfg = cfg
        self.sup = sup
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
            results = await asyncio.gather(
                *(self._probe(s) for s in due), return_exceptions=True
            )
            for svc, res in zip(due, results):
                if isinstance(res, BaseException):
                    log.debug("probe %s lỗi: %s", svc.id, res)
                    continue
                self.snapshot[svc.id] = res

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
    async def _probe(self, svc: Service) -> ServiceStatus:
        now = time.time()
        st = ServiceStatus(id=svc.id, checked_at=now)

        pid_state = self.sup.state(svc.id)
        st.pid = pid_state.pid
        st.uptime_s = pid_state.uptime_s
        st.external = pid_state.external

        payload: Any = None
        if svc.health and svc.health.url and self._client is not None:
            t0 = time.perf_counter()
            try:
                r = await self._client.get(svc.health.url)
                st.latency_ms = int((time.perf_counter() - t0) * 1000)
                if r.status_code >= 400:
                    st.error = f"HTTP {r.status_code}"
                else:
                    try:
                        payload = r.json()
                    except ValueError:
                        payload = {"_text": r.text[:200]}
            except httpx.HTTPError as e:
                st.error = type(e).__name__

        st.state = self._classify(svc, payload, st)
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
        interval = (BACKOFF_INTERVAL_S if self._fails.get(svc.id, 0) >= BACKOFF_AFTER
                    else self.cfg.health_interval_s)
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

        # không kết nối được → có thể đang khởi động, có thể thiếu env
        if st.pid is not None and st.uptime_s is not None and st.uptime_s < 90:
            return "STARTING"

        missing = self._missing(svc)
        if missing:
            st.missing = missing
            return "NO_ENV"
        return "OFFLINE"

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
