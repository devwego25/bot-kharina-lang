"""Chat endpoint for agent interaction."""

import logging
import re
from datetime import datetime
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from langchain_core.messages import HumanMessage, AIMessage

from app.models.schemas import ChatRequest, ChatResponse, UIAction
from app.core.agent import get_agent_executor
from app.core.memory import get_session_memory, add_message

logger = logging.getLogger(__name__)


def _extract_reservation_updates(output: str, request: ChatRequest) -> Dict[str, Any]:
    """
    Extract reservation state fields from agent output text and request context.
    Returns a dict to be merged into state_updates['reservation_state'].
    """
    updates: Dict[str, Any] = {}

    # Carry forward all existing context fields
    if request.context and request.context.reservation_state:
        rs = request.context.reservation_state
        if rs.name:          updates["name"] = rs.name
        if rs.date_text:     updates["date_text"] = rs.date_text
        if rs.time_text:     updates["time_text"] = rs.time_text
        if rs.people is not None:  updates["people"] = rs.people
        if rs.kids is not None:    updates["kids"] = rs.kids
        if rs.contact_phone: updates["contact_phone"] = rs.contact_phone
        if rs.phone_confirmed: updates["phone_confirmed"] = rs.phone_confirmed

    # --- Extract date in YYYY-MM-DD format from agent output ---
    date_match = re.search(r"(\d{4}-\d{2}-\d{2})", output)
    if not date_match:
        # Try DD/MM/YYYY format
        date_match = re.search(r"(\d{2}/\d{2}/\d{4})", output)
        if date_match:
            # Convert to YYYY-MM-DD
            parts = date_match.group(1).split("/")
            updates["date_text"] = f"{parts[2]}-{parts[1]}-{parts[0]}"
    else:
        updates["date_text"] = date_match.group(1)

    # --- Extract time HH:MM ---
    time_match = re.search(r"\b(\d{1,2})[hH:](\d{0,2})\b", output)
    if time_match:
        hh = time_match.group(1).zfill(2)
        mm = (time_match.group(2) or "00").zfill(2)
        updates["time_text"] = f"{hh}:{mm}"

    # --- Extract number of people ---
    people_match = re.search(
        r"(?:pessoas?|people|pax)[^\d]*(\d+)|" +
        r"(\d+)\s*(?:pessoa|people|pax)",
        output, re.IGNORECASE
    )
    if people_match:
        val = people_match.group(1) or people_match.group(2)
        updates["people"] = int(val)

    # --- Extract number of kids ---
    kids_match = re.search(
        r"(?:crian[çc]a|kid|child)[^\d]*(\d+)|(\d+)\s*(?:crian[çc]a|kid|child)",
        output, re.IGNORECASE
    )
    if kids_match:
        val = kids_match.group(1) or kids_match.group(2)
        updates["kids"] = int(val)
    elif re.search(r"sem crian[çc]a|no kids|0 crian[çc]a", output, re.IGNORECASE):
        updates["kids"] = 0

    # --- Extract client name (from context) ---
    if request.context and request.context.user_name:
        updates["name"] = updates.get("name") or request.context.user_name

    return updates

router = APIRouter()


def detect_intent(message: str, output: str, tool_calls: list) -> str:
    """Detect conversation intent."""
    msg_lower = message.lower()
    
    # Check for reservation-related intents
    if any(word in msg_lower for word in ["reserv", "mesa", "horário", "data"]):
        if tool_calls and any(t.get("tool") in ["create_reservation", "check_availability"] for t in tool_calls):
            return "criar_reserva"
        return "interesse_reserva"
    
    if any(word in msg_lower for word in ["cancelar", "cancela"]):
        return "cancelar_reserva"
    
    if any(word in msg_lower for word in ["minha reserva", "tenho reserva", "consultar"]):
        return "consultar_reserva"
    
    if any(word in msg_lower for word in ["cardápio", "cardapio", "prato", "comida"]):
        return "cardapio"
    
    if any(word in msg_lower for word in ["delivery", "entrega", "ifood"]):
        return "delivery"
    
    return "general"


def parse_agent_output(output: str) -> tuple[str, UIAction | None]:
    """
    Parse agent output to extract response text and UI actions.
    
    Special tokens:
    - CONFIRM_RESERVATION_NEEDED -> show_confirmation_menu
    - CONFIRM_CANCEL_ID:{id} -> show_cancel_confirmation
    - MENU_PRINCIPAL -> show_main_menu
    """
    ui_action = None
    
    # Check for confirmation token
    if "CONFIRM_RESERVATION_NEEDED" in output:
        ui_action = UIAction(
            type="show_confirmation_menu",
            data={}
        )
        # Remove token from response
        output = output.replace("CONFIRM_RESERVATION_NEEDED", "").strip()
    
    # Check for main menu token
    if "MENU_PRINCIPAL" in output:
        ui_action = UIAction(
            type="show_main_menu",
            data={}
        )
        output = output.replace("MENU_PRINCIPAL", "").strip()

    # Check for cardapio menu token
    if "MENU_CIDADES_CARDAPIO" in output:
        ui_action = UIAction(
            type="show_cardapio_menu",
            data={}
        )
        output = output.replace("MENU_CIDADES_CARDAPIO", "").strip()

    # Check for delivery menu token
    if "MENU_DELIVERY_CIDADES" in output:
        ui_action = UIAction(
            type="show_delivery_menu",
            data={}
        )
        output = output.replace("MENU_DELIVERY_CIDADES", "").strip()

    # Check for units menu token (reserva)
    if "MENU_UNIDADES_RESERVA" in output:
        ui_action = UIAction(
            type="show_unidades_menu",
            data={}
        )
        output = output.replace("MENU_UNIDADES_RESERVA", "").strip()
    
    # Check for cancel confirmation token
    cancel_match = re.search(r"CONFIRM_CANCEL_ID:\s*([A-Za-z0-9\-]+)", output)
    if cancel_match:
        reservation_id = cancel_match.group(1)
        ui_action = UIAction(
            type="show_cancel_confirmation",
            data={"reservation_id": reservation_id}
        )
        output = output.replace(cancel_match.group(0), "").strip()
    
    # Clean up multiple newlines
    output = re.sub(r'\n{3,}', '\n\n', output).strip()
    
    return output, ui_action


