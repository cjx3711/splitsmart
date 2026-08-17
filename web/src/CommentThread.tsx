/**
 * The comment thread on an expense. One component, both shells.
 *
 * The logged-in page and the guest page pass their own three functions, because
 * the only difference between them is which API answers; the conversation itself,
 * and the rule that a system comment is quieter than a real one, must not be
 * reimplemented twice and allowed to drift.
 *
 * Two kinds of row, as they come off the wire:
 *
 *   user    somebody typed it. Their own are deletable, nobody else's are.
 *   system  generated when the bill was edited, deleted or restored. Muted, no
 *           avatar emphasis, no delete. This is what answers "why is this 8.99".
 *
 * No markdown, and no rich text: a comment on a restaurant bill is a sentence.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Comment } from "./api.ts";
import { Avatar } from "./Avatar.tsx";

export interface CommentThreadApi {
  list: (expenseId: string) => Promise<{ comments: Comment[] }>;
  add: (expenseId: string, content: string) => Promise<unknown>;
  remove: (commentId: string) => Promise<unknown>;
}

export function CommentThread({
  expenseId,
  currentUserId,
  api,
}: {
  expenseId: string;
  /** Whose comments get a delete button, and who reads as "You". */
  currentUserId: string;
  api: CommentThreadApi;
}) {
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await api.list(expenseId);
      setComments(result.comments);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the comments");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the api object is a literal at the call site
  }, [expenseId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (content === "") return;

    setBusy(true);
    setError(null);
    try {
      await api.add(expenseId, content);
      // Cleared only after the server took it, so a failed post does not lose
      // what somebody typed.
      setDraft("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not post that comment");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(commentId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.remove(commentId);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that comment");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Comments</h2>

      {error && <p className="error">{error}</p>}

      {comments === null ? (
        <p className="muted">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="empty">Nothing said about this one yet.</p>
      ) : (
        <div className="comments">
          {comments.map((comment) => {
            const mine = comment.author.id === currentUserId;
            const name = mine
              ? "You"
              : [comment.author.firstName, comment.author.lastName].filter(Boolean).join(" ");

            if (comment.kind === "system") {
              return (
                <div key={comment.id} className="comment comment-system">
                  {/* Pre-wrapped: the server writes one change per line, and
                      reflowing them into a paragraph loses the diff. */}
                  <div className="comment-body">{comment.content}</div>
                  <time className="comment-time">{formatWhen(comment.createdAt)}</time>
                </div>
              );
            }

            return (
              <div key={comment.id} className="comment">
                <Avatar id={comment.author.id} name={name} size={30} />
                <div className="comment-main">
                  <div className="comment-meta">
                    <strong>{name}</strong>
                    <time className="comment-time">{formatWhen(comment.createdAt)}</time>
                  </div>
                  <div className="comment-body">{comment.content}</div>
                </div>
                {mine && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => void handleDelete(comment.id)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <form className="comment-composer" onSubmit={handleSubmit}>
        <label className="sr-only" htmlFor="comment-content">
          Add a comment
        </label>
        <input
          id="comment-content"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a comment"
          maxLength={5000}
        />
        <button type="submit" disabled={busy || draft.trim() === ""}>
          {busy ? "Posting…" : "Post"}
        </button>
      </form>
    </>
  );
}

/**
 * Comment timestamps come back in SQLite's `YYYY-MM-DD HH:MM:SS` (UTC) or as an
 * ISO string from an import. Both are made explicit before parsing, because a
 * bare space-separated string is treated as LOCAL time by some browsers and UTC
 * by others, which shifts every imported comment by the timezone offset.
 */
function formatWhen(value: string): string {
  const iso = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
