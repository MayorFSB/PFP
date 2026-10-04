"""Chat router: WebSocket endpoints for real-time chat."""

import json
import uuid

from fastapi import APIRouter, Depends, Form, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_session
from app.modules.auth.deps import ACCESS_COOKIE, get_current_user
from app.modules.chat import service as chat_svc
from app.modules.models import ChatMessage, Role, User

router = APIRouter(tags=["chat"])
tpl = Jinja2Templates(directory="templates")


class ConnectionManager:
    """Управление WebSocket-соединениями по user_id."""

    def __init__(self) -> None:
        self.active: dict[uuid.UUID, WebSocket] = {}

    async def connect(self, user_id: uuid.UUID, ws: WebSocket) -> None:
        await ws.accept()
        self.active[user_id] = ws

    def disconnect(self, user_id: uuid.UUID) -> None:
        self.active.pop(user_id, None)

    async def send_personal(self, user_id: uuid.UUID, data: dict[str, object]) -> bool:
        ws = self.active.get(user_id)
        if ws:
            await ws.send_json(data)
            return True
        return False


manager = ConnectionManager()


async def _get_user_ws(websocket: WebSocket, session: AsyncSession) -> User | None:
    """Получает пользователя из cookie access_token в WebSocket."""
    try:
        cookie_header = websocket.headers.get("cookie", "")
        access = ""
        for part in cookie_header.split(";"):
            if part.strip().startswith(f"{ACCESS_COOKIE}="):
                access = part.strip().split("=", 1)[1]
                break
        if not access:
            return None
        return await get_current_user(authorization="", pfp_access=access, session=session)
    except ValueError, RuntimeError, KeyError:
        return None


@router.websocket("/ws/chat")
async def ws_chat(websocket: WebSocket, session: AsyncSession = Depends(get_session)) -> None:
    user = await _get_user_ws(websocket, session)
    if user is None:
        await websocket.close(code=4001)
        return

    await manager.connect(user.id, websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")
            if msg_type == "message":
                content = (data.get("content") or "").strip()
                if not content:
                    continue

                # Сохраняем сообщение пользователя
                await chat_svc.save_message(session, str(user.id), "user", content)

                # Генерируем ответ Gemma
                reply = await chat_svc.generate_reply(session, user, content)

                # Сохраняем ответ ассистента
                await chat_svc.save_message(session, str(user.id), "assistant", reply)

                # Отправляем клиенту
                await websocket.send_json(
                    {"type": "message", "role": "assistant", "content": reply}
                )
    except WebSocketDisconnect:
        manager.disconnect(user.id)


@router.get("/chat/history", response_class=HTMLResponse)
async def chat_history(
    request: Request,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> HTMLResponse:
    """История чата для отрисовки в UI (HTMX)."""
    msgs = await chat_svc.get_recent_messages(session, str(user.id), limit=50)
    return tpl.TemplateResponse(
        request,
        "_chat_history.html",
        {"request": request, "messages": msgs, "user": user},
    )


@router.post("/chat/send")
async def chat_send(
    request: Request,
    content: str = Form(),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> dict[str, object]:
    """HTTP fallback для отправки сообщения (если WS недоступен)."""
    content = content.strip()
    if not content:
        return {"ok": False}
    await chat_svc.save_message(session, str(user.id), "user", content)
    reply = await chat_svc.generate_reply(session, user, content)
    await chat_svc.save_message(session, str(user.id), "assistant", reply)
    return {"ok": True, "reply": reply}


@router.get("/api/v1/chat/conversations")
async def chat_conversations(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, str]]:
    """Список диалогов для управляющего: последние сообщения по каждому клиенту."""
    if user.role not in (Role.moderator, Role.admin):
        return []
    # Последнее сообщение каждого клиента
    subq = (
        select(ChatMessage.user_id, func.max(ChatMessage.created_at).label("last_at"))
        .group_by(ChatMessage.user_id)
        .subquery()
    )
    q = (
        select(User, ChatMessage)
        .join(
            subq,
            (ChatMessage.user_id == subq.c.user_id) & (ChatMessage.created_at == subq.c.last_at),
        )
        .join(User, User.id == ChatMessage.user_id)
        .order_by(ChatMessage.created_at.desc())
        .limit(50)
    )
    rows = (await session.execute(q)).all()
    return [
        {
            "user_id": str(u.id),
            "client_name": u.email,
            "last_msg": m.content[:80],
            "last_time": m.created_at.strftime("%d.%m %H:%M"),
        }
        for u, m in rows
    ]


@router.get("/api/v1/chat/history/{user_id}")
async def chat_history_user(
    user_id: uuid.UUID,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> list[dict[str, str]]:
    """История сообщений конкретного клиента (для управляющего)."""
    if user.role not in (Role.moderator, Role.admin):
        return []
    msgs = await chat_svc.get_recent_messages(session, str(user_id), limit=100)
    return [
        {
            "role": m.role,
            "content": m.content,
            "created_at": m.created_at.strftime("%d.%m %H:%M"),
        }
        for m in msgs
    ]
