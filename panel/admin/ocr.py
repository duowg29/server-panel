"""Quét tài liệu lấy từ vựng (thay luồng OCR của tinytalk-admin: Edge Function +
worker Node qua ngrok). Chạy ngay trong panel, chỉ ĐỌC — lưu từ vựng đi qua
/api/admin/tables/vocabulary/bulk (có công tắc ghi + nhật ký).

  PDF có lớp chữ  → pdftotext (poppler-utils)
  PDF scan / ảnh  → tesseract (sudo apt install tesseract-ocr) nếu có
  .txt / .csv     → đọc thẳng
"""

from __future__ import annotations

import asyncio
import base64
import re
import shutil
import tempfile
from collections import Counter
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/api/admin/ocr")

MAX_BYTES = 15 * 1024 * 1024
MAX_WORDS = 400
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'\-]*[A-Za-z]|[A-Za-z]")

STOPWORDS = set("""
a an the and or but if then else when while of in on at to for from by with without about above below over under
into onto out up down off again further once here there where why how all any both each few more most other some
such no nor not only own same so than too very can will just don should now is are was were be been being have has
had having do does did doing i me my myself we our ours ourselves you your yours yourself yourselves he him his himself
she her hers herself it its itself they them their theirs themselves what which who whom this that these those am
would could ought i'm you're he's she's it's we're they're i've you've we've they've i'd you'd he'd she'd we'd they'd
i'll you'll he'll she'll we'll they'll isn't aren't wasn't weren't hasn't haven't hadn't doesn't don't didn't won't
wouldn't shan't shouldn't can't cannot couldn't mustn't let's that's who's what's here's there's when's where's why's
how's also yes one two three page unit lesson exercise www com http https etc vs eg ie
""".split())


def _pages(spec: str | None) -> tuple[int, int] | None:
    if not spec:
        return None
    m = re.fullmatch(r"\s*(\d{1,4})\s*(?:-\s*(\d{1,4}))?\s*", spec)
    if not m:
        raise HTTPException(400, "Trang dạng 3 hoặc 3-7")
    a = int(m.group(1))
    b = int(m.group(2) or a)
    if b < a or b - a > 200:
        raise HTTPException(400, "Khoảng trang không hợp lệ (tối đa 200 trang)")
    return a, b


async def _run(*cmd: str, timeout: float = 90) -> bytes:
    proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except asyncio.TimeoutError as e:
        proc.kill()
        raise HTTPException(504, f"{cmd[0]} chạy quá {int(timeout)} giây") from e
    if proc.returncode != 0:
        raise HTTPException(422, f"{cmd[0]} lỗi: {err.decode(errors='replace')[:300]}")
    return out


def _need(tool: str, hint: str) -> str:
    path = shutil.which(tool)
    if not path:
        raise HTTPException(501, f"Máy chưa có {tool} — {hint}")
    return path


async def extract_text(name: str, data: bytes, pages: tuple[int, int] | None) -> tuple[str, str]:
    """(văn bản, cách lấy)."""
    low = name.lower()
    with tempfile.TemporaryDirectory() as tmp:
        src = Path(tmp) / ("in" + Path(low).suffix)
        src.write_bytes(data)
        if low.endswith(".pdf"):
            exe = _need("pdftotext", "cài poppler-utils")
            args = [exe, "-layout"]
            if pages:
                args += ["-f", str(pages[0]), "-l", str(pages[1])]
            text = (await _run(*args, str(src), "-")).decode("utf-8", errors="replace")
            if len(text.strip()) >= 20:
                return text, "pdftotext"
            # PDF scan (không có lớp chữ): ra ảnh rồi OCR
            tess = _need("tesseract", "PDF này là ảnh scan; cài tesseract-ocr để quét: sudo apt install tesseract-ocr")
            ppm = _need("pdftoppm", "cài poppler-utils")
            args = [ppm, "-r", "200", "-png"]
            if pages:
                args += ["-f", str(pages[0]), "-l", str(pages[1])]
            else:
                args += ["-f", "1", "-l", "20"]
            await _run(*args, str(src), str(Path(tmp) / "p"), timeout=180)
            parts = []
            for img in sorted(Path(tmp).glob("p*.png")):
                parts.append((await _run(tess, str(img), "-", "-l", "eng", timeout=120)).decode("utf-8", errors="replace"))
            return "\n".join(parts), "pdftoppm + tesseract"
        if low.endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")):
            tess = _need("tesseract", "cài tesseract-ocr để quét ảnh: sudo apt install tesseract-ocr")
            return (await _run(tess, str(src), "-", "-l", "eng")).decode("utf-8", errors="replace"), "tesseract"
        if low.endswith((".txt", ".csv", ".md", ".tsv")):
            return data.decode("utf-8", errors="replace"), "văn bản"
    raise HTTPException(415, "Chỉ nhận PDF, ảnh (png/jpg/webp…) hoặc .txt / .csv")


