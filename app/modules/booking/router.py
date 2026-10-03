"""GET /slots, POST /bookings (Idempotency-Key), POST /bookings/{id}/cancel."""

import uuid
from datetime import date, datetime

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth.deps import get_current_user
from app.modules.booking import service
from app.modules.models import User

router = APIRouter(prefix="/api/v1", tags=["booking"])


class BookingIn(BaseModel):
    master_id: uuid.UUID
    filial_id: uuid.UUID
    service_id: uuid.UUID
    start_at: datetime


@router.get("/slots")
async def slots(
    filial_id: uuid.UUID,
    master_id: uuid.UUID,
    service_id: uuid.UUID,
    day: date,
    session: AsyncSession = Depends(get_session),
) -> dict[str, list[str]]:
    return {"slots": await service.day_slots(session, filial_id, master_id, day, service_id)}


@router.post("/bookings", status_code=201)
async def book(
    body: BookingIn,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
    idempotency_key: str = Header(default=""),
) -> dict[str, str]:
    if not idempotency_key:
        raise HTTPException(422, "Idempotency-Key required")
    try:
        b = await service.create_booking(
            session, idempotency_key=idempotency_key, client_id=user.id, **body.model_dump()
        )
    except service.SlotTaken as e:
        raise HTTPException(409, str(e)) from e
    return {"id": str(b.id), "status": b.status}


@router.post("/bookings/{booking_id}/cancel")
async def cancel(
    booking_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    try:
        b = await service.cancel_booking(session, booking_id, user.id)
    except service.SlotTaken as e:
        raise HTTPException(404, str(e)) from e
    return {"id": str(b.id), "status": b.status}
