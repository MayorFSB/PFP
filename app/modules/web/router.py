"""SSR: каталог → мастер → слоты → бронь, кабинеты. HTMX для слотов, формы с CSRF."""

import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth import service as auth
from app.modules.auth.deps import ACCESS_COOKIE, get_current_user
from app.modules.booking import service as booking
from app.modules.models import Booking, Filial, MasterProfile, Role, ScheduleRule, Service, User
from app.modules.web import csrf

router = APIRouter(tags=["web"])
tpl = Jinja2Templates(directory="templates")


def _ctx(request: Request, **kw: object) -> dict[str, object]:
    return {"request": request, **kw}


async def _optional_user(request: Request, session: AsyncSession) -> User | None:
    try:
        return await get_current_user(
            authorization="", pfp_access=request.cookies.get(ACCESS_COOKIE, ""), session=session
        )
    except HTTPException:
        return None


@router.get("/", response_class=HTMLResponse)
async def index(request: Request, session: AsyncSession = Depends(get_session)) -> HTMLResponse:
    filials = (await session.execute(select(Filial).order_by(Filial.name))).scalars().all()
    user = await _optional_user(request, session)
    return tpl.TemplateResponse(request, "index.html", _ctx(request, filials=filials, user=user))


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
        _ctx(request, filial=f, services=services, masters=masters, user=user),
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


@router.get("/login", response_class=HTMLResponse)
async def login_form(request: Request) -> HTMLResponse:
    token = request.cookies.get(csrf.CSRF_COOKIE, "") or csrf.new_token()
    resp = tpl.TemplateResponse(request, "login.html", _ctx(request, csrf_token=token))
    resp.set_cookie(csrf.CSRF_COOKIE, token, samesite="lax")
    return resp


@router.post("/login")
async def login(
    request: Request,
    email: str = Form(),
    password: str = Form(),
    csrf_token: str = Form(),
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    csrf.check(request, csrf_token)
    try:
        access, refresh = await auth.login(session, email, password)
    except auth.AuthError:
        raise HTTPException(401, "bad credentials") from None
    resp = RedirectResponse("/cabinet", status_code=303)
    resp.set_cookie(ACCESS_COOKIE, access, httponly=True, samesite="lax", max_age=900)
    resp.set_cookie("pfp_refresh", refresh, httponly=True, samesite="lax", max_age=30 * 86400)
    resp.set_cookie(csrf.CSRF_COOKIE, csrf.new_token(), samesite="lax")
    return resp


@router.post("/logout")
async def logout(
    request: Request, csrf_token: str = Form(), session: AsyncSession = Depends(get_session)
) -> RedirectResponse:
    csrf.check(request, csrf_token)
    await auth.logout(session, request.cookies.get("pfp_refresh", ""))
    resp = RedirectResponse("/", status_code=303)
    resp.delete_cookie(ACCESS_COOKIE)
    resp.delete_cookie("pfp_refresh")
    return resp


@router.get("/cabinet", response_class=HTMLResponse)
async def cabinet(
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    rows = (
        await session.execute(
            select(Booking, Service)
            .join(Service, Service.id == Booking.service_id)
            .where(Booking.client_id == user.id)
            .order_by(Booking.start_at.desc())
            .limit(20)
        )
    ).all()
    csrf_token = request.cookies.get(csrf.CSRF_COOKIE, "") or csrf.new_token()
    resp = tpl.TemplateResponse(
        request, "cabinet.html", _ctx(request, user=user, rows=rows, csrf_token=csrf_token)
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
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    from datetime import datetime

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
        )
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
    start = datetime.now(UTC).date().isoformat()
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
        request, "master.html", _ctx(request, user=user, rows=rows, start=start)
    )
