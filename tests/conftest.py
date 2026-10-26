"""Общие гарды тестового окружения.

Защита от повторения истории: тесты, запущенные без PFP_DATABASE_URL, тихо
ходят в dev-БД pfp и оставляют там мусор (тестовые филиалы, брони). Запрещаем.
"""

import pytest

from app.core.config import settings


def pytest_configure(config: pytest.Config) -> None:
    if "pfp_test" not in settings.database_url:
        pytest.exit(
            "Тесты запрещены вне pfp_test: задай PFP_DATABASE_URL="
            "postgresql+asyncpg://pfp:pfp@localhost:5433/pfp_test",
            returncode=3,
        )
