package consent

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/hyperledger/fabric-contract-api-go/v2/contractapi"
)

// Clinic es el registro on-chain de una institución habilitada en el bus.
//
// No reemplaza a la membresía de Fabric — el alta y la baja de verdad son
// actualizaciones de configuración del canal (scripts/addOrg.sh y removeOrg.sh),
// y sin MSP en el canal una org no puede ni firmar una transacción. Este
// registro cumple dos funciones que la config del canal no cubre:
//
//  1. Auditoría: la config de canal guarda el estado actual, no la historia.
//     Acá cada alta y cada baja quedan como versiones separadas e inmutables
//     (GetClinicHistory), con quién la ejecutó, cuándo y por qué motivo.
//  2. Datos de la institución: nombre legible, dominio y endpoint, que el
//     canal no modela y que la capa de aplicación necesita para mostrar algo
//     más útil que un MSP ID.
//
// Consecuencia de diseño: una org podría estar en el canal y no acá (alta a
// mano, sin RegisterClinic). Ese caso se trata como NO habilitada —
// CheckAccess la deniega — porque el registro es la lista de instituciones
// admitidas en el bus, y el default es negar.
type Clinic struct {
	MspID           string `json:"MspID"`
	Nombre          string `json:"Nombre"`
	Domain          string `json:"Domain"`
	PeerEndpoint    string `json:"PeerEndpoint"`
	Estado          string `json:"Estado"`
	RegisteredByOrg string `json:"RegisteredByOrg"`
	RegisteredAt    string `json:"RegisteredAt"`
	DeactivatedByOrg string `json:"DeactivatedByOrg"`
	DeactivatedAt   string `json:"DeactivatedAt"`
	MotivoBaja      string `json:"MotivoBaja"`
}

const (
	// EstadoClinicaActiva y EstadoClinicaBaja son los únicos valores de
	// Clinic.Estado.
	EstadoClinicaActiva = "ACTIVA"
	EstadoClinicaBaja   = "BAJA"

	clinicKeyPrefix = "CLINIC_"

	// EventClinicRegistered y EventClinicDeactivated los escucha el dashboard
	// para refrescar la topología sin tener que hacer polling.
	EventClinicRegistered  = "ClinicRegistered"
	EventClinicDeactivated = "ClinicDeactivated"
)

func clinicKey(mspID string) string {
	return clinicKeyPrefix + mspID
}

// readClinic devuelve el registro de una org, o nil si no está registrada.
func readClinic(ctx contractapi.TransactionContextInterface, mspID string) (*Clinic, error) {
	clinicJSON, err := ctx.GetStub().GetState(clinicKey(mspID))
	if err != nil {
		return nil, fmt.Errorf("error leyendo world state: %v", err)
	}
	if clinicJSON == nil {
		return nil, nil
	}
	var clinic Clinic
	if err := json.Unmarshal(clinicJSON, &clinic); err != nil {
		return nil, err
	}
	return &clinic, nil
}

// isClinicActive resuelve si una org está habilitada para operar en el bus.
func isClinicActive(ctx contractapi.TransactionContextInterface, mspID string) (bool, error) {
	clinic, err := readClinic(ctx, mspID)
	if err != nil {
		return false, err
	}
	return clinic != nil && clinic.Estado == EstadoClinicaActiva, nil
}

// requireActiveCaller exige que quien firma la transacción sea una clínica
// activa, y devuelve su MSP ID.
func requireActiveCaller(ctx contractapi.TransactionContextInterface) (string, error) {
	mspID, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return "", fmt.Errorf("no se pudo determinar la organización solicitante: %v", err)
	}
	active, err := isClinicActive(ctx, mspID)
	if err != nil {
		return "", err
	}
	if !active {
		return "", fmt.Errorf("la organización %s no está registrada como clínica activa", mspID)
	}
	return mspID, nil
}

