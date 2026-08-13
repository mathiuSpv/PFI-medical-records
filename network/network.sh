#!/usr/bin/env bash
# Red Fabric propia del proyecto: 1 orderer Raft + Clínica Genérica 1 +
# Clínica Genérica 2. Uso:
#
#   ./network.sh up              levanta cryptogen + contenedores
#   ./network.sh createChannels  crea canal-universal, canal-generica-1 y
#                                 canal-generica-2 (requiere 'up' previo)
#   ./network.sh deployCC        despliega el chaincode de consentimiento
#   ./network.sh down            baja todo y borra material generado
#   ./network.sh ipfsUp          levanta el nodo IPFS local (Kubo), API en :5001
#   ./network.sh ipfsDown        baja el nodo IPFS y borra su volumen
#   ./network.sh clinics         lista las clínicas de la red y su estado
#   ./network.sh addClinic <key> "<Nombre>"   alta de una clínica nueva
#   ./network.sh removeClinic <key> ["<motivo>"]  baja de una clínica
#
# Requiere el devcontainer del proyecto (peer/configtxgen/cryptogen/osnadmin
# en el PATH, Docker-in-Docker activo). Ver README para detalles.

set -euo pipefail

NETWORK_HOME="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$NETWORK_HOME"
export NETWORK_HOME
. scripts/utils.sh
. scripts/orgRegistry.sh

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

  infoln "Generando material criptográfico (orderer, ClinicaGenerica1MSP, ClinicaGenerica2MSP)"
  cryptogen generate --config=crypto-config/orderer.yaml --output="organizations"
  verifyResult $? "Fallo generando el material del orderer"
  cryptogen generate --config=crypto-config/generica1.yaml --output="organizations"
  verifyResult $? "Fallo generando el material de la Clínica Genérica 1"
  cryptogen generate --config=crypto-config/generica2.yaml --output="organizations"
  verifyResult $? "Fallo generando el material de la Clínica Genérica 2"
  successln "Material criptográfico generado en network/organizations/"
}

# La clave con la que la capa de aplicación deriva la referencia opaca del
# paciente (HMAC-SHA256) antes de mandarla al ledger. Es secreta y compartida
# por los miembros de la red: sin ella el valor que queda on-chain no se puede
# invertir por fuerza bruta. Nunca entra al chaincode — ver
# application/src/patient.js.
generatePatientKey() {
  local key_file="organizations/patient-index.key"
  if [ -f "${key_file}" ]; then
    infoln "Clave de índice de pacientes ya generada"
    return
  fi
  mkdir -p organizations
  # od en vez de openssl: es coreutils, está siempre.
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "${key_file}"
  chmod 600 "${key_file}"
  successln "Clave de índice de pacientes generada en ${key_file}"
}

networkUp() {
  generateCrypto
  # El registro de clínicas nace acá con las dos fundadoras; a partir de este
  # punto es la fuente de verdad de qué orgs existen (lo leen envVar.sh, los
  # scripts de alta/baja y la capa de aplicación).
  registryInit
  generatePatientKey
  infoln "Levantando orderer + peer0 de cada clínica"
  DOCKER_SOCK="${DOCKER_SOCK}" ${CONTAINER_CLI_COMPOSE} -f ${COMPOSE_FILE} up -d
  sleep 3
  ${CONTAINER_CLI} ps -a --filter label=service=hyperledger-fabric
}

addClinic() {
  [ -d "organizations/peerOrganizations" ] || fatalln "Correr './network.sh up' primero"
  scripts/addOrg.sh "$@"
}

removeClinic() {
  [ -d "organizations/peerOrganizations" ] || fatalln "Correr './network.sh up' primero"
  scripts/removeOrg.sh "$@"
}

listClinics() {
  registryRequire
  printf '%-14s %-28s %-28s %-7s %-8s %s\n' KEY NOMBRE MSPID PEER ESTADO CONTENEDOR
  while read -r row; do
    key=$(echo "$row" | jq -r .key)
    nombre=$(echo "$row" | jq -r .nombre)
    mspid=$(echo "$row" | jq -r .mspId)
    port=$(echo "$row" | jq -r .peerPort)
    estado=$(echo "$row" | jq -r .estado)
    domain=$(echo "$row" | jq -r .domain)
    if ${CONTAINER_CLI} ps --format '{{.Names}}' | grep -qx "peer0.${domain}"; then
      cont="up"
    else
      cont="-"
    fi
    printf '%-14s %-28s %-28s %-7s %-8s %s\n' "$key" "$nombre" "$mspid" "$port" "$estado" "$cont"
  done < <(jq -c '.clinics[]' "$(registryFile)")
}

createChannels() {
  [ -d "organizations/peerOrganizations" ] || fatalln "Correr './network.sh up' primero"

  infoln "== canal-universal (ClinicaGenerica1MSP + ClinicaGenerica2MSP) =="
  scripts/createChannel.sh canal-universal CanalUniversal generica1 generica2

  infoln "== canal-generica-1 (bitácora interna, solo ClinicaGenerica1MSP) =="
  scripts/createChannel.sh canal-generica-1 CanalGenerica1 generica1

  infoln "== canal-generica-2 (bitácora interna, solo ClinicaGenerica2MSP) =="
  scripts/createChannel.sh canal-generica-2 CanalGenerica2 generica2

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

  # Primero las clínicas dadas de alta en caliente (compose propio cada una),
  # después la red base: si se hace al revés, el `down` de la red borra la red
  # docker que los peers de las clínicas todavía usan.
  if [ -f "$(registryFile)" ]; then
    while read -r cf; do
      [ -n "$cf" ] && [ -f "$cf" ] || continue
      infoln "Bajando ${cf}"
      DOCKER_SOCK="${DOCKER_SOCK}" ${CONTAINER_CLI_COMPOSE} -f "$cf" down --volumes --remove-orphans || true
    done < <(composeFilesTodos)
  fi

  DOCKER_SOCK="${DOCKER_SOCK}" ${CONTAINER_CLI_COMPOSE} -f ${COMPOSE_FILE} down --volumes --remove-orphans
  rm -rf organizations channel-artifacts "../chaincode/vendor"
  rm -rf compose/generated configtx/generated crypto-config/generated
  rm -f /tmp/osnadmin.log /tmp/join.log /tmp/anchor.log /tmp/install.log /tmp/approve.log /tmp/commit.log \
        /tmp/signconfigtx.log /tmp/configupdate.log /tmp/register.log /tmp/revoke.log /tmp/deactivate.log
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
  clinics)
    listClinics
    ;;
  addClinic)
    shift
    addClinic "$@"
    ;;
  removeClinic)
    shift
    removeClinic "$@"
    ;;
  *)
    fatalln "Uso: ./network.sh {up|createChannels|deployCC|down|ipfsUp|ipfsDown|clinics|addClinic|removeClinic}"
    ;;
esac
