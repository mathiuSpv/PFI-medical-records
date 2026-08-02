package consent

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// Asset es el metadato público de un recurso FHIR: identifica el recurso, su
// tipo, el CID de IPFS donde vive el payload cifrado y el hash del paciente.
// Nunca contiene el payload clínico en sí.
type Asset struct {
	FhirResourceID string `json:"FhirResourceID"`
	IpfsCid        string `json:"IpfsCid"`
	OwnerOrg       string `json:"OwnerOrg"`
	PatientIDHash  string `json:"PatientIDHash"`
	ResourceType   string `json:"ResourceType"`
	Timestamp      string `json:"Timestamp"`
	TxID           string `json:"TxID"`
}

const assetKeyPrefix = "ASSET_"

func assetKey(fhirResourceID string) string {
	return assetKeyPrefix + fhirResourceID
}

// EmitAsset registra los metadatos de un recurso ya subido a IPFS por fuera
// del ledger. No sube ni descarga nada de IPFS: eso es responsabilidad de la
// capa de aplicación (paso 5), el chaincode solo dejar constancia del CID.
func (s *SmartContract) EmitAsset(ctx contractapi.TransactionContextInterface, fhirResourceID string, resourceType string, ipfsCid string, patientIDHash string) error {
	if fhirResourceID == "" || resourceType == "" || ipfsCid == "" || patientIDHash == "" {
		return fmt.Errorf("fhirResourceID, resourceType, ipfsCid y patientIDHash son obligatorios")
	}

	key := assetKey(fhirResourceID)
	existing, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("error leyendo world state: %v", err)
	}
	if existing != nil {
		return fmt.Errorf("el activo %s ya fue emitido", fhirResourceID)
	}

	// Solo una clínica habilitada puede emitir: una institución dada de baja no
	// debería poder seguir publicando activos en el bus aunque su peer siga en
	// pie hasta que se aplique la baja de membresía.
	ownerOrg, err := requireActiveCaller(ctx)
	if err != nil {
		return err
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("no se pudo obtener el timestamp de la transacción: %v", err)
	}

	asset := Asset{
		FhirResourceID: fhirResourceID,
		ResourceType:   resourceType,
		IpfsCid:        ipfsCid,
		PatientIDHash:  patientIDHash,
		OwnerOrg:       ownerOrg,
		Timestamp:      txTimestamp.AsTime().UTC().Format(time.RFC3339),
		TxID:           ctx.GetStub().GetTxID(),
	}

	assetJSON, err := json.Marshal(asset)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, assetJSON)
}

// GetAsset devuelve los metadatos de un recurso. Query de solo lectura (no
// genera transacción si se invoca con `peer chaincode query`).
func (s *SmartContract) GetAsset(ctx contractapi.TransactionContextInterface, fhirResourceID string) (*Asset, error) {
	assetJSON, err := ctx.GetStub().GetState(assetKey(fhirResourceID))
	if err != nil {
		return nil, fmt.Errorf("error leyendo world state: %v", err)
	}
	if assetJSON == nil {
		return nil, fmt.Errorf("el activo %s no existe", fhirResourceID)
	}

	var asset Asset
	if err := json.Unmarshal(assetJSON, &asset); err != nil {
		return nil, err
	}
	return &asset, nil
}

// GetAllAssets devuelve todos los activos emitidos. Query de solo lectura.
func (s *SmartContract) GetAllAssets(ctx contractapi.TransactionContextInterface) ([]*Asset, error) {
	return getAllByPrefix[Asset](ctx, assetKeyPrefix)
}
