"""Перки: промокоды, семейные подписки, геймификация мастеров.

Скидки не суммируются: на бронь идёт максимум из (промокод, подписка).
Поинты мастера за 30 дней: прибыль + выполненные + рейтинг + спектр + аптайм.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.models import (
    Booking,
    FamilySubscription,
    MasterProfile,
    Promocode,
    Role,
    ScheduleRule,
    Service,
    SubscriptionMember,
    User,
)

# Веса поинтов (поинты = взвешенная сумма, шкалы подобраны под демо-объёмы).
W_PROFIT = 0.01  # за рубль выручки
W_DONE = 10.0  # за выполненный визит
W_RATING = 20.0  # за единицу рейтинга (4.9 → ~98)
W_SPECTRUM = 50.0  # за каждую distinct-услугу в окне
W_UPTIME = 2.0  # за час по расписанию


class PromoError(Exception):
    pass


async def validate_promo(
    session: AsyncSession,
    code: str,
    *,
    filial_id: uuid.UUID,
    service_id: uuid.UUID,
    master_id: uuid.UUID,
    now: datetime | None = None,
) -> Promocode:
    """Проверяет промокод: активность, окно, лимит, привязки. Чистая проверка, без записи."""
    norm = (code or "").strip().upper()
    if not norm:
        raise PromoError("empty code")
    promo = await session.scalar(select(Promocode).where(Promocode.code == norm))
    if promo is None:
        raise PromoError("unknown code")
    if not promo.active:
        raise PromoError("inactive")
    now = now or datetime.now(UTC)
    if promo.valid_from and now < promo.valid_from:
        raise PromoError("not started")
    if promo.valid_to and now > promo.valid_to:
        raise PromoError("expired")
    if promo.max_uses is not None and promo.used_count >= promo.max_uses:
        raise PromoError("exhausted")
    if promo.filial_id and promo.filial_id != filial_id:
        raise PromoError("wrong filial")
    if promo.service_id and promo.service_id != service_id:
        raise PromoError("wrong service")
    if promo.master_id and promo.master_id != master_id:
        raise PromoError("wrong master")
    return promo


async def subscription_discount(session: AsyncSession, user_id: uuid.UUID) -> int:
    """Максимальная скидка % по активным подпискам (владелец или участник)."""
    now = datetime.now(UTC)
    subq_owner = select(FamilySubscription.discount_pct).where(
        FamilySubscription.owner_id == user_id,
        FamilySubscription.active.is_(True),
        (FamilySubscription.valid_to.is_(None)) | (FamilySubscription.valid_to >= now),
    )
    subq_member = (
        select(FamilySubscription.discount_pct)
        .join(
            SubscriptionMember,
            SubscriptionMember.subscription_id == FamilySubscription.id,
        )
        .where(
            SubscriptionMember.user_id == user_id,
            FamilySubscription.active.is_(True),
            (FamilySubscription.valid_to.is_(None)) | (FamilySubscription.valid_to >= now),
        )
    )
    rows = (await session.execute(subq_owner.union(subq_member))).all()
    return max([r[0] for r in rows] or [0])


async def resolve_discount_pct(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    promo_code: str | None,
    filial_id: uuid.UUID,
    service_id: uuid.UUID,
    master_id: uuid.UUID,
) -> tuple[int, Promocode | None]:
    """Лучшая скидка % из (промокод, подписка). Промокод невалиден → PromoError.

    Возвращает промокод, только если скидка именно от него (иначе не тикает used_count).
    """
    sub = await subscription_discount(session, user_id)
    promo = None
    if promo_code:
        promo = await validate_promo(
            session,
            promo_code,
            filial_id=filial_id,
            service_id=service_id,
            master_id=master_id,
        )
    if promo is not None and promo.discount_pct >= sub:
        return promo.discount_pct, promo
    return sub, None


async def master_score(
    session: AsyncSession, master_id: uuid.UUID, days: int = 30
) -> dict[str, float]:
    """Поинты мастера за окно: прибыль + визиты + рейтинг + спектр + аптайм."""
    since = datetime.now(UTC) - timedelta(days=days)
    done_q = [Booking.master_id == master_id, Booking.status.in_(["done", "paid"])]
    revenue = (
        await session.scalar(
            select(func.coalesce(func.sum(Service.price_kopeks), 0))
            .join(Booking, Booking.service_id == Service.id)
            .where(*done_q, Booking.start_at >= since)
        )
        or 0
    )
    done = (
        await session.scalar(
            select(func.count()).select_from(Booking).where(*done_q, Booking.start_at >= since)
        )
        or 0
    )
    spectrum = (
        await session.scalar(
            select(func.count(func.distinct(Booking.service_id))).where(
                *done_q, Booking.start_at >= since, Booking.service_id.is_not(None)
            )
        )
        or 0
    )
    rating = (
        await session.scalar(select(MasterProfile.rating).where(MasterProfile.user_id == master_id))
        or 0.0
    )
    weekly_min = (
        await session.scalar(
            select(func.coalesce(func.sum(ScheduleRule.end_min - ScheduleRule.start_min), 0)).where(
                ScheduleRule.master_id == master_id
            )
        )
        or 0
    )
    uptime_hours = weekly_min / 60 * (days / 7)
    profit_rub = revenue / 100
    total = (
        profit_rub * W_PROFIT
        + done * W_DONE
        + rating * W_RATING
        + spectrum * W_SPECTRUM
        + uptime_hours * W_UPTIME
    )
    return {
        "profit_rub": float(profit_rub),
        "done": float(done),
        "rating": float(rating),
        "spectrum": float(spectrum),
        "uptime_hours": float(uptime_hours),
        "total": round(total, 1),
    }


async def leaderboard(
    session: AsyncSession,
    limit: int = 10,
    days: int = 30,
    filial_id: uuid.UUID | None = None,
) -> list[dict[str, Any]]:
    """Топ мастеров по поинтам (опционально в разрезе филиала)."""
    q = (
        select(User, MasterProfile)
        .join(MasterProfile, MasterProfile.user_id == User.id)
        .where(User.role == Role.master)
        .order_by(MasterProfile.display_name)
    )
    if filial_id:
        master_ids = (
            (
                await session.execute(
                    select(ScheduleRule.master_id)
                    .where(ScheduleRule.filial_id == filial_id)
                    .distinct()
                )
            )
            .scalars()
            .all()
        )
        q = q.where(User.id.in_(master_ids))
    rows = (await session.execute(q)).unique().all()
    board: list[dict[str, Any]] = []
    for u, p in rows:
        score = await master_score(session, u.id, days=days)
        board.append({"name": p.display_name, "rating": p.rating, **score})
    board.sort(key=lambda r: float(r["total"]), reverse=True)
    return board[:limit]
