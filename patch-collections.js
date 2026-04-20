#!/usr/bin/env node

/**
 * Patch existing assets.json with collection and corrected category fields.
 * Run this ONCE to update the catalog without a full rescan.
 * 
 * Usage: node patch-collections.js [--preview]
 */

const fs = require("fs");
const path = require("path");

const preview = process.argv.includes("--preview");
const assetsPath = path.resolve(__dirname, "assets.json");

if (!fs.existsSync(assetsPath)) {
  console.error("No assets.json found.");
  process.exit(1);
}

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

function resolveCollection(folder) {
  const topFolder = (folder || "").split(" / ")[0].trim();
  for (const rule of COLLECTION_RULES) {
    if (rule.match.test(topFolder)) {
      return { collection: rule.collection, category: rule.category };
    }
  }
  return { collection: "general", category: null };
}

const assets = JSON.parse(fs.readFileSync(assetsPath, "utf8"));
let patched = 0;
let categoryFixed = 0;

for (const asset of assets) {
  const { collection, category } = resolveCollection(asset.folder);
  
  if (!asset.collection || asset.collection !== collection) {
    asset.collection = collection;
    patched++;
  }
  
  // Fix category if folder rule overrides vision guess
  if (category && asset.category !== category) {
    const old = asset.category;
    asset.category = category;
    categoryFixed++;
    if (preview) {
      console.log(`  FIX: ${asset.name} — ${old} → ${category} (${collection})`);
    }
  }
}

// Summary
const byCol = {};
assets.forEach((a) => { byCol[a.collection] = (byCol[a.collection] || 0) + 1; });
const byCat = {};
assets.forEach((a) => { byCat[a.category] = (byCat[a.category] || 0) + 1; });

console.log(`\nTotal assets: ${assets.length}`);
console.log(`Collections added: ${patched}`);
console.log(`Categories corrected: ${categoryFixed}`);
console.log(`\nBy collection:`);
Object.entries(byCol).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${c}: ${n}`));
console.log(`\nBy category:`);
Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`  ${c}: ${n}`));

if (preview) {
  console.log("\n[Preview mode — no changes saved]");
} else {
  fs.writeFileSync(assetsPath, JSON.stringify(assets, null, 2));
  console.log(`\n✅ Saved patched assets.json`);
}
