/**
 * Loaded before every test file (see the `test` script's --import). Gives
 * each test process the same starting point a real boot does: the default
 * business exists and holds the credentials from .env.test.
 */

import { seedDefaultBusiness } from "../store/businesses.ts";

seedDefaultBusiness();
