#!/usr/bin/env bash
# removeOrg.sh <key> ["<motivo>"]
#
# Baja de una clínica: la saca de la membresía de canal-universal con una
# actualización de configuración firmada por las demás, y apaga su peer.
#
#   1. RevokeConsent  -> se revocan los consentimientos vigentes OTORGADOS a la
#                        clínica que se va (cada uno lo revoca su otorgante, que
#                        es el único que puede). Si no, quedarían vigentes para
#                        una org que ya no está.
#   2. DeactivateClinic -> la baja queda asentada on-chain, con quién la ejecutó
#                        y el motivo. Auditable e inmutable.
#   3. config update  -> se borra la org de Application.groups. Desde acá su
#                        peer ya no puede leer ni endosar en el canal.
#   4. docker compose down -> se apaga su peer y se borra su volumen (con él se
#                        va su copia local del ledger y su canal privado).
#
# Lo que NO se borra: los activos que emitió y la auditoría de accesos que
# generó siguen en el ledger. Es a propósito — el punto de la tesis es que el
# rastro sea inmutable, y una institución que se va no puede borrar su historia.
#
# Sobre las firmas: la política del grupo Application es MAJORITY Admins. Si con
# las orgs restantes alcanza la mayoría, la baja se firma SIN la clínica que se
# va (expulsión decidida por las demás). Si no alcanza — el caso de 2 orgs,
# donde la mayoría son las 2 —, también firma ella: es una salida voluntaria.

set -euo pipefail

NETWORK_HOME=${NETWORK_HOME:-${PWD}}
. "${NETWORK_HOME}/scripts/envVar.sh"
. "${NETWORK_HOME}/scripts/configUpdate.sh"

CHANNEL_NAME="canal-universal"
CC_NAME="consent"

KEY=${1:-}
MOTIVO=${2:-"baja solicitada"}

[ -n "$KEY" ] || fatalln "Uso: ./network.sh removeClinic <key> [\"<motivo>\"]"
registryRequire
clinicExists "$KEY" || fatalln "No existe una clínica con key '${KEY}' (ver './network.sh clinics')"

ESTADO=$(clinicField "$KEY" estado)
[ "$ESTADO" = "activa" ] || fatalln "La clínica '${KEY}' ya está en estado '${ESTADO}'"

ACTIVAS=$(countActive)
[ "$ACTIVAS" -ge 2 ] || fatalln "No se puede dar de baja la última clínica activa"
if [ "$ACTIVAS" -eq 2 ]; then
  infoln "Quedará una sola clínica activa: el canal seguirá funcionando, pero no hay intercambio posible."
fi

MSPID=$(clinicField "$KEY" mspId)
NOMBRE=$(clinicField "$KEY" nombre)
COMPOSE_FILE=$(clinicField "$KEY" composeFile)
FUNDADORA=$(clinicField "$KEY" fundadora)

