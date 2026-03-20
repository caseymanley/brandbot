// ────────────────────────────────────────────
// Dynamic Multi-Step Creative Intake Forms
// ────────────────────────────────────────────

// Asset type options for Step 1 dropdown
const ASSET_TYPE_OPTIONS = [
  { text: { type: "plain_text", text: "Banners & Social Ads" }, value: "banners_social_ads" },
  { text: { type: "plain_text", text: "Video" }, value: "video" },
  { text: { type: "plain_text", text: "Artwork (Illustration & Custom Graphics)" }, value: "artwork" },
  { text: { type: "plain_text", text: "One-Pager" }, value: "one_pager" },
  { text: { type: "plain_text", text: "Deck & Presentation" }, value: "deck" },
  { text: { type: "plain_text", text: "Print (Swag & Events)" }, value: "print" },
  { text: { type: "plain_text", text: "Content Review" }, value: "content_review" },
  { text: { type: "plain_text", text: "Campaign System (Strategic)" }, value: "campaign_system" },
];

const PRIORITY_OPTIONS = [
  { text: { type: "plain_text", text: "Low" }, value: "low" },
  { text: { type: "plain_text", text: "Standard" }, value: "standard" },
  { text: { type: "plain_text", text: "High" }, value: "high" },
  { text: { type: "plain_text", text: "Urgent (requires manager approval)" }, value: "urgent" },
];

const NET_NEW_OPTIONS = [
  { text: { type: "plain_text", text: "Net new asset" }, value: "net_new" },
  { text: { type: "plain_text", text: "Revision of existing asset" }, value: "revision" },
];

const PLACEMENT_OPTIONS = [
  { text: { type: "plain_text", text: "Slide deck / presentation" }, value: "slide_deck" },
  { text: { type: "plain_text", text: "Document / report / one-pager" }, value: "document" },
  { text: { type: "plain_text", text: "Web page / landing page" }, value: "web_page" },
  { text: { type: "plain_text", text: "Email / newsletter" }, value: "email" },
  { text: { type: "plain_text", text: "Social media" }, value: "social" },
  { text: { type: "plain_text", text: "Blog post / article" }, value: "blog" },
  { text: { type: "plain_text", text: "Event signage / collateral" }, value: "event_signage" },
  { text: { type: "plain_text", text: "Paid media / ad platform" }, value: "paid_media" },
  { text: { type: "plain_text", text: "Other" }, value: "other" },
];

const VISIBILITY_OPTIONS = [
  { text: { type: "plain_text", text: "Customer-facing" }, value: "customer" },
  { text: { type: "plain_text", text: "Prospect-facing" }, value: "prospect" },
  { text: { type: "plain_text", text: "Partner-facing" }, value: "partner" },
  { text: { type: "plain_text", text: "Analyst / influencer-facing" }, value: "analyst" },
  { text: { type: "plain_text", text: "Internal only" }, value: "internal" },
];

// ── Step 1: Standard Fields ──
function buildStep1Blocks(prefillName = "", lockedAssetType = null) {
  const blocks = [
    {
      type: "section",
      text: { type: "mrkdwn", text: "*Step 1 of 2* — Project details" },
    },
    { type: "divider" },
    {
      type: "input", block_id: "name_block",
      label: { type: "plain_text", text: "Title" },
      hint: { type: "plain_text", text: "Clear, descriptive name (e.g., 'Q3 Webinar Promo — LinkedIn Paid')." },
      element: {
        type: "plain_text_input", action_id: "name_input",
        ...(prefillName && prefillName.length < 100 ? { initial_value: prefillName } : {}),
      },
    },
  ];

  if (lockedAssetType) {
    // Asset type was determined by conversation — show as locked read-only
    const label = ASSET_TYPE_LABELS[lockedAssetType] || lockedAssetType;
    blocks.push(
      {
        type: "section", block_id: "asset_type_locked_block",
        text: { type: "mrkdwn", text: `*Asset Type*\n${label}` },
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: ":lock: _Pre-selected based on your conversation with BrandBot_" }],
      }
    );
  } else {
    // No context — show the normal dropdown
    blocks.push({
      type: "input", block_id: "asset_type_block",
      label: { type: "plain_text", text: "Asset Type" },
      hint: { type: "plain_text", text: "Determines which fields appear next." },
      element: {
        type: "static_select", action_id: "asset_type_input",
        options: ASSET_TYPE_OPTIONS,
      },
    });
  }

  blocks.push(
    {
      type: "input", block_id: "team_block",
      label: { type: "plain_text", text: "Team" },
      element: { type: "static_select", action_id: "team_input", options: null }, // TEAM_OPTIONS injected at runtime
    },
    {
      type: "input", block_id: "date_block",
      label: { type: "plain_text", text: "Requested due date" },
      element: { type: "datepicker", action_id: "date_input" },
    },
    {
      type: "input", block_id: "priority_block",
      label: { type: "plain_text", text: "Priority" },
      element: { type: "static_select", action_id: "priority_input", options: PRIORITY_OPTIONS },
    },
    {
      type: "input", block_id: "net_new_block",
      label: { type: "plain_text", text: "Net new or revision?" },
      element: { type: "static_select", action_id: "net_new_input", options: NET_NEW_OPTIONS },
    },
  );

  return blocks;
}

