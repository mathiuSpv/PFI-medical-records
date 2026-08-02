// Seudonimización del identificador de paciente antes de que toque el ledger.
//
// El problema que resuelve: `canal-universal` guarda el identificador del
// paciente seudonimizado y en claro para todos los miembros del canal. Con un
// hash pelado (SHA-256 del DNI, que es lo que hacía antes esta capa) la
// seudonimización es aparente: el espacio de DNI argentinos son ~10^8 valores,
// así que cualquier miembro del canal los recorre en segundos, arma la tabla
// completa y sabe de qué paciente es cada recurso. Eso convierte el canal
// público en un registro de datos de salud identificables, que es exactamente
// lo que la Ley 25.326 trata como dato sensible.
//
// La solución: HMAC-SHA256 con una clave secreta de red. Sin la clave el valor
// no se puede invertir por fuerza bruta, y con la clave dos instituciones
// derivan el MISMO valor para el mismo paciente — que es lo que el bus necesita
// para que la clínica B pueda referirse al paciente de la clínica A.
//
// Dos decisiones que conviene poder defender:
//
//  1. El HMAC se calcula ACÁ, en la capa de aplicación, nunca en el chaincode.
//     El chaincode se ejecuta en el peer de cada organización y su read/write
//     set queda en el ledger: una clave secreta ahí no sería secreta. El
//     chaincode solo ve el valor opaco, y por diseño nunca aprende el
//     identificador real del paciente.
//
//  2. Límite conocido: la clave es compartida entre los miembros de la red, así
//     que protege contra un tercero que lea el canal, pero NO contra una
//     institución miembro que decida enumerar. Cerrar eso requiere que la
//     derivación no la pueda hacer cada org por su cuenta (un servicio de
//     índice ciego / OPRF), y queda fuera del alcance de esta etapa. En un
//     despliegue real la clave viviría en un HSM y se distribuiría al
//     incorporar cada institución.
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NETWORK_HOME } = require('./config');

const KEY_FILE = path.join(NETWORK_HOME, 'organizations', 'patient-index.key');

let cachedKey = null;

// indexKey lee la clave de red. La genera `network.sh up` y muere con `down`,
// igual que el material criptográfico: si se regenera, los valores dejan de
// coincidir con los que ya están en el ledger — es el equivalente a rotar la
// clave, y en una red real sería una migración, no un reinicio.
function indexKey() {
  if (cachedKey) return cachedKey;

  let hex;
  try {
    hex = fs.readFileSync(KEY_FILE, 'utf8').trim();
  } catch {
    throw new Error(
      `No existe la clave de índice de pacientes (${KEY_FILE}). ¿Corriste 'network.sh up'?`,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error(`La clave de índice de pacientes está corrupta (${KEY_FILE}): se esperan 64 hex`);
  }

  cachedKey = Buffer.from(hex, 'hex');
  return cachedKey;
}

// patientRef(patientId) -> referencia opaca y estable del paciente, que es lo
// único que viaja al ledger.
function patientRef(patientId) {
  const id = String(patientId ?? '').trim();
  if (!id) {
    throw new Error('El identificador de paciente es obligatorio');
  }
  return crypto.createHmac('sha256', indexKey()).update(id, 'utf8').digest('hex');
}

module.exports = { KEY_FILE, patientRef };
