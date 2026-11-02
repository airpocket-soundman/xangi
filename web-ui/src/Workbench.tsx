import { type ReactNode, useEffect, useRef, useState } from 'react';
import './workbench.css';

/** The extension owns panel tabs; the host owns placement of its existing chat. */
export function Workbench({ children }: { children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 700px)').matches);
  const [available, setAvailable] = useState(false);
  const [visible, setVisible] = useState(false);
  const [direction, setDirection] = useState('horizontal');
  const [ratio, setRatio] = useState(50);
  const axis = compact ? 'vertical' : direction;
  useEffect(() => {
    const query = window.matchMedia('(max-width: 700px)');
    const change = () => setCompact(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    let disposed = false;
    const check = async () => {
      try {
        const response = await fetch('/api/extensions', { signal: AbortSignal.timeout(10000) });
        if (!response.ok) return;
        const catalog = await response.json();
        if (!disposed)
          setAvailable(
            catalog.extensions?.some(
              (entry: { id: string; installed: boolean; healthy: boolean; uiAvailable: boolean }) =>
                entry.id === 'xangi-workbench' &&
                entry.installed &&
                entry.healthy &&
                entry.uiAvailable
            ) === true
          );
      } catch {
        /* Keep the current chat available during a host reconnect. */
      }
    };
    void check();
    const timer = setInterval(() => void check(), 15000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow)
        return;
      const data = event.data;
      if (
        data?.type !== 'xangi.workbench.layout' ||
        data.schemaVersion !== 1 ||
        typeof data.visible !== 'boolean' ||
        !['horizontal', 'vertical'].includes(data.direction) ||
        !Number.isFinite(data.ratio) ||
        data.ratio < 15 ||
        data.ratio > 85
      )
        return;
      setVisible(data.visible);
      setDirection(data.direction);
      if (!drag.current) setRatio(data.ratio);
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);
  const notify = () =>
    frame.current?.contentWindow?.postMessage(
      { type: 'xangi.workbench.visibility', visible: visible && available },
      window.location.origin
    );
  useEffect(notify, [visible, available]);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { type: 'xangi.workbench.resize', schemaVersion: 1, ratio },
      window.location.origin
    );
  }, [ratio, available]);
  const shown = visible && available;
  return (
    <div
      ref={container}
      className={`workbench ${shown ? 'workbench-open' : ''} workbench-${axis} ${dragging ? 'workbench-resizing' : ''}`}
      style={
        shown
          ? {
              gridTemplateColumns:
                axis === 'horizontal' ? `${ratio}fr 6px ${100 - ratio}fr` : 'minmax(0, 1fr)',
              gridTemplateRows:
                axis === 'vertical' ? `${ratio}fr 6px ${100 - ratio}fr` : 'minmax(0, 1fr)',
            }
          : undefined
      }
    >
      <div className="workbench-chat">{children}</div>
      {shown && (
        <div
          className="workbench-divider"
          role="separator"
          tabIndex={0}
          aria-label="チャットとワークベンチの境界"
          aria-orientation={axis === 'horizontal' ? 'vertical' : 'horizontal'}
          aria-valuemin={15}
          aria-valuemax={85}
          aria-valuenow={Math.round(ratio)}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            const bounds = event.currentTarget.getBoundingClientRect();
            drag.current = {
              pointerId: event.pointerId,
              offset:
                axis === 'horizontal'
                  ? event.clientX - (bounds.left + bounds.width / 2)
                  : event.clientY - (bounds.top + bounds.height / 2),
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.focus();
            event.preventDefault();
            setDragging(true);
          }}
          onPointerMove={(event) => {
            if (drag.current?.pointerId !== event.pointerId || !container.current) return;
            const bounds = container.current.getBoundingClientRect();
            const size = axis === 'horizontal' ? bounds.width : bounds.height;
            if (size <= 6) return;
            const position =
              axis === 'horizontal' ? event.clientX - bounds.left : event.clientY - bounds.top;
            const next = ((position - drag.current.offset - 3) / (size - 6)) * 100;
            setRatio(Math.min(85, Math.max(15, next)));
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId !== event.pointerId) return;
            drag.current = null;
            setDragging(false);
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onLostPointerCapture={() => {
            drag.current = null;
            setDragging(false);
          }}
          onKeyDown={(event) => {
            const decrease = axis === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
            const increase = axis === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
            if (![decrease, increase, 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            setRatio((value) =>
              event.key === 'Home'
                ? 15
                : event.key === 'End'
                  ? 85
                  : Math.min(85, Math.max(15, value + (event.key === increase ? 2 : -2)))
            );
          }}
        />
      )}
      {available && (
        <button
          className="workbench-toggle"
          type="button"
          aria-expanded={shown}
          onClick={() => setVisible((value) => !value)}
        >
          ワークベンチ {shown ? 'を隠す' : 'を表示'}
        </button>
      )}
      {available && (
        <iframe
          ref={frame}
          className="workbench-frame"
          hidden={!shown}
          title="Xangi Workbench"
          src="/api/extensions/xangi-workbench/service/"
          onLoad={notify}
        />
      )}
    </div>
  );
}
