import { useEffect, useState } from 'react';

export function useRealtime() {
  const [connected, setConnected] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const source = new EventSource('/api/events');
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => setRevision((value) => value + 1), 60);
    };
    source.addEventListener('connection', (event) => {
      const { ready } = JSON.parse((event as MessageEvent).data) as { ready: boolean };
      setConnected(ready);
      if (ready) refresh();
    });
    source.addEventListener('task-change', refresh);
    source.onerror = () => setConnected(false);
    const reconcile = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => {
      source.close(); clearTimeout(refreshTimer); clearInterval(reconcile); window.removeEventListener('focus', refresh);
    };
  }, []);
  return { connected, revision };
}
