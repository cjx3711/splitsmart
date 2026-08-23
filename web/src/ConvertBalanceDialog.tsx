/**
 * Collapse several friend-level balances into one currency.
 *
 * The picker is the choice; the rest is a preview of the payments that will
 * be written. Rates come from the same client-side fetch as the ≈ estimate.
 * Nothing is stored as a rate — only the resulting payments land in the ledger.
 */
import { useEffect, useState } from "react";
import { Modal } from "./Modal.tsx";
import { Amount, useCurrencies, useFormatMoney } from "./money.tsx";
import { CurrencySelect } from "./CurrencySelect.tsx";
import { useExchangeRates } from "./exchangeRates.ts";
import { planBalanceConversion, type ConversionPayment } from "./convertBalance.ts";
import type { CurrencyAmount } from "./api.ts";

export function ConvertBalanceDialog({
  open,
  themName,
  youId,
  themId,
  balances,
  preferredCurrency,
  onClose,
  onSubmit,
}: {
  open: boolean;
  themName: string;
  youId: string;
  themId: string;
  balances: CurrencyAmount[];
  preferredCurrency: string;
  onClose: () => void;
  onSubmit: (payments: ConversionPayment[]) => Promise<void>;
}) {
  const formatMoney = useFormatMoney();
  const { decimalsFor } = useCurrencies();
  const [target, setTarget] = useState(preferredCurrency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setTarget(preferredCurrency);
      setBusy(false);
      setError(null);
    }
  }, [open, preferredCurrency]);

  const symbols = balances.map((b) => b.currencyCode);
  const { rates, date, loading, error: ratesError } = useExchangeRates(
    open ? target : "",
    open ? symbols : [],
  );

  const plan =
    rates && date
      ? planBalanceConversion({
          balances,
          targetCode: target,
          rates,
          decimalsFor,
          youId,
          themId,
          rateDate: date,
          formatAmount: formatMoney,
        })
      : null;

  const canSubmit = Boolean(plan?.ok && plan.payments.length > 0 && !busy);

  async function handleSubmit() {
    if (!plan?.ok || plan.payments.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      await onSubmit(plan.payments);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not convert the balance");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Convert balance" onClose={onClose}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Other currencies are settled and reopened in the one you pick, at
          today's rate. Group bills are left in their original currencies.
        </p>

        <div>
          <label htmlFor="convertTarget">Convert to</label>
          <CurrencySelect id="convertTarget" value={target} onChange={setTarget} />
        </div>

        {error && <p className="error">{error}</p>}

        {loading && <p className="muted">Fetching today's rates…</p>}

        {ratesError && (
          <p className="error">
            Could not load a rate for {target}. Try another currency.
          </p>
        )}

        {plan && !plan.ok && (
          <p className="error">
            {plan.reason === "rounds_to_zero"
              ? `${plan.currencyCode} is too small to convert into ${target} without rounding to zero.`
              : `No rate for ${plan.currencyCode} → ${target}.`}
          </p>
        )}

        {plan?.ok && plan.legs.length === 0 && (
          <p className="muted">Everything between you is already in {target}.</p>
        )}

        {plan?.ok && plan.legs.length > 0 && (
          <>
            <div className="convert-preview">
              {plan.legs.map((leg) => (
                <div key={leg.sourceCode} className="convert-preview-row">
                  <Amount minor={leg.sourceMinor} currency={leg.sourceCode} />
                  <span className="convert-preview-arrow" aria-hidden="true">
                    →
                  </span>
                  <Amount minor={leg.targetMinor} currency={leg.targetCode} />
                </div>
              ))}
            </div>
            <p style={{ margin: 0 }}>
              Afterwards:{" "}
              {plan.resultMinor === 0 ? (
                "you'll be settled up."
              ) : (
                <>
                  {plan.resultMinor > 0 ? `${themName} will owe you ` : `you will owe ${themName} `}
                  <Amount minor={plan.resultMinor} currency={target} absolute />
                </>
              )}
            </p>
            {date && (
              <p className="muted" style={{ margin: 0 }}>
                Rates as of {date}.{" "}
                <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">
                  Rates By Exchange Rate API
                </a>
                .
              </p>
            )}
          </>
        )}

        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button className="secondary" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {busy ? "Converting…" : `Convert to ${target}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
