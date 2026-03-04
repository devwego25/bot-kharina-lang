# Análise Técnica - MCP Reservas (Bloqueios por horário/capacidade)

Data da análise: 13/02/2026

## Escopo
Verificação de como o MCP de reservas responde quando há:
- horário fora de funcionamento
- limite de capacidade/lotação
- conflito de regra entre `check_availability` e `create_reservation`

Base analisada:
- chamadas reais no endpoint MCP streamable (`tools/call`)
- código-fonte local do `reservas_api`

---

## 1) Como o bloqueio funciona hoje (na prática)

### 1.1 Horário fora de funcionamento
Quando o horário está fora da janela da loja, o MCP retorna indisponível com motivo explícito.

Exemplo real de resposta:

```json
{
  "success": true,
  "data": {
    "available": false,
    "storeId": "03dc5466-6c32-4e9e-b92f-c8b02e74bba6",
    "date": "2026-02-13",
    "time": "23:00",
    "numberOfPeople": 2,
    "message": "Horário fora do funcionamento. Loja aberta de 11:30 às 22:00",
    "storeOpen": "11:30",
    "storeClose": "22:00"
  }
}
```

Referência de código:
- `src/modules/mcp/mcp.service.ts:187`

---

### 1.2 Lotação / capacidade insuficiente
Quando a ocupação do slot não comporta o pedido, o MCP retorna indisponível com campos de capacidade.

Exemplo real de resposta:

```json
{
  "success": true,
  "data": {
    "available": false,
    "storeId": "b45c9b5e-4f79-47b1-a442-ea8fb9d6e977",
    "date": "2026-02-13",
    "time": "21:00",
    "numberOfPeople": 2,
    "message": "Capacidade insuficiente. Disponível: 0, Solicitado: 2",
    "maxCapacity": 80,
    "currentOccupancy": 80,
    "availableCapacity": 0
  }
}
```

Referências de código:
- `src/modules/mcp/mcp.service.ts:210`
- `src/modules/shared/services/operation-hours.service.ts:103`
- `src/modules/shared/services/operation-hours.service.ts:149`

---

### 1.3 Faixa min/max de pessoas
Também existe validação de faixa de pessoas por loja em `check_availability`.

Referência de código:
- `src/modules/mcp/mcp.service.ts:235`

---

## 2) Problema crítico encontrado

### 2.1 `check_availability` está com regra de “slot exclusivo”
Após validar capacidade, o serviço ainda faz uma regra extra:
- conta reservas confirmadas no mesmo horário
- define `available = existingReservation === 0`

Ou seja: se existir **qualquer** reserva confirmada naquele horário, o slot já pode voltar como indisponível, mesmo havendo capacidade.

Referência de código:
- `src/modules/mcp/mcp.service.ts:252`

Impacto:
- falsos negativos de disponibilidade
- comportamento inconsistente com o esperado para restaurante (várias mesas por horário)

---

### 2.2 Inconsistência entre `check_availability` e `create_reservation`
Hoje os dois fluxos usam critérios diferentes:

- `check_availability`: valida por **ocupação em pessoas** (soma de convidados)
- `create_reservation`: usa `maxCapacityPerSlot` por **quantidade de reservas confirmadas** para decidir `confirmed` vs `waiting`

Referência de código:
- `src/modules/mcp/mcp.service.ts:412`

Impacto:
- o “pode reservar?” e o “status final da reserva” podem divergir
- comportamento percebido como imprevisível no atendimento

---

## 3) Campos relevantes que o MCP já retorna

Quando bloqueia por capacidade, o retorno já traz dados úteis para UX:
- `message`
- `maxCapacity`
- `currentOccupancy`
- `availableCapacity`

Quando bloqueia por horário:
- `message`
- `storeOpen`
- `storeClose`

Isso é suficiente para mensagens claras ao cliente final sem alucinação.

---

## 4) Recomendação objetiva

1. Remover/ajustar a regra `existingReservation === 0` no `check_availability`.
2. Unificar regra de capacidade entre `check_availability` e `create_reservation` (mesmo critério).
3. Manter retorno estruturado com motivo de bloqueio (já está bom).
4. Opcional: diferenciar indisponibilidade por “lotado” vs “fora de horário” em códigos internos padronizados.

---

## 5) Conclusão

O MCP **já suporta bloqueio por horário e lotação com retorno bom**.
O principal ponto a corrigir é a regra adicional de indisponibilidade por existir 1 reserva no slot e a inconsistência de critério entre disponibilidade e criação.
