// The real location of a path that may not exist yet: the real path of its nearest existing parent
// plus the missing rest. A junction or symlink anywhere on the way is followed, so a containment
// check sees where a write would really land. It walks up only past a part that does not exist
// (lstat ENOENT); any other failure, such as a dangling link, gives null and the caller refuses.
import fs from 'node:fs';
import path from 'node:path';
import { realpathOrNull } from '../paths.mjs';

export function realLocation(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    const real = realpathOrNull(cur);
    if (real) return path.join(real, ...rest);
    try {
      fs.lstatSync(cur);
      return null; // it exists but does not resolve: a dangling or broken link
    } catch (err) {
      if (err.code !== 'ENOENT') return null;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    rest.unshift(path.basename(cur));
    cur = parent;
  }
}
