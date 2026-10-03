"""Платежи через Strategy: интерфейс + FakeProvider. Боевой провайдер встанет сюда же."""

import uuid
from typing import Protocol


class Provider(Protocol):
    name: str

    async def checkout(self, booking_id: uuid.UUID, amount_kopeks: int) -> str: ...
    async def verify_webhook(self, payload: dict[str, str]) -> uuid.UUID | None: ...


class FakeProvider:
    """Заглушка: checkout возвращает fake-URL, webhook подтверждает по префиксу сигнатуры."""

    name = "fake"

    async def checkout(self, booking_id: uuid.UUID, amount_kopeks: int) -> str:
        return f"https://pay.example/checkout/{booking_id}?amount={amount_kopeks}"

    async def verify_webhook(self, payload: dict[str, str]) -> uuid.UUID | None:
        if not payload.get("signature", "").startswith("fake-sig-"):
            return None
        try:
            return uuid.UUID(payload["booking_id"])
        except KeyError, ValueError:
            return None


def get_provider() -> Provider:
    return FakeProvider()
