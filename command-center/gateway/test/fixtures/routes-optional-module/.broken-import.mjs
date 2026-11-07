// Fixture (dot-prefixed so node --test skips it) for routes-optional-module.test.mjs: a module that IS present but imports a file that is not.
// Loading it must fail loudly, never be reported as "module not shipped".
import { nothing } from './this-dependency-does-not-exist.mjs';

export const value = nothing;
