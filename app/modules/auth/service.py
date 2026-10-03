"""Auth-сервис: регистрация, логин, ротация refresh, OAuth-заглушки под ключи юзера."""

import hashlib
import hmac
import uuid
from urllib.parse import urlencode

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import jwt as tokens
from app.core.config import settings
from app.core.security import hash_password, verify_password
from app.modules.models import AuthSession, Role, User


class AuthError(Exception):
    pass


async def register(session: AsyncSession, email: str, password: str) -> User:
    email = email.strip().lower()
    exists = await session.scalar(select(User).where(User.email == email))
    if exists:
        raise AuthError("email taken")
    user = User(email=email, password_hash=hash_password(password), role=Role.client)
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


async def _issue(session: AsyncSession, user: User) -> tuple[str, str]:
    access, refresh, jti = tokens.create_pair(user.id, user.role.value)
    session.add(AuthSession(user_id=user.id, jti=jti))
    await session.commit()
    return access, refresh


async def login(session: AsyncSession, email: str, password: str) -> tuple[str, str]:
    user = await session.scalar(select(User).where(User.email == email.strip().lower()))
    if user is None or not verify_password(password, user.password_hash):
        raise AuthError("bad credentials")
    return await _issue(session, user)


async def rotate(session: AsyncSession, refresh_token: str) -> tuple[str, str]:
    try:
        payload = tokens.decode(refresh_token, "refresh")
    except ValueError as e:
        raise AuthError("bad token") from e
    sess = await session.scalar(select(AuthSession).where(AuthSession.jti == payload["jti"]))
    if sess is None:
        raise AuthError("unknown session")
    if sess.revoked:
        # Reuse отозванного = компрометация → сносим всё
        await session.execute(
            update(AuthSession).where(AuthSession.user_id == sess.user_id).values(revoked=True)
        )
        await session.commit()
        raise AuthError("reuse detected")
    sess.revoked = True
    user = await session.get(User, sess.user_id)
    assert user is not None
    await session.commit()
    return await _issue(session, user)


async def logout(session: AsyncSession, refresh_token: str) -> None:
    try:
        payload = tokens.decode(refresh_token, "refresh")
    except ValueError:
        return
    await session.execute(
        update(AuthSession).where(AuthSession.jti == payload["jti"]).values(revoked=True)
    )
    await session.commit()


# --- Google OIDC ---


def google_auth_url() -> str:
    if not settings.google_client_id:
        raise AuthError("google not configured")
    q = urlencode(
        {
            "client_id": settings.google_client_id,
            "redirect_uri": settings.google_redirect,
            "response_type": "code",
            "scope": "openid email profile",
        }
    )
    return f"https://accounts.google.com/o/oauth2/v2/auth?{q}"


async def google_callback(session: AsyncSession, code: str) -> tuple[str, str]:
    if not settings.google_client_id:
        raise AuthError("google not configured")
    async with httpx.AsyncClient(timeout=10) as c:
        tr = await c.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": settings.google_client_id,
                "client_secret": settings.google_client_secret,
                "redirect_uri": settings.google_redirect,
                "grant_type": "authorization_code",
            },
        )
        tr.raise_for_status()
        access_token = tr.json()["access_token"]
        ur = await c.get(
            "https://www.googleapis.com/oauth2/v3/userinfo",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        ur.raise_for_status()
        email = ur.json()["email"].lower()
    user = await session.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(email=email, password_hash="!", role=Role.client)  # oauth: пароля нет
        session.add(user)
        await session.commit()
        await session.refresh(user)
    return await _issue(session, user)


# --- Telegram Login Widget ---


def verify_telegram(data: dict[str, str]) -> bool:
    """Проверка hash по доке Telegram Login. Чистая функция — unit-тестируется без сети."""
    if not settings.telegram_bot_token or "hash" not in data:
        return False
    given = data.pop("hash")
    check = "\n".join(f"{k}={data[k]}" for k in sorted(data))
    key = hashlib.sha256(settings.telegram_bot_token.encode()).digest()
    return hmac.new(key, check.encode(), hashlib.sha256).hexdigest() == given


async def telegram_login(session: AsyncSession, data: dict[str, str]) -> tuple[str, str]:
    if not verify_telegram(dict(data)):
        raise AuthError("bad telegram hash")
    email = f"tg_{data['id']}@telegram.local"
    user = await session.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(email=email, password_hash="!", role=Role.client)
        session.add(user)
        await session.commit()
        await session.refresh(user)
    return await _issue(session, user)


async def set_role(session: AsyncSession, user_id: uuid.UUID, role: Role) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise AuthError("no user")
    user.role = role
    await session.commit()
    await session.refresh(user)
    return user