// ── Step 2: Shared Fields (all asset types) ──
function buildSharedBlocks() {
  return [
    {
      type: "input", block_id: "context_block",
      label: { type: "plain_text", text: "Context" },
      hint: { type: "plain_text", text: "Is this part of a campaign, launch, or initiative? Note dependencies." },
      element: { type: "plain_text_input", action_id: "context_input", multiline: true },
    },
    {
      type: "input", block_id: "placement_block",
      label: { type: "plain_text", text: "Placement" },
      hint: { type: "plain_text", text: "Where will this asset live?" },
      element: { type: "static_select", action_id: "placement_input", options: PLACEMENT_OPTIONS },
    },
    {
      type: "input", block_id: "goal_block",
      label: { type: "plain_text", text: "Goal" },
      hint: { type: "plain_text", text: "What should this accomplish? How will success be measured?" },
      element: { type: "plain_text_input", action_id: "goal_input", multiline: true },
    },
    {
      type: "input", block_id: "visibility_block",
      label: { type: "plain_text", text: "Visibility" },
      element: { type: "static_select", action_id: "visibility_input", options: VISIBILITY_OPTIONS },
    },
    {
      type: "input", block_id: "audience_block",
      label: { type: "plain_text", text: "Target audience" },
      hint: { type: "plain_text", text: "Industry, company size, persona, region — the more detail, the better." },
      element: { type: "plain_text_input", action_id: "audience_input", multiline: true },
      optional: true,
    },
    {
      type: "input", block_id: "message_block",
      label: { type: "plain_text", text: "Key message" },
      hint: { type: "plain_text", text: "The single most important takeaway. One to two sentences max." },
      element: { type: "plain_text_input", action_id: "message_input", multiline: true },
    },
    {
      type: "input", block_id: "mandatory_block",
      label: { type: "plain_text", text: "Mandatory elements" },
      hint: { type: "plain_text", text: "Logos, disclaimers, product names, co-branding, data points" },
      element: { type: "plain_text_input", action_id: "mandatory_input", multiline: true },
      optional: true,
    },
    {
      type: "input", block_id: "supporting_block",
      label: { type: "plain_text", text: "Supporting documents" },
      hint: { type: "plain_text", text: "Links to briefs, guidelines, wireframes, mood boards, prior creative" },
      element: { type: "plain_text_input", action_id: "supporting_input", multiline: true },
      optional: true,
    },
  ];
}

// ── Asset-Specific Blocks ──

