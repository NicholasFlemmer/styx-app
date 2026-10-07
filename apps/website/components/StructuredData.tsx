import { site } from '@/lib/site';

/**
 * Schema.org JSON-LD for the home page: who makes Styx, the site, and the app itself as a free, open-source
 * developer tool for macOS, Windows and Linux, with its download. Only facts the page itself states: no ratings, reviews or claims it does not make.
 * Social profiles go in `sameAs` once they exist.
 */
const graph = () => {
  const org = `${site.url}/#organization`;
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': org,
        name: site.name,
        url: `${site.url}/`,
        logo: { '@type': 'ImageObject', url: `${site.url}/apple-icon`, width: 180, height: 180 },
        email: site.email,
        contactPoint: { '@type': 'ContactPoint', email: site.email, contactType: 'customer support' },
      },
      {
        '@type': 'WebSite',
        '@id': `${site.url}/#website`,
        url: `${site.url}/`,
        name: site.name,
        description: site.description,
        publisher: { '@id': org },
        inLanguage: 'en',
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${site.url}/#app`,
        name: site.name,
        description: site.shareDescription,
        url: `${site.url}/`,
        image: `${site.url}/opengraph-image`,
        applicationCategory: 'DeveloperApplication',
        applicationSubCategory: 'Agentic development environment (ADE)',
        operatingSystem: 'macOS, Windows 10, Windows 11, Linux',
        processorRequirements: 'Apple silicon (Mac), x64 (Windows and Linux)',
        softwareVersion: site.version,
        downloadUrl: `${site.url}/#download`,
        installUrl: `${site.url}/#download`,
        isAccessibleForFree: true,
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
        sameAs: [site.links.github],
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
          availability: 'https://schema.org/InStock',
        },
        featureList: [
          'Run Claude Code, Codex, Gemini CLI and Cursor agents side by side',
          'Every project and agent in one window, with the ones that need you first',
          'Each agent in its own git worktree and branch',
          'Works on top of your existing editor: your recent projects come in, and anything opens back in it',
          'Agents ask before touching production; you approve for a set time, with Touch ID, Windows Hello or your system password for live systems',
          'An append-only log of every request, approval and use',
          'Free and open source under the Apache License 2.0',
        ],
        publisher: { '@id': org },
      },
    ],
  };
};

export function StructuredData() {
  return (
    <script
      type="application/ld+json"
      // JSON.stringify output is safe in a script tag once `<` is escaped (no `</script>` can form).
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph()).replace(/</g, '\\u003c') }}
    />
  );
}
