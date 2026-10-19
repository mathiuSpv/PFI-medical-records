// Grafo de trazabilidad del activo médico digital.
//
// El modelo tiene DOS entidades y UNA relación: la institución emitió el
// documento. Nada más se dibuja.
//
// La decisión de fondo: la unidad de auditoría no es el nodo ni una arista por
// acceso, es la relación de emisión. Cada EMITIÓ carga el documento entero y su
// historial completo de accesos — quién lo pidió, cuándo, qué respondió el
// chaincode, con qué motivo, bajo qué consentimiento y con qué TxID, cada
// evaluación por separado. Abrir esa única línea reconstruye toda la vida del
// documento.
//
// Una arista por solicitud, que es lo que se probó antes, multiplica las líneas
// entre los mismos nodos y obliga a recorrer el dibujo para juntar lo que
// conviene leer de una sola vez. El paciente y el CID de IPFS, por lo mismo,
// son propiedades y no nodos.

// ---------------------------------------------------------------------------
// Construcción
// ---------------------------------------------------------------------------

export const TIPOS = {
  org: { radio: 24, clase: 'n-org' },
  activo: { radio: 19, clase: 'n-activo' },
};

const idOrg = (msp) => `org:${msp}`;
const idAct = (fhir) => `act:${fhir}`;

function estadoConsentimiento(c) {
  if (!c) return null;
  if (c.Revoked) return 'revocado';
  if (new Date(c.Expiry) <= new Date()) return 'vencido';
  return 'vigente';
}

const fecha = (iso) => (iso ? String(iso).replace('T', ' ').replace('Z', '') : '—');

// construirGrafo arma el grafo desde las cuatro fuentes del BFF. Tolera que
// cualquiera venga null (todavía cargando) devolviendo lo que se pueda.
export function construirGrafo({ clinics, assets, consents, logs, etiquetaOrg }) {
  const nodos = new Map();
  const aristas = [];
  const nombreOrg = etiquetaOrg ?? ((msp) => msp);

  // Los consentimientos no se dibujan: se consultan para explicar por qué una
  // solicitud terminó como terminó, que es donde aportan.
  const consentPorClave = new Map();
  for (const c of consents ?? []) {
    consentPorClave.set(`${c.PatientIDHash}|${c.GrantedToOrg}`, c);
  }

  for (const c of clinics ?? []) {
    nodos.set(idOrg(c.mspId), {
      id: idOrg(c.mspId),
      tipo: 'org',
      // Capas a las que pertenece: toda institución es miembro del canal
      // nacional, y además del de su provincia si tiene una. Un nodo puede
      // verse en más de una capa.
      capas: ['nacional', ...(c.jurisdiccion ? [c.jurisdiccion] : [])],
      etiqueta: c.label ?? c.nombre ?? c.mspId,
      color: c.color,
      baja: c.estado !== 'activa',
      props: {
        'MSP ID': c.mspId,
        'Canal privado': c.privateChannel,
        Estado: c.estado,
      },
    });
  }

  const pacientePorActivo = new Map();

  for (const a of assets ?? []) {
    pacientePorActivo.set(a.FhirResourceID, a.PatientIDHash);
    // El activo vive en su canal de ORIGEN (su provincia), y además en el
    // nacional si ascendió (se publicó su referencia allí, _channel nacional)
    // o si nació nacional.
    const origen = (!a.OriginChannel || a.OriginChannel === 'canal-nacional')
      ? 'nacional'
      : a.OriginChannel.replace(/^canal-/, '');
    const capasActivo = origen === 'nacional'
      ? ['nacional']
      : (a._channel === 'canal-nacional' ? [origen, 'nacional'] : [origen]);
    nodos.set(idAct(a.FhirResourceID), {
      id: idAct(a.FhirResourceID),
      tipo: 'activo',
      capas: capasActivo,
      etiqueta: a.FhirResourceID,
      subtipo: a.ResourceType,
      props: {
        'Tipo FHIR': a.ResourceType,
        Paciente: a.PatientIDHash,
        'CID en IPFS': a.IpfsCid,
        'Emitido por': nombreOrg(a.OwnerOrg),
        Emitido: fecha(a.Timestamp),
        Contenido: 'AES-256-GCM en IPFS (off-chain); la cadena solo ancla el CID',
      },
    });

    if (nodos.has(idOrg(a.OwnerOrg))) {
      aristas.push({
        origen: idOrg(a.OwnerOrg),
        destino: idAct(a.FhirResourceID),
        rel: 'EMITIÓ',
        documento: a.FhirResourceID,
        props: {
          Emisor: nombreOrg(a.OwnerOrg),
          Documento: a.FhirResourceID,
          'Tipo FHIR': a.ResourceType,
          Paciente: a.PatientIDHash,
          'CID en IPFS': a.IpfsCid,
          'Fecha de emisión': fecha(a.Timestamp),
        },
        // Lo carga el bloque de abajo, una vez agrupados los accesos.
        solicitudes: [],
      });
    }
  }

  // Los accesos se agrupan por (solicitante, documento) y se cuelgan de la
  // relación de emisión de ese documento. No se pierde nada: cada evaluación
  // queda con su decisión, su motivo y su TxID.
  const pedidos = new Map();
  for (const l of logs ?? []) {
    if (!l.FhirResourceID || !nodos.has(idAct(l.FhirResourceID))) continue;
    if (!nodos.has(idOrg(l.RequesterOrg))) continue;
    const clave = `${l.RequesterOrg}|${l.FhirResourceID}`;
    const p = pedidos.get(clave) ?? { evaluaciones: [] };
    p.evaluaciones.push({
      ts: l.Timestamp,
      decision: l.Decision,
      motivo: l.Reason || '',
      txId: l.TxID,
      tipo: l.ResourceType,
    });
    pedidos.set(clave, p);
  }

  const emisionPorDoc = new Map(aristas.map((a) => [a.documento, a]));

  for (const [clave, p] of pedidos) {
    const [msp, fhir] = clave.split('|');
    const emision = emisionPorDoc.get(fhir);
    if (!emision) continue;

    const evs = [...p.evaluaciones].sort((x, y) => String(x.ts).localeCompare(String(y.ts)));
    const ultima = evs[evs.length - 1];
    const permits = evs.filter((e) => e.decision === 'PERMIT').length;
    const cons = consentPorClave.get(`${pacientePorActivo.get(fhir)}|${msp}`);

    emision.solicitudes.push({
      solicitante: nombreOrg(msp),
      // El resultado vigente es el de la última evaluación: si el
      // consentimiento se revocó después de un PERMIT, lo que corresponde
      // mostrar es el DENY posterior.
      resultado: ultima.decision,
      motivo: ultima.motivo || (ultima.decision === 'PERMIT' ? 'consentimiento vigente y alcanzando el tipo' : '—'),
      consentimiento: cons
        ? `${estadoConsentimiento(cons)} · ${cons.ResourceTypes?.length ? cons.ResourceTypes.join(', ') : 'sin tipos'} · vence ${String(cons.Expiry).slice(0, 10)}`
        : 'no existe',
      resumen: `${evs.length} ${evs.length === 1 ? 'evaluación' : 'evaluaciones'} (${permits} PERMIT · ${evs.length - permits} DENY)`,
      evaluaciones: evs,
    });
  }

  for (const a of aristas) {
    a.solicitudes.sort((x, y) => x.solicitante.localeCompare(y.solicitante));
    const n = a.solicitudes.length;
    const rechazadas = a.solicitudes.filter((s) => s.resultado !== 'PERMIT').length;
    a.accesos = n;
    a.rechazos = rechazadas;
    a.detalle = n === 0 ? 'sin accesos' : `${n} acceso${n > 1 ? 's' : ''}${rechazadas ? ` · ${rechazadas} denegado${rechazadas > 1 ? 's' : ''}` : ''}`;
  }

  // capas = niveles presentes (unión de las capas de cada nodo), nacional
  // primero y provincias alfabéticas. Es la lista que ofrece el selector.
  const presentes = new Set();
  for (const n of nodos.values()) for (const c of n.capas) presentes.add(c);
  const provincias = [...presentes].filter((c) => c !== 'nacional').sort();
  const capas = [...(presentes.has('nacional') ? ['nacional'] : []), ...provincias];

  return { nodos: [...nodos.values()], aristas, capas };
}

