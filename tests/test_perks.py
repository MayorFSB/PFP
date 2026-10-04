"""Перки: промокоды, подписки, поинты мастеров. Чистые проверки + интеграция в бронь."""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

import httpx
import pytest_asyncio
from sqlalchemy import select

from app.core.db import SessionLocal
from app.main import create_app
from app.modules import perks
from app.modules.booking import service as booking
from app.modules.models import (
    Booking,
    FamilySubscription,
    Filial,
    MasterProfile,
    Promocode,
    Role,
    ScheduleRule,
    Service,
    SubscriptionMember,
    User,
)

app = create_app()


async def _fixture() -> dict[str, Any]:
    tag = uuid.uuid4().hex[:8]
    async with SessionLocal() as s:
        f = Filial(name=f"Перк-{tag}", address="ул. Тестовая, 1")
        m = User(email=f"pm_{tag}@example.com", password_hash="!", role=Role.master)
        u = User(email=f"pc_{tag}@example.com", password_hash="!", role=Role.client)
        s.add_all([f, m, u])
        await s.commit()
        await s.refresh(f)
        await s.refresh(m)
        await s.refresh(u)
        svc = Service(filial_id=f.id, name="Стрижка", price_kopeks=200000, duration_min=60)
        s.add(svc)
        s.add(MasterProfile(user_id=m.id, display_name=f"Мастер {tag}", rating=4.8))
        s.add(
            ScheduleRule(
                master_id=m.id, filial_id=f.id, weekday=0, start_min=9 * 60, end_min=15 * 60
            )
        )
        await s.commit()
        return {
            "filial": f.id,
            "master": m.id,
            "client": u.id,
            "service": svc.id,
            "email": f"pc_{tag}@example.com",
        }


async def _promo(code: str = "ТЕСТ10", **kw: Any) -> Promocode:
    kw.setdefault("discount_pct", 10)
    async with SessionLocal() as s:
        p = Promocode(code=f"{code}{uuid.uuid4().hex[:4].upper()}", **kw)
        s.add(p)
        await s.commit()
        await s.refresh(p)
        return p


def _kw(fx: dict[str, Any]) -> dict[str, Any]:
    return {"filial_id": fx["filial"], "service_id": fx["service"], "master_id": fx["master"]}


async def test_promo_valid() -> None:
    fx = await _fixture()
    async with SessionLocal() as s:
        p0 = await _promo()
        p = await perks.validate_promo(s, p0.code.lower(), **_kw(fx))
    assert p.discount_pct == 10


async def test_promo_unknown() -> None:
    fx = await _fixture()
    async with SessionLocal() as s:
        try:
            await perks.validate_promo(s, "НЕТ-ТАКОГО", **_kw(fx))
        except perks.PromoError as e:
            assert "unknown" in str(e)
        else:
            raise AssertionError("expected PromoError")


async def test_promo_expired_exhausted_bound() -> None:
    fx = await _fixture()
    past = datetime.now(UTC) - timedelta(days=1)
    future = datetime.now(UTC) + timedelta(days=1)
    async with SessionLocal() as s:
        old_p = await _promo("СТАРЫЙ", valid_to=past)
        empty_p = await _promo("ПУСТО", max_uses=1)
        empty = await s.scalar(select(Promocode).where(Promocode.code == empty_p.code))
        assert empty is not None
        empty.used_count = 1
        await s.commit()
        for promo_obj, reason in [
            (old_p, "expired"),
            (empty, "exhausted"),
        ]:
            try:
                await perks.validate_promo(s, promo_obj.code, **_kw(fx))
            except perks.PromoError as e:
                assert reason in str(e), promo_obj.code
            else:
                raise AssertionError(f"expected PromoError for {promo_obj.code}")
        # Привязка к чужому филиалу и будущее окно — отдельные объекты
        other = Filial(name=f"Чужой-{uuid.uuid4().hex[:6]}", address="ул. Чужая, 9")
        s.add(other)
        await s.commit()
        alien = await _promo("ЧУЖОЙ2", filial_id=other.id)
        soon = await _promo("БУДУЩИЙ2", valid_from=future + timedelta(days=1))
        await s.commit()
        for promo_obj, reason in [(alien, "wrong filial"), (soon, "not started")]:
            try:
                await perks.validate_promo(s, promo_obj.code, **_kw(fx))
            except perks.PromoError as e:
                assert reason in str(e), promo_obj.code
            else:
                raise AssertionError(f"expected PromoError for {promo_obj.code}")


