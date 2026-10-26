"""Публичные SSR-страницы: главная, каталог филиалов, документы, слоты."""

import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.booking import service as booking
from app.modules.models import Booking, Filial, MasterProfile, ScheduleRule, Service, User
from app.modules.web.common import DEMO_REVIEWS, _ctx, _optional_user, tpl

router = APIRouter(tags=["web"])


@router.get("/", response_class=HTMLResponse)
async def index(request: Request, session: AsyncSession = Depends(get_session)) -> HTMLResponse:
    filials = (await session.execute(select(Filial).order_by(Filial.name))).scalars().all()
    user = await _optional_user(request, session)

    # Популярные услуги: топ-4 по количеству выполненных записей
    popular_q = (
        await session.execute(
            select(Service, func.count(Booking.id))
            .join(Booking, Booking.service_id == Service.id)
            .where(Booking.status.in_(["done", "paid"]))
            .group_by(Service.id)
            .order_by(func.count(Booking.id).desc())
            .limit(4)
        )
    ).all()
    popular: list[tuple[Service, int]] = [(row[0], row[1]) for row in popular_q]
    if not popular:
        popular = [
            (s, 0)
            for s in (
                await session.execute(
                    select(Service)
                    .join(Filial, Filial.id == Service.filial_id)
                    .where(Filial.name == "Центр")
                    .order_by(Service.price_kopeks)
                    .limit(4)
                )
            )
            .scalars()
            .all()
        ]

    # Команда мастеров (6 первых по имени)
    masters = (
        await session.execute(
            select(User, MasterProfile)
            .join(MasterProfile, MasterProfile.user_id == User.id)
            .order_by(MasterProfile.display_name)
            .limit(6)
        )
    ).all()

    return tpl.TemplateResponse(
        request,
        "index.html",
        _ctx(request, filials=filials, user=user, popular=popular, masters=masters),
    )


@router.get("/reviews", response_class=HTMLResponse)
async def reviews_page(request: Request) -> HTMLResponse:
    return tpl.TemplateResponse(request, "reviews.html", _ctx(request, reviews=DEMO_REVIEWS))


@router.get("/promos", response_class=HTMLResponse)
async def promos_page(request: Request) -> HTMLResponse:
    return tpl.TemplateResponse(request, "promos.html", _ctx(request))


@router.get("/certs", response_class=HTMLResponse)
async def certs_page(request: Request) -> HTMLResponse:
    return tpl.TemplateResponse(request, "certs.html", _ctx(request))


@router.get("/filials", response_class=HTMLResponse)
async def filials_index(
    request: Request, session: AsyncSession = Depends(get_session)
) -> HTMLResponse:
    rows = (await session.execute(select(Filial).order_by(Filial.name))).scalars().all()
    n = len(rows)
    d10, d100 = n % 10, n % 100
    filial_word = (
        "филиал"
        if d10 == 1 and d100 != 11
        else "филиала"
        if 2 <= d10 <= 4 and not 12 <= d100 <= 14
        else "филиалов"
    )
    services = (
        (await session.execute(select(Service).order_by(Service.price_kopeks))).scalars().all()
    )
    by_filial: dict[uuid.UUID, list[Service]] = {f.id: [] for f in rows}
    for s in services:
        by_filial.setdefault(s.filial_id, []).append(s)
    return tpl.TemplateResponse(
        request,
        "filials.html",
        _ctx(request, filials=rows, by_filial=by_filial, filial_word=filial_word),
    )


@router.get("/policy", response_class=HTMLResponse)
async def policy(request: Request) -> HTMLResponse:
    return tpl.TemplateResponse(request, "policy.html", _ctx(request))


@router.get("/agreement", response_class=HTMLResponse)
async def agreement(request: Request) -> HTMLResponse:
    return tpl.TemplateResponse(request, "agreement.html", _ctx(request))


@router.get("/offer", response_class=HTMLResponse)
async def offer(request: Request) -> HTMLResponse:
    return tpl.TemplateResponse(request, "offer.html", _ctx(request))


@router.get("/f/{filial_id}", response_class=HTMLResponse)
async def filial(
    request: Request, filial_id: uuid.UUID, session: AsyncSession = Depends(get_session)
) -> HTMLResponse:
    f = await session.get(Filial, filial_id)
    if f is None:
        raise HTTPException(404)
    services = (
        (
            await session.execute(
                select(Service).where(Service.filial_id == f.id).order_by(Service.price_kopeks)
            )
        )
        .scalars()
        .all()
    )
    master_ids = (
        (
            await session.execute(
                select(ScheduleRule.master_id).where(ScheduleRule.filial_id == f.id).distinct()
            )
        )
        .scalars()
        .all()
    )
    masters = (
        (
            await session.execute(
                select(User, MasterProfile)
                .join(MasterProfile, MasterProfile.user_id == User.id)
                .where(User.id.in_(master_ids))
                .order_by(MasterProfile.display_name)
            )
        )
        .unique()
        .all()
    )
    user = await _optional_user(request, session)
    return tpl.TemplateResponse(
        request,
        "filial.html",
        _ctx(
            request,
            filial=f,
            services=services,
            masters=masters,
            user=user,
            today=datetime.now(UTC).date().isoformat(),
        ),
    )


@router.get("/slots", response_class=HTMLResponse)
async def slots_partial(
    request: Request,
    filial_id: uuid.UUID,
    master_id: uuid.UUID,
    service_id: uuid.UUID,
    day: date,
    session: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    slots = await booking.day_slots(session, filial_id, master_id, day, service_id)
    key = uuid.uuid4().hex
    return tpl.TemplateResponse(
        request,
        "slots.html",
        _ctx(
            request,
            slots=slots,
            key=key,
            filial_id=filial_id,
            master_id=master_id,
            service_id=service_id,
        ),
    )
