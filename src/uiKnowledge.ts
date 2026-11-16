/**
 * What a good UI designer knows, as data the harness can use: rules with severities, playbooks by
 * kind of product, style families, and type pairings.
 *
 * Rebuilt in our own words and structure after reading the MIT-licensed ui-ux-pro-max-skill data
 * (rules and product-to-style reasoning). Nothing here is copied wholesale; it is a working set, not a
 * claim that these are the only good answers. A model chooses among them; code validates the choice.
 */

export type Platform = "web" | "native" | "all";
export type Severity = "critical" | "high" | "medium";

export interface UiRule {
  id: string;
  area: string;
  sev: Severity;
  platform: Platform;
  /** Do this. */
  do: string;
  /** Not this. */
  not: string;
  /** In the short block every Editor sees. */
  core?: boolean;
}

export const RULES: UiRule[] = [
  // --- icons, imagery, content: where "AI slop" shows first
  { id: "no-emoji-icons", area: "icons", sev: "critical", platform: "all", core: true, do: "Use one vector icon set for every icon, tab, button and status: the one the project has installed, otherwise Phosphor (see design-system/icons.md), at one weight and a consistent size.", not: "Emoji as icons, buttons, bullets, tab labels or status markers (they render differently per device, cannot be recoloured and look unfinished)." },
  { id: "icon-labels", area: "icons", sev: "high", platform: "all", core: true, do: "Give every icon-only button an accessible label.", not: "Unlabelled icon buttons." },
  { id: "real-content", area: "content", sev: "high", platform: "all", core: true, do: "Write believable sample content in the product's own voice (real headlines, names, prices, dates); keep it in one data file.", not: "Lorem ipsum, 'Item 1', 'Welcome to our website', invented statistics or testimonials presented as real." },
  { id: "imagery-plan", area: "content", sev: "medium", platform: "all", do: "Use real images, or intentional placeholders (flat colour blocks with an aspect ratio, never broken image icons); always set the aspect ratio so layout does not jump.", not: "Stock-looking gradients blobs as the only visual, or images without dimensions." },
  { id: "truncation", area: "content", sev: "critical", platform: "all", do: "Let essential text wrap or provide a visible way to read it all.", not: "Clamp meaning (a price, a name, a headline) to make cards the same height." },
  { id: "empty-states", area: "feedback", sev: "medium", platform: "all", do: "Design empty, loading, error and offline states with a next step.", not: "Blank screens or a spinner that never explains itself." },
  // --- accessibility
  { id: "contrast", area: "accessibility", sev: "critical", platform: "all", core: true, do: "Body text at least 4.5:1 against its background (3:1 for large text and controls), in light AND dark; measure, do not eyeball.", not: "Grey on grey, pale text on photos without a scrim." },
  { id: "not-colour-only", area: "accessibility", sev: "high", platform: "all", do: "Pair colour with an icon or word for status and errors.", not: "Red versus green as the only signal." },
  { id: "focus-visible", area: "accessibility", sev: "high", platform: "web", core: true, do: "Show a visible focus ring on every interactive element (2px, 3:1 contrast).", not: "outline: none with nothing in its place." },
  { id: "semantic-controls", area: "accessibility", sev: "critical", platform: "web", core: true, do: "Use button, a, input, label, nav, main and real headings in order.", not: "Clickable divs, or heading levels chosen for size." },
  { id: "form-labels", area: "forms", sev: "high", platform: "all", core: true, do: "Every input has a visible label; errors sit under the field and say how to fix it.", not: "Placeholder as the only label; one error banner for the whole form." },
  { id: "alt-text", area: "accessibility", sev: "high", platform: "all", do: "Meaningful images get descriptive alt text; decorative ones get empty alt.", not: "Missing alt attributes." },
  { id: "reduced-motion", area: "motion", sev: "high", platform: "all", core: true, do: "Honour the reduced-motion setting: show the final state with no parallax or scroll effects.", not: "Forced scroll-jacking or looping decoration." },
  { id: "zoom", area: "accessibility", sev: "high", platform: "web", core: true, do: "Allow pinch zoom and text resize; use rem/em for text.", not: "user-scalable=no or maximum-scale=1; fixed-height boxes that clip text." },
  { id: "auth-paste", area: "accessibility", sev: "high", platform: "all", do: "Allow paste and password managers; offer a non-transcription login option.", not: "Blocking paste in password fields." },
  // --- touch and interaction
  { id: "touch-target", area: "touch", sev: "high", platform: "native", core: true, do: "At least 44pt (iOS) / 48dp (Android) for tappable things, with 8px between them.", not: "Tiny icon buttons packed together." },
  { id: "target-size-web", area: "touch", sev: "high", platform: "web", do: "At least 24x24 CSS px for targets (44 on touch layouts).", not: "Inline icon links smaller than that." },
  { id: "press-states", area: "interaction", sev: "medium", platform: "all", core: true, do: "Every control shows hover (web), pressed, focused and disabled states.", not: "Controls that look the same in every state." },
  { id: "loading-buttons", area: "interaction", sev: "high", platform: "all", do: "Disable a button and show progress while it works.", not: "Allowing double submits." },
  { id: "confirm-destructive", area: "interaction", sev: "high", platform: "all", do: "Confirm (or offer undo) before an irreversible action.", not: "Delete with one tap and no recovery." },
  { id: "no-gesture-only", area: "interaction", sev: "high", platform: "all", do: "Every swipe or drag action also has a visible button.", not: "Gesture-only actions." },
  { id: "no-hover-only", area: "interaction", sev: "high", platform: "web", do: "Put important actions where touch can reach them.", not: "Actions that exist only on hover." },
  // --- layout, responsive
  { id: "mobile-first", area: "layout", sev: "high", platform: "web", core: true, do: "Design the small screen first; test at 320, 375, 768, 1024 and 1440 widths; no horizontal scroll.", not: "Desktop layouts shrunk with overflow." },
  { id: "viewport-meta", area: "layout", sev: "high", platform: "web", do: "width=device-width, initial-scale=1.", not: "A missing viewport tag." },
  { id: "measure", area: "typography", sev: "medium", platform: "web", core: true, do: "Limit reading text to 60-75 characters per line.", not: "Paragraphs spanning the whole window." },
  { id: "dvh", area: "layout", sev: "medium", platform: "web", do: "Use dvh, or account for the mobile browser bars, for full-height sections.", not: "100vh for full-screen mobile layouts." },
  { id: "safe-areas", area: "layout", sev: "high", platform: "native", core: true, do: "Respect safe areas (notch, home indicator, status bar) and keep content above the keyboard.", not: "Content under system bars." },
  { id: "layout-shift", area: "layout", sev: "high", platform: "all", do: "Reserve space for images, async content and fonts.", not: "Content that jumps as it loads." },
  { id: "z-scale", area: "layout", sev: "medium", platform: "web", do: "A small z-index scale (10, 20, 30, 50).", not: "z-index: 9999." },
  { id: "long-words", area: "layout", sev: "high", platform: "web", do: "overflow-wrap:anywhere and min-width:0 on flex/grid text children.", not: "word-break: break-all on prose." },
  { id: "tables", area: "layout", sev: "medium", platform: "web", do: "Scroll wide tables horizontally or turn rows into cards on small screens.", not: "Tables that break the page width." },
  // --- type and colour
  { id: "type-scale", area: "typography", sev: "medium", platform: "all", core: true, do: "A modular scale from tokens (e.g. 12, 14, 16, 20, 24, 32, 44) and at most two families; headings clearly larger or heavier than body.", not: "Random font sizes; four typefaces; headings that look like body." },
  { id: "body-size", area: "typography", sev: "high", platform: "all", core: true, do: "Body text at least 16px (web) / 16sp, line height 1.5-1.7.", not: "12-13px body copy." },
  { id: "font-loading", area: "typography", sev: "medium", platform: "web", do: "font-display: swap with a metric-compatible fallback.", not: "Invisible text while fonts load." },
  { id: "tokens-only", area: "colour", sev: "high", platform: "all", core: true, do: "Colours, spacing, radius and shadow come from the design tokens in the design system.", not: "Hard-coded hex values and magic numbers scattered through components." },
  { id: "one-accent", area: "colour", sev: "high", platform: "all", core: true, do: "One signature colour, one accent at most, tinted neutrals; the loudest colour gets the least area.", not: "Rainbow palettes; default purple-to-pink gradients; pure #000 on pure #fff everywhere." },
  { id: "dark-mode", area: "colour", sev: "high", platform: "all", do: "If dark mode exists, re-check every contrast pair there; lift brand fills a step; no pure white long text on pure black.", not: "Inverting the light theme." },
  { id: "restrained-effects", area: "style", sev: "high", platform: "all", core: true, do: "Elevation, blur and gradients only where they explain something (layering, focus).", not: "Glass cards and drop shadows on everything; decorative blobs." },
  // --- motion
  { id: "motion-budget", area: "motion", sev: "medium", platform: "all", do: "Animate one or two things per view with shared duration tokens (about 120-250ms for feedback); use transform and opacity.", not: "Animating everything; animating width, height, top or left." },
  { id: "auto-rotate", area: "motion", sev: "high", platform: "all", do: "Carousels have previous, next and pause, and stop on focus.", not: "Auto-advancing slides with no control." },
  // --- navigation
  { id: "nav-count", area: "navigation", sev: "high", platform: "native", core: true, do: "At most five bottom-tab destinations, always labelled; back works as people expect; deep links for screens.", not: "Hamburger-only primary navigation on mobile; broken back behaviour." },
  { id: "nav-active", area: "navigation", sev: "medium", platform: "all", do: "Mark the current location.", not: "Navigation with no sign of where you are." },
  { id: "sticky-offset", area: "navigation", sev: "medium", platform: "web", do: "Offset content and scroll-padding by the sticky header height.", not: "A sticky bar covering the first section or the focused field." },
  // --- performance
  { id: "images", area: "performance", sev: "high", platform: "all", do: "Right-sized, modern formats, lazy-loaded below the fold, with width and height set.", not: "Full-size originals." },
  { id: "bundle", area: "performance", sev: "medium", platform: "web", do: "Split by route; defer non-critical scripts.", not: "One large bundle; synchronous third-party scripts." },
  // --- forms and feedback
  { id: "input-types", area: "forms", sev: "medium", platform: "all", do: "Use the right input type, keyboard and autocomplete (email, tel, one-time-code).", not: "A plain text field for everything." },
  { id: "validate-blur", area: "forms", sev: "medium", platform: "all", do: "Validate on blur, summarise errors after a failed submit and move focus to the first one.", not: "Validating only on submit; silent failures." },
  { id: "toasts", area: "feedback", sev: "medium", platform: "all", do: "Confirmations auto-dismiss in 3-5 seconds and never hold the only copy of an error.", not: "Toasts that never go away." },
  { id: "ai-label", area: "content", sev: "high", platform: "all", do: "Label AI-generated content clearly.", not: "Presenting generated text as human." },
];

