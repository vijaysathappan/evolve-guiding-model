"""
Evolve GM — Token Usage Analytics service.

This is a small, standalone, read-only FastAPI service for the "Usage
Analytics" tab in Settings. It reads the same local JSON datastore the
Node server (server/db.js) already writes — specifically the `llm_log`
table, which is the one authoritative per-call ledger: server/services/llm.js
appends a row there for EVERY OpenRouter call the app makes (chat, learn
mode, quizzes/exams, the news agent — all of it), each with its model,
input/output token counts, latency and any error.

The existing Node `/api/user/usage` endpoint only sums `sessions.total_tokens`,
which is only updated by the chat endpoint — learn-mode and news-agent calls
are invisible to it, so it under-counts. This service is the accurate
source of truth, and is intentionally a separate process/language (Python)
per spec, rather than folded into server.js.

Read-only: never writes to the datastore, so it can run alongside the Node
server (port 5000) with zero write-conflicts. The JSON file is written
atomically by db.js (write-to-tmp + rename), so a concurrent read here can
never observe a half-written file.

Run: python backend/analytics/main.py   (defaults to port 8010)
Env: EVOLVE_DB_PATH   overrides the datastore path (used by tests)
     ANALYTICS_PORT    overrides the listen port
"""
import json
import os
from datetime import date, datetime
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

# server/data/evolve-db.json, relative to the repo root (two levels up from
# this file: backend/analytics/main.py -> backend/ -> repo root).
DEFAULT_DB_PATH = Path(__file__).resolve().parents[2] / "server" / "data" / "evolve-db.json"
MONTHLY_LIMIT = 200_000  # kept in sync with MONTHLY_LIMIT in server/server.js

app = FastAPI(title="Evolve GM — Usage Analytics", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    # Dev-local app, no auth layer on the Node API either yet — matches it.
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)


def _db_path() -> Path:
    override = os.environ.get("EVOLVE_DB_PATH")
    return Path(override) if override else DEFAULT_DB_PATH


def _load_llm_log() -> list[dict]:
    path = _db_path()
    if not path.exists():
        return []
    # The writer renames a .tmp into place atomically, but retry once anyway
    # in case a read lands mid-rename on a filesystem without that guarantee.
    for attempt in range(2):
        try:
            with path.open("r", encoding="utf-8") as f:
                data = json.load(f)
            return data.get("llm_log", []) or []
        except (json.JSONDecodeError, OSError):
            if attempt == 1:
                return []
    return []


def _row_total(row: dict) -> int:
    return int(row.get("input_tokens") or 0) + int(row.get("output_tokens") or 0)


def _parse_date(value: Optional[str]) -> Optional[date]:
    """Accepts a plain date ("2026-09-01") or a full ISO timestamp; returns a date."""
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def _row_date(row: dict) -> Optional[date]:
    return _parse_date(row.get("created_at"))


def _filter_rows(
    user_id: str,
    from_date: Optional[str],
    to_date: Optional[str],
    model: Optional[str],
    source_mode: Optional[str],
) -> list[dict]:
    rows = [r for r in _load_llm_log() if r.get("user_id") == user_id]
    if model and model != "all":
        rows = [r for r in rows if r.get("model") == model]
    if source_mode and source_mode != "all":
        rows = [r for r in rows if r.get("source_mode") == source_mode]
    start = _parse_date(from_date)
    if start:
        rows = [r for r in rows if (_row_date(r) or start) >= start]
    end = _parse_date(to_date)
    if end:
        rows = [r for r in rows if (_row_date(r) or end) <= end]
    return rows


@app.get("/api/analytics/health")
def health():
    return {"ok": True, "time": datetime.utcnow().isoformat()}


@app.get("/api/analytics/filters")
def filters(user_id: str):
    """Distinct models/usage-types/date-range this user actually has data for, to populate the filter dropdowns."""
    rows = [r for r in _load_llm_log() if r.get("user_id") == user_id]
    models = sorted({r["model"] for r in rows if r.get("model")})
    modes = sorted({r["source_mode"] for r in rows if r.get("source_mode")})
    dates = sorted(d for r in rows if (d := r.get("created_at")))
    return {
        "models": models,
        "source_modes": modes,
        "min_date": dates[0] if dates else None,
        "max_date": dates[-1] if dates else None,
        "total_calls": len(rows),
    }


