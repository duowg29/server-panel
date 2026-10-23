"""API của trang Admin: /api/admin/*.

Mọi đường ghi đi qua `_require_write` (công tắc ghi) và `_audit` (nhật ký).
Tên bảng / cột / hàm từ request luôn được đối chiếu với cấu trúc thật của
Supabase (OpenAPI) hoặc danh sách `tt_admin_*` trước khi dùng — chuỗi lạ không
bao giờ được ghép thẳng vào URL.
"""

from __future__ import annotations

import datetime as dt
import os
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from . import rpcs as rpcmod
from . import schema as schemamod
from . import settings as settingsmod
from .guard import AuditLog, WriteGuard
from .supa import SupaError, SupaPool

router = APIRouter(prefix="/api/admin")

_DATA = Path(os.environ.get("PANEL_DATA_DIR", Path(__file__).resolve().parents[2] / "data"))
POOL = SupaPool()
GUARD = WriteGuard()
AUDIT = AuditLog(_DATA / "admin_audit.db")

#: phép lọc cho phép (PostgREST)
OPS = {"eq", "neq", "gt", "gte", "lt", "lte", "ilike", "like", "is"}
_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
MAX_LIMIT = 500


# ── tiện ích ────────────────────────────────────────────────────────────
def _settings() -> settingsmod.AdminSettings:
    s = settingsmod.load()
    if not s.configured:
        raise HTTPException(503, "Chưa cấu hình .env.admin — điền SUPABASE_URL và SUPABASE_SERVICE_ROLE_KEY")
    return s


def _http(e: SupaError) -> HTTPException:
    status = e.status if 400 <= e.status < 500 else 502
    code = f" [{e.code}]" if e.code else ""
    return HTTPException(status, f"Supabase: {e.message}{code}")


def _require_write() -> None:
    if not GUARD.on:
        raise HTTPException(423, "Đang ở chế độ CHỈ XEM — bật 'Cho phép ghi' trước khi sửa dữ liệu")


def _audit(kind: str, target: str, detail: dict[str, Any], ok: bool, error: str | None = None) -> None:
    AUDIT.add(kind, target, detail, ok, error)


async def _doc() -> dict[str, Any]:
    s = _settings()
    try:
        return await POOL.openapi(s)
    except SupaError as e:
        raise _http(e) from e


async def _table(name: str, write: bool = False) -> dict[str, Any]:
    if not _IDENT_RE.match(name):
        raise HTTPException(400, "Tên bảng không hợp lệ")
    t = schemamod.table(await _doc(), name)
    if t is None:
        raise HTTPException(404, f"Không có bảng '{name}'")
    if write and not t["writable"]:
        raise HTTPException(400, f"'{name}' là view chỉ đọc — không sửa được")
    return t


def _pg_value(v: Any) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v)


def _quote(v: str) -> str:
    """Giá trị trong or=(...) của PostgREST: bọc nháy kép, thoát \\ và "."""
    return '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _pk_params(t: dict[str, Any], pk: dict[str, Any]) -> list[tuple[str, str]]:
    if not t["pk"]:
        raise HTTPException(400, f"Bảng '{t['name']}' không có khoá chính — không sửa/xoá từng dòng được")
    missing = [c for c in t["pk"] if c not in pk]
    if missing:
        raise HTTPException(400, f"Thiếu khoá chính: {', '.join(missing)}")
    return [(c, f"eq.{_pg_value(pk[c])}") for c in t["pk"]]


def _check_cols(t: dict[str, Any], cols: list[str]) -> None:
    names = {c["name"] for c in t["columns"]}
    bad = [c for c in cols if c not in names]
    if bad:
        raise HTTPException(400, f"Bảng '{t['name']}' không có cột: {', '.join(bad)}")


# ── trạng thái / công tắc / nhật ký ─────────────────────────────────────
@router.get("/status")
async def status() -> dict[str, Any]:
    s = settingsmod.load()
    out: dict[str, Any] = {
        "configured": s.configured,
        "host": s.host,
        "project": s.project_ref,
        "write": GUARD.state(),
        "write_minutes": s.write_minutes,
        "env_file": str(settingsmod.ENV_FILE),
    }
    if not s.configured:
        out.update(ok=False, error="Chưa cấu hình .env.admin")
        return out
    try:
        doc = await POOL.openapi(s, max_age=60)
    except SupaError as e:
        out.update(ok=False, error=f"Supabase: {e.message}")
        return out
    have = set(schemamod.rpcs(doc))
    out.update(
        ok=True,
        tables=len(doc.get("definitions") or {}),
        rpcs_total=len(rpcmod.KNOWN),
        rpcs_missing=[n for n in rpcmod.KNOWN if n not in have],
    )
    return out


