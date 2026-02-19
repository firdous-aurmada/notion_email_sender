/**
 * run.js — Main email sender.
 *
 * Reads all pending rows from Notion, validates, sends via Outlook,
 * updates each row with the result, then exits.
 *
 * Runs automatically via GitHub Actions every 5 minutes.
 * Can also be run manually: node scripts/run.js
 */

require("dotenv").config();
const dns   = require("dns").promises;
const fetch = require("node-fetch");
const { Client } = require("@notionhq/client");

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const COL = {
  name:             process.env.COL_NAME             || "Name",
  email:            process.env.COL_EMAIL            || "Email",
  send:             process.env.COL_SEND             || "Send",
  template:         process.env.COL_TEMPLATE         || "Template",
  validationStatus: process.env.COL_VALIDATION_STATUS || "Validation Status",
  sendStatus:       process.env.COL_SEND_STATUS      || "Send Status",
  sentAt:           process.env.COL_SENT_AT          || "Sent At",
};

const SEND_DELAY_MS = parseInt(process.env.SEND_DELAY_MS || "3000");
const SCOPE         = "https://graph.microsoft.com/Mail.Send offline_access";
const TOKEN_URL     = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";

// ─────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────

const notion = new Client({ auth: process.env.NOTION_API_KEY });

// ─────────────────────────────────────────────
// LOGGING — structured for GitHub Actions
// ─────────────────────────────────────────────

let sentCount   = 0;
let failedCount = 0;

function log(type, email, message) {
  const icons = { success: "✅", error: "❌", info: "ℹ️" };
  const icon  = icons[type] || "•";
  const addr  = email ? ` ${email} —` : "";
  console.log(`${icon}${addr} ${message}`);
}

// ─────────────────────────────────────────────
// MICROSOFT GRAPH AUTH
// Uses a stored refresh token — no browser interaction needed
// ─────────────────────────────────────────────

let cachedToken    = null;
let tokenExpiresAt = 0;

async function getGraphToken() {
  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;

  const refreshToken = process.env.OUTLOOK_REFRESH_TOKEN;
  if (!refreshToken) {
    throw new Error(
      "OUTLOOK_REFRESH_TOKEN is not set.\n" +
      "Run: node scripts/get-token.js\n" +
      "Then add the token to your GitHub Secrets."
    );
  }

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     process.env.AZURE_CLIENT_ID,
      grant_type:    "refresh_token",
      refresh_token: refreshToken,
      scope:         SCOPE,
    }),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token)
    throw new Error(data.error_description || data.error || "Token refresh failed");

  cachedToken    = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;

  // If Microsoft issued a new refresh token, log it so it can be updated
  // in GitHub Secrets before the old one expires
  if (data.refresh_token && data.refresh_token !== refreshToken) {
    console.log("\n⚠️  Microsoft issued a new refresh token.");
    console.log("   Update OUTLOOK_REFRESH_TOKEN in GitHub Secrets with:");
    console.log(`   ${data.refresh_token}\n`);
  }

  return cachedToken;
}

// ─────────────────────────────────────────────
// SEND EMAIL VIA GRAPH API
// ─────────────────────────────────────────────

