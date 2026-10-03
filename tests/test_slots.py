from datetime import UTC, date, datetime

from app.modules.booking.service import build_slots


def test_slots_from_rule() -> None:
    day = date(2026, 10, 5)  # понедельник
    out = build_slots([(9 * 60, 11 * 60)], [], day, 60)
    assert out == [
        datetime(2026, 10, 5, 9, tzinfo=UTC).isoformat(),
        datetime(2026, 10, 5, 10, tzinfo=UTC).isoformat(),
    ]


def test_slots_minus_busy() -> None:
    day = date(2026, 10, 5)
    busy = [
        (
            datetime(2026, 10, 5, 9, tzinfo=UTC),
            datetime(2026, 10, 5, 10, tzinfo=UTC),
        )
    ]
    out = build_slots([(9 * 60, 11 * 60)], busy, day, 60)
    assert len(out) == 1 and "10:00" in out[0]


def test_partial_overlap_kills_slot() -> None:
    day = date(2026, 10, 5)
    busy = [
        (
            datetime(2026, 10, 5, 9, 30, tzinfo=UTC),
            datetime(2026, 10, 5, 10, 30, tzinfo=UTC),
        )
    ]
    out = build_slots([(9 * 60, 12 * 60)], busy, day, 60)
    assert out == [datetime(2026, 10, 5, 11, tzinfo=UTC).isoformat()]


def test_rule_shorter_than_service() -> None:
    assert build_slots([(9 * 60, 9 * 60 + 30)], [], date(2026, 10, 5), 60) == []
