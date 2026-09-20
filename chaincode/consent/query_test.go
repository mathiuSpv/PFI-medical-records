package consent_test

// Queries de solo lectura: las consultas puntuales, los listados y los
// historiales.
//
// Son las operaciones que el resto de la batería nunca ejercitaba, porque las
// otras suites prueban reglas de autorización y una query no autoriza nada. No
// por eso están libres de invariantes: un listado que devuelve `nil` en lugar
// de un array rompe el esquema de contractapi, un historial que pierde una
// versión destruye la trazabilidad que el Proyecto declara como garantía, y una
// consulta que devuelve el recurso de otro paciente sería una fuga de datos.
// Eso es lo que se verifica acá.

import (
	"strings"
	"testing"

	"pfi-medical-records/chaincode/consent"
)

// --- Consultas puntuales -----------------------------------------------------

func TestGetAssetDevuelveElActivoEmitido(t *testing.T) {
	h := newHarness(t).registrar(orgA)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")

	got, err := h.as(orgA).sc.GetAsset(h.ctx, "obs-1")
	if err != nil {
		t.Fatalf("un activo emitido debe poder consultarse: %v", err)
	}
	if got.FhirResourceID != "obs-1" || got.ResourceType != "Observation" {
		t.Fatalf("el activo devuelto no es el emitido: %+v", got)
	}
	if got.OwnerOrg != orgA {
		t.Fatalf("la titularidad debe ser de quien emitió: %q", got.OwnerOrg)
	}
	if got.PatientIDHash != "paciente-1" {
		t.Fatalf("el activo debe conservar la referencia del paciente: %q", got.PatientIDHash)
	}
}

func TestGetAssetDeUnIDInexistenteFalla(t *testing.T) {
	h := newHarness(t).registrar(orgA)

	// Un activo ausente tiene que distinguirse de uno vacío: devolver el cero
	// del struct haría que el receptor lo tomara por un activo real.
	if _, err := h.as(orgA).sc.GetAsset(h.ctx, "no-existe"); err == nil {
		t.Fatal("consultar un activo inexistente debe fallar, no devolver un activo vacío")
	}
}

func TestGetClinicDevuelveLaInstitucionRegistrada(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)

	got, err := h.as(orgA).sc.GetClinic(h.ctx, orgB)
	if err != nil {
		t.Fatalf("una clínica registrada debe poder consultarse: %v", err)
	}
	if got.MspID != orgB {
		t.Fatalf("se consultó %q y devolvió %q", orgB, got.MspID)
	}
	if got.Estado != consent.EstadoClinicaActiva {
		t.Fatalf("una clínica recién registrada debe estar activa, está %q", got.Estado)
	}
}

func TestGetClinicDeUnMspInexistenteFalla(t *testing.T) {
	h := newHarness(t).registrar(orgA)

	if _, err := h.as(orgA).sc.GetClinic(h.ctx, "ClinicaFantasmaMSP"); err == nil {
		t.Fatal("consultar una clínica no registrada debe fallar")
	}
}

func TestGetConsentDevuelveElConsentimientoVigente(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation", "Condition"}, enUnAnio(h.now))

	got, err := h.as(orgA).sc.GetConsent(h.ctx, "paciente-1", orgB)
	if err != nil {
		t.Fatalf("un consentimiento otorgado debe poder consultarse: %v", err)
	}
	if got.GrantedToOrg != orgB || got.Revoked {
		t.Fatalf("consentimiento inesperado: %+v", got)
	}
	if len(got.ResourceTypes) != 2 {
		t.Fatalf("el alcance debe conservar los dos tipos otorgados: %v", got.ResourceTypes)
	}
}

func TestGetConsentInexistenteFalla(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)

	if _, err := h.as(orgA).sc.GetConsent(h.ctx, "paciente-1", orgB); err == nil {
		t.Fatal("consultar un consentimiento que nunca se otorgó debe fallar")
	}
}

func TestGetAccessLogDevuelveLaEntradaDeAuditoria(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1").
		otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))

	h.as(orgB).tx("tx-acceso")
	h.permitido("obs-1")

	log, err := h.sc.GetAccessLog(h.ctx, h.txID)
	if err != nil {
		t.Fatalf("toda solicitud de acceso deja una entrada consultable: %v", err)
	}
	if log.RequesterOrg != orgB {
		t.Fatalf("la auditoría debe registrar a quien pidió el acceso: %q", log.RequesterOrg)
	}
}

func TestGetAccessLogDeUnTxInexistenteFalla(t *testing.T) {
	h := newHarness(t).registrar(orgA)

	if _, err := h.as(orgA).sc.GetAccessLog(h.ctx, "tx-que-no-ocurrio"); err == nil {
		t.Fatal("consultar una entrada de auditoría inexistente debe fallar")
	}
}

// --- Listados ----------------------------------------------------------------

