import { useEffect, useState } from 'react';

import { PII_BLOCK_EVENT } from '@/shared/piiGuard';

/** DHC CLI 個資防誤傳: says why something was not sent, whichever path the network guard stopped. */
export default function PiiBlockNotice() {
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (event: Event) => {
      setMessage((event as CustomEvent<{ message: string }>).detail.message);
      clearTimeout(timer);
      timer = setTimeout(() => setMessage(null), 10_000);
    };
    window.addEventListener(PII_BLOCK_EVENT, show);
    return () => {
      window.removeEventListener(PII_BLOCK_EVENT, show);
      clearTimeout(timer);
    };
  }, []);

  if (!message) return null;
  return (
    <div
      role="alert"
      className="fixed left-1/2 top-4 z-[1000] max-w-md -translate-x-1/2 whitespace-pre-line rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 shadow-lg dark:border-red-800 dark:bg-red-950 dark:text-red-200"
      onClick={() => setMessage(null)}
    >
      {message}
    </div>
  );
}
