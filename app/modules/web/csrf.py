"""CSRF double-submit: токен в cookie + то же значение в скрытом поле формы."""

import secrets

from fastapi import HTTPException, Request

CSRF_COOKIE = "pfp_csrf"


def new_token() -> str:
    return secrets.token_urlsafe(32)


def check(request: Request, form_token: str) -> None:
    cookie = request.cookies.get(CSRF_COOKIE, "")
    if not cookie or not form_token or cookie != form_token:
        raise HTTPException(403, "bad csrf")
