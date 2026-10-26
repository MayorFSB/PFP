"""0008: композитные индексы под горячие запросы (кабинет клиента, мастер, чат).

Single-column индексы на FK уже были; composite дают index scan вместо
bitmap heap scan на типовых выборках при росте числа записей.

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-26
"""

import sqlalchemy as sa
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None

INDEXES = [
    # кабинет клиента: последние записи клиента (ORDER BY start_at DESC LIMIT 20)
    ("ix_bookings_client_start", "bookings", ["client_id", sa.text("start_at DESC")]),
    # кабинет мастера: неделя/месяц по диапазону start_at
    ("ix_bookings_master_start", "bookings", ["master_id", "start_at"]),
    # фильтр дашбордов по статусам (done/paid) с фильтром филиала
    ("ix_bookings_status_start", "bookings", ["status", "start_at"]),
    # чат: последние N сообщений диалога
    ("ix_chat_messages_user_created", "chat_messages", ["user_id", sa.text("created_at DESC")]),
]


def upgrade() -> None:
    for name, table, cols in INDEXES:
        op.create_index(name, table, cols, if_not_exists=True)


def downgrade() -> None:
    for name, _table, _cols in reversed(INDEXES):
        op.drop_index(name, if_exists=True)
