import { useState } from "react";
import { PLATFORM_TERMS_VERSION } from "../terms";

export default function TermsAgreement({ onAgree, onDisagree }: { onAgree: () => void | Promise<void>; onDisagree: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function agree() {
    setBusy(true);
    setError("");
    try { await onAgree(); }
    catch (reason) { setError((reason as Error).message || "Could not save your agreement. Please try again."); }
    finally { setBusy(false); }
  }

  return <div className="terms-backdrop"><section className="terms-dialog" role="dialog" aria-modal="true" aria-labelledby="terms-title" aria-describedby="terms-intro">
    <header><p className="eyebrow">BRIANNA MICROFINANCE LIMITED · VERSION {PLATFORM_TERMS_VERSION}</p><h2 id="terms-title">Terms of use</h2><p id="terms-intro">Please read these account terms and choose whether you agree.</p></header>
    <div className="terms-content">
      <section><h3>Using your account</h3><p>Provide accurate information, keep your sign-in details private, and tell BML if you believe someone has accessed your account without permission.</p></section>
      <section><h3>Acceptable use</h3><p>Use the BML platform for its intended services. Do not impersonate another person, submit false information, interfere with the service, or try to access accounts or data without authorization.</p></section>
      <section><h3>Requests and loan decisions</h3><p>Registration and requests submitted through the platform may be reviewed and verified by BML. Creating an account or submitting a request does not approve a loan or promise that credit will be offered.</p></section>
      <section><h3>Payments</h3><p>Check the loan, amount, and payment details before confirming a payment. If a payment is pending or its status is unclear, check its status before submitting another one.</p></section>
      <section><h3>Loan agreements</h3><p>These platform terms do not set your loan amount, interest, fees, repayment schedule, or other credit conditions. BML will provide the applicable loan agreement and disclosures separately for review before a loan is accepted.</p></section>
      <section><h3>Account access</h3><p>BML may restrict platform access when needed to protect an account, investigate suspected misuse, or maintain the service. You may choose not to agree; if you do, you cannot create or continue using a BML platform account.</p></section>
    </div>
    {error && <p className="note note-error" role="alert">{error}</p>}
    <footer><button type="button" className="btn btn-ghost" disabled={busy} onClick={onDisagree}>Disagree</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void agree()}>{busy ? "Saving…" : "I agree"}</button></footer>
  </section></div>;
}
