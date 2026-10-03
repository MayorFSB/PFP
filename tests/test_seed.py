"""Сид идемпотентен: повторный прогон не меняет счётчики. Гоняем на pfp_test."""

from sqlalchemy import func, select

from app.core.db import SessionLocal
from app.modules import seed
from app.modules.models import Booking, Filial, Service, User


async def _counts() -> tuple[int, int, int, int]:
    async with SessionLocal() as s:
        f = await s.scalar(select(func.count()).select_from(Filial)) or 0
        sv = await s.scalar(select(func.count()).select_from(Service)) or 0
        u = await s.scalar(select(func.count()).select_from(User)) or 0
        b = await s.scalar(select(func.count()).select_from(Booking)) or 0
        return f, sv, u, b


async def test_seed_idempotent() -> None:
    await seed.main(clients=5, visits=5)
    first = await _counts()
    await seed.main(clients=5, visits=5)
    assert await _counts() == first
    assert first[0] >= 3 and first[1] > 20  # филиалы + прайс реально залились
