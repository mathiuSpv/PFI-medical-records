import { useEffect, useState } from 'react';
import { RUTA_MAPA, api, idDeRuta, useClinics, useRuta, useSSE } from './api.js';
import ActionsPanel from './components/ActionsPanel.jsx';
import ClinicsPanel from './components/ClinicsPanel.jsx';
import AssetsPanel from './components/AssetsPanel.jsx';
import ConsentsPanel from './components/ConsentsPanel.jsx';
import AccessLogPanel from './components/AccessLogPanel.jsx';
import EventFeed from './components/EventFeed.jsx';
import GraphPanel from './components/GraphPanel.jsx';
import AssetPage from './components/AssetPage.jsx';

// Sub-módulos de la solapa Operación: cada uno es su propio panel, separados en
// sub-solapas para no apilar los cinco en una columna que obliga a scrollear.
const SUBMODULOS = [
  ['instituciones', 'Instituciones'],
  ['acciones', 'Acciones'],
  ['activos', 'Activos'],
  ['consentimientos', 'Consentimientos'],
  ['auditoria', 'Auditoría'],
  ['entregas', 'Entregas'],
];

export default function App() {
  const { clinics, reload: reloadClinics } = useClinics();
  const activas = clinics.filter((c) => c.activa);

  // No hay identidad global: la consola administra la red entera y no actúa como
  // ninguna institución. La org que firma se elige dentro de cada acción que
  // genera una transacción (ver ActionsPanel y AssetPage).
  //
  // tick: contador de refresco — las tablas refetchean cuando cambia
  // (tras cada acción propia y ante cada evento SSE).
  const [tick, setTick] = useState(0);
  const [feed, setFeed] = useState([]);
  const [solapa, setSolapa] = useState('operacion');
  const [subOp, setSubOp] = useState('instituciones');
  const bump = () => setTick((t) => t + 1);

  // Ruta por hash: '#/activo/<id>' abre la página del documento, '#/mapa' la
  // vista dedicada del grafo, cualquier otra cosa es el dashboard.
  const ruta = useRuta();
  const activoId = idDeRuta(ruta);
  const soloMapa = ruta === RUTA_MAPA;

  // Entregas previas al load (el feed SSE solo trae lo nuevo).
  useEffect(() => {
    api('/deliveries')
      .then((ds) => setFeed(
        ds.map((d) => ({ type: 'key-delivery', delivery: d, receivedAt: Date.parse(d.timestamp) })).reverse(),
      ))
      .catch(() => {});
  }, []);

  useSSE((msg) => {
    // El progreso de un alta/baja no va al feed general: lo muestra el panel de
    // clínicas, que es donde el usuario está mirando mientras corre.
    if (msg.type === 'clinic-op') {
      if (msg.estado === 'ok') reloadClinics();
      return;
    }
    if (msg.type === 'clinic-event') reloadClinics();
    setFeed((f) => [{ ...msg, receivedAt: Date.now() }, ...f].slice(0, 100));
    bump();
  });

  // Vista del mapa: se devuelve antes del encabezado a propósito, porque la
  // idea es que no haya nada más en pantalla que la topología.
  if (soloMapa) return <GraphPanel clinics={clinics} tick={tick} soloMapa />;

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <img className="brand-mark" src="/favicon.svg" alt="Medambar" width="40" height="40" />
          <div>
            <h1 className="wordmark">Med<span className="accent">amb</span>ar</h1>
            <p className="subtitle">Panel de prueba · bus de interoperabilidad de activos médicos</p>
          </div>
        </div>
      </header>

      {activoId ? <AssetPage id={activoId} tick={tick} activas={activas} onDone={bump} /> : (
      <>
      {/* Dos vistas de lo mismo: operar el bus, o mirar lo que quedó registrado
          como grafo. La segunda va a ancho completo y sin el feed, porque el
          lienzo necesita todo el espacio disponible. */}
      <nav className="solapas" role="tablist" aria-label="Vistas">
        {/* Operación: al pasar el cursor (o enfocar) despliega sus módulos. */}
        <div className="solapa-wrap">
          <button
            role="tab"
            aria-selected={solapa === 'operacion'}
            aria-haspopup="menu"
            className={`solapa ${solapa === 'operacion' ? 'active' : ''}`}
            onClick={() => setSolapa('operacion')}
          >
            Operación ▾
          </button>
          <div className="submenu" role="menu">
            {SUBMODULOS.map(([id, etiqueta]) => (
              <button
                key={id}
                role="menuitem"
                className={`submenu-item ${solapa === 'operacion' && subOp === id ? 'active' : ''}`}
                onClick={() => { setSolapa('operacion'); setSubOp(id); }}
              >
                {etiqueta}
              </button>
            ))}
          </div>
        </div>
        <button
          role="tab"
          aria-selected={solapa === 'red'}
          className={`solapa ${solapa === 'red' ? 'active' : ''}`}
          onClick={() => setSolapa('red')}
        >
          Red de datos
        </button>
      </nav>

      {solapa === 'operacion' ? (
        <div className="main-col">
            {/* El módulo activo se elige en el flyout de la solapa Operación. */}
            {subOp === 'instituciones' && (
              <ClinicsPanel clinics={clinics} onChanged={() => { reloadClinics(); bump(); }} />
            )}
            {subOp === 'acciones' && (
              activas.length > 0
                ? <ActionsPanel clinics={activas} onDone={bump} />
                : <div className="panel"><p className="hint">No hay instituciones activas para operar.</p></div>
            )}
            {subOp === 'activos' && <AssetsPanel tick={tick} />}
            {subOp === 'consentimientos' && <ConsentsPanel tick={tick} />}
            {subOp === 'auditoria' && <AccessLogPanel tick={tick} />}
            {subOp === 'entregas' && <EventFeed feed={feed} soloEntregas />}
        </div>
      ) : (
        <div className="main-col">
          <GraphPanel clinics={clinics} tick={tick} />
        </div>
      )}
      </>
      )}
    </div>
  );
}