@router.post("/write")
async def write_toggle(body: dict[str, Any]) -> dict[str, Any]:
    s = settingsmod.load()
    if body.get("on"):
        GUARD.enable(s.write_minutes)
        _audit("write", "guard", {"on": True, "minutes": s.write_minutes}, True)
    else:
        GUARD.disable()
        _audit("write", "guard", {"on": False}, True)
    return GUARD.state()


@router.get("/audit")
async def audit(limit: int = 100, target: str | None = None) -> list[dict[str, Any]]:
    return AUDIT.recent(limit, target)


# ── cấu trúc ────────────────────────────────────────────────────────────
@router.get("/schema")
async def schema(refresh: bool = False) -> dict[str, Any]:
    if refresh:
        POOL.openapi_cache = None
    doc = await _doc()
    return {"tables": schemamod.tables(doc)}


# ── bảng: đọc ───────────────────────────────────────────────────────────
@router.get("/tables/{name}/rows")
async def rows(
    name: str,
    limit: int = 50,
    offset: int = 0,
    order: str | None = None,
    desc: bool = False,
    q: str | None = None,
    f: list[str] = Query(default=[]),
    deleted: str = "active",
) -> dict[str, Any]:
    t = await _table(name)
    params: list[tuple[str, str]] = [
        ("select", "*"),
        ("limit", str(max(1, min(MAX_LIMIT, limit)))),
        ("offset", str(max(0, offset))),
    ]
    if order:
        _check_cols(t, [order])
        params.append(("order", f"{order}.{'desc' if desc else 'asc'}.nullslast"))
    elif t["pk"]:
        params.append(("order", ",".join(f"{c}.asc" for c in t["pk"])))
    if t["softDelete"]:
        if deleted == "active":
            params.append(("deletedAt", "is.null"))
        elif deleted == "deleted":
            params.append(("deletedAt", "not.is.null"))
    for spec in f:
        # col|op|value
        parts = spec.split("|", 2)
        if len(parts) != 3:
            raise HTTPException(400, f"Bộ lọc sai dạng: {spec}")
        col, op, val = parts
        _check_cols(t, [col])
        if op not in OPS:
            raise HTTPException(400, f"Phép lọc không hỗ trợ: {op}")
        if op == "is" and val not in ("null", "true", "false"):
            raise HTTPException(400, "Phép 'is' chỉ nhận null / true / false")
        params.append((col, f"{op}.{val}"))
    if q and q.strip():
        needle = q.strip()
        ors = [
            f"{c['name']}.ilike.{_quote('*' + needle + '*')}"
            for c in t["columns"]
            if c["type"] == "string" and c["format"] in ("text", "character varying", "character", "")
        ]
        if needle.lstrip("-").isdigit():
            ors += [f"{c['name']}.eq.{needle}" for c in t["columns"] if c["type"] == "integer"]
        if ors:
            params.append(("or", "(" + ",".join(ors) + ")"))
    sb = await POOL.get(_settings())
    try:
        data, headers = await sb.rest("GET", name, params, prefer="count=exact")
    except SupaError as e:
        raise _http(e) from e
    total = None
    rng = headers.get("content-range") or ""
    if "/" in rng and rng.rsplit("/", 1)[1].isdigit():
        total = int(rng.rsplit("/", 1)[1])
    return {"rows": data or [], "total": total, "table": t}


# ── bảng: ghi ───────────────────────────────────────────────────────────
@router.post("/tables/{name}/rows")
async def insert(name: str, body: dict[str, Any]) -> dict[str, Any]:
    _require_write()
    t = await _table(name, write=True)
    row = body.get("row") or {}
    if not isinstance(row, dict) or not row:
        raise HTTPException(400, "Thiếu dữ liệu dòng mới")
    _check_cols(t, list(row))
    sb = await POOL.get(_settings())
    try:
        data, _ = await sb.rest("POST", name, body=row, prefer="return=representation")
    except SupaError as e:
        _audit("insert", name, {"row": row}, False, e.message)
        raise _http(e) from e
    created = (data or [None])[0]
    _audit("insert", name, {"row": row, "after": created}, True)
    return {"row": created}


