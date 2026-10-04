"""Chat service: Gemma 4 integration via Google genai SDK with structured output."""

import json
import os
from typing import Literal

import google.generativeai as genai
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.models import ChatMessage, User

SYSTEM_PROMPT = (
    "Ты — ассистент управляющего сети парикмахерских PFP. "
    "Отвечаешь от имени управляющего: вежливо, кратко, по делу. "
    "Помогаешь клиентам с записью, вопросами по услугам, ценами, скидкам. "
    "Не выдумывай информацию — если не знаешь, скажи, что уточнишь у администратора. "
    "Тон: дружелюбный, профессиональный. "
    "Отвечай только на русском языке."
)

GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemma-4-26b-a4b-it")

# Dict-схема для structured output: SDK 0.8 не принимает Pydantic-класс (ValueError),
# только dict. Проверено отдельным скриптом: plain text сыплет thinking-токены,
# JSON с dict-схемой парсится чисто.
REPLY_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {"reply": {"type": "string"}},
    "required": ["reply"],
}


def _configure_genai() -> None:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set in env")
    genai.configure(api_key=api_key)  # type: ignore[attr-defined]


async def get_recent_messages(
    session: AsyncSession, user_id: str, limit: int = 5
) -> list[ChatMessage]:
    """Последние N сообщений диалога (для контекста Gemma)."""
    res = await session.execute(
        select(ChatMessage)
        .where(ChatMessage.user_id == user_id)
        .order_by(ChatMessage.created_at.desc())
        .limit(limit)
    )
    return list(reversed(res.scalars().all()))


FALLBACK_REPLY = "Извините, не смог сформулировать ответ. Уточните, пожалуйста."


def _parse_reply(raw: str) -> str:
    """Парсит structured output Gemma. Чистая функция — unit-тестируется без сети/API."""
    if not raw or not raw.strip():
        return FALLBACK_REPLY
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return FALLBACK_REPLY
    if not isinstance(data, dict):
        return FALLBACK_REPLY
    reply = data.get("reply")
    if not isinstance(reply, str) or not reply.strip():
        return FALLBACK_REPLY
    return reply.strip()


async def save_message(
    session: AsyncSession,
    user_id: str,
    role: Literal["user", "assistant", "manager"],
    content: str,
    manager_id: str | None = None,
) -> ChatMessage:
    msg = ChatMessage(user_id=user_id, manager_id=manager_id, role=role, content=content)
    session.add(msg)
    await session.commit()
    await session.refresh(msg)
    return msg


async def generate_reply(
    session: AsyncSession,
    user: User,
    user_message: str,
) -> str:
    """Генерирует ответ Gemma 4 с контекстом диалога (structured output)."""
    _configure_genai()

    # История для контекста — последние 3 пары
    history = await get_recent_messages(session, str(user.id), limit=3)

    messages = []
    for msg in history:
        role = "model" if msg.role in ("assistant", "manager") else "user"
        messages.append({"role": role, "parts": [msg.content]})
    messages.append({"role": "user", "parts": [user_message]})

    model = genai.GenerativeModel(  # type: ignore[attr-defined]
        GEMINI_MODEL,
        system_instruction=SYSTEM_PROMPT,
        generation_config={  # type: ignore[arg-type]
            "temperature": 0.3,
            "top_p": 0.8,
            "max_output_tokens": 500,
            "response_mime_type": "application/json",
            "response_schema": REPLY_SCHEMA,
        },
    )

    try:
        resp = await model.generate_content_async(messages)
        return _parse_reply(resp.text or "")
    except Exception as e:  # noqa: BLE001 — внешний AI API: любой сбой → вежливый фолбэк юзеру
        return f"⚠️ Сервис ИИ временно недоступен ({type(e).__name__}). Попробуйте позже или напишите администратору напрямую."
