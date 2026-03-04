# Guia de Implantação — Kharina Chatbot 🚀

Este guia detalha os passos para configurar o domínio público e a subida de novas versões do backend na VPS.

---

## 1. Configuração de DNS (Ação do TI)

Para que o bot seja acessível externamente via domínio em vez de IP direto, o TI deve criar o seguinte registro:

| Campo | Valor |
| :--- | :--- |
| **Tipo** | `A` |
| **Host/Subdomínio** | `chatbot.kharina.com.br` |
| **Apontamento (IP)** | `72.60.137.167` |

---

## 2. Configuração de Proxy Reverso (Traefik)

A VPS utiliza o Traefik para gerenciar domínios e SSL. Para ativar o HTTPS no novo domínio, o arquivo `docker-compose.yml` do backend deve conter as seguintes labels:

```yaml
services:
  backend:
    # ... outras configs ...
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.kharina-bot.rule=Host(`chatbot.kharina.com.br`)"
      - "traefik.http.routers.kharina-bot.entrypoints=websecure"
      - "traefik.http.routers.kharina-bot.tls.certresolver=letsencrypt"
      - "traefik.http.services.kharina-bot.loadbalancer.server.port=3000"
```

---

## 3. Segurança (API Key)

Todas as rotas de gerenciamento (`/api/config`, `/api/prompt`, `/api/whatsapp/send`) exigem autenticação.

1. No arquivo `.env` da VPS, configure uma chave forte:
   ```bash
   ADMIN_API_KEY=sua_chave_secreta_gerada
   ```
2. Ao fazer requisições, envie o header:
   `x-api-key: sua_chave_secreta_gerada`

---

## 4. Passo a Passo de Atualização

Sempre que houver mudanças no código (como as feitas hoje):

1. **Local**: 
   ```bash
   git add .
   git commit -m "descrição"
   git push origin main
   ```
2. **VPS (via SSH)**:
   ```bash
   cd /root/kharina-bot  # ou o diretório do projeto
   git pull
   docker compose up -d --build
   ```

---

## 5. Endereços Úteis (Pós-DNS)

| Recurso | URL |
| :--- | :--- |
| **Webhook WhatsApp** | `https://chatbot.kharina.com.br/webhook/whatsapp` |
| **Admin API Config** | `https://chatbot.kharina.com.br/api/config` |
| **Admin API Prompt** | `https://chatbot.kharina.com.br/api/prompt` |
| **Validação da Key** | `https://chatbot.kharina.com.br/api/admin/validate` |
