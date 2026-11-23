import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { currentClaims, refresh, setSignedOutHandler, setTokens, signOut, type Claims, type Tokens } from './api';

interface AuthState {
  claims: Claims | null;
  ready: boolean;
  signIn(tokens: Tokens): void;
  signOut(): Promise<void>;
  /** super_admin passes every check, as in the API. */
  can(...roles: string[]): boolean;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [claims, setClaims] = useState<Claims | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSignedOutHandler(() => setClaims(null));
    // Restore a session after reload from the refresh token, if there is one.
    refresh()
      .then((ok) => setClaims(ok ? currentClaims() : null))
      .finally(() => setReady(true));
  }, []);

  const signIn = useCallback((t: Tokens) => {
    setTokens(t);
    setClaims(currentClaims());
  }, []);

  const can = useCallback(
    (...roles: string[]) =>
      !!claims && claims.kind === 'staff' && (claims.roles.includes('super_admin') || roles.some((r) => claims.roles.includes(r))),
    [claims],
  );

  return <Ctx.Provider value={{ claims, ready, signIn, signOut, can }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
