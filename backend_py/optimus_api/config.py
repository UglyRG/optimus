from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


ROOT_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT_DIR / ".env", extra="ignore")

    host: str = "localhost"
    port: int = 8788
    frontend_origin: str = "http://localhost:5173"
    database_url: str = "postgresql://optimus:optimus@localhost:5432/optimus"
    optimus_access_key: str = "optimus"
    optimus_public_api_key: str | None = None
    optimus_api_key: str | None = None
    openai_api_key: str | None = None
    openai_admin_key: str | None = None
    openai_olympiacos_news_model: str = "gpt-5"
    anthropic_api_key: str | None = None
    anthropic_admin_key: str | None = None
    anthropic_model: str | None = None
    knowledge_expert_chat_model: str | None = None
    knowledge_expert_embed_model: str = "text-embedding-3-small"
    session_ttl_seconds: int = 60 * 60 * 12
    data_dir: Path = ROOT_DIR / "data"
    outputs_dir: Path = ROOT_DIR / "Outputs"

    @property
    def public_api_key(self) -> str:
        return self.optimus_public_api_key or self.optimus_api_key or self.optimus_access_key


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
