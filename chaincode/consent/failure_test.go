package consent_test

// Propagación de fallos de infraestructura.
//
// Qué se prueba acá y por qué importa. El Proyecto apoya dos garantías en el
// ledger: que todo acceso queda auditado y que ningún registro se altera
// después de emitido. Las dos se caen de la misma manera, y en silencio, si el
// chaincode continúa cuando el world state falla: una emisión que no pudo
// escribir pero devuelve éxito deja a la institución creyendo que el activo
// existe, y una evaluación de acceso que no pudo registrar la auditoría deja un
// acceso sin rastro.
//
// Por eso cada operación tiene que abortar y propagar el error, nunca
// degradarse. Estos casos inyectan el fallo en la capa de abajo y verifican
// exactamente eso.

import (
	"errors"
	"strings"
	"testing"
)

var errLedger = errors.New("world state no disponible")

// --- Lecturas ----------------------------------------------------------------

func TestUnFalloDeLecturaAbortaLaEmision(t *testing.T) {
	h := newHarness(t).registrar(orgA)
	h.romperLectura("CLINIC_", errLedger)

	err := h.as(orgA).sc.EmitAsset(h.ctx, "obs-1", "Observation", "cid-1", "paciente-1")
	if err == nil {
		t.Fatal("si no se puede verificar que la institución está activa, la emisión debe abortar")
	}
}

func TestUnFalloDeLecturaAbortaElOtorgamiento(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.romperLectura("CONSENT_", errLedger)

	err := h.as(orgA).sc.GrantConsent(h.ctx, "paciente-1", orgB, `["Observation"]`, enUnAnio(h.now).Format(rfc3339))
	if err == nil {
		t.Fatal("si no se puede leer el consentimiento previo, el otorgamiento debe abortar")
	}
}

func TestUnFalloDeLecturaAbortaLaEvaluacionDeAcceso(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1").
		otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))
	h.romperLectura("ASSET_", errLedger)

	if _, err := h.as(orgB).sc.CheckAccess(h.ctx, "obs-1"); err == nil {
		t.Fatal("sin poder leer el activo no se puede decidir el acceso: debe abortar")
	}
}

func TestUnFalloDeLecturaAbortaLasConsultas(t *testing.T) {
	h := newHarness(t).registrar(orgA)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1")
	h.romperLectura("", errLedger)

	if _, err := h.as(orgA).sc.GetAsset(h.ctx, "obs-1"); err == nil {
		t.Fatal("GetAsset debe propagar el fallo de lectura")
	}
	if _, err := h.as(orgA).sc.GetClinic(h.ctx, orgA); err == nil {
		t.Fatal("GetClinic debe propagar el fallo de lectura")
	}
	if _, err := h.as(orgA).sc.GetConsent(h.ctx, "paciente-1", orgB); err == nil {
		t.Fatal("GetConsent debe propagar el fallo de lectura")
	}
	if _, err := h.as(orgA).sc.GetAccessLog(h.ctx, "tx-0"); err == nil {
		t.Fatal("GetAccessLog debe propagar el fallo de lectura")
	}
}

func TestUnFalloDelRecorridoAbortaLosListados(t *testing.T) {
	h := newHarness(t).registrar(orgA)
	h.romperRecorrido(errLedger)

	if _, err := h.as(orgA).sc.GetAllAssets(h.ctx); err == nil {
		t.Fatal("GetAllAssets debe propagar el fallo del recorrido")
	}
	if _, err := h.as(orgA).sc.GetAllClinics(h.ctx); err == nil {
		t.Fatal("GetAllClinics debe propagar el fallo del recorrido")
	}
	if _, err := h.as(orgA).sc.GetAllConsents(h.ctx); err == nil {
		t.Fatal("GetAllConsents debe propagar el fallo del recorrido")
	}
}

// --- Escrituras --------------------------------------------------------------

func TestUnFalloDeEscrituraAbortaLaEmision(t *testing.T) {
	h := newHarness(t).registrar(orgA)
	h.romperEscritura("ASSET_", errLedger)

	if err := h.as(orgA).sc.EmitAsset(h.ctx, "obs-1", "Observation", "cid-1", "paciente-1"); err == nil {
		t.Fatal("una emisión que no pudo escribirse no debe reportar éxito")
	}
	// Y no debe quedar rastro del activo: el fallo tiene que ser total.
	if _, err := h.as(orgA).sc.GetAsset(h.ctx, "obs-1"); err == nil {
		t.Fatal("tras una emisión fallida el activo no debe existir")
	}
}

func TestUnFalloDeEscrituraAbortaElOtorgamientoYLaRevocacion(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	h.romperEscritura("CONSENT_", errLedger)

	err := h.as(orgA).sc.GrantConsent(h.ctx, "paciente-1", orgB, `["Observation"]`, enUnAnio(h.now).Format(rfc3339))
	if err == nil {
		t.Fatal("un otorgamiento que no pudo escribirse no debe reportar éxito")
	}

	// La revocación sobre un consentimiento que sí existe, con la escritura rota.
	h2 := newHarness(t).registrar(orgA, orgB)
	h2.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h2.now))
	h2.romperEscritura("CONSENT_", errLedger)
	if err := h2.as(orgA).sc.RevokeConsent(h2.ctx, "paciente-1", orgB, `["Observation"]`); err == nil {
		t.Fatal("una revocación que no pudo escribirse no debe reportar éxito")
	}
}

