"""
Tests for the Usage Analytics service. Uses a throwaway fixture datastore
(via the EVOLVE_DB_PATH env var main.py honors) so these never touch the
real server/data/evolve-db.json.

Run: pytest backend/analytics -v
"""
import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

FIXTURE_DB = {
    "llm_log": [
        # user "alice": two chat calls on day 1, one learn call on day 2, one errored call
        {"id": "1", "created_at": "2026-09-01T10:00:00.000Z", "user_id": "alice",
         "model": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "prompt_name": "generic",
         "source_mode": "chat", "input_tokens": 100, "output_tokens": 50, "latency_ms": 800, "error": None},
        {"id": "2", "created_at": "2026-09-01T14:00:00.000Z", "user_id": "alice",
         "model": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "prompt_name": "generic",
         "source_mode": "chat", "input_tokens": 200, "output_tokens": 100, "latency_ms": 1200, "error": None},
        {"id": "3", "created_at": "2026-09-02T09:00:00.000Z", "user_id": "alice",
         "model": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "prompt_name": "raw_content",
         "source_mode": "learn", "input_tokens": 300, "output_tokens": 400, "latency_ms": 2000, "error": None},
        {"id": "4", "created_at": "2026-09-03T09:00:00.000Z", "user_id": "alice",
         "model": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "prompt_name": "doubt_eval",
         "source_mode": "learn", "input_tokens": 50, "output_tokens": 0, "latency_ms": 500, "error": "timeout"},
        # user "bob": one call, different model
        {"id": "5", "created_at": "2026-09-01T11:00:00.000Z", "user_id": "bob",
         "model": "some-other-model", "prompt_name": "generic",
         "source_mode": "chat", "input_tokens": 1000, "output_tokens": 1000, "latency_ms": 900, "error": None},
        # a background call with no user_id (e.g. the news agent scheduler) — must never leak into a user's numbers
        {"id": "6", "created_at": "2026-09-01T00:00:00.000Z", "user_id": None,
         "model": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "prompt_name": "news_curator",
         "source_mode": "news_agent", "input_tokens": 5000, "output_tokens": 5000, "latency_ms": 3000, "error": None},
    ]
}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    db_file = tmp_path / "evolve-db.json"
    db_file.write_text(json.dumps(FIXTURE_DB))
    monkeypatch.setenv("EVOLVE_DB_PATH", str(db_file))
    # Import after the env var is set so any accidental import-time path
    # resolution would still pick it up; main.py actually reads it lazily
    # per-request via _db_path(), so this also covers that behavior.
    import importlib
    import main as analytics_main
    importlib.reload(analytics_main)
    return TestClient(analytics_main.app)


def test_health(client):
    r = client.get("/api/analytics/health")
    assert r.status_code == 200
    assert r.json()["ok"] is True


def test_summary_scopes_to_user_and_sums_input_output(client):
    r = client.get("/api/analytics/summary", params={"user_id": "alice"})
    body = r.json()
    assert body["total_calls"] == 4
    assert body["input_tokens"] == 100 + 200 + 300 + 50
    assert body["output_tokens"] == 50 + 100 + 400 + 0
    assert body["total_tokens"] == body["input_tokens"] + body["output_tokens"]
    assert body["error_count"] == 1
    assert body["limit"] == 200_000


def test_summary_never_leaks_other_users_or_system_calls(client):
    alice = client.get("/api/analytics/summary", params={"user_id": "alice"}).json()
    bob = client.get("/api/analytics/summary", params={"user_id": "bob"}).json()
    assert alice["total_tokens"] != bob["total_tokens"]
    assert bob["total_calls"] == 1
    # the user_id=None background row (id=6) must not appear for any real user
    nobody = client.get("/api/analytics/summary", params={"user_id": "nonexistent-user"}).json()
    assert nobody["total_calls"] == 0
    assert nobody["total_tokens"] == 0


def test_summary_used_pct_computed_against_monthly_limit(client):
    body = client.get("/api/analytics/summary", params={"user_id": "alice"}).json()
    expected_pct = round(min(100.0, (body["total_tokens"] / 200_000) * 100), 2)
    assert body["used_pct"] == expected_pct
    assert body["used_pct"] > 0  # alice has usage, must not be stuck at 0


