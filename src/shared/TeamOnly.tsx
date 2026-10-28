import type { ReactNode } from 'react';

import { useIsTeamMode } from '@/shared/dhcConfig';

/** Renders its children only when dhc.config.json sets "mode": "team". */
export default function TeamOnly({ children }: { children: ReactNode }) {
  return useIsTeamMode() ? <>{children}</> : null;
}
