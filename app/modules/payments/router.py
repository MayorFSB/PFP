"""POST /payments/checkout, POST /payments/webhook (идемпотентный: повтор = ok)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth.deps import get_current_user
from app.modules.models import Booking, Service, User
from app.modules.payments.provider import get_provider

router = APIRouter(prefix="/api/v1/payments", tags=["payments"])


class CheckoutIn(BaseModel):
    booking_id: uuid.UUID


@router.post("/checkout")
async def checkout(
    body: CheckoutIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    booking = await session.get(Booking, body.booking_id)
    if booking is None or booking.client_id != user.id:
        raise HTTPException(404, "no booking")
    svc = await session.get(Service, booking.service_id)
    if svc is None:
        raise HTTPException(404, "no service")
    url = await get_provider().checkout(booking.id, svc.price_kopeks)
    return {"pay_url": url, "amount_kopeks": str(svc.price_kopeks)}


@router.post("/webhook")
async def webhook(
    payload: dict[str, str], session: AsyncSession = Depends(get_session)
) -> dict[str, bool]:
    booking_id = await get_provider().verify_webhook(payload)
    if booking_id is None:
        raise HTTPException(400, "bad signature")
    booking = await session.get(Booking, booking_id)
    if booking is None:
        raise HTTPException(404, "no booking")
    booking.status = "paid"
    await session.commit()
    return {"ok": True}
