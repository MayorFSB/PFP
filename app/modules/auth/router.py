"""POST /register /login /refresh /logout, GET /me, Google + Telegram, PATCH role (admin)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, EmailStr
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth import service
from app.modules.auth.deps import get_current_user, require_roles
from app.modules.models import Role, User

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])
REFRESH_COOKIE = "pfp_refresh"


class RegisterIn(BaseModel):
    email: EmailStr
    password: str


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class TokenOut(BaseModel):
    access_token: str


def _set_cookie(resp: Response, refresh: str) -> None:
    resp.set_cookie(REFRESH_COOKIE, refresh, httponly=True, samesite="lax", max_age=30 * 86400)


@router.post("/register", status_code=201)
async def register(
    body: RegisterIn, session: AsyncSession = Depends(get_session)
) -> dict[str, str]:
    try:
        user = await service.register(session, body.email, body.password)
    except service.AuthError as e:
        raise HTTPException(409, str(e)) from e
    return {"id": str(user.id), "email": user.email}


@router.post("/login")
async def login(
    body: LoginIn, resp: Response, request: Request, session: AsyncSession = Depends(get_session)
) -> TokenOut:
    from app.core.guard import login_allowed

    ip = request.client.host if request.client else "unknown"
    if not await login_allowed(ip, body.email):
        raise HTTPException(429, "too many attempts")
    try:
        access, refresh = await service.login(session, body.email, body.password)
    except service.AuthError as e:
        raise HTTPException(401, str(e)) from e
    _set_cookie(resp, refresh)
    return TokenOut(access_token=access)


@router.post("/refresh")
async def refresh(
    body: dict[str, str], resp: Response, session: AsyncSession = Depends(get_session)
) -> TokenOut:
    token = body.get("refresh_token", "")
    try:
        access, new_refresh = await service.rotate(session, token)
    except service.AuthError as e:
        raise HTTPException(401, str(e)) from e
    _set_cookie(resp, new_refresh)
    return TokenOut(access_token=access)


@router.post("/logout")
async def logout(
    body: dict[str, str], session: AsyncSession = Depends(get_session)
) -> dict[str, bool]:
    await service.logout(session, body.get("refresh_token", ""))
    return {"ok": True}


@router.get("/me")
async def me(user: User = Depends(get_current_user)) -> dict[str, str]:
    return {"id": str(user.id), "email": user.email, "role": user.role.value}


@router.patch("/users/{user_id}/role", dependencies=[Depends(require_roles(Role.admin))])
async def set_role(
    user_id: uuid.UUID, body: dict[str, str], session: AsyncSession = Depends(get_session)
) -> dict[str, str]:
    try:
        user = await service.set_role(session, user_id, Role(body["role"]))
    except (service.AuthError, ValueError) as e:
        raise HTTPException(404 if isinstance(e, service.AuthError) else 422, str(e)) from e
    return {"id": str(user.id), "role": user.role.value}


@router.get("/google/url")
async def google_url() -> dict[str, str]:
    try:
        return {"url": service.google_auth_url()}
    except service.AuthError as e:
        raise HTTPException(503, str(e)) from e


@router.get("/google/callback")
async def google_callback(
    code: str, resp: Response, session: AsyncSession = Depends(get_session)
) -> TokenOut:
    try:
        access, refresh = await service.google_callback(session, code)
    except service.AuthError as e:
        raise HTTPException(503, str(e)) from e
    _set_cookie(resp, refresh)
    return TokenOut(access_token=access)


@router.post("/telegram")
async def telegram(
    body: dict[str, str], resp: Response, session: AsyncSession = Depends(get_session)
) -> TokenOut:
    try:
        access, refresh = await service.telegram_login(session, body)
    except service.AuthError as e:
        raise HTTPException(401, str(e)) from e
    _set_cookie(resp, refresh)
    return TokenOut(access_token=access)
