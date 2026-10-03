"""SSR: каталог → мастер → слоты → бронь, кабинеты. HTMX для слотов, формы с CSRF."""

import calendar
import uuid
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth import service as auth
from app.modules.auth.deps import ACCESS_COOKIE, get_current_user, require_roles
from app.modules.booking import service as booking
from app.modules.models import Booking, Filial, MasterProfile, Role, ScheduleRule, Service, User
from app.modules.web import csrf

router = APIRouter(tags=["web"])
tpl = Jinja2Templates(directory="templates")

DEMO_PW = "demo1234"
DEMO_ACCOUNTS = {
    "client": ("client@demo.local", "/cabinet"),
    "master": ("master00@demo.local", "/master"),
    "moderator": ("moderator@demo.local", "/manager"),
    "admin": ("admin@demo.local", "/admin"),
}


def _ctx(request: Request, **kw: object) -> dict[str, object]:
    return {"request": request, "nonce": getattr(request.state, "csp_nonce", ""), **kw}


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

    # Статичные отзывы для демо
    reviews = [
        {
            "name": "Артём",
            "text": "Пришёл за 15 минут до закрытия — всё равно записали. Стрижка вспышка — топ!",
        },
        {
            "name": "Мария",
            "text": "Понравилось, что цена сразу на месте, без доплат. Мастер объяснил, что подойдёт именно мне.",
        },
        {
            "name": "Дмитрий",
            "text": "Результат — на фото. Скидка ко дню рождения сработала автоматически, приятно.",
        },
    ]

    return tpl.TemplateResponse(
        request,
        "index.html",
        _ctx(
            request, filials=filials, user=user, popular=popular, masters=masters, reviews=reviews
        ),
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


@router.get("/register", response_class=HTMLResponse)
async def register_form(request: Request) -> HTMLResponse:
    token = request.cookies.get(csrf.CSRF_COOKIE, "") or csrf.new_token()
    resp = tpl.TemplateResponse(request, "register.html", _ctx(request, csrf_token=token))
    resp.set_cookie(csrf.CSRF_COOKIE, token, samesite="lax")
    return resp


@router.post("/register")
async def register_submit(
    request: Request,
    email: str = Form(),
    password: str = Form(),
    pd_consent: str | None = Form(None),
    csrf_token: str = Form(),
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    csrf.check(request, csrf_token)
    if not pd_consent:
        raise HTTPException(400, "необходимо согласие с обработкой персональных данных")
    try:
        await auth.register(session, email, password)
    except auth.AuthError as e:
        raise HTTPException(409, str(e)) from e
    access, refresh = await auth.login(session, email, password)
    resp = RedirectResponse("/cabinet", status_code=303)
    resp.set_cookie(ACCESS_COOKIE, access, httponly=True, samesite="lax", max_age=900)
    resp.set_cookie("pfp_refresh", refresh, httponly=True, samesite="lax", max_age=30 * 86400)
    resp.set_cookie(csrf.CSRF_COOKIE, csrf.new_token(), samesite="lax")
    return resp


@router.post("/demo/{role}")
async def demo_login(
    role: str,
    request: Request,
    csrf_token: str = Form(),
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    csrf.check(request, csrf_token)
    pair = DEMO_ACCOUNTS.get(role)
    if pair is None:
        raise HTTPException(404, "unknown demo role")
    email, dest = pair
    try:
        access, refresh = await auth.login(session, email, DEMO_PW)
    except auth.AuthError:
        raise HTTPException(409, "demo account missing — run seed") from None
    resp = RedirectResponse(dest, status_code=303)
    resp.set_cookie(ACCESS_COOKIE, access, httponly=True, samesite="lax", max_age=900)
    resp.set_cookie("pfp_refresh", refresh, httponly=True, samesite="lax", max_age=30 * 86400)
    resp.set_cookie(csrf.CSRF_COOKIE, csrf.new_token(), samesite="lax")
    return resp


@router.get("/cabinet", response_class=HTMLResponse)
async def cabinet(
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    from app.modules import loyalty

    rows = (
        await session.execute(
            select(Booking, Service)
            .join(Service, Service.id == Booking.service_id)
            .where(Booking.client_id == user.id)
            .order_by(Booking.start_at.desc())
            .limit(20)
        )
    ).all()
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
            rows=rows,
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
        ),
    )


async def _stats(session: AsyncSession, filial_id: uuid.UUID | None) -> dict[str, object]:
    """Агрегаты для дашборда: счётчики, выручка (done+paid), 14 дней, топ мастеров."""
    bf = [Booking.filial_id == filial_id] if filial_id else []
    total = await session.scalar(select(func.count()).select_from(Booking).where(*bf)) or 0
    status_rows = (
        await session.execute(
            select(Booking.status, func.count()).where(*bf).group_by(Booking.status)
        )
    ).all()
    by_status = {row[0]: row[1] for row in status_rows}
    revenue = (
        await session.scalar(
            select(func.coalesce(func.sum(Service.price_kopeks), 0))
            .join(Booking, Booking.service_id == Service.id)
            .where(*bf, Booking.status.in_(["done", "paid"]))
        )
        or 0
    )
    since = datetime.now(UTC) - timedelta(days=14)
    day = func.date_trunc("day", Booking.start_at)
    per_day = (
        await session.execute(
            select(day, func.count())
            .where(*bf, Booking.start_at >= since)
            .group_by(day)
            .order_by(day)
        )
    ).all()
    top = (
        await session.execute(
            select(MasterProfile.display_name, func.count())
            .join(User, User.id == MasterProfile.user_id)
            .join(Booking, Booking.master_id == User.id)
            .where(*bf)
            .group_by(MasterProfile.display_name)
            .order_by(func.count().desc())
            .limit(5)
        )
    ).all()
    bars = [{"label": str(d)[:10], "v": c} for d, c in per_day]
    mx = max([b["v"] for b in bars] + [1])
    for b in bars:
        b["h"] = round(b["v"] / mx * 100)
    return {
        "total": total,
        "by_status": by_status,
        "revenue": revenue / 100,
        "bars": bars,
        "top": top,
    }


@router.get("/manager", response_class=HTMLResponse)
async def manager(
    request: Request,
    filial_id: uuid.UUID | None = None,
    user: User = Depends(require_roles(Role.moderator, Role.admin)),
    session: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    filials = (await session.execute(select(Filial).order_by(Filial.name))).scalars().all()
    fid = filial_id or (filials[0].id if filials else None)
    stats = await _stats(session, fid) if fid else {}
    return tpl.TemplateResponse(
        request, "manager.html", _ctx(request, user=user, filials=filials, fid=fid, stats=stats)
    )


@router.get("/admin", response_class=HTMLResponse)
async def admin(
    request: Request,
    user: User = Depends(require_roles(Role.admin)),
    session: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    users = (
        (await session.execute(select(User).order_by(User.created_at.desc()).limit(50)))
        .scalars()
        .all()
    )
    stats = await _stats(session, None)
    csrf_token = request.cookies.get(csrf.CSRF_COOKIE, "") or csrf.new_token()
    resp = tpl.TemplateResponse(
        request,
        "admin.html",
        _ctx(request, user=user, users=users, stats=stats, csrf_token=csrf_token, Role=Role),
    )
    if not request.cookies.get(csrf.CSRF_COOKIE):
        resp.set_cookie(csrf.CSRF_COOKIE, csrf_token, samesite="lax")
    return resp


@router.post("/admin/role")
async def admin_role(
    request: Request,
    user_id: uuid.UUID = Form(),
    role: str = Form(),
    csrf_token: str = Form(),
    user: User = Depends(require_roles(Role.admin)),
    session: AsyncSession = Depends(get_session),
) -> RedirectResponse:
    csrf.check(request, csrf_token)
    try:
        await auth.set_role(session, user_id, Role(role))
    except (ValueError, auth.AuthError) as e:
        raise HTTPException(422, str(e)) from e
    return RedirectResponse("/admin", status_code=303)
