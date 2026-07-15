package consent

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// Consent es el consentimiento de un paciente (identificado por su hash) para
// que una org acceda a ciertos resource types hasta una fecha de expiración.
// No se borra nunca: RevokeConsent lo actualiza (Revoked=true y/o recorta
// ResourceTypes), y el historial de versiones queda en el ledger vía
// GetHistoryForKey — eso es lo que da el "historial inmutable" pedido, sin
// necesidad de un array de eventos manual en el propio documento.
type Consent struct {
	PatientIDHash string   `json:"PatientIDHash"`
	GrantedToOrg  string   `json:"GrantedToOrg"`
	GrantedByOrg  string   `json:"GrantedByOrg"`
	ResourceTypes []string `json:"ResourceTypes"`
	Expiry        string   `json:"Expiry"`
	Revoked       bool     `json:"Revoked"`
	CreatedAt     string   `json:"CreatedAt"`
	UpdatedAt     string   `json:"UpdatedAt"`
}

func consentKey(patientIDHash string, grantedToOrg string) string {
	return "CONSENT_" + patientIDHash + "_" + grantedToOrg
}

// GrantConsent otorga (o reemplaza) el consentimiento de patientIDHash para
// que grantedToOrg acceda a resourceTypesJSON (array JSON de strings, p.ej.
// ["Observation","MedicationRequest"]) hasta expiry (RFC3339).
//
// Mínimo privilegio: resourceTypes no puede quedar vacío ni expiry en el
// pasado — no existe la variante "otorgar todo para siempre" por default,
// hay que ser explícito. La org otorgante (quien firma la tx, normalmente la
// clínica que tiene al paciente) queda registrada para poder validar quién
// puede revocar después.
func (s *SmartContract) GrantConsent(ctx contractapi.TransactionContextInterface, patientIDHash string, grantedToOrg string, resourceTypesJSON string, expiry string) error {
	if patientIDHash == "" || grantedToOrg == "" {
		return fmt.Errorf("patientIDHash y grantedToOrg son obligatorios")
	}

	var resourceTypes []string
	if err := json.Unmarshal([]byte(resourceTypesJSON), &resourceTypes); err != nil {
		return fmt.Errorf("resourceTypes debe ser un array JSON de strings: %v", err)
	}
	resourceTypes = dedupSorted(resourceTypes)
	if len(resourceTypes) == 0 {
		return fmt.Errorf("hay que otorgar al menos un resource type (mínimo privilegio: no se admite consentimiento vacío)")
	}

	expiryTime, err := time.Parse(time.RFC3339, expiry)
	if err != nil {
		return fmt.Errorf("expiry debe tener formato RFC3339: %v", err)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("no se pudo obtener el timestamp de la transacción: %v", err)
	}
	now := txTimestamp.AsTime()
	if !expiryTime.After(now) {
		return fmt.Errorf("expiry debe ser posterior al momento del otorgamiento")
	}

	grantorOrg, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("no se pudo determinar la organización otorgante: %v", err)
	}
	if grantorOrg == grantedToOrg {
		return fmt.Errorf("una organización no puede otorgarse consentimiento a sí misma")
	}

	key := consentKey(patientIDHash, grantedToOrg)
	createdAt := now.UTC().Format(time.RFC3339)
	existingJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("error leyendo world state: %v", err)
	}
	if existingJSON != nil {
		var existing Consent
		if err := json.Unmarshal(existingJSON, &existing); err != nil {
			return err
		}
		createdAt = existing.CreatedAt
	}

	consentRecord := Consent{
		PatientIDHash: patientIDHash,
		GrantedToOrg:  grantedToOrg,
		GrantedByOrg:  grantorOrg,
		ResourceTypes: resourceTypes,
		Expiry:        expiryTime.UTC().Format(time.RFC3339),
		Revoked:       false,
		CreatedAt:     createdAt,
		UpdatedAt:     now.UTC().Format(time.RFC3339),
	}

	consentJSON, err := json.Marshal(consentRecord)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, consentJSON)
}

