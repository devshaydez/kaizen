/**
 * Console UI primitives (T-3.6B) — ported from the Kaizen design import
 * (framer-motion look and feel). Presentation only: no data lives here.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { LayoutGroup, motion, useReducedMotion, useSpring, useTransform } from 'framer-motion';
import { Link } from 'react-router-dom';
import type { ApiError } from '../api/client';

export const ease = [0.16, 0.68, 0.43, 0.99] as const;

export function useNow(ms = 1000): number {
  const [t, setT] = useState(Date.now());
  useEffect(() => {
    const i = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(i);
  }, [ms]);
  return t;
}

/** Spring-animated number. Renders an em dash for unknown values (never 0). */
export function Num({ v, fmt }: { v: number | null | undefined; fmt?: (n: number) => string }) {
  const sp = useSpring(v ?? 0, { stiffness: 80, damping: 18 });
  useEffect(() => {
    if (v !== null && v !== undefined) sp.set(v);
  }, [v, sp]);
  const t = useTransform(sp, (x) => (fmt ? fmt(x) : Math.round(x).toLocaleString('en-US')));
  if (v === null || v === undefined) return <span>—</span>;
  return <motion.span data-value={v}>{t}</motion.span>;
}

const Arrow = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export function Btn({
  children,
  onClick,
  tone = 'ghost',
  arrow,
  disabled,
  small,
  title,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  tone?: 'pri' | 'ghost' | 'danger' | 'line';
  arrow?: boolean;
  disabled?: boolean;
  small?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}) {
  const reduce = useReducedMotion();
  return (
    <motion.button
      type={type}
      className={`btn ${tone} ${small ? 'sm' : ''}`}
      whileHover={disabled || reduce ? undefined : { y: -1 }}
      whileTap={disabled || reduce ? undefined : { scale: 0.98 }}
      transition={{ duration: reduce ? 0 : 0.18, ease }}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
      {arrow && (
        <i>
          <Arrow />
        </i>
      )}
    </motion.button>
  );
}

export function Seg<T extends string | number>({
  items,
  value,
  onChange,
  id,
  wrap,
  label,
}: {
  items: { v: T; l: string; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  id: string;
  wrap?: boolean;
  label?: string;
}) {
  return (
    <LayoutGroup id={id}>
      <div className={`seg ${wrap ? 'wrap' : ''}`} role="group" aria-label={label}>
        {items.map((i) => (
          <button
            type="button"
            key={String(i.v)}
            className={i.v === value ? 'on' : ''}
            aria-pressed={i.v === value}
            disabled={i.disabled}
            title={i.title}
            onClick={() => onChange(i.v)}
          >
            {i.v === value && <motion.span layoutId={`${id}-pill`} className="pill" transition={{ duration: 0.28, ease }} />}
            <span>{i.l}</span>
          </button>
        ))}
      </div>
    </LayoutGroup>
  );
}

export function Empty({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <h1>{title}</h1>
      <p>{text}</p>
      {action}
    </div>
  );
}

export function NoNet() {
  return (
    <Empty
      title="No network selected"
      text="Create a Portaldot network (or pick one from the selector above). Kaizen starts real portaldot_dev processes."
      action={
        <Link to="/create" className="btn pri">
          Create network
        </Link>
      }
    />
  );
}

export const STEPS = ['Create', 'Monitor', 'Break', 'Diagnose', 'Recover', 'Deploy'];

export function Stat({ label, children, sub, tone }: { label: string; children: ReactNode; sub?: string; tone?: 'bad' | 'warn' | 'ok' }) {
  return (
    <div className="stat">
      <div className="lab">{label}</div>
      <div className={`num ${tone ?? ''}`}>{children}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/** "Not built yet" label: unimplemented features are labelled, never faked (DEC-009). */
export function Planned({ phase, children }: { phase: string; children?: ReactNode }) {
  return (
    <span className="planned" title={`Not implemented yet — planned in ${phase}`}>
      {children ?? 'Coming in'} {phase}
    </span>
  );
}

export function ErrorBox({ error, title }: { error: ApiError | Error | null | undefined; title?: string }) {
  if (!error) return null;
  const code = (error as ApiError).code;
  return (
    <div className="errbox" role="alert">
      <b>{title ?? 'Request failed'}{code ? ` (${code})` : ''}</b>
      {error.message}
    </div>
  );
}

export const fmtUp = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600) ? Math.floor(s / 3600) + 'h ' : ''}${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m ${String(s % 60).padStart(2, '0')}s`;
};
