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

const CHANNEL_NAME = 'canal-universal';
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
    estado: clinic.estado,
    fundadora: clinic.fundadora === true,
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

// getChannels() -> canal público + un canal privado por clínica activa.
function getChannels() {
  return [CHANNEL_NAME, ...Object.values(getOrgs()).map((o) => o.privateChannel)];
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
  orgKeyForMsp,
  paths,
  CHANNEL_NAME,
  CHAINCODE_NAME,
  IPFS_API_URL,
};
