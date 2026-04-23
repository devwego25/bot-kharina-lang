Faz sentido — foca no que entrega valor agora. PRD enxuto só para a Kha:

***

# PRD — Bot Kha (Kharina)
**Atendimento WhatsApp com Agente LangChain**
*GG.AI Labs | v1.0 | Março 2026*

***

## 1. Objetivo

Substituir a lógica LLM atual do bot Node.js por um agente LangChain capaz de **conduzir conversa, coletar dados e executar reservas reais** via tools, com memória de contexto por sessão.

***

## 2. Escopo — O que entra nessa versão

✅ Conversa natural sobre o restaurante
✅ Criar, consultar, alterar e cancelar reservas
✅ Memória de contexto por sessão (Redis)
✅ Classificador de intenção local (Qwen3.5-0.8B)
✅ Integração com Node.js/Wuzapi existente

❌ RAG/cardápio (próxima versão)
❌ Multi-unidade com disponibilidade real
❌ Pagamentos

***

## 3. Arquitetura

```
WhatsApp
   │
Wuzapi
   │
Node.js (já existe)
   │  POST /agent/chat
   ▼
FastAPI (Python) — NOVO
   │
LangChain Agent
   ├── GPT-4o-mini (conversa + tools)
   ├── Qwen3.5-0.8B Ollama (classifica intenção)
   ├── Redis (memória de sessão)
   └── SQLite (banco de reservas)
```

***

## 4. Contrato da API

```json
// POST /agent/chat
{
  "session_id": "whatsapp_5511999999999",
  "message": "Quero reservar para amanhã às 20h",
  "user_name": "Guilherme"
}

// RESPONSE
{
  "response": "Para quantas pessoas? 😊",
  "intent": "criar_reserva",
  "tool_called": null
}
```

***

## 5. Tools

| Tool | Parâmetros obrigatórios | Ação |
|---|---|---|
| `criar_reserva` | nome, data, horario, pessoas | INSERT SQLite |
| `consultar_reserva` | nome ou telefone | SELECT SQLite |
| `alterar_reserva` | id + campo novo | UPDATE SQLite |
| `cancelar_reserva` | id | UPDATE status |

***

## 6. System Prompt da Kha

```
Você é a Kha, assistente virtual do Kharina.
Personalidade: simpática, alegre, informal, usa emojis.
Respostas curtas (máx 3 frases).

REGRAS:
- Colete TODOS os dados antes de criar reserva: nome, data, horário, pessoas
- NUNCA invente dados ou confirme sem usar a tool
- Se não souber algo, diga que um atendente vai ajudar
- Após tool retornar, informe o resultado de forma amigável

RESTAURANTE:
- Horários: Seg-Dom 12h às 23h
- Unidades: Principal, Jardim Botânico, Centro
- Reservas: não informar limite fixo de pessoas por mesa; a acomodação pode variar conforme a configuração e disponibilidade de cada unidade
```

***

## 7. Memória por Sessão

- **TTL:** 2 horas de inatividade
- **Conteúdo:** últimas 10 mensagens
- **Key Redis:** `session:whatsapp_{numero}`
- **Ao retomar:** carrega histórico e continua naturalmente

***

## 8. Fases de Desenvolvimento

**Fase 1 — API básica funcionando (2-3 dias)**
- [ ] FastAPI com `/agent/chat`
- [ ] LangChain + GPT-4o-mini
- [ ] Redis memory
- [ ] Teste via curl/Postman

**Fase 2 — Tools e reservas (2-3 dias)**
- [ ] SQLite com schema de reservas
- [ ] 4 tools implementadas
- [ ] Loop de tool calling
- [ ] Classificador Qwen via Ollama

**Fase 3 — Integração Node.js (1-2 dias)**
- [ ] Client HTTP no Node.js
- [ ] Substituir lógica LLM atual
- [ ] Testes end-to-end WhatsApp real
- [ ] Deploy Easypanel

***

## 9. Critérios de Aceite

| Teste | Esperado |
|---|---|
| "Oi" | Saudação simpática |
| "Quero reservar" | Coleta dados sem inventar |
| Dados completos fornecidos | Cria reserva no SQLite e confirma com ID |
| "Alterar minha reserva" | Pede ID e dado a alterar |
| "Cancelar reserva #3" | Cancela e confirma |
| Sessão após 10 min | Lembra o contexto anterior |

***

## 10. Stack

```
Python 3.11 + FastAPI + LangChain v0.3
GPT-4o-mini
Redis (Docker — já existe)
PostgreSQL 
Docker 
```

***
