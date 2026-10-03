"""Бронь: слоты из недельных правил минус занятое, insert под exclusion constraint."""

import uuid
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import cache
from app.modules.models import Booking, ScheduleRule, Service


class SlotTaken(Exception):
    pass


def build_slots(
    rules: list[tuple[int, int]],
    busy: list[tuple[datetime, datetime]],
    day: date,
    duration_min: int,
) -> list[str]:
    """Чистая функция: окна правил + шаг duration, вычитаем пересечения. Тестируется без БД."""
    free: list[str] = []
    for start_min, end_min in rules:
        t = start_min
        while t + duration_min <= end_min:
            s = datetime.combine(day, time(t // 60, t % 60), tzinfo=UTC)
            e = s + timedelta(minutes=duration_min)
            if not any(s < b_e and b_s < e for b_s, b_e in busy):
                free.append(s.isoformat())
            t += duration_min
    return sorted(free)


async def day_slots(
    session: AsyncSession,
    filial_id: uuid.UUID,
    master_id: uuid.UUID,
    day: date,
    service_id: uuid.UUID,
) -> list[str]:
    svc = await session.get(Service, service_id)
    if svc is None:
        return []
    key = cache.slots_key(f"{filial_id}:{master_id}:{service_id}", day.isoformat())

    async def _load() -> list[str]:
        rows = (
            await session.execute(
                select(ScheduleRule.start_min, ScheduleRule.end_min).where(
                    ScheduleRule.master_id == master_id,
                    ScheduleRule.filial_id == filial_id,
                    ScheduleRule.weekday == day.weekday(),
                )
            )
        ).all()
        day_start = datetime.combine(day, time.min, tzinfo=UTC)
        day_end = day_start + timedelta(days=1)
        booked = (
            await session.execute(
                select(Booking.start_at, Booking.end_at).where(
                    Booking.master_id == master_id,
                    Booking.start_at >= day_start,
                    Booking.start_at < day_end,
                    Booking.status != "cancelled",
                )
            )
        ).all()
        busy = [
            (b_s, b_e if b_e else b_s + timedelta(minutes=svc.duration_min)) for b_s, b_e in booked
        ]
        return build_slots([(r[0], r[1]) for r in rows], busy, day, svc.duration_min)

    out: list[str] = await cache.cached(key, 120, _load)
    return out


async def create_booking(
    session: AsyncSession,
    *,
    idempotency_key: str,
    client_id: uuid.UUID,
    master_id: uuid.UUID,
    filial_id: uuid.UUID,
    service_id: uuid.UUID,
    start_at: datetime,
) -> Booking:
    dup = await session.scalar(select(Booking).where(Booking.idempotency_key == idempotency_key))
    if dup is not None:
        return dup  # повтор с тем же ключом — та же бронь, без дубля
    svc = await session.get(Service, service_id)
    if svc is None:
        raise SlotTaken("no service")
    day = start_at.date()
    if start_at.isoformat() not in await day_slots(session, filial_id, master_id, day, service_id):
        raise SlotTaken("slot taken")
    booking = Booking(
        filial_id=filial_id,
        master_id=master_id,
        client_id=client_id,
        service_id=service_id,
        start_at=start_at,
        end_at=start_at + timedelta(minutes=svc.duration_min),
        idempotency_key=idempotency_key,
    )
    session.add(booking)
    try:
        await session.commit()
    except IntegrityError:
        # Гонка: второй инсерт с тем же ключом или пересечение (exclusion) — читаем победителя
        await session.rollback()
        winner = await session.scalar(
            select(Booking).where(Booking.idempotency_key == idempotency_key)
        )
        if winner is not None:
            return winner
        raise SlotTaken("slot taken") from None
    await session.refresh(booking)
    await cache.invalidate(
        cache.slots_key(f"{filial_id}:{master_id}:{service_id}", day.isoformat())
    )
    return booking


async def cancel_booking(
    session: AsyncSession, booking_id: uuid.UUID, client_id: uuid.UUID
) -> Booking:
    booking = await session.get(Booking, booking_id)
    if booking is None or booking.client_id != client_id:
        raise SlotTaken("not found")
    booking.status = "cancelled"
    await session.commit()
    await session.refresh(booking)
    await cache.invalidate(
        cache.slots_key(
            f"{booking.filial_id}:{booking.master_id}:{booking.service_id}",
            booking.start_at.date().isoformat(),
        )
    )
    return booking
