import React, { useEffect, useState } from "react";

export function SecuritySettings({ request }) {
  const [status, setStatus] = useState(null);
  const [setup, setSetup] = useState(null);
  const [codes, setCodes] = useState(null);
  const [accessKey, setAccessKey] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    request("/auth/2fa").then(setStatus).catch((err) => setError(err.message));
  }, [request]);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const action = status.enabled ? "disable" : setup ? "enable" : "setup";
    try {
      const result = await request(`/auth/2fa/${action}`, { method: "POST", body: JSON.stringify({ accessKey, code }) });
      if (action === "setup") {
        setSetup(result);
      } else {
        setSetup(null);
        setAccessKey("");
        setCode("");
        setCodes(result.recoveryCodes || null);
        setStatus({ enabled: result.enabled, recoveryCodesRemaining: result.recoveryCodes?.length || 0 });
        setMessage(result.enabled ? "Two-factor authentication is enabled. Other browser sessions have been signed out." : "Two-factor authentication is disabled.");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function downloadCodes() {
    const blob = new Blob(["Optimus recovery codes\nEach code can be used once, together with your access key. Store these somewhere safe.\n\n" + codes.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "optimus-recovery-codes.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return <section className="security-settings form-stack">
    <h2>Two-factor authentication</h2>
    {status ? <p>{status.enabled ? `Enabled · ${status.recoveryCodesRemaining} recovery codes remaining` : "Not enabled"}</p> : <p>Loading security settings…</p>}
    <p>Use Ente Auth, Google Authenticator, or another TOTP app. Codes are verified locally with no subscription.</p>
    {message && <p role="status">{message}</p>}
    {codes ? <div className="form-stack">
      <h3>Save your recovery codes</h3>
      <p>These are shown only once. Each code replaces an authenticator code for one login and still requires your access key. Store them somewhere safe before leaving this page.</p>
      <pre className="security-recovery-codes">{codes.join("\n")}</pre>
      <button className="button button-primary" onClick={downloadCodes}>Download recovery codes</button>
      <button className="button button-secondary" onClick={() => setCodes(null)}>I have saved my recovery codes</button>
    </div> : status && <form className="form-stack" onSubmit={submit}>
      <div className="field"><label htmlFor="security-key">Confirm your access key</label>
        <input id="security-key" type="password" autoComplete="current-password" required value={accessKey} onChange={(event) => setAccessKey(event.target.value)} />
      </div>
      {setup && <div className="form-stack">
        <p>Scan this QR code with your authenticator. Setup expires after ten minutes.</p>
        <img className="security-qr" src={setup.qrCode} alt="Scan to add Optimus to your authenticator" />
        <p>Or enter this setup key manually:</p><code className="security-secret">{setup.secret}</code>
      </div>}
      {(setup || status.enabled) && <div className="field">
        <label htmlFor="security-code">{status.enabled ? "Authenticator or recovery code" : "Six-digit authenticator code"}</label>
        <input id="security-code" autoComplete="one-time-code" required maxLength={32} value={code} onChange={(event) => setCode(event.target.value)} />
        {setup && <p>If a code was just used, wait for the next one before logging in again.</p>}
      </div>}
      <button className="button button-primary" type="submit" disabled={busy}>{busy ? "Working…" : status.enabled ? "Disable two-factor authentication" : setup ? "Verify and enable" : "Set up two-factor authentication"}</button>
      {setup && <button className="button button-secondary" type="button" disabled={busy} onClick={() => { setSetup(null); setCode(""); setError(""); }}>Start over</button>}
    </form>}
    {error && <p className="error is-visible" role="alert">{error}</p>}
  </section>;
}
