from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    app_name: str = "PFP"
    database_url: str = "postgresql+asyncpg://pfp:pfp@localhost:5433/pfp"
    valkey_url: str = "redis://localhost:6380/0"
    password_pepper: str = "dev-pepper-change-me"
    access_ttl_min: int = 15

    model_config = {"env_prefix": "PFP_", "env_file": ".env"}


settings = Settings()
