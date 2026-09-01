// Mock de RENAPER: valida identidad por DNI contra un padrón fijo en
// sample-data/renaper.json. No toca Fabric ni el chaincode — es un chequeo
// informativo aparte de la transacción, no un gate: el consentimiento se
// otorga igual sin pasar por acá. El "QR" es el propio DNI: en un escaneo
// real ese código es lo que la app del paciente resolvería contra RENAPER.
'use strict';

const padron = require('../sample-data/renaper.json');

// Latencia simulada: un lookup instantáneo no se sentiría como una consulta
// a un padrón externo.
const demora = () => new Promise((r) => setTimeout(r, 400 + Math.random() * 300));

async function validar(dni) {
  await demora();
  const persona = padron.find((p) => p.dni === String(dni).trim());
  if (!persona) return { found: false, dni };
  const { dni: _, ...datos } = persona;
  return { found: true, dni, persona: datos };
}

module.exports = { validar };
