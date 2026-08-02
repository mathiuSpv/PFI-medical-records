package consent_test

// Andamiaje de los tests: un world state en memoria detrás de los mocks
// generados con counterfeiter, para que los tests se escriban como el flujo
// real (emitir → otorgar → pedir acceso) en vez de programar retornos sueltos
// método por método.
//
// Sin testify a propósito: la biblioteca estándar alcanza y el chaincode se
// vendoriza, así que cada dependencia nueva es una que hay que arrastrar.

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/hyperledger/fabric-chaincode-go/v2/shim"
	"github.com/hyperledger/fabric-protos-go-apiv2/ledger/queryresult"
	"google.golang.org/protobuf/types/known/timestamppb"

	"pfi-medical-records/chaincode/consent"
	"pfi-medical-records/chaincode/consent/mocks"
)

const (
	orgA = "ClinicaAMSP"
	orgB = "ClinicaBMSP"
	orgC = "ClinicaCMSP"
)

// harness es una red de una sola transacción por vez: el world state persiste
// entre llamadas, así que un test puede otorgar consentimiento y después pedir
// acceso y ver el efecto, igual que en la red real.
type harness struct {
	t       *testing.T
	sc      *consent.SmartContract
	state   map[string][]byte
	ctx     *mocks.TransactionContext
	ident   *mocks.ClientIdentity
	now     time.Time
	txID    string
	eventos map[string][]byte
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	h := &harness{
		t:       t,
		sc:      &consent.SmartContract{},
		state:   map[string][]byte{},
		ident:   &mocks.ClientIdentity{MspID: orgA},
		now:     time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC),
		txID:    "tx-0",
		eventos: map[string][]byte{},
	}

	stub := &mocks.ChaincodeStub{}
	stub.GetStateCalls(func(key string) ([]byte, error) { return h.state[key], nil })
	stub.PutStateCalls(func(key string, value []byte) error {
		h.state[key] = append([]byte(nil), value...)
		return nil
	})
	stub.GetStateByRangeCalls(h.rango)
	stub.GetTxIDCalls(func() string { return h.txID })
	stub.GetTxTimestampCalls(func() (*timestamppb.Timestamp, error) {
		return timestamppb.New(h.now), nil
	})
	stub.SetEventCalls(func(name string, payload []byte) error {
		h.eventos[name] = append([]byte(nil), payload...)
		return nil
	})

	h.ctx = &mocks.TransactionContext{}
	h.ctx.GetStubReturns(stub)
	h.ctx.GetClientIdentityReturns(h.ident)
	return h
}

// rango implementa GetStateByRange sobre el mapa. Devuelve las claves
// ordenadas, como hace el peer: getAllByPrefix depende de eso para que la
// salida del chaincode sea determinista.
func (h *harness) rango(start, end string) (shim.StateQueryIteratorInterface, error) {
	var claves []string
	for k := range h.state {
		if k >= start && k < end {
			claves = append(claves, k)
		}
	}
	sort.Strings(claves)

	i := 0
	it := &mocks.StateQueryIterator{}
	it.HasNextCalls(func() bool { return i < len(claves) })
	it.NextCalls(func() (*queryresult.KV, error) {
		kv := &queryresult.KV{Key: claves[i], Value: h.state[claves[i]]}
		i++
		return kv, nil
	})
	it.CloseCalls(func() error { return nil })
	return it, nil
}

// as cambia quién firma la transacción. Es el eje de casi todos los tests: en
// este chaincode la autorización sale siempre de la identidad que firma, nunca
// de un argumento.
func (h *harness) as(mspID string) *harness {
	h.ident.MspID = mspID
	return h
}

// tx avanza el TxID: el AccessLog usa una clave por transacción, así que sin
// esto dos CheckAccess del mismo test se pisarían.
func (h *harness) tx(id string) *harness {
	h.txID = id
	return h
}

func (h *harness) at(t time.Time) *harness {
	h.now = t
	return h
}

// registrar deja clínicas activas en el registro, que es la precondición de
// casi todo el resto del chaincode. Restaura quién firmaba al terminar.
func (h *harness) registrar(msps ...string) *harness {
	h.t.Helper()
	quien := h.ident.MspID
	for _, msp := range msps {
		if err := h.sc.RegisterClinic(h.ctx, msp, "Clínica "+msp, msp+".example.com", "peer0:7051"); err != nil {
			h.t.Fatalf("precondición: no se pudo registrar %s: %v", msp, err)
		}
	}
	h.ident.MspID = quien
	return h
}

// emitir publica un activo como la org que esté firmando.
func (h *harness) emitir(id, tipo, paciente string) *harness {
	h.t.Helper()
	if err := h.sc.EmitAsset(h.ctx, id, tipo, "QmCID"+id, paciente); err != nil {
		h.t.Fatalf("precondición: no se pudo emitir %s: %v", id, err)
	}
	return h
}

// otorgar da consentimiento como la org que esté firmando.
func (h *harness) otorgar(paciente, hacia string, tipos []string, vence time.Time) *harness {
	h.t.Helper()
	crudo, _ := json.Marshal(tipos)
	if err := h.sc.GrantConsent(h.ctx, paciente, hacia, string(crudo), vence.Format(time.RFC3339)); err != nil {
		h.t.Fatalf("precondición: no se pudo otorgar consentimiento: %v", err)
	}
	return h
}

// permitido corre CheckAccess y devuelve la decisión y el motivo registrado en
// la auditoría de esa misma transacción.
func (h *harness) permitido(recurso string) (string, string) {
	h.t.Helper()
	decision, err := h.sc.CheckAccess(h.ctx, recurso)
	if err != nil {
		h.t.Fatalf("CheckAccess devolvió error inesperado: %v", err)
	}
	log, err := h.sc.GetAccessLog(h.ctx, h.txID)
	if err != nil {
		h.t.Fatalf("no quedó auditoría de la tx %s: %v", h.txID, err)
	}
	return decision, log.Reason
}

func (h *harness) ultimoLog() *consent.AccessLog {
	h.t.Helper()
	log, err := h.sc.GetAccessLog(h.ctx, h.txID)
	if err != nil {
		h.t.Fatalf("no quedó auditoría de la tx %s: %v", h.txID, err)
	}
	return log
}

func (h *harness) huboEvento(nombre string) bool {
	_, ok := h.eventos[nombre]
	return ok
}

func (h *harness) resetEventos() { h.eventos = map[string][]byte{} }

func (h *harness) clavesConPrefijo(prefijo string) []string {
	var out []string
	for k := range h.state {
		if strings.HasPrefix(k, prefijo) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

func enUnAnio(desde time.Time) time.Time { return desde.AddDate(1, 0, 0) }
