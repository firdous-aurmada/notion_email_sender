# 📧 Notion Email Sender — GitHub Actions

Sends emails from your Notion database automatically, every 5 minutes, with no local setup required. Runs entirely on GitHub's free infrastructure.

---

## How it works

1. You fill in Name, Email, and link a Template in your Notion database
2. You check the **Send** checkbox on any row
3. Within 5 minutes, GitHub Actions fires, finds all pending rows, and sends them all
4. Every row is updated automatically — Sent ✅, Failed ❌, or validation error

---

## One-time setup (~15 minutes)

### Step 1 — Fork or clone this repo to your GitHub account

### Step 2 — Generate your Outlook refresh token (on your local machine)

This is the only step that requires your computer. You do it once and never again.

**Install dependencies:**
```bash
npm install
```

**Create a `.env` file:**
```
AZURE_CLIENT_ID=your_azure_client_id_here
```

**Run the token generator:**
```bash
node scripts/get-token.js
```

A sign-in code and URL will appear in your terminal. Open the URL, enter the code, sign in with your Outlook account. The script prints your refresh token.

### Step 3 — Add GitHub Secrets

Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**

Add these secrets:

| Secret name | Where to get it |
|---|---|
| `NOTION_API_KEY` | notion.so/my-integrations → your integration → token |
| `NOTION_DATABASE_ID` | Your Notion database URL — the ID between the last `/` and `?v=` |
| `AZURE_CLIENT_ID` | Azure Portal → App registrations → your app → Overview |
| `OUTLOOK_REFRESH_TOKEN` | The token printed by `get-token.js` in Step 2 |
| `SEND_DELAY_MS` | `3000` (3 seconds between emails — recommended for personal accounts) |

**Optional** — only add these if your Notion column names differ from the defaults:

| Secret name | Default value |
|---|---|
| `COL_NAME` | `Name` |
| `COL_EMAIL` | `Email` |
| `COL_SEND` | `Send` |
| `COL_TEMPLATE` | `Template` |
| `COL_VALIDATION_STATUS` | `Validation Status` |
| `COL_SEND_STATUS` | `Send Status` |
| `COL_SENT_AT` | `Sent At` |

### Step 4 — Enable GitHub Actions

Go to your repo → **Actions** tab → click **"I understand my workflows, go ahead and enable them"** if prompted.

That's it. The workflow runs automatically every 5 minutes from now on.

---

## Notion database setup

Your database needs these columns:

| Column | Type | Purpose |
|---|---|---|
| `Name` | Title | Recipient's name |
| `Email` | Email | Recipient's email address |
| `Template` | Relation → Email Templates DB | Links to the email template page |
| `Send` | Checkbox | Check this to queue the email |
| `Validation Status` | Text | Auto-filled by the app |
| `Send Status` | Select | Auto-filled — Sent, Failed, etc. |
| `Sent At` | Date | Auto-filled — timestamp |

Your **Email Templates** database:
- Each page's **title** = the email subject line
- Page **body** = the email content (supports all Notion formatting)
- Use `{{name}}` anywhere to insert the recipient's name

---

## Viewing logs

Go to your GitHub repo → **Actions** tab → click any run to see the full log:

```
ℹ️  Found 12 row(s) to process
✅ john@company.com — Sent to John — "Quick question — Aurmada"
✅ sarah@firm.com — Sent to Sarah — "Quick question — Aurmada"
❌ bademail@x — No mail server found for x
...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ Sent: 11   ❌ Failed: 1
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

If any email fails, the run is marked with a ⚠️ warning in the Actions tab so you notice it immediately.

---

## Refresh token expiry

Microsoft refresh tokens expire after **90 days of inactivity**. If you're sending regularly, the token auto-renews silently and never expires. If you stop using the app for 90+ days, re-run `get-token.js` and update the `OUTLOOK_REFRESH_TOKEN` secret.

The script also logs a warning if Microsoft issues a new refresh token mid-run, so you always know when to update it.

---

## Giving team members access

1. Add them as a collaborator on the GitHub repo (Settings → Collaborators)
2. They can view logs in the Actions tab with no setup whatsoever
3. They never see the secrets — GitHub keeps those encrypted

Nobody on the team needs Node.js, Terminal, or any local setup.
