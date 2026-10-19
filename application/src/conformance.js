// Capa de validación de conformidad: el control que un recurso HL7 FHIR R4
// debe superar ANTES de convertirse en activo médico digital.
//
// Por qué va antes y no después. El ledger garantiza que un registro no se
// altere una vez emitido. Esa garantía es ciega al contenido: protege con la
// misma fuerza un dato correcto y uno que ya era incorrecto en origen, y le da
// a ambos el mismo sello criptográfico de autenticidad institucional. Un
// receptor que verifica el CID y la firma concluye «esto es exactamente lo que
// la clínica A emitió», que es verdad, y no «esto es un dato clínico
// utilizable», que es lo que necesita. Validar en la emisión es lo único que
// cierra esa brecha, porque después de emitido ya no hay dónde corregir sin
// romper la inmutabilidad.
//
// Qué valida, en los tres planos que el Proyecto declara:
//
//   1. Estructura     el recurso declara el resourceType correcto y los
//                     elementos que el perfil exige están presentes y son del
//                     tipo esperado.
//   2. Cardinalidades min..max de cada elemento, incluidos los grupos [x] de
//                     FHIR, donde exactamente uno de los miembros puede estar
//                     presente.
//   3. Binding        los campos codificados usan un código del ValueSet al
//                     que el perfil los liga. Con strength 'required' un código
//                     fuera de la lista invalida el recurso; con 'preferred'
//                     sólo advierte, como en el estándar.
//
// Alcance: valida contra la tabla de fhir-profiles.js, no contra el conjunto
// completo de StructureDefinitions de HL7. Un tipo de recurso que no esté en
// esa tabla se rechaza por desconocido en lugar de aceptarse sin control: el
// bus no puede dar por bueno lo que no sabe verificar.
'use strict';

const { PROFILES } = require('./fhir-profiles');

const ERROR = 'error';
const WARNING = 'warning';

function issue(severity, code, path, message) {
  return { severity, code, path, message };
}

// dateTime de FHIR R4 (regex del estándar): año obligatorio, y mes/día/hora
// opcionales pero bien formados. Date.parse aceptaba "2026" o "July 15"; esto
// no. Cubre también 'date'/'instant' (subconjuntos de esta forma).
const FHIR_DATETIME = /^([0-9]([0-9]([0-9][1-9]|[1-9]0)|[1-9]00)|[1-9]000)(-(0[1-9]|1[0-2])(-(0[0-9]|[1-2][0-9]|3[0-1])(T([01][0-9]|2[0-3]):[0-5][0-9]:([0-5][0-9]|60)(\.[0-9]+)?(Z|[+-]((0[0-9]|1[0-3]):[0-5][0-9]|14:00)))?)?)?$/;

// Referencia literal "Tipo/id": el tipo es un nombre de recurso y el id un
// token acotado del estándar. Descarta un reference mal armado (sin barra, con
// espacios) que la forma "es-string" dejaba pasar.
const FHIR_REFERENCE = /^[A-Za-z]+\/[A-Za-z0-9.-]{1,64}$/;

// Unidades de medida. No se valida la gramática UCUM completa (es enorme): se
// contrasta contra un conjunto de unidades clínicas conocidas (binding débil,
// warning) y se exige coherencia cuando el propio recurso declara system UCUM.
const UCUM_SYSTEM = 'http://unitsofmeasure.org';
const UCUM_CONOCIDAS = new Set([
  'mm[Hg]', 'mmHg', 'mg', 'g', 'kg', 'mL', 'L', '/min', 'bpm',
  'mmol/L', 'mg/dL', 'cm', 'm', 'Cel', '%', '1', 'U/L', 'ng/mL', '10*3/uL',
]);

