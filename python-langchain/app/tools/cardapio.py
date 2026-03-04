"""Cardapio (menu) related MCP tools."""

import json
import logging
from typing import Optional, Type

from langchain.tools import BaseTool
from pydantic import BaseModel, Field

from app.core.mcp_client import get_mcp_clients

logger = logging.getLogger(__name__)


# --- Schemas ---

class GetCardapioInput(BaseModel):
    query: str = Field(description="Search query for menu items (e.g., 'hambúrguer', 'vinho', 'sobremesa')")
    store_id: Optional[str] = Field(description="Optional: UUID of the store to search", default=None)
    max_items: int = Field(description="Maximum number of items to return", default=5)


class GetCardapioLinkInput(BaseModel):
    cidade: str = Field(description="City name: 'Curitiba', 'Londrina', or 'São Paulo'")


# --- Tools ---

class GetCardapioTool(BaseTool):
    name: str = "mcp_cardapio"
    description: str = """Busca pratos, ingredientes e preços no cardápio.
    
    Use esta tool para responder perguntas sobre:
    - Pratos disponíveis
    - Ingredientes
    - Preços
    - Sugestões de cardápio
    
    Se retornar CARDAPIO_DATA_NOT_FOUND, use o fallback de telefone.
    """
    args_schema: Type[BaseModel] = GetCardapioInput
    
    async def _arun(
        self,
        query: str,
        store_id: Optional[str] = None,
        max_items: int = 5
    ) -> str:
        clients = await get_mcp_clients()
        cardapio = clients["cardapio"]
        
        args = {
            "query": query,
            "maxItems": max_items
        }
        if store_id:
            args["storeId"] = store_id
        
        result = await cardapio.call_tool("mcp_cardapio", args)
        
        # Check if meaningful result
        if self._is_meaningful_result(result):
            return f"CARDAPIO_DATA_FOUND\n{result}"
        else:
            return "CARDAPIO_DATA_NOT_FOUND"
    
    def _is_meaningful_result(self, result: str) -> bool:
        """Check if result contains actual data."""
        normalized = result.strip().lower()
        
        if not normalized or normalized in ['[]', '{}', 'null']:
            return False
        if '"items":[]' in normalized or '"items": []' in normalized:
            return False
        if 'nenhum item encontrado' in normalized:
            return False
        
        # Try to parse JSON
        try:
            data = json.loads(result)
            if isinstance(data, dict):
                items = data.get("items", [])
                if isinstance(items, list) and len(items) == 0:
                    return False
        except:
            pass
        
        return True
    
    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")


class GetCardapioLinkTool(BaseTool):
    name: str = "get_cardapio_link"
    description: str = "Retorna o link do cardápio digital para a cidade especificada"
    args_schema: Type[BaseModel] = GetCardapioLinkInput
    
    async def _arun(self, cidade: str) -> str:
        # Map city names to config keys
        city_map = {
            "curitiba": "link_cardapio_curitiba",
            "londrina": "link_cardapio_londrina",
            "são paulo": "link_cardapio_sp",
            "sao paulo": "link_cardapio_sp",
            "sp": "link_cardapio_sp"
        }
        
        city_lower = cidade.lower()
        config_key = city_map.get(city_lower)
        
        if not config_key:
            # Return default
            return "https://cardapio.kharina.com.br/"
        
        # For now, return default links (could be enhanced to fetch from DB)
        default_links = {
            "link_cardapio_curitiba": "https://cardapio.kharina.com.br/",
            "link_cardapio_londrina": "https://cardapio.kharina.com.br/",
            "link_cardapio_sp": "https://cardapio.kharina.com.br/"
        }
        
        return default_links.get(config_key, "https://cardapio.kharina.com.br/")
    
    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")
