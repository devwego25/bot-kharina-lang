# 🤖 Kharina Bot - Arquitetura Híbrida

Bot de atendimento WhatsApp para o restaurante Kharina usando **Node.js + Python LangChain**.

## 🏗️ Arquitetura

```
WhatsApp API
     │
     ▼
┌─────────────────┐
│  Node.js (I/O)  │── Webhooks, Menus, Estado UI
│   Porta 3000    │
└────────┬────────┘
         │ HTTP/JSON
         ▼
┌─────────────────┐
│ Python LangChain│── NLP, Agent, Tools MCP
│   Porta 8000    │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
Redis     MCPs (Reservas/Cardápio)
```

## 📁 Estrutura

```
kharina-bot/
├── nodejs-bot/backend/      # API Node.js (webhooks)
├── python-langchain/        # Serviço Python (IA)
├── docker-compose.swarm.yml # Orquestração
└── deploy.sh                # Script de deploy
```

## 🚀 Deploy na VPS

```bash
# SSH na VPS
ssh root@72.60.137.167

# O bot está em /root/kharina-bot/
cd ~/kharina-bot

# Backup do atual (precaução)
cp -r ~/kharina-bot ~/kharina-bot-backup-$(date +%Y%m%d)

# Clone nova versão
mv ~/kharina-bot ~/kharina-bot-old
git clone https://github.com/devwego25/bot-kharina-lang.git ~/kharina-bot

# Configure variáveis
cd ~/kharina-bot
cp ~/kharina-bot-old/backend/.env ./nodejs-bot/backend/.env 2>/dev/null || nano .env

# Deploy
./deploy.sh production
```

## 🔧 Configuração

Crie o arquivo `.env` na raiz:

```bash
# OpenAI
OPENAI_API_KEY=sk-...

# MCP
MCP_CARDAPIO_TOKEN=...
MCP_RESERVAS_TOKEN=...

# WhatsApp
WHATSAPP_TOKEN=EA...
WHATSAPP_PHONE_ID=...

# Database
DATABASE_URL=postgresql://...

# Chatwoot
CHATWOOT_URL=...
CHATWOOT_TOKEN=...
```

## 📝 Comandos Úteis

```bash
# Ver logs
docker service logs -f kharina-bot_langchain
docker service logs -f kharina-bot_backend

# Health check
curl http://localhost:8000/health
curl http://localhost:3000/health

# Restart serviço
docker service update --force kharina-bot_langchain
```

## 📚 Documentação

- [DEPLOY.md](DEPLOY.md) - Guia completo de deploy
- [IMPLEMENTATION_SUMMARY.md](IMPLEMENTATION_SUMMARY.md) - Resumo da arquitetura

---
**GG.AI Labs | 2026**
