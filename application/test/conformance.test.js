// Batería de la capa de validación de conformidad.
//
// El criterio de aceptación que fija el Proyecto es doble y simétrico: rechazo
// del 100 % de los recursos no conformes y aceptación del 100 % de los
// conformes. La segunda mitad importa tanto como la primera: un validador que
// rechaza todo cumpliría el primer criterio y sería inútil.
//
// Cada caso no conforme aísla UN defecto sobre un recurso que, salvo por ese
// defecto, es válido. Así el caso prueba la regla que dice probar y no se
// aprueba por un motivo distinto del esperado.
//
// Se ejecuta con `npm test` (node:test, incorporado desde Node 18; no agrega
// dependencias).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { validateResource, assertConformant, ConformanceError } = require('../src/conformance');

// --- Recursos conformes de referencia ---------------------------------------

const observacionValida = {
  resourceType: 'Observation',
  id: 'obs-001',
  status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }] },
  subject: { reference: 'Patient/paciente-001' },
  effectiveDateTime: '2026-07-15T09:30:00Z',
  valueQuantity: { value: 118, unit: 'mmHg' },
};

const diagnosticoValido = {
  resourceType: 'DiagnosticReport',
  id: 'dr-001',
  status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '58410-2' }] },
  subject: { reference: 'Patient/paciente-001' },
  result: [{ reference: 'Observation/obs-001' }],
};

const condicionValida = {
  resourceType: 'Condition',
  id: 'cond-001',
  clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }] },
  code: { coding: [{ system: 'http://snomed.info/sct', code: '44054006' }] },
  subject: { reference: 'Patient/paciente-001' },
};

const prescripcionValida = {
  resourceType: 'MedicationRequest',
  id: 'mr-001',
  status: 'active',
  intent: 'order',
  medicationCodeableConcept: { coding: [{ system: 'http://snomed.info/sct', code: '372687004' }] },
  subject: { reference: 'Patient/paciente-001' },
};

const alergiaValida = {
  resourceType: 'AllergyIntolerance',
  id: 'ai-001',
  clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }] },
  type: 'allergy',
  criticality: 'high',
  code: { coding: [{ system: 'http://snomed.info/sct', code: '7980007' }] },
  patient: { reference: 'Patient/paciente-001' },
};

const CONFORMES = [
  ['Observation completa con LOINC', 'Observation', observacionValida],
  ['DiagnosticReport con resultados', 'DiagnosticReport', diagnosticoValido],
  ['Condition activa con SNOMED CT', 'Condition', condicionValida],
  ['MedicationRequest con medicación codificada', 'MedicationRequest', prescripcionValida],
  ['AllergyIntolerance crítica', 'AllergyIntolerance', alergiaValida],
  ['Observation sin elementos opcionales', 'Observation', {
    resourceType: 'Observation',
    status: 'registered',
    code: { coding: [{ system: 'http://loinc.org', code: '8867-4' }] },
    subject: { reference: 'Patient/p1' },
  }],
];

// Clona y aplica una mutación, para que cada caso parta de un recurso válido.
const mutar = (base, cambios) => {
  const copia = JSON.parse(JSON.stringify(base));
  for (const [clave, valor] of Object.entries(cambios)) {
    if (valor === undefined) delete copia[clave];
    else copia[clave] = valor;
  }
  return copia;
};

// --- Recursos no conformes, un defecto por caso -----------------------------

