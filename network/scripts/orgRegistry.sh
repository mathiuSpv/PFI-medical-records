#!/usr/bin/env bash
# Registro de clínicas de la red: única fuente de verdad de qué organizaciones
# existen, con qué MSP ID, en qué puertos y en qué estado. Antes esto estaba
# cableado en envVar.sh (if/elif), compose-network.yaml y src/config.js; con el
# alta/baja dinámica pasa a ser un archivo que todos leen.
#
# Vive en organizations/ a propósito: es estado de runtime que describe al
# material criptográfico, así que nace con 'network.sh up' y muere con 'down',
# igual que el material que describe. Lo consume también la capa de aplicación
# (application/src/config.js).

NETWORK_HOME=${NETWORK_HOME:-${PWD}}
CLINICS_FILE="${NETWORK_HOME}/organizations/clinics.json"

# Puertos: las dos clínicas fundadoras conservan los históricos (7051/9051)
# para no romper nada de lo ya documentado. Las que se den de alta después
# arrancan en 11051 y suben de a 1000, con el puerto de chaincode en +1 y el
# de operations (healthz) en su propia serie.
CLINIC_PORT_BASE=11051
CLINIC_PORT_STEP=1000
CLINIC_OPS_BASE=9446

registryFile() { echo "${CLINICS_FILE}"; }

# registryInit — crea el registro con las dos clínicas fundadoras si no existe.
# Idempotente: si ya está, no lo pisa (conserva las altas hechas después).
registryInit() {
  if [ -f "${CLINICS_FILE}" ]; then
    return
  fi
  mkdir -p "$(dirname "${CLINICS_FILE}")"
  cat > "${CLINICS_FILE}" <<'JSON'
{
  "clinics": [
    {
      "key": "sancristobal",
      "nombre": "Clínica San Cristóbal",
      "mspId": "ClinicaSanCristobalMSP",
      "domain": "sancristobal.example.com",
      "peerPort": 7051,
      "chaincodePort": 7052,
      "operationsPort": 9444,
      "privateChannel": "canal-sancristobal",
      "profile": "CanalSanCristobal",
      "configtxDir": "",
      "composeFile": "",
      "estado": "activa",
      "fundadora": true
    },
    {
      "key": "montenegro",
      "nombre": "Clínica Montenegro",
      "mspId": "ClinicaMontenegroMSP",
      "domain": "montenegro.example.com",
      "peerPort": 9051,
      "chaincodePort": 9052,
      "operationsPort": 9445,
      "privateChannel": "canal-montenegro",
      "profile": "CanalMontenegro",
      "configtxDir": "",
      "composeFile": "",
      "estado": "activa",
      "fundadora": true
    }
  ]
}
JSON
}

registryRequire() {
  [ -f "${CLINICS_FILE}" ] || fatalln "No existe el registro de clínicas (${CLINICS_FILE}); correr './network.sh up' primero"
}

# clinicJSON <key> — objeto completo de una clínica (vacío si no existe).
clinicJSON() {
  jq -c --arg k "$1" '.clinics[] | select(.key == $k)' "${CLINICS_FILE}"
}

clinicExists() {
  [ -n "$(clinicJSON "$1")" ]
}

# clinicField <key> <campo>
clinicField() {
  jq -r --arg k "$1" --arg f "$2" '.clinics[] | select(.key == $k) | .[$f]' "${CLINICS_FILE}"
}

# clinicKeys [activa|baja|todas]  (default: activa)
clinicKeys() {
  local filtro=${1:-activa}
  if [ "$filtro" = "todas" ]; then
    jq -r '.clinics[].key' "${CLINICS_FILE}"
  else
    jq -r --arg e "$filtro" '.clinics[] | select(.estado == $e) | .key' "${CLINICS_FILE}"
  fi
}

# clinicKeysExcept <key> — activas menos la indicada (para firmar config updates
# donde la org involucrada no puede o no debe ser la única firmante).
clinicKeysExcept() {
  jq -r --arg k "$1" '.clinics[] | select(.estado == "activa" and .key != $k) | .key' "${CLINICS_FILE}"
}

# keyForMsp <mspId> — clave interna de la clínica dueña de ese MSP ID (vacío si
# no está registrada). Sirve para volver de lo que dice el ledger (MSP IDs) a lo
# que necesita setGlobals (keys).
keyForMsp() {
  jq -r --arg m "$1" '.clinics[] | select(.mspId == $m) | .key' "${CLINICS_FILE}"
}

countActive() {
  jq '[.clinics[] | select(.estado == "activa")] | length' "${CLINICS_FILE}"
}

# nextPorts — imprime "peerPort chaincodePort operationsPort" libres para un
# alta nueva, calculados a partir del máximo ya asignado (no se reutilizan los
# de una clínica dada de baja: sus contenedores pueden seguir apagándose).
nextPorts() {
  local maxPeer maxOps peer cc ops
  maxPeer=$(jq '[.clinics[].peerPort] | max' "${CLINICS_FILE}")
  maxOps=$(jq '[.clinics[].operationsPort] | max' "${CLINICS_FILE}")

  if [ "${maxPeer}" -lt "${CLINIC_PORT_BASE}" ]; then
    peer=${CLINIC_PORT_BASE}
  else
    peer=$((maxPeer + CLINIC_PORT_STEP))
  fi
  cc=$((peer + 1))

  if [ "${maxOps}" -lt "${CLINIC_OPS_BASE}" ]; then
    ops=${CLINIC_OPS_BASE}
  else
    ops=$((maxOps + 1))
  fi

  echo "${peer} ${cc} ${ops}"
}

# registryAdd <key> <nombre> <mspId> <domain> <peerPort> <ccPort> <opsPort> <canalPrivado> <perfil> <configtxDir> <composeFile>
registryAdd() {
  local tmp="${CLINICS_FILE}.tmp"
  jq --arg key "$1" --arg nombre "$2" --arg mspId "$3" --arg domain "$4" \
     --argjson peerPort "$5" --argjson chaincodePort "$6" --argjson operationsPort "$7" \
     --arg privateChannel "$8" --arg profile "$9" --arg configtxDir "${10}" --arg composeFile "${11}" \
     '.clinics += [{
        key: $key, nombre: $nombre, mspId: $mspId, domain: $domain,
        peerPort: $peerPort, chaincodePort: $chaincodePort, operationsPort: $operationsPort,
        privateChannel: $privateChannel, profile: $profile,
        configtxDir: $configtxDir, composeFile: $composeFile,
        estado: "activa", fundadora: false
      }]' "${CLINICS_FILE}" > "${tmp}" && mv "${tmp}" "${CLINICS_FILE}"
}

# registrySetEstado <key> <activa|baja> — no borra la fila: la baja queda
# registrada acá igual que queda on-chain, para poder listarla después.
registrySetEstado() {
  local tmp="${CLINICS_FILE}.tmp"
  jq --arg k "$1" --arg e "$2" \
     '(.clinics[] | select(.key == $k) | .estado) = $e' "${CLINICS_FILE}" > "${tmp}" && mv "${tmp}" "${CLINICS_FILE}"
}

# composeFilesActivos — rutas de los compose generados de clínicas no fundadoras
# que siguen activas (las fundadoras viven en compose-network.yaml).
composeFilesActivos() {
  jq -r '.clinics[] | select(.estado == "activa" and .fundadora == false) | .composeFile' "${CLINICS_FILE}"
}

composeFilesTodos() {
  jq -r '.clinics[] | select(.fundadora == false) | .composeFile' "${CLINICS_FILE}"
}
