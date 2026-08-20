"""Đọc/validate/ghi services.yaml.

Nguyên tắc: services.yaml là TRUSTED INPUT (file trên đĩa, chủ máy sở hữu).
Body HTTP thì KHÔNG — không có đường nào để chuỗi từ request chạm tới Popen.
Xem panel/main.py::_exec_guard.
"""

from __future__ import annotations

import ast
import os
import re
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

# ── Hằng ────────────────────────────────────────────────────────────────
SECRET_KEY_RE = re.compile(r"TOKEN|KEY|SECRET|PASSWORD|AUTH", re.I)

#: pattern pkill quá ngắn / quá chung → cấm, tránh giết nhầm cả máy
FORBIDDEN_PKILL = {"python", "python3", "uvicorn", "node", "bash", "sh", "java"}
MIN_PKILL_LEN = 8

STATES = ("ONLINE", "DEGRADED", "STARTING", "OFFLINE", "NO_ENV", "UNKNOWN")

#: thứ tự nghiêm trọng, dùng để roll-up trạng thái composite (số cao = tệ hơn)
SEVERITY = {"ONLINE": 0, "STARTING": 1, "DEGRADED": 2, "UNKNOWN": 3, "OFFLINE": 4, "NO_ENV": 5}


class ConfigError(Exception):
    """Lỗi khi load/validate services.yaml — hiện nguyên văn lên UI."""


# ── Dataclass ───────────────────────────────────────────────────────────
@dataclass
class Action:
    id: str
    label: str
    type: str  # url | script | shell
    url: str | None = None
    script: str | None = None
    shell: str | None = None
    cwd: str | None = None
    confirm: str | None = None
    show_output: str | None = None  # "modal" | None


@dataclass
class StartSpec:
    mode: str  # process | script
    cwd: str | None = None
    argv: list[str] = field(default_factory=list)
    shell: str | None = None
    script: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    job_log: str | None = None
    timeout_s: int = 900
    requires_file: list[str] = field(default_factory=list)
    requires_bin: list[str] = field(default_factory=list)


@dataclass
class StopSpec:
    mode: str  # pkill | script | none
    pattern: str | None = None
    script: str | None = None
    grace_s: int = 5


@dataclass
class HealthSpec:
    url: str | None = None
    rules: dict[str, str] = field(default_factory=dict)
    detail: list[str] = field(default_factory=list)
    public_url_from: str | None = None


@dataclass
class Service:
    id: str
    name: str
    group: str
    kind: str  # process | composite
    port: int | None = None
    log: str | None = None
    pid_file: str | None = None
    start: StartSpec | None = None
    stop: StopSpec | None = None
    health: HealthSpec | None = None
    members: list[str] = field(default_factory=list)
    depends_on: list[str] = field(default_factory=list)
    conflicts_with: list[str] = field(default_factory=list)
    actions: list[Action] = field(default_factory=list)
    emphasis: str | None = None
    warn_on_start: str | None = None
    log_metrics: dict[str, Any] = field(default_factory=dict)
    note: str | None = None


@dataclass
class Group:
    id: str
    label: str


@dataclass
class Config:
    path: Path
    defaults: dict[str, Any]
    groups: list[Group]
    services: dict[str, Service]
    raw: dict[str, Any]

    @property
    def log_dir(self) -> Path:
        return Path(self.defaults.get("log_dir", "/tmp/tinytalk-hybrid"))

    @property
    def health_interval_s(self) -> float:
        return float(self.defaults.get("health_interval_s", 3))

    @property
    def health_timeout_s(self) -> float:
        return float(self.defaults.get("health_timeout_s", 2))

    def get(self, svc_id: str) -> Service:
        try:
            return self.services[svc_id]
        except KeyError:
            raise ConfigError(f"unknown service id: {svc_id!r}") from None


