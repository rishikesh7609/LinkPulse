import { useState, type FormEvent } from 'react';
import { LinkApiError } from '../api/links';
import { login, register, type AuthUser } from '../api/auth';

type Props = { onAuthenticated: (user: AuthUser) => void; serviceError: string | null };

export default function AuthScreen({ onAuthenticated, serviceError }: Props) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      const user =
        mode === 'login' ? await login(email, password) : await register(email, password);
      onAuthenticated(user);
    } catch (cause) {
      setError(cause instanceof LinkApiError ? cause.message : 'Could not sign in. Try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="app-shell auth-shell">
      <header className="topbar auth-topbar">
        <a className="brand" href="#auth" aria-label="LinkPulse sign in">
          <span className="brand-mark" aria-hidden="true">
            lp
          </span>
          <span>LinkPulse</span>
        </a>
        <span className="topbar-note">PRIVATE WORKSPACE</span>
      </header>
      <main id="auth" className="auth-content">
        <section className="auth-panel" aria-labelledby="auth-title">
          <p className="eyebrow">LINKPULSE / ACCOUNT</p>
          <h1 id="auth-title">{mode === 'login' ? 'Welcome back.' : 'Create your account.'}</h1>
          <p className="intro-copy">
            {mode === 'login'
              ? 'Sign in to manage your links and view their click activity.'
              : 'Your links and analytics will be private to your account.'}
          </p>
          {serviceError && (
            <p className="notice error-notice" role="alert">
              {serviceError}
            </p>
          )}
          {error && (
            <p className="notice error-notice" role="alert">
              {error}
            </p>
          )}
          <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
            <label className="auth-field">
              Email address
              <input
                autoComplete="email"
                type="email"
                name="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="auth-field">
              Password
              <input
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                type="password"
                name="password"
                required
                minLength={12}
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {mode === 'register' && <span>Use at least 12 characters.</span>}
            </label>
            <button className="primary-button auth-submit" type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            </button>
          </form>
          <p className="auth-mode-switch">
            {mode === 'login' ? 'New to LinkPulse?' : 'Already have an account?'}{' '}
            <button
              className="text-button"
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login');
                setError(null);
              }}
            >
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </section>
        <footer className="page-footer auth-footer">
          <span>LinkPulse — A smarter way to manage links.</span>
          <span>Designed &amp; built by Rishikesh Sinha.</span>
          <span>© 2026 LinkPulse.</span>
        </footer>
      </main>
    </div>
  );
}
