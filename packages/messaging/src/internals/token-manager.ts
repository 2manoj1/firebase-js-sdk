/**
 * @license
 * Copyright 2019 Google LLC
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

import { SubscriptionOptions, TokenDetails } from '../interfaces/token-details';
import {
  arrayToBase64,
  base64ToArray
} from '../helpers/array-base64-translator';
import { dbGet, dbRemove, dbSet } from './idb-manager';
import {
  requestDeleteToken,
  requestGetToken,
  requestUpdateToken
} from './requests';

import { FirebaseInternalDependencies } from '../interfaces/internal-dependencies';
import { MessagingService } from '../messaging-service';

// UpdateRegistration will be called once every week.
const TOKEN_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function getTokenInternal(
  messaging: MessagingService
): Promise<string> {
  const pushSubscription = await getPushSubscription(
    messaging.swRegistration!,
    messaging.vapidKey!
  );

  const subscriptionOptions: SubscriptionOptions = {
    vapidKey: messaging.vapidKey!,
    swScope: messaging.swRegistration!.scope,
    endpoint: pushSubscription.endpoint,
    auth: arrayToBase64(pushSubscription.getKey('auth')!),
    p256dh: arrayToBase64(pushSubscription.getKey('p256dh')!)
  };

  const tokenDetails = await dbGet(messaging.firebaseDependencies);
  if (!tokenDetails) {
    // No token, get a new one.
    return getNewToken(messaging.firebaseDependencies, subscriptionOptions);
  } else if (
    !isTokenValid(tokenDetails.subscriptionOptions!, subscriptionOptions)
  ) {
    // Invalid token, get a new one.
    try {
      await requestDeleteToken(
        messaging.firebaseDependencies!,
        tokenDetails.token
      );
    } catch (e) {
      // Suppress errors because of #2364
      console.warn(e);
    }

    return getNewToken(messaging.firebaseDependencies!, subscriptionOptions);
  } else if (Date.now() >= tokenDetails.createTime + TOKEN_EXPIRATION_MS) {
    // Weekly token refresh
    return updateToken(messaging, {
      token: tokenDetails.token,
      createTime: Date.now(),
      subscriptionOptions
    });
  } else {
    // Valid token, nothing to do.
    return tokenDetails.token;
  }
}

/**
 * This method deletes the token from the database, unsubscribes the token from FCM, and unregisters
 * the push subscription if it exists.
 */
export async function deleteTokenInternal(
  messaging: MessagingService
): Promise<boolean> {
  const tokenDetails = await dbGet(messaging.firebaseDependencies);
  if (tokenDetails) {
    await requestDeleteToken(
      messaging.firebaseDependencies,
      tokenDetails.token
    );
    await dbRemove(messaging.firebaseDependencies);
  }

  // Unsubscribe from the push subscription.
  const pushSubscription =
    await messaging.swRegistration!.pushManager.getSubscription();
  if (pushSubscription) {
    return pushSubscription.unsubscribe();
  }

  // If there's no SW, consider it a success.
  return true;
}

async function updateToken(
  messaging: MessagingService,
  tokenDetails: TokenDetails
): Promise<string> {
  try {
    const updatedToken = await requestUpdateToken(
      messaging.firebaseDependencies,
      tokenDetails
    );

    const updatedTokenDetails: TokenDetails = {
      ...tokenDetails,
      token: updatedToken,
      createTime: Date.now()
    };

    await dbSet(messaging.firebaseDependencies, updatedTokenDetails);
    return updatedToken;
  } catch (e) {
    await deleteTokenInternal(messaging);
    throw e;
  }
}

async function getNewToken(
  firebaseDependencies: FirebaseInternalDependencies,
  subscriptionOptions: SubscriptionOptions
): Promise<string> {
  const token = await requestGetToken(
    firebaseDependencies,
    subscriptionOptions
  );
  const tokenDetails: TokenDetails = {
    token,
    createTime: Date.now(),
    subscriptionOptions
  };
  await dbSet(firebaseDependencies, tokenDetails);
  return tokenDetails.token;
}

/**
 * Gets a PushSubscription for the current user.
 */
async function getPushSubscription(
  swRegistration: ServiceWorkerRegistration,
  vapidKey: string
): Promise<PushSubscription> {
  const subscription = await swRegistration.pushManager.getSubscription();
  if (subscription) {
    return subscription;
  }

  await swRegistration.serviceWorker.ready;

  return swRegistration.pushManager.subscribe({
    userVisibleOnly: true,
    // Chrome <= 75 doesn't support base64-encoded VAPID key. For backward compatibility, VAPID key
    // submitted to pushManager#subscribe must be of type Uint8Array.
    applicationServerKey: base64ToArray(vapidKey)
  });
}

/**
 * Checks if the saved tokenDetails object matches the configuration provided.
 */
function isTokenValid(
  dbOptions: SubscriptionOptions,
  currentOptions: SubscriptionOptions
): boolean {
  const isVapidKeyEqual = currentOptions.vapidKey === dbOptions.vapidKey;
  const isEndpointEqual = currentOptions.endpoint === dbOptions.endpoint;
  const isAuthEqual = currentOptions.auth === dbOptions.auth;
  const isP256dhEqual = currentOptions.p256dh === dbOptions.p256dh;

  return isVapidKeyEqual && isEndpointEqual && isAuthEqual && isP256dhEqual;
}
