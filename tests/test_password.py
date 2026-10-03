def test_password_argon2id() -> None:
    from app.core.security import hash_password, verify_password

    h = hash_password("secret123")
    assert h.startswith("$argon2id$")
    assert verify_password("secret123", h)
    assert not verify_password("wrong", h)
