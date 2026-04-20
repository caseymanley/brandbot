require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { App } = require("@slack/bolt");
const OpenAI = require("openai");
const forms = require("./forms");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

// ────────────────────────────────────────────
// Asana config
// ────────────────────────────────────────────
const ASANA_PAT = process.env.ASANA_PAT;
const ASANA_PROJECT_GID = process.env.ASANA_PROJECT_GID; // the project one-pager tasks land in
const ASANA_BASE = "https://app.asana.com/api/1.0";

async function asanaRequest(endpoint, method = "GET", body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${ASANA_PAT}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${ASANA_BASE}${endpoint}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Asana ${method} ${endpoint} → ${res.status}: ${text}`);
  }
  return res.json();
}

// ────────────────────────────────────────────
// Pending requests — bridge between chat + modal
// ────────────────────────────────────────────
// pendingRequests[uniqueId] = { userId, toolCall, conversationSummary, channel }
const pendingRequests = {};

// ────────────────────────────────────────────
// Pending file uploads — after form submission, users can send files
// ────────────────────────────────────────────
// pendingFileUploads[userId] = { taskGid, taskUrl, taskName, expires }
const pendingFileUploads = {};
const FILE_UPLOAD_WINDOW_MS = 10 * 60 * 1000; // 10-minute window to send files

function setPendingFileUpload(userId, taskGid, taskUrl, taskName) {
  pendingFileUploads[userId] = {
    taskGid,
    taskUrl,
    taskName,
    expires: Date.now() + FILE_UPLOAD_WINDOW_MS,
  };
}

function getPendingFileUpload(userId) {
  const pending = pendingFileUploads[userId];
  if (!pending) return null;
  if (Date.now() > pending.expires) {
    delete pendingFileUploads[userId];
    return null;
  }
  return pending;
}

async function uploadFileToAsana(taskGid, fileBuffer, fileName) {
  // Use native FormData + Blob (Node 18+) which works with native fetch
  const blob = new Blob([fileBuffer]);
  const form = new FormData();
  form.append("file", blob, fileName);
  form.append("parent", taskGid);

  const res = await fetch(`${ASANA_BASE}/attachments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ASANA_PAT}`,
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Asana attachment upload → ${res.status}: ${text}`);
  }
  return res.json();
}

// ────────────────────────────────────────────
// Permissions — 3-tier access control
// ────────────────────────────────────────────
let permissions = { admin: { users: [] }, full: { users: [] }, limited: { users: [] } };

function loadPermissions() {
  const p = path.resolve(__dirname, "permissions.json");
  if (fs.existsSync(p)) {
    permissions = JSON.parse(fs.readFileSync(p, "utf8"));
    const total = permissions.admin.users.length + permissions.full.users.length + permissions.limited.users.length;
    console.log(`Permissions loaded: ${total} users (${permissions.admin.users.length} admin, ${permissions.full.users.length} full, ${permissions.limited.users.length} limited)`);
  } else {
    console.warn("No permissions.json found — all users get full access by default.");
  }
}
loadPermissions();

function getUserTier(userId) {
  if (permissions.admin.users.includes(userId)) return "admin";
  if (permissions.full.users.includes(userId)) return "full";
  if (permissions.limited.users.includes(userId)) return "limited";
  // Default: if no permissions file or user not listed, deny intake access
  const hasAnyUsers = permissions.admin.users.length + permissions.full.users.length + permissions.limited.users.length > 0;
  return hasAnyUsers ? "none" : "full"; // If no whitelist configured, allow everyone (backward compat)
}

function canSubmitForms(userId) {
  const tier = getUserTier(userId);
  return tier === "admin" || tier === "full";
}

function canAccessAssets(userId) {
  const tier = getUserTier(userId);
  return tier === "admin" || tier === "full" || tier === "limited";
}

function isAdmin(userId) {
  return getUserTier(userId) === "admin";
}

// ────────────────────────────────────────────
// Agency whitelist
// ────────────────────────────────────────────
let agencyWhitelist = [];

function loadAgencies() {
  const p = path.resolve(__dirname, "agencies.json");
  if (fs.existsSync(p)) {
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    agencyWhitelist = data.approved_agencies || [];
    console.log(`Agency whitelist loaded: ${agencyWhitelist.length} agencies`);
  } else {
    console.warn("No agencies.json found — agency validation disabled.");
  }
}
loadAgencies();

function matchAgency(name) {
  const needle = name.toLowerCase().trim();
  for (const agency of agencyWhitelist) {
    const names = [agency.name, ...(agency.aliases || [])].map((n) => n.toLowerCase());
    for (const n of names) {
      // Exact or substring match
      if (n === needle || needle.includes(n) || n.includes(needle)) {
        return agency;
      }
    }
  }
  return null;
}

function getAgencyListForPrompt() {
  return agencyWhitelist.map((a) => `- ${a.name}${a.aliases?.length ? ` (also known as: ${a.aliases.join(", ")})` : ""}`).join("\n");
}

// ────────────────────────────────────────────
// Custom fields mapping
// ────────────────────────────────────────────
let customFields = {};

function loadCustomFields() {
  const p = path.resolve(__dirname, "custom-fields.json");
  if (fs.existsSync(p)) {
    customFields = JSON.parse(fs.readFileSync(p, "utf8"));
    console.log(`Custom fields loaded: ${Object.keys(customFields).length} fields`);
  } else {
    console.warn("No custom-fields.json found — custom field mapping disabled.");
  }
}
loadCustomFields();

// Map bot asset_type to Asana asset_type multi_enum option GIDs
function getAssetTypeGids(toolCallAssetType) {
  if (!customFields.asset_type) return [];
  const map = {
    // LLM routing asset types
    "promotional_banner": ["banners_social_ads"],
    "single_slide_graphic": ["illustration_custom_graphic"],
    "video_small_edit": ["video"],
    "video_large_edit": ["video"],
    "video_concept_or_animation": ["video"],
    "programs_and_campaign_system": ["campaign_system"],
    "campaign": ["campaign_system"],
    "event_tier1": ["artwork_event_assets"],
    "feature_launch": ["campaign_system"],
    "graphics_illustration_icons": ["illustration_custom_graphic"],
    "event_and_physical_assets": ["artwork_event_assets", "swag_physical"],
    "content_blog_guide": ["content_creation_copy"],
    "creative_review": ["content_review"],
    // Form dropdown values (direct match)
    "banners_social_ads": ["banners_social_ads"],
    "video": ["video"],
    "artwork": ["artwork_event_assets", "illustration_custom_graphic"],
    "one_pager": ["one_pager"],
    "deck": ["deck_presentation"],
    "print": ["swag_physical"],
    "content_review": ["content_review"],
    "campaign_system": ["campaign_system"],
  };
  const keys = map[toolCallAssetType] || [];
  return keys.map((k) => customFields.asset_type.options[k]).filter(Boolean);
}

// Map form team value to Asana requester_team enum option GID
function getTeamGid(teamValue) {
  if (!customFields.requester_team) return null;
  // Form values are lowercase with underscores
  const directMatch = customFields.requester_team.options[teamValue];
  if (directMatch) return directMatch;
  // Try fuzzy
  const key = Object.keys(customFields.requester_team.options).find((k) =>
    k.includes(teamValue) || teamValue.includes(k)
  );
  return key ? customFields.requester_team.options[key] : customFields.requester_team.options["other"];
}

// Look up Asana user GID from email
const asanaUserCache = {};
async function getAsanaUserGid(email) {
  if (!email || !ASANA_PAT) return null;
  if (asanaUserCache[email]) return asanaUserCache[email];
  try {
    const result = await asanaRequest(`/users/${email}?opt_fields=gid,name`);
    if (result.data?.gid) {
      asanaUserCache[email] = result.data.gid;
      console.log(`[ASANA] Resolved user ${email} → ${result.data.gid} (${result.data.name})`);
      return result.data.gid;
    }
  } catch (err) {
    console.error(`[ASANA] Could not resolve user ${email}:`, err.message);
  }
  return null;
}

// Get Slack user's profile info (name + email)
async function getSlackUserInfo(client, userId) {
  try {
    const result = await client.users.info({ user: userId });
    const profile = result.user?.profile || {};
    return {
      email: profile.email || null,
      name: profile.real_name || result.user?.real_name || null,
    };
  } catch (err) {
    console.error(`[SLACK] Could not get profile for ${userId}:`, err.message);
    return { email: null, name: null };
  }
}

// Backward-compat wrapper (used elsewhere in the file)
async function getSlackUserEmail(client, userId) {
  const info = await getSlackUserInfo(client, userId);
  return info.email;
}

// Build custom_fields object for Asana task creation
function buildCustomFields({ toolCall, teamValue, dueDate, isStrategic, slackUserGid, email }) {
  const fields = {};

  // Asset type (multi_enum)
  if (toolCall?.asset_type && customFields.asset_type) {
    const gids = getAssetTypeGids(toolCall.asset_type);
    if (gids.length) fields[customFields.asset_type.gid] = gids;
  }

  // Requester team (enum)
  if (teamValue && customFields.requester_team) {
    const gid = getTeamGid(teamValue);
    if (gid) fields[customFields.requester_team.gid] = gid;
  }

  // Requested due date (date)
  if (dueDate && customFields.requested_due_date) {
    fields[customFields.requested_due_date] = { date: dueDate };
  }

  // Strategic (enum)
  if (customFields.event) {
    const isEvent = ["event_tier1", "event_and_physical_assets"].includes(toolCall?.asset_type);
    fields[customFields.event.gid] = isEvent ? customFields.event.options.yes : customFields.event.options.no;
  }

  // Requester (people) — set from Asana user GID
  if (slackUserGid && customFields.requester_people) {
    fields[customFields.requester_people] = slackUserGid;
  }

  // Net new or revision — default to net new for briefs
  if (customFields.net_new_or_revision) {
    fields[customFields.net_new_or_revision.gid] = customFields.net_new_or_revision.options.net_new;
  }

  return fields;
}

// ────────────────────────────────────────────
// SLA configuration (business days by asset type)
// ────────────────────────────────────────────
const SLA_BUSINESS_DAYS = {
  banners_social_ads: 10,
  video: 10,
  artwork: 10,
  one_pager: 7,
  deck: 7,
  print: 20,
  content_review: 5,
};

function getBusinessDaysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end <= start) return 0;
  let count = 0;
  const current = new Date(start);
  while (current < end) {
    current.setDate(current.getDate() + 1);
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++; // skip weekends
  }
  return count;
}

function getSlaWarning(assetType, dueDate) {
  const sla = SLA_BUSINESS_DAYS[assetType];
  if (!sla || !dueDate) return null;
  const today = new Date().toISOString().split("T")[0];
  const bizDays = getBusinessDaysBetween(today, dueDate);
  const assetLabel = forms.ASSET_TYPE_LABELS[assetType] || assetType;
  if (bizDays < sla) {
    return `:warning: *Heads up on turnaround* — the standard SLA for ${assetLabel} requests is *${sla} business days*. Your requested date of ${dueDate} is only *${bizDays} business day${bizDays !== 1 ? "s" : ""}* from today, which is tighter than usual. The team will do their best, but there may be a delay.`;
  }
  return null;
}

// ────────────────────────────────────────────
// Analytics channel + tracking
// ────────────────────────────────────────────
const ANALYTICS_CHANNEL_ID = process.env.ANALYTICS_CHANNEL_ID;
const ANALYTICS_FILE = path.resolve(__dirname, "analytics.json");

// In-memory analytics store, persisted to analytics.json
let analyticsData = { events: [] };

function loadAnalytics() {
  if (fs.existsSync(ANALYTICS_FILE)) {
    try {
      analyticsData = JSON.parse(fs.readFileSync(ANALYTICS_FILE, "utf8"));
      console.log(`Analytics loaded: ${analyticsData.events.length} events`);
    } catch {
      analyticsData = { events: [] };
    }
  }
}
loadAnalytics();

function saveAnalytics() {
  try {
    fs.writeFileSync(ANALYTICS_FILE, JSON.stringify(analyticsData, null, 2));
  } catch (err) {
    console.error("[ANALYTICS] Save failed:", err.message);
  }
}

function trackEvent(type, userId, data = {}) {
  analyticsData.events.push({
    type,
    userId,
    timestamp: new Date().toISOString(),
    ...data,
  });
  // Keep last 10,000 events max
  if (analyticsData.events.length > 10000) {
    analyticsData.events = analyticsData.events.slice(-10000);
  }
  saveAnalytics();
}

function getAnalyticsSummary(days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const recent = analyticsData.events.filter((e) => e.timestamp >= cutoff);

  // Count by type
  const byType = {};
  recent.forEach((e) => { byType[e.type] = (byType[e.type] || 0) + 1; });

  // Count by user
  const byUser = {};
  recent.forEach((e) => { byUser[e.userId] = (byUser[e.userId] || 0) + 1; });

  // Top requesters (sorted)
  const topUsers = Object.entries(byUser)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  // Count by asset type requested
  const byAssetType = {};
  recent.filter((e) => e.assetType).forEach((e) => { byAssetType[e.assetType] = (byAssetType[e.assetType] || 0) + 1; });

  // Count by team
  const byTeam = {};
  recent.filter((e) => e.team).forEach((e) => { byTeam[e.team] = (byTeam[e.team] || 0) + 1; });

  // Assets delivered
  const assetsDelivered = recent.filter((e) => e.type === "asset_delivered").length;
  const filesAttached = recent.filter((e) => e.type === "file_attached").length;

  // Rejections
  const rejections = recent.filter((e) => e.type === "request_rejected").length;

  return { total: recent.length, byType, topUsers, byAssetType, byTeam, assetsDelivered, filesAttached, rejections, days };
}

async function postAnalytics(text) {
  if (!ANALYTICS_CHANNEL_ID) return;
  try {
    await app.client.chat.postMessage({
      channel: ANALYTICS_CHANNEL_ID,
      text,
    });
  } catch (err) {
    console.error("[ANALYTICS] Failed to post:", err.message);
  }
}

// ────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────
let registry = { figma_buzz: {}, asana_forms: {}, meta: {} };

function loadRegistry() {
  const p = path.resolve(__dirname, "registry.json");
  if (fs.existsSync(p)) {
    registry = JSON.parse(fs.readFileSync(p, "utf8"));
    console.log("Registry loaded:", {
      figma_buzz: Object.keys(registry.figma_buzz || {}),
      asana_forms: Object.keys(registry.asana_forms || {}),
    });
  } else {
    console.warn("No registry.json found.");
  }
}
loadRegistry();

// ────────────────────────────────────────────
// Onboarding flow — first-time users pick their team
// ────────────────────────────────────────────
function isOnboarded(userId) {
  return !!userProfiles[userId]?.team;
}

function buildOnboardingBlocks() {
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `:wave: *Welcome to BrandBot!*\n\nI'm the Brand Services intake advisor for HiBob. Before we get started, I need to know which team you're on — this helps me route your requests and track analytics.\n\nSelect your team below and hit *Done*.` },
    },
    { type: "divider" },
    {
      type: "input", block_id: "onboard_team_block",
      label: { type: "plain_text", text: "What team are you on?" },
      element: {
        type: "static_select", action_id: "onboard_team_input",
        options: null, // TEAM_OPTIONS injected at runtime
      },
    },
  ];
}

async function showOnboarding(userId, triggerId, client) {
  const blocks = buildOnboardingBlocks();
  const teamBlock = blocks.find(b => b.block_id === "onboard_team_block");
  if (teamBlock) teamBlock.element.options = TEAM_OPTIONS;

  await client.views.open({
    trigger_id: triggerId,
    view: {
      type: "modal",
      callback_id: "onboarding_submit",
      title: { type: "plain_text", text: "Welcome to BrandBot" },
      submit: { type: "plain_text", text: "Done" },
      blocks,
    },
  });
}

app.action("start_onboarding", async ({ body, ack, client }) => {
  await ack();
  await showOnboarding(body.user.id, body.trigger_id, client);
});

app.action("confirm_full_rescan", async ({ body, ack, client }) => {
  await ack();
  const userId = body.user.id;
  const channelId = body.channel?.id || body.user.id;

  const { execFile } = require("child_process");
  const scanScript = path.resolve(__dirname, "scan-assets.js");
  const keyFile = path.resolve(__dirname, "intense-climber-490121-s1-932e831cd444.json");
  const driveFolderId = "17zbQQudoe_lFv-c5xdMELEUwt6CB0uCS";
  const assetsFile = path.resolve(__dirname, "assets.json");

  if (!fs.existsSync(scanScript)) {
    await client.chat.postMessage({ channel: channelId, text: "scan-assets.js not found." });
    return;
  }

  // Delete existing catalog
  try {
    if (fs.existsSync(assetsFile)) fs.unlinkSync(assetsFile);
    assetCatalog = [];
  } catch (e) {
    await client.chat.postMessage({ channel: channelId, text: `:x: Couldn't delete assets.json: ${e.message}` });
    return;
  }

  // Post progress start
  const progressMsg = await client.chat.postMessage({
    channel: channelId,
    text: `:hourglass_flowing_sand: *Full rescan in progress...*\n\n:wastebasket: Catalog deleted\n:mag: Scanning Drive folder...\n\n_This may take several minutes. I'll update you as it progresses._`,
  });

  if (ANALYTICS_CHANNEL_ID) {
    try { await client.chat.postMessage({ channel: ANALYTICS_CHANNEL_ID, text: `:rotating_light: *Full asset re-scan started* by <@${userId}> — catalog deleted, rebuilding from scratch.` }); } catch {}
  }

  const args = [scanScript, driveFolderId];
  if (fs.existsSync(keyFile)) args.push(`--key=${keyFile}`);

  const child = execFile("node", args, { timeout: 600000 }, async (err, stdout, stderr) => {
    // Reload catalog
    try {
      if (fs.existsSync(assetsFile)) {
        assetCatalog = JSON.parse(fs.readFileSync(assetsFile, "utf8"));
      }
    } catch (e) {
      console.error("[CATALOG] Reload failed:", e.message);
    }

    if (err) {
      console.error("[CATALOG] Full scan failed:", err.message);
      await client.chat.update({
        channel: channelId, ts: progressMsg.ts,
        text: `:x: *Full rescan failed*\n\n${err.message}\n\`\`\`${(stderr || "").slice(0, 500)}\`\`\``,
      });
    } else {
      const totalMatch = stdout.match(/Total: (\d+) assets/);
      const analyzedMatch = stdout.match(/Analyzed: (\d+)/);
      const skippedMatch = stdout.match(/Skipped: (\d+)/);
      const total = totalMatch ? totalMatch[1] : assetCatalog.length;
      const analyzed = analyzedMatch ? analyzedMatch[1] : "?";
      const skipped = skippedMatch ? skippedMatch[1] : "0";

      await client.chat.update({
        channel: channelId, ts: progressMsg.ts,
        text: `:white_check_mark: *Full rescan complete!*\n\n:brain: ${analyzed} assets analyzed with AI vision\n:next_track_button: ${skipped} skipped (unsupported format)\n:file_cabinet: Catalog rebuilt with *${total} total assets*`,
      });

      if (ANALYTICS_CHANNEL_ID) {
        try { await client.chat.postMessage({ channel: ANALYTICS_CHANNEL_ID, text: `:white_check_mark: *Full rescan complete* — ${total} assets in catalog (${analyzed} analyzed)` }); } catch {}
      }
    }
  });

  // Progress updates via stdout monitoring
  let lastUpdate = Date.now();
  let scannedCount = 0;
  if (child.stdout) {
    child.stdout.on("data", async (data) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.includes("✅") || line.includes("⏭")) scannedCount++;
      }
      // Update progress every 15 seconds
      if (Date.now() - lastUpdate > 15000 && scannedCount > 0) {
        lastUpdate = Date.now();
        try {
          await client.chat.update({
            channel: channelId, ts: progressMsg.ts,
            text: `:hourglass_flowing_sand: *Full rescan in progress...*\n\n:brain: ${scannedCount} assets processed so far...\n\n_Still working. I'll update when it's done._`,
          });
        } catch {}
      }
    });
  }
});

app.view("onboarding_submit", async ({ ack, view, body, client }) => {
  const userId = body.user.id;
  const vals = view.state.values;
  const team = vals.onboard_team_block.onboard_team_input.selected_option;

  setUserTeam(userId, team.text.text);

  // Mark onboarding complete
  if (!userProfiles[userId]) userProfiles[userId] = {};
  userProfiles[userId].onboarded_at = new Date().toISOString();
  saveUserProfiles();

  await ack();

  // Send intro message
  await client.chat.postMessage({
    channel: userId,
    text: [
      `:white_check_mark: You're all set! Team: *${team.text.text}*`,
      ``,
      `Here's what I can help you with:`,
      ``,
      `*:art: Request creative work* — Tell me what you need (a banner, deck, one-pager, video, illustration) and I'll route it to the right place.`,
      `*:mag: Find brand assets* — Ask for illustrations, icons, logos, or shapes from our library and I'll send them to you.`,
      `*:book: Brand questions* — Colors, fonts, voice, logo usage — I know it all.`,
      `*:clipboard: Check request status* — Type \`my requests\` to see where your submissions stand.`,
      `*:bar_chart: Your analytics* — Type \`my analytics\` for a personal activity summary.`,
      ``,
      `You can also update your team anytime with \`set team [name]\`.`,
      ``,
      `Go ahead — tell me what you need!`,
    ].join("\n"),
  });

  console.log(`[ONBOARD] User ${userId} onboarded: team=${team.text.text}`);
});

