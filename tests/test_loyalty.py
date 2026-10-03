"""Тесты лояльности и скидки ко дню рождения."""

from datetime import date

from app.modules.loyalty import birthday_discount, loyalty_level
from app.modules.models import User


def test_birthday_discount_active() -> None:
    u = User(email="a@b.c", password_hash="!", birth_date=date(1990, 10, 3))
    assert birthday_discount(u, today=date(2026, 10, 3)) == 0.15
    assert birthday_discount(u, today=date(2026, 10, 10)) == 0.15
    assert birthday_discount(u, today=date(2026, 10, 11)) == 0.0


def test_birthday_discount_no_birth_date() -> None:
    u = User(email="a@b.c", password_hash="!")
    assert birthday_discount(u) == 0.0


def test_loyalty_levels() -> None:
    assert loyalty_level(0) == ("Базовый", 0.0)
    assert loyalty_level(4) == ("Базовый", 0.0)
    assert loyalty_level(5) == ("Серебро", 0.05)
    assert loyalty_level(14) == ("Серебро", 0.05)
    assert loyalty_level(15) == ("Золото", 0.10)
    assert loyalty_level(100) == ("Золото", 0.10)
