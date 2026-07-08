// ────────────────────────────────────────────
// review.js — Brand Compliance Review Engine
// ────────────────────────────────────────────
// Self-contained scoring engine for the file-intake brand review feature.
//
// Design (matches the v1.4 single-decision philosophy):
//   • DETERMINISTIC tiers (measured in code, not guessed): color palette
//     compliance via perceptual ΔE against the brand palette, and — when a
//     PDF embeds real fonts — font-family compliance.
//   • JUDGMENT tiers (scored by GPT-4o vision against an anchored rubric):
//     imagery, composition, and the overall design bar.
//
// The code computes the objective signals FIRST and feeds them to the vision
// model as context, but the aggregate always uses the deterministic color
// score — the model never overrides a measured value.
//
// Nothing here writes to disk or talks to Slack; index.js owns persistence,
// the registry, delivery, and certificate rendering. This module is pure
// scoring + rasterisation so it stays easy to test in isolation.

const sharp = require("sharp");

// ── Brand source of truth (mirror of the system-prompt brand knowledge) ──
const BRAND_PALETTE = [
  { name: "Cherry Syrup",    rgb: [238, 22, 79] },
  { name: "Dark Wine",       rgb: [131, 20, 61] },
  { name: "Orange Juice",    rgb: [250, 163, 43] },
  { name: "Cappuccino Foam", rgb: [253, 246, 235] },
  { name: "Black Coffee",    rgb: [58, 58, 55] },
];

// Fonts we consider on-brand (brand faces + their sanctioned Google substitutes).
// Matching is case-insensitive substring against extracted BaseFont names.
const BRAND_FONTS = ["champion", "sentinel", "gotham", "archivo", "domine", "lato"];

// ── Scoring policy (all tunable — these are the knobs Casey owns) ──
const WEIGHTS = { colors: 20, fonts: 15, imagery: 20, composition: 20, design_bar: 25 };
const PASS_THRESHOLD = 90;          // overall must be ≥ this AND no gate failure
const COLOR_DELTAE_TOLERANCE = 12;  // ΔE below this = "on palette"
const COLOR_GATE_MIN_RATIO = 0.6;   // <60% of coloured pixels on-brand = gate fail
const MAX_VISION_PAGES = 5;         // cap pages sent to vision (cost control)
const VISION_MAX_DIM = 1568;        // downscale long edge before sending to vision

const BANDS = [
  { min: 90, key: "cleared",      label: "Cleared for Live",  emoji: ":white_check_mark:" },
  { min: 75, key: "minor",        label: "Minor Revisions",   emoji: ":large_yellow_circle:" },
  { min: 50, key: "major",        label: "Major Revisions",   emoji: ":large_orange_circle:" },
  { min: 0,  key: "not_on_brand", label: "Not On-Brand",      emoji: ":red_circle:" },
];