// ────────────────────────────────────────────
// Version log
// ────────────────────────────────────────────
const CHANGELOG_FILE = path.resolve(__dirname, "changelog.json");
let changelog = [];

function loadChangelog() {
  if (fs.existsSync(CHANGELOG_FILE)) {
    try { changelog = JSON.parse(fs.readFileSync(CHANGELOG_FILE, "utf8")); } catch { changelog = []; }
  }
}
loadChangelog();
// sessions[userId] = { messages: [...], lastActivity: timestamp }
// ────────────────────────────────────────────
// Session store — real conversation history
// ────────────────────────────────────────────
const sessions = {};
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_HISTORY = 20; // keep last 20 messages (10 turns)

// ────────────────────────────────────────────
// User profiles — persistent team + preferences
// ────────────────────────────────────────────
const USER_PROFILES_FILE = path.resolve(__dirname, "user-profiles.json");
let userProfiles = {};

function loadUserProfiles() {
  if (fs.existsSync(USER_PROFILES_FILE)) {
    try {
      userProfiles = JSON.parse(fs.readFileSync(USER_PROFILES_FILE, "utf8"));
      console.log(`User profiles loaded: ${Object.keys(userProfiles).length} users`);
    } catch { userProfiles = {}; }
  }
}
loadUserProfiles();

function saveUserProfiles() {
  try { fs.writeFileSync(USER_PROFILES_FILE, JSON.stringify(userProfiles, null, 2)); } catch (err) {
    console.error("[PROFILES] Save failed:", err.message);
  }
}

function setUserTeam(userId, teamName) {
  if (!userProfiles[userId]) userProfiles[userId] = {};
  userProfiles[userId].team = teamName;
  saveUserProfiles();
}

function getUserTeam(userId) {
  return userProfiles[userId]?.team || null;
}

function getSession(userId) {
  const now = Date.now();
  let s = sessions[userId];
  if (!s || now - s.lastActivity > SESSION_TTL_MS) {
    s = { messages: [], lastActivity: now, formType: null, lastToolCall: null, videoValidated: false, videoTurnCount: 0, pendingAssetType: null };
    sessions[userId] = s;
  }
  s.lastActivity = now;
  return s;
}

function pushMessage(session, role, content) {
  session.messages.push({ role, content });
  // Trim to keep context window manageable
  if (session.messages.length > MAX_HISTORY) {
    session.messages = session.messages.slice(-MAX_HISTORY);
  }
}

// ────────────────────────────────────────────
// Build the registry into readable reference
// ────────────────────────────────────────────
function buildRegistryReference() {
  const BUZZ_HOWTO_LOOM = "https://www.loom.com/share/a6f6f7ddfefa4365bb3487a249a08492?sid=2a12a0c7-3301-4f86-ab11-26847dd1c966";

  const lines = [];

  lines.push("## Figma Buzz Templates (self-serve)");
  for (const [key, entry] of Object.entries(registry.figma_buzz || {})) {
    if (key === "project_level_hub") continue;
    lines.push(`- *${entry.name}* (key: ${key})`);
    lines.push(`  Use for: ${entry.use.join(", ")}`);
    lines.push(`  Share as: <${entry.link}|${entry.name}>`);
  }
  const hub = registry.figma_buzz?.project_level_hub;
  if (hub) {
    lines.push(`- *Full Figma Buzz Hub*: <${hub.link}|Figma Buzz Hub>`);
  }

  lines.push("");
  lines.push("## Figma Buzz How-To Video (ALWAYS include when sharing any Buzz link)");
  lines.push(`Whenever you share any Figma Buzz template link or the hub link, ALSO include this how-to refresher video: <${BUZZ_HOWTO_LOOM}|Figma Buzz How-To Video>`);
  lines.push("Frame it naturally, e.g. 'If you need a refresher on how Buzz works, here's a quick walkthrough: <link|Figma Buzz How-To Video>'");

  lines.push("");
  lines.push("## Figma Buzz Access");
  const accessForm = registry.asana_forms?.figma_buzz_access_request;
  if (accessForm) {
    lines.push(`If someone doesn't have Buzz access yet, or you're not sure, proactively offer the access request form: <${accessForm.link}|Request Figma Buzz Access>`);
  }

  lines.push("");
  lines.push("## Asana Forms (shareable — these do NOT have in-Slack buttons)");
  const shareableForms = ["figma_buzz_access_request"];
  for (const key of shareableForms) {
    const entry = registry.asana_forms?.[key];
    if (!entry) continue;
    lines.push(`- *${entry.name}*`);
    lines.push(`  Use for: ${entry.use.join(", ")}`);
    lines.push(`  Share as: <${entry.link}|${entry.name}>`);
  }

  lines.push("");
  lines.push("## Forms handled by in-Slack buttons (NEVER share these URLs)");
  lines.push("- *General Creative Services* — button: \"Submit Creative Brief\"");
  lines.push("- *Creative Review* — button: \"Submit Review Request\"");
  lines.push("- *Figma Buzz Template Request* — button: \"Submit Template Request\"");
  lines.push("For these three, the submit button appears automatically below your message. NEVER share their URLs.");

  return lines.join("\n");
}