// RevokeConsent revoca el consentimiento de grantedToOrg sobre patientIDHash.
// resourceTypesJSON vacío ("[]") revoca todo; con tipos puntuales, revoca
// solo esos (revocación parcial) y si no queda ninguno vivo marca Revoked.
// Solo la org que otorgó el consentimiento puede revocarlo.
func (s *SmartContract) RevokeConsent(ctx contractapi.TransactionContextInterface, patientIDHash string, grantedToOrg string, resourceTypesJSON string) error {
	key := consentKey(patientIDHash, grantedToOrg)
	existingJSON, err := ctx.GetStub().GetState(key)
	if err != nil {
		return fmt.Errorf("error leyendo world state: %v", err)
	}
	if existingJSON == nil {
		return fmt.Errorf("no existe consentimiento de %s hacia %s", patientIDHash, grantedToOrg)
	}

	var consentRecord Consent
	if err := json.Unmarshal(existingJSON, &consentRecord); err != nil {
		return err
	}

	callerOrg, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("no se pudo determinar la organización solicitante: %v", err)
	}
	if callerOrg != consentRecord.GrantedByOrg {
		return fmt.Errorf("solo %s puede revocar este consentimiento", consentRecord.GrantedByOrg)
	}

	var toRevoke []string
	if err := json.Unmarshal([]byte(resourceTypesJSON), &toRevoke); err != nil {
		return fmt.Errorf("resourceTypes debe ser un array JSON de strings ([] para revocación total): %v", err)
	}

	if len(toRevoke) == 0 {
		// []string{} y no nil: nil serializa a JSON "null", que el schema
		// autogenerado por contractapi rechaza donde espera "array" (rompe
		// GetConsent). []string{} serializa a "[]".
		consentRecord.ResourceTypes = []string{}
		consentRecord.Revoked = true
	} else {
		consentRecord.ResourceTypes = subtractSorted(consentRecord.ResourceTypes, dedupSorted(toRevoke))
		if len(consentRecord.ResourceTypes) == 0 {
			consentRecord.Revoked = true
		}
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("no se pudo obtener el timestamp de la transacción: %v", err)
	}
	consentRecord.UpdatedAt = txTimestamp.AsTime().UTC().Format(time.RFC3339)

	consentJSON, err := json.Marshal(consentRecord)
	if err != nil {
		return err
	}
	return ctx.GetStub().PutState(key, consentJSON)
}

// GetConsent devuelve el consentimiento vigente (o revocado) entre
// patientIDHash y grantedToOrg. Query de solo lectura.
func (s *SmartContract) GetConsent(ctx contractapi.TransactionContextInterface, patientIDHash string, grantedToOrg string) (*Consent, error) {
	consentJSON, err := ctx.GetStub().GetState(consentKey(patientIDHash, grantedToOrg))
	if err != nil {
		return nil, fmt.Errorf("error leyendo world state: %v", err)
	}
	if consentJSON == nil {
		return nil, fmt.Errorf("no existe consentimiento de %s hacia %s", patientIDHash, grantedToOrg)
	}

	var consentRecord Consent
	if err := json.Unmarshal(consentJSON, &consentRecord); err != nil {
		return nil, err
	}
	return &consentRecord, nil
}

// ConsentHistoryEntry es una versión histórica de un Consent, tal como quedó
// en un momento dado del ledger (GetHistoryForKey). Es lo que hace auditable
// el "historial inmutable" pedido para RevokeConsent: cada Grant/Revoke queda
// como una entrada separada e insertable, nunca se reescribe ni se borra.
type ConsentHistoryEntry struct {
	TxID      string   `json:"TxID"`
	Timestamp string   `json:"Timestamp"`
	IsDelete  bool     `json:"IsDelete"`
	Consent   *Consent `json:"Consent"`
}

// GetConsentHistory devuelve todas las versiones históricas del consentimiento
// entre patientIDHash y grantedToOrg, en orden cronológico. Query de solo
// lectura.
func (s *SmartContract) GetConsentHistory(ctx contractapi.TransactionContextInterface, patientIDHash string, grantedToOrg string) ([]*ConsentHistoryEntry, error) {
	iterator, err := ctx.GetStub().GetHistoryForKey(consentKey(patientIDHash, grantedToOrg))
	if err != nil {
		return nil, fmt.Errorf("error leyendo el historial: %v", err)
	}
	defer iterator.Close()

	history := []*ConsentHistoryEntry{}
	for iterator.HasNext() {
		mod, err := iterator.Next()
		if err != nil {
			return nil, err
		}

		entry := &ConsentHistoryEntry{
			TxID:      mod.TxId,
			Timestamp: mod.Timestamp.AsTime().UTC().Format(time.RFC3339),
			IsDelete:  mod.IsDelete,
		}
		if !mod.IsDelete && len(mod.Value) > 0 {
			var c Consent
			if err := json.Unmarshal(mod.Value, &c); err != nil {
				return nil, err
			}
			entry.Consent = &c
		}
		history = append(history, entry)
	}
	return history, nil
}
