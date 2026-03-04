"""Administrative tools."""

import logging
from typing import Optional, Type

from langchain.tools import BaseTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)


# --- Schemas ---

class McpAdminInput(BaseModel):
    setor: str = Field(description="Setor: 'Financeiro', 'Compras', or 'RH'")
    phone: str = Field(description="Número de telefone do usuário")


class GetKidsInfoInput(BaseModel):
    """No input needed"""
    pass


# --- Tools ---

class McpAdminTool(BaseTool):
    name: str = "mcp_adm"
    description: str = """Encaminha solicitação para áreas administrativas.
    
    Use APENAS se o cliente pedir explicitamente:
    - Contato com Financeiro
    - Contato com Compras
    - Contato com RH
    - Interesse comercial/corporativo
    """
    args_schema: Type[BaseModel] = McpAdminInput
    
    async def _arun(self, setor: str, phone: str) -> str:
        # This would normally call the webhook
        # For now, return success message
        logger.info(f"Admin request: {setor} from {phone}")
        
        return f"✅ Solicitação encaminhada para o setor: {setor}. O responsável entrará em contato em breve."
    
    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")


class GetKidsInfoTool(BaseTool):
    name: str = "get_kids_info"
    description: str = "Retorna informações sobre preços e horários do Espaço Kids"
    args_schema: Type[BaseModel] = GetKidsInfoInput
    
    async def _arun(self) -> str:
        # Default info (could be fetched from DB/config)
        info = """🎠 *Espaço Kids Kharina*

*Horários:*
- Segunda a Quinta: 18h às 22h
- Sexta e Sábado: 18h às 23h
- Domingo: 12h às 21h

*Valores:*
- De 0 a 3 anos: GRÁTIS
- De 4 a 10 anos: R$ 29,90
- Acima de 10 anos: R$ 39,90

*O que inclui:*
- Monitores treinados
- Brinquedos e jogos
- Alimentação supervisionada
- Área segura e monitorada por câmeras

*Obs:* Crianças devem estar acompanhadas de um responsável adulto no restaurante."""
        
        return info
    
    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")
