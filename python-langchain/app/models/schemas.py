"""Pydantic schemas for API requests and responses."""

from typing import Any, Dict, Optional
from pydantic import BaseModel, Field


class ReservationState(BaseModel):
    """State of ongoing reservation flow."""
    people: Optional[int] = None
    kids: Optional[int] = None
    phone_confirmed: bool = False
    contact_phone: Optional[str] = None
    awaiting_confirmation: bool = False
    awaiting_cancellation: bool = False
    name: Optional[str] = None
    date_text: Optional[str] = None
    time_text: Optional[str] = None
    occasion: Optional[str] = None
    notes: Optional[str] = None


class DeliveryState(BaseModel):
    """State of delivery flow."""
    city: Optional[str] = None


class ContextData(BaseModel):
    """Context data passed from Node.js to Python."""
    phone: str = Field(description="WhatsApp phone number")
    user_name: Optional[str] = None
    preferred_store_id: Optional[str] = None
    preferred_unit_name: Optional[str] = None
    preferred_city: Optional[str] = None
    reservation_state: Optional[ReservationState] = None
    delivery_state: Optional[DeliveryState] = None
    history: Optional[list] = Field(default_factory=list, description="Previous messages")


class ChatRequest(BaseModel):
    """Request body for /agent/chat endpoint."""
    session_id: str = Field(description="Unique session ID (e.g., whatsapp_5511999999999)")
    message: str = Field(description="User message")
    user_name: Optional[str] = Field(default=None, description="User display name")
    context: Optional[ContextData] = Field(default=None, description="Additional context from Node.js")


class UIAction(BaseModel):
    """UI action to be performed by Node.js."""
    type: str = Field(description="Action type: show_confirmation_menu, show_main_menu, etc")
    data: Optional[Dict[str, Any]] = Field(default=None, description="Action-specific data")


class ChatResponse(BaseModel):
    """Response from /agent/chat endpoint."""
    response: str = Field(description="Text response to send to user")
    intent: str = Field(default="general", description="Detected intent")
    tool_called: Optional[str] = Field(default=None, description="Name of tool that was called")
    ui_action: Optional[UIAction] = Field(default=None, description="UI action for Node.js")
    state_updates: Optional[Dict[str, Any]] = Field(default=None, description="State updates for Node.js")
    error: Optional[str] = Field(default=None, description="Error message if any")
