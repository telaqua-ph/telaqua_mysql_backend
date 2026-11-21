/**
 * One-time catch-up: add map coordinates for every order pincode that has none.
 *   npm run farmer-intel:geocode
 * Runs 1 lookup per second (OpenStreetMap policy), so 100 pincodes take ~2 minutes.
 */
import "dotenv/config";
import { pool } from "../config/db.js";
import { runPincodeGeocodeSync } from "../services/pincodeGeocodeService.js";

const total = { checked: 0, added: 0, notFound: 0, failed: 0 };
try {
  for (let round = 0; round < 40; round += 1) {
    const result = await runPincodeGeocodeSync({ limit: 25 });
    for (const key of Object.keys(total)) total[key] += Number(result[key] || 0);
    console.log(`Round ${round + 1}:`, result);
    if (!result.checked || result.error) break;
  }
  console.log("Done:", total);
} finally {
  await pool.end();
}