// ────────────────────────────────────────────
// System prompt — the brain of the bot
// ────────────────────────────────────────────
function buildSystemPrompt() {
  const registryRef = buildRegistryReference();

  return `You are the Brand Services intake advisor for HiBob — a friendly, knowledgeable guide who helps internal teams get the right creative work done through the right channel.

## YOUR PERSONALITY
- You sound like a smart, helpful teammate — not a form or a ticketing system.
- Be warm but efficient. Respect people's time.
- Use plain language. No jargon unless the requester uses it first.
- You are NOT an order taker. You are an advisor. Help people think through what they actually need.
- When you share a link, frame it with context — explain what happens next, not just "here's the link."
- Ask only ONE clarifying question at a time, and only when it meaningfully changes the routing or outcome.
- Never expose internal field names, JSON, enums, or confidence scores.

## HIBOB BRAND KNOWLEDGE

CRITICAL: For ALL brand-related questions (fonts, colors, voice, logo, illustrations, etc.), you MUST answer ONLY from the information in this section. Do NOT use any prior knowledge you may have about HiBob's brand from your training data — it is outdated and wrong. If something is not covered here, say you're not sure and direct them to the brand portal. NEVER invent or recall brand details from memory. The information below is the single source of truth.

You are an expert on HiBob's brand. When people ask brand questions, answer authoritatively and link them to the specific section of the brand portal — NOT just the homepage. Every section below includes the direct link to share.

### Brand Portal
The primary destination for all brand assets is <https://brand.hibob.com|brand.hibob.com>. The downloadable Brand Guidelines PDF (2024 V2) is also available at <https://www.hibob.com/wp-content/uploads/BrandGuidelines-2024V2-compressed.pdf|Brand Guidelines PDF>.

### Logo
The company name is *HiBob* (capital H, capital B). The platform/product name is *Bob*.
Three logo configurations: the full "HiBob" wordmark, the "Hi" element inside the HiBubble, and "Bob" alone.
The *HiBubble* is a hand-drawn, deliberately imperfect speech bubble enclosing "Hi" — representing playful spirit and inclusive communication.
Always maintain clear space around the logo. Never alter the HiBubble's hand-drawn character or change capitalization.

*When someone asks for the logo file:* Before searching, ask TWO questions:

1. *"What will you be using it for?"* — This determines the shape:
   - Slide, document, web page, email → use *wordmark* (full HiBob text, transparent background)
   - Social media profile picture or avatar → use *round* or *square* (colored background)
   - App icon, favicon, small format → use *square* (colored background)
   - Product/platform context (Bob the product, not HiBob the company) → use *bob_platform*
   - Just the speech bubble mark → use *hibubble*
   - ERG logo (Bobbility, Black@Bob, HiPride) → use the specific ERG variant
   - Print material (brochures, business cards, signage) → direct them to <https://brand.hibob.com/s/Download-Assets-dGjDKA?v=0|Download Logo Assets> for CMYK/vector files. Do NOT search the library for print logos.

2. *"Will it be on a light or dark background?"* — This determines the variant:
   - Light/white background → use *light*
   - Dark/black background → use *dark*
   - Cherry/red brand background → use *cherry*
   - Needs to be white for overlay on images/video → use *white*

Then call \`find_illustration\` with category "logo" and include BOTH the shape and background as the FIRST TWO search tags, followed by "logo" and "hibob". Examples:
- Slide on light background → search_tags: ["wordmark", "light", "logo", "hibob"]
- Social profile on cherry → search_tags: ["round", "cherry", "logo", "hibob"]
- Small icon for app → search_tags: ["square", "black", "logo", "hibob"]
- Bob product logo → search_tags: ["bob_platform", "black", "logo", "bob"]
- HiBubble only → search_tags: ["hibubble", "color", "logo", "hibob"]
- ERG Bobbility → search_tags: ["erg_bobbility", "color", "logo", "hibob"]

The first tag MUST be one of: wordmark, rectangle, square, round, hibubble, bob_platform, erg_bobbility, erg_blackatbob, erg_hipride.
The second tag MUST be one of: light, dark, white, cherry, black, color.

Always share the logo usage guidelines link alongside the files: <https://brand.hibob.com/s/HiBob-logo-oKDjDr?v=0|Logo Usage Guidelines>

Direct links to share:
• Logo downloads (SVG, PNG, vector): <https://brand.hibob.com/s/Download-Assets-dGjDKA?v=0|Download Logo Assets>
• Logo usage guidance: <https://brand.hibob.com/s/HiBob-logo-oKDjDr?v=0|Logo Usage Guidelines>

### Colors
HiBob's core brand colors:

*Cherry Syrup* — HEX: #EE164F / RGB: 238, 22, 79 / CMYK: 1, 99, 61, 0 / PMS 1925 C
*Dark Wine* — HEX: #83143D / RGB: 131, 20, 61 / CMYK: 34, 100, 60, 30 / PMS 228 C
*Orange Juice* — HEX: #FAA32B / RGB: 250, 163, 43 / CMYK: 1, 42, 93, 0 / PMS 137 C
*Cappuccino Foam* — HEX: #FDF6EB / RGB: 253, 246, 235 / CMYK: 1, 3, 6, 0 / PMS P 1-2 C
*Black Coffee* — HEX: #3A3A37 / RGB: 58, 58, 55 / CMYK: 67, 61, 64, 53 / PMS Black 7 C

The 2024 evolution expanded the palette with additional tints and shades for depth, flexibility, and better accessibility contrast. HiBob is working toward WCAG 2.2 standards.

When someone asks "what are our brand colors?" — share the color names, hex values, and RGB values directly in the conversation. Then link them to the full reference.

Direct link: <https://brand.hibob.com/k/Colors-PXX7ww|Brand Colors>

### Typography
IMPORTANT: Our fonts are listed below. Do NOT mention "three typefaces with varying weights" generically, do NOT mention camelCase constructions like "beBrilliantBeYou" — that is NOT part of our typography system. Only reference the specific fonts listed here.

HiBob uses three primary typefaces, each with specific roles, plus Google font counterparts for web and non-licensed use:

*Primary Brand Fonts (licensed):*
• *Champion* — Display/headline font. Bold, expressive, used for hero headlines and large-format brand moments.
• *Sentinel* — Serif font. Used for body copy in editorial and long-form content. Warm and readable.
• *Gotham* — Sans-serif workhorse. Used for UI, supporting copy, captions, and general-purpose text.

*Google Font Counterparts (for web, docs, and non-licensed contexts):*
• *Archivo* — Substitute for Champion. Use for headlines and display text.
• *Domine* — Substitute for Sentinel. Use for body copy and editorial content.
• *Lato* — Substitute for Gotham. Use for UI text, supporting copy, and general use.

When someone asks about fonts, ALWAYS list the specific font names above with their roles. Never give a vague answer about "three typefaces."

Direct links:
• Typography guidelines: <https://brand.hibob.com/k/Typography-d45yE4|Typography Guidelines>
• Font downloads: <https://drive.google.com/open?id=12IM9KOqTn483aikkmhF-WvgCaocxniak&usp=drive_fs|Download Brand Fonts>

### Illustrations
Illustration is a key part of HiBob's brand identity.
Style: *paper cutout / paper tearing aesthetic* — organic, handmade feel with soft curves and bold patterns.
Illustrations represent all people, all over the world — people of all different shapes, colors, and abilities.
Vibrant and multi-layered with warm personality.

If they need a *new custom illustration* not in the library → route to Creative Services (Submit Creative Brief button).

Direct links:
• Spot (small) illustrations: <https://brand.hibob.com/s/Spot-illustrations-RmNLE5?v=0|Spot Illustrations>
• Illustrative icons: <https://brand.hibob.com/s/Illustrative-icons-oKDnzE?v=0|Illustrative Icons>

### Shapes, Textures & Patterns
Textures add depth and tactile appeal, inspired by everyday work environment materials.
Patterns create vibrant, multi-layered images that enrich visual storytelling.
All shapes are rounded with soft curves, intentionally imperfect — no perfect circles or squares.

Direct links:
• Shapes, textures & patterns: <https://brand.hibob.com/k/Shapes-textures-and-patterns-RWgzJX|Shapes, Textures & Patterns>
• Shape downloads: <https://brand.hibob.com/s/Shapes-on3Q1Q?v=0|Download Shapes>

### Brand Voice & Tone
HiBob's voice is warm, confident, real, fun, and inclusive. Here's how it breaks down:

*Warm* — We're personal and human-centered. We show more soul than most technology companies. We connect on a personal level through handmade touches that engage people.

*Confident* — We're refreshingly honest. We make bold statements. We don't hedge or hide behind corporate speak.

*Real* — We connect on a personal, human level. Our realness helps us build trust. We combine warmth with sharp insights.

*Fun & Playful* — The "Hi" in HiBob represents our playful spirit. We use inclusive communication and unexpected personality in our copy.

*Inclusive* — We welcome everyone, from every background. Our language reflects the diversity and individuality of the people we serve.

This is NOT a generic B2B tech voice. HiBob intentionally has more emotional depth and personality. When helping with tone, encourage this — don't water it down.

Direct link: <https://brand.hibob.com/k/Tone-of-voice-dpKGDY|Tone of Voice Guidelines>

### Photography
Natural expressions, real people — diverse, friendly, authentic.
No overly staged or artificial imagery.
People of all different shapes, colors, and abilities.

### Additional Brand Assets
• Zoom backgrounds: <https://brand.hibob.com/s/owgQ9E?v=0|Zoom Backgrounds>
• LinkedIn profile covers: <https://brand.hibob.com/s/owgQ9E?v=0|LinkedIn Profile Covers>

### Core Values
1. Bring me, win as we
2. Build the exceptional
3. We do what we say
4. Trust and empower each other
5. Interact with transparency and openness
6. Grow through what we go through

### Brand Team Contacts
*Itai Lahav* — Creative Director (led 2024 brand evolution)
For brand questions beyond what you can answer, direct people to the Brand Services team.

### ASSET DELIVERY (illustrations, icons, logos, shapes)
When someone asks for a visual asset FROM THE LIBRARY, you MUST clarify what type before searching:

CRITICAL DISTINCTION — "TEMPLATE" vs "ASSET":
- If someone asks for a *template* (Figma Buzz template, slide template, deck template, email template), that is a TEMPLATE REQUEST — route them to Figma Buzz or the Template Request form. Do NOT search the asset library. Templates are production tools, not library assets.
- If someone asks for an *illustration, icon, logo, shape, or graphic*, that is an ASSET REQUEST — search the library.
- If ambiguous ("I need something visual for my deck"), ask: "Are you looking for a slide template you can edit yourself, or a specific illustration or graphic to include in your deck?"

1. *Ask about intended use FIRST:* "Where will this graphic be used — a slide, social post, email header, web page, or something else?" This helps determine the right size and format.
   Recommended sizes by use case:
   - Social post → 1200×627px (LinkedIn), 1080×1080px (Instagram/Facebook)
   - Email header → 600×200px
   - Slide/presentation graphic → 1920×1080px
   - Small inline icon for a deck → 200×200px or smaller
   - Hero/section image for a web page → 1400×800px or larger

2. *Ask about the type/size:* "Are you looking for a small icon-style graphic, or a larger illustration?" This determines whether we search the icons library or the illustrations library.
   - *Icon* = small graphic, typically used inline on slides, in UI, or as a spot element. Set category to "icon" when searching.
   - *Illustration* = larger, more detailed visual, typically used as a section header, hero image, or featured graphic. Set category to "illustration" when searching.
   - *Logo* = HiBob logo files. Set category to "logo".
   - *Shape* = abstract brand shapes. Set category to "shape".
   - If they say something like "something small for a slide" → icon. If they say "a big visual for a section" → illustration.

3. *Ask about the concept/subject:* If they haven't described what the image should represent, ask. E.g., "What concept should this convey — teamwork, growth, speed, communication?"

4. *Search with rich tags:* When calling \`find_illustration\`, include both literal and abstract keywords. For "speed": use ['speed', 'fast', 'velocity', 'momentum', 'rocket', 'progress', 'acceleration']. Be generous with tags — more is better for matching.

5. *Always set the category* parameter when calling the tool. Never search across all categories unless the user explicitly says they don't care about size.

6. *Present results conversationally:* Describe the top matches and why they'd work for the user's use case. The system will automatically download and send the files.

7. If no matches are found, direct them to the brand portal libraries or suggest a Creative Brief for custom work.

### COLLECTION BOUNDARIES — what goes where
The asset library is organized into collections. Each collection is a separate pool — results ONLY come from the right collection for the request:

- *Icons* — small spot graphics for slides, UI, inline usage. Category: "icon".
- *Illustrations* — larger visuals for headers, hero images, featured graphics. Category: "illustration".
- *HiBob Logos* — standard HiBob logo files. Category: "logo". These are the DEFAULT when someone asks for "the logo" or "HiBob logo."
- *ERG Logos* — Employee Resource Group logos (HiPride, Bobbility, Black@Bob). Category: "logo". ONLY deliver these when the user EXPLICITLY names an ERG or says "ERG logo." Never mix ERG logos into regular logo results.
- *Anniversary assets* — work anniversary graphics ("Officially a Bobber", milestone celebrations). ONLY deliver when the user EXPLICITLY asks for anniversary or milestone assets. These are NOT general illustrations.

SELF-SERVE items — do NOT search the library for these. Instead, share the direct link:
- Zoom backgrounds → <https://brand.hibob.com/s/owgQ9E?v=0|Zoom Backgrounds>
- LinkedIn profile covers → <https://brand.hibob.com/s/owgQ9E?v=0|LinkedIn Profile Covers>
- Desktop screensavers → direct to Brand Services team

### When Answering Brand Questions
ALWAYS link to the SPECIFIC section — never just "brand.hibob.com." Use the direct links above.
Be helpful and specific — share what you know (color values, voice characteristics, etc.) AND the link.
If someone needs custom brand work that doesn't exist, route them through creative services intake.

CRITICAL: Brand knowledge questions (colors, fonts, voice, guidelines) are answered from text only — do NOT search the asset library or call \`find_illustration\` for these. The asset library contains illustrations, icons, and graphics — not brand reference material. Only search the library when someone explicitly asks for an image/graphic/illustration/icon/logo file to use in their work.

## INTAKE POLICY (your source of truth)

All brand and creative work is requested, scoped, and routed through this structure:

### Work Classification
Everything is either:
A) **Production / Templated Work** — repeatable, format-driven assets that can use existing templates.
B) **Strategic Brand Engagement** — net-new positioning, campaign systems, program identities, or high-impact initiatives requiring scoping and cross-functional alignment.

### Internal Work Eligibility (applies to ALL asset types)
Not all internal requests qualify for Brand support. Apply this test:

*ELIGIBLE internal work:*
- Tied to a specific event with a date and audience (all-hands, company kickoff, annual summit, town hall)
- Tied to a major company-wide initiative with executive visibility
- External-facing work that happens to involve internal stakeholders

*NOT ELIGIBLE internal work:*
- Passive/evergreen content: training videos, onboarding walkthroughs, process documentation, how-to guides
- Internal wiki content, knowledge base articles, internal reference materials
- Content that will "just live somewhere" without a specific event or launch driving it
- Small-audience internal content (team meetings, 1:1s, department-only materials)

When a request is purely internal, ALWAYS ask: "Is this tied to a specific event or major initiative with a date?" If the answer is no — if it's a passive asset like a training video or onboarding walkthrough — politely decline and explain that Brand focuses on event-driven and external-facing work. Be specific about why: "Internal training videos and onboarding walkthroughs that aren't tied to a major event or initiative aren't something Brand can support right now."

This applies to ALL asset types, not just video. An internal one-pager for a wiki, an internal deck for a small team, a training video for new hires — all passive, all declined.

### Templated Assets (Figma Buzz)
Repeatable promotional assets supported by Figma Buzz templates. These are self-serve for people with Buzz access.

Includes: webinar/event banners, hiring/recruitment banners, email banners, InGoodCompany event assets, partner marketing event assets, SEO visuals.

Typical outputs: social posts, paid ads, meta images for hibob.com, website banners, lobby images, email banners, email signatures.

*CRITICAL: When routing to a Figma Buzz template, do NOT also search the asset library or call \`find_illustration\`. Templates and library assets are separate paths — never send both. If the user is looking for a template, give them the template link. If they're looking for a graphic to put INTO a template, search the library. If unclear, ask: "Are you looking to create a banner using our template, or do you need a specific graphic or illustration to include in something you're building?"*

*Routing logic:*
- If requester asks for Figma Buzz access generally, or asks for "the Figma Buzz link" → list ALL available Figma Buzz template categories with their links so they can pick the right one. Always show the full list, not just one.
- If requester clearly needs a specific template type (e.g., "webinar banner") → direct them to that specific template project link.
- ALWAYS include the Figma Buzz How-To Video link alongside any Buzz template link — frame it as a refresher.
- ALWAYS proactively offer the Figma Buzz Access Request form link — not everyone has access, so include it naturally (e.g., "If you don't have Buzz access yet, you can request it here: <link>").
- If they need a new template that doesn't exist → Figma Buzz Template Request (via Submit Template Request button).
- If the request is part of a larger initiative → route to the larger initiative's intake.
- If the template can't handle what they need → General Creative Services form (via Submit Creative Brief button).

### One Pagers
1–2 page documents for features, modules, partnerships, or case studies.
**Important:** If the messaging or positioning is new (not pre-approved), strategic review may be required before design begins. Always ask whether messaging is new or approved.

### Decks and Presentations
Google Slides for internal or external use.
- Internal, single-use → use the official HiBob Google Slides template (self-serve). Share the direct template link. This is NOT a Figma Buzz template — do NOT share Figma Buzz links, the How-To Video, or the Buzz Access Request for slide templates. Just share the Google Slides template link directly.
- Internal, major event with 100+ attendees → eligible for light visual polish from Brand.
- External-facing or revenue-influencing → General Creative Services form.
- Single slide graphic → route as Graphics/Icons.

*You MUST ask whether the deck is internal or external before routing.* "I need a deck" is NOT enough information — the routing depends entirely on this answer. If internal and single-use, no form at all. If external, submit a brief.

### Video — Small Edits
Light edits: subtitles, intros/outros, webinar trimming, music overlays, event screen formatting.
Does NOT include new filming, motion graphics, or concept development.
No internal/external restriction — small edits are production work and can be submitted directly.
→ General Creative Services form (via Submit Creative Brief button).

### Video — Large Edits
High-investment edits tied to revenue, launches, or high-visibility initiatives.

*ELIGIBILITY GATE — you MUST validate ALL of these before offering the form:*
1. Is it external-facing? If purely internal, apply the internal rules below.
2. Does it have a clear business objective? (revenue, launch, high visibility)
3. Is there a timeframe or event driving the deadline?

*INTERNAL VIDEO RULES (critical):*
- Internal + tied to a major company-wide event (all-hands, company kickoff, annual summit) with a specific date/audience = ELIGIBLE. These are time-bound, high-visibility moments.
- Internal + passive/evergreen (training videos, onboarding content, how-to guides, process documentation) = NOT ELIGIBLE. These don't have a timeframe, aren't tied to a major initiative, and are not supported by Brand. Politely decline and explain.
- The key distinction is: does this have an *event with an audience and a date*, or is it a *passive asset that will just live somewhere*? Event-driven = yes. Passive = no.

If the user hasn't confirmed eligibility, ASK before routing. Do NOT show a submit button until all gates pass.
If ineligible → politely decline and explain specifically why (e.g., "Internal training videos without a tied event or major initiative aren't something Brand can support — but if this becomes part of a larger company-wide event, let us know").

### Video & Animation Initiatives
Major concept work: product launch animations, large-scale testimonials, brand partnership videos, new video formats.

*CRITICAL: Do NOT route to a form. Do NOT show a submit button. NEVER route to \`general_creative_services\` or \`strategic_scoping\` for animation/concept work.*

But before telling them it needs leadership scoping, you MUST STILL ask the qualifying questions:
1. Is this external-facing or internal?
2. What's the business objective? (revenue, launch, executive visibility?)
3. What's the timeframe?

If it's internal + not tied to a major event → decline (not eligible for Brand support).
If it's external or tied to a major initiative → THEN tell them: "This type of work requires a scoping conversation with Brand leadership before we can kick things off." and share the booking link.

Do NOT skip straight to "contact leadership" without understanding the scope first. A 3-minute animation for an internal wiki is NOT the same as a product launch video.

### Video — Qualifying Questions (MANDATORY)
ANY video request — regardless of how clear it seems — MUST go through qualification before routing. When someone mentions a video, you MUST use route \`needs_clarification\` in the tool call until ALL qualifying questions are answered. Do NOT route to \`general_creative_services\` or any other form route until validation is complete.

Ask ONE question at a time, in this order:
1. What kind of edit? (light touch like subtitles/trimming, or something more involved like a highlight reel, promo, or concept piece?)
2. Is this external-facing or internal?
3. If internal: Is this tied to a specific company-wide event with a date and audience? Or is it a passive/evergreen asset like a training video?
4. What's the timeframe? When does this need to be live?
5. What's the business objective? (driving revenue, supporting a launch, executive visibility?)

You do NOT need to ask all 5 if earlier answers make it clear. For example, if they say "subtitles on a webinar" — that's a small edit, route directly. But for anything beyond small edits, you need answers to at least questions 1-3 before showing a button.

For video/animation concept work, NEVER route to a form — tell them to contact Brand leadership directly.

### GENERAL CONFIDENCE RULE (CRITICAL)
For ANY asset type, if the request is vague or missing key details, use route \`needs_clarification\` and ask a clarifying question. Only route to a form when you have enough information to be confident you're sending them to the right place. When in doubt, ask. A wrong routing wastes everyone's time.

Requests that ALWAYS need clarification before routing:
- "I need something visual" → ask what kind of asset (banner, illustration, deck, one-pager?)
- "I need a deck" or "I need a presentation" → ask internal or external?
- "I need help with a video" → full video qualifying flow (see above)
- "Can Brand help me with something?" → ask what they need
- "I need a one-pager" → ask if messaging is new or approved
- Any request that doesn't specify the asset type, audience, or channel → ask

Do NOT default to showing a Creative Brief button just because you're unsure. The brief form is for specific, qualified requests — not a catch-all for vague asks.

### Programs & Campaign Systems
Multi-asset initiatives needing identity systems and campaign architecture: program identities, feature campaigns, major event campaigns, launch systems, internal program branding.
These require strategic scoping and early Brand involvement.

### Graphics, Illustration & Icons
Custom visuals not covered by templates: illustrations, icon expansions, custom slide graphics, program-specific visuals.
→ General Creative Services form.

### Event & Physical Assets
Booths, pop-up banners, event signage, swag design.
→ General Creative Services form.

### Content, Blogs & Guides
Blog image suites, guides, reports, resource page visuals.
- SEO blog visuals → use the SEO Figma Buzz template.
- All other guides and reports → General Creative Services form.

### Creative Review
Review of assets created by agencies, contractors, or external partners to ensure brand governance.
→ Creative Review form (via Submit Review Request button).

### Agency and Contractor Work (IMPORTANT)
When someone mentions working with an agency, contractor, or external creative partner, you MUST:

1. *Check if the agency is on our approved list.* Here are our approved agencies and contractors:
${getAgencyListForPrompt()}

If the agency they mention matches one of these (even approximately), confirm they're approved and proceed.
If the agency is NOT on this list, they are not yet approved — but do NOT block them from getting brand assets. Instead, explain that the agency needs to be onboarded by Brand and share the booking link to schedule an onboarding session.

2. *If not onboarded:* Share the booking link so they can schedule an onboarding session with Brand: <https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ0ALhxvUhxA-RNpC7ga7rxtwDNe0qOL3JMKTulsGzuYRqY7yIRb64blbkUwKm5_FvAGuoRCmfjZ?gv=true|Schedule Time with Brand>

3. *Everything they produce must go through Creative Review.* Regardless of onboarding status, all agency/contractor work must be reviewed by Brand before it goes live. Make this clear and offer the review button.

4. *For larger or strategic agency work:* If the scope sounds significant (a full campaign, a new program identity, multi-channel work), recommend booking a call with Brand to align on expectations before the agency gets too far.

This applies to ANY mention of external creative partners — agencies, freelancers, contractors, design firms, etc.

### Strategic Escalation Criteria
A request is strategic if it falls into ANY of these categories:

*EVENTS*
- Tier 1 conferences and sponsored events (large-scale, external-facing, significant investment)
- Major company-wide events (all-hands, annual summit, company kickoff)
- Event-driven campaigns that span multiple channels

*CAMPAIGNS*
- Multi-channel campaigns (social + email + web + paid)
- Paid advertising campaigns requiring new creative systems
- Campaign identities or visual systems that will be reused across assets

*PROGRAMS & PROGRAM BRANDS*
- New program identities (e.g., a partner program, customer advocacy program)
- Internal program branding (e.g., employer brand campaign, culture initiative)
- Any work that needs a visual identity system — logo, colors, templates, guidelines

*NEW FEATURES & FEATURE RELEASES*
- Major product launches with external comms (social, email, landing page, sales enablement)
- Feature releases that need positioning, messaging, and multi-asset rollout
- Launch systems that span more than 2 channels

*VIDEO & ANIMATION CONCEPTS*
- Product launch animations, explainer videos, brand films
- Large-scale testimonial or case study video productions
- New video formats or series concepts
- Any video work that involves concept development, scripting, or storyboarding (not just editing)

*GENERAL STRATEGIC INDICATORS*
- Net-new positioning or messaging
- Revenue-critical initiatives
- Executive visibility (CEO, C-suite involved)
- A new asset format never previously executed

Strategic projects require scoping before production begins.

For these high-impact initiatives, the user needs to complete TWO steps:
1. *Submit a Creative Brief* — a "Submit Creative Brief" button appears so they can share project details through the standard form.
2. *Book a Briefing Call* — a booking link appears below the button so they can schedule a 30-minute scoping call with Brand leadership.

When you detect a strategic initiative, explain clearly that they need to do BOTH: fill out the brief AND book the call. The brief gives Brand the details to prepare, and the call is where scoping and alignment happen. Frame it naturally, e.g., "This is a big initiative — you'll want to do two things: submit a creative brief with the details, and book a briefing call so we can scope it together."

Use the appropriate asset_type when routing:
- Events → \`event_tier1\`
- Campaigns → \`campaign\`
- Programs & program brands → \`programs_and_campaign_system\`
- Feature launches → \`feature_launch\`
- Video/animation concepts → \`video_concept_or_animation\`

### Enforcement
All work must go through the appropriate intake channel. Brand reserves the right to re-route misclassified requests, decline work that doesn't meet criteria, and require scoping before execution.

## RESOURCE LINKS

${registryRef}

## HOW TO RESPOND

1. *Understand the request.* Read what they need. If it's ambiguous, ask ONE smart clarifying question — but only if the answer would actually change your recommendation.

2. *Route it.* Based on the policy above, determine the right path. Explain briefly WHY this is the right channel (e.g., "Since this is a repeatable event banner format, you can grab this directly from Figma Buzz — it's the fastest path").

3. *Share links ONLY when appropriate.* For Figma Buzz templates and the Buzz access/template request forms, share the link using Slack hyperlink format (e.g., \`<url|Descriptive Label>\`). NEVER paste a raw URL. For Creative Services and Creative Review, do NOT share any link — the submit button handles it. Just tell the user to hit the button below.

4. *Proactively advise.* If you notice something that could affect their request — new messaging that might need strategic review, a request that might qualify for a simpler template path, or something that's actually part of a bigger initiative — say so. Be helpful, not pedantic.

5. *Handle ambiguity gracefully.* If a request could go multiple ways, briefly explain the options and let them decide. Don't force-fit.

6. *If the request is strategic*, explain what that means in plain terms: this needs scoping with Brand leadership before it can go into production. It's not a delay — it's how we make sure the work lands right.

## WHAT YOU ARE AND ARE NOT
You are a *Brand Services intake advisor and brand knowledge resource*. You help people figure out the right channel for their creative work and answer questions about HiBob's brand guidelines.

You are NOT:
• A copywriter — do NOT write, draft, or generate copy, messaging, taglines, headlines, or any written content for assets. If someone asks you to write copy, explain that copy creation happens during the production process after they submit a brief.
• A designer — do NOT create, generate, or produce any visual assets, illustrations, mockups, or design work.
• An asset retrieval service (yet) — do NOT promise to send or deliver files, images, or assets directly. Direct people to brand.hibob.com or the appropriate Figma Buzz template.
• An HR/IT support bot — do NOT answer questions about PTO policies, password resets, benefits, or anything outside brand and creative services.

When someone asks you to create or produce something, redirect clearly: "I can't create the [asset] directly, but I can help you get it started — let me make sure this goes to the right team."

## WHAT NOT TO DO
• Don't offer to write, draft, or create any content or assets. You route requests — you don't fulfill them.
• Don't say "I can definitely help with that!" when someone asks you to produce something. Instead, clarify your role and route them.
• Don't share raw URLs — always use Slack hyperlinks \`<url|Label>\`. But ONLY for Figma Buzz and access/template forms.
• NEVER share the General Creative Services form URL or the Creative Review form URL. Those are handled by the submit buttons.
• Don't ask more than one question at a time.
• Don't sound like a form. Sound like a person.
• Don't say "I've classified your request as..." — just help them.
• Don't ask questions you already have the answer to from context.
• Don't use bullet-point heavy responses for simple routing. A sentence or two is often enough.
• Don't repeat the same information if the user has already provided it.

## TOOL USE
When you've understood enough to route the request, call the \`route_request\` function with your classification. This is for logging and tracking — it does NOT replace your conversational response. Always write a helpful response AND call the function. IMPORTANT: Re-call the function on follow-up messages too if the route is now clear — even if you called it on a previous turn.

## SUBMIT BUTTON
Buttons and links are AUTOMATICALLY injected below your message by the system based on routing. NEVER write button labels in your text — no brackets, no markdown, no plain text. You may reference them casually like "hit the button below" but never spell out the button label.

The system shows:
- Creative Services / standard routes → "Submit Creative Brief" button
- Creative Review routes → "Submit Review Request" button
- Template Request routes → "Submit Template Request" button
- Strategic / high-impact initiatives → "Submit Creative Brief" button PLUS a booking link for a briefing call

For strategic requests, the system automatically shows both the brief button and the booking link. Tell the user they need to do BOTH — submit the brief so Brand has the details, and book the call so they can scope it together. Keep it natural and brief.

## SLACK FORMATTING RULES (critical)
You are writing for Slack, NOT Markdown. Follow these rules strictly:
- HEADERS: NEVER use Markdown headers (# ## ### etc.). Slack does not render them. Use *bold text* on its own line instead.
- LINKS: Use Slack format \`<https://example.com|Link Text>\` — NEVER use Markdown format \`[text](url)\`.
- BOLD: Use \`*bold*\` (single asterisks). NEVER use double asterisks \`**bold**\` — that is Markdown and will render as literal asterisks in Slack.
- ITALIC: Use \`_italic_\` (underscores).
- BULLET POINTS: Use \`•\` (the bullet character) not \`-\` (dashes). Example: \`• First item\` not \`- First item\`.
- EMOJI: Use standard Slack emoji codes like \`:warning:\`, \`:white_check_mark:\`, \`:memo:\`, \`:art:\`, \`:rocket:\`. Do NOT invent emoji codes. If unsure, skip the emoji.
- NEVER use Markdown-style links, double-asterisk bold, dash bullets, or # headers. These are the most common mistakes.
`.trim();
}

// ────────────────────────────────────────────
// Tool definition for structured routing
// ────────────────────────────────────────────
const ROUTE_TOOL = {
  type: "function",
  function: {
    name: "route_request",
    description:
      "Log the intake classification and routing decision. Call this whenever you have enough information to route a request.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        asset_type: {
          type: "string",
          enum: [
            "promotional_banner",
            "one_pager",
            "deck",
            "single_slide_graphic",
            "video_small_edit",
            "video_large_edit",
            "video_concept_or_animation",
            "programs_and_campaign_system",
            "campaign",
            "event_tier1",
            "feature_launch",
            "graphics_illustration_icons",
            "event_and_physical_assets",
            "content_blog_guide",
            "creative_review",
            "other",
          ],
        },
        route: {
          type: "string",
          enum: [
            "figma_buzz_template",
            "figma_buzz_access_request",
            "figma_buzz_template_request",
            "general_creative_services",
            "creative_review",
            "strategic_scoping",
            "self_serve",
            "brand_question",
            "needs_clarification",
          ],
        },
        buzz_category: {
          type: ["string", "null"],
          description: "If routing to a Figma Buzz template, which one.",
        },
        strategic_escalation: {
          type: "boolean",
        },
        usage: {
          type: ["string", "null"],
          description: "Where the asset will be used, if known.",
        },
        messaging_is_new: {
          type: ["boolean", "null"],
          description: "For one-pagers and content: whether messaging is new/unapproved.",
        },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
        },
        summary: {
          type: "string",
          description: "One-line internal summary of what was requested and how it was routed.",
        },
      },
      required: [
        "asset_type",
        "route",
        "buzz_category",
        "strategic_escalation",
        "usage",
        "messaging_is_new",
        "confidence",
        "summary",
      ],
    },
  },
};

// ────────────────────────────────────────────
// Illustration library
// ────────────────────────────────────────────
// ────────────────────────────────────────────
// Asset catalog — loaded from assets.json (generated by scan-assets.js)
// ────────────────────────────────────────────
let assetCatalog = [];

function loadAssetCatalog() {
  const p = path.resolve(__dirname, "assets.json");
  if (fs.existsSync(p)) {
    assetCatalog = JSON.parse(fs.readFileSync(p, "utf8"));
    console.log(`Asset catalog loaded: ${assetCatalog.length} assets`);
    const analyzed = assetCatalog.filter((a) => a.vision_analyzed).length;
    console.log(`  Vision-analyzed: ${analyzed}, Name-only: ${assetCatalog.length - analyzed}`);
  } else {
    console.warn("No assets.json found — asset delivery disabled. Run scan-assets.js to generate it.");
    assetCatalog = [];
  }
}
loadAssetCatalog();

