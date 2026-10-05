import type { Metadata } from 'next';
import { LegalPage } from '@/components/Legal';
import { CookieSettingsLink } from '@/components/CookieSettingsLink';
import { legal } from '@/lib/legal';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description: 'What Styx collects, what it never sees, and how to control it.',
  alternates: { canonical: '/privacy' },
};

const Summary = () => (
  <ul>
    <li>
      Styx runs on your computer. Your code, projects, file paths, prompts, agent conversations and
      credentials never reach us.
    </li>
    <li>
      Your keys stay in your Mac&apos;s Keychain. Your agents talk to their own providers directly, under your
      accounts.
    </li>
    <li>
      If you sign in, we keep a small account: your email, name, picture, plan, and when you signed up and
      last used Styx.
    </li>
    <li>
      Styx counts a few things you do (like launches, agents started and deploys run) under a random id for
      your copy of the app, unless you turn it off. Signed in, the counts are tied to your account too.
    </li>
    <li>
      Our website counts downloads without cookies or anything about you, and uses Google Analytics only if
      you accept cookies.
    </li>
    <li>We don&apos;t sell your data, and we don&apos;t use it for advertising.</li>
  </ul>
);

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy policy" summary={<Summary />}>
      <h2>1. Who we are</h2>
      <p>
        This policy explains how Styx (&ldquo;we&rdquo;, &ldquo;us&rdquo;) handles personal information. We
        are responsible for the information described here.
        {` Styx is provided by ${legal.entity}${legal.registration ? ` (registration ${legal.registration})` : ''}${legal.address ? `, ${legal.address}` : ''}.`}{' '}
        Questions, requests and complaints go to <a href={`mailto:${legal.email}`}>{legal.email}</a>.
      </p>
      <p>
        This policy covers the Styx desktop app, the Styx account service it signs in to, and this website
        (heystyx.com).
      </p>

      <h2>2. What stays on your computer</h2>
      <p>
        Styx is a desktop app. The following is stored only on your computer, and we have no access to it:
      </p>
      <ul>
        <li>your projects, their files, branches and worktrees, and the changes your agents make;</li>
        <li>your agent sessions and conversations;</li>
        <li>
          the credentials you connect for deploy and server targets (Vercel, AWS, Google Cloud, Supabase,
          GitHub, SSH). These are kept in your operating system&apos;s keychain;
        </li>
        <li>the approvals and audit log that record what your agents asked for and what you allowed;</li>
        <li>your settings and preferences.</li>
      </ul>
      <p>
        When you use an AI coding agent through Styx (Claude Code, Codex, Gemini CLI, Cursor), the agent runs
        on your computer under your own account with that provider, and talks to that provider directly. What
        those providers do with your data is governed by your agreement with them, not by this policy. The
        same applies to the cloud and hosting services your agents deploy to.
      </p>

      <h2>3. Your Styx account</h2>
      <p>
        Signing in is optional: all of Styx works without an account. If you sign in with GitHub or Google, we
        receive and keep:
      </p>
      <ul>
        <li>your email address, name and profile picture link, as provided by GitHub or Google;</li>
        <li>which of the two you signed in with, and your ID with that provider;</li>
        <li>your plan and when it ends;</li>
        <li>when your account was created and when you last used Styx.</li>
      </ul>
      <p>
        We never see your GitHub or Google password. We use this information to sign you in, to apply your
        plan on every computer you use, and to contact you about your account. Keeping it is necessary to
        provide the account you asked for.
      </p>
      <p>
        When git on your computer has no name and email set, Styx uses your account name and email to sign the
        commits it makes. This happens on your computer.
      </p>
      <p>
        Sign-in codes expire within minutes. The tokens that keep you signed in expire on their own, and
        signing out revokes all of them.
      </p>

      <h2>4. Usage counts</h2>
      <p>Styx sends a daily count of these events, and nothing else:</p>
      <ul>
        <li>the app was opened;</li>
        <li>setup was finished;</li>
        <li>a project was added;</li>
        <li>an agent was started;</li>
        <li>a message was sent to an agent;</li>
        <li>an access request was approved;</li>
        <li>a deploy was run;</li>
        <li>an agent&apos;s work was landed on the main branch;</li>
        <li>the walkthrough was shown, finished or skipped;</li>
        <li>
          an agent could not start, with one of six fixed reasons: its program is not installed, it would not
          launch, it is not signed in, it is out of date, it reported an error, or it closed straight away;
        </li>
        <li>
          Styx crashed: a window, one of its helper processes, or the app itself (noticed the next time you
          open it).
        </li>
      </ul>
      <p>
        With the counts, Styx sends its version number, your operating system (macOS or Windows), and an
        install id: a random code your copy of Styx makes the first time it runs. The install id is not made
        from your computer, your name or anything else about you, and on its own we cannot tell who it belongs
        to. While you are signed in, the counts are also tied to your account.
      </p>
      <p>
        This lets us see how many people use Styx and which parts they reach. The counts never include a
        project, file, path, branch, command, prompt, the text of a message or anything your agents produce:
        the app is built so that it cannot attach them. Our server does not store your IP address with them.
        You can turn counts off at any time in Styx under{' '}
        <strong>Settings › Account › Send usage counts</strong>. We keep them for six months and then delete
        them, and an install we have not heard from in six months is forgotten. We rely on our legitimate
        interest in understanding how Styx is used; you can object by turning them off.
      </p>

      <h3>Feedback</h3>
      <p>
        If you send feedback from the app, we receive your message, your email address if you type one (or
        your account&apos;s, if you are signed in), Styx&apos;s version, your operating system and your
        install id. We use it to read and answer what you wrote and to improve Styx, and keep it for a year.
        Nothing from your projects is attached.
      </p>
      <p>
        If you tick <strong>Include diagnostics</strong> when you send feedback (it is off unless you do), we
        also receive the last part of Styx&apos;s own log file, so we can see what went wrong. Passwords, keys
        and tokens are masked before it leaves your computer. The log can include the names and folders of
        your projects and the names of the agents you use, but never the contents of your files or anything
        your agents wrote. It is kept with your feedback, for a year.
      </p>

      <h2>5. This website</h2>
      <h3>Hosting</h3>
      <p>
        heystyx.com is hosted on Google Cloud. Like any web server, it records each request (IP address,
        browser, page and time) to keep the service running and secure. These logs are kept for 30 days.
      </p>
      <h3>Download counts</h3>
      <p>
        The Download button goes through our server, which adds one to a daily count and sends you on to the
        file. The count records only where the click came from: a short tag in the link (such as{' '}
        <code>?from=hn</code>) or the name of the website you came from. No cookie is set, and your IP address
        and browser are not stored with it.
      </p>
      <h3>Analytics and cookies</h3>
      <p>
        We use Google Analytics, loaded through Google Tag Manager, to understand which pages and links bring
        people to Styx. It records the pages you view, the parts of the page you reach, clicks on download and
        outside links, where you came from (including campaign tags in links), your approximate location
        (country and city, derived from your IP address, which Google Analytics does not store), and your
        device and browser type.
      </p>
      <ul>
        <li>
          <strong>Before you choose,</strong> and if you decline, no analytics cookies are set. Google
          receives cookieless signals without identifiers, which it uses only to estimate totals.
        </li>
        <li>
          <strong>If you accept,</strong> Google Analytics sets the cookies <code>_ga</code> and{' '}
          <code>_ga_VT0TQG7CF8</code>, which last up to two years. Google Analytics keeps event-level data for
          two months.
        </li>
      </ul>
      <p>
        You can change your choice at any time: <CookieSettingsLink />. The site also stores two settings in
        your browser (not cookies): your light or dark theme, and your cookie choice.
      </p>

      <h2>6. Who else handles your information</h2>
      <table>
        <thead>
          <tr>
            <th>Service</th>
            <th>What for</th>
            <th>Where</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Google Cloud (Google LLC)</td>
            <td>Runs the account service and its database, and hosts this website</td>
            <td>United States</td>
          </tr>
          <tr>
            <td>Google Analytics (Google LLC)</td>
            <td>Website analytics, as described above</td>
            <td>United States</td>
          </tr>
          <tr>
            <td>GitHub and Google</td>
            <td>Sign-in, if you choose it. Their own privacy policies cover what happens on their side</td>
            <td>United States</td>
          </tr>
          <tr>
            <td>Product Hunt</td>
            <td>
              Our Product Hunt badge and card on this site load their images from Product Hunt, which sees
              your IP address when they do
            </td>
            <td>United States</td>
          </tr>
          <tr>
            <td>GitHub</td>
            <td>
              The skills catalogue in the app is fetched from GitHub, which sees your IP address when it is
              loaded
            </td>
            <td>United States</td>
          </tr>
        </tbody>
      </table>
      <p>We don&apos;t sell personal information, and we don&apos;t share it for advertising.</p>

      <h2>7. International transfers</h2>
      <p>
        Our account service and database run in the United States. Where your information moves across
        borders, it is protected by our providers&apos; data processing terms, including standard contractual
        clauses where the law requires them.
      </p>

      <h2>8. How long we keep it</h2>
      <table>
        <thead>
          <tr>
            <th>Information</th>
            <th>Kept for</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Your account</td>
            <td>Until you ask us to delete it</td>
          </tr>
          <tr>
            <td>Usage counts and download counts</td>
            <td>Six months</td>
          </tr>
          <tr>
            <td>Feedback you send</td>
            <td>One year</td>
          </tr>
          <tr>
            <td>Install id, version and operating system</td>
            <td>Six months after we last hear from that install</td>
          </tr>
          <tr>
            <td>Sign-in codes and tokens</td>
            <td>Until they expire or you sign out</td>
          </tr>
          <tr>
            <td>Website server logs</td>
            <td>30 days</td>
          </tr>
          <tr>
            <td>Google Analytics event data</td>
            <td>Two months</td>
          </tr>
        </tbody>
      </table>

      <h2>9. Your rights</h2>
      <p>
        You can ask us to show you the personal information we hold about you, correct it, delete it, give you
        a copy, or stop using it. You can withdraw consent to cookies at any time. Turning off usage counts
        stops them at once. To delete your account and its usage counts, email{' '}
        <a href={`mailto:${legal.email}`}>{legal.email}</a> from the address on your account; we will do it
        within 30 days and confirm when it&apos;s done.
      </p>
      <p>
        If you are unhappy with how we handle your information, please tell us first. You can also complain to
        your data protection authority: in South Africa, the Information Regulator; in the UK, the Information
        Commissioner&apos;s Office; in the European Union, the authority where you live.
      </p>

      <h2>10. Children</h2>
      <p>Styx is a tool for software developers and isn&apos;t meant for anyone under 16.</p>

      <h2>11. Security</h2>
      <p>
        Everything between the app, the website and our servers is encrypted in transit. Our service secrets
        are held in Google Secret Manager, and access to account data is limited to named administrators. No
        system is perfectly secure; if we learn of a breach that affects you, we will tell you and the
        relevant authorities as the law requires.
      </p>

      <h2>12. Changes</h2>
      <p>
        When we change this policy we update the date at the top. If a change matters, for example we start
        collecting something new, we will say so on this site and in the app before it takes effect.
      </p>

      <h2>13. Contact</h2>
      <p>
        {legal.entity}
        {legal.address ? `, ${legal.address}` : ''}. <a href={`mailto:${legal.email}`}>{legal.email}</a>
      </p>
    </LegalPage>
  );
}