@router.post("/chat", response_model=ChatResponse)
async def chat(request: ChatRequest) -> ChatResponse:
    """
    Process a chat message and return agent response.
    """
    try:
        logger.info(f"Chat request: session={request.session_id}, message={request.message[:50]}...")
        
        # Get session memory
        memory = get_session_memory(request.session_id)
        
        # Build context from Node.js
        context_parts = []
        if request.context:
            ctx = request.context
            
            if ctx.phone:
                context_parts.append(f"Telefone do cliente: {ctx.phone}")
            if ctx.user_name:
                context_parts.append(f"Nome do cliente: {ctx.user_name}")
            if ctx.preferred_store_id:
                context_parts.append(f"Store ID: {ctx.preferred_store_id}")
            if ctx.preferred_unit_name:
                context_parts.append(f"Unidade escolhida: {ctx.preferred_unit_name}")
            if ctx.preferred_city:
                context_parts.append(f"Cidade preferida: {ctx.preferred_city}")
            
            # Add reservation state if exists
            if ctx.reservation_state:
                rs = ctx.reservation_state
                if rs.people is not None:
                    context_parts.append(f"Pessoas: {rs.people}")
                if rs.kids is not None:
                    context_parts.append(f"Crianças: {rs.kids}")
                if rs.name:
                    context_parts.append(f"Nome na reserva: {rs.name}")
                if rs.date_text:
                    context_parts.append(f"Data: {rs.date_text}")
                if rs.time_text:
                    context_parts.append(f"Horário: {rs.time_text}")
                if rs.contact_phone:
                    context_parts.append(f"Telefone para contato: {rs.contact_phone}")
                if rs.phone_confirmed:
                    context_parts.append("Telefone já confirmado: sim")
                if rs.awaiting_confirmation:
                    context_parts.append("Aguardando confirmação da reserva: sim")
        
        # Build input with context
        context_str = "\n".join(context_parts)
        if context_str:
            full_input = f"[CONTEXTO]\n{context_str}\n\n[MENSAGEM]\n{request.message}"
        else:
            full_input = request.message
        
        logger.debug(f"Full input to agent:\n{full_input}")
        
        # Get agent executor
        agent_executor = get_agent_executor()
        
        # Run agent
        result = await agent_executor.ainvoke({
            "input": full_input,
            "chat_history": memory.chat_memory.messages
        })
        
        # Extract output and tool calls
        output = result.get("output", "Desculpe, não consegui processar sua mensagem.")
        intermediate_steps = result.get("intermediate_steps", [])
        
        logger.debug(f"Raw agent output: {output}")
        
        # Parse for UI actions
        response_text, ui_action = parse_agent_output(output)
        
        # Detect intent
        tool_calls = [{"tool": step[0].tool, "input": step[0].tool_input} for step in intermediate_steps]
        intent = detect_intent(request.message, output, tool_calls)
        
        # Get last tool called
        last_tool = tool_calls[-1]["tool"] if tool_calls else None
        
        # Build state_updates — always include reservation state when in reservation flow
        state_updates: Dict[str, Any] = {"last_intent": intent}
        
        # Propagate reservation state updates back to Node.js
        if ui_action and ui_action.type == "show_confirmation_menu":
            # Extract from agent output + existing context so Node.js can build the
            # confirmation menu with real data instead of "❓ Pendente"
            reservation_updates = _extract_reservation_updates(output, request)
            if reservation_updates:
                state_updates["reservation_state"] = reservation_updates
                logger.info(f"Propagating reservation state: {reservation_updates}")
        elif intent in ("criar_reserva", "interesse_reserva"):
            # Progressively update reservation state even before confirmation
            reservation_updates = _extract_reservation_updates(output, request)
            if reservation_updates:
                state_updates["reservation_state"] = reservation_updates
        
        # Save to memory (only if not a pure menu command)
        if not ui_action or ui_action.type != "show_main_menu":
            memory.chat_memory.add_user_message(request.message)
            memory.chat_memory.add_ai_message(response_text)
        
        logger.info(f"Chat response: intent={intent}, tool={last_tool}, has_ui_action={ui_action is not None}")
        
        return ChatResponse(
            response=response_text,
            intent=intent,
            tool_called=last_tool,
            ui_action=ui_action,
            state_updates=state_updates
        )
        
    except Exception as e:
        logger.error(f"Error in chat endpoint: {e}", exc_info=True)
        return ChatResponse(
            response=(
                "Tive uma instabilidade para verificar a disponibilidade agora 😕\n"
                "Se estiver tudo certo no resumo, toque em *Sim, tudo certo!* novamente que eu tento concluir a reserva."
            ),
            intent="error",
            tool_called=None,
            ui_action=None,
            state_updates={"last_intent": "error"},
        )