# ── Safe expression evaluator cho health rule ───────────────────────────
_ALLOWED_NODES = (
    ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.UnaryOp, ast.Not,
    ast.Compare, ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE,
    ast.In, ast.NotIn, ast.Is, ast.IsNot,
    ast.Name, ast.Load, ast.Attribute, ast.Subscript, ast.Constant,
    ast.Tuple, ast.List, ast.Call,
)
_ALLOWED_CALLS = {"len", "bool", "float", "int", "str"}
_SAFE_BUILTINS = {"len": len, "bool": bool, "float": float, "int": int, "str": str}
#: rule viết trong YAML nên chấp nhận luôn true/false/null kiểu YAML
_LITERALS = {"true": True, "false": False, "null": None, "none": None,
             "True": True, "False": False, "None": None}
_ALLOWED_NAMES = {"json", *_ALLOWED_CALLS, *_LITERALS}


def compile_rule(expr: str) -> ast.Expression:
    """Parse rule, chỉ cho phép tập node an toàn. Ném ConfigError nếu vi phạm.

    KHÔNG dùng eval() trên chuỗi tuỳ ý — rule sai fail ngay lúc load config,
    không phải lúc probe.
    """
    try:
        tree = ast.parse(expr, mode="eval")
    except SyntaxError as e:
        raise ConfigError(f"health rule sai cú pháp: {expr!r} ({e})") from None

    for node in ast.walk(tree):
        if not isinstance(node, _ALLOWED_NODES):
            raise ConfigError(
                f"health rule chứa cú pháp không cho phép ({type(node).__name__}): {expr!r}"
            )
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _ALLOWED_CALLS:
                raise ConfigError(f"health rule chỉ được gọi {_ALLOWED_CALLS}: {expr!r}")
        if isinstance(node, ast.Name) and node.id not in _ALLOWED_NAMES:
            raise ConfigError(
                f"health rule chỉ được dùng `json`, true/false/null và {sorted(_ALLOWED_CALLS)}: "
                f"{expr!r} (gặp {node.id!r})"
            )
    return tree


class _Dot(dict):
    """dict cho phép truy cập bằng dấu chấm; key thiếu trả None thay vì ném."""

    def __getattr__(self, item: str) -> Any:
        return _wrap(self.get(item))

    def __getitem__(self, item: Any) -> Any:
        try:
            return _wrap(dict.__getitem__(self, item))
        except KeyError:
            return None


def _wrap(v: Any) -> Any:
    if isinstance(v, dict):
        return _Dot(v)
    if isinstance(v, list):
        return [_wrap(x) for x in v]
    return v


def eval_rule(tree: ast.Expression, payload: Any) -> bool:
    """Chạy rule đã compile trên payload JSON. Lỗi runtime → False."""
    try:
        return bool(eval(  # noqa: S307 - AST đã whitelist ở compile_rule
            compile(tree, "<health-rule>", "eval"),
            {"__builtins__": dict(_SAFE_BUILTINS)},
            {"json": _wrap(payload), **_LITERALS},
        ))
    except Exception:
        return False


def resolve_path_expr(expr: str, payload: Any) -> Any:
    """Đọc `json.a.b[0]` từ payload cho public_url_from."""
    tree = compile_rule(expr)
    try:
        return eval(  # noqa: S307
            compile(tree, "<path-expr>", "eval"),
            {"__builtins__": dict(_SAFE_BUILTINS)},
            {"json": _wrap(payload), **_LITERALS},
        )
    except Exception:
        return None


# ── Load ────────────────────────────────────────────────────────────────
def _expand(value: Any, vars_: dict[str, str]) -> Any:
    """Thay {root} / {log_dir} và ~ trong mọi chuỗi của cây config."""
    if isinstance(value, str):
        out = value
        for k, v in vars_.items():
            out = out.replace("{" + k + "}", v)
        if out.startswith("~"):
            out = os.path.expanduser(out)
        return out
    if isinstance(value, list):
        return [_expand(v, vars_) for v in value]
    if isinstance(value, dict):
        return {k: _expand(v, vars_) for k, v in value.items()}
    return value


def _as_list(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, str):
        return [v]
    return list(v)


