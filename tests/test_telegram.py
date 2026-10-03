import hashlib
import hmac
import time

import pytest

from app.core.config import settings
from app.modules.auth.service import verify_telegram

TOKEN = "test-bot-token-123"


@pytest.fixture(autouse=True)
def _token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "telegram_bot_token", TOKEN)


def _signed(payload: dict[str, str]) -> dict[str, str]:
    check = "\n".join(f"{k}={payload[k]}" for k in sorted(payload))
    key = hashlib.sha256(TOKEN.encode()).digest()
    out = dict(payload)
    out["hash"] = hmac.new(key, check.encode(), hashlib.sha256).hexdigest()
    return out


def test_telegram_ok() -> None:
    data = {"id": "123", "first_name": "A", "auth_date": str(int(time.time()))}
    assert verify_telegram(_signed(data)) is True


def test_telegram_tampered() -> None:
    data = _signed({"id": "123", "first_name": "A", "auth_date": "1"})
    data["first_name"] = "B"
    assert verify_telegram(data) is False


def test_telegram_no_hash() -> None:
    assert verify_telegram({"id": "123"}) is False
