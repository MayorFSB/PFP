from fastapi.testclient import TestClient

from app.main import create_app


def test_health() -> None:
    client = TestClient(create_app())
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_ping() -> None:
    client = TestClient(create_app())
    r = client.get("/api/v1/ping")
    assert r.json() == {"pong": True}
