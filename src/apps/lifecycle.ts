import { appletDataDir } from '../paths.js';
import { atomicRemoveDirectorySync } from '../fs-utils.js';
import { removeRunWorkspace } from '../workspaces.js';
import { SpecialistStore } from '../specialists.js';
import { deleteSpecialist } from '../specialist-lifecycle.js';
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
 * this owns the fact that an applet is spread over seven places.
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
  //
  //    Through the shared remover rather than a bare `rmSync`, and this is the
  //    site with the most to gain from it: the handle may be held by the DAEMON
  //    rather than this process (which is what the line above can only
  //    best-effort), and on Windows an open handle blocks removal outright. WAL
  //    means the store is `data.db` + `-wal` + `-shm`, so a walk that dies
  //    part-way can leave an orphan WAL beside a deleted database — which a
  //    re-added applet of the same id would then open. The rename makes that
  //    unrepresentable; it never half-exists under the live name.
  //
  //    The tombstone it may leave is collected by the remover itself, not by
  //    anything here — see `collectRemovalTombstones`, which exists because
  //    this call site had no collector when the contract lived in prose.
  closeAppletStore(appId);
  atomicRemoveDirectorySync(appletDataDir(appId));

  // 3. The action write scope. Through the shared helper (#585), which renames
  //    it aside before removing so a walk that fails part-way cannot leave a
  //    half-emptied workspace under the id a re-added applet would adopt.
  removeRunWorkspace('apps', appId);

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
      // The full sweep, so a bound specialist's owned memories go with it —
      // the same reason the direct delete path uses it.
      deleteSpecialist(bound.id, specialists);
      boundSpecialists.push(bound.id);
    } catch {
      // A bundled specialist cannot be bound (nothing binds them) and cannot
      // be deleted; if one somehow is, leaving it is better than throwing
      // half-way through a sweep the caller cannot resume.
    }
  }

  return { deleted: true, boundSpecialists };
}
