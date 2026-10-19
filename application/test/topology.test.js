// Regla de ruteo de la topología jerárquica de canales.
//
// Es la pieza del nivel jurisdiccional que tiene lógica propia, y la que
// distingue esta topología de un bus plano: sin ella todo el tráfico interno de
// cada provincia saldría al canal nacional sin necesidad.
//
// Las pruebas trabajan sobre un registro de clínicas de prueba, no sobre el de
// la red: config.js lo lee de network/organizations/clinics.json, que sólo
// existe después de un `./network.sh up`.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Registro de prueba: dos provincias, una con dos instituciones (para el caso
// intrajurisdiccional) y otra con una, más una dada de baja.
const REGISTRO = {
  clinics: [
    {
      key: 'caba1', nombre: 'Clínica CABA 1', mspId: 'Caba1MSP', domain: 'caba1.example.com',
      peerPort: 7051, chaincodePort: 7052, operationsPort: 9444,
      privateChannel: 'canal-caba1', jurisdiccion: 'caba',
      jurisdictionChannel: 'canal-caba', jurisdictionProfile: 'CanalCaba',
      estado: 'activa',
    },
    {
      key: 'caba2', nombre: 'Clínica CABA 2', mspId: 'Caba2MSP', domain: 'caba2.example.com',
      peerPort: 11051, chaincodePort: 11052, operationsPort: 9446,
      privateChannel: 'canal-caba2', jurisdiccion: 'caba',
      jurisdictionChannel: 'canal-caba', jurisdictionProfile: 'CanalCaba',
      estado: 'activa',
    },
    {
      key: 'bsas1', nombre: 'Hospital Buenos Aires 1', mspId: 'Bsas1MSP', domain: 'bsas1.example.com',
      peerPort: 9051, chaincodePort: 9052, operationsPort: 9445,
      privateChannel: 'canal-bsas1', jurisdiccion: 'buenos-aires',
      jurisdictionChannel: 'canal-buenos-aires', jurisdictionProfile: 'CanalBuenosAires',
      estado: 'activa',
    },
    {
      key: 'baja1', nombre: 'Clínica dada de baja', mspId: 'Baja1MSP', domain: 'baja1.example.com',
      peerPort: 12051, chaincodePort: 12052, operationsPort: 9447,
      privateChannel: 'canal-baja1', jurisdiccion: 'caba',
      jurisdictionChannel: 'canal-caba', jurisdictionProfile: 'CanalCaba',
      estado: 'baja',
    },
  ],
};

// config.js resuelve la ruta del registro relativa a su propia ubicación, así
// que se escribe el archivo donde lo espera y se restaura al terminar.
const CLINICS_FILE = path.resolve(__dirname, '..', '..', 'network', 'organizations', 'clinics.json');
let previo = null;

test.before(() => {
  fs.mkdirSync(path.dirname(CLINICS_FILE), { recursive: true });
  if (fs.existsSync(CLINICS_FILE)) previo = fs.readFileSync(CLINICS_FILE);
  fs.writeFileSync(CLINICS_FILE, JSON.stringify(REGISTRO, null, 2));
});

test.after(() => {
  if (previo !== null) fs.writeFileSync(CLINICS_FILE, previo);
  else fs.rmSync(CLINICS_FILE, { force: true });
});

const config = require('../src/config');

test('un intercambio dentro de la misma jurisdicción no sale de la provincia', () => {
  assert.equal(config.channelForOrgs('caba1', 'caba2'), 'canal-caba');
  assert.equal(config.channelForOrgs('caba2', 'caba1'), 'canal-caba');
});

test('un intercambio entre jurisdicciones distintas usa el canal nacional', () => {
  assert.equal(config.channelForOrgs('caba1', 'bsas1'), 'canal-nacional');
  assert.equal(config.channelForOrgs('bsas1', 'caba2'), 'canal-nacional');
});

test('la regla es simétrica: el canal no depende de quién pregunta', () => {
  for (const [a, b] of [['caba1', 'caba2'], ['caba1', 'bsas1'], ['bsas1', 'caba1']]) {
    assert.equal(config.channelForOrgs(a, b), config.channelForOrgs(b, a),
      `asimetría entre ${a} y ${b}`);
  }
});

test('una sola institución opera en su canal jurisdiccional', () => {
  assert.equal(config.channelForOrgs('caba1'), 'canal-caba');
  assert.equal(config.channelForOrgs('bsas1', 'bsas1'), 'canal-buenos-aires');
});

test('una clínica dada de baja no rutea', () => {
  assert.throws(() => config.channelForOrgs('baja1', 'caba1'), /desconocida o dada de baja/);
  assert.throws(() => config.channelForOrgs('caba1', 'baja1'), /desconocida o dada de baja/);
  assert.throws(() => config.channelForOrgs('inexistente'), /desconocida o dada de baja/);
});

test('getChannels devuelve los tres niveles sin repetir el jurisdiccional', () => {
  const canales = config.getChannels();
  assert.equal(canales[0], 'canal-nacional');
  // canal-caba aparece una sola vez pese a tener dos instituciones activas.
  assert.equal(canales.filter((c) => c === 'canal-caba').length, 1);
  assert.ok(canales.includes('canal-buenos-aires'));
  // Las bitácoras de las activas están; la de la clínica dada de baja no.
  for (const c of ['canal-caba1', 'canal-caba2', 'canal-bsas1']) assert.ok(canales.includes(c), c);
  assert.ok(!canales.includes('canal-baja1'));
});

test('jurisdictionChannels agrupa las instituciones activas por provincia', () => {
  const j = config.jurisdictionChannels();
  assert.deepEqual(Object.keys(j).sort(), ['buenos-aires', 'caba']);
  assert.equal(j.caba.channel, 'canal-caba');
  assert.deepEqual(j.caba.orgs.sort(), ['caba1', 'caba2']);
  assert.deepEqual(j['buenos-aires'].orgs, ['bsas1']);
});
