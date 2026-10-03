"""JWT: access 15мин + refresh с ротацией (reuse detection через auth_sessions)."""

import secrets
import uuid
from datetime import UTC, datetime, timedelta

from jose import JWTError, jwt

from app.core.config import settings

ALGO = "HS256"


def _now() -> datetime:
    return datetime.now(UTC)


def create_pair(user_id: uuid.UUID, role: str) -> tuple[str, str, str]:
    jti = secrets.token_urlsafe(32)
    access = jwt.encode(
        {
            "sub": str(user_id),
            "role": role,
            "type": "access",
            "exp": _now() + timedelta(minutes=settings.access_ttl_min),
        },
        settings.jwt_secret,
        algorithm=ALGO,
    )
    refresh = jwt.encode(
        {
            "sub": str(user_id),
            "jti": jti,
            "type": "refresh",
            "exp": _now() + timedelta(days=settings.refresh_ttl_days),
        },
        settings.jwt_secret,
        algorithm=ALGO,
    )
    return access, refresh, jti


def decode(token: str, expected_type: str) -> dict[str, str]:
    try:
        payload: dict[str, str] = jwt.decode(token, settings.jwt_secret, algorithms=[ALGO])
    except JWTError as e:
        raise ValueError("bad token") from e
    if payload.get("type") != expected_type:
        raise ValueError("wrong token type")
    return payload
