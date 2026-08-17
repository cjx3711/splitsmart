/**
 * Mint, copy, rotate and revoke guest links.
 *
 * Used by the group screen (a general link, plus one per placeholder member)
 * and the friend screen (one link for that person). See docs/GUEST.md.
 */
import { useCallback, useEffect, useState } from "react";
import { api, type AccessLink } from "./api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";

export function CopyLinkButton({ url, label = "Copy link" }: { url: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="secondary inline"
      onClick={() => {
        void navigator.clipboard.writeText(url).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      {copied ? "Copied" : label}
    </button>
  );
}

type PendingAction =
  | { kind: "replace"; slot: LinkSlot }
  | { kind: "revoke"; slot: LinkSlot; linkId: string };

export function LinkPanel({
  query,
  slots,
  canManage,
  intro,
}: {
  /** Which links to list: one group's, or one friend's. */
  query: { groupId: string } | { friendId: string };
  /** The links this screen offers, whether or not they exist yet. */
  slots: LinkSlot[];
  /** Only a group owner may mint or revoke. Members just see what exists. */
  canManage: boolean;
  intro: string;
}) {
  const [links, setLinks] = useState<AccessLink[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const key = "groupId" in query ? query.groupId : query.friendId;

  const load = useCallback(async () => {
    try {
      const result = await api.listLinks(query);
      setLinks(result.links);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load links");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the query object is rebuilt each render; its identity is `key`
  }, [key]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mint(slot: LinkSlot) {
    setBusy(slot.id);
    setError(null);
    try {
      await api.mintLink({
        kind: slot.kind,
        groupId: slot.groupId ?? null,
        userId: slot.userId ?? null,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create that link");
    } finally {
      setBusy(null);
    }
  }

  async function revoke(slot: LinkSlot, linkId: string) {
    setBusy(slot.id);
    setError(null);
    try {
      await api.revokeLink(linkId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not turn that link off");
    } finally {
      setBusy(null);
    }
  }

  async function confirmPending() {
    if (!pending) return;
    const action = pending;
    if (action.kind === "replace") await mint(action.slot);
    else await revoke(action.slot, action.linkId);
    setPending(null);
  }

  if (links === null) return <p className="muted">Loading links…</p>;

  const pendingSlot = pending?.slot ?? null;

  return (
    <>
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          {intro}
        </p>
        {error && <p className="error">{error}</p>}

        {slots.map((slot) => {
          const existing = links.find((l) => matches(l, slot));
          const url = existing?.url ?? null;

          return (
            <div key={slot.id} className="link-slot">
              <div className="link-slot-head">
                <strong>{slot.label}</strong>
                <span className="muted">
                  {!existing
                    ? "No link"
                    : existing.expired
                      ? `Expired ${existing.expiresAt?.slice(0, 10) ?? ""}`.trim()
                      : [
                          existing.expiresAt ? `Expires ${existing.expiresAt.slice(0, 10)}` : null,
                          existing.lastUsedAt
                            ? `Last opened ${existing.lastUsedAt.slice(0, 10)}`
                            : "Never opened",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                </span>
              </div>

              {slot.note && <p className="field-hint">{slot.note}</p>}

              {url && (
                <div className="link-url-row">
                  <code className="link-url">{url}</code>
                  <CopyLinkButton url={url} />
                </div>
              )}

              {existing && !url && (
                <p className="field-hint">
                  Replace this link to get a copyable URL. Older links cannot be
                  read back.
                </p>
              )}

              {canManage && (
                <div className="link-slot-actions">
                  <button
                    className="secondary inline"
                    disabled={busy === slot.id}
                    onClick={() => {
                      if (existing) setPending({ kind: "replace", slot });
                      else void mint(slot);
                    }}
                  >
                    {existing ? "Replace with a new link" : "Create a link"}
                  </button>
                  {existing && (
                    <button
                      className="link"
                      disabled={busy === slot.id}
                      onClick={() => setPending({ kind: "revoke", slot, linkId: existing.id })}
                    >
                      Turn off
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={pending?.kind === "replace"}
        title={pendingSlot ? `Replace ${pendingSlot.label.toLowerCase()}?` : "Replace link?"}
        confirmLabel="Replace link"
        busyLabel="Replacing…"
        busy={pendingSlot !== null && busy === pendingSlot.id}
        onClose={() => setPending(null)}
        onConfirm={confirmPending}
      >
        <p style={{ margin: 0 }}>
          The current link stops working immediately. Anyone still using the old
          URL will need the new one you copy after this.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={pending?.kind === "revoke"}
        title={pendingSlot ? `Turn off ${pendingSlot.label.toLowerCase()}?` : "Turn off link?"}
        confirmLabel="Turn off link"
        busyLabel="Turning off…"
        busy={pendingSlot !== null && busy === pendingSlot.id}
        onClose={() => setPending(null)}
        onConfirm={confirmPending}
      >
        <p style={{ margin: 0 }}>
          The link stops working on the next request. Anyone holding it will lose
          access until you create a new one.
        </p>
      </ConfirmDialog>
    </>
  );
}

export interface LinkSlot {
  /** Stable per row, so a freshly minted URL stays attached to the right one. */
  id: string;
  kind: "group" | "group_member" | "friend";
  groupId?: string | null;
  userId?: string | null;
  label: string;
  note?: string;
}

function matches(link: AccessLink, slot: LinkSlot): boolean {
  if (link.kind !== slot.kind) return false;
  if (slot.kind === "friend") return link.userId === slot.userId;
  if (link.groupId !== slot.groupId) return false;
  return slot.kind === "group" ? link.userId === null : link.userId === slot.userId;
}