def words_of(text: str) -> list[tuple[str, int]]:
    c: Counter[str] = Counter()
    for m in _WORD_RE.finditer(text):
        w = m.group(0).lower().strip("'-")
        if w.endswith("'s"):
            w = w[:-2]
        if len(w) < 3 or w in STOPWORDS or not re.search(r"[aeiouy]", w):
            continue
        c[w] += 1
    return c.most_common()


@router.post("/extract")
async def extract(body: dict[str, Any]) -> dict[str, Any]:
    """{name, data: base64, pages?: "3-7"} → các từ (tần suất, đã có trong vocabulary chưa)."""
    from . import routes  # tránh vòng import lúc nạp module

    name = str(body.get("name") or "")
    try:
        data = base64.b64decode(body.get("data") or "", validate=True)
    except (ValueError, TypeError) as e:
        raise HTTPException(400, "File không đọc được (base64)") from e
    if not data:
        raise HTTPException(400, "Chưa có file")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "File quá 15 MB")
    text, how = await extract_text(name, data, _pages(body.get("pages")))
    found = words_of(text)
    truncated = len(found) > MAX_WORDS
    found = found[:MAX_WORDS]

    # từ đã có trong bảng vocabulary (đang dùng): word → [cấp]
    existing: dict[str, list[str]] = {}
    sb = await routes.POOL.get(routes._settings())
    simple = [w for w, _ in found if re.fullmatch(r"[a-z][a-z-]*", w)]
    for i in range(0, len(simple), 100):
        chunk = simple[i:i + 100]
        try:
            rows, _ = await sb.rest("GET", "vocabulary", [
                ("select", "word,level"), ("word", f"in.({','.join(chunk)})"), ("deletedAt", "is.null"), ("limit", "1000"),
            ])
        except Exception:  # noqa: BLE001 — thiếu thông tin trùng không chặn việc quét
            continue
        for r in rows or []:
            existing.setdefault(str(r["word"]).lower(), []).append(r.get("level"))
    return {
        "method": how,
        "chars": len(text),
        "preview": text[:2000],
        "truncated": truncated,
        "words": [{"word": w, "count": n, "existing": existing.get(w, [])} for w, n in found],
    }


@router.post("/lookup")
async def lookup(body: dict[str, Any]) -> dict[str, Any]:
    """Tra phiên âm / từ loại / câu ví dụ tiếng Anh (dictionaryapi.dev, miễn phí).
    Nghĩa tiếng Việt vẫn do người soạn điền."""
    words = [str(w).strip().lower() for w in (body.get("words") or []) if str(w).strip()][:40]
    if not words:
        raise HTTPException(400, "Chưa chọn từ nào")
    out: dict[str, Any] = {}
    sem = asyncio.Semaphore(4)

    async with httpx.AsyncClient(timeout=8) as client:
        async def one(w: str) -> None:
            async with sem:
                try:
                    r = await client.get(f"https://api.dictionaryapi.dev/api/v2/entries/en/{w}")
                    data = r.json() if r.status_code == 200 else None
                except (httpx.HTTPError, ValueError):
                    data = None
            if not isinstance(data, list) or not data:
                out[w] = None
                return
            e = data[0]
            phon = e.get("phonetic") or next((p.get("text") for p in e.get("phonetics", []) if p.get("text")), None)
            pos, example = None, None
            for m in e.get("meanings", []):
                pos = pos or m.get("partOfSpeech")
                for d in m.get("definitions", []):
                    if d.get("example"):
                        example = example or d["example"]
            out[w] = {"phonetic": phon, "pos": pos, "example": example}

        await asyncio.gather(*(one(w) for w in words))
    return {"results": out}