const NO_CONFORMES = [
  // Estructura
  ['tipo declarado distinto del recurso', 'Condition', observacionValida, 'tipo-declarado-no-coincide'],
  ['tipo sin perfil en el bus', 'Procedure', { resourceType: 'Procedure', status: 'completed' }, 'tipo-sin-perfil'],
  ['recurso que no es un objeto', 'Observation', 'no soy un recurso', 'recurso-invalido'],
  ['status obligatorio ausente', 'Observation', mutar(observacionValida, { status: undefined }), 'elemento-obligatorio-ausente'],
  ['code obligatorio ausente', 'Observation', mutar(observacionValida, { code: undefined }), 'elemento-obligatorio-ausente'],
  ['subject obligatorio ausente', 'Condition', mutar(condicionValida, { subject: undefined }), 'elemento-obligatorio-ausente'],
  ['intent obligatorio ausente', 'MedicationRequest', mutar(prescripcionValida, { intent: undefined }), 'elemento-obligatorio-ausente'],
  ['patient obligatorio ausente', 'AllergyIntolerance', mutar(alergiaValida, { patient: undefined }), 'elemento-obligatorio-ausente'],

  // Tipos
  ['CodeableConcept enviado como string', 'Observation', mutar(observacionValida, { code: '85354-9' }), 'tipo-invalido'],
  ['Reference enviada como string', 'Observation', mutar(observacionValida, { subject: 'Patient/p1' }), 'tipo-invalido'],
  ['status enviado como objeto', 'Observation', mutar(observacionValida, { status: { code: 'final' } }), 'tipo-invalido'],

  // Cardinalidades
  ['elemento 0..1 repetido como array', 'Observation', mutar(observacionValida, { subject: [{ reference: 'Patient/p1' }, { reference: 'Patient/p2' }] }), 'tipo-invalido'],
  ['grupo medication[x] ausente', 'MedicationRequest', mutar(prescripcionValida, { medicationCodeableConcept: undefined }), 'grupo-obligatorio-ausente'],
  ['grupo value[x] con dos miembros', 'Observation', mutar(observacionValida, { valueString: 'ciento dieciocho' }), 'grupo-ambiguo'],
  ['grupo effective[x] con dos miembros', 'Observation', mutar(observacionValida, { effectivePeriod: { start: '2026-07-15' } }), 'grupo-ambiguo'],

  // Binding terminológico
  ['status fuera del ValueSet', 'Observation', mutar(observacionValida, { status: 'finalizado' }), 'codigo-fuera-del-valueset'],
  ['intent fuera del ValueSet', 'MedicationRequest', mutar(prescripcionValida, { intent: 'receta' }), 'codigo-fuera-del-valueset'],
  ['clinicalStatus fuera del ValueSet', 'Condition', mutar(condicionValida, { clinicalStatus: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'curado' }] } }), 'codigo-fuera-del-valueset'],
  ['criticality fuera del ValueSet', 'AllergyIntolerance', mutar(alergiaValida, { criticality: 'altisima' }), 'codigo-fuera-del-valueset'],
  ['type de alergia fuera del ValueSet', 'AllergyIntolerance', mutar(alergiaValida, { type: 'reaccion' }), 'codigo-fuera-del-valueset'],
  ['clinicalStatus de alergia desde otro sistema', 'AllergyIntolerance', mutar(alergiaValida, { clinicalStatus: { coding: [{ system: 'http://ejemplo.local/estados', code: 'active' }] } }), 'sistema-terminologico-inesperado'],
];

// --- Pruebas ----------------------------------------------------------------

test('acepta el 100 % de los recursos conformes', async (t) => {
  for (const [nombre, tipo, recurso] of CONFORMES) {
    await t.test(nombre, () => {
      const r = validateResource(tipo, recurso);
      assert.equal(r.ok, true,
        `se esperaba conforme y falló con: ${r.errors.map((e) => e.code).join(', ')}`);
      assert.equal(r.errors.length, 0);
    });
  }
});

test('rechaza el 100 % de los recursos no conformes', async (t) => {
  for (const [nombre, tipo, recurso, codigoEsperado] of NO_CONFORMES) {
    await t.test(nombre, () => {
      const r = validateResource(tipo, recurso);
      assert.equal(r.ok, false, 'se esperaba que el recurso fuera rechazado');
      // El rechazo debe producirse por el motivo que el caso aísla y no por otro.
      assert.ok(
        r.errors.some((e) => e.code === codigoEsperado),
        `se esperaba el código «${codigoEsperado}» y se obtuvo: ${r.errors.map((e) => e.code).join(', ')}`,
      );
    });
  }
});