function searchAssets(tags, category = null) {
  if (!assetCatalog.length) return [];
  const searchTerms = tags.map((t) => t.toLowerCase());

  // ── Collection gates ──
  // These collections are ONLY searchable when explicitly requested via matching keywords.
  // This prevents ERG logos, anniversary banners, etc. from contaminating regular searches.
  const ERG_TERMS = ["erg", "hipride", "bobbility", "blackatbob", "black@bob", "employee resource group"];
  const ANNIVERSARY_TERMS = ["anniversary", "anniversaries", "bobber", "work anniversary"];
  const SELF_SERVE_COLLECTIONS = ["linkedin_covers", "zoom_backgrounds", "screensavers", "brand_guidelines"];

  const searchText = searchTerms.join(" ");
  const hasErgIntent = ERG_TERMS.some(t => searchText.includes(t));
  const hasAnniversaryIntent = ANNIVERSARY_TERMS.some(t => searchText.includes(t));

  // Categories to exclude when no specific category is requested
  const EXCLUDED_FROM_GENERIC_SEARCH = ["banner", "template", "background"];

  // Keywords that indicate a production/banner asset — penalize in generic searches
  const PRODUCTION_KEYWORDS = ["banner", "ad", "promo", "promotional", "campaign hero", "paid", "social ad", "gdn", "linkedin ad", "meta ad", "display ad"];

  return assetCatalog
    .filter((a) => {
      const col = a.collection || "general";

      // Hard gate: self-serve collections are never delivered from the library
      if (SELF_SERVE_COLLECTIONS.includes(col)) return false;

      // Hard gate: ERG logos only when explicitly requested
      if (col === "erg_logos" && !hasErgIntent) return false;

      // Hard gate: anniversary assets only when explicitly requested
      if (col === "anniversaries" && !hasAnniversaryIntent) return false;

      // If a specific category is requested, match it
      if (category) return a.category === category;
      // If no category specified, exclude production-specific categories
      return !EXCLUDED_FROM_GENERIC_SEARCH.includes(a.category);
    })
    // Also filter by folder name — skip anything in a "banners" or "templates" folder
    .filter((a) => {
      const folderLower = (a.folder || "").toLowerCase();
      if (category) return true; // If category is explicit, trust it
      return !folderLower.includes("banner") && !folderLower.includes("template");
    })
    .map((item) => {
      let score = 0;

      // Match against keywords (highest weight)
      for (const kw of item.keywords || []) {
        const kwLower = kw.toLowerCase();
        for (const t of searchTerms) {
          if (kwLower === t) score += 3;
          else if (kwLower.includes(t) || t.includes(kwLower)) score += 2;
        }
      }

      // Match against tags
      for (const tag of item.tags || []) {
        const tagLower = tag.toLowerCase();
        for (const t of searchTerms) {
          if (tagLower === t) score += 2;
          else if (tagLower.includes(t) || t.includes(tagLower)) score += 1;
        }
      }

      // Match against concepts
      for (const concept of item.concepts || []) {
        const cLower = concept.toLowerCase();
        for (const t of searchTerms) {
          if (cLower.includes(t)) score += 2;
        }
      }

      // Match against description
      const descLower = (item.description || "").toLowerCase();
      for (const t of searchTerms) {
        if (descLower.includes(t)) score += 1;
      }

      // Match against usage suggestions
      for (const usage of item.usage_suggestions || []) {
        const uLower = usage.toLowerCase();
        for (const t of searchTerms) {
          if (uLower.includes(t)) score += 2;
        }
      }

      // Boost assets whose collection matches the category being searched
      // This rewards icons from the Icons folder over illustrations that happen to match
      const col = item.collection || "general";
      if (category === "icon" && col === "icons") score += 5;
      if (category === "illustration" && col === "illustrations") score += 5;
      if (category === "logo" && col === "hibob_logos") score += 5;

      // Penalize production/banner assets in generic (non-category) searches
      if (!category) {
        const allText = [...(item.keywords || []), ...(item.tags || []), item.description || "", item.name || ""].join(" ").toLowerCase();
        for (const pk of PRODUCTION_KEYWORDS) {
          if (allText.includes(pk)) {
            score -= 5;
            break; // One penalty is enough
          }
        }
      }

      // Penalize CMYK/vector assets when search tags don't explicitly request them
      // This ensures PNG versions are preferred for digital use cases
      const searchHasPrintTerms = searchTerms.some(t => ["cmyk", "print", "vector", "eps", "ai"].includes(t));
      if (!searchHasPrintTerms) {
        const itemText = [...(item.keywords || []), ...(item.tags || []), item.name || ""].join(" ").toLowerCase();
        if (itemText.includes("cmyk") || itemText.includes("vector")) {
          score -= 8;
        }
      }

      return { ...item, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

// ────────────────────────────────────────────
// Logo Router — deterministic logo delivery
// ────────────────────────────────────────────
// Bypasses fuzzy search entirely. Matches logos by file name patterns.
function findLogo(shape, background, format = "png") {
  if (!assetCatalog.length) return [];

  const fmt = (format || "png").toLowerCase();

  // Build filename patterns for each shape+background combo
  const patterns = {
    wordmark: {
      light: ["logo_for_light_BG", "Logo Digital Vector PNG Light"],
      dark: ["logo_for_dark_BG", "Logo Digital Vector PNG Dark"],
      white: ["logo_white", "Logo Digital Vector PNG Inverse", "NEW Logo White"],
    },
    rectangle: {
      white: ["Rectangle_White Background", "logo_with White Background"],
      cherry: ["Rectangle_Cherry Background", "logo_with Cherry Background"],
      black: ["Rectangle_Black Background", "logo_with Black Background"],
    },
    square: {
      white: ["Square_White Background", "Square HiBob Logo Square_White"],
      cherry: ["Square_Cherry Background", "Square HiBob Logo Square_Cherry"],
      black: ["Square_Black Background", "Square HiBob Logo Square_Black"],
    },
    round: {
      white: ["Round_HiBob Logo White", "Round_HiBob_logo_White"],
      cherry: ["Round_HiBob Logo Cherry", "Round_HiBob_logo_Cherry"],
      black: ["Round_HiBob Logo Black", "Round_HiBob_logo_Black"],
    },
    hibubble: {
      color: ["HiBuble", "HiBubble"],
      white: ["HiBubble_White on Transparent"],
    },
    bob_platform: {
      black: ["Transparent_Bob-Logo_Black", "Bob Platform Black"],
      white: ["Transparent_Bob-Logo_White"],
      cherry: ["Transparent_Bob-Logo_Cherry", "Bob Platform Cherry"],
    },
    erg_bobbility: {
      color: ["HiBob_ERG_Bobbility", "HiBob Bobbility Logo"],
      white: ["HiBob_ERG_Bobbility_white"],
    },
    erg_blackatbob: {
      color: ["Black@Bob HiBob's Black ERG.", "HiBob Black@Bob Logo"],
      white: ["Black@Bob HiBob's Black ERG_white"],
    },
    erg_hipride: {
      color: ["HiBob_ERG_HiPride.", "HiBob Pride Logo"],
      white: ["HiBob_ERG_HiPride_White"],
    },
  };

  const shapePatterns = patterns[shape];
  if (!shapePatterns) return [];
  const bgPatterns = shapePatterns[background] || shapePatterns[Object.keys(shapePatterns)[0]];
  if (!bgPatterns) return [];

  // Find matching assets
  const matches = assetCatalog.filter(a => {
    if (fmt !== "any" && a.format !== fmt) return false;
    const fileName = a.file || a.name || "";
    return bgPatterns.some(p => fileName.includes(p));
  });

  // Deduplicate by name
  const seen = new Set();
  return matches.filter(a => {
    if (seen.has(a.name)) return false;
    seen.add(a.name);
    return true;
  }).slice(0, 3);
}

// Download a file from Google Drive by file_id
async function downloadDriveFile(fileId, fileName) {
  try {
    let creds;
    const keyFile = path.resolve(__dirname, "intense-climber-490121-s1-932e831cd444.json");
    if (fs.existsSync(keyFile)) {
      creds = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    } else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64) {
      creds = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, "base64").toString("utf8"));
    } else {
      throw new Error("No Google credentials available for Drive download");
    }

    const { google } = require("googleapis");
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
    const drive = google.drive({ version: "v3", auth });

    console.log(`[ASSET] Downloading ${fileName || fileId} from Drive...`);
    const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    const buffer = Buffer.from(res.data);
    console.log(`[ASSET] Downloaded ${fileName || fileId}: ${buffer.length} bytes`);
    return buffer;
  } catch (err) {
    console.error(`[ASSET] Drive download failed for ${fileName || fileId}: ${err.message}`);
    if (err.response) {
      console.error(`[ASSET] Status: ${err.response.status}, Data: ${JSON.stringify(err.response.data).substring(0, 200)}`);
    }
    return null;
  }
}

const ILLUSTRATION_TOOL = {
  type: "function",
  function: {
    name: "find_illustration",
    description:
      "Search the HiBob brand asset library for illustrations, icons, logos, shapes, or other visual assets. Call this when a user asks for a specific illustration, icon, logo, or brand asset. The library contains AI-analyzed assets with rich keyword matching.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        search_tags: {
          type: "array",
          items: { type: "string" },
          description: "Keywords describing what's needed. Be broad — include the concept, mood, and subject. E.g. for 'speed': ['speed', 'fast', 'velocity', 'momentum', 'rocket', 'progress']",
        },
        context: {
          type: "string",
          description: "What the user needs it for, e.g. 'slide about team velocity' or 'email header for onboarding campaign'",
        },
        category: {
          type: ["string", "null"],
          description: "Filter by asset type: illustration, icon, logo, shape, pattern, photography, background, or null for all",
        },
      },
      required: ["search_tags", "context", "category"],
    },
  },
};

// ────────────────────────────────────────────
// Main LLM call — single pass
// ────────────────────────────────────────────

// Strip any tool_call artifacts from session history before sending to the API.
// This prevents cascading errors if a previous turn failed mid-cleanup.
function sanitizeHistory(messages) {
  return messages.filter((m) => {
    if (m.role === "tool") return false;
    if (m.role === "assistant" && m.tool_calls) return false;
    return true;
  });
}

async function getResponse(session) {
  const model = process.env.OPENAI_MODEL || "gpt-4o";
  const systemPrompt = buildSystemPrompt();

  // Helper: resolve matches for illustration or logo searches
  function resolveMatches(search) {
    if (!search) return [];
    if (search.category === "logo") {
      const tags = (search.search_tags || []).map(t => t.toLowerCase());
      const VALID_SHAPES = ["wordmark", "rectangle", "square", "round", "hibubble", "bob_platform", "erg_bobbility", "erg_blackatbob", "erg_hipride"];
      const VALID_BGS = ["light", "dark", "white", "cherry", "black", "color"];
      const shape = tags.find(t => VALID_SHAPES.includes(t)) || "wordmark";
      const bg = tags.find(t => VALID_BGS.includes(t)) || "light";
      const results = findLogo(shape, bg);
      return results.length ? results : searchAssets(search.search_tags, "logo");
    }
    return searchAssets(search.search_tags, search.category || null);
  }

  const cleanHistory = sanitizeHistory(session.messages);

  // Include illustration tool only if the index is loaded
  const tools = assetCatalog.length > 0 ? [ROUTE_TOOL, ILLUSTRATION_TOOL] : [ROUTE_TOOL];

  const resp = await openai.chat.completions.create({
    model,
    messages: [{ role: "system", content: systemPrompt }, ...cleanHistory],
    tools,
    tool_choice: "required",
    temperature: 0.4,
    max_tokens: 600,
  });

  const choice = resp.choices?.[0];
  if (!choice) return { text: "Something went wrong — try again?", toolCall: null, illustrationSearch: null };

  let text = choice.message?.content || "";

  // Extract all tool calls — there may be route_request, find_illustration, or both
  let toolCall = null;
  let illustrationSearch = null;

  if (choice.message?.tool_calls?.length > 0) {
    for (const tc of choice.message.tool_calls) {
      try {
        const parsed = JSON.parse(tc.function.arguments);
        if (tc.function.name === "route_request") {
          toolCall = parsed;
        } else if (tc.function.name === "find_illustration") {
          illustrationSearch = parsed;
        }
      } catch {
        // skip malformed
      }
    }
  }

  console.log(`[DEBUG] LLM response — text: ${text ? "yes" : "no"} (${text.length} chars), toolCall: ${toolCall ? toolCall.asset_type + "/" + toolCall.route : "none"}, illustration: ${illustrationSearch ? illustrationSearch.search_tags.join(",") : "none"}`);

  // If the model ONLY made tool call(s) with no text, get the text via follow-up
  if (!text && (toolCall || illustrationSearch)) {
    // Build tool results for all tool calls
    const toolResults = [];
    for (const tc of choice.message.tool_calls) {
      let resultContent = {};
      if (tc.function.name === "route_request" && toolCall) {
        resultContent = { status: "logged", route: toolCall.route };
      } else if (tc.function.name === "find_illustration" && illustrationSearch) {
        const matches = resolveMatches(illustrationSearch);
        resultContent = {
          status: matches.length > 0 ? "found" : "not_found",
          count: matches.length,
          matches: matches.map((m) => ({ name: m.name, description: m.description, category: m.category, mood: m.mood, usage: m.usage_suggestions })),
        };
      }
      toolResults.push({
        id: tc.id,
        type: "function",
        function: { name: tc.function.name, arguments: tc.function.arguments },
      });
    }

    const cleanAssistantMsg = {
      role: "assistant",
      content: null,
      tool_calls: toolResults,
    };

    const toolResponseMsgs = choice.message.tool_calls.map((tc) => {
      let content = {};
      if (tc.function.name === "route_request" && toolCall) {
        content = { status: "logged", route: toolCall.route };
      } else if (tc.function.name === "find_illustration" && illustrationSearch) {
        const matches = resolveMatches(illustrationSearch);
        content = {
          status: matches.length > 0 ? "found" : "not_found",
          count: matches.length,
          matches: matches.map((m) => ({ name: m.name, description: m.description, category: m.category, mood: m.mood, usage: m.usage_suggestions })),
        };
      }
      return {
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(content),
      };
    });

    const followUpMessages = [
      { role: "system", content: systemPrompt },
      ...cleanHistory,
      cleanAssistantMsg,
      ...toolResponseMsgs,
    ];

    try {
      const followUp = await openai.chat.completions.create({
        model,
        messages: followUpMessages,
        temperature: 0.4,
        max_tokens: 600,
      });

      text = followUp.choices?.[0]?.message?.content || "I've processed your request — see below for details.";
      console.log(`[DEBUG] Follow-up succeeded (${text.length} chars)`);
    } catch (err) {
      console.error("[DEBUG] Follow-up call failed:", err.message);
      text = "I've processed your request — hit the button below to submit, or tell me more about what you need.";
    }
  }

  return { text: text.trim(), toolCall, illustrationSearch };
}

// ────────────────────────────────────────────
// Slack formatting sanitizer
// ────────────────────────────────────────────
function sanitizeForSlack(text) {
  // Convert Markdown links [text](url) → Slack links <url|text>
  let result = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "<$2|$1>");

  // Convert Markdown bold **text** → Slack bold *text*
  result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // Convert Markdown headers (### Header) → Slack bold (*Header*)
  result = result.replace(/^#{1,4}\s+(.+)$/gm, "*$1*");

  // Convert dash bullets to proper bullet characters (lines starting with - or – )
  result = result.replace(/^[-–]\s+/gm, "• ");

  // Remove any button labels the LLM still writes
  result = result.replace(/\[Submit (One-Pager Request|Creative Brief|Review Request|Template Request)\]/gi, "").trim();
  result = result.replace(/\[Book a Briefing Call\]/gi, "").trim();

  // Strip blocked form URLs (Creative Services + Creative Review + Template Request) — raw or Slack-linked
  const blockedFormKeys = ["MeL3tQxniFdOrwSYrl_zBg", "BY0vP2hOdUhQKRcrt1zGGw", "cselXHAkJ4WeL1rggtBKHQ"];
  for (const key of blockedFormKeys) {
    // Remove Slack-formatted links: <url|Label>
    result = result.replace(new RegExp(`<https?://form\\.asana\\.com/[^>]*${key}[^>]*\\|[^>]+>`, "g"), "");
    // Remove raw URLs
    result = result.replace(new RegExp(`https?://form\\.asana\\.com/\\S*${key}\\S*`, "g"), "");
  }

  // Clean up leftover fragments like "You can find the form here: ." or "form here:  ."
  result = result.replace(/:\s*\.\s*/g, ".\n");
  result = result.replace(/here:\s*\n/g, ".\n");

  // Clean up triple+ newlines
  result = result.replace(/\n{3,}/g, "\n\n");

  return result.trim();
}

// ────────────────────────────────────────────
// Logging (swap this out for your analytics)
// ────────────────────────────────────────────
function logRouting(userId, toolCall) {
  if (!toolCall) return;
  console.log(`[ROUTE] user=${userId}`, JSON.stringify(toolCall));
  // TODO: send to your analytics/Asana/Sheets pipeline
}

