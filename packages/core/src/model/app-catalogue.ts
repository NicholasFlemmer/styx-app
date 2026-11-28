/**
 * The apps Connected apps offers by name (ADR-0033). Checked against each vendor's own docs and its OAuth metadata
 * (research 2026-11-19, `Styx research/remote-mcp-catalogue.md`):
 * - `connect`: an official remote MCP server Styx can sign in to as it is (dynamic client registration + PKCE).
 * - `built-in`: built into Styx (Meta Ads).
 * - `needs-setup`: the vendor wants a client registered with it first, or an admin's approval; the note says what.
 * - `coming`: the vendor hosts no connection for its account data yet.
 * Anything else is "Add your own": any MCP address the person has.
 */

export type CatalogueGroup = 'marketing' | 'sales' | 'work' | 'money' | 'dev';
export type CatalogueAccess = 'connect' | 'built-in' | 'needs-setup' | 'coming';

export interface CatalogueApp {
  id: string;
  name: string;
  group: CatalogueGroup;
  access: CatalogueAccess;
  /** The official MCP address, for `connect`. */
  url: string | null;
  /** What it is for, in a few words. */
  blurb: string;
  /** Why it is not one click yet (`needs-setup`, `coming`). */
  note: string | null;
}

const app = (
  id: string,
  name: string,
  group: CatalogueGroup,
  access: CatalogueAccess,
  url: string | null,
  blurb: string,
  note: string | null = null,
): CatalogueApp => ({ id, name, group, access, url, blurb, note });

const ADMIN = 'Your workspace admin has to approve Styx first.';
const REGISTER =
  'Needs Styx registered with the vendor; use Add your own with your own connection meanwhile.';
const NONE = 'There is no hosted connection for it yet.';

export const APP_CATALOGUE: readonly CatalogueApp[] = [
  // Marketing
  app(
    'meta-ads',
    'Meta Ads',
    'marketing',
    'built-in',
    null,
    'Facebook and Instagram ads: results, campaigns, budgets',
  ),
  app(
    'klaviyo',
    'Klaviyo',
    'marketing',
    'connect',
    'https://mcp.klaviyo.com/mcp',
    'Email and SMS: lists, campaigns, flows',
  ),
  app(
    'canva',
    'Canva',
    'marketing',
    'connect',
    'https://mcp.canva.com/mcp',
    'Designs, brand kits and exports',
  ),
  app(
    'webflow',
    'Webflow',
    'marketing',
    'connect',
    'https://mcp.webflow.com/mcp',
    'Site pages and CMS content',
  ),
  app('wix', 'Wix', 'marketing', 'connect', 'https://mcp.wix.com/mcp', 'Site, store and bookings'),
  app('googleads', 'Google Ads', 'marketing', 'coming', null, 'Search, shopping and display ads', NONE),
  app('googleanalytics', 'Google Analytics', 'marketing', 'coming', null, 'Traffic and conversions', NONE),
  app('mailchimp', 'Mailchimp', 'marketing', 'coming', null, 'Email audiences and campaigns', NONE),
  // Sales and support
  app('hubspot', 'HubSpot', 'sales', 'needs-setup', null, 'Contacts, deals and marketing', REGISTER),
  app(
    'intercom',
    'Intercom',
    'sales',
    'connect',
    'https://mcp.intercom.com/mcp',
    'Customer conversations and help articles',
  ),
  app('calendly', 'Calendly', 'sales', 'connect', 'https://mcp.calendly.com', 'Meetings and availability'),
  app(
    'zapier',
    'Zapier',
    'sales',
    'connect',
    'https://mcp.zapier.com/api/v1/connect',
    'Thousands of apps through your Zaps',
  ),
  // Work and docs
  app('notion', 'Notion', 'work', 'connect', 'https://mcp.notion.com/mcp', 'Pages, docs and databases'),
  app('linear', 'Linear', 'work', 'connect', 'https://mcp.linear.app/mcp', 'Issues, projects and cycles'),
  app(
    'atlassian',
    'Jira and Confluence',
    'work',
    'connect',
    'https://mcp.atlassian.com/v2/mcp',
    'Tickets and team pages',
  ),
  app('airtable', 'Airtable', 'work', 'connect', 'https://mcp.airtable.com/mcp', 'Bases, tables and records'),
  app('slack', 'Slack', 'work', 'needs-setup', null, 'Channels and messages', REGISTER),
  app('asana', 'Asana', 'work', 'needs-setup', null, 'Tasks and projects', REGISTER),
  app('monday', 'monday.com', 'work', 'needs-setup', null, 'Boards and items', ADMIN),
  app('box', 'Box', 'work', 'needs-setup', null, 'Files and folders', ADMIN),
  // Money and store
  app('stripe', 'Stripe', 'money', 'connect', 'https://mcp.stripe.com', 'Payments, customers and invoices'),
  app(
    'paypal',
    'PayPal',
    'money',
    'connect',
    'https://mcp.paypal.com/http',
    'Payments, invoices and disputes',
  ),
  app('shopify', 'Shopify', 'money', 'needs-setup', null, 'Store, orders and products', REGISTER),
  app(
    'square',
    'Square',
    'money',
    'needs-setup',
    null,
    'Payments and catalogue',
    'Square only lets approved apps in for now.',
  ),
  // Code and hosting
  app('sentry', 'Sentry', 'dev', 'connect', 'https://mcp.sentry.dev/mcp', 'Errors and performance'),
  app('supabase', 'Supabase', 'dev', 'connect', 'https://mcp.supabase.com/mcp', 'Database, auth and storage'),
  app(
    'cloudflare',
    'Cloudflare',
    'dev',
    'connect',
    'https://mcp.cloudflare.com/mcp',
    'Workers, DNS and storage',
  ),
  app('github', 'GitHub', 'dev', 'needs-setup', null, 'Repositories, issues and pull requests', REGISTER),
  app(
    'vercel',
    'Vercel',
    'dev',
    'needs-setup',
    null,
    'Deployments and domains',
    'Vercel only lets reviewed apps in for now.',
  ),
  app(
    'figma',
    'Figma',
    'dev',
    'needs-setup',
    null,
    'Design files',
    'Figma only lets listed apps in for now.',
  ),
];

/** The catalogue entry an added app came from, by its address's origin (the list keeps only the origin). */
export const catalogueEntryFor = (origin: string): CatalogueApp | null =>
  APP_CATALOGUE.find((a) => a.url !== null && new URL(a.url).origin === origin) ?? null;
