"""Демо-сид сети. Детерминированный (Faker seed=42), идемпотентный.

Услуги — фиксированный прайс из seed_demo.md (середины диапазонов).
Мастера/клиенты/визиты — faker ru_RU.

Запуск: uv run python -m app.modules.seed [--clients N] [--visits N]
"""

import argparse
import asyncio
import hashlib
import random
from datetime import UTC, datetime, timedelta

from faker import Faker
from sqlalchemy import func, select

from app.core.db import SessionLocal
from app.core.security import hash_password
from app.modules.models import Booking, Filial, MasterProfile, Role, ScheduleRule, Service, User

fake = Faker("ru_RU")
Faker.seed(42)

# (название, длительность мин, цена копейки) — середины из seed_demo.md
SERVICES: list[tuple[str, int, int]] = [
    ("Стрижка вспышка", 15, 60000),
    ("Стрижка мужская классическая", 45, 150000),
    ("Стрижка под машинку", 25, 80000),
    ("Моделирование бороды", 35, 105000),
    ("Камуфляж седины", 25, 125000),
    ("Мужская укладка", 20, 60000),
    ("Стрижка женская", 60, 230000),
    ("Стрижка челки", 15, 50000),
    ("Окрашивание в один тон (короткие)", 105, 350000),
    ("Окрашивание в один тон (длинные)", 135, 550000),
    ("Сложное окрашивание", 210, 950000),
    ("Тонирование волос", 75, 325000),
    ("Мелирование классическое", 150, 525000),
    ("Укладка повседневная", 35, 150000),
    ("Укладка вечерняя", 75, 350000),
    ("Свадебная прическа", 150, 650000),
    ("Стрижка для мальчиков", 35, 95000),
    ("Стрижка для девочек", 45, 120000),
    ("Детская прическа", 45, 150000),
    ("Экспресс-маска для волос", 20, 80000),
    ("Пилинг кожи головы", 35, 185000),
    ("Ботокс для волос", 135, 550000),
    ("Кератиновое выпрямление", 165, 700000),
    ("Абсолютное счастье для волос", 75, 450000),
    ("Коррекция бровей", 25, 75000),
    ("Окрашивание бровей", 20, 65000),
    ("Парафинотерапия рук", 25, 60000),
    ("Каравелло", 25, 260000),
]

FILIALS = [
    ("Центр", "ул. Мира, 1"),
    ("Север", "Ленинградский пр., 45"),
    ("Парикмахерская имени Рикардо Милоса", "ул. Гарибальди, 12"),
]
# Переименования при апдейте сида на живой БД (старое → новое).
FILIAL_RENAMES = {"Юг": "Парикмахерская имени Рикардо Милоса"}

SPECS = ["барбер", "колорист", "стилист", "универсал", "детский мастер"]
DEMO_PW = "demo1234"


async def ensure_filials() -> list[Filial]:
    async with SessionLocal() as s:
        out = []
        for name, address in FILIALS:
            f = await s.scalar(select(Filial).where(Filial.name == name))
            if f is None:
                legacy = next((old for old, new in FILIAL_RENAMES.items() if new == name), None)
                if legacy:
                    f = await s.scalar(select(Filial).where(Filial.name == legacy))
                    if f is not None:
                        f.name = name
                        await s.commit()
                        await s.refresh(f)
            if f is None:
                f = Filial(name=name, address=address)
                s.add(f)
                await s.commit()
                await s.refresh(f)
            out.append(f)
        return out


async def ensure_services(filials: list[Filial]) -> list[Service]:
    async with SessionLocal() as s:
        out = []
        for f in filials:
            for i, (name, dur, price) in enumerate(SERVICES):
                # эксклюзив: не все услуги во всех филиалах (~70% кроме центра); md5 — детерминирован
                digest = hashlib.md5(f"{f.name}:{name}".encode()).digest()[0]
                if f.name != "Центр" and digest % 10 > 6:
                    continue
                svc = await s.scalar(
                    select(Service).where(Service.filial_id == f.id, Service.name == name)
                )
                if svc is None:
                    svc = Service(filial_id=f.id, name=name, price_kopeks=price, duration_min=dur)
                    s.add(svc)
                    await s.commit()
                    await s.refresh(svc)
                out.append(svc)
        return out


