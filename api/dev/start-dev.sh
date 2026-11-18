#!/usr/bin/env bash
# Sobe o ambiente local completo, sem tocar no GitHub nem na Cloudflare reais:
#   8788  GitHub falso (dev/github-mock.mjs) sobre o repositório git de dev em api/.dev-repo
#   8787  Worker (wrangler dev, Durable Object local em api/.wrangler/state)
#   8781  python3 -m http.server servindo api/.dev-repo (o site publicado no mock + /admin do repo real)
# Logs em api/.dev-logs/*.log e PIDs em api/.dev-logs/pids (usados pelo dev/stop-dev.sh).
#
#   dev/start-dev.sh                 # reaproveita api/.dev-repo e os usuários locais
#   dev/start-dev.sh --reset         # recria api/.dev-repo a partir do site real
#   dev/start-dev.sh --reset-state   # apaga usuários/sessões/auditoria locais (api/.wrangler/state)
set -euo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="$(cd "$API_DIR/.." && pwd)"
LOGS="$API_DIR/.dev-logs"
PIDS="$LOGS/pids"
REPO="$API_DIR/.dev-repo"

RESET=""
RESET_STATE=0
for a in "$@"; do
  case "$a" in
    --reset) RESET="--reset" ;;
    --reset-state) RESET_STATE=1 ;;
    *) echo "Opção desconhecida: $a" >&2; exit 2 ;;
  esac
done

die() { echo "Erro: $*" >&2; exit 1; }
command -v node >/dev/null || die "node não encontrado (precisa do Node >= 22.18)."
command -v git >/dev/null || die "git não encontrado."
command -v python3 >/dev/null || die "python3 não encontrado."
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
  || die "Node $(node -v) é antigo; use >= 22.18."
[ -x "$API_DIR/node_modules/.bin/wrangler" ] || die "rode 'npm install' dentro de api/ primeiro."

if [ -s "$PIDS" ]; then
  while read -r _ pid; do
    if kill -0 "$pid" 2>/dev/null; then die "o ambiente já está rodando (PID $pid). Use dev/stop-dev.sh."; fi
  done < "$PIDS"
  rm -f "$PIDS"
fi
for port in 8781 8787 8788; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then die "a porta $port já está em uso."; fi
done

mkdir -p "$LOGS"

# Variáveis locais do Worker (fora do git). Cria se faltar; completa chaves ausentes sem sobrescrever.
VARS="$API_DIR/.dev.vars"
touch "$VARS"
chmod 600 "$VARS"
add_var() { grep -q "^$1=" "$VARS" || echo "$1=$2" >> "$VARS"; }
add_var GITHUB_TOKEN dev-token
add_var GITHUB_API_BASE http://127.0.0.1:8788
add_var ALLOWED_ORIGINS http://127.0.0.1:8781,http://localhost:8781
add_var PASSWORD_PEPPER "dev-$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
add_var BOOTSTRAP_SECRET "dev-boot-$(node -e 'process.stdout.write(require("crypto").randomBytes(16).toString("hex"))')"
# libera GITHUB_API_BASE em 127.0.0.1 (o mock); em produção essa variável não existe e o Worker recusa
add_var DEV_ALLOW_LOCAL_GITHUB 1

if [ "$RESET_STATE" = 1 ]; then rm -rf "$API_DIR/.wrangler/state"; echo "Estado local do Durable Object apagado."; fi

# Repositório git de dev (cópia de index.html, assets/ e cms/schema.json do site real, só se não existir).
HG_MOCK_REPO="$REPO" HG_MOCK_SOURCE="$ROOT" node "$API_DIR/dev/github-mock.mjs" --init-only $RESET
# /admin dentro do site servido (o mock ignora: .git/info/exclude tem /admin). É a cópia de dev gerada em
# api/.dev-admin: index.html com a CSP local (o admin/index.html versionado tem só a de produção) e links
# para os demais arquivos do admin/ real.
node "$API_DIR/dev/build-admin-dev.mjs" >/dev/null || die "não consegui gerar o painel de dev (CSP)."
ln -sfn ../.dev-admin "$REPO/admin"

wait_port() {
  for _ in $(seq 1 120); do
    if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

cd "$API_DIR"
nohup env HG_MOCK_REPO="$REPO" HG_MOCK_SOURCE="$ROOT" node dev/github-mock.mjs > "$LOGS/mock.log" 2>&1 &
echo "mock $!" >> "$PIDS"
wait_port 8788 || die "o mock não subiu; veja $LOGS/mock.log"

nohup env WRANGLER_SEND_METRICS=false node_modules/.bin/wrangler dev --ip 127.0.0.1 --port 8787 \
  --persist-to "$API_DIR/.wrangler/state" > "$LOGS/wrangler.log" 2>&1 &
echo "wrangler $!" >> "$PIDS"

nohup python3 -m http.server 8781 --bind 127.0.0.1 --directory "$REPO" > "$LOGS/http.log" 2>&1 &
echo "http $!" >> "$PIDS"

abort() { echo "Erro: $*" >&2; "$API_DIR/dev/stop-dev.sh" >/dev/null 2>&1 || true; exit 1; }
wait_port 8781 || abort "o http.server não subiu; veja $LOGS/http.log"
healthy=0
for _ in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1; then healthy=1; break; fi
  if ! kill -0 "$(awk '$1=="wrangler"{print $2}' "$PIDS")" 2>/dev/null; then break; fi
  sleep 0.5
done
[ "$healthy" = 1 ] || abort "o Worker não respondeu em /health; veja $LOGS/wrangler.log (ambiente derrubado)"

cat <<MSG
Ambiente local no ar:
  site (versão publicada no mock)  http://127.0.0.1:8781/
  painel                           http://127.0.0.1:8781/admin/
  Worker                           http://127.0.0.1:8787/health
  GitHub falso                     http://127.0.0.1:8788  (repo git em api/.dev-repo)
Primeiro usuário:  HG_SENHA='...' node scripts/criar-usuario.mjs <usuario>
Logs: api/.dev-logs/   Parar: dev/stop-dev.sh
MSG
