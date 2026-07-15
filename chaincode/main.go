/*
SPDX-License-Identifier: Apache-2.0
*/
package main

import (
	"log"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
	"pfi-medical-records/chaincode/consent"
)

func main() {
	cc, err := contractapi.NewChaincode(&consent.SmartContract{})
	if err != nil {
		log.Panicf("Error creando el chaincode de consentimiento: %v", err)
	}

	if err := cc.Start(); err != nil {
		log.Panicf("Error iniciando el chaincode de consentimiento: %v", err)
	}
}
