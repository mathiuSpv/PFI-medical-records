#!/usr/bin/env bash
# addOrg.sh <key> "<Nombre visible>"
#
# Alta de una clínica NUEVA en la red en caliente. No es un alta simulada: crea
# una organización Fabric de verdad (MSP propio, peer propio) y la incorpora a
# canal-universal con una actualización de configuración de canal firmada por
# las clínicas que ya estaban. Pasos:
#
#   1. cryptogen        -> MSP + material TLS de la clínica
#   2. configtxgen      -> definición de la org (-printOrg)
#   3. config update    -> se inyecta la org en Application.groups de
#                          canal-universal, firmado por las orgs existentes
#                          (política MAJORITY Admins). Acá pasa a ser miembro.
#   4. docker compose   -> se levanta su peer0
#   5. join + anchor    -> el peer se une a canal-universal y se publica
#   6. canal privado    -> su bitácora interna (único miembro: ella)
#   7. chaincode        -> install + approve de la definición ya commiteada,
#                          para que pueda endosar (no hace falta re-commitear:
#                          las aprobaciones son por org y la política implícita
#                          MAJORITY se recalcula sola con el nuevo miembro)
#   8. RegisterClinic   -> el alta queda registrada on-chain, auditable
#
# La baja es scripts/removeOrg.sh.

set -euo pipefail

NETWORK_HOME=${NETWORK_HOME:-${PWD}}
. "${NETWORK_HOME}/scripts/envVar.sh"
. "${NETWORK_HOME}/scripts/configUpdate.sh"

CHANNEL_NAME="canal-universal"
CC_NAME="consent"

KEY=${1:-}
NOMBRE=${2:-}

[ -n "$KEY" ] || fatalln "Uso: ./network.sh addClinic <key> \"<Nombre visible>\""

# El key termina siendo nombre de host, de contenedor, de canal y clave de un
# JSON, así que se valida duro. Además es la única parte del alta que llega
# desde afuera (el dashboard la expone por HTTP), y no queremos que nada de
# esto se pueda usar para inyectar comandos o pisar rutas.
if ! [[ "$KEY" =~ ^[a-z][a-z0-9]{2,15}$ ]]; then
  fatalln "key inválido: '${KEY}'. Debe ser minúsculas y dígitos, empezar con letra, 3-16 caracteres."
fi
case "$KEY" in
  orderer|example|generated|all) fatalln "key reservado: '${KEY}'" ;;
esac

