"""0004 master_profiles (публичный профиль мастера)."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "master_profiles",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("display_name", sa.String(255), nullable=False),
        sa.Column("specialization", sa.String(255), nullable=False, server_default=""),
        sa.Column("bio", sa.String(1024), nullable=False, server_default=""),
    )
    op.create_index("ix_master_profiles_user_id", "master_profiles", ["user_id"], unique=True)


def downgrade() -> None:
    op.drop_table("master_profiles")