// ---------------------------------------------------------------------------
// style families
// ---------------------------------------------------------------------------

export interface StyleFamily {
  id: string;
  name: string;
  traits: string;
  use: string;
  avoid: string;
  /** Token hints, interpreted by the design-system builder. */
  radius: "sharp" | "soft" | "round";
  elevation: "flat" | "subtle" | "layered";
  scale: number;
  /** The reference table's style id, for its implementation checklist and CSS notes. */
  ref?: string;
}

export const STYLES: StyleFamily[] = [
  { id: "swiss", ref: "minimalism-and-swiss-style", name: "Swiss minimal", traits: "A strict grid, generous space, one typeface family, small caps labels, hairline rules, colour used sparingly.", use: "News, documentation, B2B, portfolios, anything text-led.", avoid: "Playful consumer apps for children.", radius: "sharp", elevation: "flat", scale: 1.25 },
  { id: "editorial", ref: "editorial-grid-magazine", name: "Editorial grid", traits: "A magazine layout: a large lead, a multi-column grid with clear rules, serif headlines, captions and bylines, high-contrast ink on paper.", use: "News, magazines, blogs, long reads, culture.", avoid: "Dense dashboards.", radius: "sharp", elevation: "flat", scale: 1.333 },
  { id: "flat", ref: "flat-design", name: "Flat and functional", traits: "No shadows, solid colour blocks, clear hierarchy, fast 150ms feedback.", use: "Productivity, CRM, tools, forms.", avoid: "Luxury or atmosphere-led brands.", radius: "soft", elevation: "flat", scale: 1.2 },
  { id: "soft", ref: "soft-ui-evolution", name: "Soft UI", traits: "Gentle shadows, rounded corners, calm low-saturation colour, tactile cards.", use: "Wellness, collaboration, finance for beginners.", avoid: "Data-dense screens (shadows add noise).", radius: "round", elevation: "subtle", scale: 1.25 },
  { id: "dark-oled", ref: "dark-mode-oled", name: "Dark (OLED)", traits: "Near-black ground, bright accents with lifted tints, subtle borders instead of shadows, high contrast text that is not pure white.", use: "Media players, trading, developer tools, night use.", avoid: "Health or children's products that need warmth; long reading.", radius: "soft", elevation: "layered", scale: 1.2 },
  { id: "glass-restrained", ref: "glassmorphism", name: "Glass, restrained", traits: "Translucent layers for one or two surfaces (a sheet, a nav bar) over rich imagery; solid surfaces everywhere else.", use: "Media-rich native apps, weather, music.", avoid: "Text-heavy screens; low-end devices; anything where contrast is borderline.", radius: "round", elevation: "layered", scale: 1.25 },
  { id: "neo-brutal", ref: "neubrutalism", name: "Neo-brutalist", traits: "Thick borders, hard offset shadows, flat bold colour, big type, deliberate roughness.", use: "Creative tools, Gen Z brands, indie products.", avoid: "Government, healthcare, finance.", radius: "sharp", elevation: "layered", scale: 1.333 },
  { id: "bento", ref: "bento-box-grid", name: "Bento grid", traits: "A modular grid of differently sized tiles, each one idea; consistent gaps and radius.", use: "Feature overviews, dashboards, portfolios, product pages.", avoid: "Linear long-form reading.", radius: "round", elevation: "subtle", scale: 1.25 },
  { id: "clay", ref: "claymorphism", name: "Playful soft 3D", traits: "Chunky rounded shapes, inner shadows, saturated friendly colour, bouncy press states.", use: "Kids, education, casual games, habit apps.", avoid: "Serious finance, legal, government.", radius: "round", elevation: "layered", scale: 1.25 },
  { id: "organic", ref: "organic-biophilic", name: "Organic and natural", traits: "Earth tones, soft rounded forms, humanist type, flowing shapes, photography of real materials.", use: "Wellness, food, plants, sustainability, crafts.", avoid: "Technical or high-speed products.", radius: "round", elevation: "subtle", scale: 1.25 },
  { id: "bauhaus", ref: "bauhaus", name: "Bold geometric", traits: "Primary shapes, strong asymmetry, flat saturated colour, heavy geometric sans.", use: "Creative agencies, events, education with attitude.", avoid: "Calm, trust-led products.", radius: "sharp", elevation: "flat", scale: 1.333 },
  { id: "material", ref: "material-you-md3-mobile", name: "Material 3 style", traits: "Tonal colour from one seed, large rounded containers, clear elevation by tone, system motion.", use: "Android-first apps and utilities.", avoid: "Brands that need a strongly different voice.", radius: "round", elevation: "subtle", scale: 1.2 },
  { id: "native-apple", ref: "apple-native-experience", name: "Apple-native feel", traits: "System type, large titles, grouped lists, sheets, subtle blur, restrained colour on a neutral ground.", use: "iOS-first apps, utilities, productivity.", avoid: "Cross-platform products that must look identical everywhere.", radius: "soft", elevation: "subtle", scale: 1.2 },
  { id: "enterprise", ref: "fluent-2", name: "Enterprise clarity", traits: "Dense but orderly tables and forms, neutral ground, one blue-ish accent, strong states, predictable patterns.", use: "B2B SaaS, admin, internal tools.", avoid: "Consumer and creative brands.", radius: "soft", elevation: "flat", scale: 1.2 },
  { id: "academia", name: "Academic and archival", traits: "Serif body, warm paper tone, small caps, footnote-like details, restrained deep colours.", use: "Research, libraries, museums, long reads.", avoid: "Fast consumer tools.", radius: "sharp", elevation: "flat", scale: 1.25 },
  { id: "luxury", ref: "exaggerated-minimalism", name: "Luxury minimal", traits: "Large imagery, wide margins, thin high-contrast serif or light sans, very little colour, slow fades.", use: "Premium brands, hotels, fashion, real estate.", avoid: "Marketplaces and anything price-led.", radius: "sharp", elevation: "flat", scale: 1.333 },
  { id: "data-dense", ref: "data-dense-dashboard", name: "Data-dense", traits: "Compact rows, tabular figures, small multiples, muted ground, colour only for meaning.", use: "Analytics, finance, operations, monitoring.", avoid: "Marketing pages.", radius: "sharp", elevation: "flat", scale: 1.125 },
  { id: "kinetic-type", ref: "kinetic-typography", name: "Typographic and kinetic", traits: "Oversized type as the main graphic, bold crops, restrained motion tied to scroll or tap.", use: "Campaigns, events, portfolios, launch pages.", avoid: "Dense tools; reduced-motion users must still get the static layout.", radius: "sharp", elevation: "flat", scale: 1.5 },
  { id: "terminal", name: "Terminal and mono", traits: "Monospace, dark ground, one phosphor accent, command-line affordances.", use: "Developer tools, security, hacker culture.", avoid: "Mainstream consumer products.", radius: "sharp", elevation: "flat", scale: 1.2 },
  { id: "retro-film", ref: "vintage-analog-retro-film", name: "Retro analogue", traits: "Grain, warm faded colour, serif display type, tactile paper or tape details.", use: "Photography, music, cafes, independent shops.", avoid: "Anything needing a clinical or efficient feel.", radius: "soft", elevation: "subtle", scale: 1.25 },
];