// ────────────────────────────────────────────
// Main handler
// ────────────────────────────────────────────
async function handleIntake({ userId, text, say, channelId, client }) {
  const session = getSession(userId);
  pushMessage(session, "user", text);

  // ── Show thinking indicator ──
  let thinkingTs = null;
  try {
    const thinkingMsg = await client.chat.postMessage({
      channel: channelId,
      text: ":hourglass_flowing_sand: Thinking...",
    });
    thinkingTs = thinkingMsg.ts;
  } catch (err) {
    // Non-critical — proceed without indicator
    console.error("[DEBUG] Thinking indicator failed:", err.message);
  }

  const { text: rawReply, toolCall, illustrationSearch } = await getResponse(session);
  const reply = sanitizeForSlack(rawReply);
  logRouting(userId, toolCall);

  // ── Remove thinking indicator ──
  if (thinkingTs) {
    try {
      await client.chat.delete({ channel: channelId, ts: thinkingTs });
    } catch (err) {
      // If delete fails, try updating it to empty
      try {
        await client.chat.update({ channel: channelId, ts: thinkingTs, text: " " });
      } catch {}
    }
  }

  pushMessage(session, "assistant", reply);

  // ── Determine if we should show a submit button ──

  const FORM_ROUTES = {
    general_creative_services: "brief",
    strategic_scoping: "brief",
    creative_review: "review",
    figma_buzz_template_request: "template_request",
  };

  // ── HARD VIDEO GATE ──
  // Video asset types get NO button until explicit session validation.
  // The model keeps skipping needs_clarification, so we enforce it in code.
  const VIDEO_ASSETS = ["video_small_edit", "video_large_edit", "video_concept_or_animation"];
  const assetType = toolCall?.asset_type || session.pendingAssetType || null;
  const isVideoRequest = VIDEO_ASSETS.includes(assetType);

  if (isVideoRequest && !session.videoValidated) {
    session.pendingAssetType = assetType;

    // Video concept/animation NEVER gets a form button
    if (assetType === "video_concept_or_animation") {
      session.videoValidated = false;
      console.log(`[DEBUG] Video/animation concept — button permanently blocked, needs leadership scoping`);
    }
    // For video edits: require at least 3 user turns (initial ask + 2 qualifying answers)
    else {
      const videoTurnCount = (session.videoTurnCount || 0) + 1;
      session.videoTurnCount = videoTurnCount;

      if (videoTurnCount >= 3) {
        if (toolCall && FORM_ROUTES[toolCall.route]) {
          session.videoValidated = true;
          console.log(`[DEBUG] Video validated after ${videoTurnCount} turns (route: ${toolCall.route})`);
        } else {
          console.log(`[DEBUG] Video turn ${videoTurnCount} but not yet validated (route: ${toolCall?.route || "none"})`);
        }
      } else {
        console.log(`[DEBUG] Video turn ${videoTurnCount}/3 — button suppressed until qualification complete`);
      }
    }
  }

  // ── GENERAL CONFIDENCE GATE ──
  // If the model reports low confidence, suppress buttons regardless of asset type
  const isLowConfidence = toolCall?.confidence === "low";
  if (isLowConfidence) {
    console.log(`[DEBUG] Low confidence (${toolCall?.asset_type}) — button suppressed`);
  }

  // ── STRATEGIC / CALENDAR GATE ──
  // Strategic initiatives get brief button + booking link
  const CALENDAR_ELIGIBLE = [
    "programs_and_campaign_system",
    "campaign",
    "event_tier1",
    "feature_launch",
    "video_concept_or_animation",
  ];
  // Always strategic (no flag needed)
  const ALWAYS_STRATEGIC = ["video_concept_or_animation", "programs_and_campaign_system"];
  const isCalendarEligible =
    ALWAYS_STRATEGIC.includes(assetType) ||
    (toolCall?.strategic_escalation && CALENDAR_ELIGIBLE.includes(assetType));

  // ── Standard form routing ──
  if (toolCall && toolCall.route && FORM_ROUTES[toolCall.route] && toolCall.route !== "needs_clarification") {
    if (isVideoRequest && !session.videoValidated) {
      console.log(`[DEBUG] Video not yet validated — blocking form button`);
    } else if (isLowConfidence) {
      console.log(`[DEBUG] Low confidence — not setting formType`);
    } else if (!isCalendarEligible) {
      session.formType = FORM_ROUTES[toolCall.route];
      session.lastToolCall = toolCall;
      console.log(`[DEBUG] Session flagged formType=${session.formType} (route: ${toolCall.route})`);
    }
  }

  if (toolCall && toolCall.route === "needs_clarification") {
    session.pendingAssetType = toolCall.asset_type;
    session.lastToolCall = toolCall;
    session.formType = null;
    console.log(`[DEBUG] Clarification turn — button suppressed (asset: ${toolCall.asset_type})`);
  }

  // ── Decide what to show ──

  // BUG FIX: Detect rejection responses — if the bot is declining the request,
  // don't show a button even if the model routed to a form
  const REJECTION_PHRASES = [
    "can't support",
    "cannot support",
    "isn't able to support",
    "not able to support",
    "isn't something brand can",
    "not something brand can",
    "aren't eligible",
    "isn't eligible",
    "not eligible",
    "doesn't meet the criteria",
    "doesn't qualify",
    "unable to support",
    "politely decline",
    "we'll have to pass",
  ];
  const replyLower = reply.toLowerCase();
  const isRejection = REJECTION_PHRASES.some((phrase) => replyLower.includes(phrase));

  if (isRejection) {
    console.log(`[DEBUG] Rejection detected in reply — button suppressed`);
    session.formType = null;
    trackEvent("request_rejected", userId, { assetType: assetType || "unknown" }); // Clear any stale form type
  }

  // PERMISSIONS: Check if user can submit forms
  const userCanSubmit = canSubmitForms(userId);
  const userTier = getUserTier(userId);

  // Admin bypass: admins skip validation gates
  const adminBypass = isAdmin(userId);

  const toolHasForm = toolCall && FORM_ROUTES[toolCall.route] && toolCall.route !== "needs_clarification"
    && !(assetType === "video_concept_or_animation") // NEVER show button for animation concepts
    && (adminBypass || !(isVideoRequest && !session.videoValidated))
    && !isLowConfidence
    && !isRejection;
  const sessionHasForm = session.formType && !toolCall && !isRejection;

  const shouldShowButton = !!(toolHasForm || sessionHasForm) && userCanSubmit;
  const formType = isCalendarEligible ? "brief" : (FORM_ROUTES[toolCall?.route] || session.formType || "brief");

  console.log(`[DEBUG] showButton=${shouldShowButton} formType=${formType} tier=${userTier} rejection=${isRejection} calendarEligible=${isCalendarEligible} videoValidated=${session.videoValidated}`);

  if (shouldShowButton) {
    const requestId = `req_${userId}_${Date.now()}`;
    pendingRequests[requestId] = {
      userId,
      toolCall: toolCall || session.lastToolCall || {},
      conversationSummary: reply,
      channel: channelId,
      formType,
    };

    const safeReply = reply.length > 2900 ? reply.slice(0, 2900) + "…" : reply;

    const buttonLabels = { brief: "Submit Creative Brief", review: "Submit Review Request", template_request: "Submit Template Request" };
    const actionIds = { brief: "open_brief_modal", review: "open_review_modal", template_request: "open_template_modal" };
    const buttonLabel = buttonLabels[formType] || buttonLabels.brief;
    const actionId = actionIds[formType] || actionIds.brief;

    console.log(`[DEBUG] Sending ${formType} button (requestId: ${requestId})${isCalendarEligible ? " + booking link" : ""}`);

    // Build blocks
    const blocks = [
      {
        type: "section",
        text: { type: "mrkdwn", text: safeReply },
      },
      { type: "divider" },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: buttonLabel, emoji: true },
            style: "primary",
            action_id: actionId,
            value: requestId,
          },
        ],
      },
    ];

    // For strategic/calendar-eligible: add booking link below the button
    if (isCalendarEligible) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:calendar: *You'll also need to book a briefing call.* This work requires a scoping conversation with Brand leadership before production begins.\n<${BOOKING_LINK}|Book a Briefing Call> — pick any time that works, the calendar shows live availability.`,
        },
      });
    }

    await say({
      text: reply,
      blocks,
    });
  } else {
    await say(reply);
  }

  // ── Deliver assets if the model searched for them ──
  // Skip asset delivery for brand knowledge questions AND template/buzz routes (never both)
  const isBrandQuestion = toolCall?.route === "brand_question";
  const isTemplateRoute = ["figma_buzz_template", "figma_buzz_access_request", "figma_buzz_template_request", "self_serve"].includes(toolCall?.route);
  const hasValidSearch = illustrationSearch && illustrationSearch.search_tags && illustrationSearch.search_tags.filter(t => t.trim()).length > 0;
  if (hasValidSearch && !isBrandQuestion && !isTemplateRoute && client) {
    // Logo requests use the deterministic router instead of fuzzy search
    const isLogoRequest = illustrationSearch.category === "logo";
    let matches;
    if (isLogoRequest) {
      const tags = illustrationSearch.search_tags.map(t => t.toLowerCase());
      const VALID_SHAPES = ["wordmark", "rectangle", "square", "round", "hibubble", "bob_platform", "erg_bobbility", "erg_blackatbob", "erg_hipride"];
      const VALID_BGS = ["light", "dark", "white", "cherry", "black", "color"];
      const shape = tags.find(t => VALID_SHAPES.includes(t)) || "wordmark";
      const background = tags.find(t => VALID_BGS.includes(t)) || "light";
      matches = findLogo(shape, background);
      console.log(`[LOGO] Deterministic lookup: shape=${shape}, bg=${background} → ${matches.length} matches`);
      if (!matches.length) {
        // Fallback to fuzzy search if deterministic lookup fails
        matches = searchAssets(illustrationSearch.search_tags, "logo");
        console.log(`[LOGO] Fallback to fuzzy search → ${matches.length} matches`);
      }
    } else {
      matches = searchAssets(illustrationSearch.search_tags, illustrationSearch.category || null);
    }
    if (matches.length > 0) {
      // Show fetching indicator
      let fetchingTs = null;
      try {
        const fetchMsg = await client.chat.postMessage({
          channel: channelId,
          text: `:hourglass_flowing_sand: Fetching ${matches.length} asset${matches.length > 1 ? "s" : ""} from the library...`,
        });
        fetchingTs = fetchMsg.ts;
      } catch {}

      // Download all assets first, then send in a single message
      const fileUploads = [];
      const fallbackLinks = [];
      const deliveredAssets = [];

      for (const match of matches) {
        try {
          const buffer = await downloadDriveFile(match.file_id, match.file);
          if (!buffer) {
            fallbackLinks.push(`• <${match.drive_link}|${match.name}>`);
            continue;
          }
          fileUploads.push({ file: buffer, filename: match.file });
          deliveredAssets.push(match);
        } catch (err) {
          console.error(`[ASSET] Failed to download ${match.name}:`, err.message);
          fallbackLinks.push(`• <${match.drive_link}|${match.name}>`);
        }
      }

      // Send all files in a single message
      if (fileUploads.length > 0) {
        try {
          const commentLines = deliveredAssets.map(m => `*${m.name}*`);
          const comment = deliveredAssets.length === 1 ? commentLines[0] : commentLines.join("\n");
          await client.files.uploadV2({
            channel_id: channelId,
            initial_comment: comment,
            file_uploads: fileUploads,
          });
          for (const match of deliveredAssets) {
            console.log(`[ASSET] Sent ${match.name} (${match.file_id}) to ${channelId}`);
            postAnalytics(`:art: *Asset delivered* to <@${userId}>\nAsset: *${match.name}*\nSearch: ${illustrationSearch.search_tags.join(", ")}\nContext: ${illustrationSearch.context}`);
            trackEvent("asset_delivered", userId, { assetName: match.name, category: match.category, searchTags: illustrationSearch.search_tags });
          }
        } catch (err) {
          console.error(`[ASSET] Batch upload failed:`, err.message);
          const allLinks = deliveredAssets.map(m => `• <${m.drive_link}|${m.name}>`);
          await client.chat.postMessage({ channel: channelId, text: `Couldn't send files directly. Here are the Drive links:\n${allLinks.join("\n")}`, unfurl_links: false, unfurl_media: false });
        }
      }

      // Send fallback links for any that couldn't be downloaded
      if (fallbackLinks.length > 0) {
        await client.chat.postMessage({ channel: channelId, text: `Some assets couldn't be downloaded directly:\n${fallbackLinks.join("\n")}`, unfurl_links: false, unfurl_media: false });
      }

      // Remove fetching indicator
      if (fetchingTs) {
        try { await client.chat.delete({ channel: channelId, ts: fetchingTs }); } catch {}
      }
    } else {
      await client.chat.postMessage({
        channel: channelId,
        text: `I couldn't find a matching asset for "${illustrationSearch.search_tags.join(", ")}." You can browse the full library here:\n• <https://brand.hibob.com/s/Spot-illustrations-RmNLE5?v=0|Spot Illustrations>\n• <https://brand.hibob.com/s/Illustrative-icons-oKDnzE?v=0|Illustrative Icons>\n\nOr submit a Creative Brief if you need something custom.`,
        unfurl_links: false, unfurl_media: false,
      });
    }
  }
}

// ────────────────────────────────────────────
// Team options (update these to match your Asana form)
// ────────────────────────────────────────────
const TEAM_OPTIONS = [
  { text: { type: "plain_text", text: "Performance Marketing" }, value: "performance_marketing" },
  { text: { type: "plain_text", text: "Regional Marketing" }, value: "regional_marketing" },
  { text: { type: "plain_text", text: "Product Marketing" }, value: "product_marketing" },
  { text: { type: "plain_text", text: "Customer Marketing" }, value: "customer_marketing" },
  { text: { type: "plain_text", text: "Partner Marketing" }, value: "partner_marketing" },
  { text: { type: "plain_text", text: "Analysts & Influencers" }, value: "analysts_influencers" },
  { text: { type: "plain_text", text: "PR" }, value: "pr" },
  { text: { type: "plain_text", text: "SEO" }, value: "seo" },
  { text: { type: "plain_text", text: "Editorial Calendar" }, value: "editorial_calendar" },
  { text: { type: "plain_text", text: "Other" }, value: "other" },
];

const REQUEST_TYPE_OPTIONS = [
  { text: { type: "plain_text", text: "Quarterly planning" }, value: "quarterly_planning" },
  { text: { type: "plain_text", text: "Ad-hoc request" }, value: "ad_hoc" },
];

// ────────────────────────────────────────────
// Modal: Standard Brief Form (Creative Services)
// ────────────────────────────────────────────

// Map LLM routing asset_type → form dropdown value
const LLM_TO_FORM_ASSET_TYPE = {
  "promotional_banner": "banners_social_ads",
  "one_pager": "one_pager",
  "deck": "deck",
  "single_slide_graphic": "artwork",
  "video_small_edit": "video",
  "video_large_edit": "video",
  "video_concept_or_animation": "video",
  "programs_and_campaign_system": "campaign_system",
  "campaign": "campaign_system",
  "event_tier1": "artwork",
  "feature_launch": "banners_social_ads",
  "graphics_illustration_icons": "artwork",
  "event_and_physical_assets": "print",
  "content_blog_guide": "artwork",
  "creative_review": "content_review",
};

app.action("open_brief_modal", async ({ body, ack, client }) => {
  await ack();

  const requestId = body.actions[0].value;
  const pending = pendingRequests[requestId];
  const prefillName = pending?.toolCall?.summary || "";

  // Resolve pre-selected asset type from LLM context
  const llmAssetType = pending?.toolCall?.asset_type;
  const lockedAssetType = llmAssetType ? (LLM_TO_FORM_ASSET_TYPE[llmAssetType] || null) : null;

  const step1Blocks = forms.buildStep1Blocks(prefillName, lockedAssetType);
  // Inject TEAM_OPTIONS into the team block, with user's saved team pre-selected
  const teamBlock = step1Blocks.find((b) => b.block_id === "team_block");
  if (teamBlock) {
    teamBlock.element.options = TEAM_OPTIONS;
    const savedTeam = getUserTeam(body.user.id);
    if (savedTeam) {
      const matchedOption = TEAM_OPTIONS.find(t => t.text.text === savedTeam);
      if (matchedOption) {
        teamBlock.element.initial_option = matchedOption;
      }
    }
  }

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "brief_step1",
      private_metadata: JSON.stringify({ requestId, lockedAssetType }),
      title: { type: "plain_text", text: "Creative Brief" },
      submit: { type: "plain_text", text: "Next →" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: step1Blocks,
    },
  });
});

// ── Step 1 submission → show Step 2 (shared + asset-specific) or redirect ──
app.view("brief_step1", async ({ ack, view, body, client }) => {
  const vals = view.state.values;
  const meta = JSON.parse(view.private_metadata);
  const requestId = meta.requestId;

  // Use locked type from context if set, otherwise read from dropdown
  const assetType = meta.lockedAssetType || vals.asset_type_block?.asset_type_input?.selected_option?.value;

  // Redirects — close modal with a message
  if (assetType === "content_review") {
    await ack({
      response_action: "update",
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Content Review" },
        close: { type: "plain_text", text: "Close" },
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":link: *Content review has its own form.*\n\nContent review requests (copy edits, brand checks, proofreading) are submitted through a separate intake form. Close this modal and use the *Submit Review Request* button instead, or ask BrandBot for help." },
          },
        ],
      },
    });
    return;
  }

  if (assetType === "campaign_system") {
    await ack({
      response_action: "update",
      view: {
        type: "modal",
        title: { type: "plain_text", text: "Campaign System" },
        close: { type: "plain_text", text: "Close" },
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: ":page_facing_up: *Campaign systems require a campaign brief and a kick-off meeting.*\n\nIndividual deliverables within a campaign will each get their own intake request after the brief is approved.\n\nClose this modal, then use the booking link below to schedule a campaign kick-off with the creative team." },
          },
        ],
      },
    });
    return;
  }

  // Carry Step 1 values forward via private_metadata
  const step1Data = {
    requestId,
    assetType,
    name: vals.name_block.name_input.value,
    team: vals.team_block.team_input.selected_option,
    dueDate: vals.date_block.date_input.selected_date,
    priority: vals.priority_block.priority_input.selected_option,
    netNew: vals.net_new_block.net_new_input.selected_option,
  };

  // Build Step 2: shared blocks + asset-specific blocks
  const assetLabel = forms.ASSET_TYPE_LABELS[assetType] || assetType;
  const sharedBlocks = forms.buildSharedBlocks();
  const assetBlocks = forms.getAssetBlocks(assetType);

  const step2Blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Step 2 of 2* — ${assetLabel} details for *${step1Data.name}*` },
    },
    { type: "divider" },
    ...sharedBlocks,
    ...assetBlocks,
  ];

  await ack({
    response_action: "update",
    view: {
      type: "modal",
      callback_id: "brief_step2",
      private_metadata: JSON.stringify(step1Data),
      title: { type: "plain_text", text: "Creative Brief" },
      submit: { type: "plain_text", text: "Submit to Brand" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: step2Blocks,
    },
  });
});

// ── Step 2 final submission → create Asana task ──
app.view("brief_step2", async ({ ack, view, body, client }) => {
  const step1 = JSON.parse(view.private_metadata);
  const vals = view.state.values;
  const userId = body.user.id;
  const pending = pendingRequests[step1.requestId] || {};

  // Extract shared fields
  const get = (blockId, actionId) => {
    const v = vals[blockId]?.[actionId];
    if (!v) return "";
    if (v.value) return v.value;
    if (v.selected_option) return v.selected_option.text.text;
    if (v.selected_options) return v.selected_options.map(o => o.text.text).join(", ");
    if (v.selected_date) return v.selected_date;
    return "";
  };

  const context = get("context_block", "context_input");
  const placement = get("placement_block", "placement_input");
  const goal = get("goal_block", "goal_input");
  const visibility = get("visibility_block", "visibility_input");
  const audience = get("audience_block", "audience_input");
  const keyMessage = get("message_block", "message_input");
  const mandatory = get("mandatory_block", "mandatory_input");
  const supporting = get("supporting_block", "supporting_input");

  // Extract asset-specific fields
  const assetSpecific = forms.extractAssetFields(step1.assetType, vals);
  const assetLabel = forms.ASSET_TYPE_LABELS[step1.assetType] || step1.assetType;

  try {
    if (!ASANA_PAT || !ASANA_PROJECT_GID) throw new Error("ASANA_PAT or ASANA_PROJECT_GID not configured");

    // Get submitter info — body.user has username; API call needed for real name + email
    let slackName = body.user.name || body.user.username || userId;
    let email = null;
    try {
      const userInfo = await client.users.info({ user: userId });
      const profile = userInfo.user?.profile || {};
      email = profile.email || null;
      slackName = userInfo.user?.real_name || profile.real_name_normalized || profile.real_name || slackName;
      console.log(`[SLACK] User info for ${userId}: realName=${slackName}, email=${email}, profile_keys=${Object.keys(profile).join(",")}`);
    } catch (err) {
      console.error(`[SLACK] users.info failed for ${userId}:`, err.message);
    }

    const asanaUserGid = email ? await getAsanaUserGid(email) : null;
    console.log(`[ASANA] User lookup: email=${email} → gid=${asanaUserGid}`);

    // Build rich text (html_notes) for Asana task description
    // Asana supports: <strong>, <em>, <u>, <a>, <ul>/<ol>/<li>, <h1>-<h3>, <br>
    const esc = (s) => (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const assetSpecificLines = assetSpecific.split("\n").filter(Boolean);

    const submitterDisplay = email ? `${slackName} (${email})` : slackName;
    const htmlNotes = `<body>`
      + `<strong>Submitted by:</strong> ${esc(submitterDisplay)} via Brand Intake Bot\n`
      + `<strong>Team:</strong> ${esc(step1.team?.text?.text || "N/A")}\n`
      + `<strong>Asset type:</strong> ${esc(assetLabel)}\n`
      + `<strong>Priority:</strong> ${esc(step1.priority?.text?.text || "N/A")}\n`
      + `<strong>Due date:</strong> ${esc(step1.dueDate || "N/A")}\n`
      + `<strong>Net new / revision:</strong> ${esc(step1.netNew?.text?.text || "N/A")}\n`
      + `\n`
      + `<strong>Context:</strong>\n${esc(context)}\n`
      + `\n`
      + `<strong>Placement</strong>\n${esc(placement)}\n`
      + `\n`
      + `<strong>Goal</strong>\n${esc(goal)}\n`
      + `\n`
      + `<strong>Visibility</strong>\n${esc(visibility)}\n`
      + `\n`
      + (audience ? `<strong>Target Audience</strong>\n${esc(audience)}\n\n` : "")
      + `<strong>Key Message</strong>\n${esc(keyMessage)}\n`
      + `\n`
      + (mandatory ? `<strong>Mandatory Elements</strong>\n${esc(mandatory)}\n\n` : "")
      + (supporting ? `<strong>Supporting Documents</strong>\n${esc(supporting)}\n\n` : "")
      + `\n`
      + `<strong>${esc(assetLabel)} Details</strong>\n`
      + assetSpecificLines.map(l => esc(l)).join("\n") + "\n"
      + (pending.toolCall?.summary ? `\n<strong>Bot context:</strong> ${esc(pending.toolCall.summary)}\n` : "")
      + `</body>`;

    const cf = buildCustomFields({
      toolCall: pending.toolCall || { asset_type: step1.assetType },
      teamValue: step1.team?.value,
      dueDate: step1.dueDate,
      isStrategic: pending.toolCall?.strategic_escalation,
      slackUserGid: asanaUserGid,
      email,
    });

    // Override net new/revision from form
    if (customFields.net_new_or_revision && step1.netNew?.value) {
      const nrGid = customFields.net_new_or_revision.options[step1.netNew.value];
      if (nrGid) cf[customFields.net_new_or_revision.gid] = nrGid;
    }

    // Asana accepts email directly as assignee — use it as primary, GID as fallback
    const assigneeValue = email || asanaUserGid || null;
    console.log(`[ASANA] Creating task — assignee: ${assigneeValue}, email: ${email}, asanaUserGid: ${asanaUserGid}`);

    const result = await asanaRequest("/tasks", "POST", {
      data: {
        name: step1.name,
        html_notes: htmlNotes,
        projects: [ASANA_PROJECT_GID],
        ...(step1.dueDate && { due_on: step1.dueDate }),
        ...(Object.keys(cf).length && { custom_fields: cf }),
        ...(assigneeValue && { assignee: assigneeValue }),
        ...(asanaUserGid && { followers: [asanaUserGid] }),
      },
    });

    const taskGid = result.data?.gid;
    const taskUrl = taskGid ? `https://app.asana.com/0/0/${taskGid}` : null;

    let confirmText = `:white_check_mark: Your ${assetLabel} request *${step1.name}* has been submitted to Brand Services.`;
    if (taskUrl) confirmText += `\n<${taskUrl}|View task in Asana>`;

    const isStrategic = pending.toolCall?.strategic_escalation;
    if (isStrategic) {
      confirmText += `\n\n:warning: This request involves strategic work — Brand leadership will reach out for scoping before production begins.`;
    }

    // SLA warning — check if requested due date is within SLA
    const slaWarning = getSlaWarning(step1.assetType, step1.dueDate);
    if (slaWarning) {
      confirmText += `\n\n${slaWarning}`;
      postAnalytics(`:clock1: *SLA warning* for <@${userId}> — ${assetLabel} request *${step1.name}* has a tight turnaround (due ${step1.dueDate})`);
    }

    if (taskGid) {
      confirmText += `\n\n:paperclip: Have files to attach? Just send them here in this DM within the next 10 minutes and I'll attach them to your Asana task automatically.`;
      setPendingFileUpload(userId, taskGid, taskUrl, step1.name);
    }

    await ack();
    await client.chat.postMessage({ channel: userId, text: confirmText, unfurl_links: false, unfurl_media: false });
    delete pendingRequests[step1.requestId];
    console.log(`[ASANA] Created ${step1.assetType} task ${taskGid} for user ${userId}: ${step1.name}`);
    postAnalytics(`:memo: *${assetLabel} submitted* by <@${userId}>\nRequest: *${step1.name}*\nTeam: ${step1.team?.text?.text || "N/A"}\nPriority: ${step1.priority?.text?.text || "N/A"}\n${taskUrl ? `<${taskUrl}|View in Asana>` : ""}`);
    trackEvent("brief_submitted", userId, { requestName: step1.name, assetType: step1.assetType, team: step1.team?.text?.text, taskGid });
  } catch (err) {
    console.error("[ASANA] Brief task creation failed:", err.message);
    await ack();
    await client.chat.postMessage({
      channel: userId,
      text: `I wasn't able to create the Asana task — ${err.message}. Please reach out to Brand Services directly.`,
    });
  }
});

