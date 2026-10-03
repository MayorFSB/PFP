"""Оплата-заглушка: checkout URL, webhook подтверждает, плохая подпись = 400."""

import uuid
from datetime import UTC, datetime

import httpx
import pytest_asyncio
from sqlalchemy import select

from app.core.db import SessionLocal
from app.main import create_app
from app.modules.models import Booking, Filial, Role, Service, User

app = create_app()


@pytest_asyncio.fixture()
async def client():  # type: ignore[no-untyped-def]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c


async def _booking(client: httpx.AsyncClient) -> tuple[str, str]:
    email = f"p_{uuid.uuid4().hex[:8]}@example.com"
    await client.post("/api/v1/auth/register", json={"email": email, "password": "secret123"})
    token = (
        await client.post("/api/v1/auth/login", json={"email": email, "password": "secret123"})
    ).json()["access_token"]
    async with SessionLocal() as s:
        u = await s.scalar(select(User).where(User.email == email))
        assert u is not None
        f = Filial(name=f"Pay-{uuid.uuid4().hex[:6]}", address="x")
        m = User(email="pm_" + email, password_hash="!", role=Role.master)
        s.add_all([f, m])
        await s.commit()
        for o in (f, m):
            await s.refresh(o)
        svc = Service(filial_id=f.id, name="Оплата-тест", price_kopeks=100000, duration_min=30)
        s.add(svc)
        await s.commit()
        await s.refresh(svc)
        start = datetime(2026, 10, 6, 10, tzinfo=UTC)
        b = Booking(
            filial_id=f.id,
            master_id=m.id,
            client_id=u.id,
            service_id=svc.id,
            start_at=start,
            end_at=datetime(2026, 10, 6, 10, 30, tzinfo=UTC),
            idempotency_key=f"pay-{uuid.uuid4().hex}",
        )
        s.add(b)
        await s.commit()
        await s.refresh(b)
        return token, str(b.id)


async def test_checkout_and_webhook(client: httpx.AsyncClient) -> None:
    token, bid = await _booking(client)
    h = {"Authorization": f"Bearer {token}"}
    r = await client.post("/api/v1/payments/checkout", json={"booking_id": bid}, headers=h)
    assert r.status_code == 200 and r.json()["pay_url"].startswith("https://pay.example/checkout/")
    w = await client.post(
        "/api/v1/payments/webhook", json={"booking_id": bid, "signature": "fake-sig-123"}
    )
    assert w.json() == {"ok": True}
    bad = await client.post(
        "/api/v1/payments/webhook", json={"booking_id": bid, "signature": "nope"}
    )
    assert bad.status_code == 400


async def test_metrics_endpoint(client: httpx.AsyncClient) -> None:
    r = await client.get("/metrics")
    assert r.status_code == 200 and "http_requests_total" in r.text
