// Helpers de acceso al BFF (/api, proxy de Vite) + hooks de fetch y SSE.
//
// Las clínicas ya no están escritas acá: se piden a /api/clinics, que las lee
// del registro de la red. Como pueden darse de alta y de baja en caliente, el
// listado vive en un cache de módulo que App refresca (setClinics) y que las
// funciones sincrónicas —orgByMsp, sobre todo— consultan sin necesidad de que
// cada componente reciba la lista por props.
import { useCallback, useEffect, useRef, useState } from 'react';

// Las dos fundadoras conservan sus colores; a las demás se les asigna uno
// estable derivado del key, para que la misma clínica se vea siempre igual.
const COLOR_FUNDADORAS = {
  sancristobal: 'var(--sc)',
  montenegro: 'var(--mn)',
};
// Tonos medios, no pasteles: estos colores se usan como texto (el nombre de la
// institución en tablas y feed) sobre fondo blanco, así que todos tienen que
// pasar 4.5:1. Se evitan el azul y el verde de las fundadoras.
const PALETA = ['#7b3fc4', '#a04a12', '#b3336b', '#0f6f86', '#5d4bbf', '#7a5c00'];

export function colorFor(key) {
  if (COLOR_FUNDADORAS[key]) return COLOR_FUNDADORAS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETA[h % PALETA.length];
}

let clinicsCache = [];
let clinicsCrudas = [];

// ---- Modo genérico ----
//
// Las instituciones de prueba tienen nombres propios, y esos nombres aparecen
// en toda la UI: tablas, feed, topología. Para mostrar el prototipo fuera del
// equipo —capturas, documentación, una demostración— hace falta poder verlo con
// instituciones genéricas sin tocar la red: el material criptográfico, los MSP
// ID y los nombres de canal ya están emitidos, y renombrarlos de verdad obliga
// a regenerar todo y a volver a crear los canales.
//
// Por eso el enmascarado es SOLO de presentación. Los campos reales (key,
// mspId, privateChannel) quedan intactos y son los que viajan en las llamadas
// al BFF; los campos *Label son los que se dibujan. Mezclarlos rompería las
// transacciones, así que la regla es: para pedir, el campo real; para mostrar,
// el Label.
//
// La numeración sale del orden del registro, que es el orden de alta y no
// cambia: la misma institución es siempre la misma Genérica N.
const GENERICO_STORAGE = 'pfi.modoGenerico';
let generico = true;
try {
  generico = localStorage.getItem(GENERICO_STORAGE) !== 'off';
} catch {
  // Sin localStorage (modo privado estricto) el default vale igual.
}

export const esGenerico = () => generico;

export function setGenerico(valor) {
  generico = valor;
  try {
    localStorage.setItem(GENERICO_STORAGE, valor ? 'on' : 'off');
  } catch { /* el modo sigue valiendo en memoria */ }
  return setClinics(clinicsCrudas);
}

// setClinics normaliza lo que devuelve /api/clinics al shape que usa la UI.
export function setClinics(lista) {
  clinicsCrudas = lista ?? [];
  clinicsCache = clinicsCrudas.map((c, i) => {
    const nro = i + 1;
    return {
      ...c,
      color: colorFor(c.key),
      activa: c.estado === 'activa',
      label: generico ? `Clínica Genérica ${nro}` : c.nombre,
      keyLabel: generico ? `generica${nro}` : c.key,
      mspLabel: generico ? `ClinicaGenerica${nro}MSP` : c.mspId,
      channelLabel: generico ? `canal-generica-${nro}` : c.privateChannel,
    };
  });
  return clinicsCache;
}

export const allClinics = () => clinicsCache;
export const activeClinics = () => clinicsCache.filter((c) => c.activa);
export const clinicByKey = (key) => clinicsCache.find((c) => c.key === key);

export const orgByMsp = (mspId) =>
  clinicsCache.find((c) => c.mspId === mspId) ?? { label: mspId, color: 'var(--muted)' };

// Para los eventos del chaincode, que traen el MSP ID crudo y pueden referirse
// a una institución que ya no está en el registro (una baja). En ese caso no
// hay nada que enmascarar y se devuelve el valor tal cual.
export const mspLabelFor = (mspId) => orgByMsp(mspId).mspLabel ?? mspId;

export async function api(path, body) {
  const res = await fetch(`/api${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || res.statusText);
  }
  return data;
}

// useClinics: mantiene el listado de clínicas y el cache de módulo en sync.
// reload() se llama tras un alta o una baja y ante los eventos de registro.
export function useClinics() {
  const [clinics, setState] = useState(clinicsCache);
  const [error, setError] = useState(null);

  const reload = useCallback(async () => {
    try {
      setState(setClinics(await api('/clinics')));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  return { clinics, error, reload };
}

// useFetch: GET con estado; refetchea cuando cambian deps y, opcionalmente,
// cada intervalMs (para status/canales).
export function useFetch(path, { deps = [], intervalMs } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api(path)
        .then((d) => { if (alive) { setData(d); setError(null); } })
        .catch((e) => { if (alive) setError(e.message); });
    load();
    const timer = intervalMs ? setInterval(load, intervalMs) : null;
    return () => { alive = false; if (timer) clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, intervalMs, ...deps]);

  return { data, error };
}

// useSSE: se conecta a /api/events y llama onMessage por cada evento.
export function useSSE(onMessage) {
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => handler.current(JSON.parse(e.data));
    return () => es.close();
  }, []);
}

// ---- Navegación ----
//
// Ruteo por hash, escrito a mano. Alcanza para las dos vistas que hay y evita
// sumar un router al proyecto: la URL queda compartible, el botón atrás del
// navegador funciona y recargar mantiene la vista, que es todo lo que se
// necesita de un router acá.
export function useRuta() {
  const [ruta, setRuta] = useState(() => window.location.hash.slice(1) || '/');

  useEffect(() => {
    const alCambiar = () => setRuta(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', alCambiar);
    return () => window.removeEventListener('hashchange', alCambiar);
  }, []);

  return ruta;
}

export const irA = (ruta) => { window.location.hash = ruta; };
export const rutaActivo = (id) => `#/activo/${encodeURIComponent(id)}`;
// Vista dedicada del mapa: una ruta propia y no un estado interno, así el
// botón de atrás del navegador vuelve al dashboard y la URL se puede compartir.
export const RUTA_MAPA = '/mapa';

// idDeRuta devuelve el id del activo si la ruta es la de detalle, o null.
export function idDeRuta(ruta) {
  const prefijo = '/activo/';
  if (!ruta.startsWith(prefijo)) return null;
  const crudo = ruta.slice(prefijo.length);
  if (!crudo) return null;
  try {
    return decodeURIComponent(crudo);
  } catch {
    // Un hash escrito a mano puede traer un % suelto y romper el decode.
    return crudo;
  }
}

export const shortHash = (h, n = 10) => (h ? `${h.slice(0, n)}…` : '');
export const fmtTs = (ts) => (ts ? new Date(ts).toLocaleTimeString('es-AR') : '');
