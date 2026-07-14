#!/usr/bin/env bash
# Variables de entorno del cliente peer por organización. NETWORK_HOME debe
# apuntar a network/ (lo fija network.sh antes de importar este archivo).

NETWORK_HOME=${NETWORK_HOME:-${PWD}}
. "${NETWORK_HOME}/scripts/utils.sh"

export CORE_PEER_TLS_ENABLED=true
export ORDERER_CA=${NETWORK_HOME}/organizations/ordererOrganizations/example.com/tlsca/tlsca.example.com-cert.pem
export ORDERER_ADMIN_TLS_SIGN_CERT=${NETWORK_HOME}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.crt
export ORDERER_ADMIN_TLS_PRIVATE_KEY=${NETWORK_HOME}/organizations/ordererOrganizations/example.com/orderers/orderer.example.com/tls/server.key
export PEER0_SANCRISTOBAL_CA=${NETWORK_HOME}/organizations/peerOrganizations/sancristobal.example.com/tlsca/tlsca.sancristobal.example.com-cert.pem
export PEER0_MONTENEGRO_CA=${NETWORK_HOME}/organizations/peerOrganizations/montenegro.example.com/tlsca/tlsca.montenegro.example.com-cert.pem

# setGlobals <sancristobal|montenegro>
setGlobals() {
  local ORG=$1
  infoln "Using organization ${ORG}"
  if [ "$ORG" = "sancristobal" ]; then
    export CORE_PEER_LOCALMSPID=ClinicaSanCristobalMSP
    export CORE_PEER_TLS_ROOTCERT_FILE=$PEER0_SANCRISTOBAL_CA
    export CORE_PEER_MSPCONFIGPATH=${NETWORK_HOME}/organizations/peerOrganizations/sancristobal.example.com/users/Admin@sancristobal.example.com/msp
    export CORE_PEER_ADDRESS=localhost:7051
  elif [ "$ORG" = "montenegro" ]; then
    export CORE_PEER_LOCALMSPID=ClinicaMontenegroMSP
    export CORE_PEER_TLS_ROOTCERT_FILE=$PEER0_MONTENEGRO_CA
    export CORE_PEER_MSPCONFIGPATH=${NETWORK_HOME}/organizations/peerOrganizations/montenegro.example.com/users/Admin@montenegro.example.com/msp
    export CORE_PEER_ADDRESS=localhost:9051
  else
    fatalln "Organización desconocida: ${ORG} (usar 'sancristobal' o 'montenegro')"
  fi
}

# peerHost <sancristobal|montenegro> -> host:port del peer0 de esa org
peerHost() {
  if [ "$1" = "sancristobal" ]; then
    echo "peer0.sancristobal.example.com:7051"
  elif [ "$1" = "montenegro" ]; then
    echo "peer0.montenegro.example.com:9051"
  fi
}