if [ ${#MOTIVO} -gt 200 ] || [[ "$MOTIVO" == *$'\n'* ]]; then
  fatalln "Motivo inválido: máximo 200 caracteres, sin saltos de línea"
fi

infoln "== Baja de '${NOMBRE}' (${MSPID}) =="

# Quién firma: las demás si les alcanza la mayoría, si no también la saliente.
REMAINING=()
mapfile -t REMAINING < <(clinicKeysExcept "$KEY")
MAJORITY=$(( ACTIVAS / 2 + 1 ))
if [ "${#REMAINING[@]}" -ge "$MAJORITY" ]; then
  SIGNERS=("${REMAINING[@]}")
  infoln "   firman la baja las ${#SIGNERS[@]} clínicas restantes (mayoría de ${ACTIVAS})"
else
  SIGNERS=("${REMAINING[@]}" "$KEY")
  infoln "   con ${ACTIVAS} clínicas la mayoría son ${MAJORITY}: firma también la saliente (salida voluntaria)"
fi
EXECUTOR=${REMAINING[0]}

# --- 1) Revocar los consentimientos vigentes hacia la clínica saliente --------
infoln "[1/4] Revocando consentimientos vigentes otorgados a ${MSPID}"
setGlobals "${EXECUTOR}"
CONSENTS=$(peer chaincode query -C "${CHANNEL_NAME}" -n "${CC_NAME}" -c '{"Args":["GetAllConsents"]}' 2>/dev/null || echo '[]')
PENDIENTES=$(echo "${CONSENTS}" | jq -c --arg m "${MSPID}" \
  '[.[] | select(.GrantedToOrg == $m and .Revoked == false)]' 2>/dev/null || echo '[]')
TOTAL=$(echo "${PENDIENTES}" | jq 'length')

if [ "${TOTAL}" = "0" ]; then
  infoln "   no había consentimientos vigentes hacia ${MSPID}"
else
  infoln "   ${TOTAL} consentimiento(s) por revocar"
  for row in $(echo "${PENDIENTES}" | jq -r '.[] | @base64'); do
    consent=$(echo "${row}" | base64 -d)
    hash=$(echo "${consent}" | jq -r '.PatientIDHash')
    grantor=$(echo "${consent}" | jq -r '.GrantedByOrg')
    grantorKey=$(keyForMsp "${grantor}")
    if [ -z "${grantorKey}" ]; then
      errorln "   no se pudo resolver la org otorgante ${grantor}; se saltea"
      continue
    fi
    PAYLOAD=$(jq -nc --arg h "${hash}" --arg to "${MSPID}" '{function:"RevokeConsent", Args:[$h, $to, "[]"]}')
    setGlobals "${grantorKey}"
    set +e
    # shellcheck disable=SC2046
    peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
      --tls --cafile "$ORDERER_CA" -C "${CHANNEL_NAME}" -n "${CC_NAME}" \
      $(peerAddressArgs) -c "${PAYLOAD}" >/tmp/revoke.log 2>&1
    rres=$?
    set -e
    if [ $rres -ne 0 ]; then
      cat /tmp/revoke.log
      errorln "   no se pudo revocar el consentimiento de ${hash:0:12}…"
    else
      successln "   revocado: paciente ${hash:0:12}… (otorgaba ${grantor})"
    fi
    sleep 3   # MVCC: transacciones sobre claves distintas, pero el orderer las agrupa
  done
fi

# --- 2) Baja on-chain ---------------------------------------------------------
infoln "[2/4] Asentando la baja en el ledger (DeactivateClinic)"
PAYLOAD=$(jq -nc --arg mspId "${MSPID}" --arg motivo "${MOTIVO}" \
  '{function:"DeactivateClinic", Args:[$mspId, $motivo]}')
setGlobals "${EXECUTOR}"
set +e
# shellcheck disable=SC2046
peer chaincode invoke -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
  --tls --cafile "$ORDERER_CA" -C "${CHANNEL_NAME}" -n "${CC_NAME}" \
  $(peerAddressArgs) -c "${PAYLOAD}" >/tmp/deactivate.log 2>&1
dres=$?
set -e
cat /tmp/deactivate.log
if [ $dres -ne 0 ]; then
  errorln "   DeactivateClinic falló; se sigue con la baja de membresía igual"
else
  successln "   baja asentada on-chain"
fi
sleep 3

# --- 3) Sacarla de la membresía del canal -------------------------------------
infoln "[3/4] Sacando ${MSPID} de '${CHANNEL_NAME}'"
mkdir -p "${NETWORK_HOME}/channel-artifacts"
BASE="${NETWORK_HOME}/channel-artifacts/remove_${KEY}"
fetchChannelConfig "${EXECUTOR}" "${CHANNEL_NAME}" "${BASE}_config.json"
jq "del(.channel_group.groups.Application.groups.${MSPID})" "${BASE}_config.json" > "${BASE}_modified.json"

if diff -q "${BASE}_config.json" "${BASE}_modified.json" >/dev/null; then
  fatalln "${MSPID} no figura en la config de '${CHANNEL_NAME}'"
fi

createConfigUpdate "${CHANNEL_NAME}" "${BASE}_config.json" "${BASE}_modified.json" "${BASE}_update.pb"
applyConfigUpdate "${CHANNEL_NAME}" "${BASE}_update.pb" "${SIGNERS[@]}"

# --- 4) Apagar el peer --------------------------------------------------------
infoln "[4/4] Apagando peer0.$(clinicField "$KEY" domain)"
: "${CONTAINER_CLI:=docker}"
if command -v "${CONTAINER_CLI}-compose" > /dev/null 2>&1; then
  : "${CONTAINER_CLI_COMPOSE:=${CONTAINER_CLI}-compose}"
else
  : "${CONTAINER_CLI_COMPOSE:=${CONTAINER_CLI} compose}"
fi

if [ "${FUNDADORA}" = "true" ]; then
  # Las fundadoras viven en compose-network.yaml junto al orderer: se para solo
  # su servicio, sin tocar el resto de la red.
  ${CONTAINER_CLI} rm -f "peer0.$(clinicField "$KEY" domain)" > /dev/null 2>&1 || true
  successln "   contenedor del peer eliminado (el volumen queda; 'network.sh down' lo limpia)"
elif [ -n "${COMPOSE_FILE}" ] && [ -f "${COMPOSE_FILE}" ]; then
  DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}" ${CONTAINER_CLI_COMPOSE} -f "${COMPOSE_FILE}" down --volumes
  successln "   peer y volumen eliminados"
else
  errorln "   no se encontró el compose de '${KEY}'; apagar el peer a mano"
fi

registrySetEstado "${KEY}" "baja"

successln "== '${NOMBRE}' dada de baja =="
infoln "   Sus activos emitidos y su auditoría de accesos siguen en el ledger (inmutables)."
infoln "   El registro on-chain la muestra como BAJA; CheckAccess ya la deniega."
