package consent_test

// Tests de la política de acceso: es el corazón del trabajo y lo que un jurado
// va a querer ver demostrado, no descrito. Cada test corresponde a una
// afirmación que hacemos en la tesis sobre el comportamiento del bus.

import (
	"strings"
	"testing"
	"time"
)

func TestAccesoSinConsentimientoSeDeniega(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")

	decision, motivo := h.as(orgB).tx("tx-1").permitido("obs-1")

	if decision != "DENY" {
		t.Fatalf("deny por defecto: se esperaba DENY, se obtuvo %s", decision)
	}
	if motivo != "no existe consentimiento" {
		t.Errorf("motivo inesperado: %q", motivo)
	}
	if h.huboEvento("AccessPermitted") {
		t.Error("un DENY no debe disparar AccessPermitted: dispararía la entrega de clave")
	}
}

func TestAccesoConConsentimientoVigenteSePermite(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))

	decision, _ := h.as(orgB).tx("tx-1").permitido("obs-1")

	if decision != "PERMIT" {
		t.Fatalf("se esperaba PERMIT, se obtuvo %s", decision)
	}
	if !h.huboEvento("AccessPermitted") {
		t.Error("un PERMIT tiene que disparar AccessPermitted: es lo que gatilla la entrega de clave")
	}
}

func TestConsentimientoNoAlcanzaAOtroTipoDeRecurso(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")
	h.as(orgA).emitir("diag-1", "DiagnosticReport", "paciente-1")
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))

	if d, _ := h.as(orgB).tx("tx-1").permitido("obs-1"); d != "PERMIT" {
		t.Fatalf("el tipo consentido debía permitirse, se obtuvo %s", d)
	}
	d, motivo := h.as(orgB).tx("tx-2").permitido("diag-1")
	if d != "DENY" {
		t.Fatalf("un tipo no consentido debe denegarse, se obtuvo %s", d)
	}
	if motivo != "resource type no autorizado por el consentimiento" {
		t.Errorf("motivo inesperado: %q", motivo)
	}
}

func TestConsentimientoNoAlcanzaAOtroPaciente(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")
	h.as(orgA).emitir("obs-2", "Observation", "paciente-2")
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))

	if d, _ := h.as(orgB).tx("tx-2").permitido("obs-2"); d != "DENY" {
		t.Fatalf("el consentimiento de un paciente no debe alcanzar a otro, se obtuvo %s", d)
	}
}

func TestConsentimientoVencidoSeDeniega(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, h.now.AddDate(0, 0, 1))

	// Un día y medio después: el consentimiento venció.
	h.at(h.now.AddDate(0, 0, 2))
	d, motivo := h.as(orgB).tx("tx-1").permitido("obs-1")

	if d != "DENY" {
		t.Fatalf("se esperaba DENY por vencimiento, se obtuvo %s", d)
	}
	if motivo != "consentimiento vencido" {
		t.Errorf("motivo inesperado: %q", motivo)
	}
}

func TestConsentimientoRevocadoSeDeniega(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))

	if err := h.as(orgA).sc.RevokeConsent(h.ctx, "paciente-1", orgB, "[]"); err != nil {
		t.Fatalf("no se pudo revocar: %v", err)
	}

	d, motivo := h.as(orgB).tx("tx-1").permitido("obs-1")
	if d != "DENY" {
		t.Fatalf("se esperaba DENY tras revocar, se obtuvo %s", d)
	}
	if motivo != "consentimiento revocado" {
		t.Errorf("motivo inesperado: %q", motivo)
	}
}

// Una institución dada de baja no puede acceder aunque le quede un
// consentimiento vigente sin revocar. Es el caso de carrera entre la baja de
// membresía y la revocación de consentimientos.
func TestClinicaDadaDeBajaNoAccedeAunqueTengaConsentimiento(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))

	if d, _ := h.as(orgB).tx("tx-1").permitido("obs-1"); d != "PERMIT" {
		t.Fatalf("precondición: debía permitir antes de la baja, se obtuvo %s", d)
	}

	if err := h.as(orgA).sc.DeactivateClinic(h.ctx, orgB, "fin de convenio"); err != nil {
		t.Fatalf("no se pudo dar de baja: %v", err)
	}

	d, motivo := h.as(orgB).tx("tx-2").permitido("obs-1")
	if d != "DENY" {
		t.Fatalf("una clínica dada de baja no debe acceder, se obtuvo %s", d)
	}
	if !strings.Contains(motivo, "no habilitada en el bus") {
		t.Errorf("motivo inesperado: %q", motivo)
	}
}

// El intento de una org dada de baja se registra en la auditoría: es
// justamente lo que interesa poder demostrar después, así que se resuelve como
// DENY auditado y no como error.
func TestIntentoDeOrgNoHabilitadaQuedaAuditado(t *testing.T) {
	h := newHarness(t).registrar(orgA)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")

	h.as(orgC).tx("tx-9").permitido("obs-1") // orgC nunca se registró

	log := h.ultimoLog()
	if log.Decision != "DENY" || log.RequesterOrg != orgC {
		t.Fatalf("la auditoría no registró el intento: %+v", log)
	}
	if log.FhirResourceID != "obs-1" {
		t.Errorf("la auditoría debe decir qué recurso se pidió, dijo %q", log.FhirResourceID)
	}
}

// El tipo y el paciente salen del activo, no de quien pide. Es la propiedad que
// impide elegir valores que hagan coincidir un consentimiento que no cubre el
// recurso que después se descarga.
func TestLaAuditoriaDerivaTipoYPacienteDelActivo(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("diag-7", "DiagnosticReport", "paciente-42")

	h.as(orgB).tx("tx-1").permitido("diag-7")

	log := h.ultimoLog()
	if log.ResourceType != "DiagnosticReport" {
		t.Errorf("ResourceType debía salir del activo, salió %q", log.ResourceType)
	}
	if log.PatientIDHash != "paciente-42" {
		t.Errorf("PatientIDHash debía salir del activo, salió %q", log.PatientIDHash)
	}
	if log.AssetOwnerOrg != orgA {
		t.Errorf("AssetOwnerOrg debía ser el emisor, fue %q", log.AssetOwnerOrg)
	}
}

func TestAccesoAActivoInexistenteEsError(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)

	if _, err := h.as(orgB).sc.CheckAccess(h.ctx, "no-existe"); err == nil {
		t.Fatal("pedir un activo inexistente debe fallar, no producir un DENY auditado")
	}
	if len(h.clavesConPrefijo("ACCESSLOG_")) != 0 {
		t.Error("no debe quedar auditoría de un recurso que no existe")
	}
}

// Cada evaluación deja su propia entrada: dos accesos al mismo recurso son dos
// registros, no uno sobreescrito.
func TestCadaEvaluacionDejaSuPropioRegistro(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")

	h.as(orgB).tx("tx-1").permitido("obs-1")
	h.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))
	h.as(orgB).tx("tx-2").permitido("obs-1")

	logs, err := h.sc.GetAllAccessLogs(h.ctx)
	if err != nil {
		t.Fatalf("GetAllAccessLogs falló: %v", err)
	}
	if len(logs) != 2 {
		t.Fatalf("se esperaban 2 registros de auditoría, hay %d", len(logs))
	}
	var permit, deny int
	for _, l := range logs {
		switch l.Decision {
		case "PERMIT":
			permit++
		case "DENY":
			deny++
		}
	}
	if permit != 1 || deny != 1 {
		t.Errorf("se esperaba 1 PERMIT y 1 DENY, hubo %d y %d", permit, deny)
	}
}

var _ = time.Now
