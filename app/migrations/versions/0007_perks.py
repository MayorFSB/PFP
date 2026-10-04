"""perks: promocodes, family subscriptions, booking discount, master rating.

Revision ID: 0007
Revises: ccabbe203501
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "0007"
down_revision = "ccabbe203501"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "promocodes",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("code", sa.String(32), nullable=False),
        sa.Column("discount_pct", sa.Integer(), nullable=False),
        sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("valid_to", sa.DateTime(timezone=True), nullable=True),
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column("used_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("filial_id", UUID(as_uuid=True), sa.ForeignKey("filials.id"), nullable=True),
        sa.Column("service_id", UUID(as_uuid=True), sa.ForeignKey("services.id"), nullable=True),
        sa.Column("master_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.create_index("ix_promocodes_code", "promocodes", ["code"], unique=True)
    op.create_table(
        "family_subscriptions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("owner_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("plan", sa.String(64), nullable=False, server_default="Семейная"),
        sa.Column("discount_pct", sa.Integer(), nullable=False, server_default="10"),
        sa.Column("valid_to", sa.DateTime(timezone=True), nullable=True),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.create_index("ix_family_subscriptions_owner", "family_subscriptions", ["owner_id"])
    op.create_table(
        "subscription_members",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "subscription_id",
            UUID(as_uuid=True),
            sa.ForeignKey("family_subscriptions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.UniqueConstraint("subscription_id", "user_id"),
    )
    op.create_index("ix_subscription_members_user", "subscription_members", ["user_id"])
    op.add_column("bookings", sa.Column("promo_id", UUID(as_uuid=True), nullable=True))
    op.create_foreign_key("fk_bookings_promo_id", "bookings", "promocodes", ["promo_id"], ["id"])
    op.add_column(
        "bookings", sa.Column("discount_kopeks", sa.Integer(), nullable=False, server_default="0")
    )
    op.add_column(
        "master_profiles",
        sa.Column("rating", sa.Float(), nullable=False, server_default="5.0"),
    )


def downgrade() -> None:
    op.drop_column("master_profiles", "rating")
    op.drop_column("bookings", "discount_kopeks")
    op.drop_constraint("fk_bookings_promo_id", "bookings", type_="foreignkey")
    op.drop_column("bookings", "promo_id")
    op.drop_index("ix_subscription_members_user", table_name="subscription_members")
    op.drop_table("subscription_members")
    op.drop_index("ix_family_subscriptions_owner", table_name="family_subscriptions")
    op.drop_table("family_subscriptions")
    op.drop_index("ix_promocodes_code", table_name="promocodes")
    op.drop_table("promocodes")