// ────────────────────────────────────────────
// Colour: perceptual ΔE (CIE76) against the brand palette
// ────────────────────────────────────────────
function rgb2lab([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const lin = (c) => (c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92);
  r = lin(r); g = lin(g); b = lin(b);
  let x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  let y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1.0;
  let z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function deltaE(a, b) {
  const A = rgb2lab(a), B = rgb2lab(b);
  return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}
// Near-greyscale pixels (white/black/greys) are neutral — never penalised.
function isNeutral(r, g, b) {
  return Math.max(r, g, b) - Math.min(r, g, b) < 18;
}
function hex([r, g, b]) {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

async function extractPalette(buffer, buckets = 6) {
  const { data } = await sharp(buffer)
    .resize(80, 80, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const map = new Map();
  for (let i = 0; i < data.length; i += 3) {
    const key = `${data[i] & 0xe0},${data[i + 1] & 0xe0},${data[i + 2] & 0xe0}`;
    const e = map.get(key) || { count: 0, r: 0, g: 0, b: 0 };
    e.count++; e.r += data[i]; e.g += data[i + 1]; e.b += data[i + 2];
    map.set(key, e);
  }
  const total = Array.from(map.values()).reduce((s, e) => s + e.count, 0) || 1;
  return Array.from(map.values())
    .map((e) => ({
      rgb: [Math.round(e.r / e.count), Math.round(e.g / e.count), Math.round(e.b / e.count)],
      share: e.count / total,
    }))
    .sort((a, b) => b.share - a.share)
    .slice(0, buckets);
}

// Score colours across one or more page buffers (PDF pages / a single image).
async function scoreColors(buffers) {
  let onBrand = 0, offBrand = 0, neutral = 0;
  const findings = [];
  for (const buf of buffers) {
    const palette = await extractPalette(buf);
    for (const c of palette) {
      if (isNeutral(...c.rgb)) { neutral += c.share; continue; }
      let best = null, bestD = Infinity;
      for (const bp of BRAND_PALETTE) {
        const d = deltaE(c.rgb, bp.rgb);
        if (d < bestD) { bestD = d; best = bp; }
      }
      if (bestD <= COLOR_DELTAE_TOLERANCE) {
        onBrand += c.share;
        findings.push(`on-brand ${hex(c.rgb)} ≈ ${best.name} (ΔE ${bestD.toFixed(1)})`);
      } else {
        offBrand += c.share;
        findings.push(`OFF-PALETTE ${hex(c.rgb)} — nearest ${best.name}, ΔE ${bestD.toFixed(1)}`);
      }
    }
  }
  const colored = onBrand + offBrand;
  const ratio = colored > 0 ? onBrand / colored : 1; // all-neutral art passes colour
  const score = Math.round(ratio * 100);
  const gate = ratio >= COLOR_GATE_MIN_RATIO ? "pass" : "fail";
  return { score, gate, ratio, findings: findings.slice(0, 10), deterministic: true };
}

// ────────────────────────────────────────────
// Fonts: deterministic ONLY for embedded PDF fonts; otherwise vision-advisory
// ────────────────────────────────────────────
async function extractPdfFonts(pdfBuffer) {
  try {
    const path = require("path");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    let standardFontDataUrl;
    try {
      standardFontDataUrl = path.dirname(require.resolve("pdfjs-dist/package.json")) + "/standard_fonts/";
    } catch { /* optional */ }
    const data = new Uint8Array(pdfBuffer);
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false, standardFontDataUrl }).promise;
    const names = new Set();
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      await page.getOperatorList(); // forces fonts into commonObjs
      const co = page.commonObjs;
      if (co && co._objs) {
        for (const k of Object.keys(co._objs)) {
          const d = co._objs[k]?.data;
          const nm = d && (d.name || d.loadedName);
          if (nm) names.add(String(nm).replace(/^[A-Z]{6}\+/, "")); // strip subset prefix
        }
      }
    }
    return Array.from(names).filter((n) => n && !/^(sans-serif|serif|monospace)$/i.test(n));
  } catch {
    return []; // any failure → fall back to vision-advisory
  }
}

function scoreFontsFromNames(fontNames) {
  const onBrand = [], offBrand = [];
  for (const n of fontNames) {
    const low = n.toLowerCase();
    if (BRAND_FONTS.some((bf) => low.includes(bf))) onBrand.push(n);
    else offBrand.push(n);
  }
  const total = onBrand.length + offBrand.length;
  const score = total === 0 ? 100 : Math.round((onBrand.length / total) * 100);
  const gate = offBrand.length === 0 ? "pass" : "fail";
  return {
    score, gate, deterministic: true,
    findings: [
      onBrand.length ? `on-brand fonts: ${onBrand.join(", ")}` : null,
      offBrand.length ? `OFF-BRAND fonts: ${offBrand.join(", ")}` : null,
    ].filter(Boolean),
  };
}

// ────────────────────────────────────────────
// Image prep for vision
// ────────────────────────────────────────────
async function toVisionDataUrl(buffer) {
  const out = await sharp(buffer)
    .resize(VISION_MAX_DIM, VISION_MAX_DIM, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

// ────────────────────────────────────────────
// Vision rubric + tool schema (judgment tiers)
// ────────────────────────────────────────────
function buildRubric(colorSummary, fontContext, userGuidance) {
  return `You are HiBob's Brand Compliance Reviewer. You are strict and specific — this review gates whether work goes live, so vague praise is worse than useless. Score against HiBob's brand, not generic design taste.

HIBOB BRAND REFERENCE
Colours (the ONLY on-brand colours): Cherry Syrup #EE164F, Dark Wine #83143D, Orange Juice #FAA32B, Cappuccino Foam #FDF6EB, Black Coffee #3A3A37. Neutral white/black/grey are always acceptable.
Type: Champion (display/headlines), Sentinel (serif body/editorial), Gotham (sans workhorse/UI). Sanctioned web substitutes: Archivo (→Champion), Domine (→Sentinel), Lato (→Gotham). Any other typeface is off-brand.
Voice: confident, warm, human, never generic B2B filler.

MEASURED COLOUR ANALYSIS (deterministic — trust this over your own eye for colour):
${colorSummary}

FONT CONTEXT:
${fontContext}

You score ONLY these three tiers (0–100 each), using the anchors:
• imagery — photography/illustration/iconography on-brand? HiBob uses warm, human, characterful imagery and its own illustration style; generic stock photography, clip-art, or off-style AI imagery scores low. 90+ = clearly HiBob's visual language; 70s = acceptable but generic; below 50 = wrong style or off-brand imagery.
• composition — layout, hierarchy, spacing, alignment, balance, logo clear-space and safe usage. 90+ = clean, intentional, professional hierarchy; 70s = readable but loose; below 50 = cluttered, misaligned, broken hierarchy, or logo misuse.
• design_bar — the honest "does this look good and make sense, would HiBob ship this?" judgment. Consider craft, polish, clarity of message, and whether it holds up next to HiBob's best work. Be willing to score below 50 for work that simply is not good enough to go live.

${userGuidance ? `ADDITIONAL REVIEW GUIDANCE FROM THE REQUESTER (weight heavily):\n${userGuidance}\n` : ""}
For each tier give a 0–100 score and 1–3 concrete, actionable findings (what specifically is wrong or right — reference what you see). Also give a one-line overall read. Call the brand_review tool exactly once.`;
}

const BRAND_REVIEW_TOOL = {
  type: "function",
  function: {
    name: "brand_review",
    description: "Return structured brand-compliance scores for the submitted artwork.",
    parameters: {
      type: "object",
      properties: {
        imagery: {
          type: "object",
          properties: {
            score: { type: "integer", minimum: 0, maximum: 100 },
            findings: { type: "array", items: { type: "string" }, maxItems: 3 },
          },
          required: ["score", "findings"],
        },
        composition: {
          type: "object",
          properties: {
            score: { type: "integer", minimum: 0, maximum: 100 },
            findings: { type: "array", items: { type: "string" }, maxItems: 3 },
          },
          required: ["score", "findings"],
        },
        design_bar: {
          type: "object",
          properties: {
            score: { type: "integer", minimum: 0, maximum: 100 },
            findings: { type: "array", items: { type: "string" }, maxItems: 3 },
          },
          required: ["score", "findings"],
        },
        fonts_observed: {
          type: "array",
          items: { type: "string" },
          description: "Typefaces you can visually identify, if any. Advisory only.",
        },
        overall_read: { type: "string", description: "One-line honest summary." },
      },
      required: ["imagery", "composition", "design_bar", "overall_read"],
    },
  },
};

async function runVisionReview({ openai, model, pageBuffers, colorResult, fontContext, userGuidance }) {
  const colorSummary =
    `Dominant colours were measured perceptually. On-brand colour share: ${(colorResult.ratio * 100).toFixed(0)}%.\n` +
    colorResult.findings.map((f) => `  - ${f}`).join("\n");

  const images = [];
  for (const buf of pageBuffers.slice(0, MAX_VISION_PAGES)) {
    images.push({ type: "image_url", image_url: { url: await toVisionDataUrl(buf) } });
  }

  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: "system", content: buildRubric(colorSummary, fontContext, userGuidance) },
      {
        role: "user",
        content: [
          { type: "text", text: "Review this artwork against the HiBob brand and call brand_review." },
          ...images,
        ],
      },
    ],
    tools: [BRAND_REVIEW_TOOL],
    tool_choice: { type: "function", function: { name: "brand_review" } },
    temperature: 0.1,
    max_tokens: 900,
  });

  const tc = resp.choices?.[0]?.message?.tool_calls?.[0];
  if (!tc) throw new Error("Vision model did not return a brand_review tool call");
  return JSON.parse(tc.function.arguments);
}

