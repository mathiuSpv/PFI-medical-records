#!/usr/bin/env bash
# Helpers para computar, firmar y enviar transacciones de actualización de
# config de canal. Se usan para fijar anchor peers y para el alta/baja de
# clínicas (que es, en el fondo, agregar o sacar una org del grupo Application
# de canal-universal). Requiere jq y configtxlator.

NETWORK_HOME=${NETWORK_HOME:-${PWD}}
. "${NETWORK_HOME}/scripts/envVar.sh"

# fetchChannelConfig <org> <channel_id> <output_json>
fetchChannelConfig() {
  local org=$1
  local channel=$2
  local output=$3

  setGlobals "$org"

  peer channel fetch config "${NETWORK_HOME}/channel-artifacts/config_block.pb" \
    -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    -c "$channel" --tls --cafile "$ORDERER_CA"

  configtxlator proto_decode --input "${NETWORK_HOME}/channel-artifacts/config_block.pb" --type common.Block --output "${NETWORK_HOME}/channel-artifacts/config_block.json"
  jq .data.data[0].payload.data.config "${NETWORK_HOME}/channel-artifacts/config_block.json" > "${output}"
}

# createConfigUpdate <channel_id> <original_config.json> <modified_config.json> <output.pb>
createConfigUpdate() {
  local channel=$1
  local original=$2
  local modified=$3
  local output=$4

  configtxlator proto_encode --input "${original}" --type common.Config --output "${NETWORK_HOME}/channel-artifacts/original_config.pb"
  configtxlator proto_encode --input "${modified}" --type common.Config --output "${NETWORK_HOME}/channel-artifacts/modified_config.pb"
  configtxlator compute_update --channel_id "${channel}" --original "${NETWORK_HOME}/channel-artifacts/original_config.pb" --updated "${NETWORK_HOME}/channel-artifacts/modified_config.pb" --output "${NETWORK_HOME}/channel-artifacts/config_update.pb"
  configtxlator proto_decode --input "${NETWORK_HOME}/channel-artifacts/config_update.pb" --type common.ConfigUpdate --output "${NETWORK_HOME}/channel-artifacts/config_update.json"
  echo '{"payload":{"header":{"channel_header":{"channel_id":"'"$channel"'", "type":2}},"data":{"config_update":'"$(cat "${NETWORK_HOME}/channel-artifacts/config_update.json")"'}}}' | jq . > "${NETWORK_HOME}/channel-artifacts/config_update_in_envelope.json"
  configtxlator proto_encode --input "${NETWORK_HOME}/channel-artifacts/config_update_in_envelope.json" --type common.Envelope --output "${output}"
}

# setAnchorPeerFor <org> <channel>
#
# Publica el peer0 de esa org como anchor peer del canal. Se firma y envía SOLO
# con esa org: el mod_policy del grupo de una org es sus propios Admins, así que
# no hace falta (ni corresponde) que firmen las demás — a diferencia del alta,
# que toca el grupo Application entero.
setAnchorPeerFor() {
  local org=$1
  local channel=$2

  setGlobals "$org"
  local mspid=$CORE_PEER_LOCALMSPID
  local host_port host port
  host_port=$(peerHost "$org")
  host=${host_port%%:*}
  port=${host_port##*:}

  infoln "Actualizando anchor peer de ${mspid} en '${channel}'"
  mkdir -p "${NETWORK_HOME}/channel-artifacts"
  local base="${NETWORK_HOME}/channel-artifacts/${mspid}_${channel}"

  fetchChannelConfig "$org" "$channel" "${base}_config.json"

  jq '.channel_group.groups.Application.groups.'"${mspid}"'.values += {"AnchorPeers":{"mod_policy": "Admins","value":{"anchor_peers": [{"host": "'"${host}"'","port": '"${port}"'}]},"version": "0"}}' \
    "${base}_config.json" > "${base}_modified.json"

  createConfigUpdate "$channel" "${base}_config.json" "${base}_modified.json" "${base}_anchors.tx"

  setGlobals "$org"
  set +e
  peer channel update -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    -c "$channel" -f "${base}_anchors.tx" --tls --cafile "$ORDERER_CA" >/tmp/anchor.log 2>&1
  local res=$?
  set -e
  cat /tmp/anchor.log
  verifyResult $res "No se pudo fijar el anchor peer de ${mspid} en '${channel}'"
  successln "Anchor peer fijado para ${mspid} en '${channel}'"
}

# applyConfigUpdate <channel> <envelope.pb> <org_firmante...>
#
# Firma el sobre con todos los orgs salvo el último y lo envía con ese último
# (`peer channel update` agrega la firma del que envía, así que firmar con
# todos y encima enviar con uno de ellos duplicaría una identidad). La política
# de Application/Admins es MAJORITY, de modo que con N orgs activas hacen falta
# ⌈N/2⌉ firmas: pasando todas las activas siempre alcanza.
applyConfigUpdate() {
  local channel=$1
  local envelope=$2
  shift 2
  local signers=("$@")

  [ ${#signers[@]} -ge 1 ] || fatalln "applyConfigUpdate necesita al menos una org firmante"

  local last_index=$((${#signers[@]} - 1))
  local submitter=${signers[$last_index]}

  local i
  for ((i = 0; i < last_index; i++)); do
    infoln "Firmando la actualización de config de '${channel}' como ${signers[$i]}"
    setGlobals "${signers[$i]}"
    set +e
    peer channel signconfigtx -f "${envelope}" >/tmp/signconfigtx.log 2>&1
    local sres=$?
    set -e
    cat /tmp/signconfigtx.log
    verifyResult $sres "${signers[$i]} no pudo firmar la actualización de config de '${channel}'"
  done

  infoln "Enviando la actualización de config de '${channel}' como ${submitter}"
  setGlobals "${submitter}"
  set +e
  peer channel update -o localhost:7050 --ordererTLSHostnameOverride orderer.example.com \
    -c "${channel}" -f "${envelope}" --tls --cafile "$ORDERER_CA" >/tmp/configupdate.log 2>&1
  local ures=$?
  set -e
  cat /tmp/configupdate.log
  verifyResult $ures "No se pudo aplicar la actualización de config de '${channel}'"
  successln "Config de '${channel}' actualizada"
}

# modifyChannelConfig <channel> <org_lector> <jq_filter> <etiqueta>
#
# Baja el config vigente del canal, le aplica el filtro jq, computa el delta y
# lo aplica firmado por todas las clínicas activas. El filtro recibe el config
# entero (el mismo objeto que devuelve fetchChannelConfig).
modifyChannelConfig() {
  local channel=$1
  local reader=$2
  local filter=$3
  local label=$4

  mkdir -p "${NETWORK_HOME}/channel-artifacts"
  local base="${NETWORK_HOME}/channel-artifacts/${label}"

  fetchChannelConfig "$reader" "$channel" "${base}_config.json"
  jq "$filter" "${base}_config.json" > "${base}_modified.json"

  if diff -q "${base}_config.json" "${base}_modified.json" >/dev/null; then
    fatalln "La modificación de config no cambió nada (${label}); revisar el filtro"
  fi

  createConfigUpdate "$channel" "${base}_config.json" "${base}_modified.json" "${base}_update.pb"

  local signers=()
  mapfile -t signers < <(clinicKeys activa)
  applyConfigUpdate "$channel" "${base}_update.pb" "${signers[@]}"
}
