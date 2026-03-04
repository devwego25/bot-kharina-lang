"""Configuration management using Pydantic Settings."""

from functools import lru_cache
from typing import Optional
import os

# Normalize socks5h for httpx globally
for env_var in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    val = os.environ.get(env_var)
    if val and "socks5h://" in val:
        os.environ[env_var] = val.replace("socks5h://", "socks5://")

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )
    
    # Application
    APP_NAME: str = "Kha LangChain Agent"
    APP_VERSION: str = "1.0.0"
    DEBUG: bool = False
    PORT: int = 8000
    HOST: str = "0.0.0.0"
    
    # OpenAI
    OPENAI_API_KEY: str
    OPENAI_MODEL: str = "gpt-4o-mini"
    OPENAI_TEMPERATURE: float = 0.2
    
    # Redis
    REDIS_URL: str = "redis://localhost:6379"
    REDIS_TTL: int = 7200  # 2 hours
    
    # MCP - Cardapio (SSE transport)
    MCP_CARDAPIO_URL: str = "http://cardapio_app:3000/mcp"
    MCP_CARDAPIO_TOKEN: Optional[str] = None
    
    # MCP - Reservas (HTTP POST / streamable transport)
    MCP_RESERVAS_URL: str = "https://mcp.reservas.wegosb.com.br/mcp"
    MCP_RESERVAS_TOKEN: Optional[str] = None
    
    # Logging
    LOG_LEVEL: str = "INFO"
    
    @property
    def is_production(self) -> bool:
        return not self.DEBUG


@lru_cache()
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()
