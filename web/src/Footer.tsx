import { Link } from "react-router-dom";

export function Footer() {
  return (
    <footer className="footer">
      <span>Created out of spite by cjx3711.</span>
      <Link to="/about">About</Link>
      <Link to="/docs">API</Link>
      <a href="https://github.com/cjx3711/splitsmart" target="_blank" rel="noreferrer">
        GitHub
      </a>
    </footer>
  );
}
