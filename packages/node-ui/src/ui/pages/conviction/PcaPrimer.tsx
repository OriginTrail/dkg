import React, { useState } from 'react';
import { PcaModalShell } from './PcaModalShell.js';
import { DiscountTierLadder } from '../../components/Pca/DiscountTierLadder.js';
import { ExternalMark } from '../../components/ds/ExternalMark.js';

/** The docs page for PCAs. It covers the CLI and API only, so the primer explains the rest itself. */
export const PCA_DOCS_URL = 'https://docs.origintrail.io/operate/publishing-conviction';

/**
 * "What is a PCA?" as a dialog. Mount it conditionally (`{open && <PcaPrimerDialog … />}`);
 * `PcaModalShell` handles Escape, the close button and returning focus.
 * Not linked from inside the Create or Get added dialogs: there is no rule for a dialog on a dialog.
 */
export function PcaPrimerDialog({ onClose }: { onClose: () => void }) {
  return (
    <PcaModalShell
      onClose={onClose}
      testId="pca-primer"
      title="What is a PCA?"
      subtitle="A Publisher Conviction Account (PCA) lets you commit TRAC up front to publish at a discount."
    >
      <div className="v10-modal-body">
        <section className="v10-pca-primer-section">
          <h3 className="v10-pca-primer-title">What you commit</h3>
          <p className="v10-pca-primer-copy">
            At least 25,000 TRAC, paid when you create the PCA. A PCA runs for a fixed number of billing
            periods that the protocol sets. Each one is an epoch long and counts from when the PCA was
            created, so it doesn’t line up with the network’s epochs. Committed TRAC isn’t returned, even if
            you don’t use it all. The PCA page shows when yours ends.
          </p>
        </section>
        <section className="v10-pca-primer-section">
          <h3 className="v10-pca-primer-title">What you get</h3>
          <p className="v10-pca-primer-copy">A discount that grows with how much you commit:</p>
          <DiscountTierLadder caption="The discount is on the TRAC publishing fee only, not on gas." />
        </section>
        <section className="v10-pca-primer-section">
          <h3 className="v10-pca-primer-title">Who gets the discount</h3>
          <p className="v10-pca-primer-copy">
            Every publish is signed by one of a node’s publishing wallets. The publish gets the discount only
            if that wallet is on the PCA’s approved list, which holds up to 100 wallets. This applies to the
            PCA’s owner too: to discount your own publishes, approve your node’s publishing wallets.
          </p>
        </section>
        <section className="v10-pca-primer-section">
          <h3 className="v10-pca-primer-title">Two ways in</h3>
          <ul className="v10-pca-primer-list">
            <li><strong>Create a PCA.</strong> Commit your own TRAC, then approve the wallets that publish with it.</li>
            <li><strong>Get added to a PCA.</strong> Share this node’s publishing wallets with a PCA owner, who approves them.</li>
          </ul>
        </section>
        <section className="v10-pca-primer-section">
          <h3 className="v10-pca-primer-title">How it’s spent</h3>
          <p className="v10-pca-primer-copy">
            The committed TRAC is split into equal shares, one for each billing period. Publishes use the
            current period’s share first, then the top-up buffer: extra TRAC the owner can add while the PCA is
            active. When both run out, publishes pay the full fee until the PCA’s next billing period starts.
            Topping up doesn’t make the PCA last longer.
          </p>
        </section>
        <section className="v10-pca-primer-section">
          <h3 className="v10-pca-primer-title">When it ends</h3>
          <p className="v10-pca-primer-copy">
            After its last billing period, the PCA expires and publishes pay the full fee again. Any top-up TRAC left
            over goes to stakers, not back to you. To keep the discount, create a new PCA: it can copy over the
            approved wallets.
          </p>
        </section>
        <p className="v10-pca-primer-foot">
          Using PCAs from the command line or API? See{' '}
          <a className="v10-pca-text-link" href={PCA_DOCS_URL} target="_blank" rel="noreferrer">
            Publishing Conviction in the OriginTrail docs <ExternalMark />
          </a>
        </p>
      </div>
      <div className="v10-modal-footer">
        <button type="button" className="v10-modal-btn ds-btn" onClick={onClose}>Close</button>
      </div>
    </PcaModalShell>
  );
}

/** The "What is a PCA?" button. Owns the dialog's open state; styled like "What is a Context Graph?". */
export function PcaPrimerLink({
  size = 'sm',
  className = '',
  testId = 'pca-primer-link',
}: {
  /** `md` beside a default-size button, so side-by-side controls share a height. */
  size?: 'sm' | 'md';
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={['ds-btn', size === 'sm' ? 'ds-sm' : '', className].filter(Boolean).join(' ')}
        data-testid={testId}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        What is a PCA?
      </button>
      {open && <PcaPrimerDialog onClose={() => setOpen(false)} />}
    </>
  );
}
