// Perfiles HL7 FHIR R4 contra los que el bus valida la conformidad de un
// recurso antes de admitirlo como activo médico digital.
//
// Por qué esta tabla existe y no se usa el validador oficial de HL7: el
// validador de referencia necesita los paquetes de StructureDefinition
// completos del estándar (cientos de MB) y una JVM. Para lo que el bus
// transporta —un subconjunto acotado de tipos de recurso, declarado en el
// Proyecto— alcanza con una tabla declarativa de los elementos que el perfil
// exige, sus cardinalidades y el sistema terminológico al que están ligados.
// La contrapartida honesta: esto NO es un validador FHIR completo. Valida el
// perfil declarado acá para los tipos declarados acá, y rechaza por
// desconocido cualquier otro tipo (ver `unknownResourceType` en
// conformance.js). Esa limitación es deliberada y es la que hace que la
// validación sea auditable: lo que se exige está escrito en este archivo.
//
// Estructura de cada perfil:
//
//   elements: { <ruta>: { min, max, type, binding } }
//
//     min / max   cardinalidad del elemento. max puede ser un número o '*'.
//                 min >= 1 lo vuelve obligatorio.
//     type        tipo esperado: 'string' | 'number' | 'boolean' | 'object'
//                 | 'array' | 'CodeableConcept' | 'Reference' | 'dateTime'.
//     binding     { strength, system, values } para campos codificados.
//                 strength 'required' rechaza un código fuera de la lista;
//                 'preferred' sólo advierte, como en el estándar.
//
//   choice: grupos [x] de FHIR (effective[x], value[x], medication[x]). Al
//           menos uno de los miembros debe estar presente si el grupo es
//           obligatorio, y nunca más de uno: dos miembros a la vez es un
//           recurso mal formado según el estándar.
'use strict';

// --- Sistemas terminológicos referenciados por los perfiles ---
const SYS = {
  loinc: 'http://loinc.org',
  snomed: 'http://snomed.info/sct',
  observationStatus: 'http://hl7.org/fhir/observation-status',
  diagnosticReportStatus: 'http://hl7.org/fhir/diagnostic-report-status',
  medicationRequestStatus: 'http://hl7.org/fhir/CodeSystem/medicationrequest-status',
  medicationRequestIntent: 'http://hl7.org/fhir/CodeSystem/medicationrequest-intent',
  conditionClinical: 'http://terminology.hl7.org/CodeSystem/condition-clinical',
  allergyClinical: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
};

// Códigos de los ValueSet de estado. Son listas cerradas en el estándar
// (binding required), así que un valor fuera de la lista es un recurso no
// conforme y no una variante local admisible.
const VS = {
  observationStatus: [
    'registered', 'preliminary', 'final', 'amended',
    'corrected', 'cancelled', 'entered-in-error', 'unknown',
  ],
  diagnosticReportStatus: [
    'registered', 'partial', 'preliminary', 'final', 'amended',
    'corrected', 'appended', 'cancelled', 'entered-in-error', 'unknown',
  ],
  medicationRequestStatus: [
    'active', 'on-hold', 'cancelled', 'completed',
    'entered-in-error', 'stopped', 'draft', 'unknown',
  ],
  medicationRequestIntent: [
    'proposal', 'plan', 'order', 'original-order',
    'reflex-order', 'filler-order', 'instance-order', 'option',
  ],
  conditionClinical: [
    'active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved',
  ],
  allergyClinical: ['active', 'inactive', 'resolved'],
  allergyType: ['allergy', 'intolerance'],
  allergyCriticality: ['low', 'high', 'unable-to-assess'],
};

