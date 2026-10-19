// Configuración de las clínicas y del canal/chaincode.
//
// Las orgs ya no están escritas acá: salen de network/organizations/clinics.json,
// el registro que crea `network.sh up` y que actualizan los scripts de alta y
// baja. Se relee cuando cambia el mtime del archivo, así una clínica dada de
// alta en caliente aparece sin reiniciar el backend.
//
// Los paths de material criptográfico apuntan a network/organizations, que
// genera `network/network.sh up` — hace falta la red arriba antes de correr
// esta app.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NETWORK_HOME = path.resolve(__dirname, '..', '..', 'network');
const CLINICS_FILE = path.join(NETWORK_HOME, 'organizations', 'clinics.json');

// Canal del nivel nacional. Sólo transporta lo que cruza un límite provincial;
// el intercambio dentro de una jurisdicción se resuelve en el canal de esa
// provincia (ver channelForOrgs).
const NATIONAL_CHANNEL = 'canal-nacional';
// Alias histórico: buena parte del BFF y de la UI lo importan con este nombre.
const CHANNEL_NAME = NATIONAL_CHANNEL;
const CHAINCODE_NAME = 'consent';

let cache = { mtimeMs: 0, clinics: [] };

// loadClinics devuelve el registro completo (activas y dadas de baja).
function loadClinics() {
  let stat;
  try {
    stat = fs.statSync(CLINICS_FILE);
  } catch {
    throw new Error(
      `No existe el registro de clínicas (${CLINICS_FILE}). ¿Corriste 'network.sh up'?`,
    );
  }

  if (stat.mtimeMs !== cache.mtimeMs) {
    const parsed = JSON.parse(fs.readFileSync(CLINICS_FILE, 'utf8'));
    cache = { mtimeMs: stat.mtimeMs, clinics: parsed.clinics ?? [] };
  }
  return cache.clinics;
}

function toOrg(clinic) {
  return {
    key: clinic.key,
    nombre: clinic.nombre,
    mspId: clinic.mspId,
    domain: clinic.domain,
    // El cliente corre fuera de la red docker: llega a los peers por el puerto
    // publicado en localhost, pero el certificado TLS está emitido para el
    // hostname interno — de ahí el override del target name en connect.js.
    peerEndpoint: `127.0.0.1:${clinic.peerPort}`,
    peerHostAlias: `peer0.${clinic.domain}`,
    operationsPort: clinic.operationsPort,
    privateChannel: clinic.privateChannel,
    jurisdiccion: clinic.jurisdiccion ?? null,
    jurisdictionChannel: clinic.jurisdictionChannel ?? null,
    estado: clinic.estado,
  };
}

// getOrgs() -> { <key>: org } solo con las clínicas activas: son las únicas con
// las que se puede operar (una dada de baja no tiene peer ni membresía).
function getOrgs() {
  return Object.fromEntries(
    loadClinics()
      .filter((c) => c.estado === 'activa')
      .map((c) => [c.key, toOrg(c)]),
  );
}

// getAllOrgs() incluye las dadas de baja, para poder mostrarlas en la UI.
function getAllOrgs() {
  return Object.fromEntries(loadClinics().map((c) => [c.key, toOrg(c)]));
}

// getChannels() -> los tres niveles: el nacional, uno por jurisdicción con al
// menos una clínica activa, y la bitácora privada de cada clínica.
// Convención de nombres de canal (tres clases, no colisionan):
//   - Nacional:    canal-nacional (único).
//   - Provincial:  canal-<jurisdiccion>  (p.ej. canal-caba, canal-buenos-aires).
//   - Privado:     la bitácora interna de cada institución.
// Dos esquemas históricos para el privado: las dos clínicas iniciales usan
// canal-generica-1 / canal-generica-2 (con número y guion, definidos a mano en
// network.sh/configtx), y las clínicas dadas de alta en caliente usan
// canal-<key> sin número (derivado en addOrg.sh). La diferencia es cosmética —
// nunca colisionan porque <key> es único y las dos iniciales son fijas— y es a lo
// que apunta la devolución del 50% ("no coinciden los números de canales"):
// unificar el esquema de las dos iniciales a canal-<key> implica recrear sus
// canales en el orderer, así que queda para la tarea de topología dinámica, no
// acá.
function getChannels() {
  const orgs = Object.values(getOrgs());
  const jurisdiccionales = [...new Set(orgs.map((o) => o.jurisdictionChannel).filter(Boolean))];
  return [NATIONAL_CHANNEL, ...jurisdiccionales, ...orgs.map((o) => o.privateChannel)];
}