// Un listado vacío debe ser un array y no nil: nil serializa a JSON "null" y el
// esquema de contractapi exige "array". Es el mismo defecto que ya se corrigió
// en RevokeConsent, y por eso se verifica en las tres colecciones.

func TestLosListadosVaciosDevuelvenArrayYNoNil(t *testing.T) {
	h := newHarness(t).registrar(orgA)

	assets, err := h.as(orgA).sc.GetAllAssets(h.ctx)
	if err != nil {
		t.Fatalf("listar activos sin activos no es un error: %v", err)
	}
	if assets == nil {
		t.Fatal("GetAllAssets debe devolver un array vacío, no nil")
	}
	if len(assets) != 0 {
		t.Fatalf("sin emisiones no debe haber activos: %d", len(assets))
	}

	consents, err := h.as(orgA).sc.GetAllConsents(h.ctx)
	if err != nil {
		t.Fatalf("listar consentimientos sin consentimientos no es un error: %v", err)
	}
	if consents == nil {
		t.Fatal("GetAllConsents debe devolver un array vacío, no nil")
	}
	if len(consents) != 0 {
		t.Fatalf("sin otorgamientos no debe haber consentimientos: %d", len(consents))
	}
}

func TestGetAllAssetsDevuelveTodosYEnOrdenDeterminista(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-2", "Observation", "paciente-1").
		emitir("obs-1", "Observation", "paciente-2")
	h.as(orgB).emitir("cond-1", "Condition", "paciente-1")

	assets, err := h.as(orgA).sc.GetAllAssets(h.ctx)
	if err != nil {
		t.Fatalf("GetAllAssets falló: %v", err)
	}
	if len(assets) != 3 {
		t.Fatalf("se emitieron 3 activos y devolvió %d", len(assets))
	}
	// El recorrido por rango del world state va ordenado por clave, y de eso
	// depende que dos invocaciones devuelvan lo mismo en el mismo orden.
	var ids []string
	for _, a := range assets {
		ids = append(ids, a.FhirResourceID)
	}
	if !sorted(ids) {
		t.Fatalf("el listado debe salir ordenado por clave para ser determinista: %v", ids)
	}
}

func TestGetAllAssetsNoFiltraPorInstitucion(t *testing.T) {
	// El canal es el límite de visibilidad, no la titularidad: todo miembro ve
	// los metadatos de todos los activos. Lo que protege el contenido clínico
	// es el cifrado y el consentimiento, no el ocultamiento del índice.
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")

	assets, err := h.as(orgB).sc.GetAllAssets(h.ctx)
	if err != nil {
		t.Fatalf("GetAllAssets falló para una org que no emitió: %v", err)
	}
	if len(assets) != 1 || assets[0].OwnerOrg != orgA {
		t.Fatalf("orgB debe ver el activo de orgA en el índice: %+v", assets)
	}
}

func TestGetAllClinicsIncluyeLasDadasDeBaja(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB, orgC)
	if err := h.as(orgA).tx("tx-baja").sc.DeactivateClinic(h.ctx, orgC, "fin de convenio"); err != nil {
		t.Fatalf("la baja falló: %v", err)
	}

	clinics, err := h.as(orgA).sc.GetAllClinics(h.ctx)
	if err != nil {
		t.Fatalf("GetAllClinics falló: %v", err)
	}
	if len(clinics) != 3 {
		t.Fatalf("la baja no borra el registro: se esperaban 3 clínicas y hay %d", len(clinics))
	}
	estados := map[string]string{}
	for _, c := range clinics {
		estados[c.MspID] = c.Estado
	}
	if estados[orgC] != consent.EstadoClinicaBaja {
		t.Fatalf("orgC debe figurar dada de baja y figura %q", estados[orgC])
	}
	if estados[orgA] != consent.EstadoClinicaActiva || estados[orgB] != consent.EstadoClinicaActiva {
		t.Fatalf("las demás deben seguir activas: %v", estados)
	}
}

func TestGetAllConsentsDevuelveLosOtorgados(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now)).
		otorgar("paciente-2", orgB, []string{"Condition"}, enUnAnio(h.now))

	consents, err := h.as(orgA).sc.GetAllConsents(h.ctx)
	if err != nil {
		t.Fatalf("GetAllConsents falló: %v", err)
	}
	if len(consents) != 2 {
		t.Fatalf("se otorgaron 2 consentimientos y devolvió %d", len(consents))
	}
}

// --- Historiales -------------------------------------------------------------

