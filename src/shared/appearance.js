// What the extension looks like, kept in one place.
//
// The highlight colours and style live here rather than being hard-coded in the
// stylesheet, because a mark drawn over someone's reading is a personal thing: the
// default gold is unreadable for some people, competes with link underlines on some
// sites, and is simply unwanted by readers who only want the side panel.
//
// Pure: turns settings into CSS variables. The content script writes them onto the
// page root, the panel writes them onto its own, and highlight.css reads them with
// a fallback so a page that loads before the settings arrive still looks right.

export const HIGHLIGHT_STYLES = [
  { id: 'both', label: 'Underline and tint (default)' },
  { id: 'underline', label: 'Underline only' },
  { id: 'background', label: 'Tint only, like a marker pen' },
  { id: 'dotted', label: 'Dotted underline' },
  { id: 'none', label: 'Nothing on the page, panel only' },
];

// Named rather than a colour picker: these are chosen to stay legible on white and
// on dark pages, and to stay distinguishable from each other for the most common
// forms of colour blindness. A free picker makes it easy to choose something
// invisible on the page you are reading.
export const HIGHLIGHT_COLORS = [
  { id: 'gold', label: 'Gold', unchecked: '#c8963e', checked: '#3d7a5a' },
  { id: 'blue', label: 'Blue', unchecked: '#3d7ea6', checked: '#2f7d63' },
  { id: 'violet', label: 'Violet', unchecked: '#7a5ea8', checked: '#3d7a5a' },
  { id: 'pink', label: 'Pink', unchecked: '#b8577f', checked: '#3d7a5a' },
  { id: 'grey', label: 'Grey, as quiet as possible', unchecked: '#7b7b7b', checked: '#4a6f5c' },
];

export const THICKNESS = [
  { id: 'thin', label: 'Thin', px: '1px' },
  { id: 'normal', label: 'Normal', px: '2px' },
  { id: 'thick', label: 'Thick', px: '3px' },
];

export const PANEL_SIZES = [
  { id: 'small', label: 'Small', px: '12px' },
  { id: 'normal', label: 'Normal', px: '13px' },
  { id: 'large', label: 'Large', px: '15px' },
  { id: 'xlarge', label: 'Larger still', px: '17px' },
];

export const DEFAULT_APPEARANCE = {
  highlightStyle: 'both',
  highlightColor: 'gold',
  highlightThickness: 'normal',
  panelTextSize: 'normal',
  showVideoOverlay: true,
};

function pick(list, id, fallback) {
  return list.find((x) => x.id === id) || list.find((x) => x.id === fallback);
}

// The CSS variables the page needs, as a plain object.
export function highlightVars(settings = {}) {
  const color = pick(HIGHLIGHT_COLORS, settings.highlightColor, 'gold');
  const thickness = pick(THICKNESS, settings.highlightThickness, 'normal');
  return {
    '--fc-color': color.unchecked,
    '--fc-color-checked': color.checked,
    '--fc-line': thickness.px,
  };
}

export function highlightStyleName(settings = {}) {
  return pick(HIGHLIGHT_STYLES, settings.highlightStyle, 'both').id;
}

export function panelTextSize(settings = {}) {
  return pick(PANEL_SIZES, settings.panelTextSize, 'normal').px;
}

// Applied to a document root. Used by the content script for the page and by the
// side panel for itself, so one function is the whole of "make it look like this".
export function applyAppearance(root, settings = {}) {
  if (!root?.style) return;
  for (const [name, value] of Object.entries(highlightVars(settings))) {
    root.style.setProperty(name, value);
  }
  root.setAttribute('data-fc-style', highlightStyleName(settings));
}
