// Helpers de acceso al BFF (/api, proxy de Vite) + hooks de fetch y SSE.
import { useEffect, useRef, useState } from 'react';

export const ORGS = {
  sancristobal: { mspId: 'ClinicaSanCristobalMSP', label: 'Clínica San Cristóbal', color: 'var(--sc)' },
  montenegro: { mspId: 'ClinicaMontenegroMSP', label: 'Clínica Montenegro', color: 'var(--mn)' },
};

export const otherOrg = (orgKey) => (orgKey === 'sancristobal' ? 'montenegro' : 'sancristobal');

export const orgByMsp = (mspId) =>
  Object.entries(ORGS).find(([, o]) => o.mspId === mspId)?.[1] ?? { label: mspId, color: 'var(--muted)' };

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
