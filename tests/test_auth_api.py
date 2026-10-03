"""Интеграционный: register → login → me → refresh rotation. Нативный async (ASGI)."""

import uuid

import httpx
import pytest_asyncio

from app.main import create_app

app = create_app()


@pytest_asyncio.fixture()
async def client():  # type: ignore[no-untyped-def]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c


def _email() -> str:
    return f"t_{uuid.uuid4().hex[:10]}@example.com"


async def test_full_cycle(client: httpx.AsyncClient) -> None:
    email = _email()
    assert (
        await client.post("/api/v1/auth/register", json={"email": email, "password": "secret123"})
    ).status_code == 201
    assert (
        await client.post("/api/v1/auth/register", json={"email": email, "password": "secret123"})
    ).status_code == 409
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": "secret123"})
    assert r.status_code == 200
    access = r.json()["access_token"]
    assert "pfp_refresh" in r.cookies
    me = await client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {access}"})
    assert me.json()["email"] == email
    bad = await client.post("/api/v1/auth/login", json={"email": email, "password": "nope"})
    assert bad.status_code == 401


async def test_refresh_rotation(client: httpx.AsyncClient) -> None:
    email = _email()
    await client.post("/api/v1/auth/register", json={"email": email, "password": "secret123"})
    r1 = await client.post("/api/v1/auth/login", json={"email": email, "password": "secret123"})
    old_refresh = r1.cookies["pfp_refresh"]
    r2 = await client.post("/api/v1/auth/refresh", json={"refresh_token": old_refresh})
    assert r2.status_code == 200
    # reuse старого refresh = компрометация → 401
    r3 = await client.post("/api/v1/auth/refresh", json={"refresh_token": old_refresh})
    assert r3.status_code == 401