async function sendEmailViaGraph(toEmail, toName, subject, htmlBody) {
  const token = await getGraphToken();

  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: {
      Authorization:  `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "HTML", content: htmlBody },
        toRecipients: [{ emailAddress: { address: toEmail, name: toName } }],
      },
      saveToSentItems: true,
    }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    throw new Error(`Graph API: ${error?.error?.message || `HTTP ${res.status}`}`);
  }
}

// ─────────────────────────────────────────────
// EMAIL VALIDATION — format + MX record only
// SMTP handshake removed: major providers return fake 550s as anti-spam
// ─────────────────────────────────────────────

function isValidFormat(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function validateEmail(email) {
  if (!isValidFormat(email))
    return { valid: false, reason: "Invalid email format" };

  const domain = email.split("@")[1];
  try {
    const records = await dns.resolveMx(domain);
    if (!records || records.length === 0)
      return { valid: false, reason: `No mail server found for ${domain}` };
  } catch {
    return { valid: false, reason: `No mail server found for ${domain}` };
  }

  return { valid: true };
}

// ─────────────────────────────────────────────
// NOTION BLOCK → HTML CONVERTER
// ─────────────────────────────────────────────

function richTextToHtml(richTexts) {
  if (!richTexts || richTexts.length === 0) return "";
  return richTexts.map((rt) => {
    let text = rt.plain_text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");

    const a = rt.annotations || {};
    if (a.code)          text = `<code style="background:#f4f4f4;padding:1px 5px;border-radius:3px;font-family:monospace">${text}</code>`;
    if (a.bold)          text = `<strong>${text}</strong>`;
    if (a.italic)        text = `<em>${text}</em>`;
    if (a.strikethrough) text = `<s>${text}</s>`;
    if (a.underline)     text = `<u>${text}</u>`;
    if (rt.href)         text = `<a href="${rt.href}" style="color:#0070f3">${text}</a>`;
    return text;
  }).join("");
}

function blocksToHtml(blocks) {
  const lines = [];
  let inUl = false;
  let inOl = false;

  const closeUl = () => { if (inUl) { lines.push("</ul>"); inUl = false; } };
  const closeOl = () => { if (inOl) { lines.push("</ol>"); inOl = false; } };

  for (const block of blocks) {
    const type = block.type;
    const data = block[type] || {};
    const rt   = data.rich_text || [];
    const html = richTextToHtml(rt);

    if (type !== "bulleted_list_item") closeUl();
    if (type !== "numbered_list_item") closeOl();

    switch (type) {
      case "paragraph":
        lines.push(html
          ? `<p style="margin:0 0 12px 0">${html}</p>`
          : `<p style="margin:0 0 12px 0">&nbsp;</p>`);
        break;
      case "heading_1":
        lines.push(`<h1 style="font-size:22px;font-weight:700;margin:0 0 12px 0">${html}</h1>`);
        break;
      case "heading_2":
        lines.push(`<h2 style="font-size:18px;font-weight:700;margin:0 0 10px 0">${html}</h2>`);
        break;
      case "heading_3":
        lines.push(`<h3 style="font-size:15px;font-weight:700;margin:0 0 8px 0">${html}</h3>`);
        break;
      case "bulleted_list_item":
        if (!inUl) { lines.push('<ul style="margin:0 0 12px 0;padding-left:24px">'); inUl = true; }
        lines.push(`<li style="margin-bottom:4px">${html}</li>`);
        break;
      case "numbered_list_item":
        if (!inOl) { lines.push('<ol style="margin:0 0 12px 0;padding-left:24px">'); inOl = true; }
        lines.push(`<li style="margin-bottom:4px">${html}</li>`);
        break;
      case "to_do":
        lines.push(`<p style="margin:0 0 6px 0">${data.checked ? "☑" : "☐"} ${html}</p>`);
        break;
      case "quote":
        lines.push(`<blockquote style="border-left:3px solid #ccc;margin:0 0 12px 0;padding:4px 0 4px 14px;color:#555">${html}</blockquote>`);
        break;
      case "code":
        lines.push(`<pre style="background:#f4f4f4;padding:12px;border-radius:4px;font-family:monospace;overflow-x:auto;margin:0 0 12px 0"><code>${richTextToHtml(rt)}</code></pre>`);
        break;
      case "divider":
        lines.push(`<hr style="border:none;border-top:1px solid #e0e0e0;margin:16px 0">`);
        break;
      case "image": {
        const url = data.type === "external" ? data.external?.url : data.file?.url;
        if (url) lines.push(`<img src="${url}" style="max-width:100%;margin:0 0 12px 0" alt="">`);
        break;
      }
      default:
        break;
    }
  }

  closeUl();
  closeOl();
  return lines.join("\n");
}

async function getTemplate(templatePageId) {
  const page      = await notion.pages.retrieve({ page_id: templatePageId });
  const titleProp = Object.values(page.properties).find((p) => p.type === "title");
  const subject   = titleProp?.title?.[0]?.plain_text || "No subject";

  let blocks = [];
  let cursor;
  do {
    const res = await notion.blocks.children.list({
      block_id:     templatePageId,
      start_cursor: cursor,
      page_size:    100,
    });
    blocks = blocks.concat(res.results);
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);

  return { subject, html: blocksToHtml(blocks) };
}

// ─────────────────────────────────────────────
// NOTION HELPERS
// ─────────────────────────────────────────────

function getProp(page, colName) {
  const prop = page.properties[colName];
  if (!prop) return null;
  switch (prop.type) {
    case "title":     return prop.title?.[0]?.plain_text     || "";
    case "rich_text": return prop.rich_text?.[0]?.plain_text || "";
    case "email":     return prop.email                      || "";
    case "checkbox":  return prop.checkbox;
    case "select":    return prop.select?.name               || "";
    case "relation":  return prop.relation?.[0]?.id          || null;
    default:          return null;
  }
}

async function updateRow(pageId, updates) {
  const properties = {};
  if (updates.validationStatus !== undefined)
    properties[COL.validationStatus] = { rich_text: [{ text: { content: updates.validationStatus } }] };
  if (updates.sendStatus !== undefined)
    properties[COL.sendStatus] = { select: { name: updates.sendStatus } };
  if (updates.sentAt !== undefined)
    properties[COL.sentAt] = { date: { start: updates.sentAt } };
  if (updates.send !== undefined)
    properties[COL.send] = { checkbox: updates.send };
  await notion.pages.update({ page_id: pageId, properties });
}

async function getPendingRows() {
  const response = await notion.databases.query({
    database_id: process.env.NOTION_DATABASE_ID,
    filter: {
      and: [
        { property: COL.send, checkbox: { equals: true } },
        {
          or: [
            { property: COL.sendStatus, select: { is_empty: true } },
            { property: COL.sendStatus, select: { equals: "Error — Retrying" } },
          ],
        },
      ],
    },
  });
  return response.results;
}

// ─────────────────────────────────────────────
// CORE PROCESSOR
// ─────────────────────────────────────────────

async function processRow(page) {
  const pageId         = page.id;
  const name           = getProp(page, COL.name)     || "there";
  const email          = getProp(page, COL.email)    || "";
  const templatePageId = getProp(page, COL.template);

  if (!email) {
    log("error", "—", "Skipped — no email address");
    await updateRow(pageId, { validationStatus: "No email address", sendStatus: "Failed", send: false });
    failedCount++;
    return;
  }

  if (!templatePageId) {
    log("error", email, "Skipped — no template linked");
    await updateRow(pageId, { validationStatus: "No template linked", sendStatus: "Failed", send: false });
    failedCount++;
    return;
  }

  const validation = await validateEmail(email);
  if (!validation.valid) {
    log("error", email, `Validation failed: ${validation.reason}`);
    await updateRow(pageId, { validationStatus: `❌ ${validation.reason}`, sendStatus: "Failed", send: false });
    failedCount++;
    return;
  }

  let subject, htmlBody;
  try {
    const tpl = await getTemplate(templatePageId);
    subject  = tpl.subject.replace(/\{\{name\}\}/gi, name);
    htmlBody = tpl.html.replace(/\{\{name\}\}/gi, name);
  } catch (err) {
    log("error", email, `Template error: ${err.message}`);
    await updateRow(pageId, { validationStatus: `Template error: ${err.message}`, sendStatus: "Failed", send: false });
    failedCount++;
    return;
  }

  await updateRow(pageId, { validationStatus: "✅ Passed", sendStatus: "Sending..." });

  try {
    await sendEmailViaGraph(email, name, subject, htmlBody);
    log("success", email, `Sent to ${name} — "${subject}"`);
    await updateRow(pageId, { sendStatus: "Sent", sentAt: new Date().toISOString(), send: false });
    sentCount++;
  } catch (err) {
    log("error", email, `Send failed: ${err.message}`);
    await updateRow(pageId, { sendStatus: "Failed", validationStatus: `Send error: ${err.message}`, send: false });
    failedCount++;
  }
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
  // Validate required env vars
  const required = ["NOTION_API_KEY", "NOTION_DATABASE_ID", "AZURE_CLIENT_ID", "OUTLOOK_REFRESH_TOKEN"];
  const missing  = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error("❌ Missing required environment variables:");
    missing.forEach((k) => console.error(`   • ${k}`));
    process.exit(1);
  }

  // Find pending rows
  let rows;
  try {
    rows = await getPendingRows();
  } catch (err) {
    console.error(`❌ Could not reach Notion: ${err.message}`);
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log("ℹ️  No pending rows — nothing to send.");
    process.exit(0);
  }

  log("info", null, `Found ${rows.length} row(s) to process`);

  for (let i = 0; i < rows.length; i++) {
    await processRow(rows[i]);
    // Delay between sends to avoid triggering Microsoft fraud detection
    // Skip delay after the last email
    if (i < rows.length - 1) {
      await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
    }
  }

  // Summary line — visible at a glance in GitHub Actions logs
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ✅ Sent: ${sentCount}   ❌ Failed: ${failedCount}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

  // Exit with error code if any failed — GitHub Actions will mark the run as failed
  if (failedCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`❌ Fatal error: ${err.message}`);
  process.exit(1);
});
