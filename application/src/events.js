// Listener de eventos de chaincode, compartido por demo.js (embebido en el
// flujo de un solo proceso) y listen.js (standalone, un listener real "por
// org" corriendo en su propia terminal).
'use strict';

const { GatewayError } = require('@hyperledger/fabric-gateway');
const grpc = require('@grpc/grpc-js');
const { CHAINCODE_NAME } = require('./config');

const utf8Decoder = new TextDecoder();

function decodeEventPayload(event) {
  return JSON.parse(utf8Decoder.decode(event.payload));
}

// listenForEvents(network, onEvent) arranca la escucha y devuelve el
// CloseableAsyncIterable (el llamador debe cerrarlo con .close() al
// terminar) junto con una promise que resuelve cuando el loop de lectura
// termina (por close() o por error real).
async function listenForEvents(network, onEvent) {
  const events = await network.getChaincodeEvents(CHAINCODE_NAME);

  const done = (async () => {
    try {
      for await (const event of events) {
        onEvent(event, decodeEventPayload(event));
      }
    } catch (err) {
      // events.close() cancela el stream gRPC; eso llega acá como
      // GatewayError con código CANCELLED — es el cierre esperado, no un
      // error real.
      const isExpectedCancel = err instanceof GatewayError && err.code === grpc.status.CANCELLED.valueOf();
      if (!isExpectedCancel) {
        throw err;
      }
    }
  })();

  return { events, done };
}

module.exports = { listenForEvents };
