// Formularios de emisión: para cada tipo de recurso FHIR, los campos que se le
// piden al usuario, sus valores iniciales y cómo se arma el recurso con ellos.
// El JSON que viaja sale de acá, así nadie tiene que editarlo a mano; los
// estados y códigos ofrecidos son los de los ValueSet que valida el bus
// (application/src/fhir-profiles.js), así que lo generado es conforme.

export const RESOURCE_TYPES = ['Observation', 'MedicationRequest', 'DiagnosticReport', 'Condition'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

export type Valores = Record<string, string>

export interface Campo {
  name: string
  label: string
  kind: 'text' | 'number' | 'datetime' | 'select'
  options?: string[]
  placeholder?: string
  // Ocupa las dos columnas del formulario.
  ancho?: boolean
}

interface Plantilla {
  campos: Campo[]
  inicial: () => Valores
  construir: (v: Valores, subject: string) => object
}

const LOINC = 'http://loinc.org'
const SNOMED = 'http://snomed.info/sct'
const CONDITION_CLINICAL = 'http://terminology.hl7.org/CodeSystem/condition-clinical'

// datetime-local ("2026-07-15T09:30") <-> dateTime de FHIR ("...:00Z").
const ahoraLocal = () => {
  const d = new Date()
  d.setSeconds(0, 0)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
}
const aFhir = (local: string) => {
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const texto = (s: string) => s.trim() || undefined
const numero = (s: string) => (s.trim() === '' || Number.isNaN(Number(s)) ? undefined : Number(s))
const codificado = (system: string, code: string, display: string) => ({
  coding: [{ system, code: code.trim(), display: texto(display) }],
})

const PLANTILLAS: Record<ResourceType, Plantilla> = {
  Observation: {
    campos: [
      { name: 'id', label: 'Id del recurso', kind: 'text' },
      { name: 'status', label: 'Estado', kind: 'select', options: ['registered', 'preliminary', 'final', 'amended', 'corrected', 'cancelled', 'entered-in-error', 'unknown'] },
      { name: 'codigo', label: 'Código LOINC', kind: 'text' },
      { name: 'detalle', label: 'Descripción', kind: 'text' },
      { name: 'fecha', label: 'Fecha y hora', kind: 'datetime', ancho: true },
      { name: 'sistolica', label: 'Presión sistólica (mmHg)', kind: 'number' },
      { name: 'diastolica', label: 'Presión diastólica (mmHg)', kind: 'number' },
    ],
    inicial: () => ({
      id: 'obs-demo-001', status: 'final', codigo: '85354-9', detalle: 'Blood pressure panel',
      fecha: ahoraLocal(), sistolica: '118', diastolica: '76',
    }),
    construir: (v, subject) => {
      const componentes = [
        ['Presión sistólica', numero(v.sistolica)],
        ['Presión diastólica', numero(v.diastolica)],
      ].filter(([, valor]) => valor !== undefined)
        .map(([nombre, valor]) => ({ code: { text: nombre }, valueQuantity: { value: valor, unit: 'mmHg' } }))
      return {
        resourceType: 'Observation',
        id: texto(v.id),
        status: v.status,
        code: codificado(LOINC, v.codigo, v.detalle),
        subject: { reference: subject },
        effectiveDateTime: aFhir(v.fecha),
        component: componentes.length ? componentes : undefined,
      }
    },
  },

  MedicationRequest: {
    campos: [
      { name: 'id', label: 'Id del recurso', kind: 'text' },
      { name: 'status', label: 'Estado', kind: 'select', options: ['active', 'on-hold', 'cancelled', 'completed', 'entered-in-error', 'stopped', 'draft', 'unknown'] },
      { name: 'intent', label: 'Intención', kind: 'select', options: ['proposal', 'plan', 'order', 'original-order', 'reflex-order', 'filler-order', 'instance-order', 'option'] },
      { name: 'fecha', label: 'Fecha de prescripción', kind: 'datetime' },
      { name: 'medicamento', label: 'Medicamento', kind: 'text', ancho: true },
      { name: 'dosis', label: 'Indicaciones de dosis', kind: 'text', ancho: true },
    ],
    inicial: () => ({
      id: 'medreq-demo-001', status: 'active', intent: 'order', fecha: ahoraLocal(),
      medicamento: 'Amoxicilina 500 mg', dosis: '1 comprimido cada 8 horas durante 7 días',
    }),
    construir: (v, subject) => ({
      resourceType: 'MedicationRequest',
      id: texto(v.id),
      status: v.status,
      intent: v.intent,
      medicationCodeableConcept: { text: v.medicamento.trim() },
      subject: { reference: subject },
      authoredOn: aFhir(v.fecha),
      dosageInstruction: texto(v.dosis) ? [{ text: v.dosis.trim() }] : undefined,
    }),
  },

  DiagnosticReport: {
    campos: [
      { name: 'id', label: 'Id del recurso', kind: 'text' },
      { name: 'status', label: 'Estado', kind: 'select', options: ['registered', 'partial', 'preliminary', 'final', 'amended', 'corrected', 'appended', 'cancelled', 'entered-in-error', 'unknown'] },
      { name: 'codigo', label: 'Código LOINC', kind: 'text' },
      { name: 'detalle', label: 'Descripción', kind: 'text' },
      { name: 'fecha', label: 'Fecha y hora', kind: 'datetime', ancho: true },
      { name: 'conclusion', label: 'Conclusión', kind: 'text', ancho: true },
    ],
    inicial: () => ({
      id: 'dr-demo-001', status: 'final', codigo: '58410-2', detalle: 'Complete blood count panel',
      fecha: ahoraLocal(), conclusion: 'Hemograma dentro de los valores de referencia.',
    }),
    construir: (v, subject) => ({
      resourceType: 'DiagnosticReport',
      id: texto(v.id),
      status: v.status,
      code: codificado(LOINC, v.codigo, v.detalle),
      subject: { reference: subject },
      effectiveDateTime: aFhir(v.fecha),
      conclusion: texto(v.conclusion),
    }),
  },

  Condition: {
    campos: [
      { name: 'id', label: 'Id del recurso', kind: 'text' },
      { name: 'clinicalStatus', label: 'Estado clínico', kind: 'select', options: ['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved'] },
      { name: 'codigo', label: 'Código SNOMED CT', kind: 'text' },
      { name: 'detalle', label: 'Descripción', kind: 'text' },
      { name: 'fecha', label: 'Inicio', kind: 'datetime', ancho: true },
    ],
    inicial: () => ({
      id: 'cond-demo-001', clinicalStatus: 'active', codigo: '38341003', detalle: 'Hypertensive disorder',
      fecha: ahoraLocal(),
    }),
    construir: (v, subject) => ({
      resourceType: 'Condition',
      id: texto(v.id),
      clinicalStatus: { coding: [{ system: CONDITION_CLINICAL, code: v.clinicalStatus }] },
      code: codificado(SNOMED, v.codigo, v.detalle),
      subject: { reference: subject },
      onsetDateTime: aFhir(v.fecha),
    }),
  },
}

export const camposDe = (tipo: ResourceType) => PLANTILLAS[tipo].campos
export const valoresIniciales = (tipo: ResourceType) => PLANTILLAS[tipo].inicial()

// Referencia FHIR al paciente: el id admite letras, números, '.' y '-' (hasta
// 64), así que lo que escribe el usuario se normaliza a eso.
export const referenciaPaciente = (patientId: string) => {
  const id = patientId.trim().replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)
  return `Patient/${id || 'desconocido'}`
}

// Recurso final como JSON (los campos vacíos desaparecen: JSON.stringify omite
// los undefined).
export function armarRecurso(tipo: ResourceType, valores: Valores, patientId: string): string {
  return JSON.stringify(PLANTILLAS[tipo].construir(valores, referenciaPaciente(patientId)), null, 2)
}
