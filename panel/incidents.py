"""Hồ sơ sự cố — chốt lại hiện trường ngay lúc service chết.

Vì sao cần: badge đổi màu là thứ chỉ tồn tại khi có người đang nhìn màn hình.
Service chết lúc 3h sáng, hoặc lúc bạn đang ở tab khác, thì đến khi quay lại chỉ
còn thấy OFFLINE — không còn gì để biết vì sao. Log thì vẫn đó nhưng đã trôi
thêm hàng nghìn dòng, và không ai nhớ chính xác phút nào nó gãy.

Nên: đúng khoảnh khắc trạng thái chuyển xấu, chụp lại N dòng cuối của log service
đó kèm mốc thời gian. Ghi cả ra `incidents.jsonl` để sống sót qua lần restart
panel.
"""

from __future__ import annotations

import json
import logging
import time
from collections import deque
from pathlib import Path
from typing import Any

log = logging.getLogger("panel.incidents")

#: số dòng log chụp lại quanh lúc gãy
TAIL_LINES = 50
#: chỉ đọc phần đuôi file — log Whisper có thể vài trăm MB
TAIL_BYTES = 256 * 1024
#: giữ trong RAM bấy nhiêu bản ghi gần nhất
KEEP = 200

#: trạng thái coi là "hỏng" khi rơi vào từ ONLINE
BAD_STATES = {"OFFLINE", "DEGRADED", "NO_ENV"}


def tail_lines(path: str | Path | None, n: int = TAIL_LINES) -> list[str]:
    if not path:
        return []
    try:
        p = Path(path)
        size = p.stat().st_size
        with p.open("rb") as f:
            f.seek(max(0, size - TAIL_BYTES))
            raw = f.read()
    except OSError as e:
        return [f"(không đọc được log: {e})"]

    text = raw.decode("utf-8", "replace")
    # tqdm ghi bằng \r; đổi hết về \n nếu không cả thanh tiến trình dồn thành
    # một dòng khổng lồ.
    lines = [ln.rstrip() for ln in text.replace("\r", "\n").splitlines() if ln.strip()]
    return lines[-n:]


class IncidentLog:
    def __init__(self, path: Path, keep: int = KEEP) -> None:
        self.path = path
        self.items: deque[dict[str, Any]] = deque(maxlen=keep)
        self._seq = 0
        self._load()

    def _load(self) -> None:
        """Nạp lại lịch sử để restart panel không mất hồ sơ cũ."""
        if not self.path.exists():
            return
        try:
            with self.path.open("r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        self.items.append(json.loads(line))
                    except ValueError:
                        continue
        except OSError as e:
            log.warning("không đọc được %s: %s", self.path, e)
        self._seq = max((int(i.get("id", 0)) for i in self.items), default=0)

    def record(
        self,
        *,
        svc_id: str,
        name: str,
        prev: str,
        state: str,
        log_path: str | None = None,
    ) -> dict[str, Any]:
        self._seq += 1
        down = state in BAD_STATES
        item = {
            "id": self._seq,
            "ts": time.time(),
            "svc_id": svc_id,
            "name": name,
            "prev": prev,
            "state": state,
            "kind": "down" if down else "up",
            # Chỉ chụp log khi gãy. Lúc hồi phục thì đuôi log là dòng khởi động,
            # chẳng nói lên điều gì.
            "tail": tail_lines(log_path) if down else [],
            "log": log_path if down else None,
        }
        self.items.append(item)
        self._append(item)
        log.info("sự cố: %s %s → %s", svc_id, prev, state)
        return item

    def alert(self, *, source: str, name: str, text: str, kind: str = "down") -> dict[str, Any]:
        """Cảnh báo không đến từ chuyển trạng thái service (đĩa đầy, …)."""
        self._seq += 1
        item = {
            "id": self._seq,
            "ts": time.time(),
            "svc_id": source,
            "name": name,
            "prev": "",
            "state": text,
            "kind": kind,
            "tail": [],
            "log": None,
        }
        self.items.append(item)
        self._append(item)
        log.warning("cảnh báo: %s — %s", name, text)
        return item

    def _append(self, item: dict[str, Any]) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(item, ensure_ascii=False) + "\n")
        except OSError as e:
            log.warning("không ghi được %s: %s", self.path, e)

    def recent(self, n: int = 20) -> list[dict[str, Any]]:
        """Bản rút gọn cho payload đẩy 2s/lần — KHÔNG kèm tail cho nhẹ."""
        out = []
        for item in list(self.items)[-n:]:
            slim = {k: v for k, v in item.items() if k != "tail"}
            slim["tail_lines"] = len(item.get("tail") or [])
            out.append(slim)
        return out

    def get(self, incident_id: int) -> dict[str, Any] | None:
        for item in reversed(self.items):
            if int(item.get("id", -1)) == incident_id:
                return item
        return None

    def clear(self) -> None:
        self.items.clear()
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            pass


def should_record(prev: str, state: str) -> bool:
    """Lọc nhiễu: chỉ quan tâm ONLINE gãy xuống, và lúc hồi phục trở lại.

    Bỏ qua mọi thứ đi qua UNKNOWN/STARTING — panel vừa khởi động hoặc service
    đang tải model 3 GB không phải là sự cố.
    """
    if prev == state:
        return False
    if prev == "ONLINE" and state in BAD_STATES:
        return True
    if prev in BAD_STATES and state == "ONLINE":
        return True
    return False