// --- Comprobación de tipos ---
// Distingue lo que los perfiles (y los miembros [x]) necesitan. CodeableConcept
// y Reference se validan por forma + contenido mínimo: alcanza para detectar el
// error que importa, un string pelado o una referencia mal armada donde el
// estándar pide estructura.
function typeMatches(type, value) {
  const isObject = value !== null && typeof value === 'object' && !Array.isArray(value);
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isObject;
    case 'dateTime':
      return typeof value === 'string' && FHIR_DATETIME.test(value);
    case 'Quantity':
      // Lo que lo distingue de un objeto cualquiera: un value numérico.
      return isObject && typeof value.value === 'number';
    case 'Range':
      // low/high opcionales; el detalle lo valida checkRange.
      return isObject;
    case 'Period':
      // start/end son dateTime si están; al menos uno debe estar.
      return isObject
        && (value.start !== undefined || value.end !== undefined)
        && (value.start === undefined || (typeof value.start === 'string' && FHIR_DATETIME.test(value.start)))
        && (value.end === undefined || (typeof value.end === 'string' && FHIR_DATETIME.test(value.end)));
    case 'CodeableConcept':
      return isObject && (Array.isArray(value.coding) || typeof value.text === 'string');
    case 'Reference':
      return isObject
        && ((typeof value.reference === 'string' && FHIR_REFERENCE.test(value.reference))
          || (value.identifier !== null && typeof value.identifier === 'object'));
    default:
      return true;
  }
}

// Extrae los códigos de un elemento para contrastarlos contra el ValueSet.
// Acepta las dos formas en que el perfil puede ligar un campo: un `code`
// primitivo (status, intent, criticality) o un CodeableConcept con coding[].
function codingsOf(value) {
  if (typeof value === 'string') return [{ system: null, code: value }];
  if (value && Array.isArray(value.coding)) {
    return value.coding.map((c) => ({ system: c?.system ?? null, code: c?.code ?? null }));
  }
  return [];
}

function checkBinding(path, binding, value, issues) {
  const codings = codingsOf(value);
  if (codings.length === 0) {
    // Un CodeableConcept sólo con `text` no tiene código que contrastar. No es
    // un error de binding, pero sí información no procesable por el receptor.
    issues.push(issue(WARNING, 'binding-sin-codigo', path,
      'el elemento no trae un código verificable; sólo texto libre'));
    return;
  }

  for (const { system, code } of codings) {
    if (binding.values && !binding.values.includes(code)) {
      issues.push(issue(
        binding.strength === 'required' ? ERROR : WARNING,
        'codigo-fuera-del-valueset', path,
        `el código «${code}» no pertenece al conjunto admitido (${binding.values.join(', ')})`,
      ));
      continue;
    }
    if (binding.system && system && system !== binding.system) {
      issues.push(issue(
        binding.strength === 'required' ? ERROR : WARNING,
        'sistema-terminologico-inesperado', path,
        `el código proviene de «${system}» y el perfil liga este elemento a «${binding.system}»`,
      ));
    }
    if (binding.system && !system) {
      issues.push(issue(WARNING, 'sistema-terminologico-ausente', path,
        `el código no declara sistema; el perfil espera «${binding.system}»`));
    }
  }
}

function checkElement(path, spec, value, issues) {
  const present = value !== undefined && value !== null;

  if (!present) {
    if (spec.min >= 1) {
      issues.push(issue(ERROR, 'elemento-obligatorio-ausente', path,
        `el perfil exige este elemento (cardinalidad ${spec.min}..${spec.max})`));
    }
    return;
  }

  if (!typeMatches(spec.type, value)) {
    issues.push(issue(ERROR, 'tipo-invalido', path,
      `se esperaba ${spec.type} y se recibió ${Array.isArray(value) ? 'array' : typeof value}`));
    return;
  }

  // Cardinalidad superior: sólo tiene sentido comprobarla sobre arrays.
  if (Array.isArray(value)) {
    if (spec.max !== '*' && value.length > spec.max) {
      issues.push(issue(ERROR, 'cardinalidad-excedida', path,
        `${value.length} repeticiones para una cardinalidad máxima de ${spec.max}`));
    }
    if (value.length < spec.min) {
      issues.push(issue(ERROR, 'cardinalidad-insuficiente', path,
        `${value.length} repeticiones para una cardinalidad mínima de ${spec.min}`));
    }
    // Contenido del array: cada repetición debe ser del tipo que el perfil
    // declara en `element` (p.ej. Reference, object). Antes sólo se verificaba
    // "es un array" y adentro podía venir cualquier cosa.
    if (spec.element) {
      value.forEach((item, i) => {
        if (!typeMatches(spec.element, item)) {
          issues.push(issue(ERROR, 'elemento-de-array-invalido', `${path}[${i}]`,
            `cada repetición debe ser ${spec.element} y se recibió ${Array.isArray(item) ? 'array' : (item === null ? 'null' : typeof item)}`));
        }
      });
    }
  } else if (spec.max !== '*' && spec.max < 1) {
    issues.push(issue(ERROR, 'cardinalidad-excedida', path,
      'el perfil no admite este elemento'));
  }

  if (spec.binding) checkBinding(path, spec.binding, value, issues);
}