// ────────────────────────────────────────────
// Aggregation + banding
// ────────────────────────────────────────────
function aggregate({ colors, fonts, imagery, composition, design_bar, gates }) {
  const raw =
    colors * WEIGHTS.colors +
    fonts * WEIGHTS.fonts +
    imagery * WEIGHTS.imagery +
    composition * WEIGHTS.composition +
    design_bar * WEIGHTS.design_bar;
  const totalWeight = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  let overall = Math.round(raw / totalWeight);

  const gateFailed = Object.values(gates).some((g) => g === "fail");
  // A hard-gate failure caps the overall below the pass line regardless of aesthetics.
  if (gateFailed) overall = Math.min(overall, PASS_THRESHOLD - 1);

  let band = BANDS.find((b) => overall >= b.min);
  // A gate failure means the work cannot ship — never let it read as Cleared or
  // Minor Revisions, even if the aesthetic tiers scored high. Floor to Major.
  if (gateFailed && (band.key === "cleared" || band.key === "minor")) {
    band = BANDS.find((b) => b.key === "major");
  }
  const cleared = overall >= PASS_THRESHOLD && !gateFailed;
  return { overall, band, cleared, gateFailed };
}

// ────────────────────────────────────────────
// Public entry point
// ────────────────────────────────────────────
// opts: { openai, model, fileBuffer, fileName, mimeType, userGuidance }
// returns a full result object (index.js persists it + renders the cert/report)
async function runBrandReview({ openai, model, fileBuffer, fileName, mimeType, userGuidance }) {
  const isPdf = /pdf$/i.test(mimeType) || /\.pdf$/i.test(fileName || "");

  // 1) Get page buffers (rasterise PDFs; single image otherwise)
  let pageBuffers = [];
  let pdfFontNames = [];
  if (isPdf) {
    const { pdf } = await import("pdf-to-img"); // lazy — feature degrades if uninstalled
    const doc = await pdf(fileBuffer, { scale: 2 });
    for await (const page of doc) {
      pageBuffers.push(page);
      if (pageBuffers.length >= MAX_VISION_PAGES) break;
    }
    pdfFontNames = await extractPdfFonts(fileBuffer);
  } else {
    pageBuffers = [fileBuffer];
  }
  if (!pageBuffers.length) throw new Error("Could not read any pages/images from the file");

  // 2) Deterministic colour score (always)
  const colorResult = await scoreColors(pageBuffers);

  // 3) Fonts — deterministic if we extracted real embedded names, else vision-advisory
  let fontResult, fontContext;
  if (pdfFontNames.length) {
    fontResult = scoreFontsFromNames(pdfFontNames);
    fontContext = `Embedded fonts extracted from the PDF (authoritative): ${pdfFontNames.join(", ")}. This tier is deterministically gated.`;
  } else {
    fontContext = isPdf
      ? "No embedded font names could be read (standard/system fonts). Assess typography visually — advisory only, not gated."
      : "Raster image — assess typography visually. Advisory only, not gated.";
    fontResult = { deterministic: false }; // score filled from vision below
  }

  // 4) Vision judgment tiers
  const vision = await runVisionReview({
    openai, model, pageBuffers, colorResult, fontContext, userGuidance,
  });

  // If fonts weren't deterministic, derive an advisory score from what vision saw.
  if (!fontResult.deterministic) {
    const observed = vision.fonts_observed || [];
    const off = observed.filter((n) => !BRAND_FONTS.some((bf) => n.toLowerCase().includes(bf)));
    const score = observed.length === 0 ? 80 : Math.round(((observed.length - off.length) / observed.length) * 100);
    fontResult = {
      score, gate: "n/a", deterministic: false,
      findings: observed.length
        ? [`visually identified (advisory): ${observed.join(", ")}`, off.length ? `possible off-brand: ${off.join(", ")}` : null].filter(Boolean)
        : ["no typefaces confidently identified — flag for human check"],
    };
  }

  // 5) Aggregate + band
  const scores = {
    colors: colorResult.score,
    fonts: fontResult.score,
    imagery: vision.imagery.score,
    composition: vision.composition.score,
    design_bar: vision.design_bar.score,
  };
  const gates = { colors: colorResult.gate, fonts: fontResult.deterministic ? fontResult.gate : "n/a" };
  const { overall, band, cleared, gateFailed } = aggregate({ ...scores, gates });

  return {
    scores,
    gates,
    overall,
    band: band.key,
    bandLabel: band.label,
    bandEmoji: band.emoji,
    cleared,
    gateFailed,
    guidelinesVersion: GUIDELINES_VERSION,
    pageCount: pageBuffers.length,
    detail: {
      colors: colorResult,
      fonts: fontResult,
      imagery: vision.imagery,
      composition: vision.composition,
      design_bar: vision.design_bar,
      overall_read: vision.overall_read,
    },
  };
}

// Bump this whenever the rubric/palette/fonts change so old certs are detectable as stale.
const GUIDELINES_VERSION = "2026-05-BR1";

module.exports = {
  runBrandReview,
  // exported for reuse / testing
  scoreColors,
  extractPdfFonts,
  aggregate,
  WEIGHTS,
  PASS_THRESHOLD,
  BANDS,
  GUIDELINES_VERSION,
  BRAND_PALETTE,
  BRAND_FONTS,
};
