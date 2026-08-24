import { useState, type InputHTMLAttributes } from "react";

/**
 * Password input with a show/hide toggle.
 *
 * The toggle is a separate control (not inside the <label>) so
 * `getByLabel("Password", { exact: true })` in tests and password managers
 * still bind to the field. The button's accessible name is "Show password" /
 * "Hide password", which is why the smoke suite matches the field exactly.
 */
export function PasswordField({
  id = "password",
  label = "Password",
  hint,
  ...props
}: {
  id?: string;
  label?: string;
  hint?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type">) {
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <div className="password-field">
        <input id={id} type={visible ? "text" : "password"} {...props} />
        <button
          type="button"
          className="password-toggle"
          aria-pressed={visible}
          aria-controls={id}
          aria-label={visible ? "Hide password" : "Show password"}
          onClick={() => setVisible((v) => !v)}
        >
          {visible ? "Hide" : "Show"}
        </button>
      </div>
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}
