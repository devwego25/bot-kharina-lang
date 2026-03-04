import axios from 'axios';
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
    timeout: 12000, // 12 seconds (faster failover for WhatsApp UX)
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
    context: ChatRequest['context'],
    options?: { timeoutMs?: number }
  ): Promise<ChatResponse> {
    try {
      console.log(`[LangChain] Sending message to agent: ${message.substring(0, 50)}...`);

      const request: ChatRequest = {
        session_id: sessionId,
        message,
        user_name: context.user_name,
        context
      };

      const response = await this.client.post<ChatResponse>('/agent/chat', request, {
        timeout: options?.timeoutMs
      });

      console.log(`[LangChain] Response received: intent=${response.data.intent}, tool=${response.data.tool_called}`);

      return response.data;
    } catch (error: any) {
      const isAxiosErr = Boolean(error?.isAxiosError);
      const status = error?.response?.status;
      const responseData = error?.response?.data;
      const code = error?.code;
      const message = error?.message || 'Unknown error';

      if (isAxiosErr) {
        console.error('[LangChain] HTTP Error:', { status, code, message, responseData });
        return {
          response: "Desculpe, tive um probleminha técnico aqui. 😅 Pode repetir por favor?",
          intent: "error",
          tool_called: null,
          ui_action: null,
          state_updates: null,
          error: message
        };
      }

      console.error('[LangChain] Non-HTTP Error:', error);
      return {
        response: "Desculpe, tive um probleminha técnico aqui. 😅 Pode repetir por favor?",
        intent: "error",
        tool_called: null,
        ui_action: null,
        state_updates: null,
        error: message
      };
    }
  }

  /**
   * Health check
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.client.get('/health');
      return (response.data as any).status === 'healthy';
    } catch (error) {
      console.error('[LangChain] Health check failed:', error);
      return false;
    }
  }
}

export const langchainService = new LangChainService();
