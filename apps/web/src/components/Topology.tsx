/**
 * Network topology stage (design import, T-3.6C).
 *
 * `Topology` renders REAL nodes from the view-model: edges are the engine's
 * expected full mesh; solid/pulsing = link observed alive by monitoring,
 * dashed red = not observed (see lib/model.ts). The per-node bar shows
 * connected peers out of the expected peer count.
 *
 * `TopoView` is the presentational stage; the landing page feeds it a
 * clearly captioned illustration (no live data claimed there).
 */

import { motion } from 'framer-motion';
import type { CSSProperties } from 'react';
import type { VNet } from '../lib/model';
import { ease } from './ui';

const W = 760;
const H = 330;
const Y = 214;

export interface TopoNode {
  id: string;
  num: string;
  badge: string;
  tone: 'ok' | 'bad' | 'rec' | 'pau';
  role: string;
  peers: number | null;
  expected: number;
  height: number | null;
  caption?: string;
  ariaLabel: string;
  glitch?: boolean;
}

export interface TopoEdge {
  a: string;
  b: string;
  alive: boolean;
  basis?: string;
}

export function TopoView({ nodes, edges, sel, onSelect, testId }: { nodes: TopoNode[]; edges: TopoEdge[]; sel?: string; onSelect?: (id: string) => void; testId?: string }) {
  const n = nodes.length;
  const X = (i: number) => ((i + 0.5) / Math.max(n, 1)) * W;
  const idx = new Map(nodes.map((v, i) => [v.id, i]));
  const width = n > 6 ? 104 : n > 4 ? 122 : 144;
  const scale = n > 6 ? 0.78 : n > 4 ? 0.86 : 1;
  const height = Number((330 * scale).toFixed(1));
  return (
    <div className="stage" data-testid={testId} style={{ '--topo-scale': scale, '--topo-height': `${height}px` } as CSSProperties}>
      <div className="stage-viewport">
        <div className="stage-canvas">
          <svg viewBox={`0 0 ${W} ${H}`} aria-hidden>
            {edges.map((e) => {
              const i = idx.get(e.a) ?? 0;
              const j = idx.get(e.b) ?? 0;
              const d = Math.abs(j - i);
              const h = Math.min(44 + d * 50, 190);
              const p = `M${X(i)} ${Y} C${X(i)} ${Y - h * 1.33} ${X(j)} ${Y - h * 1.33} ${X(j)} ${Y}`;
              return (
                <g key={`${e.a}-${e.b}`} data-edge={e.basis ?? (e.alive ? 'alive' : 'down')}>
                  <motion.path d={p} fill="none" strokeWidth={e.alive ? 1.2 : 1.5} strokeDasharray={e.alive ? '0' : '2 6'} strokeLinecap="round" initial={false} animate={{ stroke: e.alive ? 'rgba(205,185,255,.42)' : 'rgba(255,122,102,.75)' }} transition={{ duration: 0.6, ease }} />
                  {e.alive && <motion.path d={p} pathLength={1} className="pulse" initial={{ strokeDashoffset: 0 }} animate={{ strokeDashoffset: -0.5 }} transition={{ duration: 2.8 + d * 1.2, repeat: Infinity, ease: 'linear' }} />}
                </g>
              );
            })}
          </svg>
          {nodes.map((v, i) => {
            const bars = Math.max(v.expected, 0);
            const filled = bars ? Math.round((Math.min(v.peers ?? 0, bars) / bars) * 16) : 0;
            return (
              <motion.button
                type="button"
                key={v.id}
                className={`node ${v.tone === 'bad' ? 'bad' : ''} ${v.tone === 'rec' ? 'rec' : ''} ${v.tone === 'pau' ? 'pau' : ''} ${sel === v.id ? 'sel' : ''}`}
                style={{ left: `${(X(i) / W) * 100}%`, x: '-50%', width: `min(${width}px, calc(${100 / Math.max(n, 1)}% - 10px))` }}
                whileHover={onSelect ? { y: -3 } : undefined}
                whileTap={onSelect ? { scale: 0.985 } : undefined}
                transition={{ duration: 0.2, ease }}
                onClick={() => onSelect?.(v.id)}
                disabled={!onSelect}
                aria-label={v.ariaLabel}
                title={v.caption}
              >
                <span className="nh">
                  <span className="ni">{v.num}</span>
                  <motion.span key={v.badge} className="nc" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease }}>
                    {v.badge}
                  </motion.span>
                </span>
                <span className="nl">
                  {v.role} · {v.peers ?? '—'}
                  <br />
                  Peers
                </span>
                {bars > 0 && (
                  <span className="nk" title={`${v.peers ?? 0} of ${v.expected} expected peers`}>
                    {Array.from({ length: 16 }, (_, k) => (
                      <b key={k} className={k >= filled ? 'm' : ''} />
                    ))}
                  </span>
                )}
                <span className="nm">{v.height !== null ? `#${v.height.toLocaleString('en-US')}` : '# —'}</span>
                {v.glitch && (
                  <span className="glitch" aria-hidden>
                    {[
                      [-30, 34, 46, 58],
                      [20, 34, 46, 58],
                      [70, 34, 46, 58],
                      [120, 34, 46, 58],
                      [170, 34, 46, 58],
                    ].map(([x, y, w, h], k) => (
                      <motion.i key={k} style={{ left: x, top: y, width: w, height: h }} initial={{ opacity: 0 }} animate={{ opacity: [0.2, 0.9, 0.4] }} transition={{ duration: 2.4, repeat: Infinity, delay: k * 0.18 }} />
                    ))}
                  </span>
                )}
              </motion.button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const TONE = { running: 'ok', offline: 'bad', recovering: 'rec', paused: 'pau' } as const;

export function Topology({ net, sel, onSelect }: { net: VNet; sel?: string; onSelect?: (id: string) => void }) {
  const nodes: TopoNode[] = net.nodes.map((v, i) => ({
    id: v.id,
    num: String(i + 1).padStart(2, '0'),
    badge: v.stateLabel,
    tone: TONE[v.state],
    role: v.role,
    peers: v.peers,
    expected: v.expectedPeers,
    height: v.height,
    caption: `${v.label} (${v.name})`,
    ariaLabel: `${v.name}, ${v.stateLabel}`,
    glitch: v.state === 'offline' && v.activeFault !== null,
  }));
  return <TopoView testId="topology" nodes={nodes} edges={net.edges} sel={sel} onSelect={onSelect} />;
}
