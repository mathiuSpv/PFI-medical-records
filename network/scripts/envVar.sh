#!/usr/bin/env bash
# Variables de entorno del cliente peer por organización. NETWORK_HOME debe
# apuntar a network/ (lo fija network.sh antes de importar este archivo).
#
# Ya no hay orgs cableadas: setGlobals resuelve MSP ID, puerto y rutas leyendo
# el registro de clínicas (scripts/orgRegistry.sh), así que funciona igual para
# las dos clínicas iniciales que para cualquier clínica dada de alta en caliente.

NETWORK_HOME=${NETWORK_HOME:-${PWD}}
. "${NETWORK_HOME}/scripts/utils.sh"
. "${NETWORK_HOME}/scripts/orgRegistry.sh"

export CORE_PEER_TLS_ENABLED=true
export ORDERER_CA=${NETWORK_HOME}/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem
export ORDERER_ADMIN_TLS_SIGN_CERT=${NETWORK_HOME}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.crt
export ORDERER_ADMIN_TLS_PRIVATE_KEY=${NETWORK_HOME}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.key

# Nodos del servicio de ordenamiento, como "host:puertoAdmin". Son tres para
# tolerar la caída de uno (quórum Raft 2f+1 con f=1, RNF03). Todo canal debe
# unirse a los tres: un canal que sólo conoce un nodo no tiene réplica y la
# tolerancia a fallos sería aparente.
#
# El primero es además el endpoint que usan los clientes `peer` de los demás
# scripts (localhost:7050). No hace falta que lo conozcan a los tres: el
# cliente envía la transacción a un orderer y el cluster la replica.
export ORDERER_NODES="orderer.example.com:7053 orderer2.example.com:8053 orderer3.example.com:10053"

# Cada nodo presenta su propio certificado como identidad de cliente contra su
# endpoint de administración. Comparten CA de TLS, así que cualquiera sería
# aceptado por cualquiera; usar el propio deja el vínculo explícito.
ordererAdminCert() {
  echo "${NETWORK_HOME}/organizations/ordererOrganizations/example.com/orderers/$1/tls/server.crt"
}
ordererAdminKey() {
  echo "${NETWORK_HOME}/organizations/ordererOrganizations/example.com/orderers/$1/tls/server.key"
}

# Atajos de las dos clínicas iniciales: el README los usa en las pruebas manuales con
# el CLI `peer`. Para cualquier otra clínica, usar peerCA <key>.
export PEER0_GENERICA1_CA=${NETWORK_HOME}/organizations/peerOrganizations/generica1.example.com/tlsca/tlsca.generica1.example.com-cert.pem
export PEER0_GENERICA2_CA=${NETWORK_HOME}/organizations/peerOrganizations/generica2.example.com/tlsca/tlsca.generica2.example.com-cert.pem

# peerCA <key> — certificado de la CA de TLS del peer de esa clínica.
peerCA() {
  local domain
  domain=$(clinicField "$1" domain)
  echo "${NETWORK_HOME}/organizations/peerOrganizations/${domain}/tlsca/tlsca.${domain}-cert.pem"
}

# adminMSP <key> — MSP del usuario Admin de esa clínica (identidad de canal).
adminMSP() {
  local domain
  domain=$(clinicField "$1" domain)
  echo "${NETWORK_HOME}/organizations/peerOrganizations/${domain}/users/Admin@${domain}/msp"
}

# setGlobals <key> — configura el cliente `peer` para actuar como admin de esa
# clínica. El endpoint va por localhost:<puerto publicado> porque el cliente
# corre fuera de la red docker.
setGlobals() {
  local ORG=$1
  registryRequire
  clinicExists "$ORG" || fatalln "Organización desconocida: ${ORG} (ver './network.sh clinics')"

  infoln "Using organization ${ORG}"
  CORE_PEER_LOCALMSPID=$(clinicField "$ORG" mspId)
  CORE_PEER_TLS_ROOTCERT_FILE=$(peerCA "$ORG")
  CORE_PEER_MSPCONFIGPATH=$(adminMSP "$ORG")
  CORE_PEER_ADDRESS=localhost:$(clinicField "$ORG" peerPort)
  export CORE_PEER_LOCALMSPID CORE_PEER_TLS_ROOTCERT_FILE CORE_PEER_MSPCONFIGPATH CORE_PEER_ADDRESS
}

# peerHost <key> -> host:port interno (red docker) del peer0 de esa clínica.
# Es el que se publica como anchor peer y como endpoint de gossip.
peerHost() {
  local domain port
  domain=$(clinicField "$1" domain)
  port=$(clinicField "$1" peerPort)
  echo "peer0.${domain}:${port}"
}

# peerAddressArgs [key...] — pares --peerAddresses/--tlsRootCertFiles para los
# invokes que necesitan endorsement de varias orgs. Sin argumentos, todas las
# clínicas activas.
peerAddressArgs() {
  local keys=("$@")
  if [ ${#keys[@]} -eq 0 ]; then
    mapfile -t keys < <(clinicKeys activa)
  fi
  local out=()
  for k in "${keys[@]}"; do
    out+=(--peerAddresses "localhost:$(clinicField "$k" peerPort)" --tlsRootCertFiles "$(peerCA "$k")")
  done
  echo "${out[@]}"
}
