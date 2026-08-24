import { Link } from "react-router-dom";

export function AdminNav({ current }: { current: "usage" | "backups" }) {
  return (
    <nav className="admin-tabs" aria-label="Admin">
      <Link
        to="/admin"
        className={current === "usage" ? "active" : undefined}
        aria-current={current === "usage" ? "page" : undefined}
      >
        Usage
      </Link>
      <Link
        to="/admin/backups"
        className={current === "backups" ? "active" : undefined}
        aria-current={current === "backups" ? "page" : undefined}
      >
        Backups
      </Link>
    </nav>
  );
}
