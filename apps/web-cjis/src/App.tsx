/**
 * CJIS enclave web app (SEC-12, ADR-0038). Served only by the enclave
 * gateway on its own origin; the platform console links here and never
 * fetches criminal-justice information itself. Layer-5 task E builds the
 * screens; this shell shows the system use notification (AC-8).
 */
export function App() {
  return (
    <main id="main" tabIndex={-1} className="notice">
      <h1>CJIS enclave</h1>
      <p>
        This system holds criminal-justice information. Access is limited to authorized, screened
        personnel, and every action is recorded.
      </p>
    </main>
  );
}