async def _one(sb, name: str, pkp: list[tuple[str, str]]) -> dict[str, Any] | None:
    data, _ = await sb.rest("GET", name, [("select", "*"), *pkp, ("limit", "1")])
    return (data or [None])[0]


@router.patch("/tables/{name}/rows")
async def update(name: str, body: dict[str, Any]) -> dict[str, Any]:
    _require_write()
    t = await _table(name, write=True)
    pk = body.get("pk") or {}
    changes = body.get("changes") or {}
    if not isinstance(changes, dict) or not changes:
        raise HTTPException(400, "Không có gì để sửa")
    _check_cols(t, list(changes))
    pkp = _pk_params(t, pk)
    sb = await POOL.get(_settings())
    try:
        before = await _one(sb, name, pkp)
        if before is None:
            raise HTTPException(404, "Không tìm thấy dòng cần sửa")
        data, _ = await sb.rest("PATCH", name, pkp, body=changes, prefer="return=representation")
    except SupaError as e:
        _audit("update", name, {"pk": pk, "changes": changes}, False, e.message)
        raise _http(e) from e
    after = (data or [None])[0]
    _audit("update", name, {"pk": pk, "changes": changes, "before": before, "after": after}, True)
    return {"row": after}


@router.delete("/tables/{name}/rows")
async def delete(name: str, body: dict[str, Any]) -> dict[str, Any]:
    _require_write()
    t = await _table(name, write=True)
    pk = body.get("pk") or {}
    hard = bool(body.get("hard"))
    pkp = _pk_params(t, pk)
    sb = await POOL.get(_settings())
    soft = t["softDelete"] and not hard
    try:
        before = await _one(sb, name, pkp)
        if before is None:
            raise HTTPException(404, "Không tìm thấy dòng cần xoá")
        if soft:
            now = dt.datetime.now(dt.timezone.utc).isoformat()
            await sb.rest("PATCH", name, pkp, body={"deletedAt": now}, prefer="return=minimal")
        else:
            await sb.rest("DELETE", name, pkp, prefer="return=minimal")
    except SupaError as e:
        _audit("delete", name, {"pk": pk, "soft": soft}, False, e.message)
        raise _http(e) from e
    _audit("delete", name, {"pk": pk, "soft": soft, "before": before}, True)
    return {"ok": True, "soft": soft}


@router.post("/tables/{name}/restore")
async def restore(name: str, body: dict[str, Any]) -> dict[str, Any]:
    """Bỏ xoá mềm (deletedAt = null)."""
    _require_write()
    t = await _table(name, write=True)
    if not t["softDelete"]:
        raise HTTPException(400, "Bảng này không xoá mềm")
    pk = body.get("pk") or {}
    pkp = _pk_params(t, pk)
    sb = await POOL.get(_settings())
    try:
        data, _ = await sb.rest("PATCH", name, pkp, body={"deletedAt": None}, prefer="return=representation")
    except SupaError as e:
        _audit("restore", name, {"pk": pk}, False, e.message)
        raise _http(e) from e
    _audit("restore", name, {"pk": pk}, True)
    return {"row": (data or [None])[0]}


# ── hàm tt_admin_* ──────────────────────────────────────────────────────
@router.post("/rpc/{fn}")
async def rpc(fn: str, request: Request) -> Any:
    if not rpcmod.valid(fn):
        raise HTTPException(400, "Chỉ gọi được hàm tt_admin_*")
    try:
        params = await request.json() if (await request.body()) else {}
    except ValueError as e:
        raise HTTPException(400, "Tham số không phải JSON") from e
    if not isinstance(params, dict):
        raise HTTPException(400, "Tham số phải là object")
    read = rpcmod.is_read(fn)
    if not read:
        _require_write()
    sb = await POOL.get(_settings())
    try:
        result = await sb.rpc(fn, params)
    except SupaError as e:
        if not read:
            _audit("rpc", fn, {"params": params}, False, e.message)
        raise _http(e) from e
    if not read:
        preview = result if len(str(result)) < 4000 else str(result)[:4000] + "…"
        _audit("rpc", fn, {"params": params, "result": preview}, True)
    return result
