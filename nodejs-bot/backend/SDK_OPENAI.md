Aqui vai o **resumão completo** do OpenAI Agents SDK em TypeScript, com foco na parte que você vai usar (bot de restaurante):

## Primitivos Core

O SDK tem **4 blocos fundamentais**: [openai.github](https://openai.github.io/openai-agents-python/)

| Bloco | Função |
|-------|--------|
| **Agent** | LLM com instruções, tools e configurações |
| **Runner** | Executa o agent loop (tool calls → LLM → repeat) |
| **Handoffs** | Delegação entre agentes especializados |
| **Guardrails** | Validações de segurança em input/output/tools |

## Guardrails (A parte mais importante)

### Tipos de Guardrails

```
┌─────────────────────────────────────────────────────────┐
│  INPUT GUARDRAILS (rodam só no primeiro agente)        │
│  ├── runInParallel: true (default) - roda junto com LLM│
│  └── runInParallel: false - bloqueia ANTES do LLM      │
├─────────────────────────────────────────────────────────┤
│  OUTPUT GUARDRAILS (rodam só no último agente)         │
│  └── Valida a resposta final antes de entregar         │
├─────────────────────────────────────────────────────────┤
│  TOOL GUARDRAILS (envolvem function tools)             │
│  ├── Input: valida ANTES de executar a tool            │
│  └── Output: valida DEPOIS de executar a tool          │
└─────────────────────────────────────────────────────────┘
```

### Código prático

```typescript
import { 
  Agent, 
  Runner, 
  InputGuardrail, 
  GuardrailFunctionOutput,
  tool
} from '@openai-agents/sdk';
import { z } from 'zod';

// === INPUT GUARDRAIL ===
// Bloqueia se fora do horário (ex: restaurante fechado)
async function horarioGuardrail(
  ctx: RunContextWrapper<undefined>,
  agent: Agent<undefined>,
  input: string
): Promise<GuardrailFunctionOutput> {
  const estaAberto = await verificarHorarioFuncionamento();
  
  return {
    outputInfo: { aberto: estaAberto },
    tripwireTriggered: !estaAberto, // true = bloqueia
  };
}

// === TOOL GUARDRAIL ===
// Valida antes de criar reserva
const criarReservaTool = tool({
  name: 'criar_reserva',
  parameters: z.object({
    unidade: z.string(),
    data: z.string(),
    pessoas: z.number(),
  }),
  execute: async (params) => {
    // lógica de criação...
    return { success: true, id: 'RES-123' };
  },
  // Guardrail de input da tool
  inputGuardrail: async (params) => {
    const unidadeExiste = await checkUnidade(params.unidade);
    if (!unidadeExiste) {
      return { 
        behavior: 'rejectContent', // ou 'throwException'
        rejectionContent: 'Unidade não encontrada'
      };
    }
    return { behavior: 'allow' };
  },
});

// === AGENT COM GUARDRAILS ===
const reservaAgent = new Agent({
  name: 'Reservas',
  model: 'gpt-5.1-codex-mini',
  instructions: 'Extraia dados da reserva e crie usando a tool',
  tools: [criarReservaTool],
  inputGuardrails: [
    new InputGuardrail({
      guardrailFunction: horarioGuardrail,
      runInParallel: false, // Seguro: bloqueia antes de gastar tokens
    }),
  ],
});
```

### Modos de Execução Guardrails

| Modo | Quando usar | Trade-off |
|------|-------------|-----------|
| `runInParallel: true` | Validações leves (spam check) | Velocidade, mas pode gastar tokens antes de bloquear |
| `runInParallel: false` | Validações críticas (horário, autenticação) | Segurança/custo, mas adiciona latência |

## Agentes e Handoffs

### Estrutura para seu restaurante

```typescript
// Agent especializado em info (modelo barato)
const infoAgent = new Agent({
  name: 'InfoUnidades',
  model: 'gpt-4o-mini',
  instructions: 'Responda sobre endereços, horários, estacionamento...',
  tools: [buscarDadosUnidade],
});

// Agent especializado em cardápio (modelo barato)
const cardapioAgent = new Agent({
  name: 'Cardapio',
  model: 'gpt-4o-mini',
  instructions: 'Liste pratos, preços, alérgenos...',
  tools: [consultarCardapio],
});

// Agent de reservas (modelo inteligente)
const reservaAgent = new Agent({
  name: 'Reservas',
  model: 'gpt-5.1-codex-mini',
  instructions: 'Extraia data/hora/unidade/pessoas e crie reserva',
  tools: [verificarDisponibilidade, criarReservaTool],
  inputGuardrails: [horarioGuardrail],
});

// Triage (roteador)
const triageAgent = new Agent({
  name: 'Triage',
  model: 'gpt-4o-mini',
  instructions: 'Roteie para Info, Cardápio ou Reservas',
  handoffs: [infoAgent, cardapioAgent, reservaAgent],
});
```

### O Runner executa o loop

```typescript
import { Runner } from '@openai-agents/sdk';

const result = await Runner.run(triageAgent, 
  'Quero reservar mesa para 4 pessoas no shopping sábado 20h'
);

// Resultado contém:
// - Final output (resposta do agente)
// - Histórico completo de items (MessageOutputItem, HandoffCallItem, ToolCallItem)
// - Novo agente (se houve handoff)
```

## Tools (Function Tools)

```typescript
import { tool } from '@openai-agents/sdk';
import { z } from 'zod';

// Schema automático via Zod
const calcularFrete = tool({
  name: 'calcular_frete',
  parameters: z.object({
    endereco: z.string(),
    unidade: z.enum(['centro', 'shopping', 'leste', 'oeste', 'norte', 'sul', 'higienopolis']),
  }),
  execute: async ({ endereco, unidade }) => {
    // Integração com Google Maps ou similar
    return { valor: 15.0, tempo: '30-45 min' };
  },
});
```

### Tool com guardrails completo

```typescript
const criarReservaSegura = tool({
  name: 'criar_reserva_segura',
  parameters: z.object({ unidade: z.string(), data: z.string(), pessoas: z.number() }),
  
  // Valida ANTES de executar
  inputGuardrail: async (params) => {
    const disponivel = await checkDisponibilidade(params);
    if (!disponivel) {
      return { 
        behavior: 'rejectContent',
        rejectionContent: 'Horário indisponível, quero sugerir alternativas?'
      };
    }
    return { behavior: 'allow' };
  },
  
  // Valida DEPOIS de executar
  outputGuardrail: async (output) => {
    if (!output.success) {
      return { behavior: 'throwException' }; // Erro crítico
    }
    return { behavior: 'allow' };
  },
  
  execute: async (params) => {
    return await db.reservas.create(params);
  },
});
```

## Outros recursos importantes

### Sessions (Memória persistente)

```typescript
import { Session } from '@openai-agents/sdk';

const session = new Session();
// Mantém contexto entre mensagens do WhatsApp
await Runner.run(agent, input, { session });
```

### Tracing (Observabilidade)

```typescript
// Todas as runs são rastreadas automaticamente
// Dá pra ver no dashboard: handoffs, tool calls, latência, tokens
```

### Human in the Loop

```typescript
// Pausa execução para aprovação humana
const result = await Runner.run(agent, input, {
  context: { requireApproval: true }
});
```

### MCP Server Tools

```typescript
// Integra tools de servidores MCP externos
// Funciona igual function tools para o agente
```

## Checklist de implementação para seu bot

| Componente | Tipo | Modelo | Guardrails |
|------------|------|--------|------------|
| **Triage** | Agent | `gpt-4o-mini` | Fora do horário (input, sequential) |
| **Info** | Handoff | `gpt-4o-mini` | Não valida info sensível |
| **Cardápio** | Handoff | `gpt-4o-mini` | - |
| **Reservas** | Handoff | `gpt-5.1-codex-mini` | Verificar unidade existe (input) + disponibilidade (tool) |

## Erros que você vai capturar

- `InputGuardrailTripwireTriggered` → Guardrail de input falhou
- `OutputGuardrailTripwireTriggered` → Guardrail de output falhou  
- `ToolGuardrailRejection` → Tool foi bloqueada por guardrail

## Instalação

```bash
npm install @openai-agents/sdk zod
# Zod v4 é obrigatório
```

Quer que eu detalhe alguma parte específica, como o fluxo de erro quando um guardrail dispara?