// ---------------------------------------------------------------------------
// playbooks by product type
// ---------------------------------------------------------------------------

export interface Playbook {
  id: string;
  name: string;
  /** words a request may use for this kind of product */
  aka: string;
  kind: "web" | "native" | "both";
  /** The structure of the main page or screen set, in order. */
  structure: string;
  styles: string[];
  colour: string;
  type: string;
  pairings: string[];
  musts: string[];
  anti: string[];
}

export const PLAYBOOKS: Playbook[] = [
  { id: "news", name: "News and media", aka: "news website newspaper magazine publication journalism headlines media outlet", kind: "web", structure: "Masthead with the name and date; a slim category bar; a lead story with a large image and standfirst beside a ranked list of latest items; section rows (one grid per category) with consistent card anatomy: kicker, headline, deck, time, byline; a most-read rail; a newsletter strip; a dense footer. Article page: headline, deck, byline and time, hero image with caption, a single reading column of 60-70 characters, pull quotes, related stories, share and save.", styles: ["editorial", "swiss"], colour: "Ink on warm paper, with one brand colour reserved for kickers, links and the breaking badge. Section colours only as small tags.", type: "Serif headlines with a clean sans for UI and captions; tabular figures for times.", pairings: ["news-editorial", "magazine", "editorial-classic"], musts: ["mobile-first reading layout", "category navigation", "timestamps and bylines", "skeleton loading for the feed", "search"], anti: ["a centred marketing hero", "three identical rounded feature cards", "gradient blobs", "autoplaying video", "ads that look like articles"] },
  { id: "blog", name: "Magazine and blog", aka: "blog magazine essays articles writing stories", kind: "web", structure: "A confident header; a featured post; a grid or list of posts with category, date and read time; an about strip; subscription; archive. Post page with a generous reading column, drop cap or large first line, figure captions, author box and related posts.", styles: ["editorial", "academia"], colour: "Warm neutrals with one deep accent.", type: "A characterful serif for headings and body.", pairings: ["editorial-classic", "magazine", "minimal-editorial"], musts: ["article showcase", "subscribe form", "reading time", "clear typography"], anti: ["tiny grey text", "sidebar clutter", "slow hero images"] },
  { id: "saas", name: "SaaS product site", aka: "saas software tool platform startup landing product website b2b app marketing", kind: "web", structure: "Nav; a hero that states the outcome and shows the real product (not an abstract shape); proof (logos or numbers only if real); three outcome sections each with a distinct visual; how it works; pricing; FAQ; final call to action. Vary the layout between sections.", styles: ["swiss", "flat", "bento"], colour: "A neutral ground with one saturated signature and a quiet accent; avoid the default purple gradient.", type: "A distinctive heading face with a neutral body; avoid using the same face you would for any startup.", pairings: ["tech-startup", "friendly-saas", "premium-sans"], musts: ["a product screenshot or demo", "one primary action per section", "real pricing logic", "keyboard focus states"], anti: ["centred hero with a gradient orb", "three equal cards with emoji", "fake logos", "glass everywhere"] },
  { id: "ecommerce", name: "Shop", aka: "ecommerce e-commerce shop store retail products cart checkout", kind: "both", structure: "Header with search and cart; collection grid with photo-first cards (image, name, price, rating); filters that persist; product page with a gallery, variant choice, delivery information, reviews and a sticky add-to-cart on mobile; a short, honest checkout.", styles: ["flat", "bento"], colour: "Neutral ground so product photos carry the colour; a single action colour for add-to-cart; success green for stock.", type: "A clear sans pairing with tabular prices.", pairings: ["ecommerce-clean", "modern-professional"], musts: ["photo-first cards", "visible filters", "price and stock clarity", "guest checkout"], anti: ["hidden shipping costs", "text-heavy listing pages", "popups on load"] },
  { id: "luxury-shop", name: "Luxury and premium brand", aka: "luxury premium fashion jewellery watches high-end boutique", kind: "web", structure: "Full-bleed imagery, few words, a quiet header, editorial product storytelling, wide margins, slow fades.", styles: ["luxury", "editorial"], colour: "Black, ivory and one metal or deep tone.", type: "A fine high-contrast serif with a light sans.", pairings: ["luxury-serif", "luxury-minimal"], musts: ["large photography", "restrained motion", "clear contact or booking"], anti: ["discount badges", "bright buttons", "dense grids"] },
  { id: "marketplace", name: "Marketplace and directory", aka: "marketplace classifieds listings directory p2p buy sell auction", kind: "both", structure: "Search first; category chips; listing cards with photo, price, place and seller reputation; a persistent filter panel; map and list toggle; listing page with seller profile and a safe contact path.", styles: ["flat", "bento"], colour: "Neutral ground, price in a calm green, verified badges in the brand colour.", type: "Scan-friendly sans.", pairings: ["ecommerce-clean", "corporate-trust"], musts: ["multi-filter search", "seller reputation", "location", "trust cues"], anti: ["hidden filters", "no reviews", "text-only cards"] },
  { id: "dashboard", name: "Analytics and admin dashboard", aka: "dashboard analytics admin panel metrics reporting backoffice monitoring", kind: "web", structure: "A left rail or top bar; a summary row of 3-5 key numbers with change; one primary chart; a filterable table; detail drawer. Dense but with clear grouping and consistent units.", styles: ["data-dense", "enterprise"], colour: "Muted ground; colour only to mean something (series, status).", type: "A highly legible sans with tabular figures and a mono for IDs.", pairings: ["dashboard-data", "financial-trust"], musts: ["tabular numerals", "empty and error states for every widget", "keyboard navigation", "accessible chart colours and labels"], anti: ["rainbow charts", "3D charts", "decorative gradients", "tooltips as the only way to read values"] },
  { id: "fintech", name: "Finance and banking", aka: "finance fintech banking bank money payments crypto trading investing wallet", kind: "both", structure: "A clear balance and the next best action first; recent activity with plain-language rows; transfers in short steps with review and confirmation; security visible but calm.", styles: ["enterprise", "dark-oled", "flat"], colour: "Deep, trustworthy neutrals with one clear accent; green and red only for gain and loss, always with a sign or arrow.", type: "A precise sans with tabular figures.", pairings: ["financial-trust", "corporate-trust"], musts: ["clear confirmation steps", "undo or cancel windows", "plain error messages", "biometric and password-manager support"], anti: ["neon crypto clichés", "tiny grey disclaimers", "dark patterns on fees"] },
  { id: "health", name: "Healthcare and clinic", aka: "healthcare health clinic medical doctor dental hospital pharmacy patient telemedicine veterinary", kind: "both", structure: "Reassurance and clarity first: who it is for, how to book, opening hours and emergency contact; services in plain language; practitioners with real faces; booking in few steps; patient records behind a clear login.", styles: ["soft", "enterprise", "swiss"], colour: "Calm blues or greens on a clean ground, high contrast, warm accents sparingly.", type: "A friendly, highly readable sans.", pairings: ["medical-clean", "accessibility-first"], musts: ["WCAG AA or better", "large touch targets", "emergency contact", "plain language"], anti: ["red as decoration", "stock handshake photos", "low contrast pastels"] },
  { id: "education", name: "Learning and courses", aka: "education course learning school university lms tutoring study students e-learning lessons", kind: "both", structure: "A clear path (what next), progress visible, short lessons, instant feedback, a library to browse; for courses a syllabus, instructor, outcomes and a start button.", styles: ["clay", "soft", "flat"], colour: "Friendly saturated colour with a clear success and error pair that does not rely on hue alone.", type: "A rounded or friendly sans with large body sizes.", pairings: ["playful-creative", "kids-education", "corporate-trust"], musts: ["progress indicators", "skip and back controls", "accessible quizzes"], anti: ["dense walls of text", "unskippable tours", "leaderboards without opt-out"] },
  { id: "kids", name: "Children's apps", aka: "kids children toddler abc learning games parenting", kind: "native", structure: "Big targets, one task per screen, audio and animation feedback, a parent gate for settings and purchases.", styles: ["clay", "bauhaus"], colour: "Bright but organised, strong contrast, a calm base.", type: "Large rounded sans.", pairings: ["kids-education", "playful-creative"], musts: ["60pt targets", "parent gate", "no external links"], anti: ["tiny text", "dark patterns", "ads"] },
  { id: "portfolio", name: "Portfolio and agency", aka: "portfolio agency studio creative designer photographer freelancer showcase", kind: "web", structure: "A strong statement, selected work as large case-study tiles, a short process, contact. The work is the hero; the layout is a frame.", styles: ["kinetic-type", "swiss", "bauhaus", "luxury"], colour: "Neutral ground, one signature, big crops.", type: "A distinctive display face and a quiet body.", pairings: ["minimal-portfolio", "fashion-forward", "bold-statement"], musts: ["fast image loading", "clear contact", "case studies with real outcomes"], anti: ["template look", "slow intro animations", "unlabelled icon navigation"] },
  { id: "restaurant", name: "Restaurant, cafe and food", aka: "restaurant cafe bakery food menu brewery winery bar catering", kind: "web", structure: "Photography of the food, hours and location above the fold, a menu that is real text (not an image), booking or order, an honest story.", styles: ["organic", "retro-film", "editorial"], colour: "Warm, appetising, from the food and the room, not stock orange.", type: "A characterful serif display with a friendly body.", pairings: ["restaurant-menu", "wellness-calm", "indie-craft"], musts: ["menu as text with prices", "opening hours", "map and phone as tappable links"], anti: ["menu as a PDF", "autoplay music", "tiny text on photos"] },
  { id: "travel", name: "Travel and hospitality", aka: "travel tourism hotel hospitality booking holiday trips airline", kind: "both", structure: "Search or dates first, large place photography, clear prices with what is included, reviews, a simple booking flow.", styles: ["editorial", "luxury", "organic"], colour: "Sky, sea and earth tones from the destinations.", type: "A refined serif with a clean sans.", pairings: ["luxury-serif", "editorial-classic"], musts: ["date picker that works by keyboard", "price clarity", "reviews"], anti: ["fake scarcity banners", "carousels with no controls"] },
  { id: "realestate", name: "Real estate", aka: "real estate property homes listings rentals architecture interior construction", kind: "web", structure: "Search and map, listing cards with big photos and key facts, a gallery, neighbourhood facts, an enquiry form.", styles: ["luxury", "swiss"], colour: "Neutral with a deep brand colour.", type: "Elegant serif headings with a clean sans.", pairings: ["real-estate-luxury", "luxury-minimal"], musts: ["map", "saved searches", "clear price and size facts"], anti: ["tiny photos", "hidden contact"] },
  { id: "professional", name: "Legal and professional services", aka: "legal law lawyer accounting consultancy insurance b2b services firm", kind: "web", structure: "A clear promise, practice areas, credentials, real team, how to engage, contact. Authority through restraint.", styles: ["swiss", "academia", "enterprise"], colour: "Deep neutral with one restrained accent.", type: "A traditional serif or a humanist sans.", pairings: ["legal-professional", "corporate-trust"], musts: ["clear contact", "plain-language services"], anti: ["scales-of-justice imagery", "stock suits", "dense paragraphs"] },
  { id: "nonprofit", name: "Non-profit and community", aka: "nonprofit charity church community club sports team donations volunteer", kind: "web", structure: "The cause in a sentence, evidence of impact, a primary donate or join action, stories, transparency about money.", styles: ["organic", "editorial", "flat"], colour: "Warm, human, from the cause itself.", type: "Humanist.", pairings: ["wellness-calm", "corporate-trust"], musts: ["a simple donation flow", "impact numbers that are real"], anti: ["guilt imagery", "hidden costs"] },
  { id: "gov", name: "Government and civic services", aka: "government public service civic council portal forms benefits", kind: "web", structure: "Task-first: what do you need to do; plain headings; forms in small steps; progress saved; clear confirmation.", styles: ["swiss", "enterprise"], colour: "High contrast, one clear action colour.", type: "Large, clear, highly legible sans.", pairings: ["accessibility-first", "corporate-trust"], musts: ["WCAG AA or better", "keyboard operable", "plain language", "error summary with links"], anti: ["ornament", "motion", "AI purple gradients"] },
  { id: "social", name: "Social and community", aka: "social network community chat messaging forum discussion dating creator", kind: "native", structure: "A feed or thread list as the home, a composer that is always reachable, clear identity and presence, reporting and blocking easy to find.", styles: ["flat", "native-apple", "material"], colour: "Neutral ground, one expressive accent, avatars and photos carry the colour.", type: "System fonts or a friendly sans.", pairings: ["friendly-saas", "modern-professional"], musts: ["empty states", "report and block", "notification settings"], anti: ["infinite scroll without landmarks", "manipulative streaks"] },
  { id: "productivity", name: "Productivity and notes", aka: "productivity notes tasks todo planner calendar timer habit journal writing organiser", kind: "native", structure: "Capture first (one tap to add), a calm list, powerful but hidden-until-needed organisation, undo everywhere.", styles: ["native-apple", "flat", "swiss"], colour: "Neutral with one confident accent; colour used for priority and state.", type: "System or a neutral sans; generous body sizes.", pairings: ["minimal-swiss", "premium-sans"], musts: ["undo", "keyboard shortcuts on tablet and web", "fast quick-add"], anti: ["onboarding tours", "gamification confetti"] },
  { id: "tracker", name: "Health, habit and fitness tracker", aka: "tracker habit fitness workout sleep mood water nutrition period medication running yoga meditation wellness", kind: "native", structure: "Today first: a single clear status, one-tap logging, progress over time as simple charts, gentle reminders.", styles: ["organic", "soft", "clay"], colour: "Calm base with one energising accent; colours carry data meaning consistently.", type: "Friendly sans.", pairings: ["wellness-calm", "soft-rounded"], musts: ["one-tap logging", "accessible charts", "privacy statement"], anti: ["shaming copy", "medical claims", "dense charts"] },
  { id: "finance-tracker", name: "Personal finance and utilities", aka: "personal finance budget expense splitter invoice calculator converter weather alarm clock scanner utility", kind: "native", structure: "The one number that matters first (what is left, what is owed, today's total); fast entry in one or two taps; a clear history grouped by day; settings and rarely used options tucked away.", styles: ["native-apple", "material", "flat"], colour: "Neutral with one functional accent.", type: "System fonts with tabular figures.", pairings: ["premium-sans", "minimal-swiss"], musts: ["fast entry", "undo", "locale-aware numbers and dates"], anti: ["ads as content", "five-step onboarding"] },
  { id: "media", name: "Music, video and streaming", aka: "music video streaming podcast player cinema theatre entertainment", kind: "both", structure: "Content rows with large artwork, a persistent mini player, continue where you left off, search and library.", styles: ["dark-oled", "glass-restrained"], colour: "Dark ground; the artwork provides colour; one accent for state.", type: "Bold display with a plain body.", pairings: ["music-entertainment", "modern-professional"], musts: ["persistent player", "continue watching", "captions"], anti: ["autoplay with sound", "carousels with no pause"] },
  { id: "game", name: "Casual games", aka: "game puzzle trivia arcade idle clicker word card board casual", kind: "native", structure: "Instant play, one clear goal per screen, juicy feedback, simple progression, settings and pause always reachable.", styles: ["clay", "bauhaus", "neo-brutal"], colour: "Energetic palette with a calm UI frame so game colours stand out.", type: "Bold rounded display.", pairings: ["gaming-bold", "playful-creative"], musts: ["pause", "sound and haptic toggles", "accessible colour choices"], anti: ["pay-to-continue dark patterns"] },
  { id: "devtool", name: "Developer tool and documentation", aka: "developer tool ide documentation docs api sdk cli open source code changelog status", kind: "web", structure: "A fast, searchable docs layout: left navigation, centred content, right on-this-page; copyable code blocks; a clear getting-started path; keyboard command palette.", styles: ["terminal", "swiss", "dark-oled"], colour: "A neutral ground with one accent; code colours with enough contrast.", type: "A readable sans for text and a good mono for code.", pairings: ["developer-mono", "dashboard-data"], musts: ["copy buttons", "search", "dark and light themes", "keyboard navigation"], anti: ["marketing fluff before the install command", "low-contrast syntax themes"] },
  { id: "ai", name: "AI assistant and chat", aka: "ai chatbot assistant llm generative copilot agent chat", kind: "both", structure: "A calm conversation view with a composer, streaming text, clear message roles, a visible way to stop and retry, labelled AI content, history.", styles: ["swiss", "flat", "native-apple"], colour: "Neutral and quiet; one accent for the assistant; avoid sparkle and purple glow clichés.", type: "A readable sans with a good mono for code.", pairings: ["minimal-swiss", "premium-sans"], musts: ["stream the answer", "stop and regenerate", "AI label", "copy"], anti: ["sparkle icons everywhere", "gradient glow", "fake typing delays"] },
  { id: "events", name: "Events and ticketing", aka: "events conference ticketing booking appointment calendar tickets theatre festival wedding", kind: "web", structure: "What, when, where above the fold; programme or schedule; speakers or acts; tickets with clear prices; venue and access information.", styles: ["kinetic-type", "bauhaus", "editorial"], colour: "One bold colour pairing with high contrast.", type: "A display face with a clean sans.", pairings: ["bold-statement", "fashion-forward"], musts: ["date, time, place visible immediately", "add to calendar", "accessibility information"], anti: ["countdown pressure", "tiny schedule text"] },
  { id: "forms", name: "Forms, surveys and portals", aka: "form survey portal builder application registration checkout wizard signature", kind: "web", structure: "One question group per step, progress, save and resume, a clear review step and a confirmation.", styles: ["swiss", "enterprise"], colour: "Neutral, one action colour, strong error states.", type: "Large legible sans.", pairings: ["accessibility-first", "corporate-trust"], musts: ["labels above inputs", "error summary", "autofill support"], anti: ["placeholder-only labels", "timed forms without extension"] },
];

