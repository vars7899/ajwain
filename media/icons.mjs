// Ajwain's icon set, drawn in code after a reference icon pack (not part of the repo): chunky ink outlines with
// orange (or semantic) fills.
// Ink is currentColor, so outlines follow the theme; fills are fixed colours. Plain SVG strings, no deps.
export const C = {
  orange: '#F28C28', cream: '#FFF4E6', red: '#EF4444', amber: '#F59E0B', yellow: '#EAB308', green: '#22C55E',
  blue: '#3B82F6', sky: '#60A5FA', violet: '#8B5CF6', cyan: '#06B6D4', tint: 'rgba(242,140,40,.28)',
};
const W = 1.7; // ink stroke width on the 24px grid

// A filled shape with an ink outline. `fill` may be a CSS var, so it goes in style, not an attribute.
const shape = (d, fill = 'none', w = W) => `<path d="${d}" style="fill:${fill}" stroke="currentColor" stroke-width="${w}"/>`;
const ink = (d, w = W) => shape(d, 'none', w);
// The pack's "outlined stroke": a wide ink stroke under a narrower coloured one.
const bold = (d, color, w = 2.3) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${w + 2}"/><path d="${d}" fill="none" style="stroke:${color}" stroke-width="${w}"/>`;
const ring = (cx, cy, r, fill, w = W) => `<circle cx="${cx}" cy="${cy}" r="${r}" style="fill:${fill}" stroke="currentColor" stroke-width="${w}"/>`;
const cone = (fill = C.orange) =>
  shape('M10 3.5h4l4.6 13.7H5.4z', fill) +
  `<path d="M8.9 8.2h6.2M7.6 12.3h8.8" style="stroke:${C.cream}" stroke-width="2.1"/>` +
  shape('M3.5 17.2h17v2.1a1.2 1.2 0 0 1-1.2 1.2H4.7a1.2 1.2 0 0 1-1.2-1.2z', fill);

