package consent_test

// Invariantes de consentimiento y del registro de instituciones. Son reglas de
// autorización: lo que se prueba acá no es que el código corra, sino que
// RECHACE lo que tiene que rechazar.

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNoSePuedeOtorgarConsentimientoVacio(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)

	err := h.as(orgA).sc.GrantConsent(h.ctx, "paciente-1", orgB, "[]", enUnAnio(h.now).Format(rfc3339))
	if err == nil {
		t.Fatal("mínimo privilegio: un consentimiento sin resource types debe rechazarse")
	}
}

func TestNoSePuedeOtorgarConsentimientoYaVencido(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)

	pasado := h.now.AddDate(0, 0, -1).Format(rfc3339)
	if err := h.as(orgA).sc.GrantConsent(h.ctx, "paciente-1", orgB, `["Observation"]`, pasado); err == nil {
		t.Fatal("un consentimiento con expiry en el pasado debe rechazarse")
	}
}

func TestUnaOrgNoPuedeOtorgarseConsentimientoASiMisma(t *testing.T) {
	h := newHarness(t).registrar(orgA)

	err := h.as(orgA).sc.GrantConsent(h.ctx, "paciente-1", orgA, `["Observation"]`, enUnAnio(h.now).Format(rfc3339))
	if err == nil {
		t.Fatal("una org no puede otorgarse consentimiento a sí misma")
	}
}

func TestNoSePuedeOtorgarConsentimientoAUnaOrgDadaDeBaja(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	if err := h.as(orgA).sc.DeactivateClinic(h.ctx, orgB, "se fue"); err != nil {
		t.Fatalf("precondición: %v", err)
	}

	err := h.as(orgA).sc.GrantConsent(h.ctx, "paciente-1", orgB, `["Observation"]`, enUnAnio(h.now).Format(rfc3339))
	if err == nil {
		t.Fatal("otorgar a una institución dada de baja dejaría un consentimiento vigente hacia alguien que ya no está")
	}
}

// Solo la org que otorgó puede revocar: si cualquiera pudiera, una institución
// podría cortarle el acceso a otra sobre pacientes que no son suyos.
func TestSoloElOtorganteRevoca(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB, orgC)
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))

	if err := h.as(orgC).sc.RevokeConsent(h.ctx, "paciente-1", orgB, "[]"); err == nil {
		t.Fatal("una org ajena no debe poder revocar un consentimiento que no otorgó")
	}
	if err := h.as(orgA).sc.RevokeConsent(h.ctx, "paciente-1", orgB, "[]"); err != nil {
		t.Fatalf("el otorgante sí debe poder revocar: %v", err)
	}
}

// La revocación parcial saca un tipo y deja el resto vivo.
func TestRevocacionParcialDejaElRestoVigente(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")
	h.as(orgA).emitir("cond-1", "Condition", "paciente-1")
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation", "Condition"}, enUnAnio(h.now))

	if err := h.as(orgA).sc.RevokeConsent(h.ctx, "paciente-1", orgB, `["Observation"]`); err != nil {
		t.Fatalf("no se pudo revocar parcialmente: %v", err)
	}

	if d, _ := h.as(orgB).tx("tx-1").permitido("obs-1"); d != "DENY" {
		t.Errorf("el tipo revocado debía denegarse, se obtuvo %s", d)
	}
	if d, _ := h.as(orgB).tx("tx-2").permitido("cond-1"); d != "PERMIT" {
		t.Errorf("el tipo no revocado debía seguir permitiendo, se obtuvo %s", d)
	}
}

// La revocación total no borra: deja el registro marcado, y el ledger conserva
// las versiones. Es la base de la auditoría de consentimiento.
func TestRevocarNoBorraElConsentimiento(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))
	if err := h.as(orgA).sc.RevokeConsent(h.ctx, "paciente-1", orgB, "[]"); err != nil {
		t.Fatalf("no se pudo revocar: %v", err)
	}

	c, err := h.sc.GetConsent(h.ctx, "paciente-1", orgB)
	if err != nil {
		t.Fatalf("el consentimiento revocado debe seguir siendo consultable: %v", err)
	}
	if !c.Revoked {
		t.Error("debía quedar marcado como revocado")
	}
	// nil serializaría a JSON null y el schema de contractapi exige array: el
	// bug ya estaba corregido y este test lo fija.
	crudo, _ := json.Marshal(c)
	if strings.Contains(string(crudo), `"ResourceTypes":null`) {
		t.Error("ResourceTypes no puede serializar a null, tiene que ser []")
	}
}

func TestEmitirRequiereClinicaHabilitada(t *testing.T) {
	h := newHarness(t).registrar(orgA)

	if err := h.as(orgC).sc.EmitAsset(h.ctx, "obs-x", "Observation", "QmX", "paciente-1"); err == nil {
		t.Fatal("una org no registrada no debe poder emitir activos")
	}
}

func TestNoSePuedeReemitirElMismoRecurso(t *testing.T) {
	h := newHarness(t).registrar(orgA)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")

	if err := h.sc.EmitAsset(h.ctx, "obs-1", "Observation", "QmOtro", "paciente-1"); err == nil {
		t.Fatal("re-emitir el mismo fhirResourceID debe rechazarse: apuntaría a otro CID")
	}
}

// Arranque en frío: con el registro vacío cualquier miembro del canal puede
// escribir la primera entrada, y la excepción se cierra sola en cuanto hay una
// clínica activa.
func TestElRegistroSeAutocierraTrasLaPrimeraClinica(t *testing.T) {
	h := newHarness(t)

	if err := h.as(orgA).sc.RegisterClinic(h.ctx, orgA, "A", "a.example.com", "peer0:7051"); err != nil {
		t.Fatalf("la primera clínica debe poder registrarse (arranque en frío): %v", err)
	}
	if err := h.as(orgC).sc.RegisterClinic(h.ctx, orgC, "C", "c.example.com", "peer0:7051"); err == nil {
		t.Fatal("con el registro ya poblado, una org no habilitada no debe poder registrarse sola")
	}
	if err := h.as(orgA).sc.RegisterClinic(h.ctx, orgB, "B", "b.example.com", "peer0:7051"); err != nil {
		t.Fatalf("una clínica activa sí debe poder registrar a otra: %v", err)
	}
}

func TestNoSePuedeDarDeBajaDosVeces(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	if err := h.as(orgA).sc.DeactivateClinic(h.ctx, orgB, "primera"); err != nil {
		t.Fatalf("precondición: %v", err)
	}
	if err := h.as(orgA).sc.DeactivateClinic(h.ctx, orgB, "segunda"); err == nil {
		t.Fatal("dar de baja algo ya dado de baja debe rechazarse")
	}
}

const rfc3339 = "2006-01-02T15:04:05Z07:00"
