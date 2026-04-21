#!/usr/bin/env node

/**
 * Brand Asset Catalog Generator (with AI Vision Analysis)
 * 
 * Scans a Google Drive folder recursively, analyzes each image with GPT-4o vision,
 * and generates an assets.json catalog with rich keyword tags.
 * 
 * SETUP:
 * 1. Share your Drive folder with your service account email (Viewer access)
 * 2. Get the folder ID from the Drive URL
 * 3. Run: node scan-assets.js FOLDER_ID
 * 
 * OPTIONS:
 *   --key=path/to/key.json    Service account key file
 *   --output=assets.json       Output path (default: assets.json)
 *   --preview                  Print results without saving
 *   --no-vision                Skip AI analysis (tags from names only)
 *   --resume                   Skip files already in existing assets.json
 *   --concurrency=3            Parallel vision requests (default: 3)
 */

require("dotenv").config();
const { google } = require("googleapis");
const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const folderId = args.find((a) => !a.startsWith("--"));
const keyPath = args.find((a) => a.startsWith("--key="))?.split("=")[1];
const outputPath = args.find((a) => a.startsWith("--output="))?.split("=")[1] || "assets.json";
const preview = args.includes("--preview");
const noVision = args.includes("--no-vision");
const resume = args.includes("--resume");
const concurrency = parseInt(args.find((a) => a.startsWith("--concurrency="))?.split("=")[1] || "3", 10);
const visionModel = args.find((a) => a.startsWith("--model="))?.split("=")[1] || "gpt-4o";

if (!folderId) {
  console.error("Usage: node scan-assets.js FOLDER_ID [options]\n");
  console.error("Options:");
  console.error("  --key=key.json       Service account key");
  console.error("  --output=assets.json Output file");
  console.error("  --preview            Show results without saving");
  console.error("  --no-vision          Skip AI image analysis");
  console.error("  --resume             Skip already-cataloged files");
  console.error("  --concurrency=3      Parallel requests");
  process.exit(1);
}

// ── Auth ──
function getDriveAuth() {
  let creds;
  if (keyPath) creds = JSON.parse(fs.readFileSync(keyPath, "utf8"));
  else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64) creds = JSON.parse(Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, "base64").toString("utf8"));
  else if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  else { console.error("No credentials. Use --key=key.json or set GOOGLE_SERVICE_ACCOUNT_JSON_B64"); process.exit(1); }
  console.log(`Auth: ${creds.client_email}\n`);
  return new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Vision prompt ──
const VISION_SYSTEM = `You are a brand asset librarian for HiBob, an HR technology company. Analyze this image and return ONLY a JSON object:

{
  "description": "One sentence describing what the image shows",
  "keywords": ["word1", "word2", ...],
  "concepts": ["concept1", "concept2", ...],
  "hr_modules": ["module1", ...],
  "usage_suggestions": ["suggestion1", ...],
  "style": "illustration|icon|logo|pattern|shape|photo|other",
  "mood": "warm|professional|playful|serious|energetic|calm|bold",
  "colors": ["color1", "color2", ...]
}

Rules:
- "keywords": 15-25 single words someone might search to find this image. Include literal subjects AND abstract concepts AND metaphorical associations. A rocket = rocket, speed, fast, launch, growth, progress, momentum, startup, liftoff, upward, ambition, acceleration, innovation, boost, takeoff, achievement. A person at a desk = work, office, desk, employee, remote, productivity, focus, workspace, computer, working, professional. Be VERY generous — more keywords means better search results.
- "concepts": 8-15 business/workplace concepts this could illustrate. Think broadly about what slides, emails, one-pagers, or web pages this image could support. E.g.: product launch, rapid growth, moving fast, innovation, quarterly review, team update.
- "hr_modules": Which HiBob product modules this image could represent. Choose ALL that apply from: core_hr, onboarding, time_off, time_and_attendance, performance, compensation, payroll, people_analytics, surveys, workforce_planning, hiring, benefits, culture_and_engagement, learning, your_voice, esign. E.g. a calendar icon → ["time_off", "time_and_attendance", "workforce_planning"]. A trophy → ["performance", "culture_and_engagement"]. A chart → ["people_analytics", "compensation"]. If none fit, use an empty array.
- "usage_suggestions": 5-8 specific uses like "slide about team velocity", "header for a growth report", "onboarding deck section graphic", "payroll announcement email", "performance review cycle launch".
- Be generous with keywords — include synonyms, related concepts, metaphorical uses. More is always better.
- Return ONLY valid JSON. No markdown, no backticks.`;

