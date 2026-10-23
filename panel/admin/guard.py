"""Công tắc "Cho phép ghi" + nhật ký thay đổi.

Supabase chỉ có một bản thật: mở admin là CHỈ XEM. Muốn sửa phải bật công tắc,
tự tắt sau N phút. Backend chặn mọi lệnh ghi khi công tắc tắt (không chỉ ẩn
nút trên UI). Mọi lệnh ghi — thành công hay lỗi — vào nhật ký SQLite kèm giá
trị cũ / mới để khôi phục được.
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any


class WriteGuard:
    def __init__(self) -> None:
        self._until = 0.0

    def enable(self, minutes: int) -> float:
        self._until = time.time() + minutes * 60
        return self._until

    def disable(self) -> None:
        self._until = 0.0

    @property
    def until(self) -> float:
        return self._until if self.on else 0.0

    @property
    def on(self) -> bool:
        return time.time() < self._until

    def state(self) -> dict[str, Any]:
        return {"on": self.on, "until": self.until, "left_s": max(0, int(self.until - time.time())) if self.on else 0}


class AuditLog:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._db.execute(
                """CREATE TABLE IF NOT EXISTS audit (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts REAL NOT NULL,
                    kind TEXT NOT NULL,      -- insert / update / delete / rpc / auth
                    target TEXT NOT NULL,    -- bảng hoặc tên hàm
                    ok INTEGER NOT NULL,
                    detail TEXT NOT NULL,    -- json: tham số, giá trị cũ / mới
                    error TEXT
                )"""
            )
            self._db.commit()

    def add(self, kind: str, target: str, detail: dict[str, Any], ok: bool, error: str | None = None) -> int:
        with self._lock:
            cur = self._db.execute(
                "INSERT INTO audit(ts, kind, target, ok, detail, error) VALUES (?,?,?,?,?,?)",
                (time.time(), kind, target, 1 if ok else 0, json.dumps(detail, ensure_ascii=False, default=str), error),
            )
            self._db.commit()
            return int(cur.lastrowid or 0)

    def recent(self, limit: int = 100, target: str | None = None) -> list[dict[str, Any]]:
        q = "SELECT id, ts, kind, target, ok, detail, error FROM audit"
        args: list[Any] = []
        if target:
            q += " WHERE target = ?"
            args.append(target)
        q += " ORDER BY id DESC LIMIT ?"
        args.append(max(1, min(1000, limit)))
        with self._lock:
            rows = self._db.execute(q, args).fetchall()
        return [
            {"id": r[0], "ts": r[1], "kind": r[2], "target": r[3], "ok": bool(r[4]),
             "detail": json.loads(r[5]), "error": r[6]}
            for r in rows
        ]
