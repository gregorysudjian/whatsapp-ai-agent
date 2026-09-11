/**
 * Loaded before every test file (see the `test` script's --import). Gives
 * each test process the same starting point a real boot does: the default
 * business exists and holds the credentials from .env.test.
 */

import { DEFAULT_BUSINESS_ID, seedDefaultBusiness } from "../store/businesses.ts";
import { getSettings, setSettings } from "../store/settings.ts";

seedDefaultBusiness();
quietDisclosure(DEFAULT_BUSINESS_ID);

/**
 * The first-contact "automated assistant" notice (on by default) adds one
 * message to every new conversation. It has its own tests in
 * store/privacy.test.ts; everywhere else it would be one more message for
 * each assertion about replies to skip past, so those tests turn it off.
 */
export function quietDisclosure(bid: number): void {
  const s = getSettings(bid);
  setSettings(bid, { ...s, privacy: { ...s.privacy, aiDisclosure: false } });
}
