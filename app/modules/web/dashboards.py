"""Дашборды: управляющий (статистика филиала) и админ (пользователи, роли)."""

import uuid
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules import perks
from app.modules.auth import service as auth
from app.modules.auth.deps import require_roles
from app.modules.models import Booking, Filial, MasterProfile, Role, Service, User
from app.modules.web import csrf
from app.modules.web.common import _ctx, tpl

router = APIRouter(tags=["web"])


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
    board = await perks.leaderboard(session, filial_id=fid) if fid else []
    return tpl.TemplateResponse(
        request,
        "manager.html",
        _ctx(request, user=user, filials=filials, fid=fid, stats=stats, board=board),
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
