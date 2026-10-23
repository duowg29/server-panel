"""Đọc `.env.admin` (cạnh services.yaml). Đọc lại khi file đổi — điền khoá xong
không cần khởi động lại panel."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

ENV_FILE = Path(os.environ.get("PANEL_ADMIN_ENV", Path(__file__).resolve().parents[2] / ".env.admin"))


@dataclass(frozen=True)
class AdminSettings:
    url: str = ""
    key: str = ""
    write_minutes: int = 15
    avatar_bucket: str = "public-assets"

    @property
    def configured(self) -> bool:
        return bool(self.url and self.key)

    @property
    def avatar_base(self) -> str:
        """profile.profileAvatarUrl lưu đường dẫn trong bucket công khai
        (vd. avatars/<uid>/<file>.webp) — ghép thành URL xem được."""
        return f"{self.url}/storage/v1/object/public/{self.avatar_bucket}/" if self.url else ""

    @property
    def host(self) -> str:
        return urlparse(self.url).netloc

    @property
    def project_ref(self) -> str:
        return self.host.split(".", 1)[0] if self.host else ""


_cache: tuple[float, AdminSettings] | None = None


def _parse(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
            v = v[1:-1]
        out[k.strip()] = v
    return out


def load(path: Path | None = None) -> AdminSettings:
    """Cấu hình hiện tại. Biến môi trường cùng tên đè lên file (dùng cho test)."""
    global _cache
    p = path or ENV_FILE
    try:
        mtime = p.stat().st_mtime
    except OSError:
        mtime = -1.0
    if path is None and _cache and _cache[0] == mtime:
        return _cache[1]
    vals = _parse(p.read_text(encoding="utf-8")) if mtime >= 0 else {}
    for k in ("SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ADMIN_WRITE_MINUTES", "ADMIN_AVATAR_BUCKET"):
        if os.environ.get(k):
            vals[k] = os.environ[k]
    try:
        minutes = max(1, min(240, int(vals.get("ADMIN_WRITE_MINUTES") or 15)))
    except ValueError:
        minutes = 15
    s = AdminSettings(
        url=(vals.get("SUPABASE_URL") or "").rstrip("/"),
        key=vals.get("SUPABASE_SERVICE_ROLE_KEY") or "",
        write_minutes=minutes,
        avatar_bucket=(vals.get("ADMIN_AVATAR_BUCKET") or "public-assets").strip("/"),
    )
    if path is None:
        _cache = (mtime, s)
    return s
