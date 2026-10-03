# AGENTS.md — правила для AI-агентов (экономия токенов + культура)

## Команды
- Установка: `uv sync` (Python 3.14, НЕ pip install вслепую).
- Линт: `ruff check . && ruff format --check .`
- Типы: `mypy app`
- Тесты: `pytest -q` (новые фичи = новый тест в `tests/`).
- Локальный запуск: `docker compose up -d postgres valkey` затем `uvicorn app.main:app --reload`.

## Культура кода (обязательно)
1. Async SQLAlchemy 2.0 стиль, никаких sync вызовов в async path.
2. Пароли ТОЛЬКО Argon2id via `pwdlib`, pepper из env. Никаких sha256/md5.
3. Бронь: `Idempotency-Key` header + exclusion constraint в Postgres, инвалидация Valkey по событию.
4. API: версионирование `/api/v1`, cursor-pagination, OpenAPI из FastAPI.
5. Фронт SSR: Jinja autoescape ON, CSP nonce, CSRF token для форм, SameSite=Lax cookies.
6. Кэш Valkey: key=`pfp:v1:{filial}:{date}`, value=zstd/gzip JSON, TTL 60-300с. Не кэшировать персоналку без TTL.
7. Логи: structlog JSON -> Loki. Метрики: Prometheus counters `bookings_total{filial}`, `http_latency`, `cache_hit_ratio`.
8. Коммиты: conventional commits `feat(auth): ...`, `fix(booking): ...`. Без секретов в git.
9. Не добавлять новые MCP/зависимости без спроса. Docs искать через `context7` инструмент.

## Что НЕ делать
- Не шардировать/партиционировать БД раньше времени (у нас 100-1000 DAU на ноуте).
- Не класть большие бинарники/картинки в репо — только S3-совместимое хранилище.
- Не гадать про FastAPI/SQLAlchemy API — проверить через context7 или локальный venv.