// ---------------------------------------------------------------------------
// type pairings (Google Fonts families; native apps use the system font unless one is installed)
// ---------------------------------------------------------------------------

export interface Pairing {
  id: string;
  heading: string;
  body: string;
  mood: string;
  /** families to request (weights chosen by the builder) */
  weights: { heading: string; body: string };
}

export const PAIRINGS: Pairing[] = [
  { id: "news-editorial", heading: "Newsreader", body: "Source Sans 3", mood: "journalistic, trustworthy, calm", weights: { heading: "500;700", body: "400;600" } },
  { id: "magazine", heading: "Libre Bodoni", body: "Public Sans", mood: "refined, editorial, high contrast", weights: { heading: "500;700", body: "400;600" } },
  { id: "editorial-classic", heading: "Cormorant Garamond", body: "Libre Baskerville", mood: "literary, traditional, warm", weights: { heading: "500;700", body: "400;700" } },
  { id: "minimal-editorial", heading: "Playfair Display", body: "Source Serif 4", mood: "monochrome, austere, typographic", weights: { heading: "500;700", body: "400;600" } },
  { id: "tech-startup", heading: "Space Grotesk", body: "DM Sans", mood: "technical, confident, modern", weights: { heading: "500;700", body: "400;500" } },
  { id: "friendly-saas", heading: "Plus Jakarta Sans", body: "Plus Jakarta Sans", mood: "friendly, clean, approachable", weights: { heading: "600;800", body: "400;500" } },
  { id: "premium-sans", heading: "DM Sans", body: "DM Sans", mood: "premium, modern, quiet", weights: { heading: "500;700", body: "400;500" } },
  { id: "minimal-swiss", heading: "Inter", body: "Inter", mood: "neutral, functional, Swiss", weights: { heading: "600;700", body: "400;500" } },
  { id: "modern-professional", heading: "Poppins", body: "Open Sans", mood: "modern, corporate, clean", weights: { heading: "600;700", body: "400;600" } },
  { id: "corporate-trust", heading: "Lexend", body: "Source Sans 3", mood: "accessible, trustworthy, readable", weights: { heading: "500;700", body: "400;600" } },
  { id: "financial-trust", heading: "IBM Plex Sans", body: "IBM Plex Sans", mood: "precise, professional, financial", weights: { heading: "500;700", body: "400;500" } },
  { id: "ecommerce-clean", heading: "Rubik", body: "Nunito Sans", mood: "clear, retail, friendly", weights: { heading: "500;700", body: "400;600" } },
  { id: "playful-creative", heading: "Fredoka", body: "Nunito", mood: "playful, friendly, warm", weights: { heading: "500;600", body: "400;600" } },
  { id: "kids-education", heading: "Baloo 2", body: "Nunito Sans", mood: "kids, learning, cheerful", weights: { heading: "600;800", body: "400;600" } },
  { id: "soft-rounded", heading: "Varela Round", body: "Nunito Sans", mood: "soft, rounded, approachable", weights: { heading: "400", body: "400;600" } },
  { id: "wellness-calm", heading: "Lora", body: "Raleway", mood: "calm, wellness, natural", weights: { heading: "500;700", body: "400;600" } },
  { id: "medical-clean", heading: "Figtree", body: "Noto Sans", mood: "clean, accessible, caring", weights: { heading: "600;700", body: "400;600" } },
  { id: "accessibility-first", heading: "Atkinson Hyperlegible", body: "Atkinson Hyperlegible", mood: "legible, inclusive, plain", weights: { heading: "700", body: "400;700" } },
  { id: "legal-professional", heading: "EB Garamond", body: "Lato", mood: "traditional, authoritative", weights: { heading: "500;700", body: "400;700" } },
  { id: "real-estate-luxury", heading: "Cinzel", body: "Josefin Sans", mood: "elegant, premium", weights: { heading: "500;700", body: "300;400" } },
  { id: "luxury-serif", heading: "Cormorant", body: "Montserrat", mood: "luxury, fashion, refined", weights: { heading: "500;700", body: "400;500" } },
  { id: "luxury-minimal", heading: "Bodoni Moda", body: "Jost", mood: "high-end, minimal", weights: { heading: "500;700", body: "300;400" } },
  { id: "restaurant-menu", heading: "Playfair Display SC", body: "Karla", mood: "culinary, warm, elegant", weights: { heading: "400;700", body: "400;600" } },
  { id: "indie-craft", heading: "Amatic SC", body: "Cabin", mood: "handmade, artisan", weights: { heading: "400;700", body: "400;600" } },
  { id: "bold-statement", heading: "Bebas Neue", body: "Source Sans 3", mood: "impactful, loud, dramatic", weights: { heading: "400", body: "400;600" } },
  { id: "fashion-forward", heading: "Syne", body: "Manrope", mood: "avant-garde, creative", weights: { heading: "600;800", body: "400;600" } },
  { id: "minimal-portfolio", heading: "Archivo", body: "Space Grotesk", mood: "minimal, designer, quiet confidence", weights: { heading: "600;800", body: "400;500" } },
  { id: "dashboard-data", heading: "Fira Sans", body: "Fira Sans", mood: "data, technical, legible numbers", weights: { heading: "500;700", body: "400;500" } },
  { id: "developer-mono", heading: "JetBrains Mono", body: "IBM Plex Sans", mood: "code, developer, precise", weights: { heading: "500;700", body: "400;500" } },
  { id: "music-entertainment", heading: "Righteous", body: "Poppins", mood: "energetic, bold, fun", weights: { heading: "400", body: "400;500" } },
  { id: "gaming-bold", heading: "Russo One", body: "Chakra Petch", mood: "action, competitive", weights: { heading: "400", body: "400;600" } },
];

