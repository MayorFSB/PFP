"""Интеграционный: правило → слоты → бронь → дубль по ключу → чужой дубль слота → отмена."""

import uuid

import httpx
import pytest_asyncio

from app.core.db import SessionLocal
from app.main import create_app
from app.modules.models import Filial, Role, ScheduleRule, Service, User

app = create_app()


@pytest_asyncio.fixture()
async def ctx():  # type: ignore[no-untyped-def]
    email = f"b_{uuid.uuid4().hex[:8]}@example.com"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c, email


async def _seed(email: str) -> dict[str, str]:
    async with SessionLocal() as s:
        f = Filial(name="Центр", address="ул. Мира 1")
        m = User(email="m_" + email, password_hash="!", role=Role.master)
        u = User(email=email, password_hash="!", role=Role.client)
        s.add_all([f, m, u])
        await s.commit()
        await s.refresh(f)
        await s.refresh(m)
        await s.refresh(u)
        svc = Service(filial_id=f.id, name="Стрижка", price_kopeks=150000, duration_min=60)
        s.add(svc)
        await s.commit()
        await s.refresh(svc)
        s.add(
            ScheduleRule(
                master_id=m.id, filial_id=f.id, weekday=0, start_min=9 * 60, end_min=12 * 60
            )
        )
        await s.commit()
        return {"filial": str(f.id), "master": str(m.id), "service": str(svc.id)}


async def _login(c: httpx.AsyncClient, email: str) -> str:
    from app.core.security import hash_password

    async with SessionLocal() as s:
        from sqlalchemy import select

        u = await s.scalar(select(User).where(User.email == email))
        assert u is not None
        u.password_hash = hash_password("pw123456")
        await s.commit()
    r = await c.post("/api/v1/auth/login", json={"email": email, "password": "pw123456"})
    return r.json()["access_token"]


async def test_booking_flow(ctx: httpx.AsyncClient) -> None:
    c, email = ctx  # type: ignore[misc]
    ids = await _seed(email)
    token = await _login(c, email)
    h = {"Authorization": f"Bearer {token}"}
    params = {
        "filial_id": ids["filial"],
        "master_id": ids["master"],
        "service_id": ids["service"],
        "day": "2026-10-05",
    }

    r = await c.get("/api/v1/auth/me", headers=h)
    assert r.status_code == 200

    s = await c.get("/api/v1/auth/me", headers=h)  # sanity auth
    assert s.status_code == 200

    slots = (await c.get("/api/v1/slots", params=params)).json()["slots"]
    assert len(slots) == 3

    body = {
        "master_id": ids["master"],
        "filial_id": ids["filial"],
        "service_id": ids["service"],
        "start_at": slots[0],
    }
    b1 = await c.post("/api/v1/bookings", json=body, headers={**h, "Idempotency-Key": "k1"})
    assert b1.status_code == 201

    # повтор с тем же ключом — та же бронь
    b1d = await c.post("/api/v1/bookings", json=body, headers={**h, "Idempotency-Key": "k1"})
    assert b1d.status_code == 201 and b1d.json()["id"] == b1.json()["id"]

    # чужой ключ на тот же слот — 409
    b2 = await c.post("/api/v1/bookings", json=body, headers={**h, "Idempotency-Key": "k2"})
    assert b2.status_code == 409

    # слот пропал из выдачи
    slots2 = (await c.get("/api/v1/slots", params=params)).json()["slots"]
    assert slots[0] not in slots2

    # отмена возвращает слот
    cancel = await c.post(f"/api/v1/bookings/{b1.json()['id']}/cancel", headers=h)
    assert cancel.status_code == 200
    slots3 = (await c.get("/api/v1/slots", params=params)).json()["slots"]
    assert slots[0] in slots3


async def test_booking_requires_key(ctx: httpx.AsyncClient) -> None:
    c, email = ctx  # type: ignore[misc]
    ids = await _seed(email)
    token = await _login(c, email)
    body = {
        "master_id": ids["master"],
        "filial_id": ids["filial"],
        "service_id": ids["service"],
        "start_at": "2026-10-05T09:00:00+00:00",
    }
    r = await c.post("/api/v1/bookings", json=body, headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 422