def _parse_action(d: dict[str, Any]) -> Action:
    if "id" not in d or "label" not in d:
        raise ConfigError(f"action thiếu id/label: {d}")
    typ = d.get("type", "url")
    if typ not in {"url", "script", "shell"}:
        raise ConfigError(f"action type không hợp lệ: {typ}")
    return Action(
        id=d["id"], label=d["label"], type=typ,
        url=d.get("url"), script=d.get("script"), shell=d.get("shell"),
        cwd=d.get("cwd"), confirm=d.get("confirm"), show_output=d.get("show_output"),
    )


def _parse_service(d: dict[str, Any]) -> Service:
    for key in ("id", "name", "group"):
        if key not in d:
            raise ConfigError(f"service thiếu `{key}`: {d.get('id', d)}")

    start = None
    if "start" in d:
        s = d["start"]
        mode = s.get("mode", "process")
        if mode not in {"process", "script"}:
            raise ConfigError(f"[{d['id']}] start.mode phải là process|script, gặp {mode!r}")
        start = StartSpec(
            mode=mode, cwd=s.get("cwd"), argv=list(s.get("argv") or []),
            shell=s.get("shell"), script=s.get("script"),
            env={k: str(v) for k, v in (s.get("env") or {}).items()},
            job_log=s.get("job_log"), timeout_s=int(s.get("timeout_s", 900)),
            requires_file=_as_list(s.get("requires_file")),
            requires_bin=_as_list(s.get("requires_bin")),
        )
        if mode == "process" and not (start.argv or start.shell):
            raise ConfigError(f"[{d['id']}] start.mode=process cần `argv` hoặc `shell`")
        if mode == "script" and not start.script:
            raise ConfigError(f"[{d['id']}] start.mode=script cần `script`")

    stop = None
    if "stop" in d:
        s = d["stop"]
        mode = s.get("mode", "pkill")
        if mode not in {"pkill", "script", "none"}:
            raise ConfigError(f"[{d['id']}] stop.mode phải là pkill|script|none")
        stop = StopSpec(mode=mode, pattern=s.get("pattern"),
                        script=s.get("script"), grace_s=int(s.get("grace_s", 5)))
        if mode == "pkill":
            _validate_pkill(d["id"], stop.pattern)
        if mode == "script" and not stop.script:
            raise ConfigError(f"[{d['id']}] stop.mode=script cần `script`")

    health = None
    if "health" in d:
        h = d["health"]
        health = HealthSpec(
            url=h.get("url"), rules=dict(h.get("rules") or {}),
            detail=list(h.get("detail") or []),
            public_url_from=h.get("public_url_from"),
        )
        for name, expr in health.rules.items():
            if name not in {"online", "degraded", "starting"}:
                raise ConfigError(f"[{d['id']}] health rule lạ: {name}")
            compile_rule(expr)  # fail-fast
        if health.public_url_from:
            compile_rule(health.public_url_from)

    return Service(
        id=d["id"], name=d["name"], group=d["group"], kind=d.get("kind", "process"),
        port=d.get("port"), log=d.get("log"), pid_file=d.get("pid_file"),
        start=start, stop=stop, health=health,
        members=list(d.get("members") or []),
        depends_on=list(d.get("depends_on") or []),
        conflicts_with=list(d.get("conflicts_with") or []),
        actions=[_parse_action(a) for a in (d.get("actions") or [])],
        emphasis=d.get("emphasis"), warn_on_start=d.get("warn_on_start"),
        log_metrics=dict(d.get("log_metrics") or {}),
        note=d.get("note"),
    )


def _validate_pkill(svc_id: str, pattern: str | None) -> None:
    """Chặn pattern nguy hiểm. Mirror của cơ chế stop_hybrid.sh dùng để né :9199."""
    if not pattern:
        raise ConfigError(f"[{svc_id}] stop.mode=pkill cần `pattern`")
    if len(pattern) < MIN_PKILL_LEN:
        raise ConfigError(
            f"[{svc_id}] pkill pattern quá ngắn ({len(pattern)}<{MIN_PKILL_LEN}): {pattern!r}"
        )
    if pattern.strip() in FORBIDDEN_PKILL:
        raise ConfigError(f"[{svc_id}] pkill pattern quá chung: {pattern!r}")


