package consent

import (
	"encoding/json"
	"encoding/pem"
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
	TxID string `json:"TxID"`
	// FhirResourceID identifica el recurso PUNTUAL que se pidió. Antes la
	// auditoría solo guardaba el resource type, así que quedaba constancia de
	// que alguien accedió a "una Observation" del paciente pero no a cuál: con
	// varios recursos del mismo tipo era imposible reconstruir qué se entregó.
	FhirResourceID string `json:"FhirResourceID"`
	Timestamp      string `json:"Timestamp"`
	RequesterOrg   string `json:"RequesterOrg"`
	// ResourceType y PatientIDHash se derivan del activo, no los manda el
	// solicitante: así no puede pedir un recurso declarando el tipo o el
	// paciente de otro para hacer coincidir un consentimiento que no aplica.
	ResourceType  string `json:"ResourceType"`
	PatientIDHash string `json:"PatientIDHash"`
	AssetOwnerOrg string `json:"AssetOwnerOrg"`
	Decision      string `json:"Decision"`
	Reason        string `json:"Reason"`
	// RequesterCertPEM es el certificado X.509 (PEM) de quien firmó la tx,
	// tal como lo ve el chaincode vía ctx.GetClientIdentity() — determinista,
	// no es una llamada de red. Va también en el evento PERMIT para que la
	// app de la org dueña del recurso pueda envolver la clave AES para el
	// solicitante sin tener que salir a buscar su certificado a otro lado
	// (paso 5).
	RequesterCertPEM string `json:"RequesterCertPEM"`
}

const accessLogKeyPrefix = "ACCESSLOG_"

func accessLogKey(txID string) string {
	return accessLogKeyPrefix + txID
}

// CheckAccess evalúa ABAC con deny por defecto sobre UN recurso concreto: la
// organización que somete la transacción pide acceso a fhirResourceID, y el
// chaincode concede PERMIT solo si hay un Consent vigente (no revocado, no
// vencido) que cubra el resource type de ESE activo para el paciente de ESE
// activo. Cada evaluación queda registrada en el ledger para auditoría, con
// PERMIT o DENY, el motivo y el recurso.
//
// Recibe el recurso y no el par (resourceType, patientIDHash) por dos razones.
// Una es de auditoría: con el tipo solamente, el AccessLog no permitía saber
// cuál de los recursos del paciente se accedió. La otra es de seguridad: si el
// solicitante declara el tipo y el paciente, puede elegir los valores que hagan
// coincidir un consentimiento que en realidad no cubre el recurso que va a
// descargar. Derivándolos del activo, el ámbito del consentimiento y el recurso
// entregado son necesariamente el mismo.
//
// El consentimiento sigue siendo por (paciente, resource type) y no por
// recurso, a propósito: clínicamente uno consiente categorías de información,
// no resultados que todavía no existen. Lo que pasa a ser por recurso es la
// EVALUACIÓN y su rastro — cada descarga es una decisión individual y auditada,
// no un permiso general que después se usa N veces sin dejar huella.
//
// La organización solicitante se toma de ctx.GetClientIdentity().GetMSPID()
// — nunca de un argumento — porque si fuera un parámetro cualquier org
// podría pasar el MSPID de otra y leer si esa otra org tiene o no
// consentimiento sobre un paciente (fuga de información vía el resultado/
// evento), o directamente disparar entrega de clave a nombre ajeno.
func (s *SmartContract) CheckAccess(ctx contractapi.TransactionContextInterface, fhirResourceID string) (string, error) {
	if fhirResourceID == "" {
		return "", fmt.Errorf("fhirResourceID es obligatorio")
	}

	// Un pedido sobre un activo que no existe no se audita: se rechaza como
	// error. El AccessLog es el rastro de decisiones sobre recursos reales, y
	// registrar cada identificador mal tipeado lo llenaría de ruido sin agregar
	// información (los metadatos de los activos ya son públicos en el canal,
	// así que sondear identificadores no revela nada que no se pueda listar).
	asset, err := readAsset(ctx, fhirResourceID)
	if err != nil {
		return "", err
	}
	if asset == nil {
		return "", fmt.Errorf("el activo %s no existe", fhirResourceID)
	}
	resourceType := asset.ResourceType
	patientIDHash := asset.PatientIDHash

	requesterOrg, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return "", fmt.Errorf("no se pudo determinar la organización solicitante: %v", err)
	}

	requesterCert, err := ctx.GetClientIdentity().GetX509Certificate()
	if err != nil {
		return "", fmt.Errorf("no se pudo obtener el certificado del solicitante: %v", err)
	}
	requesterCertPEM := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: requesterCert.Raw}))

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return "", fmt.Errorf("no se pudo obtener el timestamp de la transacción: %v", err)
	}
	now := txTimestamp.AsTime()

	// Primer filtro: la org tiene que estar habilitada en el bus. Una clínica
	// dada de baja puede seguir teniendo consentimientos viejos sin revocar (o
	// carreras entre la revocación y la baja de membresía), y sin este chequeo
	// alcanzaría con que su peer siguiera en pie para obtener un PERMIT. Se
	// resuelve como DENY y no como error para que quede el rastro en la
	// auditoría: un intento de acceso de una institución dada de baja es
	// justamente lo que interesa poder demostrar después.
	requesterActiva, err := isClinicActive(ctx, requesterOrg)
	if err != nil {
		return "", err
	}

	decision := DecisionDeny
	reason := "no existe consentimiento"

	if !requesterActiva {
		reason = "organización no habilitada en el bus (no registrada o dada de baja)"
	} else {
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
	}

	logEntry := AccessLog{
		TxID:             ctx.GetStub().GetTxID(),
		FhirResourceID:   fhirResourceID,
		Timestamp:        now.UTC().Format(time.RFC3339),
		RequesterOrg:     requesterOrg,
		ResourceType:     resourceType,
		PatientIDHash:    patientIDHash,
		AssetOwnerOrg:    asset.OwnerOrg,
		Decision:         decision,
		Reason:           reason,
		RequesterCertPEM: requesterCertPEM,
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

// GetAllAccessLogs devuelve toda la auditoría de accesos (PERMIT y DENY).
// Query de solo lectura.
func (s *SmartContract) GetAllAccessLogs(ctx contractapi.TransactionContextInterface) ([]*AccessLog, error) {
	return getAllByPrefix[AccessLog](ctx, accessLogKeyPrefix)
}
