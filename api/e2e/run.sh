#!/usr/bin/env bash
# E2E do painel no navegador (Chromium via playwright-core) contra o ambiente local completo.
# Sobe tudo do zero (dev/start-dev.sh --reset --reset-state), cria o admin local, roda e SEMPRE derruba.
#
#   npm run e2e
#   HG_E2E_ONLY=1,3 npm run e2e    # só alguns cenários (diagnóstico; a verificação oficial roda todos)
#
# playwright-core: usa HG_PLAYWRIGHT_CORE (pasta do pacote), ou o instalado em node_modules, ou procura uma
# cópia já existente na máquina. O Chromium vem do cache do Playwright (~/Library/Caches/ms-playwright);
# se faltar: npx playwright-core install chromium-headless-shell.
# Atenção: --reset-state apaga os usuários locais; ao fim fica o admin local abaixo (HG_E2E_USER/HG_E2E_PASS).
set -uo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$API_DIR"

export HG_E2E_USER="${HG_E2E_USER:-hgadmin}"
export HG_E2E_PASS="${HG_E2E_PASS:-Cegonha-Local-2026}"

PIDS="$API_DIR/.dev-logs/pids"
if [ -s "$PIDS" ]; then
  while read -r _ pid; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "Erro: o ambiente local já está rodando (PID $pid). Pare com dev/stop-dev.sh antes do E2E." >&2
      exit 2
    fi
  done < "$PIDS"
fi

if [ -z "${HG_PLAYWRIGHT_CORE:-}" ] && ! node -e 'require.resolve("playwright-core")' >/dev/null 2>&1; then
  HG_PLAYWRIGHT_CORE="$(find "$HOME" -maxdepth 6 -path '*node_modules/playwright-core' -type d \
    -not -path '*/Library/*' 2>/dev/null | head -1)"
  export HG_PLAYWRIGHT_CORE
fi

trap '"$API_DIR/dev/stop-dev.sh"' EXIT
trap 'exit 130' INT TERM

"$API_DIR/dev/start-dev.sh" --reset --reset-state || exit 1
HG_SENHA="$HG_E2E_PASS" node scripts/criar-usuario.mjs "$HG_E2E_USER" || exit 1

node e2e/painel.e2e.mjs
