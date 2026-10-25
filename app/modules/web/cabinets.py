"""Кабинеты: клиент (записи, лояльность), бронь/отмена, мастер (неделя+месяц)."""

import calendar
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.db import get_session
from app.modules import loyalty, perks
from app.modules.auth.deps import get_current_user
from app.modules.booking import service as booking
from app.modules.models import Booking, Filial, Role, Service, User
from app.modules.web import csrf
from app.modules.web.common import _ctx, tpl

router = APIRouter(tags=["web"])


@router.get("/cabinet", response_class=HTMLResponse)
async def cabinet(
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    master = aliased(User)
    rows = (
        await session.execute(
            select(Booking, Service, Filial, master)
            .join(Service, Service.id == Booking.service_id)
            .join(Filial, Filial.id == Booking.filial_id)
            .join(master, master.id == Booking.master_id)
            .where(Booking.client_id == user.id)
            .order_by(Booking.start_at.desc())
            .limit(20)
        )
    ).all()
    # Ближайшие (не наступившие, живые) и история. now берём с таймзоной
    # записей: asyncpg отдаёт aware-даты, наивное сравнение упало бы.
    sample = rows[0][0].start_at if rows else None
    now = datetime.now(sample.tzinfo) if sample and sample.tzinfo else datetime.now(UTC)
    upcoming, past = [], []
    for b, s, f, m in rows:
        if b.start_at >= now and b.status in ("pending", "paid"):
            upcoming.append((b, s, f, m))
        else:
            past.append((b, s, f, m))
    upcoming.reverse()  # ближайшая — первой (в rows всё шло по убыванию даты)
    visits = await loyalty.visits_count(session, user.id)
    level_name, level_discount = loyalty.loyalty_level(visits)
    to_next, next_threshold = await loyalty.next_level_progress(session, user.id)
    bd = loyalty.birthday_discount(user)
    csrf_token = request.cookies.get(csrf.CSRF_COOKIE, "") or csrf.new_token()
    resp = tpl.TemplateResponse(
        request,
        "cabinet.html",
        _ctx(
            request,
            user=user,
            upcoming=upcoming,
            past=past,
            csrf_token=csrf_token,
            visits=visits,
            level_name=level_name,
            level_discount=level_discount,
            to_next=to_next,
            next_threshold=next_threshold,
            birthday_discount=bd,
        ),
    )
    if not request.cookies.get(csrf.CSRF_COOKIE):
        resp.set_cookie(csrf.CSRF_COOKIE, csrf_token, samesite="lax")
    return resp


@router.post("/book")
async def book_form(
    request: Request,
    master_id: uuid.UUID = Form(),
    filial_id: uuid.UUID = Form(),
    service_id: uuid.UUID = Form(),
    start_at: str = Form(),
    csrf_token: str = Form(),
    idempotency_key: str = Form(),
    promo_code: str | None = Form(None),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    csrf.check(request, csrf_token)
    try:
        await booking.create_booking(
            session,
            idempotency_key=idempotency_key or uuid.uuid4().hex,
            client_id=user.id,
            master_id=master_id,
            filial_id=filial_id,
            service_id=service_id,
            start_at=datetime.fromisoformat(start_at),
            promo_code=promo_code or None,
        )
    except perks.PromoError as e:
        raise HTTPException(422, f"bad promo: {e}") from e
    except booking.SlotTaken as e:
        raise HTTPException(409, str(e)) from e
    return RedirectResponse("/cabinet", status_code=303)


@router.post("/cancel/{booking_id}")
async def cancel_form(
    request: Request,
    booking_id: uuid.UUID,
    csrf_token: str = Form(),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    csrf.check(request, csrf_token)
    try:
        await booking.cancel_booking(session, booking_id, user.id)
    except booking.SlotTaken as e:
        raise HTTPException(404, str(e)) from e
    return RedirectResponse("/cabinet", status_code=303)


@router.get("/master", response_class=HTMLResponse)
async def master_cabinet(
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    if user.role not in (Role.master, Role.admin):
        raise HTTPException(403)

    today = datetime.now(UTC).date()
    # Неделя: Пн-Вс текущей недели
    monday = today - timedelta(days=today.weekday())
    sunday_eve = monday + timedelta(days=7)
    week_rows = (
        await session.execute(
            select(Booking, Service)
            .join(Service, Service.id == Booking.service_id)
            .where(
                Booking.master_id == user.id,
                Booking.status != "cancelled",
                Booking.start_at >= datetime(monday.year, monday.month, monday.day, tzinfo=UTC),
                Booking.start_at
                < datetime(sunday_eve.year, sunday_eve.month, sunday_eve.day, tzinfo=UTC),
            )
            .order_by(Booking.start_at)
        )
    ).all()

    week_labels = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
    week = []
    for i, wd in enumerate(week_labels):
        day_date = monday + timedelta(days=i)
        day_rows = [(b, s) for b, s in week_rows if b.start_at.date() == day_date]
        week.append(
            {
                "label": f"{wd} {day_date.day:02d}.{day_date.month:02d}",
                "rows": day_rows,
                "today": day_date == today,
            }
        )
    week_label = (
        f"{monday.day:02d}.{monday.month:02d} — {sunday_eve.day - 1:02d}.{sunday_eve.month:02d}"
    )

    # Месяц: календарная сетка с точками записей
    month_start = today.replace(day=1)
    month_end = (month_start + timedelta(days=32)).replace(day=1)
    month_bookings = (
        await session.execute(
            select(func.date(Booking.start_at), func.count())
            .where(
                Booking.master_id == user.id,
                Booking.status != "cancelled",
                Booking.start_at >= month_start,
                Booking.start_at < month_end,
            )
            .group_by(func.date(Booking.start_at))
        )
    ).all()
    booked_days = {str(d): c for d, c in month_bookings}

    cal = calendar.Calendar(firstweekday=0)
    cal_weeks: list[list[dict[str, object] | None]] = []
    for wk in cal.monthdatescalendar(today.year, today.month):
        row: list[dict[str, object] | None] = []
        for d in wk:
            if d.month != today.month:
                row.append(None)
            else:
                row.append(
                    {
                        "day": d.day,
                        "today": d == today,
                        "count": booked_days.get(d.isoformat(), 0),
                    }
                )
        cal_weeks.append(row)
    month_label = today.strftime("%B %Y").capitalize()

    # Ближайшие записи (таблица, как было)
    rows = (
        await session.execute(
            select(Booking, Service)
            .join(Service, Service.id == Booking.service_id)
            .where(Booking.master_id == user.id, Booking.status != "cancelled")
            .order_by(Booking.start_at)
            .limit(50)
        )
    ).all()

    return tpl.TemplateResponse(
        request,
        "master.html",
        _ctx(
            request,
            user=user,
            rows=rows,
            week=week,
            week_label=week_label,
            cal_weeks=cal_weeks,
            month_label=month_label,
            score=await perks.master_score(session, user.id),
        ),
    )
