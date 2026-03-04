"""Redis-backed conversation memory for LangChain."""

import logging
from typing import List, Optional

from langchain_community.chat_message_histories import RedisChatMessageHistory
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage
from langchain.memory import ConversationBufferWindowMemory

from app.config import get_settings

logger = logging.getLogger(__name__)


def get_session_memory(session_id: str) -> ConversationBufferWindowMemory:
    """
    Get a conversation memory instance for a session.
    
    Args:
        session_id: Unique session identifier (e.g., "whatsapp_5511999999999")
    
    Returns:
        ConversationBufferWindowMemory with Redis backend
    """
    settings = get_settings()
    
    # Create Redis chat message history
    chat_history = RedisChatMessageHistory(
        session_id=session_id,
        url=settings.REDIS_URL,
        ttl=settings.REDIS_TTL
    )
    
    # Create window memory (last 10 messages)
    memory = ConversationBufferWindowMemory(
        chat_memory=chat_history,
        k=10,
        return_messages=True,
        memory_key="chat_history",
        input_key="input"
    )
    
    logger.debug(f"Created memory for session {session_id}")
    return memory


def get_chat_history(session_id: str) -> List[BaseMessage]:
    """Get raw chat history for a session."""
    settings = get_settings()
    
    chat_history = RedisChatMessageHistory(
        session_id=session_id,
        url=settings.REDIS_URL,
        ttl=settings.REDIS_TTL
    )
    
    return chat_history.messages


def add_message(session_id: str, role: str, content: str) -> None:
    """Add a message to session history."""
    settings = get_settings()
    
    chat_history = RedisChatMessageHistory(
        session_id=session_id,
        url=settings.REDIS_URL,
        ttl=settings.REDIS_TTL
    )
    
    if role == "human":
        chat_history.add_user_message(content)
    elif role == "ai":
        chat_history.add_ai_message(content)
    
    logger.debug(f"Added {role} message to session {session_id}")


def clear_session(session_id: str) -> None:
    """Clear all messages for a session."""
    settings = get_settings()
    
    chat_history = RedisChatMessageHistory(
        session_id=session_id,
        url=settings.REDIS_URL,
        ttl=settings.REDIS_TTL
    )
    
    chat_history.clear()
    logger.info(f"Cleared session {session_id}")