async def test_subscription_discount() -> None:
    fx = await _fixture()
    async with SessionLocal() as s:
        sub = FamilySubscription(owner_id=fx["client"], plan="Семейная", discount_pct=10)
        s.add(sub)
        await s.commit()
        await s.refresh(sub)
        member = User(email=f"pmem_{uuid.uuid4().hex[:6]}@example.com", password_hash="!")
        s.add(member)
        await s.commit()
        s.add(SubscriptionMember(subscription_id=sub.id, user_id=member.id))
        outsider = User(email=f"out_{uuid.uuid4().hex[:6]}@example.com", password_hash="!")
        s.add(outsider)
        await s.commit()
        assert await perks.subscription_discount(s, fx["client"]) == 10
        assert await perks.subscription_discount(s, member.id) == 10
        assert await perks.subscription_discount(s, outsider.id) == 0
        sub.active = False
        await s.commit()
        assert await perks.subscription_discount(s, fx["client"]) == 0


async def test_resolve_best_promo_vs_sub() -> None:
    fx = await _fixture()
    async with SessionLocal() as s:
        small = await _promo("МАЛЫЙ", discount_pct=5)
        sub = FamilySubscription(owner_id=fx["client"], discount_pct=10)
        s.add(sub)
        await s.commit()
        kw = {"user_id": fx["client"], **_kw(fx)}
        pct, promo = await perks.resolve_discount_pct(s, promo_code=small.code, **kw)
        assert pct == 10 and promo is None  # подписка бьёт, промо не тикает
        pct2, promo2 = await perks.resolve_discount_pct(s, promo_code=None, **kw)
        assert pct2 == 10 and promo2 is None


async def test_booking_with_promo() -> None:
    fx = await _fixture()
    async with SessionLocal() as s:
        big = await _promo("СКИДКА15", discount_pct=15)
        slots = await booking.day_slots(
            s, fx["filial"], fx["master"], date(2026, 10, 5), fx["service"]
        )
        assert slots
        b = await booking.create_booking(
            s,
            idempotency_key=f"promo-{uuid.uuid4().hex}",
            client_id=fx["client"],
            master_id=fx["master"],
            filial_id=fx["filial"],
            service_id=fx["service"],
            start_at=datetime.fromisoformat(slots[0]),
            promo_code=big.code.lower(),
        )
        assert b.discount_kopeks == 200000 * 15 // 100
        assert b.promo_id is not None
        p = await s.scalar(select(Promocode).where(Promocode.code == big.code))
        assert p is not None and p.used_count == 1
        # Повтор по тому же ключу — та же бронь, счётчик не тикает
        b2 = await booking.create_booking(
            s,
            idempotency_key=b.idempotency_key,
            client_id=fx["client"],
            master_id=fx["master"],
            filial_id=fx["filial"],
            service_id=fx["service"],
            start_at=datetime.fromisoformat(slots[0]),
            promo_code=big.code.lower(),
        )
        assert b2.id == b.id
        await s.refresh(p)
        assert p.used_count == 1


async def test_master_score_math() -> None:
    fx = await _fixture()
    async with SessionLocal() as s:
        now = datetime.now(UTC)
        for i in range(2):
            s.add(
                Booking(
                    filial_id=fx["filial"],
                    master_id=fx["master"],
                    client_id=fx["client"],
                    service_id=fx["service"],
                    start_at=now - timedelta(days=i + 1),
                    end_at=now - timedelta(days=i + 1) + timedelta(hours=1),
                    status="done",
                    idempotency_key=f"score-{uuid.uuid4().hex}",
                )
            )
        await s.commit()
        score = await perks.master_score(s, fx["master"], days=30)
    # profit 4000₽*0.01=40, done 2*10=20, rating 4.8*20=96, спектр 1*50=50, аптайм 6ч*30/7*2≈51.4
    assert score["profit_rub"] == 4000.0
    assert score["done"] == 2.0
    assert score["rating"] == 4.8
    assert score["spectrum"] == 1.0
    assert abs(score["total"] - (40 + 20 + 96 + 50 + 6 * 30 / 7 * 2)) < 0.2


async def test_leaderboard_ordered() -> None:
    await _fixture()
    async with SessionLocal() as s:
        board = await perks.leaderboard(s, limit=50)
    names = [str(r["name"]) for r in board]
    assert any("Мастер" in n for n in names)
    totals = [float(r["total"]) for r in board]
    assert totals == sorted(totals, reverse=True)


@pytest_asyncio.fixture()
async def client():  # type: ignore[no-untyped-def]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c


async def test_api_bad_promo_422(client: httpx.AsyncClient) -> None:
    fx = await _fixture()
    email = fx["email"]
    assert isinstance(email, str)
    from app.core.security import hash_password

    async with SessionLocal() as s:
        u = await s.scalar(select(User).where(User.email == email))
        assert u is not None
        u.password_hash = hash_password("pw123456")
        await s.commit()
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": "pw123456"})
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    body = {
        "master_id": str(fx["master"]),
        "filial_id": str(fx["filial"]),
        "service_id": str(fx["service"]),
        "start_at": "2026-10-05T10:00:00+00:00",
        "promo_code": "НЕТ-ТАКОГО",
    }
    rr = await client.post(
        "/api/v1/bookings", json=body, headers={**h, "Idempotency-Key": uuid.uuid4().hex}
    )
    assert rr.status_code == 422
