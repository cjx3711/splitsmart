/**
 * Mint, copy, rotate and revoke guest links.
 *
 * Used by the group screen (a general link, plus one per placeholder member)
 * and the friend screen (one link for that person). See docs/GUEST.md.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type AccessLink } from "./api.ts";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { NeedsConnection, useOnline } from "./OnlineOnly.tsx";
import { HelpTip } from "./HelpTip.tsx";
import { Skeleton } from "./Skeleton.tsx";
import { CopyIcon, MoreIcon } from "./Icons.tsx";

/** Copies `url` to the clipboard. Pass `iconOnly` for a glyph-only button. */
export function CopyLinkButton({
  url,
  label = "Copy link",
  iconOnly = false,
}: {
  url: string;
  label?: string;
  iconOnly?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }

  if (iconOnly) {
    return (
      <button
        type="button"
        className="secondary inline icon-button"
        aria-label={copied ? "Copied" : label}
        title={copied ? "Copied" : label}
        onClick={copy}
      >
        <CopyIcon />
      </button>
    );
  }

  return (
    <button type="button" className="secondary inline" onClick={copy}>
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
  extra,
  revision = 0,
}: {
  /** Which links to list: one group's, or one friend's. */
  query: { groupId: string } | { friendId: string };
  /** The links this screen offers, whether or not they exist yet. */
  slots: LinkSlot[];
  /** Only a group owner may mint or revoke. Members just see what exists. */
  canManage: boolean;
  intro: string;
  /** Rendered inside the card after the slots (friend-page invite, etc.). */
  extra?: ReactNode;
  /** Bump to reload (e.g. after saving an email minted a friend link). */
  revision?: number;
}) {
  const [links, setLinks] = useState<AccessLink[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const online = useOnline();
  const manage = canManage && online;

  const key = "groupId" in query ? query.groupId : query.friendId;

  const load = useCallback(async () => {
    try {
      const result = await api.listLinks(query);
      setLinks(result.links);
      setError(null);
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 401
          ? "Signed out on the server. Refresh the page or sign in again."
          : err instanceof Error
            ? err.message
            : "Could not load links";
      setError(message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the query object is rebuilt each render; its identity is `key`
  }, [key, revision]);

  useEffect(() => {
    setLinks(null);
    setError(null);
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
      // A freshly minted secret is the only time the URL is readable at all
      // (see the "Replace to get a copyable URL" note below), so copying it
      // immediately saves a second click that would otherwise be mandatory.
      void navigator.clipboard.writeText(minted.url).catch(() => {});
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

  if (links === null) {
    return (
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          {intro}
        </p>
        {error ? (
          <>
            <p className="error">{error}</p>
            <button type="button" className="secondary inline" onClick={() => void load()}>
              Try again
            </button>
          </>
        ) : (
          <Skeleton kind="links" rows={Math.max(slots.length, 1)} label="Loading links" />
        )}
      </div>
    );
  }

  const pendingSlot = pending?.slot ?? null;

  return (
    <>
      <div className="card stack">
        <p className="muted" style={{ margin: 0 }}>
          {intro}
        </p>
        {canManage && !online && <NeedsConnection what="Managing guest links" />}
        {error && <p className="error">{error}</p>}

        {slots.map((slot) => {
          const existing = links.find((l) => matches(l, slot));
          const url = existing?.url ?? null;

          return (
            <div key={slot.id} className="link-slot">
              <div className="link-slot-head">
                <strong className="with-help">
                  {slot.label}
                  {slot.note && (
                    <HelpTip label={`About ${slot.label}`}>{slot.note}</HelpTip>
                  )}
                </strong>
                <span className="muted with-help">
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
                  {existing && !url && (
                    <HelpTip label="About this link">
                      Replace this link to get a copyable URL. Older links cannot be read back.
                    </HelpTip>
                  )}
                </span>
              </div>

              {(url || manage) && (
                <div className="link-url-row">
                  {url && <code className="link-url">{url}</code>}
                  {url && <CopyLinkButton url={url} iconOnly />}
                  {manage && (
                    <LinkSlotMenu
                      busy={busy === slot.id}
                      hasExisting={Boolean(existing)}
                      onCreate={() => void mint(slot)}
                      onReplace={() => setPending({ kind: "replace", slot })}
                      onRevoke={() =>
                        existing && setPending({ kind: "revoke", slot, linkId: existing.id })
                      }
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
        {extra}
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

/** The kebab menu on a link row: create/replace and turn-off, tucked away. */
function LinkSlotMenu({
  busy,
  hasExisting,
  onCreate,
  onReplace,
  onRevoke,
}: {
  busy: boolean;
  hasExisting: boolean;
  onCreate: () => void;
  onReplace: () => void;
  onRevoke: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div className="link-slot-menu" ref={ref}>
      <button
        type="button"
        className="secondary inline icon-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Link options"
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon />
      </button>

      {open && (
        <div className="link-slot-menu-list" role="menu">
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              if (hasExisting) onReplace();
              else onCreate();
            }}
          >
            {hasExisting ? "Replace with a new link" : "Create a link"}
          </button>
          {hasExisting && (
            <button
              type="button"
              role="menuitem"
              className="danger"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                onRevoke();
              }}
            >
              Turn off
            </button>
          )}
        </div>
      )}
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
