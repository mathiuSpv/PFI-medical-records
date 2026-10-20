// Helpers de acceso al BFF (/api, proxy de Vite) + hooks de fetch y SSE.
//
// Las clínicas ya no están escritas acá: se piden a /api/clinics, que las lee
// del registro de la red. Como pueden darse de alta y de baja en caliente, el
// listado vive en un cache de módulo que App refresca (setClinics) y que las
// funciones sincrónicas —orgByMsp, sobre todo— consultan sin necesidad de que
// cada componente reciba la lista por props.
import { useCallback, useEffect, useRef, useState } from 'react';

// Las dos clínicas iniciales conservan sus colores fijos; a las demás se les
// asigna uno estable derivado del key, para que la misma clínica se vea igual.
const COLOR_FIJOS = {
  generica1: 'var(--org1)',
  generica2: 'var(--org2)',
};
// Tonos claros: estos colores se usan como texto (el nombre de la institución
// en tablas y feed) sobre los paneles oscuros, así que todos tienen que pasar
// 4.5:1 sobre --panel. Se evitan el azul y el teal de los dos colores fijos y
// el ámbar de marca, que es el de la acción primaria.
const PALETA = ['#c39bff', '#ff9e64', '#ff85bd', '#5fd3ea', '#a9a4ff', '#d7e36a'];

export function colorFor(key) {
  if (COLOR_FIJOS[key]) return COLOR_FIJOS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETA[h % PALETA.length];
}

let clinicsCache = [];

// setClinics normaliza lo que devuelve /api/clinics al shape que usa la UI.
export function setClinics(lista) {
  clinicsCache = (lista ?? []).map((c) => ({
    ...c,
    color: colorFor(c.key),
    activa: c.estado === 'activa',
    label: c.nombre,
  }));
  return clinicsCache;
}

export const allClinics = () => clinicsCache;
export const activeClinics = () => clinicsCache.filter((c) => c.activa);
export const clinicByKey = (key) => clinicsCache.find((c) => c.key === key);

export const orgByMsp = (mspId) =>
  clinicsCache.find((c) => c.mspId === mspId) ?? { label: mspId, color: 'var(--muted)' };

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
// rutaPrevia: de dónde se llegó a la vista actual. La ficha de un activo se abre
// desde el mapa, la tabla de Activos o la Auditoría, y "volver" tiene que llevar
// a ese lugar y no siempre al mapa.
let rutaPrevia = null;
export const rutaAnterior = () => rutaPrevia;

export function useRuta() {
  const [ruta, setRuta] = useState(() => window.location.hash.slice(1) || '/');

  useEffect(() => {
    const alCambiar = (e) => {
      try {
        rutaPrevia = new URL(e.oldURL).hash.slice(1) || '/';
      } catch {
        rutaPrevia = null;
      }
      setRuta(window.location.hash.slice(1) || '/');
    };
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

// Fechas del ledger: llegan en ISO UTC. Se muestran en hora local con un solo
// formato en toda la consola (dd/mm/aaaa hh:mm:ss); el valor ISO original queda
// en el title de quien lo muestre, que es el que sirve para auditar.
const FMT_FECHA = new Intl.DateTimeFormat('es-AR', {
  day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
export function fmtFecha(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : FMT_FECHA.format(d).replace(',', '');
}
// Vencimientos: se fijan como fecha (aaaa-mm-dd, 23:59:59 UTC) y se muestran
// como fecha, sin pasar a hora local para no correr el día.
export function fmtDia(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

// Jurisdicciones: el identificador es un slug (caba, santa-fe) porque es parte
// del nombre del canal; para mostrarlo se usa el nombre propio.
const JURISDICCIONES = {
  caba: 'CABA',
  cordoba: 'Córdoba',
  'entre-rios': 'Entre Ríos',
  neuquen: 'Neuquén',
  'rio-negro': 'Río Negro',
  tucuman: 'Tucumán',
};
const MENORES = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
export function nombreJurisdiccion(slug) {
  if (!slug) return '';
  if (slug === 'nacional') return 'Nacional';
  if (JURISDICCIONES[slug]) return JURISDICCIONES[slug];
  return slug.split('-')
    .map((w, i) => (i > 0 && MENORES.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}
