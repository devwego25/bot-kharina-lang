# Kha Multi-Agent Board (KBS) 🚀

## Core Optimization: Multi-Agent Architecture (OpenAI SDK)

Migramos nossa IA monolítica para uma arquitetura de múltiplos agentes especializados, utilizando o **OpenAI Agents SDK**. Isso nos permitiu segmentar o "cérebro" da Kha em especialistas focados, reduzindo latência, custos e melhorando drasticamente a assertividade.

### 🧠 Divisão de Agentes
- **Kha_Triage (GPT-4o-mini)**: Porteira inteligente. Encaminha para o especialista sem consumir tokens caros desnecessariamente.
- **Kha_Maitre (GPT-4o-mini)**: Especialista em cardápio, sabores e vinhos. Possui contexto profundo sobre os produtos.
- **Kha_Reservas (GPT-4o)**: Especialista em lógica de reserva. O único que utiliza o modelo mais potente para garantir zero erro em datas e disponibilidade.
- **Kha_Delivery (GPT-4o-mini)**: Focado em iFood e suporte logístico.

### 🛡️ Governança de Dados & Guardrails
Implementamos uma camada de segurança via código para proteger a integridade das informações:
- **LinkGuardrail**: Filtro de saída que bloqueia qualquer link alucinado. O bot só envia URLs que constam nas variáveis oficiais (`system_config`).
- **StoreValidation**: Bloqueio de inputs de unidade inválidos, prevenindo erros no sistema de agendamento.
- **CapacityGuardrail**: Regra de negócio rígida (ex: max 30 pessoas) aplicada no nível do SDK, impossível de ser ignorada pelo LLM.

### 📊 Métricas Técnicas (Ganhos)
- **Prompt Reduction**: Redução de **~85%** no tamanho do prompt fixo por turno/agente.
- **Cost Efficiency**: Economia estimada de **60%** em tokens de entrada ao usar `gpt-4o-mini` para triagem e cardápio.
- **Fluid Memory**: Implementação de `MemorySession` por usuário (Chatwoot ID), mantendo contexto fluido entre especialistas.

---
**Status**: Fase 2 (Config Governance) Concluída. Arquitetura validada e pronta para escala.