// ---------------------------------------------------------------------------
// Motor de fuerzas
// ---------------------------------------------------------------------------
//
// Fruchterman-Reingold simplificado: repulsión entre todos los pares, atracción
// por arista y una gravedad suave al centro para que los componentes sueltos no
// se vayan al infinito. La temperatura baja en cada tick y limita cuánto se
// puede mover un nodo, que es lo que hace que el layout converja en vez de
// oscilar.
//
// El costo es O(n²) por tick. Con las magnitudes de este prototipo —decenas de
// nodos— eso es irrelevante, y evita la complejidad de un quadtree.

const TEMP_INICIAL = 0.16;
const ENFRIAMIENTO = 0.985;
const TEMP_MINIMA = 0.0015;

// Posiciones iniciales en círculo y no al azar: el layout converge parecido en
// cada corrida, así que volver a abrir la solapa no reordena todo el grafo.
export function posicionesIniciales(nodos, ancho, alto, capas = []) {
  const bandas = capas.length || 1;
  const bandH = alto / bandas;
  const idxDe = new Map(capas.map((c, i) => [c, i]));

  // Cada nodo cae en la banda de su capa; se reparte en X dentro de ella y
  // arranca en el centro vertical de la banda. bandTop/bandBot acotan su
  // movimiento vertical (dejando arriba lugar para el rótulo de la banda).
  const porBanda = new Map();
  for (const n of nodos) {
    const b = idxDe.get(n.capa) ?? 0;
    if (!porBanda.has(b)) porBanda.set(b, []);
    porBanda.get(b).push(n);
  }
  for (const [b, grupo] of porBanda) {
    const top = b * bandH;
    grupo.forEach((n, i) => {
      const r = TIPOS[n.tipo].radio;
      n.bandTop = top + r + 28;
      n.bandBot = top + bandH - (r + (n.subtipo ? 31 : 19));
      if (n.bandBot < n.bandTop) n.bandBot = n.bandTop;
      n.bandY = (n.bandTop + n.bandBot) / 2;
      n.x = ancho * ((i + 1) / (grupo.length + 1));
      n.y = n.bandY;
      // Margen propio de cada nodo: acotar por el radio dejaba los rótulos
      // colgando fuera del lienzo, porque el texto es bastante más ancho que el
      // círculo. ~5.9 px por carácter a 11 px de fuente, la mitad para cada lado.
      n.margenX = Math.max(r, (String(n.etiqueta ?? '').length * 5.9) / 2) + 4;
      n.margenY = r + (n.subtipo ? 31 : 19);
    });
  }
  return TEMP_INICIAL;
}

