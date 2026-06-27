// --- theme registry (T19) — shared by the hub page and the full-page terminal
// Single source of truth: each theme drives the hub's CSS variables, the picker
// preview, AND the embedded terminal's palette (bg/fg + 16 ANSI). codex is the
// default parchment look (its hub vars live in the app.py :root); every other
// theme is emitted as a body[data-theme=…] override by hub.js. Terminals stay
// dark even under light hub themes — a light terminal reads poorly for Claude.
// ANSI keeps +/- and syntax hues distinct for legibility.
//
// Loaded as a classic script BEFORE hub.js (and on the terminal page), so these
// top-level bindings are visible to both. Do NOT redeclare them elsewhere.
const THEME = {
  codex:    { name:"codex", mode:"light", font:"'EB Garamond','Noto Serif',Georgia,serif",
    bg:"#efe2c0", paper:"#f6edd6", ink:"#43331c", inkSoft:"#6e5a39", inkFaint:"#9c875f",
    lapis:"#2f5277", sanguine:"#9a3b22", verdigris:"#4f6b3a", ochre:"#8a6d1f", plum:"#5a3d6e",
    term:{ bg:"#2b2620", fg:"#e8dcc0", ansi:["#3a332a","#c1554a","#7a8c4a","#c2922e","#4f7aa6","#9a6a9e","#5a9a92","#e8dcc0","#5a5048","#d96e5e","#9bb05a","#d9aa44","#6f97c2","#b487b8","#76b3aa","#fff4dc"] } },
  lapis:    { name:"lapis", mode:"dark", font:"'EB Garamond','Noto Serif',Georgia,serif",
    bg:"#1a1b26", paper:"#24283b", ink:"#c0caf5", inkSoft:"#9aa5ce", inkFaint:"#565f89",
    lapis:"#7aa2f7", sanguine:"#f7768e", verdigris:"#9ece6a", ochre:"#e0af68", plum:"#bb9af7",
    term:{ bg:"#1a1b26", fg:"#c0caf5", ansi:["#15161e","#f7768e","#9ece6a","#e0af68","#7aa2f7","#bb9af7","#7dcfff","#a9b1d6","#414868","#f7768e","#9ece6a","#e0af68","#7aa2f7","#bb9af7","#7dcfff","#c0caf5"] } },
  koi:      { name:"koi", mode:"light", font:"'Trebuchet MS','DejaVu Sans',Verdana,sans-serif",
    bg:"#fff3da", paper:"#ffe9c2", ink:"#33250e", inkSoft:"#a65c00", inkFaint:"#cf9544",
    lapis:"#1f4dd8", sanguine:"#f56f00", verdigris:"#2eaf5d", ochre:"#e6a817", plum:"#8c4ddd",
    term:{ bg:"#1a1410", fg:"#ffe9c2", ansi:["#2a1f15","#f5503c","#2eaf5d","#e6a817","#2f6df0","#c266ff","#2bb0c8","#ffe9c2","#4a3520","#ff6e54","#46c873","#ffbe3a","#5a8cff","#d488ff","#4cc8de","#fff4dc"] } },
  phosphor: { name:"crt", mode:"dark", skin:"crt", font:"'JetBrains Mono','Hack','Noto Sans Mono',monospace",
    bg:"#050905", paper:"#0b140c", ink:"#a8ffbe", inkSoft:"#52d98b", inkFaint:"#2e7d52",
    lapis:"#36e3a0", sanguine:"#ff5470", verdigris:"#2ecf7a", ochre:"#9fe06a", plum:"#36b88f",
    term:{ bg:"#050d07", fg:"#a8ffbe", ansi:["#0a160d","#ff5470","#36e3a0","#9fe06a","#2ee6c0","#7df0b0","#5affd0","#c8ffd8","#163a24","#ff7088","#5affb8","#b6f07a","#56f0d2","#9bf6c4","#86ffe0","#e6fff0"] } },
  graphite: { name:"graphite", mode:"dark", font:"system-ui,'Segoe UI',sans-serif",
    bg:"#23272e", paper:"#2b3036", ink:"#c6ccd4", inkSoft:"#8d97a3", inkFaint:"#5c646e",
    lapis:"#6f8aa6", sanguine:"#c98a8a", verdigris:"#9bb89b", ochre:"#c9bd97", plum:"#b39ec2",
    term:{ bg:"#1f2329", fg:"#c6ccd4", ansi:["#2b3036","#c98a8a","#9bb89b","#c9bd97","#8aa6c9","#b39ec2","#8fbcbe","#c6ccd4","#3a4049","#d99e9e","#aecaae","#d8cda6","#9db8d8","#c2add0","#9fccce","#e0e4ea"] } },
  nord:     { name:"nord", mode:"dark", font:"system-ui,'Segoe UI',sans-serif",
    bg:"#2e3440", paper:"#3b4252", ink:"#d8dee9", inkSoft:"#abb2c0", inkFaint:"#6b7488",
    lapis:"#88c0d0", sanguine:"#bf616a", verdigris:"#a3be8c", ochre:"#ebcb8b", plum:"#b48ead",
    term:{ bg:"#2e3440", fg:"#d8dee9", ansi:["#3b4252","#bf616a","#a3be8c","#ebcb8b","#81a1c1","#b48ead","#88c0d0","#e5e9f0","#4c566a","#bf616a","#a3be8c","#ebcb8b","#81a1c1","#b48ead","#8fbcbb","#eceff4"] } },
  zenburn:  { name:"zenburn", mode:"dark", font:"system-ui,'Segoe UI',sans-serif",
    bg:"#3f3f3f", paper:"#4a4a4a", ink:"#dcdccc", inkSoft:"#b0b0a0", inkFaint:"#80806f",
    lapis:"#8cd0d3", sanguine:"#cc9393", verdigris:"#7f9f7f", ochre:"#d0bf8f", plum:"#dc8cc3",
    term:{ bg:"#3f3f3f", fg:"#dcdccc", ansi:["#4d4d4d","#cc9393","#7f9f7f","#d0bf8f","#8cd0d3","#dc8cc3","#93e0e3","#dcdccc","#6a6a6a","#dca3a3","#8fb28f","#e0cfa0","#9cdfe2","#ec9cd0","#a3eef0","#ffffff"] } },
  frappe:   { name:"catppuccin frappé", mode:"dark", font:"system-ui,'Segoe UI',sans-serif",
    bg:"#303446", paper:"#414559", ink:"#c6d0f5", inkSoft:"#a5adce", inkFaint:"#737994",
    lapis:"#8caaee", sanguine:"#e78284", verdigris:"#a6d189", ochre:"#e5c890", plum:"#ca9ee6",
    term:{ bg:"#303446", fg:"#c6d0f5", ansi:["#51576d","#e78284","#a6d189","#e5c890","#8caaee","#f4b8e4","#81c8be","#b5bfe2","#626880","#e78284","#a6d189","#e5c890","#8caaee","#f4b8e4","#81c8be","#a5adce"] } },
  gruvbox:  { name:"gruvbox", mode:"dark", font:"system-ui,'Segoe UI',sans-serif",
    bg:"#282828", paper:"#32302f", ink:"#ebdbb2", inkSoft:"#a89984", inkFaint:"#7c6f64",
    lapis:"#83a598", sanguine:"#fb4934", verdigris:"#b8bb26", ochre:"#fabd2f", plum:"#d3869b",
    term:{ bg:"#282828", fg:"#ebdbb2", ansi:["#282828","#cc241d","#98971a","#d79921","#458588","#b16286","#689d6a","#a89984","#928374","#fb4934","#b8bb26","#fabd2f","#83a598","#d3869b","#8ec07c","#ebdbb2"] } },
  rosepine: { name:"rosé pine", mode:"dark", font:"system-ui,'Segoe UI',sans-serif",
    bg:"#191724", paper:"#1f1d2e", ink:"#e0def4", inkSoft:"#908caa", inkFaint:"#6e6a86",
    lapis:"#31748f", sanguine:"#eb6f92", verdigris:"#9ccfd8", ochre:"#f6c177", plum:"#c4a7e7",
    term:{ bg:"#191724", fg:"#e0def4", ansi:["#26233a","#eb6f92","#31748f","#f6c177","#9ccfd8","#c4a7e7","#ebbcba","#e0def4","#6e6a86","#eb6f92","#31748f","#f6c177","#9ccfd8","#c4a7e7","#ebbcba","#e0def4"] } },
  // generative "world": a p5.js flow field behind a LIGHT UI styled after the
  // p5js.org website — near-white bg, signature brand pink (#ed225d), near-black
  // ink. `flow` is the 2-colour particle scheme the skin reads (pink + a deep
  // indigo so trails stay legible on light). Terminal stays dark, as elsewhere.
  flow:     { name:"p5 flow", mode:"light", skin:"flowfield", font:"system-ui,'Segoe UI',sans-serif",
    bg:"#fcf3f6", paper:"#ffffff", ink:"#1d1b1f", inkSoft:"#6b5560", inkFaint:"#b6a0a8",
    lapis:"#2f6df0", sanguine:"#ed225d", verdigris:"#1f9d57", ochre:"#c98a1f", plum:"#8a3fd1",
    flow:["#ed225d","#4a2fd6"],
    term:{ bg:"#0e1018", fg:"#e8ecf5", ansi:["#1b1f2e","#ed225d","#3fd08a","#e0b341","#5b8cff","#c77dff","#46d0e0","#cfd6e6","#3a4258","#ff5d83","#5fe0a3","#f0c75e","#83a8ff","#d49bff","#6fe0ee","#ffffff"] } },
  // glossy "world": Mac OS X Aqua — pinstripe desktop, gel buttons, glassy
  // panels. A material skin (restyles surfaces) rather than an overlay/canvas;
  // Lucida Grande is the period system font. Blue #2f78c4 + the traffic lights.
  aqua:     { name:"aqua", mode:"light", skin:"aqua", font:"'Lucida Grande','Helvetica Neue',Helvetica,Arial,sans-serif",
    bg:"#dde5f0", paper:"#ffffff", ink:"#1f2937", inkSoft:"#5a6b80", inkFaint:"#9babc0",
    lapis:"#2f78c4", sanguine:"#e0463a", verdigris:"#1f9e3d", ochre:"#e0a020", plum:"#8a52c4",
    term:{ bg:"#1f2430", fg:"#d7deea", ansi:["#2a3140","#e0463a","#3fae5a","#e0a020","#3f8bd4","#a06fe0","#3fb0c8","#cdd6e4","#3d4759","#ef6a5e","#5fce7a","#f0c050","#6fb0ee","#c49bf0","#6fd0e4","#ffffff"] } },
  // joke "world": peak-2000s GeoCities — starfield desktop, Comic Sans, neon
  // bevels, rainbow WordArt, blinking UNDER CONSTRUCTION, a scrolling marquee,
  // a visitor counter and a glitter cursor trail. Deliberately maximalist.
  geocities:{ name:"geocities", mode:"dark", skin:"geocities", font:"'Comic Sans MS','Comic Sans','Chalkboard SE',cursive",
    bg:"#05010f", paper:"#160a33", ink:"#e8ffe8", inkSoft:"#9fd0ff", inkFaint:"#7a6ab0",
    lapis:"#00e0ff", sanguine:"#ff2d95", verdigris:"#39ff14", ochre:"#ffe600", plum:"#b14bff",
    term:{ bg:"#05010f", fg:"#39ff14", ansi:["#1a1030","#ff2d95","#39ff14","#ffe600","#00e0ff","#b14bff","#00e0ff","#e8ffe8","#4a3a7a","#ff6cb5","#7dff5c","#fff04d","#6cefff","#cb86ff","#6cefff","#ffffff"] } },
};
const THEME_ORDER = ["codex","lapis","koi","phosphor","graphite","nord","zenburn","frappe","gruvbox","rosepine","flow","aqua","geocities"];
const THEME_MIGRATE = { matrix: "phosphor", dragon: "koi" };  // renamed themes

