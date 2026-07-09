#!/usr/bin/env bash
# Se ejecuta UNA vez al crear el devcontainer (postCreateCommand).
# Instala todo lo que Fabric necesita y deja fabric-samples listo en $HOME.
set -euo pipefail

FABRIC_VERSION="2.5.12"   # LTS. Los binarios y las imágenes Docker usan esta versión.
CA_VERSION="1.5.13"

echo "==> [1/4] Paquetes del sistema (jq, tree)"
sudo apt-get update -qq
sudo apt-get install -y -qq jq tree

echo "==> [2/4] Descarga de install-fabric.sh (script oficial de Hyperledger)"
cd "$HOME"
# Reintenta: en la creación del devcontainer la red/DNS puede no estar lista todavía
# y un proxy intermedio puede devolver un cuerpo de error con status 200 (curl -f no
# lo detecta). Se valida que el archivo descargado sea realmente un script bash.
for i in $(seq 1 10); do
    curl -fsSL https://raw.githubusercontent.com/hyperledger/fabric/main/scripts/install-fabric.sh -o install-fabric.sh || true
    if head -c 2 install-fabric.sh 2>/dev/null | grep -q '#!'; then
        break
    fi
    echo "    descarga inválida (intento $i/10), reintentando en 3s..."
    sleep 3
done
if ! head -c 2 install-fabric.sh 2>/dev/null | grep -q '#!'; then
    echo "ERROR: no se pudo descargar install-fabric.sh (contenido inesperado)"
    cat install-fabric.sh
    exit 1
fi
chmod +x install-fabric.sh

echo "==> [3/4] Binarios de Fabric (peer, orderer, configtxgen, cryptogen, osnadmin) + fabric-samples"
# 'samples' clona fabric-samples en $HOME/fabric-samples
# 'binary'  deja los binarios en $HOME/fabric-samples/bin y la config de referencia en /config
./install-fabric.sh --fabric-version "$FABRIC_VERSION" --ca-version "$CA_VERSION" samples binary

# PATH y FABRIC_CFG_PATH también en shells interactivas (además del remoteEnv del devcontainer)
if ! grep -q 'fabric-samples/bin' "$HOME/.bashrc"; then
    {
        echo 'export PATH="$PATH:$HOME/fabric-samples/bin"'
        echo 'export FABRIC_CFG_PATH="$HOME/fabric-samples/config"'
    } >> "$HOME/.bashrc"
fi

echo "==> [4/4] Imágenes Docker de Fabric (peer, orderer, ca, tools, ccenv, baseos)"
# El daemon Docker-in-Docker puede tardar unos segundos en estar listo
for i in $(seq 1 30); do
    if docker info >/dev/null 2>&1; then break; fi
    sleep 2
done
if docker info >/dev/null 2>&1; then
    ./install-fabric.sh --fabric-version "$FABRIC_VERSION" --ca-version "$CA_VERSION" docker
else
    echo "WARN: el daemon Docker no respondió; descargá las imágenes luego con:"
    echo "      ~/install-fabric.sh --fabric-version $FABRIC_VERSION --ca-version $CA_VERSION docker"
fi

echo "==> Listo. Verificación rápida:"
"$HOME/fabric-samples/bin/peer" version || true
