/**
 * Two-step confirmation for closing this account.
 *
 * If other real accounts still share groups or expenses, the row becomes a
 * ghost so their balances stay. Otherwise the ledger is wiped and the login
 * is retired. Same type-to-confirm pattern as wiping data, with a different
 * phrase, so a stray click cannot do either.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "./api.ts";
import { useAuth } from "./App.tsx";
import { Modal } from "./Modal.tsx";

const CONFIRM_PHRASE = "DELETE ACCOUNT";

export function DeleteAccountButton() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState<"closed" | "confirm" | "type">("closed");
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close() {
    if (busy) return;
    setStep("closed");
    setTyped("");
    setError(null);
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(CONFIRM_PHRASE);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not delete this account");
      setBusy(false);
      return;
    }

    // Past this line the server has already committed. The session cookie is
    // gone; logging out is just so this browser drops its copy.
    void api.logout().catch(() => {});
    setUser(null);
    navigate("/login");
  }

  return (
    <>
      <button className="danger" type="button" style={{ width: "auto" }} onClick={() => setStep("confirm")}>
        Delete my account
      </button>

      <Modal
        open={step === "confirm" || step === "type"}
        title={step === "type" ? "Type to confirm" : "Delete this account?"}
        onClose={close}
      >
        {step === "type" ? (
          <div className="stack">
            <p style={{ margin: 0 }}>
              This cannot be undone. Type <strong>{CONFIRM_PHRASE}</strong> to
              continue.
            </p>
            <div>
              <label htmlFor="deleteAccountConfirm">Confirmation</label>
              <input
                id="deleteAccountConfirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
                autoFocus
              />
            </div>
            {error && <p className="error">{error}</p>}
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="secondary" type="button" onClick={close} disabled={busy}>
                Cancel
              </button>
              <button
                className="danger"
                type="button"
                disabled={busy || typed !== CONFIRM_PHRASE}
                onClick={() => void remove()}
              >
                {busy ? "Deleting…" : "Delete account"}
              </button>
            </div>
          </div>
        ) : (
          <div className="stack">
            <p style={{ margin: 0 }}>
              If other people with accounts still share groups or expenses with
              you, your login is removed and you become a placeholder they can
              still see. They can send you a guest link. Your history stays.
            </p>
            <p style={{ margin: 0 }}>
              If nobody else has an account on this data, everything is deleted
              — groups, expenses, guest links, and this login.
            </p>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button className="secondary" type="button" onClick={close}>
                Cancel
              </button>
              <button type="button" onClick={() => setStep("type")}>
                Continue
              </button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}
