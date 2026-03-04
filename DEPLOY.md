# 🚀 Guia de Deploy - Kharina Bot (Híbrido)

## Visão Geral

Arquitetura híbrida:
- **Python LangChain**: Serviço de IA (FastAPI + LangChain + OpenAI)
- **Node.js**: API de webhooks WhatsApp (Express)
- **Redis**: Memória compartilhada entre serviços
- **MCPs**: Cardápio (interno) e Reservas (externo via WARP)

## Pré-requisitos na VPS

```bash
# Docker e Swarm já configurados
docker --version
docker info | grep Swarm  # deve estar "active"

# WARP rodando
systemctl status warp-svc  # active (running)

# Redes externas criadas
docker network ls | grep traefik-public
docker network ls | grep cardapio_default
```

## Estrutura de Rede Docker

```
┌─────────────────────────────────────────────────────────┐
│  kharina-bot_network (overlay)                         │
│  ├─ langchain:8000                                     │
│  ├─ backend:3000                                       │
│  └─ redis:6379                                         │
├─────────────────────────────────────────────────────────┤
│  cardapio_default (external)                           │
│  └─ cardapio_app:3000 (MCP)                           │
├─────────────────────────────────────────────────────────┤
│  traefik-public (external)                             │
│  └─ Exposição externa via HTTPS                       │
└─────────────────────────────────────────────────────────┘
```

## Configuração

### 1. Arquivo .env

Crie o arquivo `.env` na raiz do projeto:

```bash
# OpenAI
OPENAI_API_KEY=sk-proj-xxxxxxxxxxxx
OPENAI_MODEL=gpt-4o-mini

# WhatsApp (Meta)
WHATSAPP_TOKEN=EAxxxxxxxxxx
WHATSAPP_PHONE_ID=55xxxxxxxxxxx
WHATSAPP_VERIFY_TOKEN=seu_token_aqui

# Database
DATABASE_URL=postgresql://user:pass@kharina-db:5432/kharina

# Redis (interno)
REDIS_URL=redis://redis:6379

# MCP - Cardapio (rede interna)
MCP_CARDAPIO_URL=http://cardapio_app:3000/mcp
MCP_CARDAPIO_TOKEN=token_aqui

# MCP - Reservas (via WARP)
MCP_RESERVAS_URL=https://mcp.reservas.wegosb.com.br/mcp
MCP_RESERVAS_TOKEN=token_aqui

# Chatwoot
CHATWOOT_URL=https://chat.kharina.com.br
CHATWOOT_TOKEN=token_aqui
CHATWOOT_ACCOUNT_ID=1
CHATWOOT_INBOX_ID=1
```

### 2. Instalação na VPS

```bash
# Clone o repositório
cd /opt
git clone https://github.com/seu-usuario/bot-kharina-lang.git
cd bot-kharina-lang

# Configure o .env
nano .env

# Deploy inicial
./deploy.sh production
```

## Deploy

### Deploy Automático

```bash
# Do seu ambiente local (com SSH configurado)
./deploy.sh production

# Ou diretamente na VPS
cd /opt/kharina-bot
./deploy.sh production
```

### Deploy Manual (para debugging)

```bash
# 1. Build das imagens
docker build -t kharina-langchain:latest ./python-langchain/
docker build -t kharina-backend:latest ./nodejs-bot/backend/

# 2. Deploy da stack
docker stack deploy -c docker-compose.swarm.yml kharina-bot

# 3. Verificar status
docker stack ps kharina-bot
docker service ls | grep kharina
```

## Verificação Pós-Deploy

```bash
# Health checks
curl http://localhost:8000/health
curl http://localhost:3000/health

# Logs
docker service logs -f kharina-bot_langchain --tail 100
docker service logs -f kharina-bot_backend --tail 100

# Teste de integração (do container backend)
docker exec -it $(docker ps -q -f name=kharina-bot_backend) \
  curl http://langchain:8000/agent/chat \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test_123","message":"Oi","context":{"phone":"5511999999999"}}'
```

## Rollback