// tick avanza un paso y devuelve la temperatura nueva. Muta x/y de los nodos.
export function tick(nodos, aristas, temp, ancho, alto) {
  const n = nodos.length;
  if (n === 0) return TEMP_MINIMA;

  const area = ancho * alto;
  const k = Math.sqrt(area / n) * 0.72;
  const porId = new Map(nodos.map((nd) => [nd.id, nd]));

  for (const nd of nodos) { nd.dx = 0; nd.dy = 0; }

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const a = nodos[i];
      const b = nodos[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      // Dos nodos exactamente encima no tienen dirección de separación: se les
      // da un empujón determinista según el índice en vez de uno al azar.
      if (d2 < 0.01) {
        dx = (i - j) * 0.1 || 0.1;
        dy = 0.1;
        d2 = dx * dx + dy * dy;
      }
      const d = Math.sqrt(d2);
      const fuerza = (k * k) / d;
      const ux = (dx / d) * fuerza;
      const uy = (dy / d) * fuerza;
      a.dx += ux; a.dy += uy;
      b.dx -= ux; b.dy -= uy;
    }
  }

  for (const ar of aristas) {
    const a = porId.get(ar.origen);
    const b = porId.get(ar.destino);
    if (!a || !b) continue;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
    const fuerza = (d * d) / k;
    const ux = (dx / d) * fuerza;
    const uy = (dy / d) * fuerza;
    a.dx -= ux; a.dy -= uy;
    b.dx += ux; b.dy += uy;
  }

  // Gravedad: en X hacia el centro (mantiene el grafo centrado); en Y hacia el
  // centro de SU banda, con fuerza mayor, para que cada capa quede separada en
  // su franja en vez de mezclarse con las otras.
  const cx = ancho / 2;
  for (const nd of nodos) {
    const by = nd.bandY ?? alto / 2;
    nd.dx += (cx - nd.x) * 0.012 * k;
    nd.dy += (by - nd.y) * 0.09 * k;
  }

  const limite = Math.max(ancho, alto) * temp;
  let energia = 0;
  for (const nd of nodos) {
    if (nd.fijo) continue;
    const d = Math.sqrt(nd.dx * nd.dx + nd.dy * nd.dy) || 0.01;
    const paso = Math.min(d, limite);
    const mx = (nd.dx / d) * paso;
    const my = (nd.dy / d) * paso;
    nd.x += mx;
    nd.y += my;
    energia += mx * mx + my * my;
    // Se acota por el margen del nodo —que contempla el ancho del rótulo— y no
    // por su radio: así el texto entra entero en el lienzo.
    const margenX = nd.margenX ?? TIPOS[nd.tipo].radio + 8;
    const margenY = nd.margenY ?? TIPOS[nd.tipo].radio + 8;
    nd.x = Math.max(margenX, Math.min(ancho - margenX, nd.x));
    // Vertical: acotado a SU banda, no al lienzo entero, para que no se escape
    // a la franja de otra capa.
    const bt = nd.bandTop ?? (TIPOS[nd.tipo].radio + 6);
    const bb = nd.bandBot ?? (alto - margenY);
    nd.y = Math.max(bt, Math.min(bb, nd.y));
  }

  // Si el movimiento total ya es despreciable, se corta antes de agotar el
  // enfriamiento: no tiene sentido seguir gastando frames.
  if (energia / n < 0.02) return TEMP_MINIMA;
  return Math.max(temp * ENFRIAMIENTO, TEMP_MINIMA);
}

export const estaQuieto = (temp) => temp <= TEMP_MINIMA;

// acomodar corre la simulación entera de una y devuelve los nodos ya ubicados.
//
// Se resolvió así en vez de animar la convergencia: ver el grafo sacudirse
// durante un par de segundos hasta encontrar su lugar no aporta nada y se ve
// mal. Con las magnitudes de este prototipo el cálculo completo tarda menos que
// un frame, así que el usuario ve el resultado directamente.
export function acomodar(nodos, aristas, ancho, alto, capas = [], maxTicks = 600) {
  let temp = posicionesIniciales(nodos, ancho, alto, capas);
  for (let i = 0; i < maxTicks && !estaQuieto(temp); i++) {
    temp = tick(nodos, aristas, temp, ancho, alto);
  }
  return nodos;
}
