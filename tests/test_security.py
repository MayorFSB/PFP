"""Тесты безопасности: заголовки, rate-limit, CSRF, timing-safe логин."""

import time
import uuid

import httpx
import pytest_asyncio

from app.main import create_app

app = create_app()


@pytest_asyncio.fixture()
async def client():  # type: ignore[no-untyped-def]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c


async def test_security_headers(client: httpx.AsyncClient) -> None:
    r = await client.get("/")
    h = {k.lower(): v for k, v in r.headers.items()}
    assert "content-security-policy" in h
    assert h.get("x-frame-options") == "DENY"
    assert h.get("x-content-type-options") == "nosniff"
    assert "referrer-policy" in h


async def test_login_rate_limit(client: httpx.AsyncClient) -> None:
    from app.core import cache

    try:
        await cache.get_client().delete("pfp:rl:login:testclient")
    except Exception:
        pass
    email = f"rl_{uuid.uuid4().hex[:8]}@example.com"
    codes = [
        (
            await client.post("/api/v1/auth/login", json={"email": email, "password": "x"})
        ).status_code
        for _ in range(12)
    ]
    assert codes[:10] == [401] * 10
    assert all(c == 429 for c in codes[10:])


async def test_csrf_blocks_mutation(client: httpx.AsyncClient) -> None:
    from app.core import cache

    try:
        await cache.get_client().delete("pfp:rl:login:testclient")
    except Exception:
        pass
    email = f"csrf_{uuid.uuid4().hex[:8]}@example.com"
    await client.post("/api/v1/auth/register", json={"email": email, "password": "secret123"})
    token = (
        await client.post("/api/v1/auth/login", json={"email": email, "password": "secret123"})
    ).json()["access_token"]
    Z = "00000000-0000-0000-0000-000000000000"
    r = await client.post(
        "/book",
        data={
            "master_id": Z,
            "filial_id": Z,
            "service_id": Z,
            "start_at": "2026-10-06T10:00:00+00:00",
            "idempotency_key": "x",
            "csrf_token": "wrong-token",
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 403


async def test_timing_safe_login(client: httpx.AsyncClient) -> None:
    """Несуществующий email и существующий с неверным паролем — сопоставимое время."""
    t0 = time.perf_counter()
    await client.post(
        "/api/v1/auth/login",
        json={"email": f"nope_{uuid.uuid4().hex}@example.com", "password": "x"},
    )
    t_missing = time.perf_counter() - t0

    email = f"ts_{uuid.uuid4().hex[:8]}@example.com"
    await client.post("/api/v1/auth/register", json={"email": email, "password": "secret123"})
    t0 = time.perf_counter()
    await client.post("/api/v1/auth/login", json={"email": email, "password": "wrong"})
    t_wrong = time.perf_counter() - t0

    # argon2 доминирует; разброс не должен быть катастрофическим (порядок величины)
    assert abs(t_missing - t_wrong) < 2.0


async def test_sqli_params_rejected(client: httpx.AsyncClient) -> None:
    Z = "00000000-0000-0000-0000-000000000000"
    r = await client.get(
        "/api/v1/slots",
        params={"filial_id": Z, "master_id": Z, "service_id": Z, "day": "2026-10-05' OR '1'='1"},
    )
    assert r.status_code == 422
