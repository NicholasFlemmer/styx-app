/**
 * The facts the legal pages rest on. Everything here must be true before the pages are published: the
 * policies quote these values, and a wrong address or entity makes the whole document unreliable.
 */
export const legal = {
  /** Who runs Styx and is responsible for the data. Company details are added here when they exist. */
  entity: 'Styx',
  /** Company registration number, if a company; empty string for a sole proprietor. */
  registration: '',
  address: '',
  email: 'hello@heystyx.com',
  /** Whose law governs the terms, and whose courts hear disputes. */
  governingLaw: 'the Republic of South Africa',
  courts: 'the courts of South Africa',
  effective: '28 September 2026',
} as const;

export const legalReady = !Object.values(legal).some((v) => v.includes('['));