test('las advertencias no bloquean la emisión', () => {
  // Un código sin sistema terminológico declarado es tolerable para el estándar
  // con binding 'preferred': se informa al emisor pero el recurso se admite.
  const r = validateResource('Observation', mutar(observacionValida, {
    code: { coding: [{ code: '85354-9' }] },
  }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length > 0, 'debía advertir por el sistema terminológico ausente');
});

test('un CodeableConcept sólo con texto libre advierte pero no invalida', () => {
  const r = validateResource('Observation', mutar(observacionValida, {
    code: { text: 'Presión arterial' },
  }));
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => w.code === 'binding-sin-codigo'));
});

test('assertConformant corta el flujo con 422 y el informe', () => {
  assert.throws(
    () => assertConformant('Observation', mutar(observacionValida, { status: 'finalizado' })),
    (err) => {
      assert.ok(err instanceof ConformanceError);
      assert.equal(err.status, 422);
      assert.equal(err.report.ok, false);
      assert.ok(err.message.includes('no es conforme'));
      return true;
    },
  );
});

test('assertConformant deja pasar un recurso conforme y devuelve su informe', () => {
  const r = assertConformant('Observation', observacionValida);
  assert.equal(r.ok, true);
});

// --- Reglas del motor que la tabla de perfiles del bus todavía no ejercita ---
//
// El motor admite configuraciones de perfil que los cinco tipos actuales no
// usan: arrays con cardinalidad acotada y tipos primitivos. Se validan contra
// una tabla de perfiles de prueba para que la regla quede verificada antes de
// que algún perfil futuro dependa de ella.

const perfilesDePrueba = {
  Ensayo: {
    elements: {
      muestras: { min: 2, max: 3, type: 'array' },
      cantidad: { min: 1, max: 1, type: 'number' },
      urgente: { min: 0, max: 1, type: 'boolean' },
      metadatos: { min: 0, max: 1, type: 'object' },
      registrado: { min: 0, max: 1, type: 'dateTime' },
    },
    choice: [],
  },
};

const ensayoValido = {
  resourceType: 'Ensayo',
  muestras: ['a', 'b'],
  cantidad: 2,
  urgente: true,
  metadatos: { origen: 'laboratorio' },
  registrado: '2026-07-15T09:30:00Z',
};

test('cardinalidad de arrays acotada por el perfil', async (t) => {
  await t.test('acepta un array dentro del rango', () => {
    assert.equal(validateResource('Ensayo', ensayoValido, perfilesDePrueba).ok, true);
  });

  await t.test('rechaza por exceder la cardinalidad máxima', () => {
    const r = validateResource('Ensayo', mutar(ensayoValido, { muestras: ['a', 'b', 'c', 'd'] }), perfilesDePrueba);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === 'cardinalidad-excedida'));
  });

  await t.test('rechaza por no alcanzar la cardinalidad mínima', () => {
    const r = validateResource('Ensayo', mutar(ensayoValido, { muestras: ['a'] }), perfilesDePrueba);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.code === 'cardinalidad-insuficiente'));
  });
});

test('tipos primitivos del motor', async (t) => {
  const casos = [
    ['number', { cantidad: 'dos' }],
    ['boolean', { urgente: 'si' }],
    ['object', { metadatos: ['laboratorio'] }],
    ['dateTime', { registrado: 'el martes pasado' }],
  ];
  for (const [tipo, cambio] of casos) {
    await t.test(`rechaza ${tipo} mal tipado`, () => {
      const r = validateResource('Ensayo', mutar(ensayoValido, cambio), perfilesDePrueba);
      assert.equal(r.ok, false);
      assert.ok(r.errors.some((e) => e.code === 'tipo-invalido'));
    });
  }
});
