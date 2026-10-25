"""Общее для SSR-страниц: шаблонизатор, контекст, демо-данные."""

from fastapi import HTTPException, Request
from fastapi.templating import Jinja2Templates
from sqlalchemy.ext.asyncio import AsyncSession

from app.modules.auth.deps import ACCESS_COOKIE, get_current_user
from app.modules.models import User

tpl = Jinja2Templates(directory="templates")

DEMO_PW = "demo1234"
DEMO_ACCOUNTS = {
    "client": ("client@demo.local", "/cabinet"),
    "master": ("master00@demo.local", "/master"),
    "moderator": ("moderator@demo.local", "/manager"),
    "admin": ("admin@demo.local", "/admin"),
}

# Отзывы вынесены с главной на отдельную страницу /reviews: на главной они
# были стадией сцены и съедали высоты скролла. Хранятся здесь, чтобы страница
# отзывов и любые будущие виджеты читали один источник.
DEMO_REVIEWS = [
    {
        "name": "Артём",
        "text": "Пришёл за 15 минут до закрытия — всё равно записали. Стрижка вспышка — топ!",
    },
    {
        "name": "Мария",
        "text": "Понравилось, что цена сразу на месте, без доплат. Мастер объяснил, что подойдёт именно мне.",
    },
    {
        "name": "Дмитрий",
        "text": "Результат — на фото. Скидка ко дню рождения сработала автоматически, приятно.",
    },
    {
        "name": "Ольга",
        "text": "Ходила три месяца подряд: локон каждый раз одинаково аккуратный, без сюрпризов.",
    },
    {
        "name": "Кирилл",
        "text": "Записался в ТЦ, доехал за 10 минут. Удобно, что видно свободные слоты сразу.",
    },
    {
        "name": "Анна",
        "text": "Получила то, о чём договаривались: обсудили уход, показали, что будет с укладкой.",
    },
]


def _ctx(request: Request, **kw: object) -> dict[str, object]:
    return {"request": request, "nonce": getattr(request.state, "csp_nonce", ""), **kw}


async def _optional_user(request: Request, session: AsyncSession) -> User | None:
    try:
        return await get_current_user(
            authorization="", pfp_access=request.cookies.get(ACCESS_COOKIE, ""), session=session
        )
    except HTTPException:
        return None