def load(path: str | Path) -> Config:
    path = Path(path)
    if not path.exists():
        raise ConfigError(f"không tìm thấy config: {path}")
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    defaults = dict(raw.get("defaults") or {})
    vars_ = {
        "root": os.path.expanduser(str(defaults.get("root", ""))),
        "log_dir": os.path.expanduser(str(defaults.get("log_dir", "/tmp/tinytalk-hybrid"))),
        "home": os.path.expanduser("~"),
    }
    defaults["root"] = vars_["root"]
    defaults["log_dir"] = vars_["log_dir"]

    groups = [Group(id=g["id"], label=g.get("label", g["id"]))
              for g in (raw.get("groups") or [])]

    services: dict[str, Service] = {}
    for sd in _expand(raw.get("services") or [], vars_):
        svc = _parse_service(sd)
        if svc.id in services:
            raise ConfigError(f"service id trùng: {svc.id}")
        services[svc.id] = svc

    cfg = Config(path=path, defaults=defaults, groups=groups, services=services, raw=raw)
    _validate_refs(cfg)
    return cfg


def _validate_refs(cfg: Config) -> None:
    gids = {g.id for g in cfg.groups}
    for svc in cfg.services.values():
        if gids and svc.group not in gids:
            raise ConfigError(f"[{svc.id}] group không tồn tại: {svc.group}")
        for ref_name in ("members", "depends_on", "conflicts_with"):
            for ref in getattr(svc, ref_name):
                if ref not in cfg.services:
                    raise ConfigError(f"[{svc.id}] {ref_name} trỏ tới service không có: {ref}")
        if svc.kind == "composite" and not svc.members:
            raise ConfigError(f"[{svc.id}] kind=composite cần `members`")
        # confine path: script phải nằm dưới root hoặc thư mục panel
        for spec in (svc.start, svc.stop):
            script = getattr(spec, "script", None) if spec else None
            if script:
                _confine(svc.id, script, cfg)
        for act in svc.actions:
            if act.script:
                _confine(svc.id, act.script, cfg)


def _confine(svc_id: str, script: str, cfg: Config) -> None:
    root = Path(cfg.defaults.get("root", "/")).resolve()
    panel_dir = Path(__file__).resolve().parent.parent
    p = Path(script).resolve()
    if not (str(p).startswith(str(root)) or str(p).startswith(str(panel_dir))):
        raise ConfigError(
            f"[{svc_id}] script nằm ngoài root ({root}) và thư mục panel: {script}"
        )


# ── Ghi lại (cho "+ Lệnh" / "Sửa" / "Xóa") ──────────────────────────────
def readonly() -> bool:
    return os.environ.get("PANEL_READONLY_CONFIG", "") == "1"


def save(cfg_path: Path, raw: dict[str, Any]) -> Path:
    """Ghi atomic + backup timestamp. Trả về đường dẫn backup."""
    cfg_path = Path(cfg_path)
    backup_dir = cfg_path.parent / ".config-backups"
    backup_dir.mkdir(exist_ok=True)
    backup = backup_dir / f"{cfg_path.stem}-{time.strftime('%Y%m%d-%H%M%S')}.yaml"
    if cfg_path.exists():
        shutil.copy2(cfg_path, backup)

    tmp = cfg_path.with_suffix(cfg_path.suffix + ".tmp")
    tmp.write_text(
        yaml.safe_dump(raw, sort_keys=False, allow_unicode=True, width=100),
        encoding="utf-8",
    )
    os.replace(tmp, cfg_path)
    return backup


def mask_env(env: dict[str, str]) -> dict[str, str]:
    return {k: ("••••" if SECRET_KEY_RE.search(k) and v else v) for k, v in env.items()}
