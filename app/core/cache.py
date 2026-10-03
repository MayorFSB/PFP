"""Valkey: get/set JSON с gzip (только >1KB), TTL 60-300с."""

import gzip
import json
from typing import Any

import redis.asyncio as redis

from app.core.config import settings

_client: redis.Redis | None = None


def get_client() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.from_url(settings.valkey_url, decode_responses=False)
    return _client


def pack(value: Any) -> bytes:
    raw = json.dumps(value, ensure_ascii=False).encode()
    return gzip.compress(raw) if len(raw) > 1024 else raw


def unpack(blob: bytes) -> Any:
    try:
        return json.loads(gzip.decompress(blob))
    except OSError:
        return json.loads(blob)


async def cached(key: str, ttl: int, loader: Any) -> Any:
    from app.core.metrics import cache_hits, cache_miss

    prefix = key.split(":")[1] if ":" in key else "misc"
    r = get_client()
    hit = await r.get(key)
    if hit is not None:
        cache_hits.labels(prefix).inc()
        assert isinstance(hit, bytes)
        return unpack(hit)
    cache_miss.labels(prefix).inc()
    value = await loader()
    await r.setex(key, ttl, pack(value))
    return value


async def invalidate(*keys: str) -> None:
    if keys:
        await get_client().delete(*keys)


def slots_key(filial_id: str, day: str) -> str:
    return f"pfp:v1:{filial_id}:{day}"
