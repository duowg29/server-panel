"""Test trang Admin (panel/admin) với một Supabase GIẢ chạy trong bộ nhớ.

    .venv/bin/python selftest_admin.py

Supabase giả (`FakeSupabase`) nói đúng giao thức PostgREST mà admin dùng:
OpenAPI có `<pk/>` / `<fk …/>`, lọc `col=op.val`, `or=(…ilike…)`,
`order`, `limit/offset`, `Prefer: count=exact` → `Content-Range`, RPC. Không
cần mạng, không chạm dữ liệu thật.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


# ── Supabase giả ────────────────────────────────────────────────────────
def _openapi(tables: dict[str, dict[str, Any]], rpcs: list[str]) -> dict[str, Any]:
    defs, paths = {}, {}
    for name, spec in tables.items():
        props = {}
        for col, (typ, fmt, extra) in spec["cols"].items():
            desc = ""
            if col in spec.get("pk", []):
                desc += "Note:\nThis is a Primary Key.<pk/>"
            fk = spec.get("fk", {}).get(col)
            if fk:
                desc += f"Note:\nThis is a Foreign Key to `{fk[0]}.{fk[1]}`.<fk table='{fk[0]}' column='{fk[1]}'/>"
            props[col] = {"type": typ, "format": fmt, **({"description": desc} if desc else {}), **extra}
        defs[name] = {"type": "object", "properties": props, "required": spec.get("required", [])}
        paths[f"/{name}"] = {"get": {}} if spec.get("view") else {"get": {}, "post": {}, "patch": {}, "delete": {}}
    for r in rpcs:
        paths[f"/rpc/{r}"] = {"post": {}}
    return {"swagger": "2.0", "definitions": defs, "paths": paths}


class FakeSupabase:
    def __init__(self) -> None:
        self.tables: dict[str, dict[str, Any]] = {
            "topic": {
                "cols": {
                    "id": ("integer", "bigint", {}),
                    "title": ("string", "text", {}),
                    "learningPathId": ("integer", "bigint", {}),
                    "tags": ("string", "jsonb", {}),
                    "deletedAt": ("string", "timestamp with time zone", {}),
                },
                "pk": ["id"],
                "fk": {"learningPathId": ("learning_path", "id")},
                "required": ["id", "title"],
            },
            "learning_path": {
                "cols": {"id": ("integer", "bigint", {}), "title": ("string", "text", {})},
                "pk": ["id"],
            },
            "stats_view": {"cols": {"n": ("integer", "bigint", {})}, "view": True},
            "unit": {
                "cols": {"id": ("integer", "bigint", {}), "topicId": ("integer", "bigint", {}),
                         "deletedAt": ("string", "timestamp with time zone", {})},
                "pk": ["id"],
            },
            "unit_content": {
                "cols": {"id": ("integer", "bigint", {}), "unitId": ("integer", "bigint", {}),
                         "contentType": ("string", "text", {}), "contentRefId": ("integer", "bigint", {}),
                         "deletedAt": ("string", "timestamp with time zone", {})},
                "pk": ["id"],
            },
        }
        self.rows: dict[str, list[dict[str, Any]]] = {
            "topic": [
                {"id": i, "title": f"Topic {i}" + (" animals" if i % 3 == 0 else ""), "learningPathId": 1 + i % 2,
                 "tags": ["a"], "deletedAt": "2026-01-01T00:00:00+00:00" if i == 7 else None}
                for i in range(1, 26)
            ],
            "learning_path": [{"id": 1, "title": "Path 1"}, {"id": 2, "title": "Path 2"}],
            "stats_view": [{"n": 1}],
            "unit": [{"id": 100 + i, "topicId": 3 if i < 2 else 4, "deletedAt": None} for i in range(3)],
            "unit_content": [
                {"id": 1, "unitId": 100, "contentType": "vocabulary", "contentRefId": 9, "deletedAt": None},
                {"id": 2, "unitId": 101, "contentType": "game", "contentRefId": 9, "deletedAt": None},
                {"id": 3, "unitId": 102, "contentType": "vocabulary", "contentRefId": 9, "deletedAt": None},
            ],
        }
        self.rpcs = ["tt_admin_lesson_snapshot", "tt_admin_topic_create"]
        self.calls: list[tuple[str, str, Any]] = []
        self.app = self._build()

    def _match(self, row: dict[str, Any], col: str, expr: str) -> bool:
        op, _, val = expr.partition(".")
        neg = False
        if op == "not":
            neg = True
            op, _, val = val.partition(".")
        v = row.get(col)
        if op == "in":
            ok = str(v) in val.strip("()").split(",")
        elif op == "is":
            ok = (v is None) if val == "null" else (v is (val == "true"))
        elif op == "eq":
            ok = str(v) == val
        elif op == "neq":
            ok = str(v) != val
        elif op in ("ilike", "like"):
            pat = "^" + re.escape(val.strip('"')).replace(r"\*", ".*") + "$"
            ok = v is not None and re.match(pat, str(v), re.I if op == "ilike" else 0) is not None
        elif op in ("gt", "gte", "lt", "lte"):
            a, b = float(v), float(val)
            ok = {"gt": a > b, "gte": a >= b, "lt": a < b, "lte": a <= b}[op]
        else:
            raise ValueError(op)
        return ok != neg

    def _build(self) -> FastAPI:
        app = FastAPI()
        fake = self

        @app.get("/rest/v1/")
        async def openapi(request: Request):
            if not request.headers.get("apikey"):
                return JSONResponse({"message": "No API key found"}, 401)
            return _openapi(fake.tables, fake.rpcs)

        @app.post("/rest/v1/rpc/{fn}")
        async def rpc(fn: str, request: Request):
            body = await request.json()
            fake.calls.append(("rpc", fn, body))
            if fn not in fake.rpcs:
                return JSONResponse({"code": "PGRST202", "message": f"Could not find the function public.{fn}"}, 404)
            return {"ok": True, "fn": fn, "echo": body}

        @app.api_route("/rest/v1/{table}", methods=["GET", "POST", "PATCH", "DELETE"])
        async def rest(table: str, request: Request):
            if table not in fake.tables:
                return JSONResponse({"code": "42P01", "message": f'relation "{table}" does not exist'}, 404)
            rows = fake.rows[table]
            q = list(request.query_params.multi_items())
            sel = [r for r in rows]
            limit, offset, order = None, 0, None
            for k, v in q:
                if k == "select":
                    continue
                if k == "limit":
                    limit = int(v)
                elif k == "offset":
                    offset = int(v)
                elif k == "order":
                    order = v
                elif k == "or":
                    parts = re.findall(r'(\w+)\.(\w+)\.("(?:[^"\\]|\\.)*"|[^,()]+)', v[1:-1])
                    sel = [r for r in sel if any(fake._match(r, c, f"{op}.{val}") for c, op, val in parts)]
                else:
                    sel = [r for r in sel if fake._match(r, k, v)]
            body = None
            if request.method in ("POST", "PATCH"):
                body = await request.json()
            fake.calls.append((request.method, table, {"q": q, "body": body}))
            if request.method == "GET":
                if order:
                    first = order.split(",")[0].split(".")
                    sel.sort(key=lambda r: (r.get(first[0]) is None, r.get(first[0])), reverse=len(first) > 1 and first[1] == "desc")
                total = len(sel)
                page = sel[offset: offset + limit if limit else None]
                headers = {"Content-Range": f"{offset}-{offset + len(page) - 1}/{total}"}
                return JSONResponse(page, headers=headers)
            if request.method == "POST":
                new = body if isinstance(body, list) else [body]
                if any(r.get("id") is not None and any(x.get("id") == r["id"] for x in rows) for r in new):
                    return JSONResponse({"code": "23505", "message": "duplicate key value violates unique constraint"}, 409)
                rows.extend(new)
                return JSONResponse(new, 201)
            if request.method == "PATCH":
                for r in sel:
                    r.update(body)
                return JSONResponse(sel)
            for r in sel:
                rows.remove(r)
            return Response(status_code=204)

        return app


# ── test ────────────────────────────────────────────────────────────────
FAILS: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        FAILS.append(msg)


async def main() -> int:
    tmp = Path(tempfile.mkdtemp())
    env = tmp / ".env.admin"
    env.write_text("SUPABASE_URL=https://fake.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_test\nADMIN_WRITE_MINUTES=5\n")
    os.environ["PANEL_ADMIN_ENV"] = str(env)
    os.environ["PANEL_DATA_DIR"] = str(tmp)
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"):
        os.environ.pop(k, None)

    from panel.admin import routes, settings  # noqa: E402  (sau khi đặt biến môi trường)
    from panel.admin.supa import _auth_headers

    fake = FakeSupabase()
    routes.POOL._transport = httpx.ASGITransport(app=fake.app)
    app = FastAPI()
    app.include_router(routes.router)
    c = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t")

    print("== cấu hình")
    s = settings.load()
    check(s.configured and s.project_ref == "fake" and s.write_minutes == 5, "đọc .env.admin")
    check(_auth_headers("sb_secret_x") == {"apikey": "sb_secret_x"}, "khoá sb_secret không đi vào Authorization")
    check("Authorization" in _auth_headers("eyJhbGciOi"), "khoá JWT cũ có Authorization")

    print("== trạng thái")
    st = (await c.get("/api/admin/status")).json()
    check(st["ok"] and st["tables"] == len(fake.tables), "kết nối + đếm bảng")
    check("tt_admin_user_account_snapshot" in st["rpcs_missing"] and "tt_admin_topic_create" not in st["rpcs_missing"],
          "báo đúng hàm admin còn thiếu")

    print("== cấu trúc")
    sch = (await c.get("/api/admin/schema")).json()["tables"]
    topic = next(t for t in sch if t["name"] == "topic")
    check(topic["pk"] == ["id"] and topic["softDelete"], "khoá chính + xoá mềm")
    check(next(x for x in topic["columns"] if x["name"] == "learningPathId")["fk"] == {"table": "learning_path", "column": "id"},
          "khoá ngoại")
    check(not next(t for t in sch if t["name"] == "stats_view")["writable"], "view là chỉ đọc")

    print("== đọc")
    r = (await c.get("/api/admin/tables/topic/rows?limit=10")).json()
    check(len(r["rows"]) == 10 and r["total"] == 24, "phân trang + tổng (ẩn dòng đã xoá mềm)")
    r = (await c.get("/api/admin/tables/topic/rows?deleted=deleted")).json()
    check([x["id"] for x in r["rows"]] == [7], "lọc dòng đã xoá")
    r = (await c.get("/api/admin/tables/topic/rows", params={"q": "animals", "limit": 100})).json()
    check(r["total"] == 8 and all("animals" in x["title"] for x in r["rows"]), "tìm chữ (ilike)")
    r = (await c.get("/api/admin/tables/topic/rows", params={"q": "12"})).json()
    check([x["id"] for x in r["rows"]] == [12], "tìm số = id")
    r = (await c.get("/api/admin/tables/topic/rows", params={"f": "learningPathId|eq|2", "order": "id", "desc": "1"})).json()
    check(r["rows"][0]["id"] == 25 and all(x["learningPathId"] == 2 for x in r["rows"]), "bộ lọc + sắp xếp giảm")
    check((await c.get("/api/admin/tables/topic/rows", params={"f": "id|drop|1"})).status_code == 400, "chặn phép lọc lạ")
    check((await c.get("/api/admin/tables/topic/rows", params={"order": "x;drop"})).status_code == 400, "chặn cột lạ")
    check((await c.get("/api/admin/tables/khong_co/rows")).status_code == 404, "bảng không có → 404")
    check((await c.get("/api/admin/tables/a%2Fb/rows")).status_code in (400, 404), "chặn tên bảng lạ")

    print("== chỉ xem chặn ghi")
    r = await c.patch("/api/admin/tables/topic/rows", json={"pk": {"id": 1}, "changes": {"title": "X"}})
    check(r.status_code == 423, "sửa khi chỉ xem → 423")
    r = await c.post("/api/admin/rpc/tt_admin_topic_create", json={"p_title": "x"})
    check(r.status_code == 423, "hàm ghi khi chỉ xem → 423")
    r = await c.post("/api/admin/rpc/tt_admin_lesson_snapshot", json={})
    check(r.status_code == 200, "hàm đọc vẫn chạy khi chỉ xem")
    check((await c.post("/api/admin/rpc/pg_sleep", json={})).status_code == 400, "chỉ gọi được tt_admin_*")

    print("== ghi")
    w = (await c.post("/api/admin/write", json={"on": True})).json()
    check(w["on"] and 0 < w["left_s"] <= 300, "bật ghi theo ADMIN_WRITE_MINUTES")
    r = await c.patch("/api/admin/tables/topic/rows", json={"pk": {"id": 1}, "changes": {"title": "Sửa"}})
    check(r.status_code == 200 and r.json()["row"]["title"] == "Sửa", "sửa một dòng")
    r = await c.patch("/api/admin/tables/topic/rows", json={"pk": {}, "changes": {"title": "Y"}})
    check(r.status_code == 400, "thiếu khoá chính → không sửa hàng loạt")
    r = await c.request("DELETE", "/api/admin/tables/topic/rows", json={"pk": {"id": 2}})
    check(r.json()["soft"] and fake.rows["topic"][1]["deletedAt"], "xoá = xoá mềm")
    r = await c.post("/api/admin/tables/topic/restore", json={"pk": {"id": 2}})
    check(fake.rows["topic"][1]["deletedAt"] is None, "khôi phục")
    r = await c.request("DELETE", "/api/admin/tables/learning_path/rows", json={"pk": {"id": 2}})
    check(not r.json()["soft"] and len(fake.rows["learning_path"]) == 1, "bảng không xoá mềm → xoá hẳn")
    r = await c.post("/api/admin/tables/topic/rows", json={"row": {"id": 99, "title": "Mới"}})
    check(r.status_code == 200 and fake.rows["topic"][-1]["id"] == 99, "thêm dòng")
    r = await c.post("/api/admin/tables/stats_view/rows", json={"row": {"n": 2}})
    check(r.status_code >= 400, "không ghi vào view")
    r = await c.post("/api/admin/rpc/tt_admin_topic_create", json={"p_title": "x"})
    check(r.status_code == 200 and r.json()["echo"] == {"p_title": "x"}, "hàm ghi khi đang cho ghi")
    r = await c.post("/api/admin/rpc/tt_admin_user_account_delete", json={})
    check(r.status_code == 404 and "Could not find" in r.json()["detail"], "lỗi Supabase hiện nguyên văn")

    print("== thêm nhiều dòng / id tự tăng / lọc in")
    r = await c.post("/api/admin/tables/topic/rows", json={"row": {"title": "Tự id"}, "autoId": True})
    check(r.status_code == 200 and r.json()["row"]["id"] == 100, "autoId = MAX(id)+1")
    r = await c.post("/api/admin/tables/topic/bulk", json={"rows": [{"title": "A"}, {"title": "B", "learningPathId": 2}], "autoId": True})
    got = r.json()["rows"] if r.status_code == 200 else []
    check([x["id"] for x in got] == [101, 102] and got[0]["learningPathId"] is None, "nhập hàng loạt, cùng tập cột")
    r = await c.get("/api/admin/tables/topic/rows", params={"f": "id|in|3,5,99"})
    check(sorted(x["id"] for x in r.json()["rows"]) == [3, 5, 99], "lọc in")
    check((await c.get("/api/admin/tables/topic/rows", params={"f": "id|in|1)or(2"})).status_code == 400, "chặn giá trị in lạ")

    print("== xoá mềm theo chuỗi")
    r = await c.post("/api/admin/cms/delete", json={"entity": "topic", "id": 3})
    d = r.json().get("deleted", {})
    check(d == {"topic": 1, "unit": 2, "unit_content": 2}, f"topic → unit → nội dung ({d})")
    check(fake.rows["unit"][2]["deletedAt"] is None and fake.rows["unit_content"][2]["deletedAt"] is None, "không đụng nhánh khác")
    r = await c.post("/api/admin/cms/delete", json={"entity": "topic", "id": 3})
    check(r.status_code == 404, "xoá lại cái đã xoá → 404")
    r = await c.post("/api/admin/cms/delete", json={"entity": "profile", "id": 1})
    check(r.status_code == 400, "chỉ xoá chuỗi cho nội dung học")

    print("== nhật ký")
    log = (await c.get("/api/admin/audit")).json()
    kinds = [x["kind"] for x in log]
    upd = next(x for x in log if x["kind"] == "update" and x["ok"])
    check(upd["detail"]["before"]["title"] == "Topic 1" and upd["detail"]["after"]["title"] == "Sửa", "nhật ký có giá trị cũ / mới")
    check("rpc" in kinds and any(not x["ok"] for x in log), "ghi cả hàm và lệnh lỗi")
    check(not any(x["target"] == "tt_admin_lesson_snapshot" for x in log), "hàm đọc không vào nhật ký")

    await c.post("/api/admin/write", json={"on": False})
    r = await c.patch("/api/admin/tables/topic/rows", json={"pk": {"id": 1}, "changes": {"title": "Z"}})
    check(r.status_code == 423, "tắt ghi là chặn lại ngay")

    await c.aclose()
    await routes.POOL.aclose()
    print()
    print("ADMIN OK" if not FAILS else f"ADMIN FAIL: {len(FAILS)}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
