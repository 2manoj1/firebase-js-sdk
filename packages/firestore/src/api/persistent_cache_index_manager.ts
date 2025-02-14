/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  firestoreClientSetPersistentCacheIndexAutoCreationEnabled,
  FirestoreClient
} from '../core/firestore_client';
import { cast } from '../util/input_validation';
import { logDebug, logWarn } from '../util/log';

import { ensureFirestoreConfigured, Firestore } from './database';

/**
 * A `PersistentCacheIndexManager` which you can config persistent cache indexes
 * used for local query execution.
 *
 * To use, call `getPersistentCacheIndexManager()` to get an instance.
 *
 * TODO(CSI) Remove @internal to make the API publicly available.
 * @internal
 */
export class PersistentCacheIndexManager {
  readonly type: 'PersistentCacheIndexManager' = 'PersistentCacheIndexManager';

  /** @hideconstructor */
  constructor(readonly _client: FirestoreClient) {}
}

/**
 * Returns the PersistentCache Index Manager used by the given `Firestore`
 * object.
 *
 * @return The `PersistentCacheIndexManager` instance, or `null` if local
 * persistent storage is not in use.
 *
 * TODO(CSI) Remove @internal to make the API publicly available.
 * @internal
 */
export function getPersistentCacheIndexManager(
  firestore: Firestore
): PersistentCacheIndexManager | null {
  firestore = cast(firestore, Firestore);

  const cachedInstance = persistentCacheIndexManagerByFirestore.get(firestore);
  if (cachedInstance) {
    return cachedInstance;
  }

  const client = ensureFirestoreConfigured(firestore);
  if (client._uninitializedComponentsProvider?._offlineKind !== 'persistent') {
    return null;
  }

  const instance = new PersistentCacheIndexManager(client);
  persistentCacheIndexManagerByFirestore.set(firestore, instance);
  return instance;
}

/**
 * Enables SDK to create persistent cache indexes automatically for local query
 * execution when SDK believes cache indexes can help improves performance.
 *
 * This feature is disabled by default.
 *
 * TODO(CSI) Remove @internal to make the API publicly available.
 * @internal
 */
export function enablePersistentCacheIndexAutoCreation(
  indexManager: PersistentCacheIndexManager
): void {
  setPersistentCacheIndexAutoCreationEnabled(indexManager, true);
}

/**
 * Stops creating persistent cache indexes automatically for local query
 * execution. The indexes which have been created by calling
 * `enablePersistentCacheIndexAutoCreation()` still take effect.
 *
 * TODO(CSI) Remove @internal to make the API publicly available.
 * @internal
 */
export function disablePersistentCacheIndexAutoCreation(
  indexManager: PersistentCacheIndexManager
): void {
  setPersistentCacheIndexAutoCreationEnabled(indexManager, false);
}

function setPersistentCacheIndexAutoCreationEnabled(
  indexManager: PersistentCacheIndexManager,
  isEnabled: boolean
): void {
  indexManager._client.verifyNotTerminated();

  const promise = firestoreClientSetPersistentCacheIndexAutoCreationEnabled(
    indexManager._client,
    isEnabled
  );

  promise
    .then(_ =>
      logDebug(
        `setting persistent cache index auto creation ` +
          `isEnabled=${isEnabled} succeeded`
      )
    )
    .catch(error =>
      logWarn(
        `setting persistent cache index auto creation ` +
          `isEnabled=${isEnabled} failed`,
        error
      )
    );
}

/**
 * Maps `Firestore` instances to their corresponding
 * `PersistentCacheIndexManager` instances.
 *
 * Use a `WeakMap` so that the mapping will be automatically dropped when the
 * `Firestore` instance is garbage collected. This emulates a private member
 * as described in https://goo.gle/454yvug.
 */
const persistentCacheIndexManagerByFirestore = new WeakMap<
  Firestore,
  PersistentCacheIndexManager
>();
