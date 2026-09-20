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
	// historial replica lo que el peer guarda por clave: cada PutState agrega
	// una versión. Las queries de historial (GetClinicHistory,
	// GetConsentHistory) leen de acá, no del world state, igual que en la red.
	historial map[string][]*queryresult.KeyModification
	// fallas inyectadas: prefijo de clave -> error a devolver. Permiten
	// ejercitar las ramas de error de infraestructura, que son la mayor parte
	// del código no cubierto y las que sostienen una garantía del Proyecto: si
	// el world state falla, la operación tiene que abortar, nunca continuar a
	// medias y dejar un registro inconsistente.
	fallaGet   map[string]error
	fallaPut   map[string]error
	fallaRango error
	fallaEvent error
}

func newHarness(t *testing.T) *harness {
	t.Helper()

	h := &harness{
		t:         t,
		sc:        &consent.SmartContract{},
		state:     map[string][]byte{},
		ident:     &mocks.ClientIdentity{MspID: orgA},
		now:       time.Date(2026, 8, 1, 12, 0, 0, 0, time.UTC),
		txID:      "tx-0",
		eventos:   map[string][]byte{},
		historial: map[string][]*queryresult.KeyModification{},
		fallaGet:  map[string]error{},
		fallaPut:  map[string]error{},
	}

	stub := &mocks.ChaincodeStub{}
	stub.GetStateCalls(func(key string) ([]byte, error) {
		if err := h.falla(h.fallaGet, key); err != nil {
			return nil, err
		}
		return h.state[key], nil
	})
	stub.PutStateCalls(func(key string, value []byte) error {
		if err := h.falla(h.fallaPut, key); err != nil {
			return err
		}
		h.state[key] = append([]byte(nil), value...)
		h.historial[key] = append(h.historial[key], &queryresult.KeyModification{
			TxId:      h.txID,
			Value:     append([]byte(nil), value...),
			Timestamp: timestamppb.New(h.now),
		})
		return nil
	})
	stub.GetStateByRangeCalls(h.rango)
	stub.GetHistoryForKeyCalls(h.historia)
	stub.GetTxIDCalls(func() string { return h.txID })
	stub.GetTxTimestampCalls(func() (*timestamppb.Timestamp, error) {
		return timestamppb.New(h.now), nil
	})
	stub.SetEventCalls(func(name string, payload []byte) error {
		if h.fallaEvent != nil {
			return h.fallaEvent
		}
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
	if h.fallaRango != nil {
		return nil, h.fallaRango
	}
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

// falla devuelve el error inyectado para una clave, si alguno coincide por
// prefijo.
func (h *harness) falla(tabla map[string]error, key string) error {
	for prefijo, err := range tabla {
		if strings.HasPrefix(key, prefijo) {
			return err
		}
	}
	return nil
}

// romperLectura / romperEscritura inyectan un fallo de world state para las
// claves con ese prefijo. Con prefijo vacío fallan todas.
func (h *harness) romperLectura(prefijo string, err error) *harness {
	h.fallaGet[prefijo] = err
	return h
}

func (h *harness) romperEscritura(prefijo string, err error) *harness {
	h.fallaPut[prefijo] = err
	return h
}

func (h *harness) romperRecorrido(err error) *harness { h.fallaRango = err; return h }
func (h *harness) romperEventos(err error) *harness   { h.fallaEvent = err; return h }

// corromper reemplaza por JSON inválido el valor de las claves con ese prefijo,
// para ejercitar las ramas de deserialización.
func (h *harness) corromper(prefijo string) *harness {
	for k := range h.state {
		if strings.HasPrefix(k, prefijo) {
			h.state[k] = []byte("{no es json")
		}
	}
	return h
}

// historia implementa GetHistoryForKey sobre las versiones acumuladas por
// PutState. Una clave sin escrituras devuelve un iterador vacío, que es lo que
// hace el peer: no es un error, es un historial de longitud cero.
func (h *harness) historia(key string) (shim.HistoryQueryIteratorInterface, error) {
	mods := h.historial[key]
	i := 0
	return &historyIterator{
		hasNext: func() bool { return i < len(mods) },
		next: func() (*queryresult.KeyModification, error) {
			m := mods[i]
			i++
			return m, nil
		},
	}, nil
}

// historyIterator es un fake a mano y no un mock generado: la interfaz tiene
// tres métodos y escribirla acá evita regenerar counterfeiter para el único
// iterador que faltaba.
type historyIterator struct {
	hasNext func() bool
	next    func() (*queryresult.KeyModification, error)
}

func (it *historyIterator) HasNext() bool                               { return it.hasNext() }
func (it *historyIterator) Next() (*queryresult.KeyModification, error) { return it.next() }
func (it *historyIterator) Close() error                                { return nil }

// borrarEstado simula un DelState para poder ejercitar las ramas de lectura
// sobre una clave inexistente sin tener que construir un harness aparte.
func (h *harness) borrarEstado(key string) *harness {
	delete(h.state, key)
	return h
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
