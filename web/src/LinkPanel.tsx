/**
 * Mint, copy, rotate and revoke guest links.
 *
 * The awkward part of this UI is honest rather than hidden: the URL is shown
 * ONCE, when it is minted, because only its SHA-256 is stored. There is no
 * "copy again" for a link from last week; there is "make a new one", which
 * kills the old one in the same breath. That is the same deal as an API token,
 * and for the same reason: a database dump must not hand out working links.
 *
 * Used by the group screen (a general link, plus one per placeholder member)
 * and the friend screen (one link for that person). See docs/GUEST.md.
 */
import { useCallback, useEffect, useState } from "react";
import { api, type AccessLink } from "./api.ts";

/** A URL we minted in this session. Gone on reload, like the server's copy. */
type FreshUrls = Record<string, string>;

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
  const [fresh, setFresh] = useState<FreshUrls>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

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
      const minted = await api.mintLink({
        kind: slot.kind,
        groupId: slot.groupId ?? null,
        userId: slot.userId ?? null,
      });
      setFresh((f) => ({ ...f, [slot.id]: minted.url }));
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
      setFresh((f) => {
        const next = { ...f };
        delete next[slot.id];
        return next;
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not turn that link off");
    } finally {
      setBusy(null);
    }
  }

  if (links === null) return <p className="muted">Loading links…</p>;

  return (
    <div className="card stack">
      <p className="muted" style={{ margin: 0 }}>
        {intro}
      </p>
      {error && <p className="error">{error}</p>}

      {slots.map((slot) => {
        const existing = links.find((l) => matches(l, slot));
        const url = fresh[slot.id];

        return (
          <div key={slot.id} className="link-slot">
            <div className="link-slot-head">
              <strong>{slot.label}</strong>
              <span className="muted">
                {!existing
                  ? "No link"
                  : existing.expired
                    ? "Expired"
                    : existing.lastUsedAt
                      ? `Last opened ${existing.lastUsedAt.slice(0, 10)}`
                      : "Never opened"}
              </span>
            </div>

            {slot.note && <p className="field-hint">{slot.note}</p>}

            {url && (
              <>
                <code className="link-url">{url}</code>
                <p className="field-hint">
                  Copy this now. It is not stored anywhere we can read it, so
                  this is the only time it will be shown.
                </p>
              </>
            )}

            {canManage && (
              <div className="link-slot-actions">
                {url && (
                  <button
                    className="secondary inline"
                    onClick={() => {
                      void navigator.clipboard.writeText(url).then(() => setCopied(slot.id));
                    }}
                  >
                    {copied === slot.id ? "Copied" : "Copy link"}
                  </button>
                )}
                <button
                  className="secondary inline"
                  disabled={busy === slot.id}
                  onClick={() => void mint(slot)}
                >
                  {existing ? "Replace with a new link" : "Create a link"}
                </button>
                {existing && (
                  <button
                    className="link"
                    disabled={busy === slot.id}
                    onClick={() => void revoke(slot, existing.id)}
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