// ── Analyze one image ──
async function analyzeImage(drive, fileId, fileName, folderPath = []) {
  try {
    const ext = fileName.match(/\.([^.]+)$/)?.[1]?.toLowerCase() || "png";
    if (ext === "svg" || ext === "ai" || ext === "eps" || ext === "pdf") {
      return { skipped: true, reason: `${ext} not supported by vision` };
    }
    const res = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    const buffer = Buffer.from(res.data);
    if (buffer.length > 10 * 1024 * 1024) return { skipped: true, reason: "File >10MB" };

    const mimeMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
    const mimeType = mimeMap[ext] || "image/png";
    const base64 = buffer.toString("base64");

    const folderContext = folderPath.length ? `Folder: "${folderPath.join(" / ")}". ` : "";

    const response = await openai.chat.completions.create({
      model: visionModel,
      messages: [
        { role: "system", content: VISION_SYSTEM },
        { role: "user", content: [
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64}`, detail: "low" } },
          { type: "text", text: `${folderContext}File: "${fileName}". Analyze and return JSON.` },
        ]},
      ],
      max_tokens: 500,
      temperature: 0.2,
    });

    const text = (response.choices?.[0]?.message?.content || "{}").replace(/```json\s?|```/g, "").trim();
    return JSON.parse(text);
  } catch (err) {
    console.error(`    ⚠ Vision failed: ${fileName} — ${err.message}`);
    return { skipped: true, reason: err.message };
  }
}

// ── Batch processor ──
async function processBatches(items, fn, size) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    results.push(...await Promise.all(batch.map(fn)));
    if (i + size < items.length) await new Promise((r) => setTimeout(r, 500));
  }
  return results;
}

// ── Collection mapping ──
// Maps Drive folder names to canonical collections. The collection field is the
// primary filter in search — it determines WHAT pool of assets is searchable.
// Category (icon, illustration, logo, etc.) is a secondary descriptor.
const COLLECTION_RULES = [
  { match: /^ERG Logos/i,               collection: "erg_logos",          category: "logo" },
  { match: /^HiBob Logo/i,             collection: "hibob_logos",        category: "logo" },
  { match: /^Icons/i,                  collection: "icons",              category: "icon" },
  { match: /^Illustrations/i,          collection: "illustrations",      category: "illustration" },
  { match: /^HiBob anniversaries/i,    collection: "anniversaries",      category: "illustration" },
  { match: /^Linkedin Profile/i,       collection: "linkedin_covers",    category: "background" },
  { match: /^Zoom background/i,        collection: "zoom_backgrounds",   category: "background" },
  { match: /^Desktop Screensaver/i,    collection: "screensavers",       category: "background" },
  { match: /^HiBob Brand Guidelines/i, collection: "brand_guidelines",   category: "asset" },
];

function resolveCollection(folderPath) {
  const topFolder = (folderPath[0] || "").trim();
  for (const rule of COLLECTION_RULES) {
    if (rule.match.test(topFolder)) {
      return { collection: rule.collection, category: rule.category };
    }
  }
  return { collection: "general", category: null }; // null = let vision or name decide
}

// ── Name-based tags ──
function nameTags(fileName, folderPath) {
  const words = [fileName.replace(/\.[^.]+$/, ""), ...folderPath].join(" ").split(/[\s_\-–—.]+/).map((w) => w.toLowerCase()).filter((w) => w.length > 1);
  const noise = new Set(["the", "and", "for", "with", "from", "png", "svg", "jpg", "jpeg", "pdf", "ai", "eps", "copy", "final", "v2", "v3"]);
  return [...new Set(words)].filter((t) => !noise.has(t));
}

function categorize(fileName, folderPath) {
  const t = [fileName, ...folderPath].join(" ").toLowerCase();
  if (t.includes("logo")) return "logo";
  if (t.includes("icon")) return "icon";
  if (t.includes("illustration") || t.includes("spot") || t.includes("illo")) return "illustration";
  if (t.includes("pattern") || t.includes("texture")) return "pattern";
  if (t.includes("shape")) return "shape";
  if (t.includes("photo")) return "photography";
  if (t.includes("background") || t.includes("zoom")) return "background";
  return "asset";
}

// ── Scan folders recursively ──
async function scanFolder(drive, id, folderPath = []) {
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${id}' in parents and trashed = false`,
      fields: "nextPageToken, files(id, name, mimeType, size, webViewLink, thumbnailLink, createdTime)",
      pageSize: 100, pageToken,
    });
    for (const f of res.data.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        console.log(`  📁 ${[...folderPath, f.name].join(" / ")}`);
        files.push(...await scanFolder(drive, f.id, [...folderPath, f.name]));
      } else if (/\.(png|jpg|jpeg|svg|pdf|ai|eps|gif|webp)$/i.test(f.name) || f.mimeType?.startsWith("image/")) {
        files.push({ ...f, folderPath });
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return files;
}

// ── Build asset entry ──
function buildEntry(file, vision) {
  const ext = file.name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() || "unknown";
  const nt = nameTags(file.name, file.folderPath);
  const folderCat = categorize(file.name, file.folderPath);
  const hasVision = vision && !vision.skipped;

  // Resolve collection from folder — this is authoritative
  const { collection, category: collectionCategory } = resolveCollection(file.folderPath);

  // Category priority: collection rule > folder-based categorize() > vision guess
  const category = collectionCategory || folderCat || (hasVision ? (vision.style || "asset") : "asset");

  const allTags = hasVision ? [...new Set([...nt, ...(vision.keywords || []).map((k) => k.toLowerCase())])] : nt;

  return {
    name: file.name.replace(/\.[^.]+$/, ""),
    file: file.name,
    file_id: file.id,
    collection,
    category,
    tags: allTags,
    keywords: hasVision ? (vision.keywords || nt) : nt,
    concepts: hasVision ? (vision.concepts || []) : [],
    usage_suggestions: hasVision ? (vision.usage_suggestions || []) : [],
    hr_modules: hasVision ? (vision.hr_modules || []) : [],
    description: hasVision ? (vision.description || "") : "",
    style: hasVision ? (vision.style || category) : category,
    mood: hasVision ? (vision.mood || "") : "",
    colors: hasVision ? (vision.colors || []) : [],
    format: ext,
    folder: file.folderPath.join(" / ") || "root",
    drive_link: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
    download_link: `https://drive.google.com/uc?export=download&id=${file.id}`,
    thumbnail: file.thumbnailLink || null,
    created: file.createdTime || null,
    vision_analyzed: hasVision,
  };
}

// ── Main ──
async function main() {
  const auth = getDriveAuth();
  const drive = google.drive({ version: "v3", auth });

  console.log(`Scanning: ${folderId}`);
  console.log(`Vision: ${noVision ? "OFF" : `ON (${visionModel}, concurrency: ${concurrency})`}`);
  console.log("─".repeat(60));

  let existingIds = new Set();
  if (resume && fs.existsSync(outputPath)) {
    existingIds = new Set(JSON.parse(fs.readFileSync(outputPath, "utf8")).map((a) => a.file_id));
    console.log(`Resuming: ${existingIds.size} already cataloged\n`);
  }

  console.log("Phase 1: Scanning folders...\n");
  const allFiles = await scanFolder(drive, folderId);
  const files = resume ? allFiles.filter((f) => !existingIds.has(f.id)) : allFiles;
  console.log(`\n  Found ${allFiles.length} assets (${files.length} new)\n`);

  let analyzed = 0, skipped = 0;
  const assets = [];

  if (noVision) {
    console.log("Phase 2: Tags from names only...\n");
    for (const f of files) assets.push(buildEntry(f, null));
  } else {
    console.log("Phase 2: AI vision analysis...\n");
    const results = await processBatches(files, async (f) => {
      const vision = await analyzeImage(drive, f.id, f.name, f.folderPath);
      if (vision.skipped) { skipped++; process.stdout.write(`  ⏭ ${f.name} (${vision.reason})\n`); }
      else { analyzed++; process.stdout.write(`  ✅ ${f.name} → ${(vision.keywords||[]).length} keywords\n`); }
      return buildEntry(f, vision);
    }, concurrency);
    assets.push(...results);
  }

  // Merge with existing
  let final = assets;
  if (resume && fs.existsSync(outputPath)) {
    final = [...JSON.parse(fs.readFileSync(outputPath, "utf8")), ...assets];
  }

  // Summary
  console.log("\n" + "─".repeat(60));
  console.log(`Total: ${final.length} assets`);
  if (!noVision) console.log(`  Analyzed: ${analyzed} | Skipped: ${skipped}`);

  const byCat = {};
  final.forEach((a) => { byCat[a.category] = (byCat[a.category] || 0) + 1; });
  console.log("\nBy category:");
  Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${c}: ${n}`));

  const byCol = {};
  final.forEach((a) => { byCol[a.collection || "general"] = (byCol[a.collection || "general"] || 0) + 1; });
  console.log("\nBy collection:");
  Object.entries(byCol).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${c}: ${n}`));

  const sample = final.find((a) => a.vision_analyzed);
  if (sample) {
    console.log("\n── Sample ──");
    console.log(`  ${sample.name}`);
    console.log(`  "${sample.description}"`);
    console.log(`  Keywords: ${sample.keywords.join(", ")}`);
    console.log(`  Concepts: ${sample.concepts.join(", ")}`);
    console.log(`  Usage: ${sample.usage_suggestions.join(", ")}`);
  }

  if (preview) {
    console.log("\n── First 3 assets ──");
    console.log(JSON.stringify(final.slice(0, 3), null, 2));
  } else {
    fs.writeFileSync(outputPath, JSON.stringify(final, null, 2));
    console.log(`\n✅ Saved to ${outputPath} (${final.length} assets)`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  if (err.message.includes("404")) console.error("Folder not found — share it with the service account.");
  process.exit(1);
});