```bash
# Rollback automático (para versão anterior)
./rollback.sh

# Rollback manual (para imagem específica)
docker service update --image kharina-langchain:v1.2.3 kharina-bot_langchain
docker service update --image kharina-backend:v1.2.3 kharina-bot_backend
```

## Monitoramento

### Logs

```bash
# Ver logs em tempo real
docker service logs -f kharina-bot_langchain
docker service logs -f kharina-bot_backend

# Logs com timestamp
docker service logs --timestamps kharina-bot_langchain --tail 200

# Logs de erro apenas
docker service logs kharina-bot_langchain 2>&1 | grep ERROR
```

### Métricas

```bash
# Uso de recursos
docker stats $(docker ps -q -f name=kharina)

# Status dos serviços
docker stack ps kharina-bot

# Inspecionar serviço
docker service inspect kharina-bot_langchain
```

## Troubleshooting

### Problema: LangChain não conecta ao Redis

```bash
# Verificar se Redis está acessível
docker exec -it $(docker ps -q -f name=kharina-bot_langchain) \
  redis-cli -h redis ping

# Restart do serviço
docker service update --force kharina-bot_langchain
```

### Problema: MCP Cardapio não responde

```bash
# Verificar conectividade
docker exec -it $(docker ps -q -f name=kharina-bot_langchain) \
  curl http://cardapio_app:3000/health

# Verificar redes
docker network inspect cardapio_default
```

### Problema: Backend não encontra LangChain

```bash
# Testar conectividade interna
docker exec -it $(docker ps -q -f name=kharina-bot_backend) \
  curl http://langchain:8000/health
```

### Problema: WARP desconectado

```bash
# Verificar status WARP
systemctl status warp-svc
warp-cli status

# Reconectar
warp-cli connect
```

## Atualização de Dependências

### Python

```bash
cd python-langchain

# Atualizar requirements.txt
pip install --upgrade langchain langchain-openai
pip freeze > requirements.txt

# Rebuild e deploy
cd ..
./deploy.sh production
```

### Node.js

```bash
cd nodejs-bot/backend

# Atualizar packages
npm update

# Rebuild
cd ../..
./deploy.sh production
```

## Backup e Restore

### Backup Redis

```bash
# Backup
docker exec -it $(docker ps -q -f name=kharina-bot_redis) \
  redis-cli BGSAVE
docker cp $(docker ps -q -f name=kharina-bot_redis):/data/dump.rdb /backup/redis-$(date +%Y%m%d).rdb
```

### Backup PostgreSQL

```bash
# Backup
docker exec kharina-db pg_dump -U postgres kharina > /backup/kharina-$(date +%Y%m%d).sql
```

## Comandos Úteis

```bash
# Escalar serviços (se necessário)
docker service scale kharina-bot_langchain=2

# Atualizar variável de ambiente
docker service update --env-add OPENAI_MODEL=gpt-4o kharina-bot_langchain

# Forçar recriação
docker service update --force kharina-bot_langchain

# Remover stack (cuidado!)
docker stack rm kharina-bot
```

## Arquitetura de Comunicação

```
┌─────────────┐     Webhook      ┌──────────────┐
│  WhatsApp   │◄────────────────►│   Node.js    │
│    Meta     │                  │   Backend    │
└─────────────┘                  └──────┬───────┘
                                        │ HTTP/JSON
                                        ▼
                               ┌────────────────┐
                               │ Python Agent   │
                               │ (LangChain)    │
                               └───────┬────────┘
                                       │
           ┌───────────────────────────┼───────────────────────────┐
           │                           │                           │
           ▼                           ▼                           ▼
   ┌──────────────┐          ┌──────────────┐          ┌──────────────┐
   │     Redis    │          │ MCP Cardápio │          │ MCP Reservas │
   │   (Memory)   │          │  (Internal)  │          │ (via WARP)   │
   └──────────────┘          └──────────────┘          └──────────────┘
```

## Suporte

Em caso de problemas:
1. Verifique os logs: `docker service logs kharina-bot_langchain`
2. Teste os health checks
3. Verifique conectividade de rede entre containers
4. Consulte o WARP status se MCP externo falhar
