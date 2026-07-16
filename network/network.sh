#!/usr/bin/env bash
# Red Fabric propia del proyecto: 1 orderer Raft + Clínica San Cristóbal +
# Clínica Montenegro. Uso:
#
#   ./network.sh up              levanta cryptogen + contenedores
#   ./network.sh createChannels  crea canal-universal, canal-sancristobal y
#                                 canal-montenegro (requiere 'up' previo)
#   ./network.sh down            baja todo y borra material generado
#   ./network.sh ipfsUp          levanta el nodo IPFS local (Kubo), API en :5001
#   ./network.sh ipfsDown        baja el nodo IPFS y borra su volumen
#
# Requiere el devcontainer del proyecto (peer/configtxgen/cryptogen/osnadmin
# en el PATH, Docker-in-Docker activo). Ver README para detalles.

set -euo pipefail

NETWORK_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$NETWORK_HOME"
export NETWORK_HOME
. scripts/utils.sh

: "${CONTAINER_CLI:=docker}"
if command -v "${CONTAINER_CLI}-compose" > /dev/null 2>&1; then
  : "${CONTAINER_CLI_COMPOSE:=${CONTAINER_CLI}-compose}"
else
  : "${CONTAINER_CLI_COMPOSE:=${CONTAINER_CLI} compose}"
fi
COMPOSE_FILE="compose/compose-network.yaml"
COMPOSE_IPFS_FILE="compose/compose-ipfs.yaml"

# DOCKER_SOCK: mismo mecanismo que fabric-samples/test-network para resolver
# el socket real del contexto docker activo (relevante si no es el default).
DOCKER_SOCK="${DOCKER_SOCK:-$(docker context inspect --format '{{ .Endpoints.docker.Host }}' 2>/dev/null | sed 's#unix://##')}"
: "${DOCKER_SOCK:=/var/run/docker.sock}"
export DOCKER_SOCK

generateCrypto() {
  if [ -d "organizations/peerOrganizations" ]; then
    infoln "Material criptográfico ya generado, se omite cryptogen"
    return
  fi
  which cryptogen > /dev/null || fatalln "cryptogen no está en el PATH"

  infoln "Generando material criptográfico (orderer, ClinicaSanCristobalMSP, ClinicaMontenegroMSP)"
  cryptogen generate --config=crypto-config/orderer.yaml --output="organizations"
  verifyResult $? "Fallo generando el material del orderer"
  cryptogen generate --config=crypto-config/sancristobal.yaml --output="organizations"
  verifyResult $? "Fallo generando el material de la Clínica San Cristóbal"
  cryptogen generate --config=crypto-config/montenegro.yaml --output="organizations"
  verifyResult $? "Fallo generando el material de la Clínica Montenegro"
  successln "Material criptográfico generado en network/organizations/"
}

networkUp() {
  generateCrypto
  infoln "Levantando orderer + peer0 de cada clínica"
  DOCKER_SOCK="${DOCKER_SOCK}" ${CONTAINER_CLI_COMPOSE} -f ${COMPOSE_FILE} up -d
  sleep 3
  ${CONTAINER_CLI} ps -a --filter label=service=hyperledger-fabric
}

createChannels() {
  [ -d "organizations/peerOrganizations" ] || fatalln "Correr './network.sh up' primero"

  infoln "== canal-universal (ClinicaSanCristobalMSP + ClinicaMontenegroMSP) =="
  scripts/createChannel.sh canal-universal CanalUniversal sancristobal montenegro

  infoln "== canal-sancristobal (bitácora interna, solo ClinicaSanCristobalMSP) =="
  scripts/createChannel.sh canal-sancristobal CanalSanCristobal sancristobal

  infoln "== canal-montenegro (bitácora interna, solo ClinicaMontenegroMSP) =="
  scripts/createChannel.sh canal-montenegro CanalMontenegro montenegro

  successln "Los tres canales quedaron creados y unidos"
}

deployCC() {
  [ -d "organizations/peerOrganizations" ] || fatalln "Correr './network.sh up' y './network.sh createChannels' primero"
  scripts/deployChaincode.sh
}

ipfsUp() {
  infoln "Levantando nodo IPFS (Kubo)"
  ${CONTAINER_CLI_COMPOSE} -f ${COMPOSE_IPFS_FILE} up -d
  infoln "Esperando a que la API responda en :5001"
  for i in $(seq 1 30); do
    if curl -fsS -X POST http://127.0.0.1:5001/api/v0/version > /dev/null 2>&1; then
      successln "IPFS arriba: $(curl -fsS -X POST http://127.0.0.1:5001/api/v0/version)"
      return
    fi
    sleep 1
  done
  fatalln "La API de IPFS no respondió en :5001 tras 30s"
}

ipfsDown() {
  infoln "Bajando el nodo IPFS"
  ${CONTAINER_CLI_COMPOSE} -f ${COMPOSE_IPFS_FILE} down --volumes
  successln "IPFS abajo"
}

networkDown() {
  infoln "Bajando la red y borrando material generado"
  DOCKER_SOCK="${DOCKER_SOCK}" ${CONTAINER_CLI_COMPOSE} -f ${COMPOSE_FILE} down --volumes --remove-orphans
  rm -rf organizations channel-artifacts "../chaincode/vendor"
  rm -f /tmp/osnadmin.log /tmp/join.log /tmp/anchor.log /tmp/install.log /tmp/approve.log /tmp/commit.log
  successln "Red abajo"
}

COMMAND=${1:-}
case "$COMMAND" in
  up)
    networkUp
    ;;
  createChannels)
    createChannels
    ;;
  deployCC)
    deployCC
    ;;
  down)
    networkDown
    ;;
  ipfsUp)
    ipfsUp
    ;;
  ipfsDown)
    ipfsDown
    ;;
  *)
    fatalln "Uso: ./network.sh {up|createChannels|deployCC|down|ipfsUp|ipfsDown}"
    ;;
esac