NOMBRE=${NOMBRE:-"Clínica ${KEY}"}
if [ ${#NOMBRE} -gt 60 ] || [[ "$NOMBRE" == *$'\n'* ]]; then
  fatalln "Nombre inválido: máximo 60 caracteres, sin saltos de línea"
fi

registryRequire
[ -d "${NETWORK_HOME}/organizations/peerOrganizations" ] || fatalln "La red no está levantada; correr './network.sh up' primero"

if clinicExists "$KEY"; then
  ESTADO_PREVIO=$(clinicField "$KEY" estado)
  if [ "$ESTADO_PREVIO" = "baja" ]; then
    # Re-alta con el mismo key: su canal privado sigue creado en el orderer, así
    # que el 'osnadmin channel join' del paso 6 fallaría con 405. Se rechaza en
    # vez de dejar la red a medio armar.
    fatalln "La clínica '${KEY}' ya existió y fue dada de baja; su canal privado sigue creado en el orderer. El prototipo no soporta re-alta con el mismo key: usar otro."
  fi
  fatalln "Ya existe una clínica con key '${KEY}' (estado: ${ESTADO_PREVIO}). Elegir otro key."
fi

# --- Identificadores derivados -----------------------------------------------
PASCAL="$(tr '[:lower:]' '[:upper:]' <<< "${KEY:0:1}")${KEY:1}"
MSPID="Clinica${PASCAL}MSP"
DOMAIN="${KEY}.example.com"
PRIVATE_CHANNEL="canal-${KEY}"
CHANNEL_PROFILE="Canal${PASCAL}"

read -r PEER_PORT CC_PORT OPS_PORT <<< "$(nextPorts)"

GEN_CRYPTO="${NETWORK_HOME}/crypto-config/generated"
GEN_CONFIGTX="${NETWORK_HOME}/configtx/generated/${KEY}"
GEN_COMPOSE="${NETWORK_HOME}/compose/generated"
COMPOSE_FILE="${GEN_COMPOSE}/compose-${KEY}.yaml"
mkdir -p "${GEN_CRYPTO}" "${GEN_CONFIGTX}" "${GEN_COMPOSE}" "${NETWORK_HOME}/channel-artifacts"

infoln "== Alta de '${NOMBRE}' (${MSPID}) =="
infoln "   dominio ${DOMAIN} · peer :${PEER_PORT} · chaincode :${CC_PORT} · operations :${OPS_PORT}"

render() {
  sed -e "s|__KEY__|${KEY}|g" \
      -e "s|__ORG_NAME__|${PASCAL}|g" \
      -e "s|__MSPID__|${MSPID}|g" \
      -e "s|__DOMAIN__|${DOMAIN}|g" \
      -e "s|__PEER_PORT__|${PEER_PORT}|g" \
      -e "s|__CC_PORT__|${CC_PORT}|g" \
      -e "s|__OPS_PORT__|${OPS_PORT}|g" \
      -e "s|__CHANNEL_PROFILE__|${CHANNEL_PROFILE}|g" \
      -e "s|__NETWORK_HOME__|${NETWORK_HOME}|g" \
      "$1" > "$2"
}

# --- 1) Material criptográfico ------------------------------------------------
infoln "[1/8] Generando material criptográfico"
render "${NETWORK_HOME}/crypto-config/clinic.template.yaml" "${GEN_CRYPTO}/${KEY}.yaml"
cryptogen generate --config="${GEN_CRYPTO}/${KEY}.yaml" --output="${NETWORK_HOME}/organizations"
successln "MSP y TLS generados en organizations/peerOrganizations/${DOMAIN}"

# --- 2) Definición de la organización ----------------------------------------
infoln "[2/8] Generando la definición de la organización"
render "${NETWORK_HOME}/configtx/clinic.template.yaml" "${GEN_CONFIGTX}/configtx.yaml"
ORG_DEF="${NETWORK_HOME}/channel-artifacts/${KEY}-org.json"
FABRIC_CFG_PATH="${GEN_CONFIGTX}" configtxgen -printOrg "${MSPID}" > "${ORG_DEF}"
successln "Definición escrita en channel-artifacts/${KEY}-org.json"

# --- 3) Alta de la membresía en canal-universal -------------------------------
infoln "[3/8] Incorporando ${MSPID} a '${CHANNEL_NAME}' (config update firmado por las orgs existentes)"
READER=$(clinicKeys activa | head -1)
ORG_JSON=$(cat "${ORG_DEF}")
modifyChannelConfig "${CHANNEL_NAME}" "${READER}" \
  ".channel_group.groups.Application.groups += {\"${MSPID}\": ${ORG_JSON}}" \
  "add_${KEY}"

# A partir de acá ya es miembro: se registra antes de levantar el peer para que
# el registro no quede desincronizado si algo falla más adelante (el estado real
# es el del canal, y en el canal ya está).
registryAdd "${KEY}" "${NOMBRE}" "${MSPID}" "${DOMAIN}" \
  "${PEER_PORT}" "${CC_PORT}" "${OPS_PORT}" \
  "${PRIVATE_CHANNEL}" "${CHANNEL_PROFILE}" "${GEN_CONFIGTX}" "${COMPOSE_FILE}"

# --- 4) Peer ------------------------------------------------------------------
infoln "[4/8] Levantando peer0.${DOMAIN}"
render "${NETWORK_HOME}/compose/compose-clinic.template.yaml" "${COMPOSE_FILE}"

: "${CONTAINER_CLI:=docker}"
if command -v "${CONTAINER_CLI}-compose" > /dev/null 2>&1; then
  : "${CONTAINER_CLI_COMPOSE:=${CONTAINER_CLI}-compose}"
else
  : "${CONTAINER_CLI_COMPOSE:=${CONTAINER_CLI} compose}"
fi
DOCKER_SOCK="${DOCKER_SOCK:-$(docker context inspect --format '{{ .Endpoints.docker.Host }}' 2>/dev/null | sed 's#unix://##')}"
: "${DOCKER_SOCK:=/var/run/docker.sock}"
export DOCKER_SOCK

DOCKER_SOCK="${DOCKER_SOCK}" ${CONTAINER_CLI_COMPOSE} -f "${COMPOSE_FILE}" up -d

infoln "   esperando a que el peer responda en :${OPS_PORT}/healthz"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${OPS_PORT}/healthz" > /dev/null 2>&1; then
    successln "peer0.${DOMAIN} arriba"
    break
  fi
  [ "$i" -lt 30 ] || fatalln "El peer no respondió en :${OPS_PORT} tras 30s"
  sleep 1
done

# --- 5) Join + anchor peer ----------------------------------------------------
infoln "[5/8] Uniendo el peer a '${CHANNEL_NAME}'"
setGlobals "${KEY}"
BLOCKFILE="${NETWORK_HOME}/channel-artifacts/${CHANNEL_NAME}_for_${KEY}.block"
peer channel fetch 0 "${BLOCKFILE}" -o localhost:7050 \
  --ordererTLSHostnameOverride orderer.example.com -c "${CHANNEL_NAME}" --tls --cafile "$ORDERER_CA"

rc=1; counter=1
while [ $rc -ne 0 ] && [ $counter -lt 6 ]; do
  sleep 3
  set +e
  peer channel join -b "${BLOCKFILE}" >/tmp/join.log 2>&1
  rc=$?
  set -e
  counter=$((counter + 1))
done
cat /tmp/join.log
verifyResult $rc "peer0.${DOMAIN} no pudo unirse a '${CHANNEL_NAME}'"
successln "peer0.${DOMAIN} unido a '${CHANNEL_NAME}'"

setAnchorPeerFor "${KEY}" "${CHANNEL_NAME}"

# --- 6) Canal privado ---------------------------------------------------------
infoln "[6/8] Creando el canal privado '${PRIVATE_CHANNEL}'"
CONFIGTX_DIR="${GEN_CONFIGTX}" "${NETWORK_HOME}/scripts/createChannel.sh" "${PRIVATE_CHANNEL}" "${CHANNEL_PROFILE}" "${KEY}"

# --- 7) Chaincode -------------------------------------------------------------
infoln "[7/8] Habilitando a ${MSPID} como endorser del chaincode"
setGlobals "${READER}"
COMMITTED=$(peer lifecycle chaincode querycommitted --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" --output json 2>/dev/null || echo '')

if [ -z "${COMMITTED}" ]; then
  infoln "   el chaincode '${CC_NAME}' todavía no está commiteado; se omite (correr './network.sh deployCC')"
else
  CC_VERSION=$(echo "${COMMITTED}" | jq -r '.version')
  CC_SEQUENCE=$(echo "${COMMITTED}" | jq -r '.sequence')
  CC_PKG="${NETWORK_HOME}/channel-artifacts/${CC_NAME}.tar.gz"

  if [ ! -f "${CC_PKG}" ]; then
    infoln "   re-empaquetando el chaincode (no estaba el .tar.gz de deployCC)"
    (cd "${NETWORK_HOME}/../chaincode" && GO111MODULE=on go mod vendor)
    peer lifecycle chaincode package "${CC_PKG}" --path "${NETWORK_HOME}/../chaincode" --lang golang --label "${CC_NAME}_${CC_VERSION}"
  fi
  PACKAGE_ID=$(peer lifecycle chaincode calculatepackageid "${CC_PKG}")

  setGlobals "${KEY}"
  infoln "   instalando ${CC_NAME}@${CC_VERSION} en peer0.${DOMAIN}"
  set +e
  peer lifecycle chaincode install "${CC_PKG}" >/tmp/install.log 2>&1
  ires=$?
  set -e
  cat /tmp/install.log
  verifyResult $ires "No se pudo instalar el chaincode en peer0.${DOMAIN}"

  infoln "   aprobando la definición ya commiteada (secuencia ${CC_SEQUENCE})"
  set +e
  peer lifecycle chaincode approveformyorg -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" --channelID "${CHANNEL_NAME}" --name "${CC_NAME}" \
    --version "${CC_VERSION}" --package-id "${PACKAGE_ID}" --sequence "${CC_SEQUENCE}" >/tmp/approve.log 2>&1
  ares=$?
  set -e
  cat /tmp/approve.log
  verifyResult $ares "No se pudo aprobar la definición de ${CC_NAME} para ${MSPID}"
  successln "${MSPID} puede endosar '${CC_NAME}'"

  # --- 8) Registro on-chain ---------------------------------------------------
  infoln "[8/8] Registrando la clínica en el ledger (RegisterClinic)"
  PAYLOAD=$(jq -nc --arg mspId "${MSPID}" --arg nombre "${NOMBRE}" --arg domain "${DOMAIN}" \
    --arg endpoint "peer0.${DOMAIN}:${PEER_PORT}" \
    '{function:"RegisterClinic", Args:[$mspId, $nombre, $domain, $endpoint]}')

  setGlobals "${READER}"
  # shellcheck disable=SC2046
  set +e
  peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    --tls --cafile "$ORDERER_CA" -C "${CHANNEL_NAME}" -n "${CC_NAME}" \
    $(peerAddressArgs) -c "${PAYLOAD}" >/tmp/register.log 2>&1
  rres=$?
  set -e
  cat /tmp/register.log
  if [ $rres -ne 0 ]; then
    errorln "El alta on-chain (RegisterClinic) falló; la clínica ES miembro del canal igual."
    errorln "Reintentar a mano o revisar que el chaincode tenga la función (versión ≥ 1.1)."
  else
    successln "Clínica registrada on-chain"
  fi
fi

successln "== '${NOMBRE}' dada de alta =="
infoln "   MSP: ${MSPID} · peer: localhost:${PEER_PORT} · canal privado: ${PRIVATE_CHANNEL}"
infoln "   La capa de aplicación la toma sola (lee organizations/clinics.json)."
