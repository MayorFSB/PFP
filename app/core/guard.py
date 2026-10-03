"""Защита: security headers + rate-limit логина через Valkey."""

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from app.core import cache

HEADERS = {
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://unpkg.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
}

LOGIN_LIMIT = 10
LOGIN_WINDOW = 60


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):  # type: ignore[no-untyped-def]
        resp = await call_next(request)
        for k, v in HEADERS.items():
            resp.headers.setdefault(k, v)
        return resp


async def login_allowed(ip: str, email: str = "") -> bool:
    """Фиксированное окно 10/мин с IP+email. Valkey недоступен — fail open (не ложим вход)."""
    try:
        r = cache.get_client()
        key = f"pfp:rl:login:{ip}:{email}"
        n = await r.incr(key)
        if n == 1:
            await r.expire(key, LOGIN_WINDOW)
        return n <= LOGIN_LIMIT
    except Exception:  # noqa: BLE001 — fail open: без Valkey не блокируем вход
        return True
