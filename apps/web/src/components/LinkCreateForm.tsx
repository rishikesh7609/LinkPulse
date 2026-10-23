import type { FormEventHandler } from 'react';
import type { Link } from '../api/links';

type Props = {
  isSubmitting: boolean;
  formError: string | null;
  createdLink: Link | null;
  copiedLinkId: string | null;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onCopy: (link: Pick<Link, 'id' | 'shortUrl'>) => Promise<void>;
};

export default function LinkCreateForm({
  isSubmitting,
  formError,
  createdLink,
  copiedLinkId,
  onSubmit,
  onCopy,
}: Props) {
  return (
    <section className="create-panel dashboard-create" aria-labelledby="create-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">NEW LINK</p>
          <h2 id="create-heading">Shorten a URL</h2>
        </div>
        <span className="step-number" aria-hidden="true">
          01
        </span>
      </div>
      <form className="link-form" onSubmit={onSubmit}>
        <label className="field destination-field" htmlFor="destinationUrl">
          <span>Destination URL</span>
          <input
            id="destinationUrl"
            name="destinationUrl"
            type="url"
            placeholder="https://example.com/your-long-link"
            autoComplete="url"
            maxLength={2048}
            required
          />
        </label>
        <div className="form-options">
          <label className="field" htmlFor="alias">
            <span>
              Custom alias <em>OPTIONAL</em>
            </span>
            <div className="alias-input">
              <span aria-hidden="true">/</span>
              <input
                id="alias"
                name="alias"
                type="text"
                minLength={3}
                maxLength={32}
                pattern="[A-Za-z0-9_-]{3,32}"
                placeholder="launch-day"
              />
            </div>
          </label>
          <label className="field" htmlFor="expiresAt">
            <span>
              Expires <em>OPTIONAL</em>
            </span>
            <input id="expiresAt" name="expiresAt" type="datetime-local" />
          </label>
        </div>
        {formError && (
          <p className="form-message error-message" role="alert">
            {formError}
          </p>
        )}
        <button className="primary-button" type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Creating link…' : 'Create short link'}{' '}
          {!isSubmitting && <span aria-hidden="true">↗</span>}
        </button>
      </form>
      {createdLink && (
        <div className="created-result" role="status" aria-live="polite">
          <div className="result-copy">
            <span className="result-label">YOUR SHORT LINK IS READY</span>
            <a href={createdLink.shortUrl} target="_blank" rel="noreferrer">
              {createdLink.shortUrl}
            </a>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void onCopy(createdLink)}
          >
            {copiedLinkId === createdLink.id ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
    </section>
  );
}
