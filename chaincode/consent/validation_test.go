package consent_test

// Contrato de entrada del chaincode: qué argumentos rechaza y por qué.
//
// Un chaincode no puede confiar en que la capa de aplicación valide por él. Es
// la última frontera antes del ledger, y lo que acepte queda escrito de forma
// inmutable: un activo con el identificador de paciente vacío, o un
// consentimiento con un vencimiento que no se puede interpretar, no se corrigen
// después. Estos casos fijan esa frontera.

import (
	"testing"
	"time"
)

// --- Emisión -----------------------------------------------------------------

func TestLaEmisionExigeTodosSusArgumentos(t *testing.T) {
	// Ninguno de los cuatro es opcional: sin tipo de recurso el consentimiento
	// no puede discriminar, sin CID el contenido es irrecuperable, y sin
	// referencia de paciente el activo no se puede asociar a nadie.
	casos := []struct {
		nombre                  string
		id, tipo, cid, paciente string
	}{
		{"sin identificador del recurso", "", "Observation", "cid-1", "paciente-1"},
		{"sin tipo de recurso", "obs-1", "", "cid-1", "paciente-1"},
		{"sin CID", "obs-1", "Observation", "", "paciente-1"},
		{"sin referencia de paciente", "obs-1", "Observation", "cid-1", ""},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			h := newHarness(t).registrar(orgA)
			if err := h.as(orgA).sc.EmitAsset(h.ctx, c.id, c.tipo, c.cid, c.paciente); err == nil {
				t.Fatal("debe rechazarse")
			}
		})
	}
}

func TestNoSePuedeEmitirDosVecesElMismoActivo(t *testing.T) {
	// La reemisión sobre el mismo identificador sobrescribiría la referencia
	// anterior, que es justamente lo que la inmutabilidad debe impedir.
	h := newHarness(t).registrar(orgA)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")

	err := h.as(orgA).sc.EmitAsset(h.ctx, "obs-1", "Observation", "cid-distinto", "paciente-2")
	if err == nil {
		t.Fatal("un identificador ya emitido debe rechazarse, no sobrescribirse")
	}

	// Y el activo original debe quedar intacto.
	got, err := h.as(orgA).sc.GetAsset(h.ctx, "obs-1")
	if err != nil {
		t.Fatalf("el activo original debe seguir existiendo: %v", err)
	}
	if got.PatientIDHash != "paciente-1" {
		t.Fatalf("el intento de reemisión alteró el activo: %+v", got)
	}
}

// --- Consentimiento ----------------------------------------------------------

func TestElOtorgamientoExigePacienteYDestinatario(t *testing.T) {
	casos := []struct{ nombre, paciente, hacia string }{
		{"sin referencia de paciente", "", orgB},
		{"sin destinatario", "paciente-1", ""},
	}
	for _, c := range casos {
		t.Run(c.nombre, func(t *testing.T) {
			h := newHarness(t).registrar(orgA, orgB)
			vence := enUnAnio(h.now).Format(rfc3339)
			if err := h.as(orgA).sc.GrantConsent(h.ctx, c.paciente, c.hacia, `["Observation"]`, vence); err == nil {
				t.Fatal("debe rechazarse")
			}
		})
	}
}

func TestElAlcanceDebeSerUnArrayJSONDeStrings(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	vence := enUnAnio(h.now).Format(rfc3339)

	for _, alcance := range []string{"Observation", "{}", "[1,2]", "", "[\"Observation\""} {
		if err := h.as(orgA).sc.GrantConsent(h.ctx, "paciente-1", orgB, alcance, vence); err == nil {
			t.Fatalf("un alcance mal formado debe rechazarse: %q", alcance)
		}
	}
}

func TestElVencimientoDebeSerRFC3339(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)

	for _, vence := range []string{"mañana", "2026-13-45", "01/08/2027", ""} {
		if err := h.as(orgA).sc.GrantConsent(h.ctx, "paciente-1", orgB, `["Observation"]`, vence); err == nil {
			t.Fatalf("un vencimiento no interpretable debe rechazarse: %q", vence)
		}
	}
}