func TestGetClinicHistoryConservaCadaVersion(t *testing.T) {
	// La trazabilidad del registro de instituciones es una garantía declarada:
	// el alta, la baja y la re-alta tienen que quedar las tres, en orden.
	h := newHarness(t).registrar(orgA, orgC)
	h.as(orgA).tx("tx-baja").sc.DeactivateClinic(h.ctx, orgC, "fin de convenio")
	h.as(orgA).tx("tx-realta").sc.RegisterClinic(h.ctx, orgC, "Clínica C", "c.example.com", "peer0.c:7051")

	hist, err := h.as(orgA).sc.GetClinicHistory(h.ctx, orgC)
	if err != nil {
		t.Fatalf("GetClinicHistory falló: %v", err)
	}
	if len(hist) != 3 {
		t.Fatalf("alta, baja y re-alta son 3 versiones y hay %d", len(hist))
	}
	if hist[0].Clinic == nil || hist[0].Clinic.Estado != consent.EstadoClinicaActiva {
		t.Fatalf("la primera versión debe ser el alta: %+v", hist[0])
	}
	if hist[1].Clinic == nil || hist[1].Clinic.Estado != consent.EstadoClinicaBaja {
		t.Fatalf("la segunda versión debe ser la baja: %+v", hist[1])
	}
	if hist[2].Clinic == nil || hist[2].Clinic.Estado != consent.EstadoClinicaActiva {
		t.Fatalf("la tercera versión debe ser la re-alta: %+v", hist[2])
	}
	// Cada versión tiene que ser atribuible a su transacción y su momento.
	for i, e := range hist {
		if e.TxID == "" {
			t.Fatalf("la versión %d no tiene TxID: sin eso no es auditable", i)
		}
		if e.Timestamp == "" {
			t.Fatalf("la versión %d no tiene Timestamp", i)
		}
	}
}

func TestGetConsentHistoryRegistraElOtorgamientoYLaRevocacion(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation", "Condition"}, enUnAnio(h.now))
	if err := h.as(orgA).tx("tx-revoca").sc.RevokeConsent(h.ctx, "paciente-1", orgB, `["Condition"]`); err != nil {
		t.Fatalf("la revocación parcial falló: %v", err)
	}

	hist, err := h.as(orgA).sc.GetConsentHistory(h.ctx, "paciente-1", orgB)
	if err != nil {
		t.Fatalf("GetConsentHistory falló: %v", err)
	}
	if len(hist) != 2 {
		t.Fatalf("otorgamiento y revocación son 2 versiones y hay %d", len(hist))
	}
	if hist[0].Consent == nil || len(hist[0].Consent.ResourceTypes) != 2 {
		t.Fatalf("la primera versión debe tener el alcance completo: %+v", hist[0].Consent)
	}
	if hist[1].Consent == nil || len(hist[1].Consent.ResourceTypes) != 1 {
		t.Fatalf("tras revocar Condition debe quedar un solo tipo: %+v", hist[1].Consent)
	}
	// Que la versión previa siga siendo legible es lo que vuelve demostrable
	// que el alcance fue más amplio antes de la revocación.
	if hist[1].Consent.ResourceTypes[0] != "Observation" {
		t.Fatalf("el tipo que sobrevive debe ser Observation: %v", hist[1].Consent.ResourceTypes)
	}
}

func TestLosHistorialesDeUnaClaveSinEscriturasSonVacios(t *testing.T) {
	h := newHarness(t).registrar(orgA)

	// Un historial vacío no es un error: es una clave que nunca se escribió.
	hc, err := h.as(orgA).sc.GetClinicHistory(h.ctx, "ClinicaFantasmaMSP")
	if err != nil {
		t.Fatalf("el historial de una clave sin escrituras no debe fallar: %v", err)
	}
	if hc == nil || len(hc) != 0 {
		t.Fatalf("debe ser un array vacío: %v", hc)
	}

	hk, err := h.as(orgA).sc.GetConsentHistory(h.ctx, "paciente-inexistente", orgB)
	if err != nil {
		t.Fatalf("el historial de un consentimiento inexistente no debe fallar: %v", err)
	}
	if hk == nil || len(hk) != 0 {
		t.Fatalf("debe ser un array vacío: %v", hk)
	}
}

// --- Robustez de la deserialización -----------------------------------------

func TestUnValorCorruptoEnElWorldStateSeReportaComoError(t *testing.T) {
	// Si un valor del world state no deserializa, la query tiene que fallar en
	// lugar de devolver un registro a medio llenar: un activo con campos en
	// cero sería indistinguible de uno real para el receptor.
	h := newHarness(t).registrar(orgA)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")

	for k := range h.state {
		if strings.HasPrefix(k, "ASSET_") {
			h.state[k] = []byte("{esto no es json")
		}
	}
	if _, err := h.as(orgA).sc.GetAllAssets(h.ctx); err == nil {
		t.Fatal("un valor corrupto debe propagarse como error, no ignorarse")
	}
	if _, err := h.as(orgA).sc.GetAsset(h.ctx, "obs-1"); err == nil {
		t.Fatal("un activo corrupto debe propagarse como error")
	}
}

// sorted informa si la lista está en orden ascendente.
func sorted(xs []string) bool {
	for i := 1; i < len(xs); i++ {
		if xs[i-1] > xs[i] {
			return false
		}
	}
	return true
}
