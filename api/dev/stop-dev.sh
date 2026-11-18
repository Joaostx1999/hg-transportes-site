#!/usr/bin/env bash
# Para o que o dev/start-dev.sh subiu (só os PIDs registrados em api/.dev-logs/pids e os filhos deles;
# nunca mata processo de outra sessão) e confere que as portas 8781, 8787 e 8788 ficaram livres.
set -uo pipefail

API_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDS="$API_DIR/.dev-logs/pids"

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

if [ -s "$PIDS" ]; then
  while read -r name pid; do
    if kill -0 "$pid" 2>/dev/null; then
      kill_tree "$pid"
      echo "parado: $name ($pid)"
    fi
  done < "$PIDS"
  for _ in $(seq 1 20); do
    alive=0
    while read -r _ pid; do kill -0 "$pid" 2>/dev/null && alive=1; done < "$PIDS"
    [ "$alive" = 0 ] && break
    sleep 0.5
  done
  while read -r _ pid; do kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null; done < "$PIDS"
  rm -f "$PIDS"
else
  echo "Nenhum PID registrado em $PIDS."
fi

busy=0
for port in 8781 8787 8788; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "AVISO: a porta $port continua em uso:"; lsof -nP -iTCP:"$port" -sTCP:LISTEN; busy=1
  fi
done
[ "$busy" = 0 ] && echo "Portas 8781, 8787 e 8788 livres."
exit "$busy"