// ---------------------------------------------------------------------------
// the slop list: how generated UI gives itself away
// ---------------------------------------------------------------------------

export const SLOP_SIGNS = [
  "emoji used as icons, bullets or tab labels",
  "a centred hero with a purple-to-pink or blue-to-purple gradient, a glowing orb or a sparkle icon",
  "three identical rounded cards with a soft shadow and an icon, under every heading",
  "glassmorphism on every surface, drop shadows on everything",
  "lorem ipsum, 'Item 1', 'Welcome to our platform', made-up logos, numbers or testimonials",
  "every section centred and the same width, with no change of rhythm or scale",
  "the same neutral sans (Inter) at one weight for everything, with no hierarchy",
  "pure #000 text on pure #fff, or grey on grey",
  "a rainbow of accent colours, or default framework blue buttons",
  "icon-only buttons with no label; placeholder text as the only label",
  "decorative motion on everything; nothing that responds to a press",
  "no empty, loading or error states; no real content shape",
];

export const findPlaybook = (id: unknown): Playbook | undefined => PLAYBOOKS.find((p) => p.id === id);
export const findStyle = (id: unknown): StyleFamily | undefined => STYLES.find((s) => s.id === id);
export const findPairing = (id: unknown): Pairing | undefined => PAIRINGS.find((p) => p.id === id);