// resolve a stored key to a current, valid theme key (handles renames)
function resolveTheme(key) {
  key = THEME_MIGRATE[key] || key;
  return THEME[key] ? key : "codex";
}

function _hx(h){ h=h.replace("#",""); return [0,2,4].map(i=>parseInt(h.slice(i,i+2),16)); }
function _rgba(hex,a){ const [r,g,b]=_hx(hex); return `rgba(${r},${g},${b},${a})`; }
function _shade(hex,amt){ const [r,g,b]=_hx(hex); const t=amt<0?0:255, p=Math.abs(amt)/100;
  const c=v=>Math.round(v+(t-v)*p).toString(16).padStart(2,"0"); return "#"+c(r)+c(g)+c(b); }

// build an xterm.js (v5) theme object from a theme key
function xtermTheme(key){ const d=(THEME[resolveTheme(key)]).term, a=d.ansi; return {
  background:d.bg, foreground:d.fg, cursor:d.fg, cursorAccent:d.bg,
  selectionBackground:_rgba(d.fg,.25),
  black:a[0],red:a[1],green:a[2],yellow:a[3],blue:a[4],magenta:a[5],cyan:a[6],white:a[7],
  brightBlack:a[8],brightRed:a[9],brightGreen:a[10],brightYellow:a[11],brightBlue:a[12],
  brightMagenta:a[13],brightCyan:a[14],brightWhite:a[15] }; }
