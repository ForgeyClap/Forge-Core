/**
 * Distributed-build stand-in for AccountRotationView (WP B5 part BUILD).
 *
 * In `vite build --mode dist` the forge-dist-strip plugin (scripts/dist-strip.mjs) resolves every
 * import of views/accounts/AccountRotationView to this module, so the rotator view, its stylesheet
 * and its gateway adapter never reach an emitted chunk. It renders nothing; App.tsx also drops the
 * /accounts route in that build, so this stand-in is normally tree-shaken away entirely.
 */
export default function DistUnavailable(): null {
  return null;
}
