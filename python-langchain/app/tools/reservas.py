"""Reservation-related MCP tools."""

import json
import logging
from typing import Optional, Type

from langchain.tools import BaseTool
from pydantic import BaseModel, Field

from app.core.mcp_client import get_mcp_clients

logger = logging.getLogger(__name__)


# --- Schemas ---

class CheckAvailabilityInput(BaseModel):
    store_id: str = Field(description="UUID of the store/unit")
    date: str = Field(description="Date in YYYY-MM-DD format")
    time: str = Field(description="Time in HH:MM format")
    number_of_people: int = Field(description="Number of people", ge=1)


class CreateReservationInput(BaseModel):
    store_id: str = Field(description="UUID of the store/unit")
    client_phone: str = Field(description="Client phone number")
    date: str = Field(description="Date in YYYY-MM-DD format")
    time: str = Field(description="Time in HH:MM format")
    number_of_people: int = Field(description="Number of people", ge=1)
    kids: Optional[int] = Field(description="Number of children", default=0)
    notes: Optional[str] = Field(description="Additional notes", default=None)


class QueryReservationsInput(BaseModel):
    client_phone: str = Field(description="Client phone number to search")
    start_date: Optional[str] = Field(description="Start date filter (YYYY-MM-DD)", default=None)
    end_date: Optional[str] = Field(description="End date filter (YYYY-MM-DD)", default=None)


class CancelReservationInput(BaseModel):
    reservation_id: str = Field(description="Reservation ID to cancel")
    reason: Optional[str] = Field(description="Cancellation reason", default="Solicitado pelo cliente")


class QueryClientInput(BaseModel):
    phone: str = Field(description="Client phone number")


class CreateClientInput(BaseModel):
    name: str = Field(description="Client full name")
    phone: str = Field(description="Client phone number")
    email: Optional[str] = Field(description="Client email", default=None)


class ListStoresInput(BaseModel):
    """No input needed"""
    pass


# --- Tools ---

class CheckAvailabilityTool(BaseTool):
    name: str = "check_availability"
    description: str = "Verifica disponibilidade de mesas para uma data, horário e quantidade de pessoas"
    args_schema: Type[BaseModel] = CheckAvailabilityInput
    
    async def _arun(self, store_id: str, date: str, time: str, number_of_people: int) -> str:
        clients = await get_mcp_clients()
        reservas = clients["reservas"]
        
        result = await reservas.call_tool("check_availability", {
            "storeId": store_id,
            "date": date,
            "time": time,
            "numberOfPeople": number_of_people
        })
        
        return result
    
    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")


class CreateReservationTool(BaseTool):
    name: str = "create_reservation"
    description: str = "Cria uma nova reserva no sistema. APENAS use após o cliente confirmar no menu visual!"
    args_schema: Type[BaseModel] = CreateReservationInput
    
    async def _arun(
        self,
        store_id: str,
        client_phone: str,
        date: str,
        time: str,
        number_of_people: int,
        kids: Optional[int] = 0,
        notes: Optional[str] = None
    ) -> str:
        clients = await get_mcp_clients()
        reservas = clients["reservas"]
        
        args = {
            "storeId": store_id,
            "clientPhone": client_phone,
            "date": date,
            "time": time,
            "numberOfPeople": number_of_people,
            "kids": kids or 0
        }
        if notes:
            args["notes"] = notes
        
        result = await reservas.call_tool("create_reservation", args)
        return result
    
    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")


class QueryReservationsTool(BaseTool):
    name: str = "query_reservations"
    description: str = "Consulta reservas existentes de um cliente pelo telefone"
    args_schema: Type[BaseModel] = QueryReservationsInput
    
    async def _arun(
        self,
        client_phone: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None
    ) -> str:
        clients = await get_mcp_clients()
        reservas = clients["reservas"]
        
        args = {"clientPhone": client_phone}
        if start_date:
            args["startDate"] = start_date
        if end_date:
            args["endDate"] = end_date
        
        result = await reservas.call_tool("query_reservations", args)
        return result
    
    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")


class CancelReservationTool(BaseTool):
    name: str = "cancel_reservation"
    description: str = "Cancela uma reserva existente pelo ID"
    args_schema: Type[BaseModel] = CancelReservationInput
    
    async def _arun(self, reservation_id: str, reason: Optional[str] = None) -> str:
        clients = await get_mcp_clients()
        reservas = clients["reservas"]
        
        args = {"reservationId": reservation_id}
        if reason:
            args["reason"] = reason
        
        result = await reservas.call_tool("cancel_reservation", args)
        return result
    
    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")


class QueryClientTool(BaseTool):
    name: str = "query_client"
    description: str = "Busca informações de um cliente pelo telefone"
    args_schema: Type[BaseModel] = QueryClientInput
    
    async def _arun(self, phone: str) -> str:
        clients = await get_mcp_clients()
        reservas = clients["reservas"]
        
        result = await reservas.call_tool("query_client", {"phone": phone})
        return result
    
    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")


class CreateClientTool(BaseTool):
    name: str = "create_client"
    description: str = "Cria um novo cliente no sistema"
    args_schema: Type[BaseModel] = CreateClientInput
    
    async def _arun(
        self,
        name: str,
        phone: str,
        email: Optional[str] = None
    ) -> str:
        clients = await get_mcp_clients()
        reservas = clients["reservas"]
        
        args = {"name": name, "phone": phone}
        if email:
            args["email"] = email
        
        result = await reservas.call_tool("create_client", args)
        return result
    
    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")


class ListStoresTool(BaseTool):
    name: str = "list_stores"
    description: str = "Lista todas as unidades/restaurantes disponíveis"
    args_schema: Type[BaseModel] = ListStoresInput
    
    async def _arun(self) -> str:
        clients = await get_mcp_clients()
        reservas = clients["reservas"]
        
        result = await reservas.call_tool("list_stores", {})
        return result
    
    def _run(self, **kwargs) -> str:
        raise NotImplementedError("Use async version")
