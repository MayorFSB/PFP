"""Защита: security headers + rate-limit логина через Valkey."""

import secrets

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware

from app.core import cache

CSP = (
    "default-src 'self'; "
    "script-src 'self' https://unpkg.com 'nonce-{nonce}'; "
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "font-src 'self' https://fonts.gstatic.com; "
    "img-src 'self' data:; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; "
    "base-uri 'self'; "
    "form-action 'self'"
)

HEADERS = {
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
}

LOGIN_LIMIT = 10
LOGIN_WINDOW = 60


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """CSP с nonce на каждый запрос + базовые заголовки. nonce попадает в request.state."""

    async def dispatch(self, request: Request, call_next):  # type: ignore[no-untyped-def]
        nonce = secrets.token_urlsafe(16)
        request.state.csp_nonce = nonce
        resp = await call_next(request)
        resp.headers.setdefault("Content-Security-Policy", CSP.format(nonce=nonce))
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
