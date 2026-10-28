import { describe, expect, it } from 'vitest';
import { gitCredentialRequest, githubRepository } from './git-credential';

describe('GitHub credential repository', () => {
  it('normalizes repository names and the Git suffix', () => {
    expect(githubRepository('Acme/Shop.git')).toBe('acme/shop.git');
    expect(githubRepository('acme/shop')).toBe('acme/shop');
    expect(gitCredentialRequest(['get', 'fetch', 'https://github.com/acme/shop.git'])).toEqual({
      repository: 'acme/shop',
      operation: 'fetch',
    });
    expect(gitCredentialRequest(['get', 'push', 'https://github.com/acme/shop.git.git'])).toEqual({
      repository: 'acme/shop.git',
      operation: 'push',
    });
  });
  it.each([
    'acme',
    'acme/../shop',
    'acme/.',
    'acme/..',
    'acme/shop/extra',
    'acme/shop?x=1',
    'acme/shop%2Fextra',
    'acme/shop\n',
  ])('refuses malformed repository %s', (path) => {
    expect(githubRepository(path)).toBeNull();
  });
  it.each([
    ['get', 'push', 'https://github.com.evil/acme/shop'],
    ['get', 'push', 'https://github.com:443/acme/shop'],
    ['get', 'push', 'http://github.com/acme/shop'],
    ['get', 'read', 'https://github.com/acme/shop'],
    ['get', 'fetch', 'https://github.com/acme/shop', 'extra'],
  ])('refuses invalid broker arguments %j', (...argv) => {
    expect(gitCredentialRequest(argv)).toBeNull();
  });
});
