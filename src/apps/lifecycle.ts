import * as fs from 'node:fs';
import { appletDataDir, runWorkspace } from '../paths.js';
import { SpecialistStore } from '../specialists.js';
import { AppletBriefStore } from './brief-store.js';
import { closeAppletStore } from './store.js';
import { saveAppGrants } from './app-grants.js';
import { saveAppCspGrant } from './app-csp-grants.js';
import { clearBlocked } from '../host/violations.js';
import { AppRegistry } from './registry.js';

/**
 * Deleting an applet, across every store keyed by its id.
 *
 * Its own module rather than a method on `AppRegistry`, which would otherwise
 * acquire edges to the specialist store, profile settings and SQLite to do a
 * job that is not registry work. The registry owns the manifest and the page;
 * this owns the fact that an applet is spread over six places.
 */

export interface DeleteResult {
  deleted: boolean;
  /** Specialists removed because they were bound to this app and nothing else. */
  boundSpecialists: string[];
}

/**
 * Removes an applet and everything keyed to it.
 *
 * **The order is forced.** The manifest goes first, because it is what
 * `listIds()` sees and therefore what tells the host daemon's `reconcile()` to
 * stop serving — which is what closes the server, revokes the capability
 * handles and closes the SQLite connection. Unlinking the data directory
 * before the daemon notices races a live connection.
 *
 * **The port assignment is deliberately kept.** `HostRegistry` has no
 * `release` on purpose: an applet re-added later gets its origin back, and
 * with it the browser storage that origin still holds.
 *
 * That makes the data directory the one genuinely awkward row. Dropping it
 * while keeping the port hands a re-added applet its old origin with an empty
 * server-side store — a silent half-restore. It is dropped anyway: an applet
 * the user deleted should not leave its data on disk indefinitely, and "delete
 * means delete" is the less surprising of the two. Recorded because the
 * alternative is defensible and the combination is the thing to avoid.
 */
export function deleteApplet(appId: string): DeleteResult {
  const registry = new AppRegistry({ seed: false });
  if (!registry.exists(appId)) return { deleted: false, boundSpecialists: [] };

  // 1. Manifest + served assets. This is what stops the host serving it.
  registry.remove(appId);

  // 2. Release the SQLite handle before touching the file. `closeAppletStore`
  //    is idempotent and safe when the daemon already closed it.
  closeAppletStore(appId);
  fs.rmSync(appletDataDir(appId), { recursive: true, force: true });

  // 3. The action write scope.
  fs.rmSync(runWorkspace('apps', appId), { recursive: true, force: true });

  // 4. Per-app permission rules. `[]` removes the entry rather than leaving an
  //    empty one behind for a future app to inherit by id collision.
  saveAppGrants(appId, []);

  // 5. Per-app CSP grants (#467). A separate store from the rules above and
  //    so a separate row: leaving an origin grant behind would hand a
  //    re-added applet of the same id external access the user granted to a
  //    different applet.
  saveAppCspGrant(appId, {});
  //    ...and what the browser reported it was refused, which is only ever
  //    read to offer that grant.
  clearBlocked(appId);

  // 6. The design brief (#463) — what the applet was for and what was tried.
  //    Position is unconstrained: a plain file holds nothing open, so unlike
  //    the SQLite row above this has no ordering requirement.
  new AppletBriefStore().clear(appId);

  // 7. Specialists bound to this app, which are unreachable without it.
  const specialists = new SpecialistStore({ seed: false });
  const boundSpecialists: string[] = [];
  for (const bound of specialists.listBoundTo(appId)) {
    try {
      specialists.delete(bound.id);
      boundSpecialists.push(bound.id);
    } catch {
      // A bundled specialist cannot be bound (nothing binds them) and cannot
      // be deleted; if one somehow is, leaving it is better than throwing
      // half-way through a sweep the caller cannot resume.
    }
  }

  return { deleted: true, boundSpecialists };
}
