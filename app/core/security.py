from pwdlib import PasswordHash

from app.core.config import settings

_hasher = PasswordHash.recommended()


def hash_password(raw: str) -> str:
    """Argon2id + server-side pepper. Никаких sha256/md5."""
    return _hasher.hash(raw + settings.password_pepper)


def verify_password(raw: str, hashed: str) -> bool:
    return _hasher.verify(raw + settings.password_pepper, hashed)