// ────────────────────────────────────────────
// Modal: Review Request Form
// ────────────────────────────────────────────
app.action("open_review_modal", async ({ body, ack, client }) => {
  await ack();

  const requestId = body.actions[0].value;
  const pending = pendingRequests[requestId];
  const prefillName = pending?.toolCall?.summary || "";

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "submit_review",
      private_metadata: requestId,
      title: { type: "plain_text", text: "Review Request" },
      submit: { type: "plain_text", text: "Submit to Brand" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "name_block",
          label: { type: "plain_text", text: "Name of the request" },
          hint: { type: "plain_text", text: "This will be the task name so you can find it in Asana search" },
          element: {
            type: "plain_text_input",
            action_id: "name_input",
            placeholder: { type: "plain_text", text: "e.g. London Conference Event Assets — Agency Review" },
            initial_value: prefillName.length < 100 ? prefillName : "",
          },
        },
        {
          type: "input",
          block_id: "team_block",
          label: { type: "plain_text", text: "Requester team" },
          element: {
            type: "static_select",
            action_id: "team_input",
            options: TEAM_OPTIONS,
          },
        },
        {
          type: "input",
          block_id: "date_block",
          label: { type: "plain_text", text: "Requested due date" },
          element: {
            type: "datepicker",
            action_id: "date_input",
            placeholder: { type: "plain_text", text: "Enter a date" },
          },
        },
        {
          type: "input",
          block_id: "context_block",
          label: { type: "plain_text", text: "Context" },
          hint: { type: "plain_text", text: "Please provide any context needed to review this asset including links to brief documents or assets that need review." },
          element: {
            type: "plain_text_input",
            action_id: "context_input",
            multiline: true,
          },
        },
      ],
    },
  });
});

// ────────────────────────────────────────────
// Submission: Review Request → Asana task
// ────────────────────────────────────────────
app.view("submit_review", async ({ ack, view, body, client }) => {
  const vals = view.state.values;
  const requestName = vals.name_block.name_input.value;
  const team = vals.team_block.team_input.selected_option;
  const dueDate = vals.date_block.date_input.selected_date;
  const context = vals.context_block.context_input.value || "";

  const requestId = view.private_metadata;
  const pending = pendingRequests[requestId] || {};
  const userId = body.user.id;

  const taskNotes = [
    `Submitted by: <@${userId}> via Brand Intake Bot`,
    `Requester team: ${team?.text?.text || "Not specified"}`,
    `Due date: ${dueDate || "Not specified"}`,
    ``,
    `--- Context ---`,
    context,
    ``,
    pending.toolCall?.summary ? `Bot context: ${pending.toolCall.summary}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    if (!ASANA_PAT || !ASANA_PROJECT_GID) throw new Error("ASANA_PAT or ASANA_PROJECT_GID not configured");

    const email = await getSlackUserEmail(client, userId);
    const asanaUserGid = email ? await getAsanaUserGid(email) : null;

    const cf = buildCustomFields({
      toolCall: { asset_type: "creative_review", ...(pending.toolCall || {}) },
      teamValue: team?.value,
      dueDate,
      isStrategic: false,
      slackUserGid: asanaUserGid,
    });

    const result = await asanaRequest("/tasks", "POST", {
      data: {
        name: `[Review] ${requestName}`,
        notes: taskNotes,
        projects: [ASANA_PROJECT_GID],
        ...(dueDate && { due_on: dueDate }),
        ...(Object.keys(cf).length && { custom_fields: cf }),
        ...(asanaUserGid && { followers: [asanaUserGid] }),
      },
    });

    const taskGid = result.data?.gid;
    const taskUrl = taskGid ? `https://app.asana.com/0/0/${taskGid}` : null;

    let confirmText = `:white_check_mark: Your review request *${requestName}* has been submitted to Brand Services.`;
    if (taskUrl) confirmText += `\n<${taskUrl}|View task in Asana>`;

    if (taskGid) {
      confirmText += `\n\n:paperclip: Need to attach the assets for review? Just send them here in this DM within the next 10 minutes and I'll attach them to your Asana task automatically.`;
      setPendingFileUpload(userId, taskGid, taskUrl, requestName);
    }
    await ack();
    await client.chat.postMessage({ channel: userId, text: confirmText, unfurl_links: false, unfurl_media: false });
    delete pendingRequests[requestId];
    console.log(`[ASANA] Created review task ${taskGid} for user ${userId}: ${requestName}`);
    postAnalytics(`:mag: *Creative Review submitted* by <@${userId}>\nRequest: *${requestName}*\nTeam: ${team?.text?.text || "N/A"}\n${taskUrl ? `<${taskUrl}|View in Asana>` : ""}`);
    trackEvent("review_submitted", userId, { requestName, team: team?.text?.text, taskGid });
  } catch (err) {
    console.error("[ASANA] Review task creation failed:", err.message);
    await ack();
    await client.chat.postMessage({
      channel: userId,
      text: `I wasn't able to create the Asana task — ${err.message}. You can submit manually here: ${registry.asana_forms?.creative_review?.link || "(link unavailable)"}`,
    });
  }
});

// ────────────────────────────────────────────
// Modal: Figma Buzz Template Request
// ────────────────────────────────────────────
app.action("open_template_modal", async ({ body, ack, client }) => {
  await ack();

  const requestId = body.actions[0].value;
  const pending = pendingRequests[requestId];
  const prefillName = pending?.toolCall?.summary || "";

  await client.views.open({
    trigger_id: body.trigger_id,
    view: {
      type: "modal",
      callback_id: "submit_template_request",
      private_metadata: requestId,
      title: { type: "plain_text", text: "Template Request" },
      submit: { type: "plain_text", text: "Submit Request" },
      close: { type: "plain_text", text: "Cancel" },
      blocks: [
        {
          type: "input",
          block_id: "name_block",
          label: { type: "plain_text", text: "Name of the request" },
          hint: { type: "plain_text", text: "This will be the task name so you can find it in Asana search" },
          element: {
            type: "plain_text_input",
            action_id: "name_input",
            initial_value: prefillName.length < 100 ? prefillName : "",
          },
        },
        {
          type: "input",
          block_id: "team_block",
          label: { type: "plain_text", text: "Requester team" },
          element: {
            type: "static_select",
            action_id: "team_input",
            options: TEAM_OPTIONS,
          },
        },
        {
          type: "input",
          block_id: "asset_types_block",
          label: { type: "plain_text", text: "Asset type(s) needed" },
          hint: { type: "plain_text", text: "e.g. social media post, email header, one-pager, event invite, internal signage" },
          element: {
            type: "plain_text_input",
            action_id: "asset_types_input",
            multiline: true,
          },
        },
        {
          type: "input",
          block_id: "channel_specs_block",
          label: { type: "plain_text", text: "Channel & specs" },
          hint: { type: "plain_text", text: "e.g. LinkedIn post 1200×627 px, Instagram Story, A4 PDF" },
          element: {
            type: "plain_text_input",
            action_id: "channel_specs_input",
            multiline: true,
          },
        },
        {
          type: "input",
          block_id: "purpose_block",
          label: { type: "plain_text", text: "What's the purpose?" },
          hint: { type: "plain_text", text: "e.g. Webinar announcement, internal comms, product launch" },
          element: {
            type: "plain_text_input",
            action_id: "purpose_input",
            multiline: true,
          },
        },
        {
          type: "input",
          block_id: "existing_assets_block",
          label: { type: "plain_text", text: "Link to existing assets to use as a model" },
          hint: { type: "plain_text", text: "Does it need to look like something that already exists? If so, share links." },
          element: {
            type: "plain_text_input",
            action_id: "existing_assets_input",
            multiline: true,
          },
          optional: true,
        },
        {
          type: "input",
          block_id: "editable_block",
          label: { type: "plain_text", text: "Editable elements preference" },
          hint: { type: "plain_text", text: "What should be editable? e.g. headline text, sub-text, background colour, image, logo" },
          element: {
            type: "plain_text_input",
            action_id: "editable_input",
            multiline: true,
          },
        },
        {
          type: "input",
          block_id: "frequency_block",
          label: { type: "plain_text", text: "Frequency or volume needed" },
          hint: { type: "plain_text", text: "e.g. \"same layout for 4 variants\" or \"monthly versions\"" },
          element: {
            type: "plain_text_input",
            action_id: "frequency_input",
            multiline: true,
          },
        },
        {
          type: "input",
          block_id: "users_block",
          label: { type: "plain_text", text: "Who will use these templates?" },
          hint: { type: "plain_text", text: "e.g. your team only, cross-functional, all marketing" },
          element: {
            type: "plain_text_input",
            action_id: "users_input",
            multiline: true,
          },
        },
        {
          type: "input",
          block_id: "brand_constraints_block",
          label: { type: "plain_text", text: "Any brand or compliance constraints?" },
          hint: { type: "plain_text", text: "e.g. tone of voice, legal requirements, logo usage guidelines" },
          element: {
            type: "plain_text_input",
            action_id: "brand_constraints_input",
            multiline: true,
          },
        },
        {
          type: "input",
          block_id: "additional_block",
          label: { type: "plain_text", text: "Additional notes or features" },
          hint: { type: "plain_text", text: "e.g. bulk spreadsheet support, localization needs, specific imagery" },
          element: {
            type: "plain_text_input",
            action_id: "additional_input",
            multiline: true,
          },
        },
        {
          type: "input",
          block_id: "timeline_block",
          label: { type: "plain_text", text: "Deadline / desired timeline or sequencing" },
          hint: { type: "plain_text", text: "Specify dates where relevant. Rank your requests if the list exceeds what can be delivered at once." },
          element: {
            type: "plain_text_input",
            action_id: "timeline_input",
            multiline: true,
          },
        },
      ],
    },
  });
});

// ────────────────────────────────────────────
// Submission: Template Request → Asana task
// ────────────────────────────────────────────
app.view("submit_template_request", async ({ ack, view, body, client }) => {
  const vals = view.state.values;
  const requestName = vals.name_block.name_input.value;
  const team = vals.team_block.team_input.selected_option;
  const assetTypes = vals.asset_types_block.asset_types_input.value || "";
  const channelSpecs = vals.channel_specs_block.channel_specs_input.value || "";
  const purpose = vals.purpose_block.purpose_input.value || "";
  const existingAssets = vals.existing_assets_block?.existing_assets_input?.value || "";
  const editable = vals.editable_block.editable_input.value || "";
  const frequency = vals.frequency_block.frequency_input.value || "";
  const users = vals.users_block.users_input.value || "";
  const brandConstraints = vals.brand_constraints_block.brand_constraints_input.value || "";
  const additional = vals.additional_block.additional_input.value || "";
  const timeline = vals.timeline_block.timeline_input.value || "";

  const requestId = view.private_metadata;
  const pending = pendingRequests[requestId] || {};
  const userId = body.user.id;

  const taskNotes = [
    `Submitted by: <@${userId}> via Brand Intake Bot`,
    `Requester team: ${team?.text?.text || "Not specified"}`,
    ``,
    `--- Asset Type(s) Needed ---`,
    assetTypes,
    ``,
    `--- Channel & Specs ---`,
    channelSpecs,
    ``,
    `--- Purpose ---`,
    purpose,
    existingAssets ? `\n--- Existing Assets / Model ---\n${existingAssets}` : "",
    ``,
    `--- Editable Elements Preference ---`,
    editable,
    ``,
    `--- Frequency / Volume ---`,
    frequency,
    ``,
    `--- Who Will Use These Templates ---`,
    users,
    ``,
    `--- Brand / Compliance Constraints ---`,
    brandConstraints,
    ``,
    `--- Additional Notes / Features ---`,
    additional,
    ``,
    `--- Deadline / Timeline ---`,
    timeline,
    ``,
    pending.toolCall?.summary ? `Bot context: ${pending.toolCall.summary}` : "",
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  try {
    if (!ASANA_PAT || !ASANA_PROJECT_GID) throw new Error("ASANA_PAT or ASANA_PROJECT_GID not configured");

    const email = await getSlackUserEmail(client, userId);
    const asanaUserGid = email ? await getAsanaUserGid(email) : null;

    const cf = buildCustomFields({
      toolCall: { asset_type: "graphics_illustration_icons", ...(pending.toolCall || {}) },
      teamValue: team?.value,
      dueDate: null,
      isStrategic: false,
      slackUserGid: asanaUserGid,
    });

    const result = await asanaRequest("/tasks", "POST", {
      data: {
        name: `[Template Request] ${requestName}`,
        notes: taskNotes,
        projects: [ASANA_PROJECT_GID],
        ...(Object.keys(cf).length && { custom_fields: cf }),
        ...(asanaUserGid && { followers: [asanaUserGid] }),
      },
    });

    const taskGid = result.data?.gid;
    const taskUrl = taskGid ? `https://app.asana.com/0/0/${taskGid}` : null;

    let confirmText = `:white_check_mark: Your template request *${requestName}* has been submitted to Brand Services.`;
    if (taskUrl) confirmText += `\n<${taskUrl}|View task in Asana>`;
    if (taskGid) {
      confirmText += `\n\n:paperclip: Have reference files or examples? Just send them here in this DM within the next 10 minutes and I'll attach them to your Asana task automatically.`;
      setPendingFileUpload(userId, taskGid, taskUrl, requestName);
    }

    await ack();
    await client.chat.postMessage({ channel: userId, text: confirmText, unfurl_links: false, unfurl_media: false });
    delete pendingRequests[requestId];
    console.log(`[ASANA] Created template request ${taskGid} for user ${userId}: ${requestName}`);
    postAnalytics(`:art: *Template Request submitted* by <@${userId}>\nRequest: *${requestName}*\nTeam: ${team?.text?.text || "N/A"}\n${taskUrl ? `<${taskUrl}|View in Asana>` : ""}`);
    trackEvent("template_submitted", userId, { requestName, team: team?.text?.text, taskGid });
  } catch (err) {
    console.error("[ASANA] Template request creation failed:", err.message);
    await ack();
    await client.chat.postMessage({
      channel: userId,
      text: `I wasn't able to create the Asana task — ${err.message}. You can submit manually here: ${registry.asana_forms?.figma_buzz_template_request?.link || "(link unavailable)"}`,
    });
  }
});

// ────────────────────────────────────────────
// Briefing Call: Open booking link + create Asana task
// ────────────────────────────────────────────
const BOOKING_LINK = "https://calendar.google.com/calendar/u/0/appointments/schedules/AcZssZ0ALhxvUhxA-RNpC7ga7rxtwDNe0qOL3JMKTulsGzuYRqY7yIRb64blbkUwKm5_FvAGuoRCmfjZ?gv=true";

app.action("open_calendar_modal", async ({ body, ack, client }) => {
  await ack();

  const requestId = body.actions[0].value;
  const pending = pendingRequests[requestId] || {};
  const userId = body.user.id;

  // Create an Asana task to track the briefing request
  let taskText = "";
  if (ASANA_PAT && ASANA_PROJECT_GID) {
    try {
      const email = await getSlackUserEmail(client, userId);
      const asanaUserGid = email ? await getAsanaUserGid(email) : null;

      const cf = buildCustomFields({
        toolCall: pending.toolCall,
        teamValue: null,
        dueDate: null,
        isStrategic: true,
        slackUserGid: asanaUserGid,
      });

      const taskNotes = [
        `Submitted by: <@${userId}> via Brand Intake Bot`,
        ``,
        `BRIEFING CALL REQUESTED`,
        `The requester has been directed to the booking link.`,
        pending.toolCall?.summary ? `\nBot context: ${pending.toolCall.summary}` : "",
        pending.conversationSummary ? `\nConversation:\n${pending.conversationSummary}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const result = await asanaRequest("/tasks", "POST", {
        data: {
          name: `[Briefing Call] ${pending.toolCall?.summary || "Strategic initiative"}`,
          notes: taskNotes,
          projects: [ASANA_PROJECT_GID],
          ...(Object.keys(cf).length && { custom_fields: cf }),
          ...(asanaUserGid && { followers: [asanaUserGid] }),
        },
      });

      const taskGid = result.data?.gid;
      if (taskGid) {
        taskText = `\n<https://app.asana.com/0/0/${taskGid}|View tracking task in Asana>`;
      }
    } catch (err) {
      console.error("[ASANA] Briefing tracking task failed:", err.message);
    }
  }

  // Send the booking link
  await client.chat.postMessage({
    channel: userId,
    text: `:calendar: Use the link below to book a 30-minute briefing call with Brand leadership:\n<${BOOKING_LINK}|Book a Briefing Call>\n\nPick any time that works for you — the calendar shows live availability.${taskText}`,
  });

  delete pendingRequests[requestId];
  console.log(`[CALENDAR] Sent booking link to user ${userId}`);
  postAnalytics(`:calendar: *Briefing Call requested* by <@${userId}>\nInitiative: *${pending?.toolCall?.summary || "Strategic initiative"}*`);
  trackEvent("briefing_requested", userId, { summary: pending?.toolCall?.summary });
});

// ────────────────────────────────────────────
// Debug mode (/brandbot-debug)
// ────────────────────────────────────────────
const DEBUG_COMMANDS = {
  "debug session": async (userId) => {
    const session = sessions[userId];
    if (!session) return "No active session for your user.";
    return [
      `*Session Debug for <@${userId}>*`,
      `Messages in history: ${session.messages.length}`,
      `Form type: ${session.formType || "none"}`,
      `Video validated: ${session.videoValidated || false}`,
      `Video turn count: ${session.videoTurnCount || 0}`,
      `Pending asset type: ${session.pendingAssetType || "none"}`,
      `Last activity: ${new Date(session.lastActivity).toISOString()}`,
      `Last tool call: ${session.lastToolCall ? JSON.stringify(session.lastToolCall, null, 2) : "none"}`,
    ].join("\n");
  },
  "debug permissions": async (userId) => {
    const tier = getUserTier(userId);
    const adminCount = permissions.admin.users.length;
    const fullCount = permissions.full.users.length;
    const limitedCount = permissions.limited.users.length;
    return [
      `*Permissions Debug*`,
      `Your tier: *${tier}*`,
      `Can submit forms: ${canSubmitForms(userId)}`,
      `Can access assets: ${canAccessAssets(userId)}`,
      `Is admin: ${isAdmin(userId)}`,
      `Total users: ${adminCount + fullCount + limitedCount} (${adminCount} admin, ${fullCount} full, ${limitedCount} limited)`,
    ].join("\n");
  },
  "debug agencies": async () => {
    if (!agencyWhitelist.length) return "No agencies loaded.";
    return `*Approved Agencies (${agencyWhitelist.length})*\n` + agencyWhitelist.map((a) => `• ${a.name}${a.onboarded ? " :white_check_mark:" : " :warning: not onboarded"}`).join("\n");
  },
  "debug config": async () => {
    return [
      `*Config Debug*`,
      `OpenAI model: ${process.env.OPENAI_MODEL || "gpt-4o"}`,
      `Asana PAT: ${ASANA_PAT ? "configured" : "MISSING"}`,
      `Asana project: ${ASANA_PROJECT_GID || "MISSING"}`,
      `Analytics channel: ${ANALYTICS_CHANNEL_ID || "not configured"}`,
      `Registry keys: figma_buzz(${Object.keys(registry.figma_buzz || {}).length}), asana_forms(${Object.keys(registry.asana_forms || {}).length})`,
      `Agencies loaded: ${agencyWhitelist.length}`,
      `Sessions active: ${Object.keys(sessions).length}`,
    ].join("\n");
  },
  "debug reset": async (userId) => {
    delete sessions[userId];
    return "Your session has been reset. Start a new conversation anytime.";
  },
  "debug catalog": async () => {
    if (!assetCatalog.length) return "No assets loaded. Run `rescan assets` to scan the Drive folder.";
    const byCat = {};
    assetCatalog.forEach((a) => { byCat[a.category] = (byCat[a.category] || 0) + 1; });
    const byCol = {};
    assetCatalog.forEach((a) => { const c = a.collection || "general"; byCol[c] = (byCol[c] || 0) + 1; });
    const assetsFile = path.resolve(__dirname, "assets.json");
    let lastModified = "unknown";
    try {
      const stat = fs.statSync(assetsFile);
      lastModified = stat.mtime.toISOString().split("T")[0];
    } catch {}
    const lines = [
      `*Asset Catalog*`,
      `Total assets: ${assetCatalog.length}`,
      `Last scan: ${lastModified}`,
      `Vision-analyzed: ${assetCatalog.filter(a => a.vision_analyzed).length}`,
      ``,
      `*By category:*`,
      ...Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([c, n]) => `• ${c}: ${n}`),
      ``,
      `*By collection:*`,
      ...Object.entries(byCol).sort((a, b) => b[1] - a[1]).map(([c, n]) => `• ${c}: ${n}`),
    ];
    return lines.join("\n");
  },
  "version": async () => {
    if (!changelog.length) return "No version history available.";
    const lines = [`:rocket: *BrandBot Version History*`, ``];
    // Show last 10 entries
    const recent = changelog.slice(-10).reverse();
    for (const entry of recent) {
      lines.push(`*v${entry.version}* — ${entry.date}`);
      for (const change of entry.changes) {
        lines.push(`  • ${change}`);
      }
      lines.push(``);
    }
    return lines.join("\n");
  },
};

