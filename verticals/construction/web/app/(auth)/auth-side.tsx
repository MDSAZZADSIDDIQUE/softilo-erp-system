export function AuthSide() {
  return (
    <aside className="auth-side">
      <img src="/brand/logo-tagline-reversed.svg" alt="Softilo — Innovation, Leadership, Outcomes" />
      <div>
        <h2>Job costing, CIS and applications for payment, in the same books as your accounts.</h2>
        <ul>
          <li>CIS deductions on labour only, with monthly CIS300 returns</li>
          <li>Retentions held and released on every application</li>
          <li>Domestic reverse charge decided per project</li>
          <li>Payment and pay-less notice dates on every valuation</li>
        </ul>
      </div>
      <small style={{ color: "#8f8a7f" }}>© {new Date().getFullYear()} Softilo</small>
    </aside>
  );
}
