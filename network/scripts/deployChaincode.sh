#!/usr/bin/env bash
# deployChaincode.sh
#
# Empaqueta, instala, aprueba y commitea el chaincode de consentimiento
# (../chaincode) en canal-universal, con ambas clínicas como endorsers
# (política por default: MAJORITY Endorsement, que con 2 orgs exige a las
# dos). Idempotente: si ya está commiteado en esta versión/secuencia, no
# vuelve a instalar.

set -euo pipefail

NETWORK_HOME=${NETWORK_HOME:-${PWD}}
. "${NETWORK_HOME}/scripts/envVar.sh"

CC_NAME="consent"
CC_SRC_PATH="${NETWORK_HOME}/../chaincode"
# Overrideables por env para upgrade in-place (p.ej. CC_VERSION=1.1 CC_SEQUENCE=2
# ./network.sh deployCC); el flujo documentado sigue siendo redeploy fresco.
: "${CC_VERSION:=1.0}"
: "${CC_SEQUENCE:=1}"
CHANNEL_NAME="canal-universal"
DELAY=3
MAX_RETRY=5
ORGS=(sancristobal montenegro)

infoln "Vendorizando dependencias Go en ${CC_SRC_PATH}"
(cd "${CC_SRC_PATH}" && GO111MODULE=on go mod vendor)
successln "Dependencias vendorizadas"

mkdir -p "${NETWORK_HOME}/channel-artifacts"
cd "${NETWORK_HOME}/channel-artifacts"

infoln "Empaquetando ${CC_NAME}@${CC_VERSION}"
peer lifecycle chaincode package "${CC_NAME}.tar.gz" --path "${CC_SRC_PATH}" --lang golang --label "${CC_NAME}_${CC_VERSION}"
PACKAGE_ID=$(peer lifecycle chaincode calculatepackageid "${CC_NAME}.tar.gz")
successln "Empaquetado (package id: ${PACKAGE_ID})"

installChaincode() {
  local org=$1
  setGlobals "$org"
  if peer lifecycle chaincode queryinstalled --output json | jq -r 'try (.installed_chaincodes[].package_id)' | grep -qx "${PACKAGE_ID}"; then
    infoln "Ya instalado en peer0.${org}"
    return
  fi
  local rc=1 counter=1 res=1
  while [ $rc -ne 0 ] && [ $counter -lt $MAX_RETRY ]; do
    sleep $DELAY
    set +e
    peer lifecycle chaincode install "${CC_NAME}.tar.gz" >/tmp/install.log 2>&1
    res=$?
    set -e
    rc=$res
    counter=$((counter + 1))
  done
  cat /tmp/install.log
  verifyResult $res "No se pudo instalar el chaincode en peer0.${org}"
  successln "Chaincode instalado en peer0.${org}"
}

approveForOrg() {
  local org=$1
  setGlobals "$org"
  set +e
  peer lifecycle chaincode approveformyorg -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" \
    --version "${CC_VERSION}" --package-id "${PACKAGE_ID}" --sequence "${CC_SEQUENCE}" >/tmp/approve.log 2>&1
  res=$?
  set -e
  cat /tmp/approve.log
  verifyResult $res "No se pudo aprobar la definición de ${CC_NAME} para ${org}"
  successln "Definición de ${CC_NAME} aprobada por ${CORE_PEER_LOCALMSPID}"
}

for org in "${ORGS[@]}"; do
  infoln "Instalando en peer0.${org}"
  installChaincode "$org"
done

for org in "${ORGS[@]}"; do
  infoln "Aprobando para ${org}"
  approveForOrg "$org"
done

infoln "Commiteando la definición en '${CHANNEL_NAME}'"
# --peerAddresses son endpoints alcanzables desde el cliente peer (este shell,
# fuera de la red docker), por eso van por localhost:<puerto publicado> y no
# por el hostname interno peer0.<org>.example.com que usa el anchor peer.
setGlobals sancristobal
set +e
peer lifecycle chaincode commit -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "$ORDERER_CA" --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" \
  --peerAddresses localhost:7051 --tlsRootCertFiles "$PEER0_SANCRISTOBAL_CA" \
  --peerAddresses localhost:9051 --tlsRootCertFiles "$PEER0_MONTENEGRO_CA" \
  --version "${CC_VERSION}" --sequence "${CC_SEQUENCE}" >/tmp/commit.log 2>&1
res=$?
set -e
cat /tmp/commit.log
verifyResult $res "No se pudo commitear la definición de ${CC_NAME}"
successln "Chaincode '${CC_NAME}' commiteado en '${CHANNEL_NAME}'"

for org in "${ORGS[@]}"; do
  setGlobals "$org"
  peer lifecycle chaincode querycommitted --channelID "${CHANNEL_NAME}" --name "${CC_NAME}"
done
