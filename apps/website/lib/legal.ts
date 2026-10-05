/**
 * The facts the legal pages rest on. Everything here must be true before the pages are published: the
 * policies quote these values, and a wrong address or entity makes the whole document unreliable.
 */
export const legal = {
  /**
   * Who runs Styx and is responsible for the data: the owner as a sole proprietor until a company exists, when
   * its name, registration and address replace this.
   */
  entity: 'Nic Flemmer, trading as Styx',
  /** Company registration number, if a company; empty string for a sole proprietor. */
  registration: '',
  address: '',
  email: 'hello@heystyx.com',
  /** Whose law governs the terms, and whose courts hear disputes. */
  governingLaw: 'the Republic of South Africa',
  courts: 'the courts of South Africa',
  effective: '5 October 2026',
} as const;

export const legalReady = !Object.values(legal).some((v) => v.includes('['));
