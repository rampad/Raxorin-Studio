#!/usr/bin/env bash
# Publica Raxorin Studio Lite (app.raxorin.dev) en el servidor compartido. Se ejecuta desde tu equipo:
#   lite/deploy/desplegar.sh
# Compila (npm run lite:build), sube dist-lite/ y deploy/ a /opt/raxorin/app/src, construye la imagen en el
# servidor y reinicia. Deja la versión anterior en /opt/raxorin/app/src.anterior (vuelta atrás: ver el final).
# La primera vez también hacen falta: el registro DNS "app" en Cloudflare y el sitio en /opt/edge/conf/sitios.
set -euo pipefail

SERVIDOR="${RAXORIN_SERVIDOR:?Falta RAXORIN_SERVIDOR (usuario@host)}"
PUERTO="${RAXORIN_PUERTO:-22}"
DIR=/opt/raxorin/app

cd "$(dirname "$0")/../.."
VERSION=$(date +%Y%m%d-%H%M)
echo "== Compilando Raxorin Studio Lite ($VERSION)"
npm run lite:build >/dev/null
[ -f dist-lite/index.html ] && [ -f dist-lite/slint/slint_wasm_interpreter_bg.wasm ] || { echo 'ERROR: el build no generó la app'; exit 1; }

echo "== Revisando el servidor $SERVIDOR"
ssh -p "$PUERTO" "$SERVIDOR" "
  [ -d $DIR ] || mkdir -p $DIR
  [ -w $DIR ] || { echo 'ERROR: no se puede escribir en $DIR'; exit 1; }
  docker network inspect edge >/dev/null 2>&1 || { echo 'ERROR: falta la red edge del proxy de entrada'; exit 1; }
"

echo "== Subiendo"
COPYFILE_DISABLE=1 tar --exclude='.DS_Store' -cf - dist-lite -C lite deploy | ssh -p "$PUERTO" "$SERVIDOR" "
  set -e
  rm -rf $DIR/src.nuevo && mkdir -p $DIR/src.nuevo && tar -x -C $DIR/src.nuevo
  echo $VERSION > $DIR/src.nuevo/VERSION
  rm -rf $DIR/src.anterior
  [ -d $DIR/src ] && mv $DIR/src $DIR/src.anterior
  mv $DIR/src.nuevo $DIR/src
"

echo "== Construyendo y reiniciando"
ssh -p "$PUERTO" "$SERVIDOR" "
  set -e
  cd $DIR/src/deploy
  docker compose build -q
  docker compose up -d --remove-orphans
  docker image prune -f >/dev/null
  sleep 3
  docker compose ps
  echo '== Prueba interna'
  docker compose exec -T web wget -qS --spider http://127.0.0.1/ 2>&1 | grep -m1 'HTTP/'
  docker compose exec -T web wget -qS --spider http://127.0.0.1/slint/slint_wasm_interpreter_bg.wasm 2>&1 | grep -m1 'HTTP/'
"
echo "== Listo: $VERSION"
echo "   Vuelta atrás: ssh -p $PUERTO $SERVIDOR 'cd $DIR && rm -rf src && mv src.anterior src && cd src/deploy && docker compose up -d --build'"
