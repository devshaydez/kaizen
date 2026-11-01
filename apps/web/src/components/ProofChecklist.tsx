import { motion, useReducedMotion } from 'framer-motion';
import type { JSX } from 'react';

export interface ProofCheckItem {
  label: string;
  ok: boolean | null;
  detail?: string;
  href?: string | null;
  linkLabel?: string;
}

/** Plain-language presentation of evidence already fetched by the parent screen. */
export function ProofChecklist({ items }: { items: ProofCheckItem[] }): JSX.Element {
  const reduce = useReducedMotion();
  const mark = (ok: boolean | null) => (ok === true ? '✓' : ok === false ? '✗' : '—');
  return (
    <motion.section
      className="proof-checklist"
      aria-label="Proof checklist"
      initial={reduce ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduce ? 0 : 0.2, ease: 'easeOut' }}
    >
      <div className="lab">Proof checklist</div>
      {items.map((item) => (
        <div className="proof-item" key={item.label}>
          <b className={item.ok === true ? 'ok' : item.ok === false ? 'bad' : 'warn'} aria-label={item.ok === true ? 'Passed' : item.ok === false ? 'Failed' : 'Not checked'}>
            {mark(item.ok)}
          </b>
          <div>
            <div>{item.label}</div>
            {item.detail && <div className="sub">{item.detail}</div>}
            {item.href && <a className="ext" href={item.href} target="_blank" rel="noreferrer">{item.linkLabel ?? 'Open explorer evidence'} ↗</a>}
          </div>
        </div>
      ))}
    </motion.section>
  );
}
