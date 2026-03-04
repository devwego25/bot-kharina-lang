#!/bin/bash
# Script de Instalação e Configuração do Cloudflare WARP + Socat
# Resolve o bloqueio de ASN da Hostinger para a API do WhatsApp (Meta)
# Autor: Guilherme

set -e

echo "=========================================================="
echo "🚀 Iniciando setup do Cloudflare WARP (Bypass Hostinger)"
echo "=========================================================="

# 1. Adicionar chave GPG da Cloudflare
echo "[1/5] Adicionando chave GPG do repositório..."
curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | sudo gpg --yes --dearmor -o /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg

# 1.5. Detectar versão do OS (ex: bullseye, bookworm, jammy, noble)
OS_CODENAME=$(lsb_release -cs 2>/dev/null || cat /etc/os-release | grep VERSION_CODENAME | cut -d= -f2)
if [ -z "$OS_CODENAME" ]; then
    echo "Não foi possível detectar o codinome do OS. Assumindo 'bullseye' (Debian 11) como padrão."
    OS_CODENAME="bullseye"
fi

# 2. Adicionar repositório
echo "[2/5] Configurando repositório ($OS_CODENAME)..."
echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $OS_CODENAME main" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list

# Limpar conflitos passados
sudo apt-get remove -y cloudflare-warp || true
sudo rm -f /var/lib/apt/lists/pkg.cloudflareclient.com*

# 3. Instalar pacotes necessários (WARP e Socat)
echo "[3/5] Instalando cloudflare-warp e socat..."
sudo apt-get update && sudo apt-get install -y cloudflare-warp socat

# 4. Registrar e ATIVAR o WARP localmente
echo "[4/5] Registrando Cloudflare WARP no modo PROXY..."
warp-cli --accept-tos registration new || true
warp-cli --accept-tos mode proxy
warp-cli --accept-tos proxy port 40000
warp-cli --accept-tos connect

# Teste básico do WARP
sleep 2
echo "Teste WARP local:"
curl --proxy socks5h://127.0.0.1:40000 https://cloudflare.com/cdn-cgi/trace | grep warp=

# 5. Criar serviço systemd para o Socat
echo "[5/5] Configurando Bridge Socat (0.0.0.0:40001 -> 127.0.0.1:40000)..."

cat <<EOF | sudo tee /etc/systemd/system/socat-warp.service
[Unit]
Description=Socat Bridge para Cloudflare WARP
After=network.target cloudflare-warp.service

[Service]
Type=simple
ExecStart=/usr/bin/socat TCP-LISTEN:40001,fork,reuseaddr TCP:127.0.0.1:40000
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now socat-warp.service

echo "=========================================================="
echo "✅ Setup concluído com sucesso!"
echo "O proxy SOCKS5 está exposto para os containers na porta 40001."
echo ""
echo "Instruções finais para o Docker Compose ou Docker Stack:"
echo "Adicione as seguintes linhas no seu arquivo .env dentro da pasta backend:"
echo "   HTTP_PROXY=socks5h://host.docker.internal:40001"
echo "   HTTPS_PROXY=socks5h://host.docker.internal:40001"
echo "   NO_PROXY=localhost,127.0.0.1,host.docker.internal,10.0.0.0/8,192.168.0.0/16"
echo ""
echo "Depois disso, faça um rebuild e redeploy dos containers, por exemplo:"
echo "   docker compose up -d --build"
echo "=========================================================="
