package consent_test

// Tests de PublishAssetRef: la referencia que el BFF asciende al canal nacional
// cuando un activo cruza una frontera jurisdiccional. El harness tiene un único
// world state, así que acá modela "el canal nacional recibiendo la referencia".

import (
	"errors"
	"testing"
)

// publicarRef publica una referencia como la org que esté firmando.
func (h *harness) publicarRef(id, tipo, paciente, origen string) error {
	return h.sc.PublishAssetRef(h.ctx, id, tipo, "QmCID"+id, paciente, origen)
}

func TestPublishAssetRefCreaReferencia(t *testing.T) {
	h := newHarness(t).registrar(orgA).as(orgA)
	if err := h.publicarRef("obs-1", "Observation", "paciente-1", "canal-caba"); err != nil {
		t.Fatalf("publicarRef falló: %v", err)
	}
	a, err := h.sc.GetAsset(h.ctx, "obs-1")
	if err != nil {
		t.Fatalf("GetAsset: %v", err)
	}
	if a.OwnerOrg != orgA {
		t.Errorf("OwnerOrg=%q, quería %q (dueño = firmante)", a.OwnerOrg, orgA)
	}
	if a.OriginChannel != "canal-caba" {
		t.Errorf("OriginChannel=%q, quería canal-caba", a.OriginChannel)
	}
	if a.ResourceType != "Observation" || a.PatientIDHash != "paciente-1" {
		t.Errorf("metadata mal: %+v", a)
	}
	todos, _ := h.sc.GetAllAssets(h.ctx)
	if len(todos) != 1 {
		t.Errorf("GetAllAssets=%d, quería 1", len(todos))
	}
}

func TestPublishAssetRefHabilitaAccesoCrossJur(t *testing.T) {
	h := newHarness(t).registrar(orgA, orgB)
	// orgA (dueño en otra provincia) asciende la referencia al nacional.
	if err := h.as(orgA).publicarRef("obs-1", "Observation", "pac-1", "canal-caba"); err != nil {
		t.Fatalf("publicarRef: %v", err)
	}
	// orgA otorga consentimiento a orgB sobre ese tipo.
	h.as(orgA).otorgar("pac-1", orgB, []string{"Observation"}, enUnAnio(h.now))
	// orgB pide acceso: PERMIT, con metadata derivada de la referencia guardada.
	dec, _ := h.as(orgB).tx("tx-chk").permitido("obs-1")
	if dec != "PERMIT" {
		t.Fatalf("decisión=%q, quería PERMIT", dec)
	}
	log := h.ultimoLog()
	if log.ResourceType != "Observation" || log.PatientIDHash != "pac-1" || log.AssetOwnerOrg != orgA {
		t.Errorf("auditoría mal: %+v", log)
	}
	if !h.huboEvento("AccessPermitted") {
		t.Error("no se emitió AccessPermitted sobre la referencia")
	}
}

func TestPublishAssetRefRequiereClinicaActiva(t *testing.T) {
	h := newHarness(t) // orgA NO registrada
	if err := h.as(orgA).publicarRef("obs-1", "Observation", "pac-1", "canal-caba"); err == nil {
		t.Fatal("esperaba error: solo una clínica activa puede publicar")
	}
}

func TestPublishAssetRefRechazaArgsVacios(t *testing.T) {
	h := newHarness(t).registrar(orgA).as(orgA)
	casos := [][5]string{
		{"", "Observation", "Qm", "pac", "canal-caba"},
		{"obs-1", "", "Qm", "pac", "canal-caba"},
		{"obs-1", "Observation", "", "pac", "canal-caba"},
		{"obs-1", "Observation", "Qm", "", "canal-caba"},
		{"obs-1", "Observation", "Qm", "pac", ""},
	}
	for _, c := range casos {
		if err := h.sc.PublishAssetRef(h.ctx, c[0], c[1], c[2], c[3], c[4]); err == nil {
			t.Errorf("esperaba error con args %v", c)
		}
	}
}

func TestPublishAssetRefNoPisaNativo(t *testing.T) {
	h := newHarness(t).registrar(orgA).as(orgA)
	// emitir deja un activo nativo (OriginChannel == canal de este estado).
	h.emitir("obs-1", "Observation", "pac-1")
	if err := h.publicarRef("obs-1", "Observation", "pac-1", "canal-caba"); err == nil {
		t.Fatal("esperaba error: una referencia no debe pisar un activo nativo")
	}
}

func TestPublishAssetRefIdempotente(t *testing.T) {
	h := newHarness(t).registrar(orgA).as(orgA)
	if err := h.publicarRef("obs-1", "Observation", "pac-1", "canal-caba"); err != nil {
		t.Fatalf("primer publish: %v", err)
	}
	if err := h.publicarRef("obs-1", "Observation", "pac-1", "canal-caba"); err != nil {
		t.Fatalf("re-publish idempotente falló: %v", err)
	}
	todos, _ := h.sc.GetAllAssets(h.ctx)
	if len(todos) != 1 {
		t.Errorf("re-publish duplicó la referencia: %d", len(todos))
	}
}

func TestPublishAssetRefAbortaSiFallaWorldState(t *testing.T) {
	h := newHarness(t).registrar(orgA).as(orgA)
	h.romperEscritura("ASSET_", errors.New("world state caído"))
	if err := h.publicarRef("obs-1", "Observation", "pac-1", "canal-caba"); err == nil {
		t.Fatal("esperaba abortar ante fallo de PutState")
	}
}
