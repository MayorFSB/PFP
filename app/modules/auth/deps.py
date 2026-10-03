"""Зависимости: текущий юзер + RBAC."""

import uuid

from fastapi import Cookie, Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import jwt as tokens
from app.core.db import get_session
from app.modules.models import Role, User

ACCESS_COOKIE = "pfp_access"


async def get_current_user(
    authorization: str = Header(default=""),
    pfp_access: str = Cookie(default=""),
    session: AsyncSession = Depends(get_session),
) -> User:
    token = authorization[7:] if authorization.startswith("Bearer ") else pfp_access
    if not token:
        raise HTTPException(401, "no token")
    try:
        payload = tokens.decode(token, "access")
    except ValueError:
        raise HTTPException(401, "bad token") from None
    user = await session.get(User, uuid.UUID(payload["sub"]))
    if user is None:
        raise HTTPException(401, "no user")
    return user


def require_roles(*roles: Role):  # type: ignore[no-untyped-def]
    async def _check(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise HTTPException(403, "forbidden")
        return user

    return _check


async def get_user_by_id(user_id: uuid.UUID, session: AsyncSession = Depends(get_session)) -> User:
    user = await session.scalar(select(User).where(User.id == user_id))
    if user is None:
        raise HTTPException(404, "no user")
    return user