function buildBannerBlocks() {
  return [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Banners & Social Ads — Details*" } },
    {
      type: "input", block_id: "promo_type_block",
      label: { type: "plain_text", text: "Promotion type" },
      element: { type: "static_select", action_id: "promo_type_input", options: [
        { text: { type: "plain_text", text: "Event promotion" }, value: "event" },
        { text: { type: "plain_text", text: "Content promotion" }, value: "content" },
        { text: { type: "plain_text", text: "Webinar promotion" }, value: "webinar" },
        { text: { type: "plain_text", text: "Product feature or release" }, value: "product" },
        { text: { type: "plain_text", text: "Website / Tredemon" }, value: "website" },
        { text: { type: "plain_text", text: "Brand awareness / thought leadership" }, value: "brand" },
        { text: { type: "plain_text", text: "Other" }, value: "other" },
      ]},
    },
    {
      type: "input", block_id: "graphic_cat_block",
      label: { type: "plain_text", text: "Graphic category" },
      element: { type: "static_select", action_id: "graphic_cat_input", options: [
        { text: { type: "plain_text", text: "Paid ad graphic" }, value: "paid" },
        { text: { type: "plain_text", text: "Organic graphic" }, value: "organic" },
      ]},
    },
    {
      type: "input", block_id: "brand_block",
      label: { type: "plain_text", text: "Brand" },
      element: { type: "static_select", action_id: "brand_input", options: [
        { text: { type: "plain_text", text: "HiBob Marketing" }, value: "hibob" },
        { text: { type: "plain_text", text: "In Good Company" }, value: "igc" },
        { text: { type: "plain_text", text: "Heartcore HR" }, value: "heartcore" },
      ]},
    },
    {
      type: "input", block_id: "platform_block",
      label: { type: "plain_text", text: "Platform(s)" },
      hint: { type: "plain_text", text: "List all platforms where this will run" },
      element: { type: "checkboxes", action_id: "platform_input", options: [
        { text: { type: "plain_text", text: "LinkedIn" }, value: "linkedin" },
        { text: { type: "plain_text", text: "Meta / Facebook / Instagram" }, value: "meta" },
        { text: { type: "plain_text", text: "Google Display Network" }, value: "gdn" },
        { text: { type: "plain_text", text: "YouTube" }, value: "youtube" },
        { text: { type: "plain_text", text: "X (Twitter)" }, value: "x" },
        { text: { type: "plain_text", text: "Tredemon" }, value: "tredemon" },
        { text: { type: "plain_text", text: "Programmatic / DSP" }, value: "programmatic" },
      ]},
    },
    {
      type: "input", block_id: "dimensions_block",
      label: { type: "plain_text", text: "Dimensions" },
      hint: { type: "plain_text", text: "e.g., 1200×628px LinkedIn, 1080×1080px Instagram" },
      element: { type: "plain_text_input", action_id: "dimensions_input", multiline: true },
      optional: true,
    },
    {
      type: "input", block_id: "file_format_block",
      label: { type: "plain_text", text: "File format" },
      element: { type: "checkboxes", action_id: "file_format_input", options: [
        { text: { type: "plain_text", text: "PNG" }, value: "png" },
        { text: { type: "plain_text", text: "JPG" }, value: "jpg" },
        { text: { type: "plain_text", text: "SVG" }, value: "svg" },
        { text: { type: "plain_text", text: "GIF (animated)" }, value: "gif" },
        { text: { type: "plain_text", text: "HTML5" }, value: "html5" },
      ]},
      optional: true,
    },
    {
      type: "input", block_id: "ad_copy_block",
      label: { type: "plain_text", text: "Ad / post copy" },
      hint: { type: "plain_text", text: "Headline, body, CTA for each variant. Note if copy is pending." },
      element: { type: "plain_text_input", action_id: "ad_copy_input", multiline: true },
      optional: true,
    },
    {
      type: "input", block_id: "cta_block",
      label: { type: "plain_text", text: "CTA & destination URL" },
      element: { type: "plain_text_input", action_id: "cta_input" },
      optional: true,
    },
    {
      type: "input", block_id: "ab_block",
      label: { type: "plain_text", text: "A/B variants needed?" },
      hint: { type: "plain_text", text: "If yes, describe what varies (copy, image, CTA, color)" },
      element: { type: "plain_text_input", action_id: "ab_input", multiline: true },
      optional: true,
    },
    {
      type: "input", block_id: "campaign_link_block",
      label: { type: "plain_text", text: "Campaign / content link" },
      hint: { type: "plain_text", text: "Link to the campaign brief, event page, or content being promoted" },
      element: { type: "plain_text_input", action_id: "campaign_link_input" },
      optional: true,
    },
  ];
}

function buildVideoBlocks() {
  return [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Video — Details*" } },
    {
      type: "input", block_id: "video_type_block",
      label: { type: "plain_text", text: "Video type" },
      element: { type: "static_select", action_id: "video_type_input", options: [
        { text: { type: "plain_text", text: "Webinar" }, value: "webinar" },
        { text: { type: "plain_text", text: "Product demo" }, value: "product_demo" },
        { text: { type: "plain_text", text: "Customer testimonial" }, value: "testimonial" },
        { text: { type: "plain_text", text: "Event recap" }, value: "event_recap" },
        { text: { type: "plain_text", text: "Event signage" }, value: "event_signage" },
      ]},
    },
    {
      type: "input", block_id: "video_brief_block",
      label: { type: "plain_text", text: "Video brief link" },
      hint: { type: "plain_text", text: "Paste the link to your completed video brief document. Required for all video requests." },
      element: { type: "plain_text_input", action_id: "video_brief_input" },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: ":movie_camera: *All video requests require a completed video brief.* Copy the template, fill it out, and paste the link above." },
    },
  ];
}