// El tipo de un miembro [x] está codificado en el sufijo de su nombre
// (effectiveDateTime -> DateTime, valueQuantity -> Quantity, ...). Se mapea el
// sufijo al tipo que entiende typeMatches; lo no listado cae a 'object' (se
// exige al menos que sea una estructura, no un primitivo suelto).
const CHOICE_MEMBER_TYPE = {
  DateTime: 'dateTime', Instant: 'dateTime', Date: 'dateTime',
  String: 'string', Boolean: 'boolean', Integer: 'integer',
  Quantity: 'Quantity', Period: 'Period', Range: 'Range',
  CodeableConcept: 'CodeableConcept', Reference: 'Reference',
  Age: 'object', Ratio: 'object',
};

function choiceMemberType(groupName, member) {
  const base = groupName.replace('[x]', '');
  return CHOICE_MEMBER_TYPE[member.slice(base.length)] ?? 'object';
}

// checkQuantity valida el dominio de una Quantity: value numérico (ya lo exige
// typeMatches, acá se reafirma) y la unidad. No valida UCUM completo: avisa si
// la unidad no está en el conjunto conocido y rechaza la incoherencia de
// declarar system UCUM sin code.
function checkQuantity(path, q, issues) {
  if (typeof q.value !== 'number' || !Number.isFinite(q.value)) {
    issues.push(issue(ERROR, 'quantity-sin-valor-numerico', path,
      'una Quantity debe tener value numérico'));
    return;
  }
  if (q.system && q.system !== UCUM_SYSTEM) {
    issues.push(issue(WARNING, 'quantity-sistema-no-ucum', path,
      `la unidad declara el sistema «${q.system}», no UCUM`));
  }
  if (q.system === UCUM_SYSTEM && !q.code) {
    issues.push(issue(ERROR, 'quantity-ucum-sin-code', path,
      'declara system UCUM pero no trae code de unidad'));
  }
  const unidad = q.code ?? q.unit;
  if (unidad && !UCUM_CONOCIDAS.has(unidad)) {
    issues.push(issue(WARNING, 'unidad-desconocida', path,
      `la unidad «${unidad}» no está en el conjunto conocido`));
  }
}

// checkRange valida un Range: low/high son Quantity con value numérico y, si
// están los dos, low <= high.
function checkRange(path, r, issues) {
  for (const limite of ['low', 'high']) {
    if (r[limite] !== undefined && typeof r[limite]?.value !== 'number') {
      issues.push(issue(ERROR, 'range-limite-invalido', `${path}.${limite}`,
        `${limite} debe ser una Quantity con value numérico`));
    }
  }
  if (typeof r.low?.value === 'number' && typeof r.high?.value === 'number'
      && r.low.value > r.high.value) {
    issues.push(issue(ERROR, 'range-invertido', path,
      `low (${r.low.value}) es mayor que high (${r.high.value})`));
  }
}

