import axios, { AxiosError } from 'axios';
import { config } from '../config/env';

const LANGCHAIN_URL = process.env.LANGCHAIN_URL || 'http://localhost:8000';

interface ChatRequest {
  session_id: string;
  message: string;
  user_name?: string;
  context: {
    phone: string;
    user_name?: string;
    preferred_store_id?: string;
    preferred_unit_name?: string;
    preferred_city?: string;
    reservation_state?: {
      people?: number;
      kids?: number;
      phone_confirmed?: boolean;
      contact_phone?: string;
      awaiting_confirmation?: boolean;
      awaiting_cancellation?: boolean;
      name?: string;
      date_text?: string;
      time_text?: string;
      occasion?: string;
      notes?: string;
    };
    delivery_state?: {
      city?: string;
    };
  };
}

interface UIAction {
  type: string;
  data?: Record<string, any>;
}

interface ChatResponse {
  response: string;
  intent: string;
  tool_called: string | null;
  ui_action: UIAction | null;
  state_updates: Record<string, any> | null;
  error?: string;
}

export class LangChainService {
  private client = axios.create({
    baseURL: LANGCHAIN_URL,
    timeout: 30000, // 30 seconds
    headers: {
      'Content-Type': 'application/json'
    }
  });

  /**
   * Process message through Python LangChain agent
   */
  async processMessage(
    sessionId: string,
    message: string,
    context: ChatRequest['context']
  ): Promise<ChatResponse> {
    try {
      console.log(`[LangChain] Sending message to agent: ${message.substring(0, 50)}...`);

      const request: ChatRequest = {
        session_id: sessionId,
        message,
        user_name: context.user_name,
        context
      };

      const response = await this.client.post<ChatResponse>('/agent/chat', request);

      console.log(`[LangChain] Response received: intent=${response.data.intent}, tool=${response.data.tool_called}`);

      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        console.error('[LangChain] HTTP Error:', error.response?.status, error.response?.data);
        return {
          response: "Desculpe, tive um probleminha técnico aqui. 😅 Pode repetir por favor?",
          intent: "error",
          tool_called: null,
          ui_action: null,
          state_updates: null,
          error: error.message
        };
      }
      throw error;
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/health');
      return response.data.status === 'healthy';
    } catch (error) {
      console.error('[LangChain] Health check failed:', error);
      return false;
    }
  }
}

export const langchainService = new LangChainService();
