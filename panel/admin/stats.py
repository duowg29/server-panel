"""Số liệu học tập cho team (Dashboard P2): phiên chơi, điểm phát âm theo từng
từ, thiết bị đang hoạt động. Tổng hợp ở đây (đọc theo trang 1000 dòng) để
trình duyệt chỉ nhận con số.

Ngày tính theo giờ Việt Nam (UTC+7).
"""

from __future__ import annotations

import datetime as dt
import functools
from collections import Counter, defaultdict
from typing import Any

from fastapi import APIRouter, HTTPException

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


def _supa_errors(f):
    """Lỗi Supabase (kể cả lỗi mạng) → HTTP rõ ràng, không thành 500 trống."""
    @functools.wraps(f)
    async def wrap(*a, **kw):
        from . import routes
        from .supa import SupaError
        try:
            return await f(*a, **kw)
        except SupaError as e:
            raise routes._http(e) from e
    return wrap


@router.get("/learning")
@_supa_errors
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
        talks = await _all(sb, "on_the_go_free_talk_session", FT_SELECT,
                           [("deletedAt", "is.null"), ("startedAt", f"gte.{since.isoformat()}")])
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
    ft_secs = [x for x in (_talk_secs(t) for t in talks) if x is not None]

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
        "freeTalk": {
            "sessions": len(talks),
            "players": len({t.get("profileId") for t in talks}),
            "avgMinutes": round(sum(ft_secs) / len(ft_secs) / 60, 1) if ft_secs else None,
            "avgTurns": round(sum(t.get("turnCount") or 0 for t in talks) / len(talks), 1) if talks else None,
            "byActivity": dict(Counter(t.get("activity") or "free_talk" for t in talks)),
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



# ══ Theo từng học sinh ══════════════════════════════════════════════════
# Nguồn:
#   game_session            — phiên chơi; flashcard ghi correct/wrongVocabularyIds
#   profile_event           — heartbeat-sent (phút online), vocabulary-learned (score100)
#   on_the_go_free_talk_session — Free Talk / Story
# Chỉ lấy đúng trường cần trong metadata (PostgREST `metadata->key`).

GS_SELECT = ("id,profileId,gameId,startedAt,endedAt,createdAt,score,resultStatus,"
             "cv:metadata->correctVocabularyIds,wv:metadata->wrongVocabularyIds,dps:metadata->durationPlayedSec")
FT_SELECT = "id,profileId,startedAt,endedAt,turnCount,resultStatus,dur:metadata->durationSeconds,activity:metadata->>activity"
MAX_SESSION_S = 3 * 3600  # phiên treo (quên đóng) không được tính thành giờ chơi


def _secs(a: str | None, b: str | None) -> float | None:
    t0, t1 = _parse(a), _parse(b)
    if not t0 or not t1:
        return None
    d = (t1 - t0).total_seconds()
    return d if 0 <= d <= MAX_SESSION_S else None


def _sess_secs(s: dict[str, Any]) -> float | None:
    """Thời gian chơi: game tự đo (TinyFarm ghi durationPlayedSec) thì tin số đó —
    phiên hay bị đóng muộn bởi tác vụ quét timeout."""
    d = s.get("dps")
    if isinstance(d, (int, float)) and 0 <= d <= MAX_SESSION_S:
        return float(d)
    return _secs(s.get("startedAt"), s.get("endedAt"))


def _talk_secs(t: dict[str, Any]) -> float | None:
    d = t.get("dur")
    if isinstance(d, (int, float)) and 0 <= d <= MAX_SESSION_S:
        return float(d)
    return _secs(t.get("startedAt"), t.get("endedAt"))


def _ids(v: Any) -> list[int]:
    return [int(x) for x in v if isinstance(x, (int, float, str)) and str(x).isdigit()] if isinstance(v, list) else []


async def _activity(sb, since: dt.datetime, pid: int | None = None) -> dict[str, list[dict[str, Any]]]:
    from . import routes
    from .supa import SupaError

    who = [("profileId", f"eq.{pid}")] if pid is not None else []
    iso = since.isoformat()
    try:
        return {
            "sessions": await _all(sb, "game_session", GS_SELECT,
                                   [("deletedAt", "is.null"), ("createdAt", f"gte.{iso}"), *who], "id.asc"),
            "beats": await _all(sb, "profile_event", "profileId,createdAt,m:metadata->minutesDelta",
                                [("metadata->>actionSlug", "eq.heartbeat-sent"), ("createdAt", f"gte.{iso}"), *who], "id.asc"),
            "learned": await _all(sb, "profile_event", "profileId,createdAt,vid:metadata->vocabularyId,s:metadata->score100",
                                  [("metadata->>actionSlug", "eq.vocabulary-learned"), ("createdAt", f"gte.{iso}"), *who], "id.asc"),
            "talks": await _all(sb, "on_the_go_free_talk_session", FT_SELECT,
                                [("deletedAt", "is.null"), ("startedAt", f"gte.{iso}"), *who], "id.asc"),
            "games": await _all(sb, "game", "id,title"),
        }
    except SupaError as e:
        raise routes._http(e) from e


def _summary(act: dict[str, list[dict[str, Any]]]) -> dict[Any, dict[str, Any]]:
    """Gộp hoạt động theo profileId."""
    title = {g["id"]: g.get("title") or f"#{g['id']}" for g in act["games"]}
    out: dict[Any, dict[str, Any]] = defaultdict(lambda: {
        "sessions": 0, "playSec": 0.0, "games": Counter(), "online": 0.0, "correct": 0, "wrong": 0,
        "scores": [], "talks": 0, "talkSec": 0.0, "turns": 0, "days": set(), "last": "",
    })

    def touch(r: dict[str, Any], ts: str | None) -> None:
        t = _parse(ts)
        if t:
            r["days"].add(_day(t))
            r["last"] = max(r["last"], t.isoformat())

    for s in act["sessions"]:
        r = out[s["profileId"]]
        r["sessions"] += 1
        r["games"][title.get(s.get("gameId"), f"#{s.get('gameId')}")] += 1
        r["playSec"] += _sess_secs(s) or 0
        r["correct"] += len(_ids(s.get("cv")))
        r["wrong"] += len(_ids(s.get("wv")))
        touch(r, s.get("startedAt") or s.get("createdAt"))
    for b in act["beats"]:
        r = out[b["profileId"]]
        r["online"] += b["m"] if isinstance(b.get("m"), (int, float)) else 1
        touch(r, b.get("createdAt"))
    for e in act["learned"]:
        r = out[e["profileId"]]
        if isinstance(e.get("s"), (int, float)):
            r["scores"].append(e["s"])
        touch(r, e.get("createdAt"))
    for t in act["talks"]:
        r = out[t["profileId"]]
        r["talks"] += 1
        r["talkSec"] += _talk_secs(t) or 0
        r["turns"] += t.get("turnCount") or 0
        touch(r, t.get("startedAt"))
    return out


def _row(pid: Any, r: dict[str, Any], prof: dict[str, Any]) -> dict[str, Any]:
    answered = r["correct"] + r["wrong"]
    return {
        "profileId": pid, "name": prof.get("fullname"), "role": prof.get("role"),
        "sessions": r["sessions"], "playMinutes": round(r["playSec"] / 60),
        "onlineMinutes": round(r["online"]), "daysActive": len(r["days"]),
        "topGames": [{"title": k, "count": n} for k, n in r["games"].most_common(3)],
        "flashAnswered": answered, "flashAccuracy": round(r["correct"] * 100 / answered) if answered else None,
        "pronAvg": round(sum(r["scores"]) / len(r["scores"]), 1) if r["scores"] else None,
        "pronCount": len(r["scores"]),
        "talks": r["talks"], "talkMinutes": round(r["talkSec"] / 60),
        "lastActive": r["last"] or None,
    }


async def _profiles(sb, ids: list[Any]) -> dict[Any, dict[str, Any]]:
    out: dict[Any, dict[str, Any]] = {}
    ids = [i for i in ids if i is not None]
    for i in range(0, len(ids), 200):
        rows, _ = await sb.rest("GET", "profile", [("select", "id,fullname,role,createdAt"),
                                                   ("id", f"in.({','.join(map(str, ids[i:i + 200]))})")])
        for p in rows or []:
            out[p["id"]] = p
    return out


@router.get("/learners")
@_supa_errors
async def learners(days: int = 30) -> dict[str, Any]:
    from . import routes

    days = max(1, min(365, days))
    sb = await routes.POOL.get(routes._settings())
    now = dt.datetime.now(dt.timezone.utc)
    summ = _summary(await _activity(sb, now - dt.timedelta(days=days)))
    prof = await _profiles(sb, sorted(summ))
    rows = [_row(pid, r, prof.get(pid, {})) for pid, r in summ.items()]
    rows.sort(key=lambda x: x["lastActive"] or "", reverse=True)
    return {"days": days, "generatedAt": now.isoformat(), "learners": rows}


@router.get("/learners/{pid}")
@_supa_errors
async def learner(pid: int, days: int = 30) -> dict[str, Any]:
    from . import routes

    days = max(1, min(365, days))
    sb = await routes.POOL.get(routes._settings())
    now = dt.datetime.now(dt.timezone.utc)
    act = await _activity(sb, now - dt.timedelta(days=days), pid)
    prof = (await _profiles(sb, [pid])).get(pid)
    if not prof:
        raise HTTPException(404, "Không có profile này")
    r = _summary(act).get(pid)
    title = {g["id"]: g.get("title") or f"#{g['id']}" for g in act["games"]}

    # theo ngày
    by_day: dict[str, dict[str, Any]] = {}
    for i in range(days - 1, -1, -1):
        d = _day(now - dt.timedelta(days=i))
        by_day[d] = {"day": d, "sessions": 0, "minutes": 0.0}
    for s in act["sessions"]:
        t = _parse(s.get("startedAt") or s.get("createdAt"))
        if t and _day(t) in by_day:
            by_day[_day(t)]["sessions"] += 1
    for b in act["beats"]:
        t = _parse(b.get("createdAt"))
        if t and _day(t) in by_day:
            by_day[_day(t)]["minutes"] += b["m"] if isinstance(b.get("m"), (int, float)) else 1

    # theo từ: flashcard đúng/sai + điểm phát âm
    words: dict[int, dict[str, Any]] = defaultdict(lambda: {"correct": 0, "wrong": 0, "scores": [], "last": ""})
    for s in act["sessions"]:
        ts = s.get("startedAt") or s.get("createdAt") or ""
        for key, field in (("cv", "correct"), ("wv", "wrong")):
            for v in _ids(s.get(key)):
                words[v][field] += 1
                words[v]["last"] = max(words[v]["last"], ts)
    for e in act["learned"]:
        v = e.get("vid")
        if isinstance(v, (int, float)) and isinstance(e.get("s"), (int, float)):
            words[int(v)]["scores"].append(e["s"])
            words[int(v)]["last"] = max(words[int(v)]["last"], e.get("createdAt") or "")
    vocab: dict[int, dict[str, Any]] = {}
    ids = sorted(words)
    for i in range(0, len(ids), 200):
        rows, _ = await sb.rest("GET", "vocabulary", [("select", "id,word,level"),
                                                      ("id", f"in.({','.join(map(str, ids[i:i + 200]))})")])
        for v in rows or []:
            vocab[v["id"]] = v
    word_rows = []
    for vid, w in words.items():
        n = w["correct"] + w["wrong"]
        word_rows.append({
            "vocabularyId": vid, "word": vocab.get(vid, {}).get("word"), "level": vocab.get(vid, {}).get("level"),
            "correct": w["correct"], "wrong": w["wrong"], "accuracy": round(w["correct"] * 100 / n) if n else None,
            "pronAvg": round(sum(w["scores"]) / len(w["scores"]), 1) if w["scores"] else None,
            "pronCount": len(w["scores"]), "last": w["last"] or None,
        })
    word_rows.sort(key=lambda x: (x["accuracy"] if x["accuracy"] is not None else 101, -(x["wrong"])))

    games: dict[str, dict[str, Any]] = defaultdict(lambda: {"count": 0, "scores": [], "secs": 0.0})
    for s in act["sessions"]:
        g = games[title.get(s.get("gameId"), f"#{s.get('gameId')}")]
        g["count"] += 1
        g["secs"] += _sess_secs(s) or 0
        if isinstance(s.get("score"), (int, float)):
            g["scores"].append(s["score"])
    recent = sorted(act["sessions"], key=lambda s: s.get("startedAt") or s.get("createdAt") or "", reverse=True)[:60]

    return {
        "days": days, "generatedAt": now.isoformat(),
        "profile": {"id": pid, "name": prof.get("fullname"), "role": prof.get("role"), "createdAt": prof.get("createdAt")},
        "summary": _row(pid, r, prof) if r else None,
        "byDay": [{"day": v["day"], "sessions": v["sessions"], "minutes": round(v["minutes"])} for v in by_day.values()],
        "words": word_rows,
        "games": sorted([{"title": k, "count": v["count"], "minutes": round(v["secs"] / 60),
                          "avgScore": round(sum(v["scores"]) / len(v["scores"]), 1) if v["scores"] else None}
                         for k, v in games.items()], key=lambda x: -x["count"]),
        "recent": [{"id": s["id"], "game": title.get(s.get("gameId"), f"#{s.get('gameId')}"),
                    "startedAt": s.get("startedAt") or s.get("createdAt"),
                    "minutes": round((_sess_secs(s) or 0) / 60, 1),
                    "score": s.get("score"), "result": s.get("resultStatus"),
                    "correct": len(_ids(s.get("cv"))), "wrong": len(_ids(s.get("wv")))} for s in recent],
        "talks": [{"startedAt": t.get("startedAt"), "activity": t.get("activity") or "free_talk",
                   "minutes": round((_talk_secs(t) or 0) / 60, 1), "turns": t.get("turnCount"),
                   "result": t.get("resultStatus")}
                  for t in sorted(act["talks"], key=lambda t: t.get("startedAt") or "", reverse=True)[:40]],
    }