/** The short block every Editor sees when it touches user-facing UI. */
export function coreRulesBlock(platform: Platform | "unknown" = "unknown"): string {
  const pick = RULES.filter((r) => r.core && (platform === "unknown" || r.platform === "all" || r.platform === platform));
  return (
    "UI CRAFT RULES (apply to any screen, component or page you write; these are checked after the phase):\n" +
    pick.map((r) => `- ${r.do} Not: ${r.not}`).join("\n")
  );
}

// ---------------------------------------------------------------------------
// screens: what each kind of page needs (so a screen is designed for its job, not for a template)
// ---------------------------------------------------------------------------

export interface PageType {
  id: string;
  name: string;
  layout: string;
  components: string;
  states: string;
  watch: string;
}

export const PAGE_TYPES: PageType[] = [
  { id: "home", name: "Home or landing", layout: "A hero that states the outcome and shows the real product; sections with different layouts and scale so the page has rhythm; one primary action repeated, not many competing ones.", components: "Header, hero, proof, feature rows, pricing or next step, footer.", states: "Loading skeleton for dynamic parts; a reduced-motion version of any animation.", watch: "Centred everything; three identical cards; text over busy images without a scrim." },
  { id: "feed", name: "Feed or list", layout: "A scannable list or grid with one consistent card anatomy; sticky filters or tabs; pagination or infinite scroll with a way back to the top.", components: "Card, filter bar, sort, search, load more.", states: "Empty (with a next step), skeletons, error with retry, end of list.", watch: "Cards whose height changes as images load; hidden filters." },
  { id: "detail", name: "Detail or article", layout: "One main column at a readable width (60-70 characters for prose), a clear title block, supporting information beside or below, related items at the end.", components: "Title block, media with caption, body, metadata, related, share or save.", states: "Not found, loading, paywall or locked.", watch: "Full-width paragraphs; actions only visible on hover." },
  { id: "dashboard", name: "Dashboard", layout: "Key numbers first, one primary chart, then a filterable table; a consistent grid; density chosen for the audience.", components: "Stat card, chart, table, filters, date range, drawer.", states: "Every widget has loading, empty and error; a stale-data indicator.", watch: "Rainbow charts; values only in tooltips; tables that break on small screens." },
  { id: "form", name: "Form or wizard", layout: "One column; labels above fields; related fields grouped; progress for more than one step; the primary action at the end of the flow.", components: "Input, select, checkbox, radio, date, error summary, stepper.", states: "Inline error, summary after a failed submit, saving, success, resume later.", watch: "Placeholder as label; validating only on submit; blocking paste." },
  { id: "checkout", name: "Checkout or payment", layout: "A focused single column with an order summary always visible; no distracting navigation; fewest possible steps; a guest option.", components: "Summary, address, payment, review, confirmation.", states: "Payment failure with a recovery path, address validation, processing.", watch: "Surprise costs late; an account wall; timers that pressure." },
  { id: "auth", name: "Sign in and sign up", layout: "A small centred card or split screen; one clear action; alternatives (passkey, provider) offered without a wall of buttons.", components: "Email, password with show toggle, one-time code, provider buttons, recovery link.", states: "Wrong password, locked, code sent, success.", watch: "Disabling paste; unlabeled fields; errors that reveal which accounts exist." },
  { id: "settings", name: "Settings and profile", layout: "Grouped lists with a clear heading per group; immediate effect for toggles and an explicit save for text; destructive actions separated at the end.", components: "Toggle, list row, segmented control, avatar upload, danger zone.", states: "Saved confirmation, error, an unsaved-changes guard.", watch: "One long unbroken list; dangerous actions next to harmless ones." },
  { id: "pricing", name: "Pricing and plans", layout: "Plans side by side with the recommended one marked; what is included in plain language; a billing period toggle; an honest comparison.", components: "Plan card, feature list, toggle, FAQ, contact for custom.", states: "Current plan marked; error when payment fails.", watch: "Hidden fees; feature lists that cannot be compared; fake urgency." },
  { id: "search", name: "Search and results", layout: "A prominent search with suggestions; results with the match highlighted; filters that persist; sort.", components: "Search field, suggestion list, result card, filter chips, sort.", states: "No results with suggestions, loading, error, recent searches.", watch: "A bare 0 results; filters that reset on every change." },
  { id: "onboarding", name: "Onboarding", layout: "As few screens as possible, each with one idea and a visible skip and back; the value shown before any sign-up.", components: "Pager, illustration or real preview, permission prompts with a reason.", states: "Skipped, resumed.", watch: "A forced linear tour; permission prompts before the reason is given." },
  { id: "empty", name: "Empty, error and not found", layout: "A short explanation of what happened and the next action; the tone matches the product.", components: "Illustration or icon, heading, one action.", states: "n/a", watch: "Blank screens; blaming the user; dead ends with no link out." },
  { id: "media", name: "Player or media view", layout: "The content is the hero; controls reachable with one hand; a persistent mini player; captions and transcripts.", components: "Player, queue, scrubber, artwork, captions.", states: "Buffering, offline, unavailable.", watch: "Autoplay with sound; tiny scrubber targets." },
  { id: "chat", name: "Conversation", layout: "Messages in a single column with clear sender roles; the composer pinned above the keyboard; the newest message visible.", components: "Message bubble or block, composer, attachment, typing or streaming indicator.", states: "Sending, failed with retry, offline, empty thread.", watch: "A composer hidden by the keyboard; no way to stop a streaming answer." },
];

export const findPageType = (id: unknown) => PAGE_TYPES.find((p) => p.id === id);

export const VARIANCE: Record<"low" | "mid" | "high", string> = {
  low: "Predictable: a symmetric grid, aligned edges, one rhythm of section heights. Calm and fast to scan; the identity comes from type, colour and content.",
  mid: "Balanced: a steady grid with a few deliberate breaks: one oversized element, one section that changes alignment or width.",
  high: "Bold: asymmetric layouts, overlap, large scale contrast, sections that change width and alignment. Still on a grid, and every break must serve the content, not decorate it.",
};