async def ensure_masters(filials: list[Filial], n: int = 12) -> list[User]:
    async with SessionLocal() as s:
        out = []
        for i in range(n):
            email = f"master{i:02d}@demo.local"
            u = await s.scalar(select(User).where(User.email == email))
            if u is None:
                u = User(email=email, password_hash=hash_password(DEMO_PW), role=Role.master)
                s.add(u)
                await s.commit()
                await s.refresh(u)
                f = filials[i % len(filials)]
                name = (
                    f"{fake.first_name_male()} {fake.last_name_male()}"
                    if i % 3
                    else f"{fake.first_name_female()} {fake.last_name_female()}"
                )
                s.add(
                    MasterProfile(
                        user_id=u.id, display_name=name, specialization=random.choice(SPECS)
                    )
                )
                for wd in range(5):
                    s.add(
                        ScheduleRule(
                            master_id=u.id, filial_id=f.id, weekday=wd, start_min=540, end_min=1200
                        )
                    )
                s.add(
                    ScheduleRule(
                        master_id=u.id, filial_id=f.id, weekday=5, start_min=600, end_min=1080
                    )
                )
                await s.commit()
            out.append(u)
        return out


async def ensure_clients(n: int = 200) -> int:
    """Массовые клиенты — bulk insert батчами с DO NOTHING (гэпы в нумерации не страшны)."""
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    async with SessionLocal() as s:
        for start in range(0, n, 500):
            stmt = (
                pg_insert(User)
                .values(
                    [
                        {
                            "email": f"client{(start + j):05d}@demo.local",
                            "password_hash": "!",
                            "role": Role.client,
                        }
                        for j in range(min(500, n - start))
                    ]
                )
                .on_conflict_do_nothing(index_elements=["email"])
            )
            await s.execute(stmt)
            await s.commit()
        return (
            await s.scalar(select(func.count()).select_from(User).where(User.role == Role.client))
            or 0
        )


async def ensure_demo_accounts() -> None:
    async with SessionLocal() as s:
        for email, role in [
            ("client@demo.local", Role.client),
            ("moderator@demo.local", Role.moderator),
            ("admin@demo.local", Role.admin),
        ]:
            u = await s.scalar(select(User).where(User.email == email))
            if u is None:
                s.add(User(email=email, password_hash=hash_password(DEMO_PW), role=role))
                await s.commit()


async def ensure_visits(services: list[Service], masters: list[User], n: int = 300) -> int:
    """Прошлые визиты для будущих BI-дашбордов. Фикс-слоты 10:00/14:00 пн–сб — без пересечений."""
    async with SessionLocal() as s:
        have = await s.scalar(select(func.count()).select_from(Booking)) or 0
        if have > 0:
            return have
        if not services or not masters:
            return 0
        clients = (
            (await s.execute(select(User.id).where(User.role == Role.client).limit(n)))
            .scalars()
            .all()
        )
        if not clients:
            return 0
        today = datetime.now(UTC).date()
        rows: list[Booking] = []
        mi = 0
        day_back = 1
        while len(rows) < n and day_back < 365:
            day = today - timedelta(days=day_back)
            day_back += 1
            if day.weekday() == 6:
                continue
            for hour in (10, 14):
                if len(rows) >= n:
                    break
                svc = services[(len(rows) + day_back) % len(services)]
                master = masters[mi % len(masters)]
                mi += 1
                start = datetime(day.year, day.month, day.day, hour, tzinfo=UTC)
                rows.append(
                    Booking(
                        filial_id=svc.filial_id,
                        master_id=master.id,
                        client_id=clients[len(rows) % len(clients)],
                        service_id=svc.id,
                        start_at=start,
                        end_at=start + timedelta(minutes=svc.duration_min),
                        status="done",
                        idempotency_key=f"seed-{(len(rows)):05d}",
                    )
                )
        s.add_all(rows)
        await s.commit()
        return len(rows)


async def main(clients: int = 200, visits: int = 300) -> None:
    filials = await ensure_filials()
    services = await ensure_services(filials)
    masters = await ensure_masters(filials)
    total_clients = await ensure_clients(clients)
    await ensure_demo_accounts()
    total_visits = await ensure_visits(services, masters, visits)
    print(
        f"filials={len(filials)} services={len(services)} masters={len(masters)} clients={total_clients} visits={total_visits}"
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--clients", type=int, default=200)
    ap.add_argument("--visits", type=int, default=300)
    a = ap.parse_args()
    asyncio.run(main(a.clients, a.visits))
