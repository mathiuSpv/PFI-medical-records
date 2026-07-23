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
const PALETA = ['#c88cff', '#f0b429', '#ff8f6b', '#4dd6c1', '#ff6bb5', '#9aa8ff'];

export function colorFor(key) {
  if (COLOR_FUNDADORAS[key]) return COLOR_FUNDADORAS[key];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return PALETA[h % PALETA.length];
}

let clinicsCache = [];

// setClinics normaliza lo que devuelve /api/clinics al shape que usa la UI.
export function setClinics(lista) {
  clinicsCache = (lista ?? []).map((c) => ({
    ...c,
    label: c.nombre,
    color: colorFor(c.key),
    activa: c.estado === 'activa',
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

export const shortHash = (h, n = 10) => (h ? `${h.slice(0, n)}…` : '');
export const fmtTs = (ts) => (ts ? new Date(ts).toLocaleTimeString('es-AR') : '');
