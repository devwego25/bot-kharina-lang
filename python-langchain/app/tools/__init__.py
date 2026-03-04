"""LangChain tools for Kha agent."""

from langchain.tools import BaseTool

from .reservas import (
    CheckAvailabilityTool,
    CreateReservationTool,
    QueryReservationsTool,
    CancelReservationTool,
    QueryClientTool,
    CreateClientTool,
    ListStoresTool
)
from .cardapio import GetCardapioTool, GetCardapioLinkTool
from .admin import McpAdminTool, GetKidsInfoTool


def get_all_tools() -> list[BaseTool]:
    """Get all available tools for the agent."""
    return [
        # Reservas
        CheckAvailabilityTool(),
        CreateReservationTool(),
        QueryReservationsTool(),
        CancelReservationTool(),
        QueryClientTool(),
        CreateClientTool(),
        ListStoresTool(),
        
        # Cardapio
        GetCardapioTool(),
        GetCardapioLinkTool(),
        
        # Admin
        McpAdminTool(),
        GetKidsInfoTool(),
    ]