function buildArtworkBlocks() {
  return [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Artwork — Details*" } },
    {
      type: "input", block_id: "artwork_type_block",
      label: { type: "plain_text", text: "Artwork type" },
      element: { type: "static_select", action_id: "artwork_type_input", options: [
        { text: { type: "plain_text", text: "Custom illustration" }, value: "illustration" },
        { text: { type: "plain_text", text: "Product mockup" }, value: "mockup" },
        { text: { type: "plain_text", text: "Infographic / data visualization" }, value: "infographic" },
        { text: { type: "plain_text", text: "Icon set or spot art" }, value: "icon_set" },
        { text: { type: "plain_text", text: "Diagram or architectural visual" }, value: "diagram" },
        { text: { type: "plain_text", text: "Photo composite or retouching" }, value: "photo_composite" },
        { text: { type: "plain_text", text: "Other" }, value: "other" },
      ]},
    },
    {
      type: "input", block_id: "style_ref_block",
      label: { type: "plain_text", text: "Style reference" },
      hint: { type: "plain_text", text: "Describe the style or link to references, mood boards, examples" },
      element: { type: "plain_text_input", action_id: "style_ref_input", multiline: true },
      optional: true,
    },
    {
      type: "input", block_id: "dimensions_block",
      label: { type: "plain_text", text: "Dimensions" },
      element: { type: "plain_text_input", action_id: "dimensions_input" },
      optional: true,
    },
    {
      type: "input", block_id: "file_format_block",
      label: { type: "plain_text", text: "File format" },
      element: { type: "checkboxes", action_id: "file_format_input", options: [
        { text: { type: "plain_text", text: "PNG (transparent)" }, value: "png" },
        { text: { type: "plain_text", text: "SVG (vector)" }, value: "svg" },
        { text: { type: "plain_text", text: "PSD (layered)" }, value: "psd" },
        { text: { type: "plain_text", text: "AI / EPS (vector source)" }, value: "ai_eps" },
        { text: { type: "plain_text", text: "PDF (print-ready)" }, value: "pdf" },
        { text: { type: "plain_text", text: "JPG" }, value: "jpg" },
      ]},
      optional: true,
    },
    {
      type: "input", block_id: "usage_context_block",
      label: { type: "plain_text", text: "Usage context" },
      hint: { type: "plain_text", text: "Where will this appear? Helps determine resolution, bleed, safe zones." },
      element: { type: "plain_text_input", action_id: "usage_context_input", multiline: true },
      optional: true,
    },
  ];
}

