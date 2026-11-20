import { useState, type FormEvent } from "react";
import Link from "next/link";

/**
 * Login page — UI ONLY (Days 7–12 scaffold).
 * No credentials are sent anywhere: the auth provider is not selected yet
 * (ADR-011) and there is no backend sign-in to call. Submitting shows the
 * placeholder notice below.
 */
export default function Login() {
  const [notice, setNotice] = useState<string | null>(null);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(
      "Sign-in is not wired yet in this scaffold. A managed auth provider with MFA " +
        "will be selected (ADR-011) before any real user can sign in. No credentials were sent.",
    );
  };

  return (
    <main>
      <h1>Sign in to QualiOS</h1>
      <form onSubmit={onSubmit}>
        <label>
          Work email
          <input autoComplete="email" name="email" required type="email" />
        </label>
        <label>
          Password
          <input autoComplete="current-password" name="password" required type="password" />
        </label>
        <button type="submit">Sign in</button>
      </form>
      {notice ? <p className="notice">{notice}</p> : null}
      <p>
        <Link href="/">Back to home</Link>
      </p>
    </main>
  );
}
