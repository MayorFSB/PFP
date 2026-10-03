"""Prometheus: http latency/counts, bookings_total{filial}, cache hit/miss."""

import time
import uuid

import structlog
from fastapi import Request
from fastapi.responses import Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest
from starlette.middleware.base import BaseHTTPMiddleware

http_total = Counter("http_requests_total", "requests", ["method", "status"])
http_latency = Histogram("http_latency_seconds", "latency", ["path"])
bookings_total = Counter("bookings_total", "created bookings", ["filial"])
cache_hits = Counter("cache_hits_total", "valkey hits", ["key_prefix"])
cache_miss = Counter("cache_miss_total", "valkey misses", ["key_prefix"])

log = structlog.get_logger()

structlog.configure(
    processors=[
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.JSONRenderer(ensure_ascii=False),
    ],
    logger_factory=structlog.PrintLoggerFactory(),
)


class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):  # type: ignore[no-untyped-def]
        rid = request.headers.get("X-Request-ID", uuid.uuid4().hex[:8])
        t0 = time.perf_counter()
        resp = await call_next(request)
        dt = time.perf_counter() - t0
        route = request.scope.get("route")
        path = getattr(route, "path", request.url.path) if route else request.url.path
        http_total.labels(request.method, resp.status_code).inc()
        http_latency.labels(path).observe(dt)
        log.info(
            "request",
            rid=rid,
            method=request.method,
            path=path,
            status=resp.status_code,
            ms=round(dt * 1000, 1),
        )
        resp.headers["X-Request-ID"] = rid
        return resp


async def metrics_endpoint() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
