/**
 * Plain anchors, not <Link>s, on purpose.
 *
 * This footer is rendered inside all three shells (/, /app, /guest), each with
 * its own router basename. A <Link to="/about"> would resolve to /app/about
 * inside the app shell, which is a 404. Crossing shells is a document load.
 */
export function Footer() {
  return (
    <footer className="footer">
      <span>Created out of spite by cjx3711.</span>
      <a href="/about">About</a>
      <a href="/changelog">Changelog</a>
      <a href="/docs">API</a>
      <a href="https://github.com/cjx3711/splitsmart" target="_blank" rel="noreferrer">
        GitHub
      </a>
    </footer>
  );
}