def test_summary_starts_at_zero_for_a_fresh_user(client):
    body = client.get("/api/analytics/summary", params={"user_id": "brand-new-user"}).json()
    assert body["used_pct"] == 0
    assert body["total_tokens"] == 0
    assert body["total_calls"] == 0


def test_date_range_filter(client):
    day1_only = client.get("/api/analytics/summary", params={
        "user_id": "alice", "from_date": "2026-09-01", "to_date": "2026-09-01",
    }).json()
    assert day1_only["total_calls"] == 2  # only the two 9/1 chat calls

    full_range = client.get("/api/analytics/summary", params={
        "user_id": "alice", "from_date": "2026-09-01", "to_date": "2026-09-03",
    }).json()
    assert full_range["total_calls"] == 4


def test_model_and_source_mode_filters(client):
    chat_only = client.get("/api/analytics/summary", params={"user_id": "alice", "source_mode": "chat"}).json()
    assert chat_only["total_calls"] == 2

    learn_only = client.get("/api/analytics/summary", params={"user_id": "alice", "source_mode": "learn"}).json()
    assert learn_only["total_calls"] == 2

    all_explicit = client.get("/api/analytics/summary", params={"user_id": "alice", "model": "all"}).json()
    assert all_explicit["total_calls"] == 4


def test_filters_endpoint_returns_distinct_values_for_that_user_only(client):
    body = client.get("/api/analytics/filters", params={"user_id": "alice"}).json()
    assert body["source_modes"] == ["chat", "learn"]
    assert body["total_calls"] == 4
    assert body["min_date"] <= body["max_date"]

    bob = client.get("/api/analytics/filters", params={"user_id": "bob"}).json()
    assert bob["models"] == ["some-other-model"]


def test_timeseries_buckets_by_day(client):
    body = client.get("/api/analytics/timeseries", params={"user_id": "alice"}).json()
    points = {p["date"]: p for p in body["points"]}
    assert points["2026-09-01"]["calls"] == 2
    assert points["2026-09-01"]["tokens"] == 100 + 50 + 200 + 100
    assert points["2026-09-02"]["calls"] == 1
    assert points["2026-09-03"]["calls"] == 1


def test_by_mode_breakdown_percentages_sum_to_100(client):
    body = client.get("/api/analytics/by_mode", params={"user_id": "alice"}).json()["breakdown"]
    total_pct = sum(b["pct"] for b in body)
    assert 99.0 <= total_pct <= 100.1  # rounding tolerance
    modes = {b["source_mode"] for b in body}
    assert modes == {"chat", "learn"}


def test_by_model_breakdown(client):
    body = client.get("/api/analytics/by_model", params={"user_id": "alice"}).json()["breakdown"]
    assert len(body) == 1
    assert body[0]["calls"] == 4


def test_logs_pagination_and_sort_order(client):
    page1 = client.get("/api/analytics/logs", params={"user_id": "alice", "page": 1, "page_size": 2}).json()
    assert page1["total"] == 4
    assert len(page1["items"]) == 2
    # newest first
    assert page1["items"][0]["created_at"] > page1["items"][1]["created_at"]

    page2 = client.get("/api/analytics/logs", params={"user_id": "alice", "page": 2, "page_size": 2}).json()
    assert len(page2["items"]) == 2
    ids_p1 = {i["id"] for i in page1["items"]}
    ids_p2 = {i["id"] for i in page2["items"]}
    assert not (ids_p1 & ids_p2)  # no overlap between pages


def test_logs_row_reports_error_field(client):
    body = client.get("/api/analytics/logs", params={"user_id": "alice", "page_size": 10}).json()
    errored = [i for i in body["items"] if i["error"]]
    assert len(errored) == 1
    assert errored[0]["error"] == "timeout"


def test_missing_db_file_degrades_to_empty_results(tmp_path, monkeypatch):
    monkeypatch.setenv("EVOLVE_DB_PATH", str(tmp_path / "does-not-exist.json"))
    import importlib
    import main as analytics_main
    importlib.reload(analytics_main)
    c = TestClient(analytics_main.app)
    body = c.get("/api/analytics/summary", params={"user_id": "alice"}).json()
    assert body == {
        "total_calls": 0, "total_tokens": 0, "input_tokens": 0, "output_tokens": 0,
        "error_count": 0, "avg_latency_ms": 0, "limit": 200_000, "used_pct": 0.0,
    }