func TestUnFalloDeEscrituraAbortaElAltaYLaBaja(t *testing.T) {
	h := newHarness(t).registrar(orgA)
	h.romperEscritura("CLINIC_", errLedger)

	if err := h.as(orgA).sc.RegisterClinic(h.ctx, orgB, "Clínica B", "b.example.com", "peer0.b:7051"); err == nil {
		t.Fatal("un alta que no pudo escribirse no debe reportar éxito")
	}

	h2 := newHarness(t).registrar(orgA, orgC)
	h2.romperEscritura("CLINIC_", errLedger)
	if err := h2.as(orgA).sc.DeactivateClinic(h2.ctx, orgC, "fin de convenio"); err == nil {
		t.Fatal("una baja que no pudo escribirse no debe reportar éxito")
	}
}

func TestUnFalloAlRegistrarLaAuditoriaAbortaElAcceso(t *testing.T) {
	// Es el caso más delicado: si la auditoría no se puede escribir, el acceso
	// no debe concederse. Un acceso sin rastro es exactamente lo que el
	// registro inmutable existe para impedir.
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1").
		otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))
	h.romperEscritura("ACCESSLOG_", errLedger)

	if _, err := h.as(orgB).sc.CheckAccess(h.ctx, "obs-1"); err == nil {
		t.Fatal("sin poder dejar constancia en la auditoría, el acceso debe abortar")
	}
}

func TestUnFalloAlEmitirElEventoAbortaLaOperacion(t *testing.T) {
	// El evento es lo que notifica al resto de la red. Si no se puede emitir,
	// la transacción queda invisible para los suscriptores y es preferible
	// abortarla a dejar el ledger y los observadores desincronizados.
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1").
		otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))
	h.romperEventos(errLedger)

	if _, err := h.as(orgB).sc.CheckAccess(h.ctx, "obs-1"); err == nil {
		t.Fatal("un acceso permitido que no pudo emitir su evento debe abortar")
	}
}

// --- Estado corrupto ---------------------------------------------------------

func TestUnRegistroCorruptoSeReportaComoError(t *testing.T) {
	// Un valor que no deserializa no puede tratarse como ausente: devolver el
	// cero del struct haría pasar por activa a una institución dada de baja.
	h := newHarness(t).registrar(orgA, orgB)
	h.as(orgA).emitir("obs-1", "Observation", "paciente-1").
		otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h.now))

	h.corromper("CLINIC_")
	if err := h.as(orgA).sc.EmitAsset(h.ctx, "obs-2", "Observation", "cid-2", "paciente-1"); err == nil {
		t.Fatal("con el registro de instituciones corrupto la emisión debe abortar")
	}
	if _, err := h.as(orgA).sc.GetClinic(h.ctx, orgA); err == nil {
		t.Fatal("GetClinic debe propagar el error de deserialización")
	}
	if _, err := h.as(orgA).sc.GetAllClinics(h.ctx); err == nil {
		t.Fatal("GetAllClinics debe propagar el error de deserialización")
	}

	h2 := newHarness(t).registrar(orgA, orgB)
	h2.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h2.now))
	h2.corromper("CONSENT_")
	if _, err := h2.as(orgA).sc.GetConsent(h2.ctx, "paciente-1", orgB); err == nil {
		t.Fatal("GetConsent debe propagar el error de deserialización")
	}
	if _, err := h2.as(orgA).sc.GetAllConsents(h2.ctx); err == nil {
		t.Fatal("GetAllConsents debe propagar el error de deserialización")
	}
}

func TestUnHistorialCorruptoSeReportaComoError(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgC)

	// Se corrompe la versión guardada en el historial, no el world state: la
	// consulta puntual sigue funcionando y la del historial debe fallar.
	for k, mods := range h.historial {
		if strings.HasPrefix(k, "CLINIC_") {
			for _, m := range mods {
				m.Value = []byte("{no es json")
			}
		}
	}
	if _, err := h.as(orgA).sc.GetClinicHistory(h.ctx, orgC); err == nil {
		t.Fatal("GetClinicHistory debe propagar el error de deserialización")
	}

	h2 := newHarness(t).registrar(orgA, orgB)
	h2.as(orgA).otorgar("paciente-1", orgB, []string{"Observation"}, enUnAnio(h2.now))
	for k, mods := range h2.historial {
		if strings.HasPrefix(k, "CONSENT_") {
			for _, m := range mods {
				m.Value = []byte("{no es json")
			}
		}
	}
	if _, err := h2.as(orgA).sc.GetConsentHistory(h2.ctx, "paciente-1", orgB); err == nil {
		t.Fatal("GetConsentHistory debe propagar el error de deserialización")
	}
}
