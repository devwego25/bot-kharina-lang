"""FastAPI main application."""

import logging
import sys
import os
# Fix for httpx not supporting socks5h scheme
# Normalize it to socks5:// which is understood by httpx[socks]
for env_var in ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]:
    val = os.environ.get(env_var)
    if val and val.startswith("socks5h://"):
        os.environ[env_var] = val.replace("socks5h://", "socks5://")

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.core.mcp_client import get_mcp_clients
from app.api.routes import chat

# Configure logging
def configure_logging():
    """Configure structured logging."""
    settings = get_settings()
    
    logging.basicConfig(
        level=getattr(logging, settings.LOG_LEVEL.upper()),
        format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout)
        ]
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan events."""
    # Startup
    configure_logging()
    logger = logging.getLogger(__name__)
    logger.info("Starting Kha LangChain Agent...")
    
    # Initialize MCP clients
    try:
        clients = await get_mcp_clients()
        for name, client in clients.items():
            logger.info(f"MCP Client '{name}' ready: {client.ready}")
    except Exception as e:
        logger.error(f"Failed to initialize MCP clients: {e}")
    
    yield
    
    # Shutdown
    logger.info("Shutting down...")
    clients = await get_mcp_clients()
    for client in clients.values():
        await client.close()


def create_app() -> FastAPI:
    """Create FastAPI application."""
    settings = get_settings()
    
    app = FastAPI(
        title=settings.APP_NAME,
        version=settings.APP_VERSION,
        description="LangChain-powered agent for Kharina restaurant bot",
        lifespan=lifespan,
        docs_url="/docs" if settings.DEBUG else None,
        redoc_url="/redoc" if settings.DEBUG else None
    )
    
    # CORS
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # Restrict in production
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    
    # Include routers
    app.include_router(chat.router, prefix="/agent", tags=["agent"])
    
    @app.get("/health")
    async def health_check():
        """Health check endpoint."""
        clients = await get_mcp_clients()
        mcp_status = {
            name: client.ready 
            for name, client in clients.items()
        }
        
        return {
            "status": "healthy",
            "version": settings.APP_VERSION,
            "mcp_clients": mcp_status
        }
    
    @app.get("/")
    async def root():
        """Root endpoint."""
        return {
            "name": settings.APP_NAME,
            "version": settings.APP_VERSION,
            "docs": "/docs"
        }
    
    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn
    settings = get_settings()
    uvicorn.run(
        "app.main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.DEBUG,
        log_level=settings.LOG_LEVEL.lower()
    )
