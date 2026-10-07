#!/bin/bash
# Ubuntu 22.04/24.04.
# Uso: sudo bash setup-vps.sh https://robo.seudominio.com SEU-TIME.cloudflareaccess.com AUD_DO_APP_ACCESS
# Sem os 3 parâmetros o script NÃO instala: o app não tem login próprio e jamais deve ficar público sem Access.
set -euo pipefail
ORIGIN="${1:?informe a URL pública, ex.: https://robo.seudominio.com}"
TEAM="${2:?informe o domínio do seu time Zero Trust, ex.: meutime.cloudflareaccess.com}"
AUD="${3:?informe o Application Audience (AUD) do app no Cloudflare Access}"
REPO="https://github.com/corretoresdabahiacom-create/Binary.git"

apt-get update && apt-get install -y curl git ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
id deriv &>/dev/null || useradd --system --create-home --shell /usr/sbin/nologin deriv
[ -d /opt/deriv ] || git clone "$REPO" /opt/deriv
cd /opt/deriv && git pull && npm ci --omit=dev
mkdir -p /opt/deriv/data && chown -R deriv:deriv /opt/deriv

cat > /etc/systemd/system/deriv.service <<UNIT
[Unit]
Description=Deriv Signal Desk
After=network-online.target
[Service]
User=deriv
WorkingDirectory=/opt/deriv
Environment=PORT=3000
Environment=ALLOWED_ORIGIN=${ORIGIN}
Environment=CF_ACCESS_TEAM_DOMAIN=${TEAM}
Environment=CF_ACCESS_AUD=${AUD}
ExecStart=/usr/bin/node server/index.js
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now deriv

# cloudflared (túnel de saída: nenhuma porta precisa ser aberta no servidor)
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list
apt-get update && apt-get install -y cloudflared
echo
echo "App rodando em 127.0.0.1:3000. Agora conecte o túnel:"
echo "  sudo cloudflared service install <TOKEN_DO_TUNEL>"
