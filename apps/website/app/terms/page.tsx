import type { Metadata } from 'next';
import { LegalPage } from '@/components/Legal';
import { legal } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Terms of service',
  description: 'The terms for using the Styx desktop app, a Styx account and heystyx.com.',
  alternates: { canonical: '/terms' },
};

const Summary = () => (
  <ul>
    <li>You can use Styx for personal and commercial work. Your code stays yours.</li>
    <li>Styx is free, and an account is optional.</li>
    <li>
      You&apos;re responsible for what your agents do and for the services you connect. Styx&apos;s approvals
      help you control that; they aren&apos;t a sandbox.
    </li>
    <li>Don&apos;t use Styx to break the law or attack systems you don&apos;t own.</li>
    <li>Styx is provided as it is. Our liability is limited, except where the law says it can&apos;t be.</li>
  </ul>
);

export default function TermsPage() {
  return (
    <LegalPage title="Terms of service" summary={<Summary />}>
      <h2>1. These terms</h2>
      <p>
        These terms are an agreement between you and {legal.entity}
        {legal.registration ? ` (registration ${legal.registration})` : ''} (&ldquo;we&rdquo;,
        &ldquo;us&rdquo;). They cover the Styx desktop app, a Styx account and this website. By installing
        Styx, creating an account or using the site, you agree to them. If you use Styx for an organisation,
        you confirm you can agree on its behalf. You must be at least 16.
      </p>

      <h2>2. Using Styx</h2>
      <p>
        We give you a personal, non-exclusive, non-transferable right to install and use Styx on the computers
        you use, for personal or commercial work, while you follow these terms. You may not sell, rent or
        redistribute Styx itself, remove its notices, or reverse-engineer it except where the law allows you
        to.
      </p>

      <h2>3. Your account</h2>
      <p>
        You can use all of Styx without an account. If you choose to sign in, you do so with GitHub or Google.
        Keep your account secure; you are responsible for activity under it. Tell us at{' '}
        <a href={`mailto:${legal.email}`}>{legal.email}</a> if you think someone else has used it.
      </p>

      <h2>4. Plans and price</h2>
      <p>
        Styx is currently free. If we introduce paid plans, we will tell you what they cost and what they
        include before anything changes, and you will never be charged without agreeing to it first.
      </p>

      <h2>5. Your code and your agents</h2>
      <p>
        Your code, projects and everything your agents produce belong to you. We claim no rights in them, and
        they don&apos;t leave your computer through Styx (see the <a href="/privacy">privacy policy</a>).
      </p>
      <p>
        The AI coding agents you run through Styx (such as Claude Code, Codex, Gemini CLI and Cursor) are
        third-party software, used under your own accounts and your agreements with their providers. The same
        is true of the cloud, hosting and database services you connect. You are responsible for the
        instructions you give your agents, for reviewing their work, and for what they do with the access you
        grant them.
      </p>

      <h2>6. Access controls are a safeguard, not a guarantee</h2>
      <p>
        Styx&apos;s approvals, time-limited access and audit log help you decide what your agents can reach
        and keep a record of it. They are not a sandbox. Agents run on your computer with your permissions,
        and Styx cannot stop an agent, or anything else on your computer, that deliberately goes around it.
        Use credentials with the least access you need, especially for production.
      </p>
      <p>
        To the extent the law allows, we are not responsible for changes, deployments, data loss, costs or
        other consequences caused by your agents, by third-party services, or by access you approved.
      </p>

      <h2>7. Acceptable use</h2>
      <p>Don&apos;t use Styx or our services to:</p>
      <ul>
        <li>break the law or infringe anyone&apos;s rights;</li>
        <li>access, test or attack systems you don&apos;t own or aren&apos;t authorised to use;</li>
        <li>get around someone else&apos;s security or access controls;</li>
        <li>
          overload, probe or interfere with the Styx account service, or access it other than through Styx;
        </li>
        <li>build a competing product by copying Styx.</li>
      </ul>
      <p>We may suspend or close accounts that do.</p>

      <h2>8. Third-party services</h2>
      <p>
        Styx works with services we don&apos;t control, including GitHub, Google, AI agent providers and the
        cloud providers you connect. Their terms and privacy policies apply to your use of them, and we are
        not responsible for them.
      </p>

      <h2>9. Changes and availability</h2>
      <p>
        Styx is under active development. Features may change, and we may stop offering parts of it. The
        account service may occasionally be unavailable; the app keeps working without it. We will give
        reasonable notice before removing anything significant you rely on.
      </p>

      <h2>10. Feedback</h2>
      <p>If you send us ideas or feedback, we may use them without owing you anything for it.</p>

      <h2>11. Disclaimer</h2>
      <p>
        Styx is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the extent the law allows, we
        make no promises that it will be error-free, uninterrupted or suitable for a particular purpose, and
        we disclaim implied warranties.
      </p>

      <h2>12. Limitation of liability</h2>
      <p>
        To the extent the law allows, we are not liable for indirect, incidental or consequential losses, or
        for lost profits, revenue or data. Our total liability to you for any claim is limited to the greater
        of what you paid us for Styx in the 12 months before the claim and US$100.
      </p>
      <p>
        Nothing in these terms limits rights you have that the law says cannot be limited, including your
        rights as a consumer under South Africa&apos;s Consumer Protection Act or the law where you live.
      </p>

      <h2>13. Ending</h2>
      <p>
        You can stop using Styx at any time and ask us to delete your account. We may suspend or end your
        access if you break these terms, and will tell you why unless the law or security prevents it.
        Sections 5, 6 and 10 to 14 continue after these terms end.
      </p>

      <h2>14. Law and disputes</h2>
      <p>
        These terms are governed by the law of {legal.governingLaw}. Disputes go to {legal.courts}, unless the
        law where you live gives you the right to bring them there instead. Please contact us first; most
        things can be sorted out by email.
      </p>

      <h2>15. Changes to these terms</h2>
      <p>
        We may update these terms. We will change the date at the top, and for significant changes we will
        tell you on this site and in the app before they take effect. Continuing to use Styx after that means
        you accept them.
      </p>

      <h2>16. Contact</h2>
      <p>
        {legal.entity}
        {legal.address ? `, ${legal.address}` : ''}. <a href={`mailto:${legal.email}`}>{legal.email}</a>
      </p>
    </LegalPage>
  );
}
