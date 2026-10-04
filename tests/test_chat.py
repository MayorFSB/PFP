"""Чат: парсинг structured output (без сети) + roundtrip сообщений в БД."""

import uuid

from app.core.db import SessionLocal
from app.modules.chat import service as chat
from app.modules.models import Role, User


def test_parse_reply_valid_json() -> None:
    raw = '{"reply": "Здравствуйте! Запишитесь через сайт."}'
    assert chat._parse_reply(raw) == "Здравствуйте! Запишитесь через сайт."


def test_parse_reply_truncated_json_fallback() -> None:
    # Обрезанный JSON (max_output_tokens) — вежливый фолбэк, не thinking-мусор
    raw = '{"reply": "Здравствуйте! Вы можете записаться по телефо'
    assert chat._parse_reply(raw) == chat.FALLBACK_REPLY


def test_parse_reply_garbage_fallback() -> None:
    assert chat._parse_reply("") == chat.FALLBACK_REPLY
    assert chat._parse_reply("   ") == chat.FALLBACK_REPLY
    assert chat._parse_reply("not json at all") == chat.FALLBACK_REPLY
    assert chat._parse_reply("[1, 2, 3]") == chat.FALLBACK_REPLY
    assert chat._parse_reply('{"nope": 1}') == chat.FALLBACK_REPLY
    assert chat._parse_reply('{"reply": "   "}') == chat.FALLBACK_REPLY
    assert chat._parse_reply('{"reply": 123}') == chat.FALLBACK_REPLY


def test_parse_reply_strips_whitespace() -> None:
    assert chat._parse_reply('{"reply": "  Привет!  "}') == "Привет!"


async def test_chat_roundtrip() -> None:
    email = f"chat_{uuid.uuid4().hex[:8]}@example.com"
    async with SessionLocal() as s:
        u = User(email=email, password_hash="!", role=Role.client)
        s.add(u)
        await s.commit()
        await s.refresh(u)
        await chat.save_message(s, str(u.id), "user", "Привет!")
        await chat.save_message(s, str(u.id), "assistant", "Здравствуйте!")
        hist = await chat.get_recent_messages(s, str(u.id), limit=5)
    assert [m.role for m in hist] == ["user", "assistant"]
    assert hist[0].content == "Привет!"
