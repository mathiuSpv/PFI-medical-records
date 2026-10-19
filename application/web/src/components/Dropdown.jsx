// Dropdown propio: reemplaza el <select> nativo para poder estilar cada fila del
// listado (el popup nativo lo dibuja el SO y no se puede estilar de verdad).
// options = [{ value, label }]. onChange(value). Cierra al elegir o al clickear
// afuera.
//
// Teclado como el de un select: con el foco en el botón, flechas / Enter /
// Espacio abren; abierto, flechas, Inicio y Fin recorren las opciones, Enter o
// Espacio eligen, Escape y Tab cierran. El foco se queda en el botón y la opción
// resaltada se anuncia con aria-activedescendant.
import { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon.jsx';

export default function Dropdown({ value, onChange, options, disabled = false, ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [resaltada, setResaltada] = useState(-1);
  const ref = useRef(null);
  const listaRef = useRef(null);
  const id = useId();

  const indiceSel = options.findIndex((o) => o.value === value);
  const sel = options[indiceSel];

  useEffect(() => {
    if (!open) return undefined;
    const alClickear = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('click', alClickear);
    return () => document.removeEventListener('click', alClickear);
  }, [open]);

  // La opción resaltada siempre a la vista, también con listas que scrollean.
  useEffect(() => {
    if (!open || resaltada < 0) return;
    listaRef.current?.children[resaltada]?.scrollIntoView({ block: 'nearest' });
  }, [open, resaltada]);

  const abrir = (indice = indiceSel) => {
    setResaltada(indice >= 0 ? indice : 0);
    setOpen(true);
  };

  const elegir = (indice) => {
    const o = options[indice];
    if (o) onChange(o.value);
    setOpen(false);
  };

  const alTecla = (e) => {
    if (disabled || options.length === 0) return;
    const ultima = options.length - 1;
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        abrir(e.key === 'ArrowUp' && indiceSel < 0 ? ultima : indiceSel);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setResaltada((i) => Math.min(ultima, i + 1)); break;
      case 'ArrowUp': e.preventDefault(); setResaltada((i) => Math.max(0, i - 1)); break;
      case 'Home': e.preventDefault(); setResaltada(0); break;
      case 'End': e.preventDefault(); setResaltada(ultima); break;
      case 'Enter':
      case ' ': e.preventDefault(); elegir(resaltada); break;
      case 'Escape': e.preventDefault(); setOpen(false); break;
      case 'Tab': setOpen(false); break;
      default:
    }
  };

  return (
    <div className="dd" ref={ref}>
      <button
        type="button"
        className="dd-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-lista`}
        aria-activedescendant={open && resaltada >= 0 ? `${id}-op-${resaltada}` : undefined}
        aria-label={ariaLabel}
        onClick={(e) => { e.stopPropagation(); if (!disabled) (open ? setOpen(false) : abrir()); }}
        onKeyDown={alTecla}
      >
        <span className="dd-value">{sel ? sel.label : ''}</span>
        <Icon name="chevron-down" size={15} className={`dd-caret ${open ? 'abierto' : ''}`} />
      </button>
      {open && (
        <ul className="dd-list" role="listbox" id={`${id}-lista`} aria-label={ariaLabel} ref={listaRef}>
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-op-${i}`}
              role="option"
              aria-selected={o.value === value}
              className={`dd-opt ${o.value === value ? 'active' : ''} ${i === resaltada ? 'resaltada' : ''}`}
              onMouseEnter={() => setResaltada(i)}
              onClick={() => elegir(i)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
