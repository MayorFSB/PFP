"""0005 unique на имя филиала (защита от дублей сида/тестов)."""

from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_unique_constraint("uq_filials_name", "filials", ["name"])


def downgrade() -> None:
    op.drop_constraint("uq_filials_name", "filials", type_="unique")
