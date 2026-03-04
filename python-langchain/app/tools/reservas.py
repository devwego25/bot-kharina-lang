"""Reservation-related MCP tools."""

import json
import logging
import re
from typing import Optional, Type

from langchain.tools import BaseTool
from pydantic import BaseModel, Field

from app.core.mcp_client import get_mcp_clients

logger = logging.getLogger(__name__)
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.IGNORECASE)
STORE_ALIAS_TO_UUID = {
    "jardim botanico": "a99c098f-c16b-4168-a5b1-54e76aa1a855",
    "cabral": "c6919b3c-f5ff-4006-a226-2b493d9d8cf5",
    "agua verde": "fde9ba37-baff-4958-b6be-5ced7059864c",
    "batel": "b45c9b5e-4f79-47b1-a442-ea8fb9d6e977",
    "portao": "f0f6ae17-01d1-4c51-a423-33222f8fcd5c",
    "londrina": "3e027375-3049-4080-98c3-9f7448b8fd62",
    "higienopolis": "3e027375-3049-4080-98c3-9f7448b8fd62",
    "sao paulo": "03dc5466-6c32-4e9e-b92f-c8b02e74bba6",
    "shopping parque da cidade": "03dc5466-6c32-4e9e-b92f-c8b02e74bba6",
}


def _normalize_store_id(raw: str) -> str:
    value = (raw or "").strip()
    if UUID_RE.match(value):
        return value
    normalized = (
        value.lower()
        .replace("á", "a")
        .replace("à", "a")
        .replace("â", "a")
        .replace("ã", "a")
        .replace("é", "e")
        .replace("ê", "e")
        .replace("í", "i")
        .replace("ó", "o")
        .replace("ô", "o")
        .replace("õ", "o")
        .replace("ú", "u")
        .replace("ç", "c")
    )
    resolved = STORE_ALIAS_TO_UUID.get(normalized)
    if resolved:
        logger.warning("Resolved non-UUID store_id '%s' -> '%s'", raw, resolved)
        return resolved
    return value


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
        resolved_store_id = _normalize_store_id(store_id)
        
        result = await reservas.call_tool("check_availability", {
            "storeId": resolved_store_id,
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
        resolved_store_id = _normalize_store_id(store_id)
        
        args = {
            "storeId": resolved_store_id,
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
