/**
 * get-token.js — Run this ONCE locally to get your refresh token.
 *
 * Usage:
 *   node scripts/get-token.js
 *
 * It will show you a code + URL to sign in with your Outlook account.
 * After signing in, it prints your OUTLOOK_REFRESH_TOKEN.
 * Copy that value into your GitHub repository secrets.
 *
 * You never need to run this again unless the token expires
 * (which only happens after 90+ days of zero activity).
 */

require("dotenv").config();
const fetch = require("node-fetch");

const CLIENT_ID      = process.env.AZURE_CLIENT_ID;
const SCOPE          = "https://graph.microsoft.com/Mail.Send offline_access";
const DEVICE_CODE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL       = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

if (!CLIENT_ID) {
  console.error("\n❌ AZURE_CLIENT_ID is missing.");
  console.error("   Create a .env file with AZURE_CLIENT_ID=your_client_id\n");
  process.exit(1);
}

async function main() {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  Notion Email Sender — One-time token setup");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Step 1: Request device code
  const dcRes = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }),
  });

  const dcData = await dcRes.json();

  if (!dcRes.ok || !dcData.device_code) {
    const hint = dcData.error === "unauthorized_client"
      ? "\n→ Fix: Azure Portal → your app → Authentication → enable 'Allow public client flows'"
      : "";
    console.error(`\n❌ ${dcData.error_description || dcData.error}${hint}\n`);
    process.exit(1);
  }

  console.log("  Step 1 of 2 — Sign in to Outlook:\n");
  console.log(`  1. Open this URL in your browser:`);
  console.log(`     ${dcData.verification_uri}\n`);
  console.log(`  2. Enter this code when prompted:`);
  console.log(`     ${dcData.user_code}\n`);
  console.log("  Waiting for you to sign in...\n");

  // Step 2: Poll until signed in
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const pollMs = (dcData.interval || 5) * 1000;

  while (true) {
    await delay(pollMs);

    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: dcData.device_code,
      }),
    });

    const tokenData = await tokenRes.json();

    if (tokenData.access_token) {
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log("  ✅ Signed in successfully!\n");
      console.log("  Step 2 of 2 — Add this to your GitHub Secrets:\n");
      console.log("  Secret name:   OUTLOOK_REFRESH_TOKEN");
      console.log("  Secret value:  (the long string below)\n");
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
      console.log(tokenData.refresh_token);
      console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
      console.log("  Where to add it:");
      console.log("  GitHub repo → Settings → Secrets and variables");
      console.log("  → Actions → New repository secret\n");
      process.exit(0);
    }

    if (tokenData.error === "authorization_pending") continue;
    if (tokenData.error === "slow_down") { await delay(5000); continue; }
    if (tokenData.error === "expired_token") {
      console.error("\n❌ Code expired. Run this script again.\n");
      process.exit(1);
    }
    if (tokenData.error === "access_denied") {
      console.error("\n❌ Sign-in was cancelled.\n");
      process.exit(1);
    }

    console.error(`\n❌ ${tokenData.error_description || tokenData.error}\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n❌ Unexpected error: ${err.message}\n`);
  process.exit(1);
});
