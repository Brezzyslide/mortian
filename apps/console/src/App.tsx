import { brand } from '@project/domain';

export function App() {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>{brand.name}</h1>
      <p>Admin console — Phase 0 scaffold.</p>
    </main>
  );
}