// RegisterClinic da de alta una institución en el registro del bus.
//
// Quien la registra tiene que ser una clínica ya activa, con una excepción
// acotada: si el registro está vacío, cualquier miembro del canal puede
// escribir la primera entrada. Es el arranque en frío de la red — las
// fundadoras no tienen a nadie que las avale — y se cierra solo, porque a
// partir de la primera clínica activa la excepción deja de aplicar.
func (s *SmartContract) RegisterClinic(ctx contractapi.TransactionContextInterface, mspID string, nombre string, domain string, peerEndpoint string) error {
	if mspID == "" || nombre == "" {
		return fmt.Errorf("mspID y nombre son obligatorios")
	}

	existentes, err := getAllByPrefix[Clinic](ctx, clinicKeyPrefix)
	if err != nil {
		return err
	}

	callerMSP, err := ctx.GetClientIdentity().GetMSPID()
	if err != nil {
		return fmt.Errorf("no se pudo determinar la organización solicitante: %v", err)
	}
	if len(existentes) > 0 {
		if _, err := requireActiveCaller(ctx); err != nil {
			return err
		}
	}

	existing, err := readClinic(ctx, mspID)
	if err != nil {
		return err
	}
	if existing != nil && existing.Estado == EstadoClinicaActiva {
		return fmt.Errorf("la clínica %s ya está registrada y activa", mspID)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("no se pudo obtener el timestamp de la transacción: %v", err)
	}
	now := txTimestamp.AsTime().UTC().Format(time.RFC3339)

	clinic := Clinic{
		MspID:           mspID,
		Nombre:          nombre,
		Domain:          domain,
		PeerEndpoint:    peerEndpoint,
		Estado:          EstadoClinicaActiva,
		RegisteredByOrg: callerMSP,
		RegisteredAt:    now,
	}
	// Un alta después de una baja reusa la clave: la versión anterior no se
	// pierde, queda en el historial del ledger igual que un consentimiento.

	clinicJSON, err := json.Marshal(clinic)
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutState(clinicKey(mspID), clinicJSON); err != nil {
		return err
	}
	return ctx.GetStub().SetEvent(EventClinicRegistered, clinicJSON)
}

// DeactivateClinic da de baja una institución. La ejecuta otra clínica activa
// (baja decidida por la red) o la propia interesada (salida voluntaria); en
// ambos casos queda registrado quién fue.
func (s *SmartContract) DeactivateClinic(ctx contractapi.TransactionContextInterface, mspID string, motivo string) error {
	callerMSP, err := requireActiveCaller(ctx)
	if err != nil {
		return err
	}

	clinic, err := readClinic(ctx, mspID)
	if err != nil {
		return err
	}
	if clinic == nil {
		return fmt.Errorf("la clínica %s no está registrada", mspID)
	}
	if clinic.Estado == EstadoClinicaBaja {
		return fmt.Errorf("la clínica %s ya está dada de baja", mspID)
	}

	txTimestamp, err := ctx.GetStub().GetTxTimestamp()
	if err != nil {
		return fmt.Errorf("no se pudo obtener el timestamp de la transacción: %v", err)
	}

	clinic.Estado = EstadoClinicaBaja
	clinic.DeactivatedByOrg = callerMSP
	clinic.DeactivatedAt = txTimestamp.AsTime().UTC().Format(time.RFC3339)
	clinic.MotivoBaja = motivo

	clinicJSON, err := json.Marshal(clinic)
	if err != nil {
		return err
	}
	if err := ctx.GetStub().PutState(clinicKey(mspID), clinicJSON); err != nil {
		return err
	}
	return ctx.GetStub().SetEvent(EventClinicDeactivated, clinicJSON)
}

// GetClinic devuelve el registro de una institución. Query de solo lectura.
func (s *SmartContract) GetClinic(ctx contractapi.TransactionContextInterface, mspID string) (*Clinic, error) {
	clinic, err := readClinic(ctx, mspID)
	if err != nil {
		return nil, err
	}
	if clinic == nil {
		return nil, fmt.Errorf("la clínica %s no está registrada", mspID)
	}
	return clinic, nil
}

// GetAllClinics devuelve el registro completo, activas y dadas de baja. Query
// de solo lectura.
func (s *SmartContract) GetAllClinics(ctx contractapi.TransactionContextInterface) ([]*Clinic, error) {
	return getAllByPrefix[Clinic](ctx, clinicKeyPrefix)
}

// ClinicHistoryEntry es una versión histórica del registro de una clínica.
type ClinicHistoryEntry struct {
	TxID      string  `json:"TxID"`
	Timestamp string  `json:"Timestamp"`
	IsDelete  bool    `json:"IsDelete"`
	Clinic    *Clinic `json:"Clinic"`
}

// GetClinicHistory devuelve todas las versiones del registro de una clínica en
// orden cronológico: el alta, cada baja y cada re-alta. Query de solo lectura.
func (s *SmartContract) GetClinicHistory(ctx contractapi.TransactionContextInterface, mspID string) ([]*ClinicHistoryEntry, error) {
	iterator, err := ctx.GetStub().GetHistoryForKey(clinicKey(mspID))
	if err != nil {
		return nil, fmt.Errorf("error leyendo el historial: %v", err)
	}
	defer iterator.Close()

	history := []*ClinicHistoryEntry{}
	for iterator.HasNext() {
		mod, err := iterator.Next()
		if err != nil {
			return nil, err
		}
		entry := &ClinicHistoryEntry{
			TxID:      mod.TxId,
			Timestamp: mod.Timestamp.AsTime().UTC().Format(time.RFC3339),
			IsDelete:  mod.IsDelete,
		}
		if !mod.IsDelete && len(mod.Value) > 0 {
			var c Clinic
			if err := json.Unmarshal(mod.Value, &c); err != nil {
				return nil, err
			}
			entry.Clinic = &c
		}
		history = append(history, entry)
	}
	return history, nil
}