// Grupos [x]: FHIR permite un único miembro del grupo por recurso. Dos a la vez
// no es una ambigüedad tolerable sino un recurso inválido, porque el receptor
// no tiene regla para decidir cuál vale. Si hay exactamente uno, además se
// valida que su VALOR sea del tipo que el sufijo del miembro declara: antes el
// valor clínico del recurso no se chequeaba (effectiveDateTime podía ser "el
// martes", valueQuantity un string).
function checkChoice(group, resource, issues) {
  const present = group.members.filter((m) => resource[m] !== undefined && resource[m] !== null);

  if (present.length === 0 && group.min >= 1) {
    issues.push(issue(ERROR, 'grupo-obligatorio-ausente', group.name,
      `el perfil exige uno de: ${group.members.join(', ')}`));
  }
  if (present.length > 1) {
    issues.push(issue(ERROR, 'grupo-ambiguo', group.name,
      `sólo puede estar presente uno de los miembros del grupo y vinieron ${present.length}: ${present.join(', ')}`));
    return;
  }
  if (present.length === 1) {
    const member = present[0];
    const type = choiceMemberType(group.name, member);
    const val = resource[member];
    if (!typeMatches(type, val)) {
      issues.push(issue(ERROR, 'miembro-tipo-invalido', member,
        `el miembro ${member} debe ser ${type} y el valor recibido no lo es`));
    } else if (type === 'Quantity') {
      checkQuantity(member, val, issues);
    } else if (type === 'Range') {
      checkRange(member, val, issues);
    }
  }
}

/**
 * Valida un recurso contra el perfil declarado para su tipo.
 *
 * @param {string} resourceType tipo declarado por quien emite.
 * @param {object} resource     recurso FHIR R4 completo.
 * @param {object} [profiles]   tabla de perfiles a aplicar. Por defecto la del bus;
 *                              se parametriza para poder ejercitar en la batería
 *                              configuraciones de perfil que la tabla aún no declara.
 * @returns {{ok: boolean, resourceType: string, issues: Array, errors: Array, warnings: Array}}
 *          `ok` es false si hay al menos una incidencia de severidad error.
 */
function validateResource(resourceType, resource, profiles = PROFILES) {
  const issues = [];

  if (resource === null || typeof resource !== 'object' || Array.isArray(resource)) {
    issues.push(issue(ERROR, 'recurso-invalido', '(raíz)',
      'el recurso debe ser un objeto JSON'));
    return result(resourceType, issues);
  }

  // El tipo declarado al emitir gobierna el consentimiento ABAC: si no coincide
  // con el del recurso, el paciente estaría autorizando sobre una categoría y
  // recibiendo otra. Es un error de conformidad, no una discrepancia menor.
  if (resource.resourceType !== resourceType) {
    issues.push(issue(ERROR, 'tipo-declarado-no-coincide', 'resourceType',
      `se emite como «${resourceType}» y el recurso declara «${resource.resourceType ?? '(ausente)'}»`));
    return result(resourceType, issues);
  }

  const profile = profiles[resourceType];
  if (!profile) {
    issues.push(issue(ERROR, 'tipo-sin-perfil', 'resourceType',
      `el bus no tiene perfil declarado para «${resourceType}» y no admite recursos que no puede verificar`));
    return result(resourceType, issues);
  }

  for (const [path, spec] of Object.entries(profile.elements)) {
    checkElement(path, spec, resource[path], issues);
  }
  for (const group of profile.choice ?? []) {
    checkChoice(group, resource, issues);
  }

  return result(resourceType, issues);
}

function result(resourceType, issues) {
  const errors = issues.filter((i) => i.severity === ERROR);
  const warnings = issues.filter((i) => i.severity === WARNING);
  return { ok: errors.length === 0, resourceType, issues, errors, warnings };
}

/** Error con el detalle de conformidad, para que la API lo devuelva al emisor. */
class ConformanceError extends Error {
  constructor(report) {
    const detail = report.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    super(`El recurso ${report.resourceType} no es conforme al perfil FHIR R4: ${detail}`);
    this.name = 'ConformanceError';
    this.status = 422; // Unprocessable Entity: la sintaxis es válida, la semántica no.
    this.report = report;
  }
}

/** Valida y corta el flujo si el recurso no es conforme. */
function assertConformant(resourceType, resource) {
  const report = validateResource(resourceType, resource);
  if (!report.ok) throw new ConformanceError(report);
  return report;
}

module.exports = {
  validateResource,
  assertConformant,
  ConformanceError,
  supportedResourceTypes: () => Object.keys(PROFILES),
};