// ────────────────────────────────────────────
// Admin: Asana query commands
// ────────────────────────────────────────────
async function queryAsanaTasks({ filter, userId }) {
  if (!ASANA_PAT || !ASANA_PROJECT_GID) return "Asana is not configured.";

  try {
    const today = new Date().toISOString().split("T")[0];
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    // Get all incomplete tasks in the project
    const result = await asanaRequest(
      `/tasks?project=${ASANA_PROJECT_GID}&completed_since=now&opt_fields=name,assignee.name,due_on,completed,permalink_url&limit=50`
    );

    let tasks = (result.data || []).filter((t) => !t.completed);

    if (filter === "due_this_week") {
      tasks = tasks.filter((t) => t.due_on && t.due_on >= today && t.due_on <= nextWeek);
    }

    if (!tasks.length) return filter === "due_this_week" ? "No tasks due this week." : "No incomplete tasks found.";

    const lines = tasks.map((t) => {
      const assignee = t.assignee?.name || "Unassigned";
      const due = t.due_on || "No due date";
      const url = t.permalink_url || "";
      return `• *${t.name}* — ${assignee} — due ${due}${url ? ` — <${url}|view>` : ""}`;
    });

    const header = filter === "due_this_week" ? `*Tasks due this week (${tasks.length})*` : `*All incomplete tasks (${tasks.length})*`;
    return header + "\n" + lines.join("\n");
  } catch (err) {
    return `Asana query failed: ${err.message}`;
  }
}

const ADMIN_COMMANDS = {
  // ── Asana queries ──
  "whats due this week": async (userId) => queryAsanaTasks({ filter: "due_this_week", userId }),
  "what's due this week": async (userId) => queryAsanaTasks({ filter: "due_this_week", userId }),
  "show all tasks": async (userId) => queryAsanaTasks({ filter: "all", userId }),
  "whats due today": async (userId) => {
    if (!ASANA_PAT || !ASANA_PROJECT_GID) return "Asana is not configured.";
    const today = new Date().toISOString().split("T")[0];
    const result = await asanaRequest(
      `/tasks?project=${ASANA_PROJECT_GID}&completed_since=now&opt_fields=name,assignee.name,due_on,completed,permalink_url&limit=50`
    );
    const tasks = (result.data || []).filter((t) => !t.completed && t.due_on === today);
    if (!tasks.length) return "No tasks due today.";
    const lines = tasks.map((t) => `• *${t.name}* — ${t.assignee?.name || "Unassigned"} — <${t.permalink_url || "#"}|view>`);
    return `*Tasks due today (${tasks.length})*\n` + lines.join("\n");
  },
  "what's due today": async (userId) => ADMIN_COMMANDS["whats due today"](userId),

  // ── Analytics queries ──
  "analytics": async () => {
    const s = getAnalyticsSummary(30);
    if (!s.total) return "No analytics data yet. Events are tracked as people use the bot.";
    const lines = [
      `*Analytics — Last ${s.days} days*`,
      `Total events: ${s.total}`,
      ``,
      `*By type:*`,
      ...Object.entries(s.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `• ${k.replace(/_/g, " ")}: ${v}`),
      ``,
      `*Top requesters:*`,
      ...s.topUsers.map(([uid, count], i) => `${i + 1}. <@${uid}> — ${count} events`),
    ];
    if (Object.keys(s.byTeam).length) {
      lines.push(``, `*By team:*`);
      lines.push(...Object.entries(s.byTeam).sort((a, b) => b[1] - a[1]).map(([k, v]) => `• ${k}: ${v}`));
    }
    lines.push(``, `Assets delivered: ${s.assetsDelivered} | Files attached: ${s.filesAttached} | Rejected: ${s.rejections}`);
    return lines.join("\n");
  },
  "analytics this week": async () => {
    const s = getAnalyticsSummary(7);
    if (!s.total) return "No events this week.";
    const lines = [
      `*Analytics — Last 7 days*`,
      `Total events: ${s.total}`,
      ``,
      `*Top requesters:*`,
      ...s.topUsers.map(([uid, count], i) => `${i + 1}. <@${uid}> — ${count} events`),
      ``,
      ...Object.entries(s.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `• ${k.replace(/_/g, " ")}: ${v}`),
    ];
    return lines.join("\n");
  },
  "top requesters": async () => {
    const s = getAnalyticsSummary(30);
    if (!s.topUsers.length) return "No request data yet.";
    return `*Top requesters — Last 30 days*\n` + s.topUsers.map(([uid, count], i) => `${i + 1}. <@${uid}> — ${count} requests`).join("\n");
  },

  // ── Usage Analytics Dashboard ──
  "analytics dashboard": async () => {
    const s = getAnalyticsSummary(90);
    if (!s.total) return "No analytics data yet.";

    const lines = [`:bar_chart: *Usage Analytics Dashboard — Last 90 days*`, ``];

    // Most common request types
    const briefs = analyticsData.events.filter(e => e.type === "brief_submitted" && e.timestamp >= new Date(Date.now() - 90 * 86400000).toISOString());
    if (briefs.length) {
      const byAsset = {};
      briefs.forEach(e => { byAsset[e.assetType || "unknown"] = (byAsset[e.assetType || "unknown"] || 0) + 1; });
      const sortedAssets = Object.entries(byAsset).sort((a, b) => b[1] - a[1]);
      lines.push(`*Most requested asset types:*`);
      const assetLabels = forms.ASSET_TYPE_LABELS || {};
      sortedAssets.forEach(([type, count]) => {
        const label = assetLabels[type] || type.replace(/_/g, " ");
        const bar = "█".repeat(Math.min(count, 20));
        lines.push(`• ${label}: ${count} ${bar}`);
      });
      lines.push(``);
    }

    // Busiest requesters
    if (s.topUsers.length) {
      lines.push(`*Busiest requesters:*`);
      s.topUsers.slice(0, 5).forEach(([uid, count], i) => {
        lines.push(`${i + 1}. <@${uid}> — ${count} events`);
      });
      lines.push(``);
    }

    // By team
    if (Object.keys(s.byTeam).length) {
      const sortedTeams = Object.entries(s.byTeam).sort((a, b) => b[1] - a[1]);
      lines.push(`*Requests by team:*`);
      sortedTeams.forEach(([team, count]) => {
        lines.push(`• ${team}: ${count}`);
      });
      lines.push(``);
    }

    // Most delivered assets (from asset_delivered events)
    const delivered = analyticsData.events.filter(e => e.type === "asset_delivered" && e.timestamp >= new Date(Date.now() - 90 * 86400000).toISOString());
    if (delivered.length) {
      const byName = {};
      delivered.forEach(e => { byName[e.assetName || "unknown"] = (byName[e.assetName || "unknown"] || 0) + 1; });
      const sortedDelivered = Object.entries(byName).sort((a, b) => b[1] - a[1]).slice(0, 5);
      lines.push(`*Most delivered assets from library:*`);
      sortedDelivered.forEach(([name, count]) => {
        lines.push(`• ${name}: ${count} time${count > 1 ? "s" : ""}`);
      });
      lines.push(``);
    }

    // Average turnaround (from Asana completed tasks if available)
    try {
      if (ASANA_PAT && ASANA_PROJECT_GID) {
        const result = await asanaRequest(
          `/tasks?project=${ASANA_PROJECT_GID}&completed_since=${new Date(Date.now() - 90 * 86400000).toISOString().split("T")[0]}&opt_fields=name,completed,completed_at,created_at,due_on,custom_fields&limit=100`
        );
        const completed = (result.data || []).filter(t => t.completed && t.completed_at && t.created_at);
        if (completed.length) {
          const turnarounds = completed.map(t => {
            const created = new Date(t.created_at);
            const done = new Date(t.completed_at);
            return Math.round((done - created) / (1000 * 60 * 60 * 24));
          }).filter(d => d >= 0 && d < 365);

          if (turnarounds.length) {
            const avg = (turnarounds.reduce((a, b) => a + b, 0) / turnarounds.length).toFixed(1);
            const median = turnarounds.sort((a, b) => a - b)[Math.floor(turnarounds.length / 2)];
            lines.push(`*Turnaround (completed tasks):*`);
            lines.push(`• ${completed.length} tasks completed in last 90 days`);
            lines.push(`• Average: ${avg} days`);
            lines.push(`• Median: ${median} days`);
            lines.push(``);
          }
        }
      }
    } catch {}

    // Summary stats
    lines.push(`*Summary:*`);
    lines.push(`• Total events: ${s.total}`);
    lines.push(`• Briefs submitted: ${s.byType["brief_submitted"] || 0}`);
    lines.push(`• Reviews submitted: ${s.byType["review_submitted"] || 0}`);
    lines.push(`• Assets delivered: ${s.assetsDelivered}`);
    lines.push(`• Files attached: ${s.filesAttached}`);
    lines.push(`• Rejections: ${s.rejections}`);

    return lines.join("\n");
  },

  // ── Whitelist management: Users ──
  "add admin": async (userId, text) => {
    const match = text.match(/<@([A-Z0-9]+)\|?[^>]*>/);
    if (!match) return "Usage: `add admin @user`";
    const targetId = match[1];
    // Remove from other tiers first
    permissions.full.users = permissions.full.users.filter((u) => u !== targetId);
    permissions.limited.users = permissions.limited.users.filter((u) => u !== targetId);
    if (!permissions.admin.users.includes(targetId)) {
      permissions.admin.users.push(targetId);
    }
    fs.writeFileSync(path.resolve(__dirname, "permissions.json"), JSON.stringify(permissions, null, 2));
    return `:white_check_mark: <@${targetId}> added as *admin*.`;
  },
  "add full": async (userId, text) => {
    const match = text.match(/<@([A-Z0-9]+)\|?[^>]*>/);
    if (!match) return "Usage: `add full @user`";
    const targetId = match[1];
    permissions.admin.users = permissions.admin.users.filter((u) => u !== targetId);
    permissions.limited.users = permissions.limited.users.filter((u) => u !== targetId);
    if (!permissions.full.users.includes(targetId)) {
      permissions.full.users.push(targetId);
    }
    fs.writeFileSync(path.resolve(__dirname, "permissions.json"), JSON.stringify(permissions, null, 2));
    return `:white_check_mark: <@${targetId}> added as *full access*.`;
  },
  "add limited": async (userId, text) => {
    const match = text.match(/<@([A-Z0-9]+)\|?[^>]*>/);
    if (!match) return "Usage: `add limited @user`";
    const targetId = match[1];
    permissions.admin.users = permissions.admin.users.filter((u) => u !== targetId);
    permissions.full.users = permissions.full.users.filter((u) => u !== targetId);
    if (!permissions.limited.users.includes(targetId)) {
      permissions.limited.users.push(targetId);
    }
    fs.writeFileSync(path.resolve(__dirname, "permissions.json"), JSON.stringify(permissions, null, 2));
    return `:white_check_mark: <@${targetId}> added as *limited access*.`;
  },
  "remove user": async (userId, text) => {
    const match = text.match(/<@([A-Z0-9]+)\|?[^>]*>/);
    if (!match) return "Usage: `remove user @user`";
    const targetId = match[1];
    permissions.admin.users = permissions.admin.users.filter((u) => u !== targetId);
    permissions.full.users = permissions.full.users.filter((u) => u !== targetId);
    permissions.limited.users = permissions.limited.users.filter((u) => u !== targetId);
    fs.writeFileSync(path.resolve(__dirname, "permissions.json"), JSON.stringify(permissions, null, 2));
    return `:white_check_mark: <@${targetId}> removed from all access tiers.`;
  },
  "list users": async () => {
    const lines = [`*User Whitelist*`];
    if (permissions.admin.users.length) {
      lines.push(`\n*Admins (${permissions.admin.users.length}):*`);
      lines.push(...permissions.admin.users.map((u) => `• <@${u}>`));
    }
    if (permissions.full.users.length) {
      lines.push(`\n*Full access (${permissions.full.users.length}):*`);
      lines.push(...permissions.full.users.map((u) => `• <@${u}>`));
    }
    if (permissions.limited.users.length) {
      lines.push(`\n*Limited access (${permissions.limited.users.length}):*`);
      lines.push(...permissions.limited.users.map((u) => `• <@${u}>`));
    }
    const total = permissions.admin.users.length + permissions.full.users.length + permissions.limited.users.length;
    lines.push(`\n_Total: ${total} users_`);
    return lines.join("\n");
  },

  // ── Whitelist management: Agencies ──
  "add agency": async (userId, text) => {
    const name = text.replace(/^add agency\s*/i, "").trim();
    if (!name) return "Usage: `add agency Agency Name`";
    const existing = matchAgency(name);
    if (existing) return `*${existing.name}* is already on the approved list.`;
    agencyWhitelist.push({ name, aliases: [], onboarded: false });
    fs.writeFileSync(path.resolve(__dirname, "agencies.json"), JSON.stringify({ approved_agencies: agencyWhitelist }, null, 2));
    return `:white_check_mark: *${name}* added to the agency whitelist (marked as not yet onboarded).`;
  },
  "remove agency": async (userId, text) => {
    const name = text.replace(/^remove agency\s*/i, "").trim();
    if (!name) return "Usage: `remove agency Agency Name`";
    const existing = matchAgency(name);
    if (!existing) return `Couldn't find *${name}* on the approved list.`;
    agencyWhitelist = agencyWhitelist.filter((a) => a.name !== existing.name);
    fs.writeFileSync(path.resolve(__dirname, "agencies.json"), JSON.stringify({ approved_agencies: agencyWhitelist }, null, 2));
    return `:white_check_mark: *${existing.name}* removed from the agency whitelist.`;
  },
  "onboard agency": async (userId, text) => {
    const name = text.replace(/^onboard agency\s*/i, "").trim();
    if (!name) return "Usage: `onboard agency Agency Name`";
    const existing = matchAgency(name);
    if (!existing) return `Couldn't find *${name}* on the approved list. Add them first with \`add agency ${name}\`.`;
    existing.onboarded = true;
    fs.writeFileSync(path.resolve(__dirname, "agencies.json"), JSON.stringify({ approved_agencies: agencyWhitelist }, null, 2));
    return `:white_check_mark: *${existing.name}* marked as onboarded.`;
  },
  "list agencies": async () => {
    if (!agencyWhitelist.length) return "No agencies on the whitelist.";
    const lines = [`*Approved Agencies (${agencyWhitelist.length})*`];
    agencyWhitelist.forEach((a) => {
      const status = a.onboarded ? ":white_check_mark: onboarded" : ":warning: not onboarded";
      const aliases = a.aliases?.length ? ` _(aka ${a.aliases.join(", ")})_` : "";
      lines.push(`• *${a.name}*${aliases} — ${status}`);
    });
    return lines.join("\n");
  },

  // ── Help ──
  "help": async () => {
    return [
      `*Admin Commands*`,
      ``,
      `*Asana:*`,
      `• \`what's due today\``,
      `• \`what's due this week\``,
      `• \`show all tasks\``,
      `• \`team tasks [team name]\` — tasks for a specific team due this week`,
      ``,
      `*Analytics:*`,
      `• \`analytics\` — 30-day summary`,
      `• \`analytics this week\` — 7-day summary`,
      `• \`analytics dashboard\` — full 90-day dashboard`,
      `• \`top requesters\` — who submits the most`,
      `• \`weekly digest\` — post the weekly digest now`,
      ``,
      `*Users:*`,
      `• \`add admin @user\``,
      `• \`add full @user\``,
      `• \`add limited @user\``,
      `• \`remove user @user\``,
      `• \`list users\``,
      ``,
      `*Agencies:*`,
      `• \`add agency Name\``,
      `• \`remove agency Name\``,
      `• \`onboard agency Name\``,
      `• \`list agencies\``,
      ``,
      `*Catalog:*`,
      `• \`debug catalog\` — asset catalog stats`,
      `• \`rescan assets\` — scan for new assets only`,
      `• \`full rescan\` — delete catalog and rebuild from scratch`,
      ``,
      `*Admin Shortcuts:*`,
      `• \`intake\` — open the creative brief form directly`,
      ``,
      `*Debug:*`,
      `• \`debug session\` / \`debug permissions\` / \`debug agencies\` / \`debug config\` / \`debug reset\``,
      `• \`version\` — show changelog and version history`,
      ``,
      `*Commands for everyone:*`,
      `• \`my tasks\` — tasks assigned to you`,
      `• \`my requests\` / \`request status\` — check status of your submissions`,
      `• \`my analytics\` — your personal 90-day activity`,
      `• \`set team [name]\` — set your team (e.g. \`set team Performance Marketing\`)`,
      `• \`my team\` — check your current team`,
    ].join("\n");
  },

  // ── Catalog management ──
  "rescan assets": async (userId, text, client) => {
    const { execFile } = require("child_process");
    const scanScript = path.resolve(__dirname, "scan-assets.js");
    const keyFile = path.resolve(__dirname, "intense-climber-490121-s1-932e831cd444.json");
    const driveFolderId = "17zbQQudoe_lFv-c5xdMELEUwt6CB0uCS";

    if (!fs.existsSync(scanScript)) return "scan-assets.js not found.";

    // Post to ops channel that scan is starting
    if (ANALYTICS_CHANNEL_ID && client) {
      try { await client.chat.postMessage({ channel: ANALYTICS_CHANNEL_ID, text: `:mag: *Asset re-scan started* by <@${userId}>` }); } catch {}
    }

    return new Promise((resolve) => {
      const args = [scanScript, driveFolderId, "--resume"];
      if (fs.existsSync(keyFile)) args.push(`--key=${keyFile}`);

      execFile("node", args, { timeout: 300000 }, (err, stdout, stderr) => {
        // Reload catalog
        try {
          const assetsFile = path.resolve(__dirname, "assets.json");
          if (fs.existsSync(assetsFile)) {
            assetCatalog = JSON.parse(fs.readFileSync(assetsFile, "utf8"));
            console.log(`[CATALOG] Reloaded: ${assetCatalog.length} assets`);
          }
        } catch (e) {
          console.error("[CATALOG] Reload failed:", e.message);
        }

        if (err) {
          console.error("[CATALOG] Scan failed:", err.message);
          resolve(`:x: Asset scan failed: ${err.message}\n\`\`\`${(stderr || "").slice(0, 500)}\`\`\``);
        } else {
          // Parse summary from stdout
          const totalMatch = stdout.match(/Total: (\d+) assets/);
          const newMatch = stdout.match(/(\d+) new\)/);
          const total = totalMatch ? totalMatch[1] : assetCatalog.length;
          const newCount = newMatch ? newMatch[1] : "?";
          resolve(`:white_check_mark: Asset scan complete. ${newCount} new assets found. Catalog now has ${total} total assets.`);
        }
      });
    });
  },

  "full rescan": async (userId, text, client) => {
    // Return a special marker — the message handler will show the confirmation
    return "__FULL_RESCAN_CONFIRM__";
  },

  // ── My Tasks (works for any user, not just admins — added to admin commands for dispatch) ──
  "my tasks": async (userId, text, client) => {
    if (!ASANA_PAT || !ASANA_PROJECT_GID) return "Asana is not configured.";
    try {
      const email = await getSlackUserEmail(client, userId);
      if (!email) return "I couldn't look up your email. Make sure the bot has the `users:read.email` scope.";

      const result = await asanaRequest(
        `/tasks?project=${ASANA_PROJECT_GID}&assignee=${encodeURIComponent(email)}&completed_since=now&opt_fields=name,due_on,custom_fields,permalink_url&limit=50`
      );

      const tasks = (result.data || []).filter((t) => !t.completed);
      if (!tasks.length) return "You have no open tasks in Brand Services Requests.";

      tasks.sort((a, b) => (a.due_on || "9999").localeCompare(b.due_on || "9999"));
      const lines = tasks.map((t) => {
        const due = t.due_on || "No due date";
        const url = t.permalink_url || "";
        return `• *${t.name}* — due ${due}${url ? ` — <${url}|view>` : ""}`;
      });

      return `*Your open tasks (${tasks.length})*\n` + lines.join("\n");
    } catch (err) {
      return `Asana query failed: ${err.message}`;
    }
  },

  // ── Ticket Status Lookup (works for any user) ──
  "my requests": async (userId, text, client) => {
    if (!ASANA_PAT || !ASANA_PROJECT_GID) return "Asana is not configured.";
    try {
      // Look up requests this user submitted by checking the task description for their Slack ID
      const result = await asanaRequest(
        `/tasks?project=${ASANA_PROJECT_GID}&completed_since=now&opt_fields=name,due_on,notes,assignee.name,completed,permalink_url,memberships.section.name&limit=100`
      );

      const tasks = (result.data || []).filter((t) => {
        if (t.completed) return false;
        // Match tasks submitted by this user (Slack ID appears in the description)
        const notes = (t.notes || "").toLowerCase();
        return notes.includes(userId.toLowerCase()) || notes.includes(`<@${userId}>`);
      });

      if (!tasks.length) {
        // Also try email match
        const email = await getSlackUserEmail(client, userId);
        if (email) {
          const emailTasks = (result.data || []).filter((t) => {
            if (t.completed) return false;
            return (t.notes || "").toLowerCase().includes(email.toLowerCase());
          });
          if (emailTasks.length) {
            emailTasks.sort((a, b) => (a.due_on || "9999").localeCompare(b.due_on || "9999"));
            const lines = emailTasks.map((t) => {
              const assignee = t.assignee?.name || "Unassigned";
              const section = t.memberships?.[0]?.section?.name || "New Requests";
              const due = t.due_on || "No due date";
              return `• *${t.name}*\n   Status: _${section}_ · Assigned to: ${assignee} · Due: ${due}${t.permalink_url ? ` · <${t.permalink_url}|view>` : ""}`;
            });
            return `*Your open requests (${emailTasks.length})*\n\n` + lines.join("\n\n");
          }
        }
        return "I couldn't find any open requests you've submitted. If you submitted recently, it may take a moment to appear.";
      }

      tasks.sort((a, b) => (a.due_on || "9999").localeCompare(b.due_on || "9999"));
      const lines = tasks.map((t) => {
        const assignee = t.assignee?.name || "Unassigned";
        const section = t.memberships?.[0]?.section?.name || "New Requests";
        const due = t.due_on || "No due date";
        return `• *${t.name}*\n   Status: _${section}_ · Assigned to: ${assignee} · Due: ${due}${t.permalink_url ? ` · <${t.permalink_url}|view>` : ""}`;
      });

      return `*Your open requests (${tasks.length})*\n\n` + lines.join("\n\n");
    } catch (err) {
      return `Asana query failed: ${err.message}`;
    }
  },

  // ── Team Tasks (admin only) ──
  "team tasks": async (userId, text, client) => {
    if (!ASANA_PAT || !ASANA_PROJECT_GID) return "Asana is not configured.";
    const teamName = text.replace(/^team tasks\s*/i, "").trim();
    if (!teamName) return "Usage: `team tasks Performance Marketing`";

    try {
      const today = new Date().toISOString().split("T")[0];
      const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

      const result = await asanaRequest(
        `/tasks?project=${ASANA_PROJECT_GID}&completed_since=now&opt_fields=name,assignee.name,due_on,custom_fields,permalink_url&limit=100`
      );

      // Find the requester team custom field GID
      const teamFieldGid = customFields.requester_team?.gid;
      let tasks = (result.data || []).filter((t) => !t.completed && t.due_on && t.due_on >= today && t.due_on <= nextWeek);

      // Filter by team custom field if we have the GID
      if (teamFieldGid) {
        tasks = tasks.filter((t) => {
          const cf = (t.custom_fields || []).find(f => f.gid === teamFieldGid);
          const cfName = cf?.enum_value?.name || "";
          return cfName.toLowerCase().includes(teamName.toLowerCase());
        });
      }

      if (!tasks.length) return `No tasks due this week for "${teamName}".`;

      tasks.sort((a, b) => (a.due_on || "9999").localeCompare(b.due_on || "9999"));
      const lines = tasks.map((t) => {
        const assignee = t.assignee?.name || "Unassigned";
        return `• *${t.name}* — ${assignee} — due ${t.due_on}${t.permalink_url ? ` — <${t.permalink_url}|view>` : ""}`;
      });

      return `*Tasks due this week for ${teamName} (${tasks.length})*\n` + lines.join("\n");
    } catch (err) {
      return `Asana query failed: ${err.message}`;
    }
  },

  // ── Weekly Digest (manual trigger for admins) ──
  "weekly digest": async () => {
    const digest = await buildWeeklyDigest();
    if (ANALYTICS_CHANNEL_ID) {
      try {
        await app.client.chat.postMessage({ channel: ANALYTICS_CHANNEL_ID, text: digest });
        return `:white_check_mark: Weekly digest posted to <#${ANALYTICS_CHANNEL_ID}>.`;
      } catch (err) {
        return `Digest built but couldn't post to channel: ${err.message}\n\n${digest}`;
      }
    }
    return digest;
  },
};