function buildOnePagerBlocks() {
  return [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*One-Pager — Details*" } },
    {
      type: "input", block_id: "topic_block",
      label: { type: "plain_text", text: "Topic / focus" },
      hint: { type: "plain_text", text: "What is this one-pager about?" },
      element: { type: "plain_text_input", action_id: "topic_input", multiline: true },
    },
    {
      type: "input", block_id: "template_block",
      label: { type: "plain_text", text: "Template" },
      element: { type: "static_select", action_id: "template_input", options: [
        { text: { type: "plain_text", text: "Use existing template (link in supporting docs)" }, value: "existing" },
        { text: { type: "plain_text", text: "Follow brand template standards" }, value: "brand_standard" },
        { text: { type: "plain_text", text: "Custom layout (describe in context)" }, value: "custom" },
      ]},
    },
    {
      type: "input", block_id: "data_points_block",
      label: { type: "plain_text", text: "Key data points" },
      hint: { type: "plain_text", text: "Stats, metrics, proof points, or quotes that must be included" },
      element: { type: "plain_text_input", action_id: "data_points_input", multiline: true },
      optional: true,
    },
    {
      type: "input", block_id: "cta_block",
      label: { type: "plain_text", text: "CTA" },
      hint: { type: "plain_text", text: "What should the reader do next? Include URL or contact details." },
      element: { type: "plain_text_input", action_id: "cta_input" },
      optional: true,
    },
    {
      type: "input", block_id: "dimensions_block",
      label: { type: "plain_text", text: "Page size" },
      element: { type: "static_select", action_id: "dimensions_input", options: [
        { text: { type: "plain_text", text: "US Letter (8.5×11″) — portrait" }, value: "letter_portrait" },
        { text: { type: "plain_text", text: "US Letter (8.5×11″) — landscape" }, value: "letter_landscape" },
        { text: { type: "plain_text", text: "A4 — portrait" }, value: "a4_portrait" },
        { text: { type: "plain_text", text: "A4 — landscape" }, value: "a4_landscape" },
        { text: { type: "plain_text", text: "Custom" }, value: "custom" },
      ]},
    },
    {
      type: "input", block_id: "file_format_block",
      label: { type: "plain_text", text: "File format" },
      element: { type: "static_select", action_id: "file_format_input", options: [
        { text: { type: "plain_text", text: "PDF (final / print-ready)" }, value: "pdf_final" },
        { text: { type: "plain_text", text: "PDF (editable)" }, value: "pdf_editable" },
        { text: { type: "plain_text", text: "PPTX (PowerPoint)" }, value: "pptx" },
        { text: { type: "plain_text", text: "Google Slides" }, value: "gslides" },
        { text: { type: "plain_text", text: "INDD (InDesign)" }, value: "indd" },
      ]},
      optional: true,
    },
    {
      type: "input", block_id: "content_status_block",
      label: { type: "plain_text", text: "Content status" },
      element: { type: "static_select", action_id: "content_status_input", options: [
        { text: { type: "plain_text", text: "Copy is final — design only" }, value: "final" },
        { text: { type: "plain_text", text: "Draft copy — needs editing" }, value: "draft" },
        { text: { type: "plain_text", text: "Copy needs to be written from scratch" }, value: "from_scratch" },
      ]},
    },
  ];
}

function buildDeckBlocks() {
  return [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Deck & Presentation — Details*" } },
    {
      type: "input", block_id: "deck_type_block",
      label: { type: "plain_text", text: "Deck type" },
      element: { type: "static_select", action_id: "deck_type_input", options: [
        { text: { type: "plain_text", text: "Sales / pitch deck" }, value: "sales" },
        { text: { type: "plain_text", text: "Product overview / demo" }, value: "product" },
        { text: { type: "plain_text", text: "Webinar / event presentation" }, value: "webinar" },
        { text: { type: "plain_text", text: "Internal strategy / planning" }, value: "internal" },
        { text: { type: "plain_text", text: "Board or executive readout" }, value: "executive" },
        { text: { type: "plain_text", text: "Training / enablement" }, value: "training" },
        { text: { type: "plain_text", text: "Conference talk" }, value: "conference" },
        { text: { type: "plain_text", text: "Other" }, value: "other" },
      ]},
    },
    {
      type: "input", block_id: "slide_count_block",
      label: { type: "plain_text", text: "Estimated slide count" },
      hint: { type: "plain_text", text: "Number or range (e.g., 10-15)" },
      element: { type: "plain_text_input", action_id: "slide_count_input" },
      optional: true,
    },
    {
      type: "input", block_id: "delivery_format_block",
      label: { type: "plain_text", text: "Delivery format" },
      element: { type: "static_select", action_id: "delivery_format_input", options: [
        { text: { type: "plain_text", text: "Presented live (speaker-led)" }, value: "live" },
        { text: { type: "plain_text", text: "Sent asynchronously (leave-behind, must stand alone)" }, value: "async" },
      ]},
    },
    {
      type: "input", block_id: "presenter_block",
      label: { type: "plain_text", text: "Presenter" },
      hint: { type: "plain_text", text: "Who will present or own this deck?" },
      element: { type: "plain_text_input", action_id: "presenter_input" },
      optional: true,
    },
    {
      type: "input", block_id: "content_status_block",
      label: { type: "plain_text", text: "Content status" },
      element: { type: "static_select", action_id: "content_status_input", options: [
        { text: { type: "plain_text", text: "Full content provided — design only" }, value: "final" },
        { text: { type: "plain_text", text: "Outline / bullets — needs refinement" }, value: "outline" },
        { text: { type: "plain_text", text: "Content needs to be developed from brief" }, value: "from_brief" },
      ]},
    },
  ];
}

