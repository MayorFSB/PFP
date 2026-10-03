"""SSR smoke: главная, страница филиала, login, кабинеты под куками."""

import uuid

import httpx
import pytest_asyncio
from sqlalchemy import select

from app.core.db import SessionLocal
from app.main import create_app
from app.modules.models import Filial

app = create_app()


@pytest_asyncio.fixture()
async def client():  # type: ignore[no-untyped-def]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c


async def test_index(client: httpx.AsyncClient) -> None:
    r = await client.get("/")
    assert r.status_code == 200 and "Филиалы" in r.text


async def test_filial_page(client: httpx.AsyncClient) -> None:
    async with SessionLocal() as s:
        f = await s.scalar(select(Filial).limit(1))
        assert f is not None
        fid = f.id
    r = await client.get(f"/f/{fid}")
    assert r.status_code == 200 and "Услуги" in r.text
    bad = await client.get(f"/f/{uuid.uuid4()}")
    assert bad.status_code == 404


async def test_login_form_has_csrf(client: httpx.AsyncClient) -> None:
    r = await client.get("/login")
    assert r.status_code == 200 and "csrf_token" in r.text


async def test_cabinet_requires_auth(client: httpx.AsyncClient) -> None:
    assert (await client.get("/cabinet")).status_code == 401
    assert (await client.get("/master")).status_code == 401


async def test_web_login_and_cabinet(client: httpx.AsyncClient) -> None:
    email = f"w_{uuid.uuid4().hex[:8]}@example.com"
    await client.post("/api/v1/auth/register", json={"email": email, "password": "secret123"})
    form = await client.get("/login")
    token = form.text.split('name="csrf_token" value="')[1].split('"')[0]
    r = await client.post(
        "/login", data={"email": email, "password": "secret123", "csrf_token": token}
    )
    assert r.status_code in (200, 303)
    cab = await client.get("/cabinet")
    assert cab.status_code == 200 and "Мои записи" in cab.text