// jurisdictionChannels() -> { <jurisdicción>: { channel, orgs[] } }, derivado
// del registro. Lo usa la UI para mostrar la topología por niveles.
function jurisdictionChannels() {
  const out = {};
  for (const org of Object.values(getOrgs())) {
    if (!org.jurisdiccion) continue;
    out[org.jurisdiccion] ??= { channel: org.jurisdictionChannel, orgs: [] };
    out[org.jurisdiccion].orgs.push(org.key);
  }
  return out;
}

// channelForOrgs(a, b) -> el canal por el que debe resolverse un intercambio
// entre dos instituciones.
//
// Esta es la regla de ruteo de la topología jerárquica: si ambas pertenecen a
// la misma jurisdicción, el intercambio se resuelve en el canal de esa
// provincia y no sale de ella; si pertenecen a jurisdicciones distintas, cruza
// un límite provincial y le corresponde el canal nacional. Una sola institución
// (emisión, consulta propia) opera en su canal jurisdiccional.
//
// Que el nacional sea el caso por defecto y no el único es lo que distingue
// esta topología de un bus plano: sin la regla, todo el tráfico interno de cada
// provincia quedaría expuesto al resto del país sin necesidad.
//
// El estado de Fabric es por canal: un consentimiento otorgado en canal-caba no
// existe en canal-nacional, y una transacción no puede abarcar dos canales. Por
// eso el ascenso entre niveles no lo hace el chaincode (no hay cross-channel
// invoke) sino el BFF como una segunda transacción: el activo nace en el canal
// de su provincia (actions.emitAsset → este canal) y su REFERENCIA se publica
// en el nacional cuando un consentimiento cruza una frontera
// (actions.grantConsent → PublishAssetRef). Las lecturas unen nacional +
// provinciales y de-duplican (server/readmodel.js). Esta función es la única
// fuente de la decisión de ruteo y está cubierta por topology.test.js.
function channelForOrgs(orgKeyA, orgKeyB) {
  const orgs = getOrgs();
  const a = orgs[orgKeyA];
  if (!a) throw new Error(`Organización desconocida o dada de baja: ${orgKeyA}`);
  if (!orgKeyB || orgKeyA === orgKeyB) return a.jurisdictionChannel ?? NATIONAL_CHANNEL;

  const b = orgs[orgKeyB];
  if (!b) throw new Error(`Organización desconocida o dada de baja: ${orgKeyB}`);
  if (a.jurisdiccion && a.jurisdiccion === b.jurisdiccion) {
    return a.jurisdictionChannel ?? NATIONAL_CHANNEL;
  }
  return NATIONAL_CHANNEL;
}

function orgKeyForMsp(mspId) {
  return Object.values(getAllOrgs()).find((o) => o.mspId === mspId)?.key;
}

// paths(orgKey) resuelve los archivos de identidad de User1 de esa org
// (el usuario "de aplicación", no el Admin de canal) dentro de
// network/organizations/peerOrganizations/<domain>.
function paths(orgKey) {
  const org = getAllOrgs()[orgKey];
  if (!org) {
    const conocidas = Object.keys(getAllOrgs()).join(', ');
    throw new Error(`Organización desconocida: ${orgKey} (registradas: ${conocidas})`);
  }

  const orgHome = path.join(NETWORK_HOME, 'organizations', 'peerOrganizations', org.domain);
  const userHome = path.join(orgHome, 'users', `User1@${org.domain}`, 'msp');

  return {
    ...org,
    tlsCertPath: path.join(orgHome, 'peers', `peer0.${org.domain}`, 'tls', 'ca.crt'),
    certDirectoryPath: path.join(userHome, 'signcerts'),
    keyDirectoryPath: path.join(userHome, 'keystore'),
  };
}

const IPFS_API_URL = process.env.IPFS_API_URL || 'http://127.0.0.1:5001';

module.exports = {
  NETWORK_HOME,
  CLINICS_FILE,
  loadClinics,
  getOrgs,
  getAllOrgs,
  getChannels,
  jurisdictionChannels,
  channelForOrgs,
  orgKeyForMsp,
  paths,
  CHANNEL_NAME,
  NATIONAL_CHANNEL,
  CHAINCODE_NAME,
  IPFS_API_URL,
};
