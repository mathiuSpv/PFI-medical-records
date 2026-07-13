// Package consent implementa el chaincode de consentimiento + ABAC del canal
// público (canal-universal): registro de metadatos de activos FHIR,
// otorgamiento/revocación de consentimiento entre organizaciones y control de
// acceso con auditoría inmutable.
//
// Restricción de todo el paquete: determinista y sin I/O externo. Nunca usar
// time.Now(), math/rand ni ninguna llamada de red — solo ctx.GetStub() y
// ctx.GetClientIdentity(), cuyos valores todos los peers endorsers calculan
// igual a partir de la misma transacción.
package consent

import "github.com/hyperledger/fabric-contract-api-go/v2/contractapi"

// SmartContract agrupa las funciones del chaincode. Los métodos están
// repartidos en asset.go, consent.go y access.go según el área que tocan.
type SmartContract struct {
	contractapi.Contract
}