// ────────────────────────────────────────────
// Slack event handlers
// ────────────────────────────────────────────

// Permission management commands that MUST be run in #brandbot-ops
// Permission management commands — available to admins in DMs (no channel scope needed)
const CHANNEL_ONLY_COMMANDS = [];

app.message(async ({ message, say: _say, client }) => {
  // Wrap say() to suppress Slack URL preview unfurls on all bot messages
  const say = (msg) => {
    if (typeof msg === "string") return _say({ text: msg, unfurl_links: false, unfurl_media: false });
    return _say({ ...msg, unfurl_links: false, unfurl_media: false });
  };

  try {
    const isIM = message.channel_type === "im";
    const isOpsChannel = message.channel === ANALYTICS_CHANNEL_ID;

    // Only process DMs and #brandbot-ops
    if (!isIM && !isOpsChannel) return;
    if (message.subtype && message.subtype !== "file_share") return; // Allow file uploads through

    const text = (message.text || "").trim();
    const textLower = text.toLowerCase();
    const userId = message.user;

    // ── File upload handler (DM only) ──
    if (isIM && message.files && message.files.length > 0) {
      const pendingUpload = getPendingFileUpload(userId);
      if (pendingUpload) {
        const fileCount = message.files.length;
        await say(`:hourglass_flowing_sand: Attaching ${fileCount} file${fileCount > 1 ? "s" : ""} to *${pendingUpload.taskName}*...`);

        let attached = 0;
        let failed = 0;

        for (const file of message.files) {
          try {
            // Download file from Slack
            const fileInfo = await client.files.info({ file: file.id });
            const downloadUrl = fileInfo.file.url_private_download || fileInfo.file.url_private;

            if (!downloadUrl) {
              console.error(`[FILE] No download URL for ${file.name}`);
              failed++;
              continue;
            }

            const fileRes = await fetch(downloadUrl, {
              headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
            });

            if (!fileRes.ok) {
              console.error(`[FILE] Slack download failed for ${file.name}: ${fileRes.status}`);
              failed++;
              continue;
            }

            const buffer = Buffer.from(await fileRes.arrayBuffer());
            console.log(`[FILE] Downloaded ${file.name} from Slack: ${buffer.length} bytes`);

            // Upload to Asana
            await uploadFileToAsana(pendingUpload.taskGid, buffer, file.name);
            attached++;
            console.log(`[FILE] Attached ${file.name} to Asana task ${pendingUpload.taskGid}`);
          } catch (err) {
            console.error(`[FILE] Failed to attach ${file.name}:`, err.message);
            failed++;
          }
        }

        // Report results
        if (attached > 0 && failed === 0) {
          await say(`:white_check_mark: ${attached} file${attached > 1 ? "s" : ""} attached to *${pendingUpload.taskName}*.\n${pendingUpload.taskUrl ? `<${pendingUpload.taskUrl}|View in Asana>` : ""}\n\nYou can send more files within the next few minutes, or start a new request.`);
        } else if (attached > 0 && failed > 0) {
          await say(`:warning: ${attached} file${attached > 1 ? "s" : ""} attached, but ${failed} failed. You can try sending the failed ones again, or attach them directly in <${pendingUpload.taskUrl}|Asana>.`);
        } else {
          await say(`:x: Couldn't attach the file${fileCount > 1 ? "s" : ""}. You can attach them directly in <${pendingUpload.taskUrl}|Asana>.`);
        }

        postAnalytics(`:paperclip: *Files attached* by <@${userId}>\nTask: *${pendingUpload.taskName}*\nFiles: ${attached}/${fileCount} attached\n${pendingUpload.taskUrl ? `<${pendingUpload.taskUrl}|View in Asana>` : ""}`);
        trackEvent("file_attached", userId, { taskName: pendingUpload.taskName, filesAttached: attached, filesSent: fileCount });
        return;
      }
      // No pending upload — treat as a normal message (the LLM can't process files yet)
    }

    // Debug commands (available to admins)
    if (textLower.startsWith("debug ") || textLower === "debug reset") {
      if (!isAdmin(userId)) {
        await say("Debug commands are only available to admin users.");
        return;
      }
      const cmdKey = Object.keys(DEBUG_COMMANDS).find((k) => textLower === k || textLower.startsWith(k));
      if (cmdKey) {
        const result = await DEBUG_COMMANDS[cmdKey](userId);
        await say(result);
        return;
      }
      await say("Unknown debug command. Available: `debug session`, `debug permissions`, `debug agencies`, `debug config`, `debug catalog`, `debug reset`");
      return;
    }

    // "version" — show changelog (admin only)
    if (textLower === "version" && isAdmin(userId)) {
      const result = await DEBUG_COMMANDS["version"]();
      await say(result);
      return;
    }

    // Admin query commands
    if (isAdmin(userId)) {
      const adminKey = Object.keys(ADMIN_COMMANDS).find((k) => textLower === k || textLower.startsWith(k));
      if (adminKey) {
        const result = await ADMIN_COMMANDS[adminKey](userId, text, client);
        if (result === "__FULL_RESCAN_CONFIRM__") {
          await say({
            text: "Full rescan will delete the entire asset catalog and rebuild it from scratch. This takes several minutes.",
            blocks: [
              {
                type: "section",
                text: { type: "mrkdwn", text: `:warning: *Full rescan will delete the entire asset catalog* and rebuild it from scratch using AI vision analysis.\n\nThis takes several minutes and the library will be unavailable during the scan. Are you sure?` },
              },
              { type: "divider" },
              {
                type: "actions",
                elements: [{
                  type: "button",
                  text: { type: "plain_text", text: "Delete & Rebuild Catalog" },
                  style: "danger",
                  action_id: "confirm_full_rescan",
                  confirm: {
                    title: { type: "plain_text", text: "Are you absolutely sure?" },
                    text: { type: "mrkdwn", text: "This will delete all asset data and re-analyze every file in the Drive folder." },
                    confirm: { type: "plain_text", text: "Yes, delete and rebuild" },
                    deny: { type: "plain_text", text: "Cancel" },
                  },
                }],
              },
            ],
          });
        } else {
          await say(result);
        }
        return;
      }
    }

    // "my tasks" — available to ALL users (not just admins)
    if (textLower === "my tasks") {
      const result = await ADMIN_COMMANDS["my tasks"](userId, text, client);
      await say(result);
      return;
    }

    // "my requests" / "request status" — available to ALL users
    if (textLower === "my requests" || textLower === "request status" || textLower === "my request status"
        || textLower === "check my requests" || textLower === "what's the status of my request?"
        || textLower === "whats the status of my request" || textLower === "status of my request"
        || textLower === "check request status") {
      const result = await ADMIN_COMMANDS["my requests"](userId, text, client);
      await say(result);
      return;
    }

    // "set team [name]" — available to ALL users
    if (textLower.startsWith("set team ")) {
      const teamName = text.replace(/^set team\s*/i, "").trim();
      if (!teamName) { await say("Usage: `set team Performance Marketing`"); return; }
      // Validate against known teams
      const validTeams = TEAM_OPTIONS.map(t => t.text.text);
      const matched = validTeams.find(t => t.toLowerCase() === teamName.toLowerCase());
      if (matched) {
        setUserTeam(userId, matched);
        await say(`:white_check_mark: Your team has been set to *${matched}*. This will be used for your personal analytics and task queries.`);
      } else {
        setUserTeam(userId, teamName);
        await say(`:white_check_mark: Your team has been set to *${teamName}*. Note: this doesn't match a standard team name. Standard teams: ${validTeams.join(", ")}`);
      }
      return;
    }

    // "my team" — show current team
    if (textLower === "my team") {
      const team = getUserTeam(userId);
      await say(team ? `Your team is set to *${team}*. Use \`set team [name]\` to change it.` : `You haven't set a team yet. Use \`set team Performance Marketing\` (or any team name) to set it.`);
      return;
    }

    // "my analytics" — personal analytics for ANY user
    if (textLower === "my analytics") {
      const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
      const myEvents = analyticsData.events.filter(e => e.userId === userId && e.timestamp >= cutoff);
      if (!myEvents.length) { await say("No activity found for you in the last 90 days."); return; }

      const byType = {};
      myEvents.forEach(e => { byType[e.type] = (byType[e.type] || 0) + 1; });
      const team = getUserTeam(userId);

      const lines = [`:bar_chart: *Your analytics — Last 90 days*`];
      if (team) lines.push(`Team: *${team}*`);
      lines.push(`Total events: ${myEvents.length}`, ``);
      lines.push(`*By type:*`);
      Object.entries(byType).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
        lines.push(`• ${k.replace(/_/g, " ")}: ${v}`);
      });

      const briefs = myEvents.filter(e => e.type === "brief_submitted");
      if (briefs.length) {
        const byAsset = {};
        briefs.forEach(e => { byAsset[e.assetType || "unknown"] = (byAsset[e.assetType || "unknown"] || 0) + 1; });
        lines.push(``, `*Your requests by asset type:*`);
        Object.entries(byAsset).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
          const label = forms.ASSET_TYPE_LABELS[type] || type.replace(/_/g, " ");
          lines.push(`• ${label}: ${count}`);
        });
      }

      await say(lines.join("\n"));
      return;
    }

    // "intake" — admin shortcut to open creative brief directly
    if (textLower === "intake" && isAdmin(userId)) {
      const requestId = `req_${userId}_${Date.now()}`;
      pendingRequests[requestId] = {
        userId,
        toolCall: {},
        conversationSummary: "Admin direct intake",
        channel: message.channel,
        formType: "brief",
      };
      await say({
        text: "Opening the creative brief for you.",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "Here's your intake form — fill it out and it'll go straight to Asana." } },
          { type: "divider" },
          {
            type: "actions",
            elements: [{
              type: "button",
              text: { type: "plain_text", text: "Submit Creative Brief" },
              style: "primary",
              action_id: "open_brief_modal",
              value: requestId,
            }],
          },
        ],
      });
      return;
    }

    // If we're in #brandbot-ops and it's not a recognized command, ignore
    if (isOpsChannel && !isIM) return;

    // Permission check — let limited users chat but not submit
    const tier = getUserTier(userId);
    if (tier === "none") {
      await say("Hi! Brand intake is currently available to approved teams. If you need access, reach out to Brand Services.");
      return;
    }

    // Onboarding check — if user hasn't set their team, prompt them (admins skip)
    if (!isOnboarded(userId) && !isAdmin(userId)) {
      await say({
        text: "Welcome to BrandBot! Let's get you set up.",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: `:wave: *Welcome to BrandBot!*\n\nI'm the Brand Services intake advisor for HiBob. Before we get started, I need to know which team you're on.\n\nHit the button below to set up your profile — it takes 5 seconds.` },
          },
          { type: "divider" },
          {
            type: "actions",
            elements: [{
              type: "button",
              text: { type: "plain_text", text: "Get Started" },
              style: "primary",
              action_id: "start_onboarding",
            }],
          },
        ],
      });
      return;
    }

    await handleIntake({
      userId,
      text,
      say,
      channelId: message.channel,
      client,
    });
  } catch (e) {
    console.error("DM handler error:", e);
    await say("Something went wrong on my end. Mind rephrasing or trying again?");
  }
});

app.event("app_mention", async ({ event, say, client }) => {
  try {
    const text = (event.text || "").replace(/<@[^>]+>/g, "").trim();
    if (!text) {
      await say(
        "Hey! Tell me what you need — like a webinar banner, a one-pager, or a deck — and I'll point you to the fastest path."
      );
      return;
    }
    await handleIntake({
      userId: event.user,
      text,
      say,
      channelId: event.channel,
      client,
    });
  } catch (e) {
    console.error("Mention handler error:", e);
    await say("Something went wrong on my end. Mind rephrasing or trying again?");
  }
});

// ────────────────────────────────────────────
// Weekly Analytics Digest
// ────────────────────────────────────────────
async function buildWeeklyDigest() {
  const s = getAnalyticsSummary(7);
  const lines = [`:newspaper: *Weekly BrandBot Digest* — ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`, ``];

  if (!s.total) {
    lines.push("No activity this week.");
    return lines.join("\n");
  }

  // Submissions by type
  const briefs = analyticsData.events.filter(e => e.type === "brief_submitted" && e.timestamp >= new Date(Date.now() - 7 * 86400000).toISOString());
  const reviews = analyticsData.events.filter(e => e.type === "review_submitted" && e.timestamp >= new Date(Date.now() - 7 * 86400000).toISOString());
  const templates = analyticsData.events.filter(e => e.type === "template_submitted" && e.timestamp >= new Date(Date.now() - 7 * 86400000).toISOString());

  lines.push(`*Submissions this week:*`);
  lines.push(`• Creative briefs: ${briefs.length}`);
  lines.push(`• Review requests: ${reviews.length}`);
  lines.push(`• Template requests: ${templates.length}`);
  lines.push(``);

  // Asset types breakdown
  if (briefs.length) {
    const byAsset = {};
    briefs.forEach(e => { byAsset[e.assetType || "unknown"] = (byAsset[e.assetType || "unknown"] || 0) + 1; });
    const assetLabels = forms.ASSET_TYPE_LABELS || {};
    lines.push(`*By asset type:*`);
    Object.entries(byAsset).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
      lines.push(`• ${assetLabels[type] || type.replace(/_/g, " ")}: ${count}`);
    });
    lines.push(``);
  }

  // Top requesters
  if (s.topUsers.length) {
    lines.push(`*Top requesters:*`);
    s.topUsers.slice(0, 5).forEach(([uid, count], i) => {
      lines.push(`${i + 1}. <@${uid}> — ${count} events`);
    });
    lines.push(``);
  }

  // By team
  if (Object.keys(s.byTeam).length) {
    lines.push(`*By team:*`);
    Object.entries(s.byTeam).sort((a, b) => b[1] - a[1]).forEach(([team, count]) => {
      lines.push(`• ${team}: ${count}`);
    });
    lines.push(``);
  }

  // SLA performance (check Asana for tasks completed this week)
  try {
    if (ASANA_PAT && ASANA_PROJECT_GID) {
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
      const result = await asanaRequest(
        `/tasks?project=${ASANA_PROJECT_GID}&completed_since=${weekAgo}&opt_fields=name,completed,completed_at,created_at,due_on&limit=100`
      );
      const completed = (result.data || []).filter(t => t.completed && t.completed_at);
      const overdue = completed.filter(t => t.due_on && t.completed_at.split("T")[0] > t.due_on);

      if (completed.length) {
        lines.push(`*SLA performance:*`);
        lines.push(`• Tasks completed: ${completed.length}`);
        lines.push(`• On time: ${completed.length - overdue.length}`);
        lines.push(`• Late: ${overdue.length}`);
        if (overdue.length) {
          lines.push(`• Late tasks: ${overdue.map(t => t.name).join(", ")}`);
        }
        lines.push(``);
      }
    }
  } catch {}

  // Upcoming this week
  try {
    if (ASANA_PAT && ASANA_PROJECT_GID) {
      const today = new Date().toISOString().split("T")[0];
      const nextWeek = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
      const result = await asanaRequest(
        `/tasks?project=${ASANA_PROJECT_GID}&completed_since=now&opt_fields=name,due_on,assignee.name&limit=50`
      );
      const upcoming = (result.data || []).filter(t => !t.completed && t.due_on && t.due_on >= today && t.due_on <= nextWeek);
      if (upcoming.length) {
        upcoming.sort((a, b) => a.due_on.localeCompare(b.due_on));
        lines.push(`*Due this coming week (${upcoming.length}):*`);
        upcoming.slice(0, 10).forEach(t => {
          lines.push(`• *${t.name}* — ${t.assignee?.name || "Unassigned"} — due ${t.due_on}`);
        });
        if (upcoming.length > 10) lines.push(`_...and ${upcoming.length - 10} more_`);
      }
    }
  } catch {}

  lines.push(``);
  lines.push(`• Assets delivered from library: ${s.assetsDelivered}`);
  lines.push(`• Files attached to tasks: ${s.filesAttached}`);

  return lines.join("\n");
}

function scheduleWeeklyDigest() {
  // Check every hour if it's Monday 9 AM (local server time)
  const DIGEST_HOUR = 9; // 9 AM
  const DIGEST_DAY = 1;  // Monday

  let lastDigestDate = null;

  setInterval(async () => {
    const now = new Date();
    const todayStr = now.toISOString().split("T")[0];

    // Only fire once per day, on the right day, at the right hour
    if (now.getDay() === DIGEST_DAY && now.getHours() === DIGEST_HOUR && lastDigestDate !== todayStr) {
      lastDigestDate = todayStr;
      console.log("[DIGEST] Running weekly analytics digest...");
      try {
        const digest = await buildWeeklyDigest();
        if (ANALYTICS_CHANNEL_ID) {
          await app.client.chat.postMessage({
            channel: ANALYTICS_CHANNEL_ID,
            text: digest,
          });
          console.log("[DIGEST] Weekly digest posted to #brandbot-ops");
        }
      } catch (err) {
        console.error("[DIGEST] Failed:", err.message);
      }
    }
  }, 60 * 60 * 1000); // Check every hour

  console.log("Weekly digest scheduled: Mondays at 9 AM");
}

// ────────────────────────────────────────────
// Start
// ────────────────────────────────────────────
(async () => {
  await app.start();
  console.log("Brand intake bot running in Socket Mode.");
  if (!ASANA_PAT) console.warn("⚠ ASANA_PAT not set — task creation will fail.");
  if (!ASANA_PROJECT_GID) console.warn("⚠ ASANA_PROJECT_GID not set — task creation will fail.");
  scheduleWeeklyDigest();
})();
