"""0003 services + schedule_rules + booking end_at/status + exclusion от двойной брони."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "services",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "filial_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("filials.id"), nullable=False
        ),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("price_kopeks", sa.Integer(), nullable=False),
        sa.Column("duration_min", sa.Integer(), nullable=False),
    )
    op.create_index("ix_services_filial_id", "services", ["filial_id"])

    op.create_table(
        "schedule_rules",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "master_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column(
            "filial_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("filials.id"), nullable=False
        ),
        sa.Column("weekday", sa.Integer(), nullable=False),
        sa.Column("start_min", sa.Integer(), nullable=False),
        sa.Column("end_min", sa.Integer(), nullable=False),
    )
    op.create_index("ix_schedule_rules_master_id", "schedule_rules", ["master_id"])
    op.create_index("ix_schedule_rules_filial_id", "schedule_rules", ["filial_id"])

    op.add_column("bookings", sa.Column("end_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "bookings",
        sa.Column(
            "service_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("services.id"), nullable=True
        ),
    )
    op.add_column(
        "bookings", sa.Column("status", sa.String(16), nullable=False, server_default="pending")
    )

    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")
    op.execute(
        "ALTER TABLE bookings ADD CONSTRAINT no_double_book "
        "EXCLUDE USING gist (master_id WITH =, tstzrange(start_at, end_at) WITH &&)"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE bookings DROP CONSTRAINT IF EXISTS no_double_book")
    op.drop_column("bookings", "status")
    op.drop_column("bookings", "service_id")
    op.drop_column("bookings", "end_at")
    op.drop_table("schedule_rules")
    op.drop_table("services")
