from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.modules.auth.router import router as auth_router
from app.modules.booking.router import router as booking_router
from app.modules.web.router import router as web_router


def create_app() -> FastAPI:
    app = FastAPI(title="PFP", version="0.1.0")
    app.mount("/static", StaticFiles(directory="static"), name="static")
    app.include_router(auth_router)
    app.include_router(booking_router)
    app.include_router(web_router)

    @app.get("/health")
    async def health() -> JSONResponse:
        return JSONResponse({"status": "ok"})

    @app.get("/live")
    async def live() -> JSONResponse:
        return JSONResponse({"alive": True})

    @app.get("/ready")
    async def ready() -> JSONResponse:
        # День 2+: проверка postgres + valkey. Пока заглушка.
        return JSONResponse({"ready": True})

    @app.get("/api/v1/ping")
    async def ping() -> JSONResponse:
        return JSONResponse({"pong": True})

    return app


app = create_app()
