// src/sidepanel/icons.js
//
// The handful of icons the agent activity timeline uses, as inline SVG. They
// are the same lucide icons the Lexi web app renders (lucide-react 0.511.0,
// ISC licence), copied as plain path data: the panel's CSP allows no external
// assets and there is no bundler.
//
// ES module — imported by agent-activity.js only.

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS = {
  'arrow-left': [['path', { d: 'm12 19-7-7 7-7' }], ['path', { d: 'M19 12H5' }]],
  camera: [
    ['path', { d: 'M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z' }],
    ['circle', { cx: '12', cy: '13', r: '3' }],
  ],
  check: [['path', { d: 'M20 6 9 17l-5-5' }]],
  'chevron-down': [['path', { d: 'm6 9 6 6 6-6' }]],
  'chevron-right': [['path', { d: 'm9 18 6-6-6-6' }]],
  'circle-check': [['circle', { cx: '12', cy: '12', r: '10' }], ['path', { d: 'm9 12 2 2 4-4' }]],
  clock: [['circle', { cx: '12', cy: '12', r: '10' }], ['polyline', { points: '12 6 12 12 16 14' }]],
  crosshair: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['line', { x1: '22', x2: '18', y1: '12', y2: '12' }],
    ['line', { x1: '6', x2: '2', y1: '12', y2: '12' }],
    ['line', { x1: '12', x2: '12', y1: '6', y2: '2' }],
    ['line', { x1: '12', x2: '12', y1: '22', y2: '18' }],
  ],
  'file-search': [
    ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
    ['path', { d: 'M4.268 21a2 2 0 0 0 1.727 1H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3' }],
    ['path', { d: 'm9 18-1.5-1.5' }],
    ['circle', { cx: '5', cy: '14', r: '3' }],
  ],
  'file-text': [
    ['path', { d: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z' }],
    ['path', { d: 'M14 2v4a2 2 0 0 0 2 2h4' }],
    ['path', { d: 'M10 9H8' }],
    ['path', { d: 'M16 13H8' }],
    ['path', { d: 'M16 17H8' }],
  ],
  globe: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }],
    ['path', { d: 'M2 12h20' }],
  ],
  hourglass: [
    ['path', { d: 'M5 22h14' }],
    ['path', { d: 'M5 2h14' }],
    ['path', { d: 'M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22' }],
    ['path', { d: 'M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2' }],
  ],
  keyboard: [
    ['path', { d: 'M10 8h.01' }],
    ['path', { d: 'M12 12h.01' }],
    ['path', { d: 'M14 8h.01' }],
    ['path', { d: 'M16 12h.01' }],
    ['path', { d: 'M18 8h.01' }],
    ['path', { d: 'M6 8h.01' }],
    ['path', { d: 'M7 16h10' }],
    ['path', { d: 'M8 12h.01' }],
    ['rect', { width: '20', height: '16', x: '2', y: '4', rx: '2' }],
  ],
  'list-checks': [
    ['path', { d: 'm3 17 2 2 4-4' }],
    ['path', { d: 'm3 7 2 2 4-4' }],
    ['path', { d: 'M13 6h8' }],
    ['path', { d: 'M13 12h8' }],
    ['path', { d: 'M13 18h8' }],
  ],
  'loader-circle': [['path', { d: 'M21 12a9 9 0 1 1-6.219-8.56' }]],
  'message-circle-question': [
    ['path', { d: 'M7.9 20A9 9 0 1 0 4 16.1L2 22Z' }],
    ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }],
    ['path', { d: 'M12 17h.01' }],
  ],
  'mouse-pointer-click': [
    ['path', { d: 'M14 4.1 12 6' }],
    ['path', { d: 'm5.1 8-2.9-.8' }],
    ['path', { d: 'm6 12-1.9 2' }],
    ['path', { d: 'M7.2 2.2 8 5.1' }],
    [
      'path',
      {
        d: 'M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z',
      },
    ],
  ],
  'move-vertical': [['path', { d: 'M12 2v20' }], ['path', { d: 'm8 18 4 4 4-4' }], ['path', { d: 'm8 6 4-4 4 4' }]],
  'text-cursor-input': [
    ['path', { d: 'M12 20h-1a2 2 0 0 1-2-2 2 2 0 0 1-2 2H6' }],
    ['path', { d: 'M13 8h7a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-7' }],
    ['path', { d: 'M5 16H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h1' }],
    ['path', { d: 'M6 4h1a2 2 0 0 1 2 2 2 2 0 0 1 2-2h1' }],
    ['path', { d: 'M9 6v12' }],
  ],
  wrench: [
    [
      'path',
      {
        d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
      },
    ],
  ],
};

/**
 * A lucide icon as an <svg> element (24-unit grid, 2px round stroke, coloured
 * by currentColor). Unknown names fall back to the wrench, as in the web app.
 * @param {string} name
 * @param {string} [className]
 * @returns {SVGSVGElement}
 */
export function icon(name, className = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  for (const [k, v] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(k, v);
  }
  if (className) svg.setAttribute('class', className);
  svg.dataset.icon = ICONS[name] ? name : 'wrench';
  for (const [tag, attrs] of ICONS[name] || ICONS.wrench) {
    const child = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) child.setAttribute(k, v);
    svg.appendChild(child);
  }
  return svg;
}
