from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

# pool_pre_ping: мёртвые соединения после сна/сетевых сбоев отбраковываются
# до запроса. pool_recycle: Livy/файрволы рвут долгие коннекты — пересоздаём
# до разрыва. Размеры дефолтные: 100-1000 DAU на одном инстансе хватает.
engine = create_async_engine(settings.database_url, pool_pre_ping=True, pool_recycle=1800)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_session():  # type: ignore[no-untyped-def]
    async with SessionLocal() as s:
        yield s