@app.get("/api/analytics/summary")
def summary(
    user_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    model: Optional[str] = None,
    source_mode: Optional[str] = None,
):
    rows = _filter_rows(user_id, from_date, to_date, model, source_mode)
    total_tokens = sum(_row_total(r) for r in rows)
    input_tokens = sum(int(r.get("input_tokens") or 0) for r in rows)
    output_tokens = sum(int(r.get("output_tokens") or 0) for r in rows)
    error_count = sum(1 for r in rows if r.get("error"))
    latencies = [r["latency_ms"] for r in rows if isinstance(r.get("latency_ms"), (int, float))]
    avg_latency_ms = round(sum(latencies) / len(latencies)) if latencies else 0
    used_pct = round(min(100.0, (total_tokens / MONTHLY_LIMIT) * 100), 2) if MONTHLY_LIMIT else 0.0
    return {
        "total_calls": len(rows),
        "total_tokens": total_tokens,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "error_count": error_count,
        "avg_latency_ms": avg_latency_ms,
        "limit": MONTHLY_LIMIT,
        "used_pct": used_pct,
    }


@app.get("/api/analytics/timeseries")
def timeseries(
    user_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    model: Optional[str] = None,
    source_mode: Optional[str] = None,
):
    """Daily token/call totals — drives the usage-over-time bar chart."""
    rows = _filter_rows(user_id, from_date, to_date, model, source_mode)
    buckets: dict[str, dict] = {}
    for r in rows:
        d = _row_date(r)
        key = d.isoformat() if d else "unknown"
        b = buckets.setdefault(key, {"date": key, "tokens": 0, "calls": 0})
        b["tokens"] += _row_total(r)
        b["calls"] += 1
    return {"points": sorted(buckets.values(), key=lambda x: x["date"])}


def _breakdown(rows: list[dict], key_fn) -> list[dict]:
    buckets: dict[str, dict] = {}
    total = 0
    for r in rows:
        key = key_fn(r) or "unknown"
        b = buckets.setdefault(key, {"key": key, "tokens": 0, "calls": 0})
        t = _row_total(r)
        b["tokens"] += t
        b["calls"] += 1
        total += t
    out = sorted(buckets.values(), key=lambda x: -x["tokens"])
    for b in out:
        b["pct"] = round((b["tokens"] / total) * 100, 1) if total else 0.0
    return out


@app.get("/api/analytics/by_model")
def by_model(
    user_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    source_mode: Optional[str] = None,
):
    rows = _filter_rows(user_id, from_date, to_date, None, source_mode)
    breakdown = [{"model": b["key"], **{k: v for k, v in b.items() if k != "key"}} for b in _breakdown(rows, lambda r: r.get("model"))]
    return {"breakdown": breakdown}


@app.get("/api/analytics/by_mode")
def by_mode(
    user_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    model: Optional[str] = None,
):
    rows = _filter_rows(user_id, from_date, to_date, model, None)
    breakdown = [{"source_mode": b["key"], **{k: v for k, v in b.items() if k != "key"}} for b in _breakdown(rows, lambda r: r.get("source_mode"))]
    return {"breakdown": breakdown}


@app.get("/api/analytics/logs")
def logs(
    user_id: str,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
    model: Optional[str] = None,
    source_mode: Optional[str] = None,
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=200),
):
    """Paginated raw call list for the detail table (newest first)."""
    rows = _filter_rows(user_id, from_date, to_date, model, source_mode)
    rows = sorted(rows, key=lambda r: r.get("created_at") or "", reverse=True)
    total = len(rows)
    start = (page - 1) * page_size
    page_rows = rows[start:start + page_size]
    items = [
        {
            "id": r.get("id"),
            "created_at": r.get("created_at"),
            "model": r.get("model"),
            "source_mode": r.get("source_mode"),
            "prompt_name": r.get("prompt_name"),
            "input_tokens": int(r.get("input_tokens") or 0),
            "output_tokens": int(r.get("output_tokens") or 0),
            "total_tokens": _row_total(r),
            "latency_ms": r.get("latency_ms"),
            "error": r.get("error"),
        }
        for r in page_rows
    ]
    return {"items": items, "total": total, "page": page, "page_size": page_size}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("ANALYTICS_PORT", 8010)))
