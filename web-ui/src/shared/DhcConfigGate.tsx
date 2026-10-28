import { useEffect, useState, type ReactNode } from 'react';

import { loadDhcConfig } from '@/shared/dhcConfig';

/** Holds the workspace until dhc.config.json is loaded, so the sidebar sorts projects with the right root on its first render. */
export default function DhcConfigGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadDhcConfig().finally(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  return ready ? <>{children}</> : null;
}
