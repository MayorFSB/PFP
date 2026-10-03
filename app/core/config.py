from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "PFP"
    database_url: str = "postgresql+asyncpg://pfp:pfp@localhost:5433/pfp"
    valkey_url: str = "redis://localhost:6380/0"
    password_pepper: str = "dev-pepper-change-me"
    jwt_secret: str = "dev-jwt-secret-change-me"
    access_ttl_min: int = 15
    refresh_ttl_days: int = 30
    google_client_id: str = Field(
        default="",
        validation_alias=AliasChoices("PFP_GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_ID", "CLIENT_ID"),
    )
    google_client_secret: str = Field(
        default="",
        validation_alias=AliasChoices(
            "PFP_GOOGLE_CLIENT_SECRET", "GOOGLE_CLIENT_SECRET", "CLIENT_SECRET"
        ),
    )
    google_redirect: str = "http://localhost:8000/api/v1/auth/google/callback"
    telegram_bot_token: str = Field(
        default="", validation_alias=AliasChoices("PFP_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN")
    )

    model_config = {"env_prefix": "PFP_", "env_file": ".env", "extra": "ignore"}


settings = Settings()
