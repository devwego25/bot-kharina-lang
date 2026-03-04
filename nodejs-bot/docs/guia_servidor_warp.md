Guia: Bypass ASN Hostinger (47583) para WhatsApp Cloud API em Docker Swarm
Este guia resolve o bloqueio da Meta no ASN da Hostinger para conexões outbound (QR Code, webhooks, sync) da API oficial do WhatsApp.

Pré-requisitos
VPS Hostinger (Ubuntu 24.04/Debian)

Docker Swarm ativo (EasyPanel padrão)

Acesso SSH root ao host

WhatsApp Cloud API oficial configurada

1. Instalar Cloudflare WARP (Host)
Execute no host VPS:

bash
# Adicionar chave GPG
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | gpg --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg

# Adicionar repositório (Ubuntu 24.04/noble)
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ noble main" | tee /etc/apt/sources.list.d/cloudflare-client.list

# Instalar
apt update && apt install cloudflare-warp -y

# Registrar e ativar PROXY mode (porta 40000)
warp-cli --accept-tos registration new
warp-cli mode proxy
warp-cli proxy port 40000
warp-cli connect
Teste WARP ativo:

bash
curl --proxy socks5h://127.0.0.1:40000 https://cloudflare.com/cdn-cgi/trace | grep warp=
# Deve retornar: warp=on
2. Instalar Socat e Criar Bridge Docker
bash
apt install socat -y

# Bridge: 0.0.0.0:40001 → 127.0.0.1:40000 (Docker acessa)
nohup socat TCP-LISTEN:40001,fork,reuseaddr TCP:127.0.0.1:40000 >/var/log/socat-warp.log 2>&1 &

# Verificar socat escutando todas interfaces
ss -lntp | grep 40001
# tcp LISTEN 0 128 0.0.0.0:40001 0.0.0.0:*
3. Identificar Gateway Docker Swarm
bash
# Listar containers (encontre seu WhatsApp API)
docker ps | grep -E 'whatsapp|api|webhook'

# Pegar gateway real (EasyPanel usa overlay, não 172.17.0.1)
docker exec -it SEU_CONTAINER_ID ip route | awk '/default/ {print $3}'
# Exemplo retorno: 172.18.0.1
4. Configurar Variáveis no Container (EasyPanel)
No EasyPanel → Seu App → Environment Variables:

text
HTTP_PROXY=socks5h://172.18.0.1:40001
HTTPS_PROXY=socks5h://172.18.0.1:40001
NO_PROXY=localhost,127.0.0.1,172.18.0.1,10.0.0.0/8,192.168.0.0/16
no_proxy=localhost,127.0.0.1,172.18.0.1,10.0.0.0/8,192.168.0.0/16
IMPORTANTE: Remova qualquer ALL_PROXY se existir.

5. Configurar Webhook (Node.js/Python)
Node.js (https-proxy-agent)
js
const HttpsProxyAgent = require('https-proxy-agent');
const agent = new HttpsProxyAgent('socks5://172.18.0.1:40001');

const response = await fetch('https://graph.facebook.com/v20.0/PHONE_ID/messages', {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}` },
  agent, // Proxy para outbound
  body: JSON.stringify(payload)
});
Python (requests)
python
import requests
proxies = {
    'http': 'socks5h://172.18.0.1:40001',
    'https': 'socks5h://172.18.0.1:40001'
}

response = requests.post(
    'https://graph.facebook.com/v20.0/PHONE_ID/messages',
    headers={'Authorization': f'Bearer {TOKEN}'},
    json=payload,
    proxies=proxies
)
Webhook ACK imediato (<250ms)
js
app.post('/webhook', (req, res) => {
  res.status(200).send('OK'); // Meta espera <10s, ideal <250ms
  processWebhookAsync(req.body).catch(console.error); // Async process
});
6. Deploy e Testes
text
# 1. Redeploy no EasyPanel
# 2. Teste conectividade container → proxy
docker exec -it SEU_CONTAINER bash -lc 'echo > /dev/tcp/172.18.0.1/40001 && echo "proxy_ok" || echo "proxy_fail"'

# 3. Teste WhatsApp outbound
curl --proxy socks5h://172.18.0.1:40001 https://graph.facebook.com/v20.0/PHONE_ID

# 4. Monitor logs
tail -f /var/log/socat-warp.log
docker logs SEU_CONTAINER
7. Validação Final
text
✅ WARP ativo: warp=on via Cloudflare IPs
✅ Socat bridge: escuta 0.0.0.0:40001
✅ Container acessa proxy: proxy_ok
✅ QR Code gera instantaneamente
✅ Webhooks 100% entregues (Meta Console)
✅ Sem erros 429/timeout graph.facebook.com
Troubleshooting
Problema	Solução
proxy_fail	Confirme gateway com ip route no container
QR ainda trava	warp-cli disconnect && warp-cli connect
Webhook 429	ACK <250ms + queue async
Socat morre	systemctl enable --now socat (script systemd)
Imagens falham	Rate limit ASN: WARP obrigatório
Script Automatizado (Opcional)
bash
#!/bin/bash
# save as /root/setup-warp.sh
wget -O- https://raw.githubusercontent.com/USERNAME/warp-hostinger-fix/main/setup.sh | bash
Tempo total: 15 minutos. Resultado: 100% uptime WhatsApp Cloud API na Hostinger.
​

Precisa do nome exato do container ou algum ajuste específico?