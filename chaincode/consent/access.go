package consent

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

const (
	// DecisionPermit y DecisionDeny son los únicos valores posibles de
	// AccessLog.Decision.
	DecisionPermit = "PERMIT"
	DecisionDeny   = "DENY"

	// EventAccessPermitted es el evento de chaincode que dispara la entrega
	// de clave off-chain (paso 5): la app de la org dueña del recurso lo
	// escucha y envuelve la clave AES para requesterOrg.
	EventAccessPermitted = "AccessPermitted"
)

// AccessLog es el registro de auditoría de cada evaluación de acceso, tanto
// PERMIT como DENY. Se persiste siempre, nunca se sobreescribe (una clave por
// TxID), así que además de estar en el historial del ledger cada decisión
// tiene su propia entrada consultable por separado.
type AccessLog struct {
	TxID          string `json:"TxID"`
	Timestamp     string `json:"Timestamp"`
	RequesterOrg  string `json:"RequesterOrg"`
	ResourceType  string `json:"ResourceType"`
	PatientIDHash string `json:"PatientIDHash"`
	Decision      string `json:"Decision"`
	Reason        string `json:"Reason"`
}

func accessLogKey(txID string) string {
	return "ACCESSLOG_" + txID
}

// CheckAccess evalúa ABAC con deny por defecto: la organización que somete la
// transacción pide acceso a resourceType de patientIDHash, y el chaincode
// concede PERMIT solo si hay un Consent vigente (no revocado, no vencido) que
// cubra ese resource type. Cada evaluación queda registrada en el ledger para
// auditoría, con PERMIT o DENY y el motivo.
//
// La organización solicitante se toma de ctx.GetClientIdentity().GetMSPID()
// — nunca de un argumento — porque si fuera un parámetro cualquier org
// podría pasar el MSPID de otra y leer si esa otra org tiene o no
// consentimiento sobre un paciente (fuga de información vía el resultado/
// evento), o directamente disparar entrega de clave a nombre ajeno.
func (s *SmartContract) CheckAccess(ctx contractapi.TransactionContextInterface, resourceType string, patientIDHash string) (string, error) {
	if resourceType == "" || patientIDHash == "" {
		return "", fmt.Errorf("resourceType y patientIDHash son obligatorios")
	}

	requesterOrg, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return "", fmt.Errorf("no se pudo determinar la organización solicitante: %v", err)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return "", fmt.Errorf("no se pudo obtener el timestamp de la transacción: %v", err)
	}
	now := txTimestamp.AsTime()

	decision := DecisionDeny
	reason := "no existe consentimiento"

	consentJSON, err := ctx.GetStub().GetState(consentKey(patientIDHash, requesterOrg))
	if err != nil {
		return "", fmt.Errorf("error leyendo world state: %v", err)
	}

	if consentJSON != nil {
		var consentRecord Consent
		if err := json.Unmarshal(consentJSON, &consentRecord); err != nil {
			return "", err
		}

		expiry, err := time.Parse(time.RFC3339, consentRecord.Expiry)
		if err != nil {
			return "", fmt.Errorf("expiry de consentimiento corrupto: %v", err)
		}

		switch {
		case consentRecord.Revoked:
			reason = "consentimiento revocado"
		case !now.Before(expiry):
			reason = "consentimiento vencido"
		case !containsString(consentRecord.ResourceTypes, resourceType):
			reason = "resource type no autorizado por el consentimiento"
		default:
			decision = DecisionPermit
			reason = ""
		}
	}

	logEntry := AccessLog{
		TxID:          ctx.GetStub().GetTxID(),
		Timestamp:     now.UTC().Format(time.RFC3339),
		RequesterOrg:  requesterOrg,
		ResourceType:  resourceType,
		PatientIDHash: patientIDHash,
		Decision:      decision,
		Reason:        reason,
	}
	logJSON, err := json.Marshal(logEntry)
	if err != nil {
		return "", err
	}
	if err := ctx.GetStub().PutState(accessLogKey(logEntry.TxID), logJSON); err != nil {
		return "", fmt.Errorf("no se pudo registrar la auditoría: %v", err)
	}

	if decision == DecisionPermit {
		if err := ctx.GetStub().SetEvent(EventAccessPermitted, logJSON); err != nil {
			return "", fmt.Errorf("no se pudo emitir el evento %s: %v", EventAccessPermitted, err)
		}
	}

	return decision, nil
}

// GetAccessLog devuelve el registro de auditoría de una transacción de
// CheckAccess puntual. Query de solo lectura.
func (s *SmartContract) GetAccessLog(ctx contractapi.TransactionContextInterface, txID string) (*AccessLog, error) {
	logJSON, err := ctx.GetStub().GetState(accessLogKey(txID))
	if err != nil {
		return nil, fmt.Errorf("error leyendo world state: %v", err)
	}
	if logJSON == nil {
		return nil, fmt.Errorf("no existe registro de auditoría para la tx %s", txID)
	}

	var logEntry AccessLog
	if err := json.Unmarshal(logJSON, &logEntry); err != nil {
		return nil, err
	}
	return &logEntry, nil
}
