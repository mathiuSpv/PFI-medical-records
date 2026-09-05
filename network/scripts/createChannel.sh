#!/usr/bin/env bash
# createChannel.sh <channel_name> <profile_name> <org1> [org2 ...]
#
# Genera el bloque de génesis del canal con el perfil dado, lo une al orderer
# (channel participation API, sin canal de sistema) y hace join + anchor peer
# para cada org listada. Reusado para los tres canales de la red (network.sh).

set -euo pipefail

NETWORK_HOME=${NETWORK_HOME:-${PWD}}
. "${NETWORK_HOME}/scripts/envVar.sh"
. "${NETWORK_HOME}/scripts/configUpdate.sh"

CHANNEL_NAME=$1
PROFILE=$2
shift 2
MEMBER_ORGS=("$@")

DELAY=3
MAX_RETRY=5

mkdir -p "${NETWORK_HOME}/channel-artifacts"
BLOCKFILE="${NETWORK_HOME}/channel-artifacts/${CHANNEL_NAME}.block"

# CONFIGTX_DIR permite crear un canal cuyo perfil no está en el configtx.yaml
# principal: el canal privado de una clínica dada de alta en caliente vive en
# configtx/generated/<key>/ (ver scripts/addOrg.sh).
CONFIGTX_DIR=${CONFIGTX_DIR:-${NETWORK_HOME}/configtx}

infoln "Generando bloque de génesis de '${CHANNEL_NAME}' (perfil ${PROFILE})"
FABRIC_CFG_PATH=${CONFIGTX_DIR} configtxgen -profile "${PROFILE}" -outputBlock "${BLOCKFILE}" -channelID "${CHANNEL_NAME}"

# Une UN nodo de ordenamiento al canal. Se llama una vez por nodo: el canal
# necesita a los tres para que el quórum Raft exista; con uno solo unido la
# tolerancia a fallos sería aparente.
joinOrderer() {
  local node=$1 adminPort=$2
  local rc=1 counter=1 res=1
  while [ $rc -ne 0 ] && [ $counter -lt $MAX_RETRY ]; do
    sleep $DELAY
    set +e
    osnadmin channel join --channelID "${CHANNEL_NAME}" --config-block "${BLOCKFILE}" \
      -o "localhost:${adminPort}" --ca-file "$ORDERER_CA" \
      --client-cert "$(ordererAdminCert "$node")" --client-key "$(ordererAdminKey "$node")" >/tmp/osnadmin.log 2>&1
    res=$?
    set -e
    # Un nodo ya unido devuelve error pero el estado es el buscado: el canal
    # existe en ese nodo. Se trata como éxito para que el script sea reentrante.
    if grep -qi 'already exists' /tmp/osnadmin.log; then
      infoln "${node} ya estaba unido a '${CHANNEL_NAME}'"
      return 0
    fi
    rc=$res
    counter=$((counter + 1))
  done
  cat /tmp/osnadmin.log
  verifyResult $res "${node} no pudo unirse al canal '${CHANNEL_NAME}'"
}

joinAllOrderers() {
  local node port
  for entry in ${ORDERER_NODES}; do
    node=${entry%%:*}
    port=${entry##*:}
    infoln "Uniendo ${node} al canal '${CHANNEL_NAME}'"
    joinOrderer "$node" "$port"
  done
}

joinPeer() {
  local org=$1
  setGlobals "$org"
  local rc=1 counter=1 res=1
  while [ $rc -ne 0 ] && [ $counter -lt $MAX_RETRY ]; do
    sleep $DELAY
    set +e
    peer channel join -b "${BLOCKFILE}" >/tmp/join.log 2>&1
    res=$?
    set -e
    rc=$res
    counter=$((counter + 1))
  done
  cat /tmp/join.log
  verifyResult $res "peer0.${org} no pudo unirse al canal '${CHANNEL_NAME}'"
}

infoln "Uniendo el servicio de ordenamiento al canal '${CHANNEL_NAME}'"
joinAllOrderers

for org in "${MEMBER_ORGS[@]}"; do
  infoln "Uniendo peer0.${org} al canal '${CHANNEL_NAME}'"
  joinPeer "$org"
done

for org in "${MEMBER_ORGS[@]}"; do
  setAnchorPeerFor "$org" "${CHANNEL_NAME}"
done

successln "Canal '${CHANNEL_NAME}' listo (miembros: ${MEMBER_ORGS[*]})"
