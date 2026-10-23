"""Cấu trúc bảng đọc từ OpenAPI của PostgREST (bảng nào cũng duyệt được, kể cả
bảng thêm sau — không phải khai báo tay)."""

from __future__ import annotations

import re
from typing import Any

_FK_RE = re.compile(r"<fk table='([^']+)' column='([^']+)'/>")
_PK_MARK = "<pk/>"


def tables(doc: dict[str, Any]) -> list[dict[str, Any]]:
    defs = doc.get("definitions") or {}
    paths = doc.get("paths") or {}
    out = []
    for name, d in sorted(defs.items()):
        path = paths.get(f"/{name}") or {}
        required = set(d.get("required") or [])
        cols = []
        for cname, c in (d.get("properties") or {}).items():
            desc = c.get("description") or ""
            fk = _FK_RE.search(desc)
            cols.append({
                "name": cname,
                "type": c.get("type") or "string",
                "format": c.get("format") or "",
                "pk": _PK_MARK in desc,
                "fk": {"table": fk.group(1), "column": fk.group(2)} if fk else None,
                "required": cname in required,
                "default": c.get("default"),
                "enum": c.get("enum"),
                "maxLength": c.get("maxLength"),
            })
        names = {c["name"] for c in cols}
        out.append({
            "name": name,
            "columns": cols,
            "pk": [c["name"] for c in cols if c["pk"]],
            "softDelete": "deletedAt" in names,
            # view thì PostgREST không có POST/PATCH/DELETE
            "writable": any(m in path for m in ("post", "patch", "delete")),
        })
    return out


def rpcs(doc: dict[str, Any]) -> list[str]:
    return sorted(p[len("/rpc/"):] for p in (doc.get("paths") or {}) if p.startswith("/rpc/"))


def table(doc: dict[str, Any], name: str) -> dict[str, Any] | None:
    for t in tables(doc):
        if t["name"] == name:
            return t
    return None
