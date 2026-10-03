import uuid

import pytest

from app.core import jwt as tokens


def test_pair_roundtrip() -> None:
    uid = uuid.uuid4()
    access, refresh, jti = tokens.create_pair(uid, "client")
    pa = tokens.decode(access, "access")
    pr = tokens.decode(refresh, "refresh")
    assert pa["sub"] == str(uid) and pa["role"] == "client"
    assert pr["jti"] == jti and pr["sub"] == str(uid)


def test_wrong_type_rejected() -> None:
    access, _, _ = tokens.create_pair(uuid.uuid4(), "client")
    with pytest.raises(ValueError):
        tokens.decode(access, "refresh")


def test_tampered_rejected() -> None:
    access, _, _ = tokens.create_pair(uuid.uuid4(), "client")
    with pytest.raises(ValueError):
        tokens.decode(access + "x", "access")