function buildPrintBlocks() {
  return [
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Print (Swag & Events) — Details*" } },
    {
      type: "input", block_id: "item_type_block",
      label: { type: "plain_text", text: "Item type" },
      hint: { type: "plain_text", text: "e.g., t-shirt, tote bag, booth backdrop, brochure, sticker sheet" },
      element: { type: "plain_text_input", action_id: "item_type_input" },
    },
    {
      type: "input", block_id: "event_purpose_block",
      label: { type: "plain_text", text: "Event / purpose" },
      hint: { type: "plain_text", text: "Event name, date, location if applicable" },
      element: { type: "plain_text_input", action_id: "event_purpose_input", multiline: true },
    },
    {
      type: "input", block_id: "quantity_block",
      label: { type: "plain_text", text: "Quantity" },
      element: { type: "plain_text_input", action_id: "quantity_input" },
      optional: true,
    },
    {
      type: "input", block_id: "print_specs_block",
      label: { type: "plain_text", text: "Print specs" },
      hint: { type: "plain_text", text: "Print method, color mode (CMYK/Pantone), resolution, material" },
      element: { type: "plain_text_input", action_id: "print_specs_input", multiline: true },
      optional: true,
    },
    {
      type: "input", block_id: "dimensions_block",
      label: { type: "plain_text", text: "Dimensions" },
      hint: { type: "plain_text", text: "Physical size of item or print area, including bleed" },
      element: { type: "plain_text_input", action_id: "dimensions_input" },
      optional: true,
    },
    {
      type: "input", block_id: "vendor_block",
      label: { type: "plain_text", text: "Vendor" },
      hint: { type: "plain_text", text: "Preferred vendor or print partner? Include spec sheets if available." },
      element: { type: "plain_text_input", action_id: "vendor_input" },
      optional: true,
    },
    {
      type: "input", block_id: "file_format_block",
      label: { type: "plain_text", text: "File format" },
      element: { type: "checkboxes", action_id: "file_format_input", options: [
        { text: { type: "plain_text", text: "PDF (press-ready, CMYK)" }, value: "pdf" },
        { text: { type: "plain_text", text: "AI / EPS (vector)" }, value: "ai_eps" },
        { text: { type: "plain_text", text: "PNG (high-res, 300 DPI)" }, value: "png" },
        { text: { type: "plain_text", text: "PSD (layered)" }, value: "psd" },
        { text: { type: "plain_text", text: "Per vendor spec sheet" }, value: "vendor_spec" },
      ]},
      optional: true,
    },
    {
      type: "input", block_id: "ship_date_block",
      label: { type: "plain_text", text: "Ship-by date" },
      hint: { type: "plain_text", text: "When does the finished product need to arrive?" },
      element: { type: "datepicker", action_id: "ship_date_input" },
      optional: true,
    },
  ];
}

// ── Get asset-specific blocks by type ──
function getAssetBlocks(assetType) {
  switch (assetType) {
    case "banners_social_ads": return buildBannerBlocks();
    case "video": return buildVideoBlocks();
    case "artwork": return buildArtworkBlocks();
    case "one_pager": return buildOnePagerBlocks();
    case "deck": return buildDeckBlocks();
    case "print": return buildPrintBlocks();
    default: return [];
  }
}

