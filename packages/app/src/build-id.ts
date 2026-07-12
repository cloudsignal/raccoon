// The standalone PWA build injects __RACCOON_BUILD_ID__ via a bundler define
// (vite.config / vitest define). The REUSABLE library surface must not depend
// on that standalone-only global — an embedded host bundles the lib without it.
// A `typeof` guard is runtime-safe (referencing an undeclared global with
// `typeof` never throws) and the bundler define still substitutes it in the
// standalone build, so this is 'dev' when embedded and the real id standalone.
declare const __RACCOON_BUILD_ID__: string | undefined;

export const RACCOON_BUILD_ID: string =
  typeof __RACCOON_BUILD_ID__ !== 'undefined' ? __RACCOON_BUILD_ID__ : 'dev';
