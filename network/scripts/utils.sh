#!/usr/bin/env bash
# Helpers de salida y verificación, usados por network.sh.

C_RESET='\033[0m'
C_RED='\033[0;31m'
C_GREEN='\033[0;32m'
C_BLUE='\033[0;34m'

infoln()    { echo -e "${C_BLUE}${1}${C_RESET}"; }
successln() { echo -e "${C_GREEN}${1}${C_RESET}"; }
errorln()   { echo -e "${C_RED}${1}${C_RESET}"; }
fatalln()   { errorln "${1}"; exit 1; }

verifyResult() {
  if [ "$1" -ne 0 ]; then
    fatalln "$2"
  fi
}
