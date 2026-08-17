/**
 * Where you are, and one tap back out.
 *
 * Shared by both shells. It renders relative paths through react-router's
 * `Link`, so the same trail resolves under the `/app` basename and the
 * `/guest` one without either side knowing about the other. Do not put an
 * absolute `/app/...` or `/guest/...` path in here; that is a document load
 * dressed up as a route.
 *
 * The leading `←` is the back affordance, and it goes to the PARENT rather
 * than to `history.back()`. History-back is wrong here often enough to matter:
 * arriving at a group from a notification, a shared link, or a reload has no
 * previous page inside the app, and "back" that leaves the app entirely is
 * worse than no button. The parent is always somewhere sensible.
 */
import { Link } from "react-router-dom";

export interface Crumb {
  label: string;
  /** Omit on the last crumb: you are already there. */
  to?: string;
}

export function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  // The nearest ancestor with a destination. Usually trail[length - 2], but
  // not when a middle crumb is unlinkable (a group a guest cannot open).
  const parent = [...trail].reverse().find((crumb) => crumb.to);

  if (trail.length === 0) return null;

  return (
    <nav className="crumbs" aria-label="Breadcrumb">
      {parent && (
        <Link to={parent.to!} className="crumbs-back" aria-label={`Back to ${parent.label}`}>
          ←
        </Link>
      )}
      <ol>
        {trail.map((crumb, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={`${crumb.label}-${i}`}>
              {crumb.to && !last ? (
                <Link to={crumb.to}>{crumb.label}</Link>
              ) : (
                <span aria-current={last ? "page" : undefined}>{crumb.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
