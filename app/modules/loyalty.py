"""Скидки и лояльность: день рождения, уровни по визитам."""

import uuid
from datetime import UTC, date, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.models import Booking, User

BIRTHDAY_DISCOUNT = 0.15
BIRTHDAY_WINDOW_DAYS = 7

LOYALTY_LEVELS = [
    (0, "Базовый", 0.0),
    (5, "Серебро", 0.05),
    (15, "Золото", 0.10),
]


def birthday_discount(user: User, today: date | None = None) -> float:
    """15% в течение недели до и после дня рождения."""
    if not user.birth_date:
        return 0.0
    today = today or datetime.now(UTC).date()
    bd = user.birth_date.replace(year=today.year)
    delta = abs((bd - today).days)
    if delta <= BIRTHDAY_WINDOW_DAYS:
        return BIRTHDAY_DISCOUNT
    return 0.0


async def visits_count(session: AsyncSession, user_id: uuid.UUID) -> int:
    return (
        await session.scalar(
            select(func.count())
            .select_from(Booking)
            .where(Booking.client_id == user_id, Booking.status.in_(["done", "paid"]))
        )
        or 0
    )


def loyalty_level(visits: int) -> tuple[str, float]:
    name, discount = LOYALTY_LEVELS[0][1], LOYALTY_LEVELS[0][2]
    for threshold, n, d in LOYALTY_LEVELS:
        if visits >= threshold:
            name, discount = n, d
    return name, discount


async def next_level_progress(session: AsyncSession, user_id: uuid.UUID) -> tuple[int, int]:
    """(визитов до следующего уровня, порог следующего уровня)."""
    visits = await visits_count(session, user_id)
    for threshold, _, _ in LOYALTY_LEVELS:
        if visits < threshold:
            return threshold - visits, threshold
    return 0, LOYALTY_LEVELS[-1][0]
