export function AuthSide() {
  return (
    <aside className="auth-side">
      <img src="/brand/logo-tagline-reversed.svg" alt="Softilo — Innovation, Leadership, Outcomes" />
      <div>
        <h2>Accounts, stock and landed cost in one system, built for UK importers.</h2>
        <ul>
          <li>Double-entry ledger with 9-box VAT returns</li>
          <li>Landed cost across freight, duty and brokerage</li>
          <li>Postponed import VAT matched to shipments</li>
          <li>Every company&apos;s data kept apart by the database, with a tamper-evident audit trail</li>
        </ul>
      </div>
      <small style={{ color: "#8f8a7f" }}>© {new Date().getFullYear()} Softilo</small>
    </aside>
  );
}