const ICONS = {
  // ----- issue types -----
  t_epic: () => // anchor
    bold('M12 7.4V20M8.2 10.4h7.6M4.3 13.4c.4 4 3.6 6.8 7.7 6.8s7.3-2.8 7.7-6.8M2.8 15.3l1.5-2.4 2.5 1.2M21.2 15.3l-1.5-2.4-2.5 1.2', C.violet, 2) +
    ring(12, 5, 2.3, C.violet),
  t_story: () => // paintbrush
    `<path d="M20 4 13.6 10.4" stroke="currentColor" stroke-width="4.6"/><path d="M20 4 13.6 10.4" style="stroke:${C.amber}" stroke-width="2.6"/>` +
    `<path d="m14.4 9.6-2.8 2.8" stroke="currentColor" stroke-width="4.4"/>` +
    shape('M11.4 12.5c-1.9-.5-3.8.4-4.3 2.4-.4 1.6-1 2.8-2.6 3.6 3 .7 6.1-.1 7.2-2.6.6-1.3.6-2.6-.3-3.4z', C.amber) +
    ink('M14.5 19.6c1.6-1.4 3.3-1.4 4.9 0'),
  t_task: () => // ticked box
    `<rect x="3.5" y="3.5" width="17" height="17" rx="4.5" style="fill:${C.blue}" stroke="currentColor" stroke-width="${W}"/>` +
    `<path d="m8 12.3 2.8 2.8 5.4-5.9" stroke="#fff" stroke-width="2.4" fill="none"/>`,
  t_bug: () => // the pack's fish, X-eyed: something's off
    shape('M2.8 12c2.4-3.9 6.3-5.4 10.4-4.5 2.1.5 3.9 1.8 5.1 3.3L21 8.4v7.2l-2.7-2.4c-1.2 1.5-3 2.8-5.1 3.3-4.1.9-8-.6-10.4-4.5z', C.red) +
    ink('m6.3 10.3 1.9 1.9m0-1.9-1.9 1.9M11.2 8.8c1.1 2 1.1 4.4 0 6.4M5.6 14.5c.6-.5 1.4-.5 2 0'),
  t_subtask: () => // the pack's move path
    bold('M5.2 18.6c3.3-.6 3.4-6 7-7.5 2.6-1.1 4.7-1.9 6.6-4.4', C.sky, 2) +
    shape('m14.9 5.3 5.6.1-.3 5.5z', C.sky) + ring(5, 18.7, 2, C.sky),
  t_test: () => // flask
    shape('M7.4 14.4h9.2l2.1 3.4a1.5 1.5 0 0 1-1.3 2.3H6.6a1.5 1.5 0 0 1-1.3-2.3z', C.green, 0) +
    ink('M9.5 3.5h5M10.5 3.5v5.3L5 17.8a1.6 1.6 0 0 0 1.4 2.4h11.2a1.6 1.6 0 0 0 1.4-2.4l-5.5-9V3.5'),

  // ----- priorities: the pack's block arrow, doubled for the extremes -----
  p_highest: () => bold('m6 12.4 6-6 6 6M6 18.6l6-6 6 6', C.red, 2.4),
  p_high: () => shape('M12 4.2 18.6 11h-4.1v8.4h-5V11H5.4z', '#F97316'),
  p_medium: () =>
    `<rect x="4.5" y="7.6" width="15" height="3.4" rx="1.7" style="fill:${C.yellow}" stroke="currentColor" stroke-width="1.5"/>` +
    `<rect x="4.5" y="13" width="15" height="3.4" rx="1.7" style="fill:${C.yellow}" stroke="currentColor" stroke-width="1.5"/>`,
  p_low: () => shape('M12 19.8 18.6 13h-4.1V4.6h-5V13H5.4z', C.cyan),
  p_lowest: () => bold('m6 5.4 6 6 6-6M6 11.6l6 6 6-6', C.blue, 2.4),

  // ----- status categories (a = the status colour) -----
  s_todo: (a) => `<rect x="4.5" y="4.5" width="15" height="15" fill="none" style="stroke:${a}" stroke-width="2.6"/>`,
  s_in_progress: (a) => cone(a), // work in progress: a traffic cone
  s_done: (a) => `<rect x="3.5" y="3.5" width="17" height="17" style="fill:${a}"/><path d="m7.8 12.3 2.9 2.9 5.6-6" stroke="#fff" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter" fill="none"/>`,
  s_none: (a) => `<rect x="4.5" y="4.5" width="15" height="15" fill="none" style="stroke:${a}" stroke-width="2.2" stroke-dasharray="3 2.6"/>`,

  // ----- interface -----
  logo: () => cone(),
  alert: () => cone(), // caution
  clock: () => ring(12, 12, 8.8, C.tint) + ink('M12 7v5.2l3.3 2'),
  calendar: () =>
    shape('M3.5 7.2a2.2 2.2 0 0 1 2.2-2.2h12.6a2.2 2.2 0 0 1 2.2 2.2V10h-17z', C.orange) +
    ink('M5.7 5h12.6a2.2 2.2 0 0 1 2.2 2.2v11.6a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2V7.2A2.2 2.2 0 0 1 5.7 5zM8 3v4M16 3v4'),
  plus: () => ink('M12 5v14M5 12h14', 2.2),
  check: () => ink('m5 12.5 4.5 4.5L19.5 7', 2.4),
  close: () => ink('M6.5 6.5l11 11m0-11-11 11', 2),
  chevron: () => ink('m6.5 9.5 5.5 5.5 5.5-5.5', 2),
  search: () => ring(10.5, 10.5, 6.3, C.tint) + bold('m15.4 15.4 4.4 4.4', C.orange, 2.2),
  refresh: () => ink('M19.5 12a7.5 7.5 0 1 1-2.2-5.3') + shape('M20.4 3.6v5.6h-5.6z', C.orange, 1.5),
  branch: () => // the pack's curve with its anchor points
    ink('M6.5 7.3v9.4M17.5 9.3c0 4.2-4.6 4.4-8.7 5.6') +
    `<rect x="4.3" y="2.9" width="4.4" height="4.4" rx="1" style="fill:${C.orange}" stroke="currentColor" stroke-width="1.5"/>` +
    `<rect x="4.3" y="16.7" width="4.4" height="4.4" rx="1" style="fill:${C.cream}" stroke="currentColor" stroke-width="1.5"/>` +
    `<rect x="15.3" y="4.9" width="4.4" height="4.4" rx="1" style="fill:${C.orange}" stroke="currentColor" stroke-width="1.5"/>`,
  external: () => ink('M18 13.5v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6h5') + bold('M13.5 4H20v6.5M20 4l-8.5 8.5', C.orange, 1.8),
  copy: () => shape('M15.5 8V5a1.5 1.5 0 0 0-1.5-1.5H5A1.5 1.5 0 0 0 3.5 5v9A1.5 1.5 0 0 0 5 15.5h3', C.tint) +
    `<rect x="8.5" y="8.5" width="12" height="12" rx="1.8" fill="none" stroke="currentColor" stroke-width="${W}"/>`,
  file: () => ink('M14 3.5H6.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 19V8.5zM8.5 13h7M8.5 16.5h5') + shape('M14 3.5v5h5z', C.orange, 1.5),
  filter: () => shape('M3.5 5h17l-6.6 7.6v5.8l-3.8 2v-7.8z', C.tint),
  board: () => ink('M3.5 4.5h17v15h-17z') + shape('M9.2 4.5h5.6v15H9.2z', C.orange),
  list: () => ink('M9 6.5h11M9 12h11M9 17.5h11') + ring(4.8, 6.5, 1.5, C.orange, 1.3) + ring(4.8, 12, 1.5, C.orange, 1.3) + ring(4.8, 17.5, 1.5, C.orange, 1.3),
  sprint: () => ink('M4.6 13.5A7.6 7.6 0 1 0 6.9 6.4') + shape('M3.4 3.6v5.9h5.9z', C.orange, 1.5),
  user: () => ring(12, 8.5, 3.8, C.tint) + ink('M4.5 20.5a7.5 7.5 0 0 1 15 0'),
  comment: () => shape('M20.5 11.5a8 8 0 0 1-11.7 7.1L3.5 20.5l1.8-5A8 8 0 1 1 20.5 11.5z', C.tint),
  tag: () => shape('M3.5 3.5h7.6l9.4 9.4-7.6 7.6-9.4-9.4z', C.orange) + ring(7.8, 7.8, 1.5, C.cream, 1.4),
  sun: () => ring(12, 12, 4.3, C.orange) + ink('M12 2.6v2.3m0 14.2v2.3M5.4 5.4 7 7m10 10 1.6 1.6M2.6 12h2.3m14.2 0h2.3M5.4 18.6 7 17M17 7l1.6-1.6'),
  bell: () => shape('M6 9.5a6 6 0 0 1 12 0c0 5.6 2.5 7.4 2.5 7.4h-17S6 15.1 6 9.5z', C.orange) + ink('M10 20.2a2.1 2.1 0 0 0 4 0'),
  clip: () => bold('M16.5 7.5 9 15a2.5 2.5 0 0 0 3.5 3.5l8-8a4.5 4.5 0 0 0-6.4-6.4l-8 8a6.5 6.5 0 0 0 9.2 9.2l6.2-6.2', C.orange, 1.6),
  image: () => ink('M4.5 4.5h15v15h-15z') + ring(9.5, 9.5, 1.8, C.orange, 1.4) + shape('M4.5 17l5-5 4 4 2-2 4 4v1.5h-15z', C.tint, 1.4),
  download: () => ink('M12 4v11M7 10.5 12 15.5l5-5M5 19.5h14', 2),
  upload: () => ink('M12 15.5v-11M7 9 12 4l5 5M5 19.5h14', 2),
  trash: () => ink('M4.5 6.5h15M9.5 6.5V4h5v2.5M6.5 6.5l1 13.5h9l1-13.5M10 10v6.5M14 10v6.5'),
  wand: () => bold('M4 20 15 9', C.orange, 2) + shape('M17 3.5l1 2.5 2.5 1-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1z', C.yellow, 1.3),
  dice: () => `<rect x="3.5" y="3.5" width="17" height="17" style="fill:${C.orange}" stroke="currentColor" stroke-width="${W}"/>` +
    [[8, 8], [16, 8], [12, 12], [8, 16], [16, 16]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.6" style="fill:${C.cream}"/>`).join(''),
  trophy: () => shape('M7 4h10v5a5 5 0 0 1-10 0z', C.yellow) + ink('M7 6H4.5v1.5A3 3 0 0 0 7.5 10.5M17 6h2.5v1.5a3 3 0 0 1-3 3M12 14v3.5M8 20.5h8M9.5 17.5h5v3h-5z'),
  flame: () => shape('M12 21c-4 0-6.5-2.6-6.5-6 0-3.6 3-5.4 3-9 2.6 1.4 4 3.6 4 5.6 1-1 1.6-2.2 1.6-3.6 2.4 1.6 4.4 4.2 4.4 7 0 3.4-2.5 6-6.5 6z', C.orange) + shape('M12 21c-1.8 0-3-1.2-3-2.8 0-1.8 1.6-2.6 2-4.4 1.6 1 3.4 2.6 3.4 4.4 0 1.6-1 2.8-2.4 2.8z', C.yellow, 1.2),
  moon: () => shape('M19.5 14.5A8 8 0 1 1 9.5 4.5a6.5 6.5 0 0 0 10 10z', C.tint),
  eye: () => shape('M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', C.tint) + ring(12, 12, 3, C.orange, 1.5),
  stretch: () => ring(12, 4.5, 2.2, C.cream, 1.5) + ink('M12 7v7M12 14l-4 6M12 14l4 6M5 3l7 6 7-6', 1.8),
  pr: () => ink('M6.5 7.3v9.4M17.5 16.7V11a3 3 0 0 0-3-3h-4M12.5 5.5 10 8l2.5 2.5') + ring(6.5, 5.2, 2.1, C.orange, 1.5) + ring(6.5, 18.8, 2.1, C.cream, 1.5) + ring(17.5, 18.8, 2.1, C.orange, 1.5),
  sparkle: () => // the pack's pen nib: "draft"
    shape('M12 2.8 17.6 10l-2.8 9.2H9.2L6.4 10z', C.orange) + ink('M12 2.8v8.6M9 21.2h6') + ring(12, 12.6, 1.6, C.cream, 1.4),
  lanes: () => ink('M3.5 4.5h17v15h-17zM3.5 9.5h17M3.5 14.5h17') + shape('M3.5 4.5h4v15h-4z', C.orange),
  command: () => ink('M3.5 4.5h17v15h-17z') + bold('m7.5 9 3 3-3 3', C.orange, 1.8) + ink('M12.5 15.5h4.5'),
  keyboard: () => ink('M2.5 6.5h19v11h-19zM6 9.8h1.2M9.4 9.8h1.2M13.4 9.8h1.2M16.8 9.8h1.2') + shape('M6.5 13.4h11v1.4h-11z', C.orange, 1.2),
  sound: () => shape('M4 9.5h3.5L12 5.5v13l-4.5-4H4z', C.orange) + ink('M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11'),
  mute: () => shape('M4 9.5h3.5L12 5.5v13l-4.5-4H4z', C.tint) + ink('m15.5 9.5 5 5m0-5-5 5'),
  bolt: () => shape('M13.5 2.5 5 13.5h6l-1 8 8.5-11h-6z', C.yellow),
  star: () => shape('M12 3.2l2.6 5.5 6 .8-4.4 4.1 1.1 6L12 16.7l-5.3 2.9 1.1-6-4.4-4.1 6-.8z', C.yellow),
  history: () => ink('M4.6 13.5A7.6 7.6 0 1 0 6.9 6.4M12 8v4.6l3 2') + shape('M3.4 3.6v5.9h5.9z', C.orange, 1.5),
  users: () => ring(9, 8.5, 3.3, C.tint) + ink('M2.8 19.5a6.2 6.2 0 0 1 12.4 0M16.8 13.8a5 5 0 0 1 4.4 5.2') + ring(16.5, 9, 2.5, C.orange, 1.5),
  stop: () => `<rect x="6" y="6" width="12" height="12" style="fill:${C.red}" stroke="currentColor" stroke-width="${W}"/>`,
  pulse: () => ink('M2.5 12.5h4l2.5-6 4 11 2.5-5h6'),
  sort: () => ink('M3.5 6.5h9M3.5 12h6.5M3.5 17.5h4') + bold('M17.5 4.5v14.5m-3.4-3.4 3.4 3.4 3.4-3.4', C.orange, 1.6),
};

export function icon(name, { size = 16, ink: color, accent, title } = {}) {
  const body = (ICONS[name] ?? ICONS.alert)(accent ?? C.orange);
  return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"${
    color && color !== 'currentColor' ? ` style="color:${color}"` : ''
  } ${title ? `role="img" aria-label="${title}"><title>${title}</title>` : 'aria-hidden="true">'}${body}</svg>`;
}

// A standalone SVG file (for VS Code tree items, which load icons by URL): ink is a fixed colour.
export const svgFile = (name, ink, accent = C.orange) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" color="${ink}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name](accent).replace(/style="fill:([^";]+)"/g, 'fill="$1"').replace(/style="stroke:([^";]+)"/g, 'stroke="$1"')}</svg>`;

// The mascot from the pack: a kid in a traffic-cone hat. Head only (greetings, empty states) with moods,
// and a full figure with posable limbs (the stretch-break screen).
const FACES = {
  wink: '<path d="M23.6 38.2c1.6 1.4 4 1.4 5.6 0" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="39" cy="37.6" r="2" fill="currentColor"/><path d="M25.5 45.5c3.6 3.6 9.4 3.6 13 0" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  happy: '<circle cx="26.2" cy="37.6" r="2" fill="currentColor"/><circle cx="38" cy="37.6" r="2" fill="currentColor"/><path d="M25.5 45.5c3.6 3.6 9.4 3.6 13 0" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  party: '<path d="M23.4 38.6l2.6-2.6 2.6 2.6M35.4 38.6l2.6-2.6 2.6 2.6" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M25 44h14c-.6 4.6-3.4 6.6-7 6.6s-6.4-2-7-6.6z" fill="currentColor"/>',
  sleepy: '<path d="M23.6 37.6c1.6 1.2 4 1.2 5.6 0M34.8 37.6c1.6 1.2 4 1.2 5.6 0" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="32" cy="46.5" r="2.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M50 14h6l-6 6h6M44 6h4l-4 4h4" fill="none" stroke="currentColor" stroke-width="1.8"/>',
  sweat: '<circle cx="26.2" cy="38" r="2" fill="currentColor"/><circle cx="38" cy="38" r="2" fill="currentColor"/><path d="M23 33.5l5-1.5M41 33.5l-5-1.5M27 47c3-2.4 7-2.4 10 0" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M47 30c0 2.4 3.4 4.4 3.4 6.4a3.4 3.4 0 0 1-6.8 0c0-2 3.4-4 3.4-6.4z" fill="#60A5FA" stroke="currentColor" stroke-width="1.4"/>',
  look: '<circle cx="28.4" cy="37.6" r="2" fill="currentColor"/><circle cx="40.2" cy="37.6" r="2" fill="currentColor"/><path d="M27 46h10" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  wave: '<circle cx="26.2" cy="37.6" r="2" fill="currentColor"/><circle cx="38" cy="37.6" r="2" fill="currentColor"/><path d="M25.5 45.5c3.6 3.6 9.4 3.6 13 0" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M55 40c2-3 2-7 0-10M58.5 42c3-4.4 3-10.4 0-14.8" fill="none" stroke="currentColor" stroke-width="1.8"/>',
};
export const mascotHead = (mood = 'wink') => `
  <path d="M15.5 34c-3.3-1-4.6-4.6-2.7-7.2-2.2-2.7-.6-6.6 2.8-6.8M48.5 34c3.3-1 4.6-4.6 2.7-7.2 2.2-2.7.6-6.6-2.8-6.8" fill="none" stroke="currentColor" stroke-width="2"/>
  <circle cx="32" cy="38.5" r="16" style="fill:${C.cream}" stroke="currentColor" stroke-width="2.2"/>
  <path d="M16.2 36.6c-2.6-.4-3.8 2.8-1.4 4.4M47.8 36.6c2.6-.4 3.8 2.8 1.4 4.4" style="fill:${C.cream}" stroke="currentColor" stroke-width="2"/>
  <path d="M21 26.5 33.5 2.5l12 22.4z" style="fill:${C.orange}" stroke="currentColor" stroke-width="2.2"/>
  <path d="M28.9 11.4l8.9-.5M25.6 17.8l15.3-.8" style="stroke:${C.cream}" stroke-width="3.2"/>
  <path d="M14.8 27.6c9.8-3.9 22.5-5.1 34.6-3.4.9.1 1.4 1.2.8 1.9-.4.5-1 .6-1.6.6-11.3-1.2-22.9-.2-32.6 3.4-.8.3-1.7-.1-1.9-.9-.2-.7.1-1.4.7-1.6z" style="fill:${C.orange}" stroke="currentColor" stroke-width="2"/>
  ${FACES[mood] ?? FACES.wink}
  <circle cx="21.5" cy="44" r="2.2" fill="${C.orange}" opacity=".35"/><circle cx="42.5" cy="44" r="2.2" fill="${C.orange}" opacity=".35"/>`;
export const mascot = (size = 72, mood = 'wink') =>
  `<svg class="mascot mood-${mood}" width="${size}" height="${size}" viewBox="0 0 64 64" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mascotHead(mood)}</svg>`;

// Full figure, 200x320. Pose it with CSS custom properties on the svg: --la/--ra (arm angles from hanging down,
// in deg), --torso (lean), --head (tilt), --lift (shoulder shrug, px). Groups rotate about their joints.
const limb = (d) => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="15"/><path d="${d}" fill="none" style="stroke:${C.cream}" stroke-width="10.5"/>`;
export const mascotBody = (mood = 'happy') => `<svg class="mascot-body" viewBox="0 0 200 320" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <g class="legs">${limb('M88 214 84 284')}${limb('M112 214 116 284')}
    <path d="M70 284h22v12H66a4 4 0 0 1 4-12zM108 284h22a4 4 0 0 1 4 12h-26z" style="fill:${C.orange}" stroke="currentColor" stroke-width="3"/></g>
  <g class="torso">
    <g class="arm arm-l">${limb('M77 136 60 196')}<circle cx="60" cy="198" r="8" style="fill:${C.cream}" stroke="currentColor" stroke-width="3"/></g>
    <g class="arm arm-r">${limb('M123 136 140 196')}<circle cx="140" cy="198" r="8" style="fill:${C.cream}" stroke="currentColor" stroke-width="3"/></g>
    <path d="M74 132h52l6 86H68z" style="fill:${C.orange}" stroke="currentColor" stroke-width="3.2"/>
    <path d="M86 150h28M84 168h32" style="stroke:${C.cream}" stroke-width="5"/>
    <g class="head"><path d="M93.5 90h13v44h-13z" style="fill:${C.cream}" stroke="currentColor" stroke-width="3"/><svg x="52" y="16" width="96" height="96" viewBox="0 0 64 64">${mascotHead(mood)}</svg></g>
  </g>
</svg>`;

export const NAMES = Object.keys(ICONS);