// ── Extract asset-specific fields from view values into formatted text ──
function extractAssetFields(assetType, vals) {
  const lines = [];
  const get = (blockId, actionId) => {
    const v = vals[blockId]?.[actionId];
    if (!v) return null;
    if (v.value) return v.value;
    if (v.selected_option) return v.selected_option.text.text;
    if (v.selected_options) return v.selected_options.map(o => o.text.text).join(", ");
    if (v.selected_date) return v.selected_date;
    return null;
  };

  switch (assetType) {
    case "banners_social_ads":
      lines.push(`Promotion type: ${get("promo_type_block", "promo_type_input") || "N/A"}`);
      lines.push(`Graphic category: ${get("graphic_cat_block", "graphic_cat_input") || "N/A"}`);
      lines.push(`Brand: ${get("brand_block", "brand_input") || "N/A"}`);
      lines.push(`Platform(s): ${get("platform_block", "platform_input") || "N/A"}`);
      if (get("dimensions_block", "dimensions_input")) lines.push(`Dimensions: ${get("dimensions_block", "dimensions_input")}`);
      if (get("file_format_block", "file_format_input")) lines.push(`File format: ${get("file_format_block", "file_format_input")}`);
      if (get("ad_copy_block", "ad_copy_input")) lines.push(`Ad/post copy: ${get("ad_copy_block", "ad_copy_input")}`);
      if (get("cta_block", "cta_input")) lines.push(`CTA: ${get("cta_block", "cta_input")}`);
      if (get("ab_block", "ab_input")) lines.push(`A/B variants: ${get("ab_block", "ab_input")}`);
      if (get("campaign_link_block", "campaign_link_input")) lines.push(`Campaign link: ${get("campaign_link_block", "campaign_link_input")}`);
      break;

    case "video":
      lines.push(`Video type: ${get("video_type_block", "video_type_input") || "N/A"}`);
      lines.push(`Video brief: ${get("video_brief_block", "video_brief_input") || "N/A"}`);
      break;

    case "artwork":
      lines.push(`Artwork type: ${get("artwork_type_block", "artwork_type_input") || "N/A"}`);
      if (get("style_ref_block", "style_ref_input")) lines.push(`Style reference: ${get("style_ref_block", "style_ref_input")}`);
      if (get("dimensions_block", "dimensions_input")) lines.push(`Dimensions: ${get("dimensions_block", "dimensions_input")}`);
      if (get("file_format_block", "file_format_input")) lines.push(`File format: ${get("file_format_block", "file_format_input")}`);
      if (get("usage_context_block", "usage_context_input")) lines.push(`Usage context: ${get("usage_context_block", "usage_context_input")}`);
      break;

    case "one_pager":
      lines.push(`Topic: ${get("topic_block", "topic_input") || "N/A"}`);
      lines.push(`Template: ${get("template_block", "template_input") || "N/A"}`);
      if (get("data_points_block", "data_points_input")) lines.push(`Key data points: ${get("data_points_block", "data_points_input")}`);
      if (get("cta_block", "cta_input")) lines.push(`CTA: ${get("cta_block", "cta_input")}`);
      lines.push(`Page size: ${get("dimensions_block", "dimensions_input") || "N/A"}`);
      if (get("file_format_block", "file_format_input")) lines.push(`File format: ${get("file_format_block", "file_format_input")}`);
      lines.push(`Content status: ${get("content_status_block", "content_status_input") || "N/A"}`);
      break;

    case "deck":
      lines.push(`Deck type: ${get("deck_type_block", "deck_type_input") || "N/A"}`);
      if (get("slide_count_block", "slide_count_input")) lines.push(`Slide count: ${get("slide_count_block", "slide_count_input")}`);
      lines.push(`Delivery format: ${get("delivery_format_block", "delivery_format_input") || "N/A"}`);
      if (get("presenter_block", "presenter_input")) lines.push(`Presenter: ${get("presenter_block", "presenter_input")}`);
      lines.push(`Content status: ${get("content_status_block", "content_status_input") || "N/A"}`);
      break;

    case "print":
      lines.push(`Item type: ${get("item_type_block", "item_type_input") || "N/A"}`);
      lines.push(`Event / purpose: ${get("event_purpose_block", "event_purpose_input") || "N/A"}`);
      if (get("quantity_block", "quantity_input")) lines.push(`Quantity: ${get("quantity_block", "quantity_input")}`);
      if (get("print_specs_block", "print_specs_input")) lines.push(`Print specs: ${get("print_specs_block", "print_specs_input")}`);
      if (get("dimensions_block", "dimensions_input")) lines.push(`Dimensions: ${get("dimensions_block", "dimensions_input")}`);
      if (get("vendor_block", "vendor_input")) lines.push(`Vendor: ${get("vendor_block", "vendor_input")}`);
      if (get("file_format_block", "file_format_input")) lines.push(`File format: ${get("file_format_block", "file_format_input")}`);
      if (get("ship_date_block", "ship_date_input")) lines.push(`Ship-by date: ${get("ship_date_block", "ship_date_input")}`);
      break;
  }

  return lines.join("\n");
}

// ── Human-readable asset type labels ──
const ASSET_TYPE_LABELS = {
  banners_social_ads: "Banners & Social Ads",
  video: "Video",
  artwork: "Artwork",
  one_pager: "One-Pager",
  deck: "Deck & Presentation",
  print: "Print (Swag & Events)",
  content_review: "Content Review",
  campaign_system: "Campaign System",
};

module.exports = {
  ASSET_TYPE_OPTIONS,
  PRIORITY_OPTIONS,
  NET_NEW_OPTIONS,
  buildStep1Blocks,
  buildSharedBlocks,
  getAssetBlocks,
  extractAssetFields,
  ASSET_TYPE_LABELS,
};