func TestLaRevocacionValidaSusArgumentos(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))

	if err := h.as(orgA).sc.RevokeConsent(h.ctx, "", orgB, `["Observation"]`); err == nil {
		t.Fatal("una revocación sin referencia de paciente debe rechazarse")
	}
	if err := h.as(orgA).sc.RevokeConsent(h.ctx, "paciente-1", "", `["Observation"]`); err == nil {
		t.Fatal("una revocación sin destinatario debe rechazarse")
	}
	if err := h.as(orgA).sc.RevokeConsent(h.ctx, "paciente-1", orgB, "no es json"); err == nil {
		t.Fatal("una revocación con alcance mal formado debe rechazarse")
	}
}

func TestNoSePuedeRevocarUnConsentimientoInexistente(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)

	if err := h.as(orgA).sc.RevokeConsent(h.ctx, "paciente-1", orgB, `["Observation"]`); err == nil {
		t.Fatal("revocar algo que nunca se otorgó debe fallar, no ser una operación vacía")
	}
}

func TestElOtorgamientoConservaLaFechaDeCreacionOriginal(t *testing.T) {
	// Reotorgar amplía el alcance pero no reinicia la antigüedad del
	// consentimiento: la fecha de creación es parte de la trazabilidad.
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))

	primero, err := h.as(orgA).sc.GetConsent(h.ctx, "paciente-1", orgB)
	if err != nil {
		t.Fatalf("GetConsent falló: %v", err)
	}

	h.at(h.now.Add(48 * time.Hour)).tx("tx-reotorga")
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation", "Condition"}, enUnAnio(h.now))

	segundo, err := h.as(orgA).sc.GetConsent(h.ctx, "paciente-1", orgB)
	if err != nil {
		t.Fatalf("GetConsent falló: %v", err)
	}
	if segundo.CreatedAt != primero.CreatedAt {
		t.Fatalf("la fecha de creación no debe reiniciarse: %q -> %q", primero.CreatedAt, segundo.CreatedAt)
	}
	if len(segundo.ResourceTypes) != 2 {
		t.Fatalf("el alcance debía ampliarse a dos tipos: %v", segundo.ResourceTypes)
	}
}

// --- Registro de instituciones -----------------------------------------------

func TestElAltaExigeMspIDYNombre(t *testing.T) {
	h := newHarness(t).registrar(orgA)

	if err := h.as(orgA).sc.RegisterClinic(h.ctx, "", "Clínica B", "b.example.com", "peer0.b:7051"); err == nil {
		t.Fatal("un alta sin MSP ID debe rechazarse")
	}
	if err := h.as(orgA).sc.RegisterClinic(h.ctx, orgB, "", "b.example.com", "peer0.b:7051"); err == nil {
		t.Fatal("un alta sin nombre debe rechazarse")
	}
}

func TestLaBajaExigeQueLaClinicaExistaYNoEsteYaDeBaja(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgC)

	if err := h.as(orgA).sc.DeactivateClinic(h.ctx, "ClinicaFantasmaMSP", "motivo"); err == nil {
		t.Fatal("dar de baja una clínica no registrada debe fallar")
	}

	if err := h.as(orgA).tx("tx-baja").sc.DeactivateClinic(h.ctx, orgC, "fin de convenio"); err != nil {
		t.Fatalf("la primera baja debe funcionar: %v", err)
	}
	if err := h.as(orgA).tx("tx-baja-2").sc.DeactivateClinic(h.ctx, orgC, "otra vez"); err == nil {
		t.Fatal("una segunda baja sobre la misma clínica debe rechazarse")
	}
}

// --- Evaluación de acceso ----------------------------------------------------

func TestLaEvaluacionDeAccesoValidaSuArgumento(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)

	if _, err := h.as(orgB).sc.CheckAccess(h.ctx, ""); err == nil {
		t.Fatal("una evaluación sin identificador de recurso debe rechazarse")
	}
	if _, err := h.as(orgB).sc.CheckAccess(h.ctx, "obs-inexistente"); err == nil {
		t.Fatal("evaluar el acceso a un activo que no existe debe fallar")
	}
}
