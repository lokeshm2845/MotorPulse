import os
import tempfile

os.environ["MOTORPULSE_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")

from fastapi.testclient import TestClient  # noqa: E402
from server.main import app  # noqa: E402

client = TestClient(app)

BATCH = {
    "device_id": "dev-1",
    "machines": [{"id": "m1", "name": "Well pump", "type": "surface_pump", "location": "Shirpur"}],
    "checks": [
        {"id": "c1", "machine_id": "m1", "ts": "2026-11-20T10:00:00Z", "health": 92, "severity": "green", "model_version": "mp-fp-1.0"},
        {"id": "c2", "machine_id": "m1", "ts": "2026-11-21T10:00:00Z", "health": 31, "severity": "red",
         "top_fault": "bearing", "fault_confidence": 0.9, "model_version": "mp-fp-1.0"},
    ],
}


def test_batch_is_idempotent():
    r = client.post("/v1/checks/batch", json=BATCH)
    assert r.status_code == 200 and r.json() == {"accepted": 2, "duplicates": 0}
    r = client.post("/v1/checks/batch", json=BATCH)
    assert r.json() == {"accepted": 0, "duplicates": 2}


def test_fleet_summary_uses_latest_check():
    d = client.get("/v1/fleet/summary").json()
    m = next(x for x in d["machines"] if x["id"] == "m1")
    assert m["severity"] == "red" and m["health"] == 31 and m["top_fault"] == "bearing" and m["n_checks"] == 2
    assert d["counts"]["red"] >= 1


def test_validation_rejects_bad_values():
    bad = {"device_id": "d", "machines": [], "checks": [{"id": "x", "machine_id": "m1", "ts": "2026-11-21T10:00:00Z", "health": 150, "severity": "green"}]}
    assert client.post("/v1/checks/batch", json=bad).status_code == 422
    unknown = {"device_id": "d", "machines": [], "checks": [{"id": "y", "machine_id": "nope", "ts": "2026-11-21T10:00:00Z", "health": 50, "severity": "yellow"}]}
    assert client.post("/v1/checks/batch", json=unknown).status_code == 422


def test_machine_history_and_dashboard():
    r = client.get("/v1/machines/m1/checks")
    assert r.status_code == 200 and [c["id"] for c in r.json()["checks"]] == ["c2", "c1"]
    assert client.get("/v1/machines/none/checks").status_code == 404
    assert client.get("/dashboard").status_code == 200
    assert client.get("/app/").status_code == 200
