/**
 * App-wide event context (T-2.5/E): ONE WebSocket for the whole UI.
 *
 * - components read the ring buffer; they never open their own sockets
 *   (prevents duplicate subscriptions and duplicate rendering sources)
 * - `generation` increments after every reconnect so pages can refetch REST
 *   state instead of assuming missed events were delivered
 * - events keep their engine `at` timestamp when present (never invented)
 */

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import { KaizenEventStream, type EventStreamStatus } from '../api/events';
import type { KaizenEventName } from '../api/types';
import { REPLAY } from '../lib/mode';

export interface StoredEvent {
  /** Monotonic per-session sequence (rendering key; also dedupes StrictMode double-renders). */
  seq: number;
  name: KaizenEventName;
  payload: Record<string, unknown>;
  /** Event timestamp from the payload when present, else local receipt time. */
  at: string;
  receivedAt: string;
}

interface EventsContextValue {
  events: StoredEvent[];
  status: EventStreamStatus;
  generation: number;
  clear: () => void;
}

const MAX_EVENTS = 500;

const EventsContext = createContext<EventsContextValue | null>(null);

export function EventsProvider({
  children,
  stream,
}: {
  children: ReactNode;
  /** Injectable for tests; defaults to a real stream at the same origin. */
  stream?: KaizenEventStream;
}): JSX.Element {
  const streamRef = useRef<KaizenEventStream | null>(stream ?? null);
  // Replay mode has no engine and therefore no live event stream: stay idle
  // ('closed') instead of reconnecting forever to a socket that is not there.
  if (!streamRef.current && !(REPLAY && !stream)) streamRef.current = new KaizenEventStream();
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [status, setStatus] = useState<EventStreamStatus>('connecting');
  const [generation, setGeneration] = useState(0);
  const seqRef = useRef(0);

  useEffect(() => {
    const s = streamRef.current;
    if (!s) {
      setStatus('closed');
      return undefined;
    }
    const offEvent = s.subscribe(({ name, payload }) => {
      const p = (payload ?? {}) as Record<string, unknown>;
      seqRef.current += 1;
      const stored: StoredEvent = {
        seq: seqRef.current,
        name,
        payload: p,
        at: typeof p['at'] === 'string' ? (p['at'] as string) : new Date().toISOString(),
        receivedAt: new Date().toISOString(),
      };
      setEvents((prev) => {
        const next = prev.length >= MAX_EVENTS ? prev.slice(prev.length - MAX_EVENTS + 1) : prev.slice();
        next.push(stored);
        return next;
      });
    });
    const offStatus = s.onStatus(setStatus);
    const offResync = s.onResync(() => setGeneration((g) => g + 1));
    return () => {
      offEvent();
      offStatus();
      offResync();
    };
  }, []);

  const value = useMemo<EventsContextValue>(
    () => ({ events, status, generation, clear: () => setEvents([]) }),
    [events, status, generation],
  );

  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>;
}

export function useEventsContext(): EventsContextValue {
  const ctx = useContext(EventsContext);
  if (!ctx) throw new Error('useEventsContext must be used inside <EventsProvider>');
  return ctx;
}
