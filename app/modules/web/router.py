"""SSR-роутер: собирает модули страниц. Точка входа для app.main."""

from fastapi import APIRouter

from app.modules.web import auth_pages, cabinets, dashboards, pages

router = APIRouter(tags=["web"])
router.include_router(pages.router)
router.include_router(auth_pages.router)
router.include_router(cabinets.router)
router.include_router(dashboards.router)
