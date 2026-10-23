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
        "profileId": pid, "name": prof.get("fullname"), "role": prof.get("role"), "avatar": prof.get("profileAvatarUrl"),
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
        rows, _ = await sb.rest("GET", "profile", [("select", "id,fullname,role,createdAt,profileAvatarUrl"),
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
        "profile": {"id": pid, "name": prof.get("fullname"), "role": prof.get("role"), "createdAt": prof.get("createdAt"),
                    "avatar": prof.get("profileAvatarUrl")},
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


# ══ Theo bài học (lộ trình → chủ đề → unit → nội dung) ═════════════════
# Tính từ trước tới nay (tiến độ là luỹ kế), không theo kỳ ngày.
#   profile_learning_progress — mỗi học sinh × mỗi nội dung: status, score
#   game_session.metadata.unitId — phiên chơi trong unit; flashcard có id từ đúng/sai
#   vocabulary_global_stats × vocabulary_unit_map — điểm phát âm theo unit

async def _lesson_data(sb) -> dict[str, Any]:
    alive = [("deletedAt", "is.null")]
    return {
        "paths": await _all(sb, "learning_path", "id,title", alive),
        "topics": await _all(sb, "topic", "id,learningPathId,title,targetLevelMin", alive),
        "units": await _all(sb, "unit", "id,topicId,unitName,displayOrder", alive),
        "contents": await _all(sb, "unit_content", "id,unitId,contentType,contentRefId,isRequired,displayOrder", alive),
        "progress": await _all(sb, "profile_learning_progress",
                               "profileId,unitContentId,status,score,completedAt,updatedAt", alive),
        "sessions": await _all(sb, "game_session",
                               "profileId,gameId,startedAt,createdAt,u:metadata->unitId,"
                               "cv:metadata->correctVocabularyIds,wv:metadata->wrongVocabularyIds", alive),
        "vmap": await _all(sb, "vocabulary_unit_map", "vocabularyId,unitId", alive),
        "wstats": await _all(sb, "vocabulary_global_stats", "vocabularyId,attempts,correct,avgScore100"),
    }


def _num(v: Any) -> int | None:
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _lesson_rollup(d: dict[str, Any]) -> dict[str, Any]:
    unit_of_content = {c["id"]: c["unitId"] for c in d["contents"]}
    required = defaultdict(set)
    for c in d["contents"]:
        if c.get("isRequired", True):
            required[c["unitId"]].add(c["id"])
    words_of = defaultdict(set)
    for m in d["vmap"]:
        words_of[m["unitId"]].add(m["vocabularyId"])
    ws = {w["vocabularyId"]: w for w in d["wstats"] if (w.get("attempts") or 0) > 0 and w.get("avgScore100") is not None}

    u: dict[Any, dict[str, Any]] = defaultdict(lambda: {
        "started": set(), "done": defaultdict(set), "scores": [], "sessions": 0, "players": set(),
        "correct": 0, "wrong": 0, "last": ""})
    for p in d["progress"]:
        uid = unit_of_content.get(p.get("unitContentId"))
        if uid is None:
            continue
        r = u[uid]
        r["started"].add(p["profileId"])
        if p.get("status") == "completed":
            r["done"][p["profileId"]].add(p["unitContentId"])
            if isinstance(p.get("score"), (int, float)):
                r["scores"].append(p["score"])
        r["last"] = max(r["last"], p.get("completedAt") or p.get("updatedAt") or "")
    for s in d["sessions"]:
        uid = _num(s.get("u"))
        if uid is None:
            continue
        r = u[uid]
        r["sessions"] += 1
        r["players"].add(s.get("profileId"))
        r["correct"] += len(_ids(s.get("cv")))
        r["wrong"] += len(_ids(s.get("wv")))
        r["last"] = max(r["last"], s.get("startedAt") or s.get("createdAt") or "")

    def pron(vids: set[int]) -> tuple[float | None, int, int]:
        got = [ws[v] for v in vids if v in ws]
        att = sum(w["attempts"] for w in got)
        avg = round(sum(w["avgScore100"] * w["attempts"] for w in got) / att, 1) if att else None
        return avg, len(got), att

    return {"u": u, "required": required, "words_of": words_of, "pron": pron, "ws": ws}


def _unit_row(unit: dict[str, Any], topic: dict[str, Any], path: dict[str, Any], R: dict[str, Any]) -> dict[str, Any]:
    uid = unit["id"]
    r = R["u"].get(uid)
    req = R["required"].get(uid, set())
    pron, scored, att = R["pron"](R["words_of"].get(uid, set()))
    answered = (r["correct"] + r["wrong"]) if r else 0
    return {
        "unitId": uid, "unit": unit.get("unitName"), "order": unit.get("displayOrder"),
        "topicId": topic.get("id"), "topic": topic.get("title"),
        "pathId": path.get("id"), "path": path.get("title"),
        "contents": len(req), "words": len(R["words_of"].get(uid, set())),
        "learners": len(r["started"]) if r else 0,
        "completed": sum(1 for got in r["done"].values() if req and req <= got) if r else 0,
        "avgScore": round(sum(r["scores"]) / len(r["scores"]), 1) if r and r["scores"] else None,
        "sessions": r["sessions"] if r else 0, "players": len(r["players"]) if r else 0,
        "flashAccuracy": round(r["correct"] * 100 / answered) if answered else None, "flashAnswered": answered,
        "pronAvg": pron, "pronWords": scored, "pronAttempts": att,
        "last": (r["last"] or None) if r else None,
    }


@router.get("/lessons")
@_supa_errors
async def lessons() -> dict[str, Any]:
    from . import routes

    sb = await routes.POOL.get(routes._settings())
    d = await _lesson_data(sb)
    R = _lesson_rollup(d)
    paths = {p["id"]: p for p in d["paths"]}
    topics = {t["id"]: t for t in d["topics"]}
    units = [_unit_row(un, topics.get(un.get("topicId"), {}), paths.get(topics.get(un.get("topicId"), {}).get("learningPathId"), {}), R)
             for un in d["units"]]

    def roll(rows: list[dict[str, Any]]) -> dict[str, Any]:
        att = sum(r["pronAttempts"] for r in rows)
        ans = sum(r["flashAnswered"] for r in rows)
        acc_ok = sum(round((r["flashAccuracy"] or 0) * r["flashAnswered"] / 100) for r in rows)
        return {
            "units": len(rows), "activeUnits": sum(1 for r in rows if r["learners"] or r["sessions"]),
            "words": sum(r["words"] for r in rows), "sessions": sum(r["sessions"] for r in rows),
            "completions": sum(r["completed"] for r in rows),
            "flashAccuracy": round(acc_ok * 100 / ans) if ans else None,
            "pronAvg": round(sum((r["pronAvg"] or 0) * r["pronAttempts"] for r in rows) / att, 1) if att else None,
        }

    by_topic: dict[Any, list[dict[str, Any]]] = defaultdict(list)
    for r in units:
        by_topic[r["topicId"]].append(r)
    learners_topic: dict[Any, set] = defaultdict(set)
    for un in d["units"]:
        x = R["u"].get(un["id"])
        if x:
            learners_topic[un.get("topicId")] |= x["started"] | x["players"]
    topic_rows = []
    for tid, rows in by_topic.items():
        t = topics.get(tid, {})
        topic_rows.append({"topicId": tid, "topic": t.get("title") or f"#{tid}", "level": t.get("targetLevelMin"),
                           "pathId": t.get("learningPathId"), "path": paths.get(t.get("learningPathId"), {}).get("title"),
                           "learners": len(learners_topic.get(tid, set()) - {None}), **roll(rows)})
    path_rows = []
    for pid, p in paths.items():
        rows = [r for r in units if r["pathId"] == pid]
        path_rows.append({"pathId": pid, "path": p.get("title"), "topics": len({r["topicId"] for r in rows}),
                          "learners": len(set().union(*[learners_topic.get(t["topicId"], set()) for t in topic_rows if t["pathId"] == pid]) - {None}),
                          **roll(rows)})
    active = [r for r in units if r["learners"] or r["sessions"]]
    return {
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "paths": sorted(path_rows, key=lambda x: x["pathId"]),
        "topics": sorted(topic_rows, key=lambda x: (-(x["sessions"] + x["completions"]), x["topicId"] or 0)),
        "units": sorted(units, key=lambda x: (-(x["sessions"] + x["learners"]), x["unitId"])),
        "totals": {"units": len(units), "activeUnits": len(active), "completions": sum(r["completed"] for r in units),
                   "sessionsInUnits": sum(r["sessions"] for r in units),
                   "sessionsNoUnit": sum(1 for s in d["sessions"] if _num(s.get("u")) is None)},
    }


@router.get("/lessons/units/{uid}")
@_supa_errors
async def lesson_unit(uid: int) -> dict[str, Any]:
    from . import routes

    sb = await routes.POOL.get(routes._settings())
    d = await _lesson_data(sb)
    unit = next((x for x in d["units"] if x["id"] == uid), None)
    if not unit:
        raise HTTPException(404, "Không có unit này")
    R = _lesson_rollup(d)
    topic = next((t for t in d["topics"] if t["id"] == unit.get("topicId")), {})
    path = next((p for p in d["paths"] if p["id"] == topic.get("learningPathId")), {})
    row = _unit_row(unit, topic, path, R)

    games, _ = await sb.rest("GET", "game", [("select", "id,title")])
    gtitle = {g["id"]: g.get("title") for g in games or []}
    contents = sorted([c for c in d["contents"] if c["unitId"] == uid], key=lambda c: c.get("displayOrder") or 0)
    cids = {c["id"] for c in contents}
    prog = [p for p in d["progress"] if p.get("unitContentId") in cids]
    content_rows = []
    for c in contents:
        ps = [p for p in prog if p["unitContentId"] == c["id"]]
        done = [p for p in ps if p.get("status") == "completed"]
        sc = [p["score"] for p in done if isinstance(p.get("score"), (int, float))]
        label = gtitle.get(c.get("contentRefId")) if c.get("contentType") == "game" else None
        content_rows.append({"id": c["id"], "order": c.get("displayOrder"), "type": c.get("contentType"),
                             "ref": c.get("contentRefId"), "label": label or f"{c.get('contentType')} #{c.get('contentRefId')}",
                             "required": c.get("isRequired", True), "started": len({p['profileId'] for p in ps}),
                             "completed": len({p['profileId'] for p in done}),
                             "avgScore": round(sum(sc) / len(sc), 1) if sc else None})

    # từ của unit: điểm phát âm toàn hệ thống + đúng/sai flashcard trong unit này
    vids = sorted(R["words_of"].get(uid, set()))
    flash: dict[int, list[int]] = defaultdict(lambda: [0, 0])
    for s in d["sessions"]:
        if _num(s.get("u")) == uid:
            for v in _ids(s.get("cv")):
                flash[v][0] += 1
            for v in _ids(s.get("wv")):
                flash[v][1] += 1
    vocab: dict[int, dict[str, Any]] = {}
    for i in range(0, len(vids), 200):
        rows, _ = await sb.rest("GET", "vocabulary", [("select", "id,word,level"), ("id", f"in.({','.join(map(str, vids[i:i + 200]))})")])
        for v in rows or []:
            vocab[v["id"]] = v
    word_rows = []
    for v in vids:
        w = R["ws"].get(v)
        c, x = flash.get(v, [0, 0])
        word_rows.append({"vocabularyId": v, "word": vocab.get(v, {}).get("word"), "level": vocab.get(v, {}).get("level"),
                          "pronAvg": round(w["avgScore100"], 1) if w else None, "pronAttempts": w["attempts"] if w else 0,
                          "correct": c, "wrong": x, "accuracy": round(c * 100 / (c + x)) if c + x else None})
    word_rows.sort(key=lambda r: (r["pronAvg"] if r["pronAvg"] is not None else 101, r["word"] or ""))

    # học sinh: bao nhiêu nội dung bắt buộc đã xong
    req = R["required"].get(uid, set())
    per: dict[Any, dict[str, Any]] = defaultdict(lambda: {"done": set(), "scores": [], "last": ""})
    for p in prog:
        r = per[p["profileId"]]
        if p.get("status") == "completed":
            r["done"].add(p["unitContentId"])
            if isinstance(p.get("score"), (int, float)):
                r["scores"].append(p["score"])
        r["last"] = max(r["last"], p.get("completedAt") or p.get("updatedAt") or "")
    prof = await _profiles(sb, sorted(per))
    learner_rows = sorted([{
        "profileId": k, "name": prof.get(k, {}).get("fullname"), "avatar": prof.get(k, {}).get("profileAvatarUrl"),
        "done": len(v["done"] & req) if req else len(v["done"]), "total": len(req) or len(cids),
        "avgScore": round(sum(v["scores"]) / len(v["scores"]), 1) if v["scores"] else None, "last": v["last"] or None,
    } for k, v in per.items()], key=lambda r: r["last"] or "", reverse=True)

    return {"generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "unit": row,
            "contents": content_rows, "words": word_rows, "learners": learner_rows}