const PROFILES = {
  // Resultados de mediciones y estudios. Es el tipo de mayor volumen en el
  // intercambio institucional, según el relevamiento del Proyecto.
  Observation: {
    elements: {
      status: {
        min: 1, max: 1, type: 'string',
        binding: { strength: 'required', system: SYS.observationStatus, values: VS.observationStatus },
      },
      code: {
        min: 1, max: 1, type: 'CodeableConcept',
        binding: { strength: 'preferred', system: SYS.loinc },
      },
      subject: { min: 1, max: 1, type: 'Reference' },
      performer: { min: 0, max: '*', type: 'array' },
      component: { min: 0, max: '*', type: 'array' },
    },
    choice: [
      { name: 'effective[x]', min: 0, members: ['effectiveDateTime', 'effectivePeriod', 'effectiveInstant'] },
      { name: 'value[x]', min: 0, members: ['valueQuantity', 'valueCodeableConcept', 'valueString', 'valueBoolean', 'valueInteger', 'valueRange', 'valueRatio'] },
    ],
  },

  // Informes diagnósticos: agrupan observaciones bajo una conclusión clínica.
  DiagnosticReport: {
    elements: {
      status: {
        min: 1, max: 1, type: 'string',
        binding: { strength: 'required', system: SYS.diagnosticReportStatus, values: VS.diagnosticReportStatus },
      },
      code: {
        min: 1, max: 1, type: 'CodeableConcept',
        binding: { strength: 'preferred', system: SYS.loinc },
      },
      subject: { min: 1, max: 1, type: 'Reference' },
      result: { min: 0, max: '*', type: 'array' },
    },
    choice: [
      { name: 'effective[x]', min: 0, members: ['effectiveDateTime', 'effectivePeriod'] },
    ],
  },

  // Diagnósticos. El binding de clinicalStatus importa para el bus: un
  // diagnóstico «resolved» y uno «active» tienen consecuencias distintas en el
  // punto de atención, y el consentimiento se otorga por tipo de recurso.
  Condition: {
    elements: {
      clinicalStatus: {
        min: 0, max: 1, type: 'CodeableConcept',
        binding: { strength: 'required', system: SYS.conditionClinical, values: VS.conditionClinical },
      },
      code: {
        min: 1, max: 1, type: 'CodeableConcept',
        binding: { strength: 'preferred', system: SYS.snomed },
      },
      subject: { min: 1, max: 1, type: 'Reference' },
    },
    choice: [
      { name: 'onset[x]', min: 0, members: ['onsetDateTime', 'onsetAge', 'onsetPeriod', 'onsetRange', 'onsetString'] },
    ],
  },

  // Prescripción electrónica. Es el tipo con exigencia legal propia: la Ley
  // 27.553 condiciona su validez, de modo que un MedicationRequest mal formado
  // no es sólo un problema de interoperabilidad.
  MedicationRequest: {
    elements: {
      status: {
        min: 1, max: 1, type: 'string',
        binding: { strength: 'required', system: SYS.medicationRequestStatus, values: VS.medicationRequestStatus },
      },
      intent: {
        min: 1, max: 1, type: 'string',
        binding: { strength: 'required', system: SYS.medicationRequestIntent, values: VS.medicationRequestIntent },
      },
      subject: { min: 1, max: 1, type: 'Reference' },
      dosageInstruction: { min: 0, max: '*', type: 'array' },
    },
    choice: [
      { name: 'medication[x]', min: 1, members: ['medicationCodeableConcept', 'medicationReference'] },
    ],
  },

  // Alergias e intolerancias: el 80 % de los encuestados lo señala como la
  // información más crítica al atender a un paciente no habitual, y es el caso
  // donde un dato mal formado tiene consecuencia clínica directa.
  AllergyIntolerance: {
    elements: {
      clinicalStatus: {
        min: 0, max: 1, type: 'CodeableConcept',
        binding: { strength: 'required', system: SYS.allergyClinical, values: VS.allergyClinical },
      },
      type: {
        min: 0, max: 1, type: 'string',
        binding: { strength: 'required', values: VS.allergyType },
      },
      criticality: {
        min: 0, max: 1, type: 'string',
        binding: { strength: 'required', values: VS.allergyCriticality },
      },
      code: {
        min: 1, max: 1, type: 'CodeableConcept',
        binding: { strength: 'preferred', system: SYS.snomed },
      },
      patient: { min: 1, max: 1, type: 'Reference' },
    },
    choice: [],
  },
};

module.exports = { PROFILES, SYS, VS };
