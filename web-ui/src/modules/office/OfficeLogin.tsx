import { useState, type FormEvent } from 'react';

import { Button, Card, CardContent, CardHeader, CardTitle, Input } from '@/shared/ui';
import { officeApi, writeOfficeSession } from '@/shared/api';

/** office 模組內部：員工／管理員登入表單。成功後寫入 session 並通知外層。 */
export function OfficeLogin({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [organizationSlug, setOrganizationSlug] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await officeApi.login({ organizationSlug: organizationSlug.trim(), email: email.trim(), password });
      writeOfficeSession(session);
      setPassword('');
      onLoggedIn();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm">
        <CardHeader><CardTitle>DHC AI Office 登入</CardTitle></CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={submit} aria-label="登入表單">
            <label className="block text-sm">組織代碼
              <Input value={organizationSlug} onChange={event => setOrganizationSlug(event.target.value)} autoComplete="organization" required />
            </label>
            <label className="block text-sm">Email
              <Input type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="username" required />
            </label>
            <label className="block text-sm">密碼
              <Input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required />
            </label>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <Button type="submit" className="w-full" disabled={busy}>{busy ? '登入中…' : '登入'}</Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
