import { defineSyncRegistry } from "@pgxsinkit/contracts";

import { fkSyncRegistry, projectsSyncRegistry, rlsSyncRegistry } from "./integration";
import { demoSyncRegistry } from "./registry";

export const governanceSyncRegistry = defineSyncRegistry({
  ...demoSyncRegistry,
  ...projectsSyncRegistry,
  ...fkSyncRegistry,
  ...rlsSyncRegistry,
});
