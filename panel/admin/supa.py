"""Gọi Supabase bằng khoá service_role (PostgREST, RPC, Auth admin).

Không bao giờ trả khoá ra ngoài; lỗi Supabase được rút gọn thành SupaError
(mã + thông điệp) để hiện lên UI.
"""

from __future__ import annotations

import time
from typing import Any

import httpx

from .settings import AdminSettings


class SupaError(Exception):
    def __init__(self, status: int, message: str, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def _err(r: httpx.Response) -> SupaError:
    try:
        b = r.json()
    except ValueError:
        b = {"message": r.text[:300]}
    if not isinstance(b, dict):
        b = {"message": str(b)[:300]}
    msg = b.get("message") or b.get("msg") or b.get("error_description") or b.get("error") or f"HTTP {r.status_code}"
    if b.get("details"):
        msg = f"{msg} — {b['details']}"
    if b.get("hint"):
        msg = f"{msg} (gợi ý: {b['hint']})"
    return SupaError(r.status_code, str(msg), b.get("code") or b.get("error_code"))


def _auth_headers(key: str) -> dict[str, str]:
    """Khoá kiểu mới (`sb_secret_…`) chỉ đi trong `apikey` — không phải JWT nên
    không được đặt vào Authorization. Khoá cũ (JWT `service_role`) thì cần cả hai."""
    if key.startswith("sb_"):
        return {"apikey": key}
    return {"apikey": key, "Authorization": f"Bearer {key}"}


class Supa:
    def __init__(self, settings: AdminSettings, transport: httpx.AsyncBaseTransport | None = None):
        if not settings.configured:
            raise SupaError(503, "Chưa cấu hình .env.admin (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)")
        self.s = settings
        self._client = httpx.AsyncClient(
            base_url=settings.url,
            timeout=httpx.Timeout(40.0, connect=10.0),
            headers=_auth_headers(settings.key),
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _send(self, method: str, url: str, **kw: Any) -> httpx.Response:
        """Gửi request; kết nối giữ sẵn trong pool bị Supabase đóng lúc nhàn
        rỗi thì lệnh ĐỌC được gửi lại một lần. Lệnh ghi không gửi lại (có thể
        đã chạy rồi) — báo lỗi mạng cho người dùng tự kiểm."""
        tries = 2 if method in ("GET", "HEAD") else 1
        for i in range(tries):
            try:
                return await self._client.request(method, url, **kw)
            except (httpx.ReadError, httpx.RemoteProtocolError, httpx.ConnectError, httpx.WriteError) as e:
                if i + 1 >= tries:
                    raise SupaError(502, f"Lỗi mạng khi gọi Supabase ({type(e).__name__}) — thử lại") from e
            except httpx.TimeoutException as e:
                raise SupaError(504, "Supabase trả lời quá lâu — thử lại") from e
        raise AssertionError("unreachable")

    # ── PostgREST ────────────────────────────────────────────────────
    async def openapi(self) -> dict[str, Any]:
        r = await self._send("GET", "/rest/v1/", headers={"Accept": "application/openapi+json"})
        if r.status_code >= 400:
            raise _err(r)
        return r.json()

    async def rpc(self, name: str, params: dict[str, Any] | None = None) -> Any:
        r = await self._send("POST", f"/rest/v1/rpc/{name}", json=params or {})
        if r.status_code >= 400:
            raise _err(r)
        if not r.content:
            return None
        try:
            return r.json()
        except ValueError:
            return r.text

    async def rest(
        self,
        method: str,
        table: str,
        params: list[tuple[str, str]] | None = None,
        body: Any = None,
        prefer: str | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> tuple[Any, httpx.Headers]:
        headers = dict(extra_headers or {})
        if prefer:
            headers["Prefer"] = prefer
        r = await self._send(method, f"/rest/v1/{table}", params=params, json=body, headers=headers)
        if r.status_code >= 400:
            raise _err(r)
        data = r.json() if r.content else None
        return data, r.headers

    # ── Auth admin ───────────────────────────────────────────────────
    async def auth(self, method: str, path: str, params: dict[str, Any] | None = None, body: Any = None) -> Any:
        r = await self._send(method, f"/auth/v1/admin/{path}", params=params, json=body)
        if r.status_code >= 400:
            raise _err(r)
        return r.json() if r.content else None

    # ── Storage ──────────────────────────────────────────────────────
    async def storage(self, method: str, path: str, body: Any = None, params: dict[str, Any] | None = None) -> Any:
        r = await self._send(method, f"/storage/v1/{path}", json=body, params=params)
        if r.status_code >= 400:
            raise _err(r)
        return r.json() if r.content else None


class SupaPool:
    """Một client cho mỗi cấu hình; đổi .env.admin là dựng client mới."""

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None):
        self._client: Supa | None = None
        self._for: AdminSettings | None = None
        self._transport = transport
        self.openapi_cache: tuple[float, dict[str, Any]] | None = None

    async def get(self, settings: AdminSettings) -> Supa:
        if self._client is None or self._for != settings:
            if self._client is not None:
                await self._client.aclose()
            self._client = Supa(settings, self._transport)
            self._for = settings
            self.openapi_cache = None
        return self._client

    async def openapi(self, settings: AdminSettings, max_age: float = 300) -> dict[str, Any]:
        sb = await self.get(settings)
        now = time.monotonic()
        if self.openapi_cache and now - self.openapi_cache[0] < max_age:
            return self.openapi_cache[1]
        doc = await sb.openapi()
        self.openapi_cache = (now, doc)
        return doc

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
