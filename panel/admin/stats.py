"""Số liệu học tập cho team (Dashboard P2): phiên chơi, điểm phát âm theo từng
từ, thiết bị đang hoạt động. Tổng hợp ở đây (đọc theo trang 1000 dòng) để
trình duyệt chỉ nhận con số.

Ngày tính theo giờ Việt Nam (UTC+7).
"""

from __future__ import annotations

import datetime as dt
from collections import Counter, defaultdict
from typing import Any

from fastapi import APIRouter

router = APIRouter(prefix="/api/admin/stats")

VN = dt.timezone(dt.timedelta(hours=7))
PAGE = 1000
MAX_ROWS = 100_000


async def _all(sb, table: str, select: str, filters: list[tuple[str, str]] | None = None, order: str = "") -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    while len(out) < MAX_ROWS:
        params = [("select", select), *(filters or []), ("limit", str(PAGE)), ("offset", str(len(out)))]
        if order:
            params.append(("order", order))
        rows, _ = await sb.rest("GET", table, params)
        out.extend(rows or [])
        if not rows or len(rows) < PAGE:
            break
    return out


def _parse(ts: str | None) -> dt.datetime | None:
    if not ts:
        return None
    try:
        return dt.datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _day(ts: dt.datetime) -> str:
    return ts.astimezone(VN).date().isoformat()


@router.get("/learning")
async def learning(days: int = 30, min_attempts: int = 3) -> dict[str, Any]:
    from . import routes  # tránh vòng import lúc nạp module
    from .supa import SupaError

    days = max(1, min(365, days))
    min_attempts = max(1, min(1000, min_attempts))
    sb = await routes.POOL.get(routes._settings())
    now = dt.datetime.now(dt.timezone.utc)
    since = now - dt.timedelta(days=days)
    try:
        sessions = await _all(sb, "game_session", "id,profileId,gameId,startedAt,createdAt,score,resultStatus",
                              [("deletedAt", "is.null"), ("createdAt", f"gte.{since.isoformat()}")], "id.asc")
        games = await _all(sb, "game", "id,title")
        stats = await _all(sb, "vocabulary_global_stats", "vocabularyId,attempts,correct,avgScore100,updatedAt")
        tb = await _all(sb, "profile_tinybot_device", "id,profileId,deviceId,connectionStatus,lastSeenAt,isPrimary",
                        [("deletedAt", "is.null")])
    except SupaError as e:
        raise routes._http(e) from e

    # ── phiên chơi ────────────────────────────────────────────────────
    title = {g["id"]: g.get("title") or f"#{g['id']}" for g in games}
    by_day: dict[str, dict[str, Any]] = {}
    for i in range(days - 1, -1, -1):
        d = _day(now - dt.timedelta(days=i))
        by_day[d] = {"day": d, "count": 0, "players": set()}
    by_game: dict[Any, dict[str, Any]] = defaultdict(lambda: {"count": 0, "players": set(), "scores": [], "results": Counter()})
    players: set[Any] = set()
    today = _day(now)
    for s in sessions:
        t = _parse(s.get("startedAt")) or _parse(s.get("createdAt"))
        if not t:
            continue
        d = _day(t)
        if d in by_day:
            by_day[d]["count"] += 1
            by_day[d]["players"].add(s.get("profileId"))
        g = by_game[s.get("gameId")]
        g["count"] += 1
        g["players"].add(s.get("profileId"))
        if isinstance(s.get("score"), (int, float)):
            g["scores"].append(s["score"])
        g["results"][s.get("resultStatus") or "?"] += 1
        players.add(s.get("profileId"))
    last7 = {_day(now - dt.timedelta(days=i)) for i in range(7)}

    # ── điểm phát âm theo từng từ ─────────────────────────────────────
    words = [w for w in stats if (w.get("attempts") or 0) > 0 and w.get("avgScore100") is not None]
    att = sum(w["attempts"] for w in words)
    weighted = round(sum(w["avgScore100"] * w["attempts"] for w in words) / att, 1) if att else None
    plain = round(sum(w["avgScore100"] for w in words) / len(words), 1) if words else None
    hist = [0] * 10
    for w in words:
        hist[min(9, int(w["avgScore100"] // 10))] += 1
    enough = [w for w in words if w["attempts"] >= min_attempts]
    hard = sorted(enough, key=lambda w: (w["avgScore100"], -w["attempts"]))[:20]
    easy = sorted(enough, key=lambda w: (-w["avgScore100"], -w["attempts"]))[:20]
    most = sorted(words, key=lambda w: -w["attempts"])[:20]
    ids = sorted({w["vocabularyId"] for w in hard + easy + most})
    vocab: dict[Any, dict[str, Any]] = {}
    for i in range(0, len(ids), 200):
        chunk = ids[i:i + 200]
        rows, _ = await sb.rest("GET", "vocabulary", [("select", "id,word,level"), ("id", f"in.({','.join(map(str, chunk))})")])
        for r in rows or []:
            vocab[r["id"]] = r

    def wrow(w: dict[str, Any]) -> dict[str, Any]:
        v = vocab.get(w["vocabularyId"], {})
        return {"vocabularyId": w["vocabularyId"], "word": v.get("word"), "level": v.get("level"),
                "avgScore100": round(w["avgScore100"], 1), "attempts": w["attempts"], "correct": w.get("correct")}

    last_update = max((w.get("updatedAt") or "" for w in stats), default="") or None

    # ── thiết bị ──────────────────────────────────────────────────────
    def seen_within(ts: str | None, d: int) -> bool:
        t = _parse(ts)
        return bool(t and now - t <= dt.timedelta(days=d))

    return {
        "days": days,
        "generatedAt": now.isoformat(),
        "sessions": {
            "inRange": len(sessions),
            "today": by_day.get(today, {}).get("count", 0),
            "last7": sum(v["count"] for k, v in by_day.items() if k in last7),
            "players": len(players),
            "byDay": [{"day": v["day"], "count": v["count"], "players": len(v["players"])} for v in by_day.values()],
            "byGame": sorted(
                [{"gameId": k, "title": title.get(k, f"#{k}"), "count": v["count"], "players": len(v["players"]),
                  "avgScore": round(sum(v["scores"]) / len(v["scores"]), 1) if v["scores"] else None,
                  "results": dict(v["results"])} for k, v in by_game.items()],
                key=lambda x: -x["count"]),
        },
        "pronunciation": {
            "words": len(words), "attempts": att, "correct": sum(w.get("correct") or 0 for w in words),
            "avgWeighted": weighted, "avgPlain": plain, "minAttempts": min_attempts,
            "histogram": [{"from": i * 10, "to": i * 10 + 10, "words": n} for i, n in enumerate(hist)],
            "hardest": [wrow(w) for w in hard], "easiest": [wrow(w) for w in easy], "mostPracticed": [wrow(w) for w in most],
            "lastUpdate": last_update,
        },
        "devices": {
            "tinybot": {
                "total": len(tb),
                "active24h": sum(1 for d in tb if seen_within(d.get("lastSeenAt"), 1)),
                "active7d": sum(1 for d in tb if seen_within(d.get("lastSeenAt"), 7)),
                "byStatus": dict(Counter(d.get("connectionStatus") or "?" for d in tb)),
                "list": sorted(tb, key=lambda d: d.get("lastSeenAt") or "", reverse=True),
            },
        },
    }

