"""Формы входа/регистрации: SSR-обёртки над auth-сервисом с CSRF."""

from fastapi import APIRouter, Depends, Form, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth import service as auth
from app.modules.auth.deps import ACCESS_COOKIE
from app.modules.web import csrf
from app.modules.web.common import DEMO_ACCOUNTS, DEMO_PW, _ctx, tpl

router = APIRouter(tags=["web"])


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
